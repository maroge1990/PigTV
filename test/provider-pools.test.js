const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0173 (multi-provider P5): per-provider connection pools in the stream coordinator
// (default path). Every rule of the single pool - free slot, idle reclaim, own
// replacement, 409, force, recording prompt - is applied within the pool of the
// provider asked for; a device watches one thing across all of them; and with no
// backup configured everything is exactly as before. Sources live in a sandboxed
// database, as the coordinator reads them from an open one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-pools-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
delete process.env.PIGTV_TUNER;
process.chdir(sandbox); // transcode-cache lands in the sandbox

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const recordingEngine = load('services/recordingEngine');
const playbackStrategy = load('services/playbackStrategy');
const { scheduled } = load('db/recordingsDb');

const S = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60 };
let A, B, C; // primary, backup 1, backup 2
let counter = 0;

async function session(owner, idleSec, providerId, opts = {}) {
    const s = await transcodeSession.createSession(`http://provider.invalid/live/${++counter}.ts`, { owner, live: true, providerId, ...opts });
    s.lastAccess = Date.now() - idleSec * 1000;
    return s;
}
const alive = s => transcodeSession.getAllSessions().some(x => x.id === s.id);
const setAccount = (sourceId, maxConnections) => sqlite.getDb().prepare(
    'INSERT OR REPLACE INTO provider_accounts (source_id, max_connections, checked_at, ok) VALUES (?, ?, ?, 1)'
).run(sourceId, maxConnections, Date.now());
const clearAccounts = () => sqlite.getDb().prepare('DELETE FROM provider_accounts').run();
const recordingOn = (providerId, id = 70) => ({ id, title: 'The News', channel_name: 'ABC', program_end: Date.now() + 3600000, post_buffer_min: 2, source_id: A.id, providerId });
const due = (id, title = 'Match') => ({ id, title, channel_name: 'Fox Sports 505', program_start: Date.now() + 60000, program_end: Date.now() + 3600000, pre_buffer_min: 0 });

// Only the primary (backups disabled): today's setup.
async function singleProvider() {
    await db.sources.update(B.id, { enabled: false });
    await db.sources.update(C.id, { enabled: false });
}
async function threeProviders() {
    await db.sources.update(B.id, { enabled: true });
    await db.sources.update(C.id, { enabled: true });
}

let server, base, realListActive, userId;
const resolveCalls = [];

