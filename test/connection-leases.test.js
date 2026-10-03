const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// R11: provider connections are leased by the decision that admits somebody, before the probe,
// so two near-simultaneous contenders cannot both be admitted. The real resolve route runs here
// (a copy of the server, as playback-arbitration does); only the ffmpeg start and the probe
// are faked: the probe is seeded into the cache, the session's start() does nothing.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-leases-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
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
const { probeCache, analyzeProbeResult } = load('services/streamProbe');

let server, base;
let activeRecordings = [];
recordingEngine.listActive = () => activeRecordings;
recordingEngine.stopForViewer = async () => {};

const S = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The window between "admitted" and "session registered": how long the fake probe takes.
let probeDelayMs = 0;
let createFails = false;
const realCreate = transcodeSession.createSession;
let starts = 0;
transcodeSession.createSession = async (url, opts) => {
    if (probeDelayMs) await sleep(probeDelayMs);
    if (createFails) throw new Error('the stream could not be opened');
    const s = await realCreate(url, opts);
    starts++;
    s.start = async () => {};
    s.waitForPlaylist = async () => true;
    return s;
};

function seedProbe(url, caps) {
    return db.settings.get().then(current => {
        const merged = { ...playbackStrategy.DEFAULT_CAPABILITIES, ...caps };
        const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                                { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                      format: { format_name: 'mpegts' } };
        const key = `${url}|${db.getUserAgent(current) || ''}|${Object.keys(merged).filter(k => merged[k]).sort().join(',')}`;
        probeCache.set(key, { result: analyzeProbeResult(raw, url, merged), timestamp: Date.now() });
    });
}

function deviceToken(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, '1', deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const tvToken = () => deviceToken('apple-tv');
const ipadToken = () => deviceToken('ipad');

const CAPS = { segmentedDelivery: true };
async function resolve(token, n = 1) {
    const url = `http://provider.invalid/live/u/p/${n}.ts`;
    await seedProbe(url, CAPS);
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, capabilities: CAPS })
    });
    return { status: response.status, body: await response.json() };
}

const sessions = () => transcodeSession.getAllSessions();
const quietly = async (fn) => {
    const warn = console.warn; const lines = [];
    console.warn = (...a) => lines.push(a.join(' '));
    try { return [await fn(), lines]; } finally { console.warn = warn; }
};

before(async () => {
    await db.users.create({ username: 'owner', role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    probeDelayMs = 0;
    createFails = false;
    activeRecordings = [];
    for (const s of sessions()) await transcodeSession.removeSession(s.id);
    coordinator._leases.clear();
});

after(() => {
    server.closeAllConnections?.();
    server.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it for the OS temp cleaner */ }
});

// --------------------------------------------------------------- the race --

test('two concurrent resolves for a one-connection provider: exactly one is admitted, the other gets the normal conflict', async () => {
    probeDelayMs = 150; // the probe: both decisions are made inside this window
    const [a, b] = await Promise.all([resolve(tvToken(), 1), resolve(ipadToken(), 2)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], 'one plays, the other is told somebody else is watching');
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.conflict.type, 'viewer-in-progress');
    assert.equal(sessions().length, 1, 'the provider sees one connection');
    assert.equal(starts >= 1, true);
});

test('the lease hands its count to the session: counted once, never twice, never none', async () => {
    const { status, body } = await resolve(tvToken(), 3);
    assert.equal(status, 200);
    assert.equal(sessions().length, 1);
    const mine = coordinator.listLeases().filter(l => l.sessionId === body.sessionId);
    assert.equal(mine.length, 1, 'the lease is bound to the session it became');
    assert.equal(coordinator.hasFreeConnection(null, S, []), false, 'the connection is taken');
    assert.equal(coordinator.requestForViewer({ owner: 'device:other', settings: S }).allowed, false);
    // limit 2: one session + a bound lease is one connection, so a second is free
    assert.equal(coordinator.hasFreeConnection(null, { ...S, maxProviderStreams: 2 }, []), true, 'never counted twice');
});

test('a viewer resolve racing a recording start never exceeds the limit', async () => {
    // The recording is admitted first (a lease, no running recording yet): a viewer is refused.
    const schedule = { id: 77, title: 'News', channel_name: 'Ch 1', program_end: Date.now() + 3600000, post_buffer_min: 0 };
    const verdict = await coordinator.requestForRecording(schedule, S);
    assert.equal(verdict.allowed, true);
    assert.ok(verdict.lease, 'the recording took a lease with its decision');
    const v = coordinator.requestForViewer({ owner: 'device:tv', settings: S, activeRecordings: [] });
    assert.equal(v.allowed, false);
    assert.equal(v.conflict.type, 'recording-in-progress');
    assert.equal(v.conflict.scheduleId, 77);
    // ...and the reverse: a viewer mid-probe makes a recording due now wait and ask, not stack.
    coordinator.releaseLease(verdict.lease);
    probeDelayMs = 200;
    const viewer = resolve(tvToken(), 4);
    // Until the viewer's request has been admitted (its lease exists) - not a fixed sleep, which a
    // loaded machine outruns before the HTTP request even reaches the route.
    for (let i = 0; i < 200 && ![...coordinator._leases.values()].some(l => l.purpose === 'viewer'); i++) await sleep(5);
    const due = await coordinator.requestForRecording(schedule, S);
    assert.equal(due.allowed, false, 'the viewer in the middle of its start holds the only connection');
    assert.equal(due.prompted, true);
    assert.equal((await viewer).status, 200);
    coordinator.clearPrompt(77);
    assert.equal(sessions().length, 1);
});

