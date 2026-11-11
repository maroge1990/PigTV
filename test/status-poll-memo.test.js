const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { sqlCount } = require('./helpers/sqlCount');

// I-6 (#273): the collapsed Status page polls GET /api/status every 5 s. leastReliable, the interruptions summary,
// the free-bytes read and the owner-name lookups run at most once per TTL; the segmented-recording counts stay live.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-status-memo-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const statusRoute = load('routes/status');
const segments = load('services/recordingSegments');

let server, base, adminToken, counter, clockNow;
const clock = () => clockNow;
const poll = async () => {
    const r = await fetch(`${base}/api/status?details=0`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(r.status, 200);
    return r.json();
};

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    load('db/recordingsDb').initSchema();
    load('services/playbackInterruptions').noteLost({ owner: 'user:1', channel: 'Seven', how: 'stall' });
    sqlite.getDb().prepare(`INSERT INTO channel_health (source_id, channel_key, name, at, ok, reason) VALUES (1, 'pos_1', 'Seven', ?, 0, 'refused')`).run(Date.now());
    sqlite.getDb().prepare(`INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES ('d1', '1', 'Lounge', 'tvOS', 1, 2)`).run();
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/status', statusRoute);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    clockNow = Date.now();
    statusRoute._resetMemo?.(clock);
    counter = sqlCount(sqlite.getDb());
});

after(() => {
    counter?.restore();
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const counts = () => ({
    health: counter.executions(/FROM channel_health WHERE at >= \?\s+ORDER BY/) + counter.executions(/FROM channel_health WHERE at >= \?$/),
    interruptions: counter.executions(/FROM playback_interruptions WHERE at >= \?/),
    devices: counter.executions(/FROM devices/),
    users: counter.executions(/SELECT id, username FROM app_users/)
});

test('20 polls inside the TTL compute each slow answer once; after the TTL they are recomputed', async () => {
    const realStatfs = fs.statfsSync;
    let statfsCalls = 0;
    fs.statfsSync = (...a) => { if (String(a[0]) === segments.workRoot()) statfsCalls++; return realStatfs.apply(fs, a); };
    try {
        statusRoute._resetMemo?.(clock);
        counter.reset();
        const first = await poll();
        for (let i = 0; i < 19; i++) await poll();
        assert.deepEqual(counts(), { health: 1, interruptions: 1, devices: 1, users: 1 }, 'each table scan ran once across 20 polls');
        assert.equal(statfsCalls, 1, 'free bytes read once');
        assert.equal(first.leastReliable.length, 1);
        assert.equal(first.interruptions.count, 1);

        clockNow += 61000; // past every TTL
        await poll();
        assert.deepEqual(counts(), { health: 2, interruptions: 2, devices: 2, users: 2 }, 'recomputed after the TTL');
        assert.equal(statfsCalls, 2);
    } finally { fs.statfsSync = realStatfs; }
});

test('owner names expire after 10 s, the others hold for 60 s', async () => {
    statusRoute._resetMemo?.(clock);
    counter.reset();
    await poll();
    clockNow += 11000;
    await poll();
    assert.equal(counts().devices, 2, 'owner names refreshed after 11 s');
    assert.equal(counts().health, 1, 'least reliable not yet');
    assert.equal(counts().interruptions, 1);
});

test('segmented-recording counts are live inside the TTL', async () => {
    statusRoute._resetMemo?.(clock);
    const rdb = load('db/recordingsDb');
    const before = await poll();
    assert.deepEqual(before.segmentedRecordings.failed, []);
    const cols = sqlite.getDb().prepare('PRAGMA table_info(recordings)').all().map(c => c.name);
    assert.ok(cols.includes('segment_state') && cols.includes('work_dir'), 'fixture sanity');
    sqlite.getDb().prepare(`INSERT INTO recordings (title, file_path, status, segment_state, work_dir) VALUES ('Seg', '/tmp/x.mp4', 'recording', 'failed', '/tmp/x')`).run();
    const after = await poll();
    assert.equal(after.segmentedRecordings.failed.length, 1, 'the second poll shows the new failure straight away');
});

test('two polls inside the TTL have the same body apart from time fields', async () => {
    statusRoute._resetMemo?.(clock);
    const a = await poll();
    const b = await poll();
    delete a.generatedAt; delete b.generatedAt;
    for (const x of [a, b]) for (const s of x.sessions || []) { delete s.uptimeSec; delete s.idleSec; }
    assert.deepEqual(b, a);
});
