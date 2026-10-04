const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// R12: POST /api/playback/warm starts the channel a viewer will probably play next on a
// connection nobody wants, and a following resolve adopts it. Off by default.
//
// The real routes, strategy, coordinator and session registry run in a copy of the server;
// the provider routing plan, the probe (seeded) and ffmpeg (session.start does nothing) are faked.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-warm-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const transcodeSession = load('services/transcodeSession');
const recordingEngine = load('services/recordingEngine');
const playbackStrategy = load('services/playbackStrategy');
const coordinator = load('services/streamCoordinator');
const warming = load('services/channelWarming');
const providerRouting = load('services/providerRouting');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');

let server, base;
let activeRecordings = [];
recordingEngine.listActive = () => activeRecordings;
recordingEngine.stopForViewer = async () => {};

// One provider, one channel per id.
providerRouting.plan = async (sourceId, channelId) => ({
    candidates: [{ providerId: 1, providerName: 'Strong8K', role: 'primary', via: 'primary', channelKey: String(channelId),
        url: `http://provider.invalid/live/u/p/${channelId}.ts` }],
    primaryKey: String(channelId), backupsConfigured: false, providerCount: 1, primarySkipped: false, channelName: `Channel ${channelId}`
});

let starts = 0;
const realCreate = transcodeSession.createSession;
transcodeSession.createSession = async (url, opts) => {
    const s = await realCreate(url, opts);
    starts++;
    s.start = async () => {};
    s.waitForPlaylist = async () => true;
    return s;
};

const CAPS = { segmentedDelivery: true };
async function seedAll() {
    const current = await db.settings.get();
    for (const channelId of [10, 11, 12]) {
        const url = `http://provider.invalid/live/u/p/${channelId}.ts`;
        for (const caps of [CAPS, { ...CAPS, hevc: true }]) {
            const merged = { ...playbackStrategy.DEFAULT_CAPABILITIES, ...caps };
            const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                                    { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                          format: { format_name: 'mpegts' } };
            const key = `${url}|${db.getUserAgent(current) || ''}|${Object.keys(merged).filter(k => merged[k]).sort().join(',')}`;
            probeCache.set(key, { result: analyzeProbeResult(raw, url, merged), timestamp: Date.now() });
        }
    }
}