test('a forced viewer takes the lease of a recording that has not started: that start gives up', async () => {
    const schedule = { id: 78, title: 'Film', channel_name: 'Ch 2', program_end: Date.now() + 3600000, post_buffer_min: 0 };
    const { lease } = await coordinator.requestForRecording(schedule, S);
    const verdict = await coordinator.admitViewer({ owner: 'device:tv', settings: S, force: true, activeRecordings: [] });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.sacrificed, [78]);
    assert.equal(coordinator.leaseAlive(lease), false, 'the recording must not start after all');
    coordinator.releaseLease(verdict.lease);
});

test('a recording lease is not counted twice once the recording is running', async () => {
    const schedule = { id: 79, title: 'Quiz', channel_name: 'Ch 3', program_end: Date.now() + 3600000, post_buffer_min: 0 };
    const { lease } = await coordinator.requestForRecording(schedule, { ...S, maxProviderStreams: 2 });
    const two = { ...S, maxProviderStreams: 2 };
    assert.equal(coordinator.hasFreeConnection(null, two, []), true, 'one of two taken by the lease');
    // The row now says 'recording': listActive() lists it, and the lease (still unbound) must not add a second.
    const running = [{ id: 79, providerId: null, title: 'Quiz' }];
    assert.equal(coordinator.hasFreeConnection(null, two, running), true, 'the recording counts once');
    assert.equal(coordinator.canRecordFreely(null, two, running), true);
    coordinator.bindLeaseToRecording(lease, 5);
    assert.equal(coordinator.hasFreeConnection(null, two, running), true);
    assert.equal(coordinator.hasFreeConnection(null, two, []), true, 'bound: the engine counts the row, not the lease');
});

// ---------------------------------------------------------------- release --

test('a failed resolve releases its lease', async () => {
    createFails = true;
    const first = await resolve(tvToken(), 5);
    assert.equal(first.status, 500);
    assert.equal(coordinator.listLeases().length, 0, 'nothing is left holding the connection');
    createFails = false;
    assert.equal((await resolve(ipadToken(), 6)).status, 200, 'the next contender is admitted');
});

