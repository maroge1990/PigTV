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

// ---------------------------------------------------------------------------
// GET /api/playback/:sessionId/terminal-status
//
// A displaced client only sees a 404 on its playlist or segments, which is the
// same thing it sees when a session expires or a feed stalls. Recovering from
// that by re-resolving takes the provider's only connection straight back off
// whoever just got it, and the two clients trade the stream back and forth.
// Owner equality cannot break the tie: two password logins are both `user:1`.
// ---------------------------------------------------------------------------

// A password login: no deviceId, so ownerKey() resolves to `user:1` - the same
// owner two different browsers get.
const webToken = () => jwt.sign({ id: 1, username: 'owner', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function terminalStatus(token, sessionId) {
    const response = await fetch(`${base}/api/playback/${encodeURIComponent(sessionId)}/terminal-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return { status: response.status, body: await response.json() };
}

async function releaseSession(token, sessionId) {
    const response = await fetch(`${base}/api/playback/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return response.status;
}

test('a device displaced by force:true is told its session was taken over', async () => {
    const tv = await holding('device:apple-tv', 5);
    assert.equal((await resolve(ipadToken(), { force: true })).status, 200);
    assert.ok(!stillRegistered(tv), 'the old session really is gone');

    const mine = await terminalStatus(tvToken(), tv.id);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, { status: 'taken-over' });

    // The device that took the stream learns nothing about the one it displaced.
    const theirs = await terminalStatus(ipadToken(), tv.id);
    assert.deepEqual(theirs.body, { status: 'none' });
});

test('two password logins share one owner key, and the displaced one is still told', async () => {
    // The case owner equality cannot solve: both clients are `user:1`, so the
    // coordinator replaces the first as "its own earlier stream" - but there are
    // two people, and the first one's player is about to 404.
    const first = await holding('user:1', 5);
    assert.equal((await resolve(webToken())).status, 200, 'no prompt: same owner');
    assert.ok(!stillRegistered(first));
    assert.deepEqual((await terminalStatus(webToken(), first.id)).body, { status: 'taken-over' });
});

test('a client that released its own session first is not told it was taken over', async () => {
    // The ordinary same-device channel change: the client sends DELETE, then
    // resolves. Nothing was displaced, so there is nothing to report and the
    // client keeps its normal recovery behaviour.
    const old = await holding('device:apple-tv', 2);
    assert.equal(await releaseSession(tvToken(), old.id), 200);
    assert.equal((await resolve(tvToken())).status, 200);
    assert.deepEqual((await terminalStatus(tvToken(), old.id)).body, { status: 'none' });
});

test('a session that simply ended leaves no marker, so ordinary recovery is unaffected', async () => {
    // A stall watchdog kill, the idle sweep, or any other removal that does not
    // go through admitViewer. These must stay 'none' or a client would stop
    // instead of recovering from a fault it could have recovered from.
    const s = await holding('device:apple-tv', 2);
    await transcodeSession.removeSession(s.id);
    assert.deepEqual((await terminalStatus(tvToken(), s.id)).body, { status: 'none' });
});

test('a stream released for being idle is still reported: a paused client is the ping-pong case', async () => {
    // Deliberately wider than the written spec, agreed with the Swift side. A
    // client paused longer than viewerIdleTimeoutSec looks idle, so it is picked
    // for release first - and it is exactly the client that would otherwise
    // resume, fail, recover, and take the connection straight back. Everything
    // admitViewer releases is released to admit somebody else.
    const paused = await holding('device:apple-tv', 300);
    assert.equal((await resolve(ipadToken())).status, 200, 'an idle stream is reclaimed without a prompt');
    assert.ok(!stillRegistered(paused));
    assert.deepEqual((await terminalStatus(tvToken(), paused.id)).body, { status: 'taken-over' });
});

test('the answer is the same however many times it is asked, until it expires', async () => {
    const tv = await holding('device:apple-tv', 5);
    await resolve(ipadToken(), { force: true });
    for (let i = 0; i < 3; i++) {
        assert.deepEqual((await terminalStatus(tvToken(), tv.id)).body, { status: 'taken-over' }, `read ${i + 1}`);
    }

    process.env.PIGTV_TERMINAL_STATUS_TTL_SEC = '0.05';
    try {
        const other = await holding('device:apple-tv', 5);
        await resolve(ipadToken(), { force: true });
        assert.deepEqual((await terminalStatus(tvToken(), other.id)).body, { status: 'taken-over' }, 'before expiry');
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual((await terminalStatus(tvToken(), other.id)).body, { status: 'none' }, 'after expiry');
    } finally {
        delete process.env.PIGTV_TERMINAL_STATUS_TTL_SEC;
    }
});

test('it says nothing to anyone who cannot prove the session was theirs', async () => {
    const tv = await holding('device:apple-tv', 5);
    await resolve(ipadToken(), { force: true });

    assert.equal((await terminalStatus(null, tv.id)).status, 401, 'no token is refused, not answered');
    assert.deepEqual((await terminalStatus(ipadToken(), tv.id)).body, { status: 'none' }, 'a different owner');
    assert.deepEqual((await terminalStatus(tvToken(), 'never-existed')).body, { status: 'none' }, 'an unknown id');

    // The shape itself is the privacy guarantee: one key, one of two values.
    // Nothing about who took the stream, their device, the channel or the new
    // session can leak through a body that can only say this much.
    const { body } = await terminalStatus(tvToken(), tv.id);
    assert.deepEqual(Object.keys(body), ['status']);
    assert.ok(['taken-over', 'none'].includes(body.status));
});