function deviceToken(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, '1', deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const tv = () => deviceToken('apple-tv');
const ipad = () => deviceToken('ipad');

async function post(route, token, channelId, extra = {}) {
    const response = await fetch(`${base}/api/playback/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ sourceId: 1, channelId, capabilities: CAPS, ...extra })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}
const warm = (token, channelId, extra) => post('warm', token, channelId, extra);
const resolve = (token, channelId, extra) => post('resolve', token, channelId, extra);

const sessions = () => transcodeSession.getAllSessions();
const setWarming = (on) => db.settings.update({ warmNextChannel: on });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
    await db.users.create({ username: 'owner', role: 'admin' });
    await seedAll();
    const app = express();
    app.use(express.json());
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await warming.endAll('test over');
    warming._reset();
    warming._setTtl(null);
    activeRecordings = [];
    starts = 0;
    for (const s of sessions()) await transcodeSession.removeSession(s.id);
    coordinator._leases.clear();
    await setWarming(false);
});

after(() => {
    server.closeAllConnections?.();
    server.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it for the OS temp cleaner */ }
});

test('warming is off by default: 204 and nothing is started', async () => {
    assert.equal((await db.settings.get()).warmNextChannel, false);
    const r = await warm(tv(), 11);
    assert.equal(r.status, 204);
    assert.equal(starts, 0);
    assert.equal(sessions().length, 0);
    assert.equal(coordinator.listLeases().length, 0);
});

test('warm needs a signed-in user and a channel', async () => {
    await setWarming(true);
    assert.equal((await warm(null, 11)).status, 401);
    const response = await fetch(`${base}/api/playback/warm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tv()}` }, body: JSON.stringify({})
    });
    assert.equal(response.status, 400);
});

test('on, with a free connection: a warm session exists and the next resolve adopts it, with no second start', async () => {
    await setWarming(true);
    const w = await warm(tv(), 11);
    assert.equal(w.status, 200);
    assert.equal(w.body.warm, true);
    assert.equal(w.body.ttlSec, 90);
    assert.equal(starts, 1);
    assert.equal(sessions().length, 1);
    assert.equal(sessions()[0].warm, true, 'abandoned from the start');
    assert.equal(warming.status(await db.settings.get()).active, 1);

    const warmId = sessions()[0].id;
    const r = await resolve(tv(), 11);
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionId, warmId, 'the warm session is the viewer\'s session');
    assert.equal(r.body.warm, true, 'the decision says it was warm');
    assert.equal(r.body.info.warm, true);
    assert.equal(starts, 1, 'no second ffmpeg start');
    assert.equal(sessions().length, 1);
    assert.equal(sessions()[0].warm, false, 'now an ordinary viewer session');
    assert.equal(coordinator.listLeases().find(l => l.sessionId === warmId).purpose, 'viewer');
    const st = warming.status(await db.settings.get());
    assert.equal(st.hits, 1);
    assert.equal(st.active, 0);
    // and it is a real viewer now: another device is asked, not given it
    assert.equal((await resolve(ipad(), 12)).status, 409);
});

test('warming the same channel again only refreshes its time; warming another ends the first', async () => {
    await setWarming(true);
    await warm(tv(), 10);
    const again = await warm(tv(), 10);
    assert.equal(again.status, 200);
    assert.equal(again.body.refreshed, true);
    assert.equal(starts, 1);
    const first = sessions()[0].id;
    const other = await warm(tv(), 11);
    assert.equal(other.status, 200);
    assert.equal(starts, 2);
    assert.equal(sessions().length, 1, 'one warm session per owner');
    assert.notEqual(sessions()[0].id, first);
});

test('a different channel, or different needs, end the warm session and resolve normally', async () => {
    await setWarming(true);
    await warm(tv(), 10);
    const warmId = sessions()[0].id;
    const r = await resolve(tv(), 12);
    assert.equal(r.status, 200);
    assert.notEqual(r.body.sessionId, warmId);
    assert.notEqual(r.body.warm, true);
    assert.equal(sessions().length, 1, 'the warm one is gone, the viewer\'s is running');
    assert.equal(starts, 2);

    await warming.endAll('again');
    for (const s of sessions()) await transcodeSession.removeSession(s.id);
    await warm(tv(), 11);
    const warmId2 = sessions().find(s => s.warm).id;
    const incompatible = await resolve(tv(), 11, { capabilities: { ...CAPS, hevc: true } });
    assert.equal(incompatible.status, 200);
    assert.notEqual(incompatible.body.sessionId, warmId2, 'other capabilities: a fresh start');
    assert.equal(sessions().some(s => s.id === warmId2), false);
    assert.ok(warming.status(await db.settings.get()).misses >= 2);
});

test('the channel the owner is already watching is never warmed', async () => {
    await setWarming(true);
    assert.equal((await resolve(tv(), 10)).status, 200);
    const w = await warm(tv(), 10);
    assert.equal(w.status, 204);
    assert.equal(starts, 1);
});

test('no free connection: 204, and nobody is disturbed', async () => {
    await setWarming(true);
    assert.equal((await resolve(ipad(), 10)).status, 200);
    const viewer = sessions()[0];
    const w = await warm(tv(), 11);
    assert.equal(w.status, 204);
    assert.equal(starts, 1, 'nothing new was started');
    assert.deepEqual(sessions().map(s => s.id), [viewer.id], 'the viewer is undisturbed');
    // not by a recording either
    await transcodeSession.removeSession(viewer.id);
    activeRecordings = [{ id: 5, providerId: 1 }];
    assert.equal((await warm(tv(), 11)).status, 204);
    assert.equal(sessions().length, 0);
});

test('a viewer on another device that needs the connection reclaims the warm session silently', async () => {
    await setWarming(true);
    await warm(tv(), 11);
    const warmId = sessions()[0].id;
    const r = await resolve(ipad(), 12);
    assert.equal(r.status, 200, 'no conflict prompt: nobody was watching the warm session');
    assert.equal(sessions().some(s => s.id === warmId), false);
    assert.equal(sessions().length, 1);
    assert.equal(coordinator.terminalStatus(warmId, 'device:apple-tv'), 'none', 'its owner is not told it was taken over');
    const st = warming.status(await db.settings.get());
    assert.equal(st.reclaimed, 1);
    assert.equal(st.active, 0);
});

test('a warm session ends when its time runs out', async () => {
    await setWarming(true);
    warming._setTtl(80);
    await warm(tv(), 11);
    assert.equal(sessions().length, 1);
    await sleep(250);
    assert.equal(sessions().length, 0, 'the session is stopped');
    const st = warming.status(await db.settings.get());
    assert.equal(st.expired, 1);
    assert.equal(st.active, 0);
    assert.equal(coordinator.hasFreeConnection(1, { maxProviderStreams: 1 }, []), true, 'and the connection is free again');
});

test('a recording that falls due takes the warm session first', async () => {
    await setWarming(true);
    await warm(tv(), 11);
    const warmId = sessions()[0].id;
    const schedule = { id: 91, title: 'Derby', channel_name: 'Sport', program_end: Date.now() + 3600000, post_buffer_min: 0 };
    const verdict = await coordinator.requestForRecording(schedule, { maxProviderStreams: 1 }, 1);
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /warm/);
    assert.equal(sessions().some(s => s.id === warmId), false);
    assert.equal(warming.status(await db.settings.get()).reclaimed, 1);
    coordinator.releaseLease(verdict.lease);
});

test('info says the server can warm, and whether it is switched on', async () => {
    const off = await (await fetch(`${base}/api/info`)).json();
    assert.equal(off.features.warming, true);
    assert.equal(off.warmingEnabled, false);
    await setWarming(true);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).warmingEnabled, true);
});