test('a direct play (no session at all) leaves no lease behind', async () => {
    // direct play: no session at all
    const url = 'http://provider.invalid/live/u/p/9.m3u8';
    const current = await db.settings.get();
    const merged = { ...playbackStrategy.DEFAULT_CAPABILITIES };
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }, { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }], format: { format_name: 'hls' } };
    probeCache.set(`${url}|${db.getUserAgent(current) || ''}|${Object.keys(merged).filter(k => merged[k]).sort().join(',')}`, { result: analyzeProbeResult(raw, url, merged), timestamp: Date.now() });
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tvToken()}` }, body: JSON.stringify({ url })
    });
    assert.equal((await response.json()).strategy, 'direct');
    assert.equal(coordinator.listLeases().length, 0);
});

test('an unbound lease expires, with a warning, and stops counting', async () => {
    const lease = coordinator.takeLease(null, 'viewer', { owner: 'device:tv', ttlMs: 30 });
    assert.equal(coordinator.hasFreeConnection(null, S, []), false);
    await sleep(60);
    const [free, warnings] = await quietly(async () => coordinator.hasFreeConnection(null, S, []));
    assert.equal(free, true, 'a leaked lease cannot hold a connection forever');
    assert.equal(coordinator.leaseAlive(lease), false);
    assert.ok(warnings.some(w => /expired unbound/.test(w)), 'and it says so');
    assert.equal(coordinator.LEASE_TTL_MS, 60000);
});

// ------------------------------------------------------ standby and warm --

test('tryReserveFree: a lease only when a connection is free, atomically, and never by disturbing anybody', async () => {
    const one = coordinator.tryReserveFree(null, 'standby', S, []);
    assert.ok(one);
    assert.equal(coordinator.tryReserveFree(null, 'standby', S, []), null, 'two callers cannot both find it free');
    coordinator.releaseLease(one);
    const s = await transcodeSession.createSession('http://provider.invalid/live/1.ts', { owner: 'device:tv', live: true });
    s.lastAccess = Date.now() - 600000; // abandoned: reclaimable by a viewer, but not something a standby may take
    assert.equal(coordinator.tryReserveFree(null, 'standby', S, []), null);
    assert.equal(sessions().length, 1, 'nothing was reclaimed');
    activeRecordings = [{ id: 1, providerId: null }];
    await transcodeSession.removeSession(s.id);
    assert.equal(coordinator.tryReserveFree(null, 'warm', S, activeRecordings), null, 'a recording holds it');
});

test('a standby start loses cleanly to a viewer that arrives during its probe', async () => {
    let told = null;
    const lease = coordinator.tryReserveFree(null, 'standby', S, [], { owner: 'standby:r1', onReclaim: (why) => { told = why; } });
    assert.ok(lease);
    const verdict = await coordinator.admitViewer({ owner: 'device:tv', settings: S, activeRecordings: [] });
    assert.equal(verdict.allowed, true, 'the viewer is admitted without a prompt');
    assert.deepEqual(verdict.release.map(r => r.cause), ['standby']);
    assert.equal(told, 'reclaimed', 'the standby\'s owner is told to stop');
    assert.equal(coordinator.leaseAlive(lease), false);
    assert.equal(coordinator.bindLease(lease, 'x'), false);
    // The real resolve, handed the lost lease, starts no session.
    const url = 'http://provider.invalid/live/u/p/11.ts';
    await seedProbe(url, CAPS);
    const before = starts;
    await assert.rejects(playbackStrategy.resolve({ url, capabilities: CAPS, settings: await db.settings.get(), lease, owner: 'standby:r1' }),
        err => err.superseded === true);
    assert.equal(starts, before, 'no session was created for the lost lease');
    coordinator.releaseLease(verdict.lease);
});

test('warm is reclaimed first and silently: before a standby, with no prompt and no terminal-status note', async () => {
    const two = { ...S, maxProviderStreams: 2 };
    const warm = await transcodeSession.createSession('http://provider.invalid/live/w.ts', { owner: 'device:tv', live: true, warm: true });
    const standby = await transcodeSession.createSession('http://provider.invalid/live/s.ts', { owner: 'standby:r', live: true, standby: true });
    const verdict = await coordinator.admitViewer({ owner: 'device:ipad', settings: two, activeRecordings: [] });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => [r.stream.id, r.cause]), [[warm.id, 'warm']]);
    assert.equal(sessions().some(s => s.id === warm.id), false, 'the warm session is gone');
    assert.equal(sessions().some(s => s.id === standby.id), true, 'the standby is untouched while the warm one sufficed');
    assert.equal(coordinator.terminalStatus(warm.id, 'device:tv'), 'none', 'its owner is not told it was taken over');
    assert.equal(coordinator.pendingPrompt(S), null);
    coordinator.releaseLease(verdict.lease);
});

test('warm never displaces a viewer or a recording, and a recording takes it first', async () => {
    const warm = await transcodeSession.createSession('http://provider.invalid/live/w2.ts', { owner: 'device:tv', live: true, warm: true });
    const schedule = { id: 90, title: 'Match', channel_name: 'Sport', program_end: Date.now() + 3600000, post_buffer_min: 0 };
    const verdict = await coordinator.requestForRecording(schedule, S);
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /warm session gave up/);
    assert.equal(sessions().some(s => s.id === warm.id), false);
    assert.ok(verdict.lease);
    // The recording holds the only connection: a warm lease is refused, and a viewer is asked, not given it.
    assert.equal(coordinator.tryReserveFree(null, 'warm', S, []), null);
    assert.equal(coordinator.requestForViewer({ owner: 'device:ipad', settings: S, activeRecordings: [] }).allowed, false);
    coordinator.releaseLease(verdict.lease);
});

test('a warm lease is reclaimed by a viewer mid-probe, calling onReclaim', async () => {
    let told = null;
    const lease = coordinator.tryReserveFree(null, 'warm', S, [], { owner: 'device:tv', onReclaim: (why) => { told = why; } });
    const verdict = await coordinator.admitViewer({ owner: 'device:ipad', settings: S, activeRecordings: [] });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => r.cause), ['warm']);
    assert.equal(told, 'reclaimed');
    assert.equal(coordinator.leaseAlive(lease), false);
    coordinator.releaseLease(verdict.lease);
});

test('a standby takes the only spare connection from a warm channel; nothing else does', async () => {
    let reclaimed = 0;
    const warm = coordinator.takeLease(null, 'warm', { owner: 'device:tv', onReclaim: () => { reclaimed++; } });
    assert.equal(coordinator.tryReserveFree(null, 'standby', S, []), null, 'no free connection while the warm one holds it');
    assert.equal(coordinator.tryReserveFree(null, 'warm', S, []), null, 'a second warm takes nothing');
    const standby = await coordinator.reserveTakingWarm(null, 'standby', S, []);
    assert.ok(standby, 'the standby gets the connection');
    assert.equal(coordinator.leaseAlive(warm), false, 'the warm channel gave it up');
    assert.equal(reclaimed, 1);
    assert.equal(await coordinator.reserveTakingWarm(null, 'standby', S, []), null, 'with no warm channel left, nothing more is taken');
    coordinator.releaseLease(standby);
});