before(async () => {
    userId = (await db.users.create({ username: 'owner', role: 'admin' })).id;
    A = await db.sources.create({ type: 'xtream', name: 'Strong8K', url: 'http://strong.invalid', username: 'u', password: 'p' });
    B = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    C = await db.sources.create({ type: 'm3u', name: 'Dream4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 2 });

    realListActive = recordingEngine.listActive; // listActive is stubbed for the route
    recordingEngine.listActive = () => [];
    recordingEngine.stopForViewer = async () => {};
    playbackStrategy.resolve = async (opts) => {
        resolveCalls.push(opts);
        const s = await transcodeSession.createSession(opts.url, { owner: opts.owner, live: opts.live, providerId: opts.providerId });
        return { strategy: 'transcode', url: `/api/transcode/${s.id}/stream.m3u8`, sessionId: s.id, reason: 'stubbed' };
    };
    const app = express();
    app.use(express.json());
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    clearAccounts();
    await threeProviders();
    await db.sources.update(B.id, { url: 'http://trex.invalid', username: 'u' });
    resolveCalls.length = 0;
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

// ------------------------------------------------------------------ limits --

test('limit: with no backup configured it is maxProviderStreams (default 1), whatever the account says', async () => {
    await singleProvider();
    setAccount(A.id, 4);
    assert.equal(coordinator.providerLimit(A.id, {}), 1);
    assert.equal(coordinator.providerLimit(A.id, { maxProviderStreams: 3 }), 3);
    assert.equal(coordinator.providerLimit(null, { maxProviderStreams: 2 }), 2);
    assert.equal(coordinator.providerLimit(B.id, { maxProviderStreams: 2 }), 2, 'a disabled backup is not a pool of its own');
});

test('limit: a backup uses its account, else 1', async () => {
    assert.equal(coordinator.providerLimit(B.id, S), 1);
    setAccount(B.id, 3);
    assert.equal(coordinator.providerLimit(B.id, S), 3);
    await db.sources.update(B.id, { maxConnections: 2 });
    assert.equal(coordinator.providerLimit(B.id, S), 3, '0182: a hand-typed limit is not read');
    assert.equal(coordinator.providerLimit(B.id, { maxProviderStreams: 6 }), 3, 'the legacy setting never applies to a backup');
});

test('limit: the primary with backups takes the larger of its account and maxProviderStreams', async () => {
    assert.equal(coordinator.providerLimit(A.id, S), 1);
    assert.equal(coordinator.providerLimit(null, { maxProviderStreams: 2 }), 2, 'an admin who raised the legacy setting keeps it');
    setAccount(A.id, 3);
    assert.equal(coordinator.providerLimit(A.id, S), 3);
    assert.equal(coordinator.providerLimit(A.id, { maxProviderStreams: 4 }), 4);
});

// ------------------------------------------------------------------ viewers --

test('a viewer on A: a second device is refused on A but fits on B (canAdmitWithoutDisturbing)', async () => {
    await session('device:tv', 5, A.id);
    const opts = { owner: 'device:ipad', settings: S, activeRecordings: [] };
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: A.id }), false);
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts }), false, 'no providerId is the primary pool');
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: B.id }), true);
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: C.id }), true);
    assert.equal(transcodeSession.getAllSessions().length, 1, 'asking changes nothing');
    // Own replacement and idle reclaim count as "without disturbing".
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, owner: 'device:tv', providerId: A.id }), true);
});

test('pools are independent: a full A does not block B, and B full does not reclaim or ask about A', async () => {
    const onA = await session('device:tv', 5, A.id);
    const verdict = coordinator.requestForViewer({ owner: 'device:ipad', settings: S, providerId: B.id });
    assert.deepEqual(verdict, { allowed: true, release: [] }, 'nothing on A is touched');

    const idleOnA = await session('device:old', 300, A.id);
    await session('device:phone', 5, B.id);
    const refused = coordinator.requestForViewer({ owner: 'device:ipad', settings: S, providerId: B.id });
    assert.equal(refused.allowed, false, 'the idle stream on A does not make room on B');
    assert.equal(refused.conflict.type, 'viewer-in-progress');
    assert.equal(refused.conflict.providerId, B.id, 'the conflict names its provider when there is more than one');
    assert.deepEqual(refused.release, []);
    assert.ok(alive(onA) && alive(idleOnA));

    // Idle reclaim within A only.
    await transcodeSession.removeSession(onA.id);
    const onA2 = coordinator.requestForViewer({ owner: 'device:ipad', settings: S, providerId: A.id });
    assert.equal(onA2.allowed, true);
    assert.deepEqual(onA2.release.map(r => [r.stream.id, r.cause]), [[idleOnA.id, 'idle']]);
});

test('three providers: three devices each get a provider; a fourth is refused on each, and force acts on one pool', async () => {
    await session('device:1', 5, A.id);
    await session('device:2', 5, B.id);
    const onC = await session('device:3', 5, C.id);
    for (const p of [A.id, B.id, C.id]) {
        assert.equal(coordinator.canAdmitWithoutDisturbing({ owner: 'device:4', settings: S, providerId: p }), false);
    }
    const forced = await coordinator.admitViewer({ owner: 'device:4', settings: S, providerId: C.id, force: true });
    assert.equal(forced.allowed, true);
    assert.deepEqual(forced.release.map(r => r.stream.id), [onC.id]);
    assert.equal(transcodeSession.getAllSessions().length, 2, 'only C was taken');
    assert.equal(coordinator.terminalStatus(onC.id, 'device:3'), 'taken-over');
});

