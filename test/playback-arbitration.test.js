const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// Drive the real /api/playback/resolve route with real device tokens, so what
// is under test includes who the route decides is asking. Copy the server so its
// relative data paths never touch real data (same approach as access.test.js;
// a junction rather than a symlink so it also works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-arbitration-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox); // transcode-cache lands in the sandbox, not the repo

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const recordingEngine = load('services/recordingEngine');
const playbackStrategy = load('services/playbackStrategy');

let server, base;
let activeRecordings = [];
const resolveCalls = [];
recordingEngine.listActive = () => activeRecordings;
recordingEngine.stopForViewer = async () => {};
playbackStrategy.resolve = async (opts) => {
    resolveCalls.push(opts);
    return { strategy: 'direct', url: '/api/proxy/stream?url=x', reason: 'stubbed' };
};

function deviceToken(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, '1', deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const tvToken = () => deviceToken('apple-tv');
const ipadToken = () => deviceToken('ipad');

async function resolve(token, body = {}) {
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ url: 'http://provider.invalid/live/9.ts', ...body })
    });
    return { status: response.status, body: await response.json() };
}

// A stream `owner` is already holding, last touched `idleSec` seconds ago.
async function holding(owner, idleSec) {
    const s = await transcodeSession.createSession('http://provider.invalid/live/1.ts', { owner, live: true });
    s.lastAccess = Date.now() - idleSec * 1000;
    return s;
}
const stillRegistered = s => transcodeSession.getAllSessions().some(x => x.id === s.id);

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    activeRecordings = [];
    resolveCalls.length = 0;
});

after(() => {
    server.closeAllConnections?.();
    server.close();
    process.chdir(os.tmpdir());
    // Best effort: on Windows the still-open SQLite file cannot be deleted, and
    // a temp-dir leftover must not fail a passing test.
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it for the OS temp cleaner */ }
});

test('resolve still refuses a request with no token', async () => {
    assert.equal((await resolve(null)).status, 401);
});

test('another device that is really watching gets a 409 the client can act on, and is left running', async () => {
    const tv = await holding('device:apple-tv', 5);
    const { status, body } = await resolve(ipadToken());
    assert.equal(status, 409);
    assert.equal(body.conflict.type, 'viewer-in-progress');
    assert.match(body.conflict.message, /Another device is watching/);
    assert.match(body.resolution, /"force": true/);
    assert.match(body.resolution, /other stream/, 'the hint must not talk about a recording');
    assert.ok(stillRegistered(tv), 'nothing is stopped until the caller agrees');
    assert.equal(resolveCalls.length, 0, 'no new stream is started for a refused request');
});

test('force:true takes the slot: the other stream is stopped, then the new one starts', async () => {
    const tv = await holding('device:apple-tv', 5);
    const { status } = await resolve(ipadToken(), { force: true });
    assert.equal(status, 200);
    assert.ok(!stillRegistered(tv));
    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].owner, 'device:ipad', 'the new stream is owned by the device that asked');
});

test('a device changing channel replaces its own old stream without a prompt', async () => {
    const old = await holding('device:apple-tv', 2);
    const { status } = await resolve(tvToken());
    assert.equal(status, 200);
    assert.ok(!stillRegistered(old));
    assert.equal(resolveCalls[0].owner, 'device:apple-tv');
});

test('an abandoned stream is reclaimed without troubling anyone', async () => {
    const crashed = await holding('device:apple-tv', 90);
    const { status } = await resolve(ipadToken());
    assert.equal(status, 200);
    assert.ok(!stillRegistered(crashed));
});

test('nothing is stopped while the provider has a free connection', async () => {
    const settings = load('db');
    const original = await settings.settings.get();
    await settings.settings.update({ maxProviderStreams: 2 });
    try {
        const tv = await holding('device:apple-tv', 2);
        const { status } = await resolve(ipadToken());
        assert.equal(status, 200);
        assert.ok(stillRegistered(tv), 'a second connection is allowed, so the first viewer is undisturbed');
    } finally {
        await settings.settings.update({ maxProviderStreams: original.maxProviderStreams });
    }
});

test('a recording in progress is still reported as before', async () => {
    activeRecordings = [{ id: 3, title: 'The News', channel_name: 'ABC', program_end: Date.now() + 3600000, post_buffer_min: 0 }];
    const { status, body } = await resolve(ipadToken());
    assert.equal(status, 409);
    assert.equal(body.conflict.type, 'recording-in-progress');
    assert.match(body.resolution, /stop the recording/);
});