test('a device admitted on B has its own stream on A released (replacement), and only its own', async () => {
    const mineOnA = await session('device:tv', 5, A.id);
    const theirsOnA = await session('device:ipad', 5, A.id);
    const verdict = coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: B.id });
    assert.deepEqual(verdict.release.map(r => [r.stream.id, r.cause]), [[mineOnA.id, 'replacement']]);

    const admitted = await coordinator.admitViewer({ owner: 'device:tv', settings: S, providerId: B.id });
    assert.equal(admitted.allowed, true);
    assert.ok(!alive(mineOnA), 'its earlier stream on A is gone');
    assert.ok(alive(theirsOnA), "another device's stream is untouched");

    // A refused admission releases nothing elsewhere.
    const again = await session('device:tv', 5, A.id);
    await session('device:phone', 5, B.id);
    const refused = await coordinator.admitViewer({ owner: 'device:tv', settings: S, providerId: B.id });
    assert.equal(refused.allowed, false);
    assert.ok(alive(again));

    // releaseOwnerElsewhere on its own, for P6.
    assert.equal(await coordinator.releaseOwnerElsewhere('device:tv', C.id), 1);
    assert.ok(!alive(again));
    assert.equal(await coordinator.releaseOwnerElsewhere(null, C.id), 0, 'an unidentified caller owns nothing');
});

test('a recording on B counts against B only', async () => {
    const onB = recordingOn(B.id);
    const onA = coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: A.id, activeRecordings: [onB] });
    assert.deepEqual(onA, { allowed: true, release: [] });

    const blocked = coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: B.id, activeRecordings: [onB] });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.conflict.type, 'recording-in-progress');
    assert.equal(blocked.conflict.providerId, B.id);

    const forced = coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: B.id, activeRecordings: [onB, recordingOn(A.id, 71)], force: true });
    assert.deepEqual(forced.sacrificed, [70], 'force on B stops only the recording on B');

    // A schedule row with no providerId counts in its source's pool (the primary's).
    const legacyRow = { ...recordingOn(undefined, 72) }; delete legacyRow.providerId;
    assert.equal(coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: A.id, activeRecordings: [legacyRow] }).allowed, false);
    assert.equal(coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: B.id, activeRecordings: [legacyRow] }).allowed, true);
});

// --------------------------------------------------------------- recordings --

test('canRecordFreely: free slot or idle reclaim, never a live viewer; recordings already on the provider count', async () => {
    await session('device:tv', 5, A.id);
    assert.equal(coordinator.canRecordFreely(A.id, S, []), false, 'a live viewer on A');
    assert.equal(coordinator.canRecordFreely(B.id, S, []), true);
    assert.equal(coordinator.canRecordFreely(B.id, S, [recordingOn(B.id)]), false, 'a recording already holds B');
    assert.equal(coordinator.canRecordFreely(C.id, S, [recordingOn(B.id)]), true);

    const stale = await session('device:old', 300, C.id);
    assert.equal(coordinator.canRecordFreely(C.id, S, []), true, 'an abandoned stream can be reclaimed');
    assert.ok(alive(stale), 'asking reclaims nothing');
    const verdict = await coordinator.requestForRecording(due(90), S, C.id);
    assert.equal(verdict.allowed, true);
    assert.ok(!alive(stale), 'requestForRecording reclaims within C');
});

test('requestForRecording, announce and prompt stay within the pool concerned', async () => {
    const onA = await session('device:tv', 5, A.id);

    // Due on B, a viewer on A: nothing to ask, nothing released.
    assert.equal((await coordinator.requestForRecording(due(91), S, B.id)).allowed, true);
    coordinator.announceUpcoming(due(92), S, B.id);
    assert.equal(coordinator._prompts.has(92), false, 'no warning for a recording on a free provider');
    assert.ok(alive(onA));

    // Due on A: the viewer on A is warned, and only a viewer on A is shown it.
    coordinator.announceUpcoming(due(93, 'Grand Final'), S, A.id);
    assert.ok(coordinator._prompts.has(93));
    assert.equal(coordinator.pendingPrompt(S, B.id), null, 'a viewer on B is not asked');
    assert.equal(coordinator.pendingPrompt(S, A.id).scheduleId, 93);
    assert.equal(coordinator.pendingPrompt(S).scheduleId, 93, 'no provider: any prompt, as before');
    assert.equal(coordinator.pendingPrompt(S, null).scheduleId, 93, 'null is the primary pool');

    const asked = await coordinator.requestForRecording(due(93, 'Grand Final'), S, A.id);
    assert.equal(asked.allowed, false);
    // The answer timeout takes only A's viewers.
    const onB = await session('device:ipad', 5, B.id);
    coordinator._prompts.get(93).dueSince = Date.now() - 10 * 60000;
    const took = await coordinator.requestForRecording(due(93, 'Grand Final'), S, A.id);
    assert.equal(took.allowed, true);
    assert.ok(!alive(onA) && alive(onB));
});

test('GET /conflict shows a viewer only the prompts for the provider it is watching on', async () => {
    const token = (deviceId) => {
        sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(deviceId, String(userId), deviceId, 'test', Date.now(), Date.now());
        return jwt.sign({ id: userId, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    };
    await session('device:tv', 5, A.id);
    await session('device:ipad', 5, B.id);
    coordinator.announceUpcoming(due(94), S, A.id);
    const ask = async (t) => (await fetch(`${base}/api/playback/conflict`, { headers: t ? { Authorization: `Bearer ${t}` } : {} })).json();
    assert.equal((await ask(token('tv'))).scheduleId, 94);
    assert.equal(await ask(token('ipad')), null);
    // A browser's sign-in names no device: it sees every prompt, as before.
    const web = jwt.sign({ id: userId, username: 'owner', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await ask(web)).scheduleId, 94, 'a poller with no device: as before');
    // R01: and without signing in, nothing.
    assert.equal((await fetch(`${base}/api/playback/conflict`)).status, 401);
});

// ---------------------------------------------------------------- plumbing --

test('resolve: a channel play carries its source as providerId; a bare url carries null (the primary pool)', async () => {
    sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('tv', String(userId), 'tv', 'test', Date.now(), Date.now());
    const t = jwt.sign({ id: userId, username: 'owner', role: 'admin', deviceId: 'tv' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const post = (body) => fetch(`${base}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify(body)
    });
    assert.equal((await post({ sourceId: A.id, channelId: '505' })).status, 200);
    assert.equal(resolveCalls[0].providerId, A.id);
    assert.deepEqual(coordinator.activeStreams().map(s => s.providerId), [A.id]);

    assert.equal((await post({ url: 'http://provider.invalid/live/9.ts' })).status, 200);
    assert.equal(resolveCalls[1].providerId, null);
    assert.deepEqual(coordinator.activeStreams().map(s => s.providerId), [null], 'its own earlier stream was replaced in the same (primary) pool');
});

test('listActive exposes each recording\'s providerId (its schedule\'s source until P7 chooses)', () => {
    const row = scheduled.create({ title: 'Test', description: null, source_id: A.id, channel_item_id: '505', channel_name: 'Fox',
        channel_logo: null, program_start: Date.now(), program_end: Date.now() + 60000, pre_buffer_min: 0, post_buffer_min: 0,
        created_by: 1, created_at: Date.now() });
    scheduled.setStatus(row.id, 'recording');
    const listed = realListActive().find(r => r.id === row.id);
    assert.equal(listed.providerId, A.id);
    scheduled.setStatus(row.id, 'completed');
});

// ------------------------------------------------------- single provider --

test('with no backup configured every scenario has today\'s outcome, whatever providerIds the streams carry', async () => {
    await singleProvider();
    setAccount(A.id, 3); // ignored with one provider

    // A viewer anywhere fills the one connection; the second device gets today's 409, with no providerId.
    const theirs = await session('device:tv', 5, B.id); // a stale id from a backup that has since been disabled
    for (const providerId of [undefined, null, A.id, B.id, C.id]) {
        const v = coordinator.requestForViewer({ owner: 'device:ipad', settings: S, providerId });
        assert.equal(v.allowed, false);
        assert.deepEqual(Object.keys(v.conflict).sort(), ['lastActiveSec', 'message', 'streamId', 'type']);
        assert.equal(v.conflict.streamId, theirs.id);
        assert.equal(v.conflict.message, 'Another device is watching. Your provider allows one stream at a time, so watching here will stop it.');
        assert.equal(coordinator.canAdmitWithoutDisturbing({ owner: 'device:ipad', settings: S, providerId }), false);
    }

    // Own replacement and idle reclaim, as before.
    const own = coordinator.requestForViewer({ owner: 'device:tv', settings: S, providerId: A.id });
    assert.deepEqual(own.release.map(r => [r.stream.id, r.cause]), [[theirs.id, 'replacement']]);

    // With room (limit 2), a device's earlier stream is kept, as before (no "elsewhere").
    const roomy = coordinator.requestForViewer({ owner: 'device:tv', settings: { ...S, maxProviderStreams: 2 }, providerId: C.id });
    assert.deepEqual(roomy, { allowed: true, release: [] });

    // Every recording counts, whatever its provider.
    const rec = coordinator.requestForViewer({ owner: 'device:x', settings: { ...S, maxProviderStreams: 2 }, providerId: A.id, activeRecordings: [recordingOn(C.id)] });
    assert.equal(rec.allowed, false);
    assert.equal(rec.conflict.type, 'recording-in-progress');
    assert.equal(rec.conflict.providerId, undefined);

    // Recording prompt and announce: the viewer is asked whichever provider the schedule names.
    coordinator.announceUpcoming(due(95), S, C.id);
    assert.ok(coordinator._prompts.has(95));
    assert.equal(coordinator.pendingPrompt(S, A.id).scheduleId, 95);
    assert.equal((await coordinator.requestForRecording(due(96), S, C.id)).prompted, true);
    assert.ok(alive(theirs));
    assert.equal(await coordinator.releaseOwnerElsewhere('device:tv', A.id), 0);
});

// ------------------------------------------ 0181: the same account is one pool --

test('0181: two sources with the same server and login are one pool; another login on the same server stays separate', async () => {
    // Trex configured with Strong8K's server and login (the 1 Oct live cause), written with another case and the default port.
    await db.sources.update(B.id, { url: 'HTTP://Strong.invalid:80/', username: 'u' });
    await session('device:tv', 5, A.id);
    const opts = { owner: 'device:ipad', settings: S, activeRecordings: [] };
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: B.id }), false, 'a second viewer on the twin is not admitted');
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: A.id }), false);
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: C.id }), true, 'an unrelated provider is unaffected');
    const verdict = coordinator.requestForViewer({ ...opts, providerId: B.id });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.conflict.type, 'viewer-in-progress', 'asked about, not silently disturbed');
    assert.equal(transcodeSession.getAllSessions().length, 1, 'nothing was stopped');
    // A viewer on the twin holds the primary's connection too.
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    await session('device:tv', 5, B.id);
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: A.id }), false);
    // Same server, a different username: its own account, its own pool.
    await db.sources.update(B.id, { username: 'someone-else' });
    assert.equal(coordinator.canAdmitWithoutDisturbing({ ...opts, providerId: A.id }), true);
});

test('0181: a shared pool\'s limit is the lowest among its sources', async () => {
    await db.sources.update(B.id, { url: 'http://strong.invalid', username: 'u' });
    setAccount(B.id, 1);
    setAccount(A.id, 3);
    assert.equal(coordinator.providerLimit(B.id, S), 1);
    assert.equal(coordinator.providerLimit(A.id, S), 1, 'the primary sees the same pool limit');
    setAccount(B.id, 5);
    assert.equal(coordinator.providerLimit(A.id, S), 3);
});

test('0181: no twin, no change: the primary and backups keep their own limits and pools', async () => {
    setAccount(A.id, 2);
    setAccount(B.id, 4);
    assert.equal(coordinator.providerLimit(A.id, S), 2);
    assert.equal(coordinator.providerLimit(B.id, S), 4);
});
