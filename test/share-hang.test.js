const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createFakeSegmentFfmpeg, stubNativeTools, drainSegmentQueue, until: untilTicked } = require('./helpers/fakeSegmentFfmpeg');

// #8: a hung recordings share must not freeze the server. Its file calls run in a helper process with a deadline
// (services/shareFs.js), so the event loop that serves every stream keeps going. The hang is simulated twice over:
// the helper waits forever on the share folder (PIGTV_TEST_SHARE_HANG), and any synchronous call this process still
// makes on it blocks for 3 s, which is what a frozen SMB server does to Node.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-share-hang-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const share = path.join(sandbox, 'share');
const recordingsPath = path.join(share, 'Recordings');
fs.mkdirSync(recordingsPath, { recursive: true });
// A share that answers the helper but would block any synchronous call this process makes on it (#144).
const slowShare = path.join(sandbox, 'slow-share');
fs.mkdirSync(path.join(slowShare, 'Recordings'), { recursive: true });
process.env.PIGTV_TEST_SHARE_HANG = share;

const load = p => require(path.join(sandbox, 'server', p));
const express = require(path.join(sandbox, 'node_modules', 'express'));
const db = load('db');
const auth = load('auth');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false); // no background MP4 preparation of the recordings these tests finish
const segments = load('services/recordingSegments');
let shareFs = null; // absent before #8: the proof runs this file against the old server too
try { shareFs = load('services/shareFs'); } catch { /* old server */ }

// Every recording is segmented (D-48): captured into appdata, its MP4 published to the share at the end.
const fake = createFakeSegmentFfmpeg(sandbox);
const slowRecordings = path.join(slowShare, 'Recordings');
const healthy = path.join(sandbox, 'healthy', 'Recordings'); // a share that answers, to finish what a test left
fs.mkdirSync(healthy, { recursive: true });

// Any synchronous call on the share from this process blocks, as on a hung mount.
const blocked = [];
let bypass = false; // a stand-in helper's own calls (deferringHelper) are not this process's
/** Real file calls on the share, from this process, for a test's own setup and checks. */
const real = (fn) => { const was = bypass; bypass = true; try { return fn(); } finally { bypass = was; } };
const onShare = (p) => !bypass && (String(p).startsWith(share) || String(p).startsWith(slowShare));
let hangMs = 3000;
const hang = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hangMs);
// The remux is ffmpeg, a process of its own: its writes to the share are not this process's.
const remuxed = stubNativeTools(engine);
const stubRemux = engine._nativeTools.ffmpeg;
engine._nativeTools.ffmpeg = (...a) => real(() => stubRemux(...a));
// #287: and the calls that name a second path (link, rename, copy: either end on the share blocks).
const twoPaths = new Set(['linkSync', 'renameSync', 'copyFileSync']);
for (const name of ['existsSync', 'statSync', 'statfsSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'unlinkSync', 'linkSync',
    'renameSync', 'copyFileSync', 'appendFileSync']) {
    const real = fs[name];
    fs[name] = function (p, ...rest) {
        const to = twoPaths.has(name) ? rest[0] : null;
        if (onShare(p) || (to !== null && onShare(to))) { blocked.push(`${name} ${p}${to !== null ? ` -> ${to}` : ''}`); hang(); }
        return real.call(this, p, ...rest);
    };
}

/** The longest gap between 20 ms timer ticks while `work` runs: how long the event loop was frozen. */
async function loopFreeze(work) {
    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    try { return { result: await work(), worst: () => worst }; } finally { clearInterval(timer); }
}

let server, base, token;
before(async () => {
    if (shareFs) shareFs.tuning.timeoutMs = 1500;
    await db.settings.update({ recordingsPath, minFreeSpaceGB: 0 });
    token = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    load('db/recordingsDb').initSchema();
    const app = express();
    app.use(express.json());
    app.use('/api/status', load('routes/status'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.close();
    shareFs?.reset();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('GET /api/status answers at once and never touches the share', async () => {
    blocked.length = 0;
    const began = Date.now();
    const r = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    const ms = Date.now() - began;
    assert.equal(r.status, 200);
    assert.deepEqual(blocked, [], 'no synchronous call on the share');
    assert.ok(ms < 1000, `answered in ${ms} ms`);
    const body = await r.json();
    assert.equal(JSON.stringify(body).includes('hunter'), false);
});

test('the folder health check reports a hung share as unresponsive without freezing the loop', async () => {
    blocked.length = 0;
    const { result, worst } = await loopFreeze(() => engine.checkFolderHealthNow());
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'unresponsive');
    assert.deepEqual(blocked, []);
    assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
});

test('getRecordingsRoot fails with a clear reason instead of blocking, and the helper comes back for a working folder', async () => {
    blocked.length = 0;
    const { worst } = await loopFreeze(() => assert.rejects(() => engine.getRecordingsRoot(), /not responding/));
    assert.deepEqual(blocked, []);
    assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    const elsewhere = path.join(sandbox, 'local-recordings');
    fs.mkdirSync(elsewhere);
    await db.settings.update({ recordingsPath: elsewhere });
    try {
        assert.equal(await engine.getRecordingsRoot(), elsewhere, 'a fresh helper answers for a healthy folder');
        assert.equal((await engine.checkFolderHealthNow()).ok, true);
    } finally {
        await db.settings.update({ recordingsPath });
    }
});

test('#142: helpers stuck after a kill are bounded; calls then fail at once until one exits', async () => {
    const { EventEmitter } = require('node:events');
    const realFork = shareFs._spawner.fork;
    const forks = [];
    shareFs.reset();
    shareFs.tuning.timeoutMs = 100;
    shareFs._spawner.fork = () => {
        const fake = Object.assign(new EventEmitter(), {
            connected: true, exitCode: null, signalCode: null,
            send() {}, kill() { this.connected = false; }, unref() {}, channel: { ref() {}, unref() {} }
        });
        forks.push(fake);
        return fake;
    };
    try {
        await assert.rejects(() => shareFs.exists('/anywhere'), { code: 'SHARE_UNRESPONSIVE' });
        await assert.rejects(() => shareFs.exists('/anywhere'), { code: 'SHARE_UNRESPONSIVE' });
        assert.equal(forks.length, 2);
        const began = Date.now();
        await assert.rejects(() => shareFs.exists('/anywhere'), { code: 'SHARE_UNRESPONSIVE' });
        assert.ok(Date.now() - began < 50, 'failed at once');
        assert.equal(forks.length, 2, 'no third helper while two are stuck');
        forks[0].emit('exit', null, 'SIGKILL');
        await assert.rejects(() => shareFs.exists('/anywhere'), { code: 'SHARE_UNRESPONSIVE' });
        assert.equal(forks.length, 3, 'one exited: a new helper may try');
    } finally {
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
    }
});

/** The provider, the channel and a due schedule (the engine runs the segment fake; the tests drive tick() themselves). */
async function recordingSetup(title) {
    const { scheduled, recordings } = load('db/recordingsDb');
    let source = (await db.sources.getAll()).find(s => s.name === 'Provider');
    if (!source) {
        source = await db.sources.create({ type: 'm3u', name: 'Provider', url: 'http://provider.invalid/list.m3u' });
        load('db/sqlite').getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
            VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 0, 1, 'ff', 'http://provider.invalid/ff.ts')`).run(`${source.id}:pos_1`, source.id);
    }
    engine.init({ ffmpegPath: fake.path, ffprobePath: 'ffprobe' });
    engine.shutdown();
    const now = Date.now();
    const s = scheduled.create({ title, description: null, source_id: source.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
        channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    return { s, scheduled, recordings };
}

/** Whatever a test left to finish is finished on a share that answers, so the next test's queue starts empty. */
async function finishLeftovers() {
    await engine.stopAllActive(3000);
    await db.settings.update({ recordingsPath: healthy });
    shareFs.reset();
    bypass = true;
    try { await drainSegmentQueue(segments, load('db/recordingsDb').recordings); } finally { bypass = false; }
    fake.reset();
    remuxed.length = 0;
    await db.settings.update({ recordingsPath });
}

/** Captured until at least one segment is written; its row. */
async function capturing(s, recordings) {
    await untilTicked(engine, () => recordings.listBySchedule(s.id)[0]?.segment_state === 'capturing', 'started');
    const rec = recordings.listBySchedule(s.id)[0];
    await untilTicked(engine, () => fs.existsSync(path.join(rec.work_dir, 'e1', 'a000000.ts')), 'a segment written');
    return rec;
}

test('#144: a recording starts and its capture ends without a synchronous call on the share', async () => {
    await db.settings.update({ recordingsPath: slowRecordings, sharedIngestEnabled: false, maxConcurrentRecordings: 2 });
    const { s, scheduled, recordings } = await recordingSetup('Show');
    // The capture alone: the MP4 (made right after) is the next tests'.
    const realQueue = segments.processQueue;
    segments.processQueue = async () => {};
    blocked.length = 0;
    try {
        let rec;
        const { worst } = await loopFreeze(async () => {
            rec = await capturing(s, recordings);
            await engine.cancelScheduled(s.id);
            await untilTicked(engine, () => recordings.getById(rec.id).segment_state !== 'capturing', 'the capture ended');
        });
        const ended = recordings.getById(rec.id);
        assert.equal(ended.segment_state, 'finishing', 'its segments wait for their MP4');
        assert.equal(ended.status, 'recording');
        assert.ok(segments.archiveSegmentCount(rec.work_dir) >= 1, 'what it captured is kept');
        assert.ok(!rec.work_dir.startsWith(slowShare), 'captured into appdata');
        assert.deepEqual(real(() => fs.readdirSync(slowRecordings)), [], 'nothing on the share yet');
        // #146 (the cancel is the last word) for the segmented exit, which reads nothing from the share.
        assert.equal(scheduled.getById(s.id).status, 'cancelled', 'the cancel is the last word');
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        segments.processQueue = realQueue;
        await finishLeftovers();
    }
});

test('#144, #287: the MP4 is published to a share that answers its checks without a synchronous call on the share', async () => {
    await db.settings.update({ recordingsPath: slowRecordings, sharedIngestEnabled: false, maxConcurrentRecordings: 2 });
    const { s, recordings } = await recordingSetup('Published');
    hangMs = 1000; // each synchronous call still freezes the loop far past the 300 ms allowed, but the test ends sooner
    blocked.length = 0;
    const remux = engine._nativeTools.ffmpeg;
    let remuxOpts = null;
    engine._nativeTools.ffmpeg = (args, opts) => { remuxOpts = opts; return remux(args, opts); };
    try {
        let rec;
        const { worst } = await loopFreeze(async () => {
            rec = await capturing(s, recordings);
            await engine.cancelScheduled(s.id);
            await untilTicked(engine, () => recordings.getById(rec.id).status === 'completed', 'finished', 30000);
        });
        const done = recordings.getById(rec.id);
        assert.equal(done.segment_state, 'done');
        assert.ok(done.file_path.startsWith(path.join(slowRecordings, 'Fox Footy') + path.sep), done.file_path);
        assert.equal(done.file_size_bytes, 5000);
        assert.equal(remuxOpts.sizeOf, shareFs.sizeOf, "the remux's stall watchdog reads the share through shareFs");
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        engine._nativeTools.ffmpeg = remux;
        hangMs = 3000;
        await finishLeftovers();
    }
});

test('#144: a share that does not answer when the MP4 is due: it waits in appdata, playable; the loop and another recording go on; it moves once the share answers', async () => {
    const hungRecordings = path.join(share, 'Recordings');
    await db.settings.update({ recordingsPath: hungRecordings, sharedIngestEnabled: false, maxConcurrentRecordings: 3, maxProviderStreams: 3 });
    shareFs.reset();
    const { s, scheduled, recordings } = await recordingSetup('Hung at the end');
    blocked.length = 0;
    let rec;
    try {
        const { worst } = await loopFreeze(async () => {
            rec = await capturing(s, recordings);
            await engine.cancelScheduled(s.id);
            const now = Date.now();
            const other = scheduled.create({ title: 'Another', description: null, source_id: s.source_id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
                channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
                pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
            await untilTicked(engine, () => recordings.getById(rec.id).segment_state === 'moving', 'waiting to move', 15000);
            await untilTicked(engine, () => recordings.listBySchedule(other.id)[0]?.segment_state === 'capturing', 'another recording starts meanwhile', 15000);
            await engine.cancelScheduled(other.id);
        });
        const waiting = recordings.getById(rec.id);
        assert.equal(waiting.status, 'completed', 'playable meanwhile');
        assert.equal(waiting.file_path, path.join(rec.work_dir, 'final.mp4'), 'its MP4 waits in appdata');
        assert.ok(fs.existsSync(waiting.file_path));
        assert.ok(segments.status().waitingToMove.some(r => r.id === rec.id), 'listed as waiting to move');
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        await engine.stopAllActive(3000);
    }
    // The share answers again: the next move (its retry is 15 min later) puts the MP4 on it. Its calls on the share are
    // the publish case above; here only the outcome counts.
    const hangWas = process.env.PIGTV_TEST_SHARE_HANG;
    delete process.env.PIGTV_TEST_SHARE_HANG;
    shareFs.reset();
    bypass = true;
    try {
        for (let i = 0; i < 20 && recordings.getById(rec.id).segment_state !== 'done'; i++) {
            await segments.processQueue(Date.now() + 16 * 60 * 1000);
            await new Promise(r => setTimeout(r, 25));
        }
        const moved = recordings.getById(rec.id);
        assert.equal(moved.segment_state, 'done', 'moved once the share answers');
        assert.ok(moved.file_path.startsWith(path.join(hungRecordings, 'Fox Footy') + path.sep), moved.file_path);
        assert.ok(fs.existsSync(moved.file_path));
        assert.equal(fs.existsSync(rec.work_dir), false, 'and the work folder is gone');
    } finally {
        bypass = false;
        process.env.PIGTV_TEST_SHARE_HANG = hangWas;
        shareFs.reset();
        await finishLeftovers();
    }
});

/**
 * A stand-in share helper that answers from this process (the real calls, unblocked) but holds any call `hold(op,
 * file)` picks until `release()`: a share that answers late at exactly the wrong moment.
 */
function deferringHelper(hold, onHeld = () => {}) {
    const { EventEmitter } = require('node:events');
    const { run } = load('services/shareFsWorker');
    const held = [];
    const fake = Object.assign(new EventEmitter(), {
        connected: true, exitCode: null, signalCode: null, unref() {}, channel: { ref() {}, unref() {} },
        kill() { this.connected = false; this.emit('exit', null, 'SIGKILL'); },
        send(msg) {
            const answer = () => {
                // The helper's calls are not this process's: run them with the real (unblocked) fs.
                let result;
                const { id, op, file, ...extra } = msg;
                try { result = real(() => run(op, file, extra)); } catch (err) { return fake.emit('message', { id, error: err.message, code: err.code }); }
                fake.emit('message', { id: msg.id, result });
            };
            if (hold(msg.op, msg.file, msg)) { held.push(answer); onHeld(); } else setImmediate(answer);
        }
    });
    return { fake, release: () => { for (const a of held.splice(0)) a(); }, heldCount: () => held.length };
}

test('#145: a cancel while the share is checked at the start starts nothing', async () => {
    await db.settings.update({ recordingsPath: slowRecordings, sharedIngestEnabled: false });
    const realFork = shareFs._spawner.fork;
    // A segmented start checks the share (its MP4 goes there) before it creates anything: held at its write test.
    let armed = false; // not the folder health check engine.init makes
    const helper = deferringHelper((op, file) => armed && op === 'writeProbe' && file === slowRecordings);
    shareFs.reset();
    shareFs._spawner.fork = () => helper.fake;
    try {
        const { s, scheduled, recordings } = await recordingSetup('Cancelled while checking');
        await engine.checkFolderHealthNow();
        armed = true;
        const ticks = [];
        for (let i = 0; i < 100 && helper.heldCount() === 0; i++) {
            ticks.push(engine.tick());
            await new Promise(r => setTimeout(r, 30));
        }
        assert.equal(helper.heldCount(), 1, 'the share check is waiting on the share');
        await engine.cancelScheduled(s.id);
        helper.release();
        await Promise.all(ticks);
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(recordings.listBySchedule(s.id), [], 'no recording was created');
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
        assert.ok(!engine.listActive().some(r => r.id === s.id), 'no capture runs');
        assert.equal(fake.captures().length, 0, 'ffmpeg never started');
    } finally {
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        await finishLeftovers();
    }
});

// ---- #141: deleting recordings and the start-up clean-up ----

const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
const cleanupRow = (p) => load('db/sqlite').getDb().prepare('SELECT kind, identity FROM recording_cleanup WHERE path = ?').get(p);

function completedRecording(file, title) {
    const { recordings } = load('db/recordingsDb');
    real(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(4000)); });
    const rec = recordings.create({ scheduled_id: null, title, channel_name: 'Fox Footy', channel_logo: null, source_id: null,
        channel_item_id: null, file_path: file, started_at: Date.now() - 60000 });
    recordings.finish(rec.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 4000, duration_sec: 60, error: null });
    return rec;
}

test('#141: a delete while the share is not answering is refused, and nothing of the recording is touched', async () => {
    const { recordings } = load('db/recordingsDb');
    const owners = load('services/recordingOwners');
    const rec = completedRecording(path.join(recordingsPath, 'Hung.ts'), 'Hung');
    blocked.length = 0;
    const { worst } = await loopFreeze(() => assert.rejects(() => engine.deleteRecording(rec.id), /not responding/));
    assert.deepEqual(blocked, [], 'no synchronous call on the share');
    assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    assert.ok(recordings.getById(rec.id), 'the recording is still listed');
    assert.ok(real(() => fs.existsSync(rec.file_path)), 'its file is untouched');
    assert.ok(owners.owned(rec.id), '#149: and not retired: its jobs carry on as before');
    shareFs.reset();
});

test('#141: a file the share stops answering on is listed; the recording goes at once, the file once the share answers', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings') });
    const { recordings } = load('db/recordingsDb');
    const ts = path.join(slowShare, 'Recordings', 'Gone.ts');
    const mp4 = path.join(slowShare, 'Recordings', 'Gone.mp4');
    const rec = completedRecording(ts, 'Gone');
    real(() => fs.writeFileSync(mp4, 'sidecar'));
    const realFork = shareFs._spawner.fork;
    // The share answers everything but the removal of the recording's own file, which it never answers.
    const helper = deferringHelper((op, file) => op === 'unlink' && file === ts);
    shareFs.reset();
    shareFs.tuning.timeoutMs = 300;
    shareFs._spawner.fork = () => helper.fake;
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(() => engine.deleteRecording(rec.id));
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        assert.ok(!recordings.getById(rec.id), 'the recording is gone');
        assert.equal(real(() => fs.existsSync(mp4)), false, 'what the share answered for is removed');
        assert.ok(real(() => fs.existsSync(ts)), 'the file it did not answer for is still there');
        const row = cleanupRow(ts);
        assert.equal(row?.kind, 'deleted', 'and listed for removal');
        assert.ok(row.identity, 'as that very file');
    } finally {
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
    }
    // The share answers again: the next folder check removes it.
    await engine.checkFolderHealthNow();
    assert.ok(await until(() => !real(() => fs.existsSync(ts)), 5000), 'removed once the share answers');
    assert.ok(await until(() => !cleanupRow(ts), 2000), 'and no longer listed');
    await db.settings.update({ recordingsPath });
});

test('#141: start-up clean-up of interrupted compressions and old MP4s goes through the helper, before the queues run', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings') });
    const { recordings } = load('db/recordingsDb');
    const owners = load('services/recordingOwners');
    const { compressionTargetPath, nativePlaybackTargetPath } = load('services/recordingMedia');
    const sql = load('db/sqlite').getDb();
    const squash = completedRecording(path.join(slowShare, 'Recordings', 'Squash.mkv'), 'Squash');
    const target = compressionTargetPath(squash.file_path);
    real(() => { fs.writeFileSync(target, 'truncated'); fs.writeFileSync(`${target}.partial`, 'old'); });
    sql.prepare(`UPDATE recordings SET compress_status = 'running' WHERE id = ?`).run(squash.id);
    const old = completedRecording(path.join(slowShare, 'Recordings', 'Old.mkv'), 'Old');
    const native = nativePlaybackTargetPath(old.file_path);
    real(() => fs.writeFileSync(native, 'copied audio'));
    sql.prepare(`UPDATE recordings SET native_status = 'ready', native_version = NULL WHERE id = ?`).run(old.id);
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(async () => { engine._reconcileJobsOnStartup(); await owners.whenSwept(); });
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        assert.equal(real(() => fs.existsSync(target)), false, 'the interrupted compression output is gone before the queue may run');
        assert.equal(real(() => fs.existsSync(`${target}.partial`)), false);
        assert.equal(real(() => fs.existsSync(native)), false, 'the old MP4 is gone');
        assert.equal(recordings.getById(old.id).native_status, 'pending', 'and it is prepared again');
        assert.equal(recordings.getById(squash.id).compress_status, 'pending');
    } finally {
        sql.prepare(`UPDATE recordings SET compress_status = NULL, native_status = NULL WHERE id IN (?, ?)`).run(squash.id, old.id);
        await db.settings.update({ recordingsPath });
    }
});

test('#141: a recording cut short by a restart is finished with its size read through the helper', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings') });
    const { s, scheduled, recordings } = await recordingSetup('Cut short');
    const file = path.join(slowShare, 'Recordings', 'Cut short.ts');
    real(() => fs.writeFileSync(file, Buffer.alloc(5000)));
    const rec = recordings.create({ scheduled_id: s.id, title: 'Cut short', channel_name: 'Fox Footy', channel_logo: null,
        source_id: s.source_id, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() - 60000 });
    load('db/sqlite').getDb().prepare(`UPDATE scheduled_recordings SET status = 'recording', recording_id = ? WHERE id = ?`).run(rec.id, s.id);
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(() => engine._reconcileOnStartup());
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        assert.ok(await until(() => recordings.getById(rec.id).status !== 'recording', 3000), 'finished');
        assert.equal(recordings.getById(rec.id).status, 'completed');
        assert.equal(recordings.getById(rec.id).file_size_bytes, 5000);
        assert.equal(scheduled.getById(s.id).status, 'failed');
    } finally {
        await db.settings.update({ recordingsPath });
    }
});

test('#151: a second delete of the same recording joins the first, and a path another recording points at is kept', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings') });
    const { recordings } = load('db/recordingsDb');
    const dir = path.join(slowShare, 'Recordings');
    const rec = completedRecording(path.join(dir, 'Twice.ts'), 'Twice');
    // Another recording whose own file has a name in this one's family ("<name>.mp4").
    const other = completedRecording(path.join(dir, 'Twice.mp4'), 'Twice, kept');
    try {
        const first = engine.deleteRecording(rec.id);
        const second = engine.deleteRecording(rec.id);
        assert.equal(second, first, 'one deletion, not two interleaving');
        await first;
        assert.ok(!recordings.getById(rec.id));
        assert.ok(recordings.getById(other.id), 'the other recording stays');
        assert.ok(real(() => fs.existsSync(other.file_path)), 'and so does its file');
    } finally {
        await db.settings.update({ recordingsPath });
    }
});

// ---- #287: every way a finished recording reaches the share, and a share that stalls mid-publish ----

const foxFooty = path.join(slowRecordings, 'Fox Footy');

/** A capture on the slow share, ended: its row waits for its MP4 ('finishing'); the queue is held meanwhile. */
async function captured(title) {
    await db.settings.update({ recordingsPath: slowRecordings, sharedIngestEnabled: false, maxConcurrentRecordings: 3, maxProviderStreams: 3 });
    const { s, scheduled, recordings } = await recordingSetup(title);
    const realQueue = segments.processQueue;
    segments.processQueue = async () => {};
    try {
        const rec = await capturing(s, recordings);
        await engine.cancelScheduled(s.id);
        await untilTicked(engine, () => recordings.getById(rec.id).segment_state === 'finishing', 'the capture ended');
        return { rec: recordings.getById(rec.id), s, scheduled, recordings };
    } finally {
        segments.processQueue = realQueue;
    }
}

/** Run the segment queue (as of `at()`) until `cond`; fails with `label` after `ms`. */
async function queueUntil(cond, label, { at = () => Date.now(), ms = 30000 } = {}) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return;
        await segments.processQueue(at());
        await new Promise(r => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for: ${label}`);
}
const later = () => Date.now() + 16 * 60 * 1000; // past the 15-minute retry of a move

/** The recording's segments joined, as the archive lists them (what a kept original must be, byte for byte). */
function segmentBytes(rec) {
    const epochs = fs.readdirSync(rec.work_dir).filter(d => /^e\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    return Buffer.concat(epochs.flatMap((e) => {
        const listed = fs.readFileSync(path.join(rec.work_dir, e, 'archive.m3u8'), 'utf8').match(/^a\d+\.ts$/mg) || [];
        return listed.map(n => fs.readFileSync(path.join(rec.work_dir, e, n)));
    }));
}

/** The files in the channel folder whose names start with the recording's own name. */
const filesOf = (rec) => real(() => (fs.existsSync(foxFooty) ? fs.readdirSync(foxFooty) : [])).filter(n => n.startsWith(rec.segment_name)).sort();

/** Finish the recording in appdata (the share's folder unplugged): its row waits to move ('moving'). */
async function leftInAppdata(rec, recordings) {
    await db.settings.update({ recordingsPath: path.join(sandbox, 'unplugged', 'Recordings') });
    try {
        await queueUntil(() => recordings.getById(rec.id).segment_state === 'moving', 'finished in appdata');
    } finally {
        await db.settings.update({ recordingsPath: slowRecordings });
    }
    const waiting = recordings.getById(rec.id);
    assert.equal(waiting.file_path, path.join(rec.work_dir, 'final.mp4'));
    return waiting;
}

test('#287: an MP4 left in appdata moves to a share that answers its checks without a synchronous call on the share', async () => {
    const { rec, recordings } = await captured('Moved later');
    hangMs = 400; // each synchronous call still freezes the loop past the 300 ms allowed
    try {
        await leftInAppdata(rec, recordings);
        blocked.length = 0;
        const { worst } = await loopFreeze(() => queueUntil(() => recordings.getById(rec.id).segment_state === 'done', 'moved', { at: later }));
        const moved = recordings.getById(rec.id);
        assert.ok(moved.file_path.startsWith(foxFooty + path.sep), moved.file_path);
        assert.equal(real(() => fs.statSync(moved.file_path).size), 5000);
        assert.deepEqual(filesOf(rec), [path.basename(moved.file_path)], 'one file, no partial left');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        hangMs = 3000;
        await finishLeftovers();
    }
});

test('#287: a recording that keeps its original adopts the one already on the share without a synchronous call on the share', async () => {
    const { rec, recordings } = await captured('Kept');
    // Its audio cannot be decode-checked: the MP4 plays but is not proven, so the segments are kept beside it (DVR-1).
    engine._nativeTools.audioErrors = async () => null;
    // Its original is already there, byte for byte its segments (a restart after the copy): adopted, not copied again.
    const original = path.join(foxFooty, `${rec.segment_name}.ts`);
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(original, segmentBytes(rec)); });
    hangMs = 400;
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(() => queueUntil(() => recordings.getById(rec.id).segment_state === 'done', 'finished'));
        const done = recordings.getById(rec.id);
        assert.ok(done.segment_keep, 'its original is kept');
        assert.equal(done.segment_original, original, 'the file on the share is adopted as its original');
        assert.ok(done.file_path.startsWith(foxFooty + path.sep), done.file_path);
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        engine._nativeTools.audioErrors = async () => 0;
        hangMs = 3000;
        await finishLeftovers();
    }
});

test('#287: a recording deleted while its MP4 is made leaves nothing on the share, without a synchronous call on the share', async () => {
    const { rec, recordings } = await captured('Deleted while made');
    const remux = engine._nativeTools.ffmpeg;
    let deletion = null;
    // The deletion lands while ffmpeg writes the MP4: it stops it (the abort), and the partial on the share must go.
    engine._nativeTools.ffmpeg = async (args, opts) => {
        await remux(args, opts);
        deletion = engine.deleteRecording(rec.id);
        if (!opts.signal.aborted) await once(opts.signal, 'abort');
        return { code: -1, tail: ['Stopped: the recording was deleted'] };
    };
    hangMs = 400;
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(async () => {
            await queueUntil(() => deletion !== null, 'the MP4 is being made');
            await deletion;
            await queueUntil(() => !recordings.getById(rec.id), 'deleted');
        });
        assert.deepEqual(filesOf(rec), [], 'nothing of it is left on the share');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        engine._nativeTools.ffmpeg = remux;
        hangMs = 3000;
        await finishLeftovers();
    }
});

test('#287: a recording deleted just as its MP4 is published takes that copy back without a synchronous call on the share', async () => {
    const owners = load('services/recordingOwners');
    const { rec, recordings } = await captured('Deleted while published');
    hangMs = 400;
    const published = owners.published;
    try {
        await leftInAppdata(rec, recordings);
        // The deletion retires it the moment its MP4 has its final name (once the link waits on the share, that is a
        // window a deletion can land in): the move takes that copy back (withdraw).
        owners.published = (p, id, ...rest) => { const ok = published(p, id, ...rest); if (id === rec.id) owners.retire(id); return ok; };
        blocked.length = 0;
        const { worst } = await loopFreeze(() => queueUntil(() => !owners.owned(rec.id) && filesOf(rec).length === 0, 'the move ran and took its copy back', { at: later }));
        owners.published = published;
        await new Promise(r => setTimeout(r, 100));
        assert.equal(owners.owned(rec.id), false, 'it was retired');
        assert.deepEqual(filesOf(rec), [], 'the published copy is taken back');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        owners.published = published;
        hangMs = 3000;
        await engine.deleteRecording(rec.id).catch(() => {});
        await finishLeftovers();
    }
});

test('#287: an MP4 that cannot be made: the segments go to the share as a .ts without a synchronous call on the share', async () => {
    const { rec, recordings } = await captured('Only a ts');
    const joined = segmentBytes(rec).length;
    const remux = engine._nativeTools.ffmpeg;
    engine._nativeTools.ffmpeg = async () => ({ code: 1, tail: ['Invalid data found when processing input'] });
    hangMs = 400;
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(() => queueUntil(() => recordings.getById(rec.id).segment_state === 'done', 'delivered as a .ts after three attempts'));
        const done = recordings.getById(rec.id);
        assert.equal(done.file_path, path.join(foxFooty, `${rec.segment_name}.ts`));
        assert.equal(done.file_size_bytes, joined);
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        engine._nativeTools.ffmpeg = remux;
        hangMs = 3000;
        await finishLeftovers();
    }
});

test('#287: the stall watchdog of an ffmpeg writing to the share reads its size without a synchronous call on the share', async () => {
    const media = load('services/recordingMedia');
    engine.init({ ffmpegPath: fake.path, ffprobePath: 'ffprobe' });
    engine.shutdown();
    // The fake (no "-f hls") writes one growing file at its last argument, as the remux writes its MP4 to the share; the
    // finishing queue passes the bounded check (shareFs.sizeOf), as the publish test below checks.
    const out = path.join(slowRecordings, 'Watched.mp4.partial');
    const stop = new AbortController();
    hangMs = 400;
    blocked.length = 0;
    try {
        const { result, worst } = await loopFreeze(async () => {
            // A 1 s stall window, so the watchdog (every min(30 s, stallMs)) checks the size twice before the stop.
            const run = media.runFfmpegCollectingTail(['-i', 'http://provider.invalid/ff.ts', out], { watchFile: out, stallMs: 1000, signal: stop.signal, sizeOf: shareFs.sizeOf });
            await new Promise(r => setTimeout(r, 2500));
            stop.abort();
            return run;
        });
        assert.ok(result.tail.some(l => /deleted/.test(l)), 'stopped by the signal');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        hangMs = 3000;
        real(() => { try { fs.unlinkSync(out); } catch { /* none */ } });
        fake.reset();
    }
});

test('#287: the stall watchdog runs one size check at a time, and a size it cannot read counts as no growth', async () => {
    const media = load('services/recordingMedia');
    media.setToolPaths({ ffmpegPath: process.execPath });
    try {
        // A check that never answers (a share that hangs) is not stacked up by the next ticks (at 1, 2 and 3 s).
        let calls = 0;
        const stop = new AbortController();
        const run = media.runFfmpegCollectingTail(['-e', 'setTimeout(() => {}, 10000)'], { watchFile: path.join(slowRecordings, 'x.partial'), stallMs: 1000,
            signal: stop.signal, sizeOf: () => { calls++; return new Promise(() => {}); } });
        await new Promise(r => setTimeout(r, 3500));
        stop.abort();
        await run;
        assert.equal(calls, 1, 'one check at a time');
        // Sizes it cannot read (null): no growth, so it is stopped once the stall window has passed, as before.
        const r = await media.runFfmpegCollectingTail(['-e', 'setTimeout(() => {}, 20000)'], { watchFile: path.join(slowRecordings, 'y.partial'), stallMs: 1000,
            sizeOf: async () => null });
        assert.ok(r.tail.some(l => /did not grow/.test(l)), r.tail.join(' | '));
    } finally {
        engine.init({ ffmpegPath: fake.path, ffprobePath: 'ffprobe' });
        engine.shutdown();
    }
});

test('#287: an ffmpeg job on a local file is never stopped because the share is hung (no size check of its own: read here, as before)', async () => {
    const media = load('services/recordingMedia');
    engine.init({ ffmpegPath: fake.path, ffprobePath: 'ffprobe' });
    engine.shutdown();
    // The share's helpers are stuck: every shareFs call fails at once.
    shareFs.reset();
    shareFs._stuck.add({ stuck: 1 });
    shareFs._stuck.add({ stuck: 2 });
    const out = path.join(sandbox, 'local-job', 'Compressed.mp4.partial');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const stop = new AbortController();
    try {
        await assert.rejects(() => shareFs.stat(out), { code: 'SHARE_UNRESPONSIVE' });
        // Compression and preparation pass no size check: a growing local file keeps it running past two stall windows.
        const run = media.runFfmpegCollectingTail(['-i', 'http://provider.invalid/ff.ts', out], { watchFile: out, stallMs: 1000, signal: stop.signal });
        await new Promise(r => setTimeout(r, 3500));
        stop.abort();
        const result = await run;
        assert.ok(!result.tail.some(l => /did not grow/.test(l)), result.tail.join(' | '));
        assert.ok(result.tail.some(l => /deleted/.test(l)), 'it ran until stopped');
    } finally {
        shareFs.reset();
        fs.rmSync(path.dirname(out), { recursive: true, force: true });
        fake.reset();
    }
});

test('#287: a kept original an earlier build left unproven is checked without a synchronous call on the share', async () => {
    const { rec, recordings } = await captured('Legacy');
    const sql = load('db/sqlite').getDb();
    const mp4 = path.join(foxFooty, `${rec.segment_name}.mp4`);
    const conventional = path.join(foxFooty, `${rec.segment_name}.ts`);
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(mp4, Buffer.alloc(5000)); fs.writeFileSync(conventional, segmentBytes(rec)); });
    // R4-D1: 'done' with a kept original but no path for it, its segments still in appdata.
    sql.prepare(`UPDATE recordings SET status = 'completed', file_path = ?, segment_state = 'done', segment_keep = 'the length could not be read',
        segment_original = NULL WHERE id = ?`).run(mp4, rec.id);
    hangMs = 400;
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(() => segments.recoverLegacyOriginals());
        assert.equal(recordings.getById(rec.id).segment_original, conventional, 'the same bytes as its segments: claimed');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        hangMs = 3000;
        await segments.removeWork(rec);
        sql.prepare(`UPDATE recordings SET work_dir = NULL WHERE id = ?`).run(rec.id);
        await finishLeftovers();
    }
});

/**
 * Stand-in share helpers, a fresh one per fork (as after a kill), that answer at once from this process, except for a
 * call on the slow share that `hold(op, file)` picks: held past its deadline until release(), when it completes - late,
 * after its caller has given up on it. A share that stalls mid-publish and comes back.
 */
function stallingHelpers(hold, { exitOnRelease = false } = {}) {
    const { EventEmitter } = require('node:events');
    const { run } = load('services/shareFsWorker');
    const held = [];
    const dying = []; // exitOnRelease: killed while stuck in the kernel, they exit only once their held call has run
    const exit = (helper) => { helper.signalCode = 'SIGKILL'; helper.emit('exit', null, 'SIGKILL'); };
    const fork = () => {
        const helper = Object.assign(new EventEmitter(), {
            connected: true, exitCode: null, signalCode: null, unref() {}, channel: { ref() {}, unref() {} },
            kill() { this.connected = false; if (exitOnRelease) dying.push(this); else exit(this); },
            send(msg) {
                const { id, op, file, ...rest } = msg;
                const answer = () => {
                    let result;
                    // The helper's calls are not this process's: run with the real (unblocked) fs. Extra fields (a
                    // second path) are passed on.
                    try { result = real(() => run(op, String(file), rest)); } catch (err) {
                        if (helper.connected) helper.emit('message', { id, error: err.message, code: err.code || 'SHARE_ERROR' });
                        return;
                    }
                    if (helper.connected) helper.emit('message', { id, result }); // a killed helper sends nothing back
                };
                if (String(file).startsWith(slowShare) && hold(op, String(file))) held.push(answer); else setImmediate(answer);
            }
        });
        return helper;
    };
    return { fork, release: () => { for (const a of held.splice(0)) a(); for (const h of dying.splice(0)) exit(h); }, heldCount: () => held.length };
}

const journalOf = (id) => load('db/sqlite').getDb().prepare('SELECT path, kind FROM recording_cleanup WHERE recording_id = ?').all(id);

test('#287: a share that stalls mid-publish: the loop and another recording go on, and once it answers the recording is published exactly once', async () => {
    const { rec, s, scheduled, recordings } = await captured('Stalled');
    // The share stalls at the link that publishes the MP4: that call and every later one on it are held past their
    // deadline, and complete (late: the link lands) once it answers again.
    let stalled = false;
    const helpers = stallingHelpers((op) => { if (op === 'link') stalled = true; return stalled; });
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    hangMs = 1500; // any synchronous call on it is held as long
    blocked.length = 0;
    let other;
    try {
        const { worst } = await loopFreeze(async () => {
            const finishing = segments.processQueue();
            assert.ok(await until(() => stalled, 30000), 'the link went out');
            const now = Date.now();
            other = scheduled.create({ title: 'Another', description: null, source_id: s.source_id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
                channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
                pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
            await untilTicked(engine, () => recordings.listBySchedule(other.id)[0]?.segment_state === 'capturing', 'another recording starts while the share stalls', 15000);
            assert.ok(stalled && helpers.heldCount() > 0, 'it started while the share was still hung');
            await finishing;
            const waiting = recordings.getById(rec.id);
            assert.equal(waiting.segment_state, 'finishing', 'a stall is not a failure: it waits for the next tick');
            assert.equal(waiting.segment_attempts || 0, rec.segment_attempts || 0, 'and is not counted as an attempt');
            await engine.cancelScheduled(other.id);
        });
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        await engine.stopAllActive(3000);
        hangMs = 3000;
    }
    // The share answers again: what it held completes now - the link lands, after its caller gave up on it - and the
    // queue carries on (the other recording's MP4 too). Only the outcome counts here.
    bypass = true;
    stalled = false;
    const name = path.join(foxFooty, `${rec.segment_name}.mp4`);
    helpers.release();
    const landed = fs.existsSync(name); // at once: a call still within its deadline may take it back next
    await new Promise(r => setTimeout(r, 100));
    shareFs._spawner.fork = realFork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1500;
    try {
        assert.ok(landed, 'the late link landed');
        await queueUntil(() => recordings.getById(rec.id).segment_state === 'done', 'published once the share answers', { at: later });
        const done = recordings.getById(rec.id);
        assert.equal(done.status, 'completed', 'not lost');
        assert.equal(done.file_path, name);
        assert.equal(fs.statSync(done.file_path).size, 5000);
        assert.deepEqual(filesOf(rec), [`${rec.segment_name}.mp4`], 'published exactly once: no "(2)" copy, no partial left');
        assert.deepEqual(journalOf(rec.id), [], 'nothing of it left in the journal');
        assert.equal(fs.existsSync(rec.work_dir), false, 'and the work folder is gone');
    } finally {
        bypass = false;
        await finishLeftovers();
    }
});

test('#287: a publish the share stalls three times uses up no attempt, so a remux that then fails once is retried, not delivered as a .ts', async () => {
    const { rec, recordings } = await captured('Stalls thrice');
    const helpers = stallingHelpers((op, file) => op === 'link' && file.includes('.mp4.')); // the MP4's link, every time
    const realFork = shareFs._spawner.fork;
    const remux = engine._nativeTools.ffmpeg;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    try {
        for (let i = 0; i < 3; i++) await segments.processQueue();
        let row = recordings.getById(rec.id);
        assert.equal(helpers.heldCount(), 3, 'three links went out and missed their deadline');
        assert.equal(row.segment_state, 'finishing');
        assert.equal(row.segment_attempts || 0, 0, 'no attempt used up');
        // Then the remux fails once: had the stalls counted, that would be the third failure and the .ts fallback.
        engine._nativeTools.ffmpeg = async () => ({ code: 1, tail: ['Invalid data found when processing input'] });
        await segments.processQueue();
        row = recordings.getById(rec.id);
        assert.equal(row.segment_attempts, 1, 'one attempt used');
        assert.equal(row.segment_state, 'finishing', 'it is tried again');
        assert.deepEqual(filesOf(rec), [], 'no .ts, and nothing left of the stalled attempts');
    } finally {
        engine._nativeTools.ffmpeg = remux;
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        await finishLeftovers();
    }
});

test('#287: a recording deleted while its MP4 waits on the link to the share leaves no MP4 there', async () => {
    const { rec, recordings } = await captured('Deleted at the link');
    const helper = deferringHelper((op) => op === 'link');
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 10000; // the link answers (late), well within its deadline
    shareFs._spawner.fork = () => helper.fake;
    blocked.length = 0;
    try {
        const finishing = segments.processQueue();
        assert.ok(await until(() => helper.heldCount() === 1, 10000), 'the link is out');
        const owners = load('services/recordingOwners');
        let leftWhenDeleted = null;
        const deleting = engine.deleteRecording(rec.id).then(() => { leftWhenDeleted = filesOf(rec); });
        assert.ok(await until(() => !owners.owned(rec.id), 5000), 'the deletion has begun');
        helper.release(); // the link answers; the publication sees the deletion and withdraws its MP4
        await deleting;
        await finishing;
        assert.deepEqual(leftWhenDeleted, [], 'the deletion returned only once nothing of it was left (it waits for the publication)');
        assert.ok(!recordings.getById(rec.id), 'the recording is gone');
        assert.deepEqual(filesOf(rec), [], 'and nothing of it is on the share');
        assert.deepEqual(journalOf(rec.id), [], 'nor in the journal');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
    } finally {
        helper.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        await finishLeftovers();
    }
});

test('#287: EEXIST at a name that is the very file (a link that landed late) adopts that name instead of publishing "(2)"', async () => {
    const owners = load('services/recordingOwners');
    const partial = path.join(foxFooty, 'Adopted.mp4.1-ab.partial');
    const dest = path.join(foxFooty, 'Adopted.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(partial, Buffer.alloc(1234)); fs.linkSync(partial, dest); });
    shareFs.reset();
    blocked.length = 0;
    try {
        const published = await segments._publishNoReplace(partial, foxFooty, 'Adopted.mp4', n => `Adopted (${n}).mp4`, 900001);
        assert.equal(published, dest);
        assert.deepEqual(real(() => fs.readdirSync(foxFooty)).filter(n => n.startsWith('Adopted')), ['Adopted.mp4'], 'one name, the partial gone');
        assert.deepEqual(journalOf(900001), [{ path: dest, kind: 'published' }], 'journalled until the database points at it');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
    } finally {
        owners.committed(dest);
        owners.forget(partial);
        real(() => { for (const f of [partial, dest]) fs.rmSync(f, { force: true }); });
    }
});

test('#287: EEXIST at a name another file holds leaves that file and its name alone and publishes the next name', async () => {
    const owners = load('services/recordingOwners');
    const partial = path.join(foxFooty, 'Foreign.mp4.1-cd.partial');
    const theirs = path.join(foxFooty, 'Foreign.mp4');
    const next = path.join(foxFooty, 'Foreign (2).mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(partial, Buffer.alloc(1234)); fs.writeFileSync(theirs, 'someone else'); });
    shareFs.reset();
    blocked.length = 0;
    try {
        const published = await segments._publishNoReplace(partial, foxFooty, 'Foreign.mp4', n => `Foreign (${n}).mp4`, 900002);
        assert.equal(published, next);
        assert.equal(real(() => fs.readFileSync(theirs, 'utf8')), 'someone else', 'the other file is untouched');
        assert.equal(real(() => fs.statSync(next).size), 1234);
        assert.equal(real(() => fs.existsSync(partial)), false);
        assert.deepEqual(journalOf(900002), [{ path: next, kind: 'published' }], 'its name is not journalled as this recording\'s');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
    } finally {
        owners.committed(next);
        owners.forget(theirs);
        real(() => { for (const f of [partial, theirs, next]) fs.rmSync(f, { force: true }); });
    }
});

test('#287: take-back never removes a name a publication in this process still holds', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const file = path.join(foxFooty, 'Held.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(file, Buffer.alloc(1000)); });
    shareFs.reset();
    // Journalled, not yet recorded: what another run of this recording is between its link and its row.
    owners.published(file, 900004, real(() => identityOfStat(fs.statSync(file, { bigint: true }))));
    owners.hold(file);
    try {
        assert.equal(await owners.takeBack(900004), 0);
        assert.ok(real(() => fs.existsSync(file)), 'kept while held');
    } finally {
        owners.release(file);
    }
    assert.equal(await owners.takeBack(900004), 1, 'once released, an uncommitted name is taken back');
    assert.equal(real(() => fs.existsSync(file)), false);
    assert.deepEqual(journalOf(900004), []);
});

test('#287: a link answer that does not prove the link failed (EIO) keeps its name journalled; one that does (EACCES, EOPNOTSUPP) frees it', async () => {
    const owners = load('services/recordingOwners');
    const realLink = shareFs.link;
    real(() => fs.mkdirSync(foxFooty, { recursive: true }));
    shareFs.reset();
    try {
        for (const [code, kept, id] of [['EIO', true, 900005], ['EACCES', false, 900006], ['EOPNOTSUPP', false, 900009]]) {
            const partial = path.join(foxFooty, `Link ${code}.mp4.1-ef.partial`);
            const dest = path.join(foxFooty, `Link ${code}.mp4`);
            real(() => fs.writeFileSync(partial, Buffer.alloc(100)));
            shareFs.link = async () => { throw Object.assign(new Error(code), { code }); };
            await assert.rejects(() => segments._publishNoReplace(partial, foxFooty, `Link ${code}.mp4`, n => `Link ${code} (${n}).mp4`, id),
                kept ? { code, keepPartial: true } : { code }); // an errno answer: never a stall
            assert.deepEqual(journalOf(id).map(r => r.path), kept ? [dest] : [], kept ? 'the name may have been made: still journalled' : 'no link was made: not journalled');
            owners.forget(dest);
            real(() => fs.rmSync(partial, { force: true }));
        }
    } finally {
        shareFs.link = realLink;
    }
});

test('#287: a withdrawn copy the share does not let go of stays journalled with its identity, and is taken back later', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const file = path.join(foxFooty, 'Withdrawn.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(file, Buffer.alloc(1000)); });
    const identity = real(() => identityOfStat(fs.statSync(file, { bigint: true })));
    shareFs.reset();
    const refusing = { identity: shareFs.identity, unlink: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    await owners.withdrawBounded(file, 900007, 'MP4', refusing);
    assert.ok(real(() => fs.existsSync(file)), 'it could not be removed');
    const row = load('db/sqlite').getDb().prepare('SELECT kind, identity FROM recording_cleanup WHERE path = ?').get(file);
    assert.deepEqual({ ...row }, { kind: 'published', identity }, 'journalled as that very file');
    assert.equal(await owners.takeBack(900007), 1);
    assert.equal(real(() => fs.existsSync(file)), false, 'removed once the share lets go');
    assert.deepEqual(journalOf(900007), []);
});

test('#287: once the remux has failed its last attempt, a share that stalls the .ts leaves it waiting: later runs retry only the .ts', async () => {
    const { rec, recordings } = await captured('Last resort');
    load('db/sqlite').getDb().prepare('UPDATE recordings SET segment_attempts = 2 WHERE id = ?').run(rec.id);
    let stalled = true;
    const helpers = stallingHelpers((op, file) => stalled && op === 'link' && file.includes('.ts.')); // the .ts's link
    const realFork = shareFs._spawner.fork;
    const remux = engine._nativeTools.ffmpeg;
    let remuxes = 0;
    engine._nativeTools.ffmpeg = async () => { remuxes++; return { code: 1, tail: ['Invalid data found when processing input'] }; };
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    try {
        await segments.processQueue(); // the third remux fails; its .ts meets the stall
        let row = recordings.getById(rec.id);
        assert.equal(remuxes, 1);
        assert.equal(row.segment_attempts, 3, 'the failed remux counts');
        assert.equal(row.segment_state, 'finishing', 'not failed: the .ts waits');
        await segments.processQueue(); // the next run: the .ts only
        row = recordings.getById(rec.id);
        assert.equal(remuxes, 1, 'no remux again');
        assert.equal(row.segment_attempts, 3);
        assert.equal(row.segment_state, 'finishing');
        assert.equal(helpers.heldCount(), 2, 'the .ts was tried again');
        stalled = false; // the share answers
        await segments.processQueue();
        row = recordings.getById(rec.id);
        assert.equal(remuxes, 1);
        assert.equal(row.segment_state, 'done');
        assert.equal(row.file_path, path.join(foxFooty, `${rec.segment_name}.ts`));
        assert.deepEqual(filesOf(rec), [`${rec.segment_name}.ts`], 'one .ts, nothing left of the stalled tries');
    } finally {
        engine._nativeTools.ffmpeg = remux;
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        await finishLeftovers();
    }
});

test('#287: take-back leaves alone a partial that a writer of the recording names while it runs', async () => {
    const owners = load('services/recordingOwners');
    const id = 900008;
    real(() => fs.mkdirSync(foxFooty, { recursive: true }));
    // An earlier attempt's name, journalled but gone: take-back asks the share about it (held here until the writer has begun).
    owners.published(path.join(foxFooty, 'Earlier.mp4'), id, 'x:1:1:1:1');
    let asked;
    const asking = new Promise(r => { asked = r; });
    let answer;
    const gate = new Promise(r => { answer = r; });
    const slow = { ...shareFs, identity: async (p) => { asked(); await gate; return shareFs.identity(p); }, nlink: shareFs.nlink, unlink: shareFs.unlink };
    shareFs.reset();
    const taking = owners.takeBack(id, () => slow);
    await asking;
    // Meanwhile a writer of the same recording (a compression, say) names and makes its partial.
    const partial = owners.partialFor(path.join(foxFooty, 'Compressing.mp4'));
    let done;
    const writing = owners.write(id, async (signal, made) => {
        made(partial);
        real(() => fs.writeFileSync(partial, 'being written'));
        await new Promise(r => { done = r; });
    });
    await until(() => done, 2000);
    answer();
    await taking;
    try {
        assert.ok(real(() => fs.existsSync(partial)), 'the running writer keeps its partial');
    } finally {
        done();
        await writing;
        real(() => fs.rmSync(partial, { force: true }));
        owners.forget(partial);
    }
});

test('#287: a take-back unlink that misses its deadline and lands late never removes a recording published at that name since', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const name = path.join(foxFooty, 'Late unlink.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(name, 'an earlier attempt'); });
    owners.published(name, 900010, real(() => identityOfStat(fs.statSync(name, { bigint: true }))));
    let stuck = true;
    // The share stops answering at that unlink; its helper, killed, stays stuck in the kernel until the call has run.
    const helpers = stallingHelpers((op, file) => stuck && op === 'unlink' && file === name, { exitOnRelease: true });
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    const partial = path.join(foxFooty, 'Late unlink.mp4.1-ab.partial');
    let published = null;
    try {
        await assert.rejects(() => owners.takeBack(900010), { code: 'SHARE_UNRESPONSIVE' });
        stuck = false; // the share answers again (a fresh helper), while the old one still holds that unlink
        await owners.takeBack(900010);
        // A new recording is published under that name meanwhile.
        real(() => fs.writeFileSync(partial, 'the new recording'));
        published = await segments._publishNoReplace(partial, foxFooty, 'Late unlink.mp4', n => `Late unlink (${n}).mp4`, 900011);
        helpers.release(); // the stuck unlink lands now, then its helper exits
        await new Promise(r => setTimeout(r, 100));
        assert.equal(real(() => fs.readFileSync(published, 'utf8')), 'the new recording', 'the new recording survives');
        // Once that helper is gone the name is free again: nothing stays marked on a share that answers.
        assert.ok(await until(() => !owners.removalPending(name), 2000), 'released once the late call can no longer land');
        await owners.takeBack(900010);
        assert.deepEqual(journalOf(900010), []);
    } finally {
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        for (const f of [name, partial, published]) if (f) { owners.forget(f); real(() => fs.rmSync(f, { force: true })); }
    }
});

test('#287: a removal that gets a definite answer frees its name at once: the next publish takes it', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const name = path.join(foxFooty, 'Freed.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(name, 'an earlier attempt'); });
    owners.published(name, 900012, real(() => identityOfStat(fs.statSync(name, { bigint: true }))));
    shareFs.reset();
    const partial = path.join(foxFooty, 'Freed.mp4.1-cd.partial');
    let published = null;
    try {
        assert.equal(await owners.takeBack(900012), 1);
        assert.equal(owners.removalPending(name), false, 'not marked once the unlink has answered');
        real(() => fs.writeFileSync(partial, 'the new recording'));
        published = await segments._publishNoReplace(partial, foxFooty, 'Freed.mp4', n => `Freed (${n}).mp4`, 900013);
        assert.equal(published, name, 'the name is used again');
    } finally {
        for (const f of [name, partial]) { owners.forget(f); real(() => fs.rmSync(f, { force: true })); }
    }
});

test('#287: an unlink cut off because another call\'s deadline killed its helper frees its name once that helper is gone', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const name = path.join(foxFooty, 'Cut off.mp4');
    const other = path.join(foxFooty, 'Something else.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(name, 'an earlier attempt'); });
    owners.published(name, 900014, real(() => identityOfStat(fs.statSync(name, { bigint: true }))));
    let stuck = true;
    // The share stops answering: take-back's unlink and another caller's check wait on one helper, which, killed for the
    // other call's deadline, exits once its calls have run (in the kernel) without answering them.
    const helpers = stallingHelpers((op, file) => stuck && ((op === 'unlink' && file === name) || file === other), { exitOnRelease: true });
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 20000; // take-back's own deadline is far off
    shareFs._spawner.fork = helpers.fork;
    const partial = path.join(foxFooty, 'Cut off.mp4.1-ef.partial');
    let published = null;
    try {
        const taking = owners.takeBack(900014).catch(e => e);
        assert.ok(await until(() => helpers.heldCount() === 1, 5000), 'the unlink is out');
        await assert.rejects(() => shareFs.exists(other, { timeoutMs: 1000 }), { code: 'SHARE_UNRESPONSIVE' });
        stuck = false;
        helpers.release(); // its calls run (the unlink lands), then it exits
        const err = await taking;
        assert.equal(err.code, 'SHARE_UNRESPONSIVE', 'the unlink went unanswered');
        assert.ok(await until(() => !owners.removalPending(name), 2000), 'its name is free once that helper is gone');
        await owners.takeBack(900014);
        assert.deepEqual(journalOf(900014), [], 'and take-back finishes the job');
        real(() => fs.writeFileSync(partial, 'the new recording'));
        published = await segments._publishNoReplace(partial, foxFooty, 'Cut off.mp4', n => `Cut off (${n}).mp4`, 900015);
        assert.equal(published, name, 'a publish takes that name again, without a restart');
    } finally {
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        for (const f of [name, partial]) { owners.forget(f); real(() => fs.rmSync(f, { force: true })); }
    }
});

test('#287: a withdraw while the share fails fast leaves no mark: once the share answers, take-back removes the copy', async () => {
    const owners = load('services/recordingOwners');
    const { identityOfStat } = load('services/shareFsWorker');
    const file = path.join(foxFooty, 'Withdrawn fast.mp4');
    real(() => { fs.mkdirSync(foxFooty, { recursive: true }); fs.writeFileSync(file, Buffer.alloc(1000)); });
    // Its publication journalled it with its identity before the link, as publishNoReplace does.
    owners.published(file, 900016, real(() => identityOfStat(fs.statSync(file, { bigint: true }))));
    shareFs.reset();
    shareFs._stuck.add({ stuck: 1 }); // two helpers stuck: every call fails at once, never sent
    shareFs._stuck.add({ stuck: 2 });
    try {
        await owners.withdrawBounded(file, 900016, 'MP4');
        assert.equal(owners.removalPending(file), false, 'nothing was sent that could land: no mark');
        assert.deepEqual(journalOf(900016), [{ path: file, kind: 'published' }], 'journalled for later');
    } finally {
        shareFs.reset(); // the share answers again
    }
    assert.equal(await owners.takeBack(900016), 1);
    assert.equal(real(() => fs.existsSync(file)), false, 'removed once the share answers');
    assert.deepEqual(journalOf(900016), []);
});

// ---- the rest of the post-capture pipeline: compression, preparation, the remux, the playback poll, the settings check ----

/** A finished recording with a 20 kB .mkv beside the others in `dirPath` (bigger than the stand-in ffmpeg's 5 kB result). */
function postRecording(dirPath, name) {
    const rec = completedRecording(path.join(dirPath, `${name}.mkv`), name);
    real(() => fs.writeFileSync(rec.file_path, Buffer.alloc(20000)));
    return load('db/recordingsDb').recordings.getById(rec.id);
}
const sqlDb = () => load('db/sqlite').getDb();

test('compression, preparation, the remux and the playback poll make no synchronous call on the share', async () => {
    const { recordings } = load('db/recordingsDb');
    const media = load('services/recordingMedia');
    hangMs = 400;
    try {
        const kept = postRecording(slowRecordings, 'Squeezed kept');
        const replaced = postRecording(slowRecordings, 'Squeezed replaced');
        const prepared = postRecording(slowRecordings, 'Prepared');
        const played = postRecording(slowRecordings, 'Played');
        blocked.length = 0;
        const { worst } = await loopFreeze(async () => {
            await engine._compressRecording(kept, { postRecordKeepOriginal: true });
            assert.equal(recordings.getById(kept.id).compress_status, 'done');
            assert.deepEqual(await engine.pollNativePlayback(recordings.getById(kept.id)), { state: 'ready' }, 'served from the compressed file');

            await engine._compressRecording(replaced, { postRecordKeepOriginal: false });
            const after = recordings.getById(replaced.id);
            assert.equal(after.compress_status, 'done');
            assert.equal(after.file_path, media.compressionTargetPath(replaced.file_path));

            await engine._prepareRecording(prepared);
            const ready = recordings.getById(prepared.id);
            assert.equal(ready.native_status, 'ready');
            assert.equal(ready.file_path, media.preparedTargetPath(prepared.file_path));

            const served = await engine.ensureNativePlayback(played);
            assert.equal(served, media.nativePlaybackTargetPath(played.file_path));
            assert.deepEqual(await engine.pollNativePlayback(played), { state: 'ready' });
        });
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        real(() => {
            assert.equal(fs.existsSync(replaced.file_path), false, 'the original it replaced is gone');
            assert.equal(fs.existsSync(prepared.file_path), false, 'and the .mkv the MP4 replaced');
            assert.equal(fs.existsSync(kept.file_path), true, 'a kept original stays');
            assert.equal(fs.existsSync(media.compressionTargetPath(replaced.file_path)), true);
        });
    } finally {
        hangMs = 3000;
    }
});

test('with the share hung, compression, preparation, the remux and the poll end within the deadline and delete nothing', async () => {
    const media = load('services/recordingMedia');
    const { recordings } = load('db/recordingsDb');
    hangMs = 400;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 600;
    try {
        const squeeze = postRecording(recordingsPath, 'Hung squeeze');
        const prep = postRecording(recordingsPath, 'Hung prepare');
        const play = postRecording(recordingsPath, 'Hung play');
        const poll = postRecording(recordingsPath, 'Hung poll');
        sqlDb().prepare(`UPDATE recordings SET compress_status = 'done' WHERE id = ?`).run(poll.id);
        blocked.length = 0;
        const timed = async (work) => { const began = Date.now(); const out = await work(); return { out, ms: Date.now() - began }; };
        const { worst } = await loopFreeze(async () => {
            shareFs.reset();
            let t = await timed(() => assert.rejects(() => engine._compressRecording(squeeze, { postRecordKeepOriginal: false }), { code: 'SHARE_UNRESPONSIVE' }));
            assert.ok(t.ms < 3000, `compression ended in ${t.ms} ms`);
            shareFs.reset();
            t = await timed(() => engine._prepareRecording(prep));
            assert.ok(t.ms < 3000, `preparation ended in ${t.ms} ms`);
            const row = recordings.getById(prep.id);
            assert.equal(row.native_status, 'pending', 'and is tried again later');
            assert.match(row.native_error, /recordings share|not respond|did not answer/i);
            assert.equal(row.file_path, prep.file_path);
            shareFs.reset();
            t = await timed(() => assert.rejects(() => engine.ensureNativePlayback(play), { code: 'SHARE_UNRESPONSIVE' }));
            assert.ok(t.ms < 3000, `the remux ended in ${t.ms} ms`);
            shareFs.reset();
            t = await timed(() => engine.pollNativePlayback(recordings.getById(poll.id)));
            assert.deepEqual(t.out, { state: 'idle' }, 'a poll that cannot tell is not an error');
            assert.ok(t.ms < 3000, `the poll ended in ${t.ms} ms`);
        });
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        real(() => { for (const r of [squeeze, prep, play, poll]) assert.equal(fs.existsSync(r.file_path), true, `${path.basename(r.file_path)} is still there`); });
        assert.equal(recordings.getById(squeeze.id).file_path, squeeze.file_path);
        void media;
    } finally {
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        hangMs = 3000;
    }
});

test('a rename the share does not answer leaves the original and the row alone; the next pass finishes the job', async () => {
    const media = load('services/recordingMedia');
    const { recordings } = load('db/recordingsDb');
    const helpers = stallingHelpers((op) => op === 'rename');
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 500;
    shareFs._spawner.fork = helpers.fork;
    hangMs = 400;
    try {
        const squeeze = postRecording(slowRecordings, 'Late squeeze');
        const prep = postRecording(slowRecordings, 'Late prepare');
        const play = postRecording(slowRecordings, 'Late play');
        blocked.length = 0;
        const { worst } = await loopFreeze(async () => {
            await assert.rejects(() => engine._compressRecording(squeeze, { postRecordKeepOriginal: false }), { code: 'SHARE_UNRESPONSIVE' });
            assert.equal(recordings.getById(squeeze.id).file_path, squeeze.file_path, 'the row still has the original');
            assert.notEqual(recordings.getById(squeeze.id).compress_status, 'done');
            await engine._prepareRecording(prep);
            assert.equal(recordings.getById(prep.id).native_status, 'pending');
            assert.equal(recordings.getById(prep.id).file_path, prep.file_path);
            await assert.rejects(() => engine.ensureNativePlayback(play), { code: 'SHARE_UNRESPONSIVE' });
        });
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        real(() => { for (const r of [squeeze, prep, play]) assert.equal(fs.existsSync(r.file_path), true, `${path.basename(r.file_path)} was not deleted`); });
        // The share answers again: the renames it held land late. The next pass finds a whole MP4 where it was going.
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500; // what must succeed now goes through a freshly forked helper: a full margin
        await engine._prepareRecording(recordings.getById(prep.id));
        const done = recordings.getById(prep.id);
        assert.equal(done.native_status, 'ready');
        assert.equal(done.file_path, media.preparedTargetPath(prep.file_path));
        assert.equal(await engine.ensureNativePlayback(play), media.nativePlaybackTargetPath(play.file_path), 'and a Play finds the remux that landed');
    } finally {
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        hangMs = 3000;
    }
});

test('saving a recordings folder on a hung share answers with an error within the deadline', async () => {
    const folder = load('services/recordingsFolder');
    shareFs.reset();
    shareFs.tuning.timeoutMs = 600;
    hangMs = 400;
    blocked.length = 0;
    try {
        const began = Date.now();
        const { result, worst } = await loopFreeze(() => folder.validateRecordingsPathSetting(path.join(recordingsPath, 'Newly typed')));
        assert.equal(result.ok, false);
        assert.match(result.reason, /not responding/);
        assert.ok(Date.now() - began < 3000, 'answered within the deadline');
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
        // And a folder on a share that answers is still accepted (through a freshly forked helper: a full margin).
        shareFs.tuning.timeoutMs = 1500;
        assert.deepEqual(await folder.validateRecordingsPathSetting(path.join(slowRecordings, 'Newly typed')), { ok: true });
        assert.deepEqual([...blocked], [], 'no synchronous call on the share');
    } finally {
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        hangMs = 3000;
    }
});

// ---- Codex and Opus reviews of 0568: a publication by rename is a writer's; a missed deadline is retried; Settings ----

/**
 * A stand-in share helper like deferringHelper, except that a call `hold(op, file)` picks is made at once and only its
 * answer is held until release(): a rename that has landed while its caller still waits.
 */
function answerLateHelper(hold) {
    const { EventEmitter } = require('node:events');
    const { run } = load('services/shareFsWorker');
    const held = [];
    const fake = Object.assign(new EventEmitter(), {
        connected: true, exitCode: null, signalCode: null, unref() {}, channel: { ref() {}, unref() {} },
        kill() { this.connected = false; this.emit('exit', null, 'SIGKILL'); },
        send(msg) {
            const { id, op, file, ...extra } = msg;
            let answer;
            try { const result = real(() => run(op, file, extra)); answer = { id, result }; } catch (err) { answer = { id, error: err.message, code: err.code }; }
            const reply = () => { if (fake.connected) fake.emit('message', answer); };
            if (hold(op, String(file))) held.push(reply); else setImmediate(reply);
        }
    });
    return { fake, release: () => { for (const a of held.splice(0)) a(); }, heldCount: () => held.length };
}

/** What is left of a recording made by postRecording: its files beside it, its row, its journal, a verified name. */
function leftOf(rec, name) {
    const media = load('services/recordingMedia');
    const dir = path.dirname(rec.file_path);
    return {
        files: real(() => fs.readdirSync(dir)).filter(n => n.startsWith(`${name}.`)).sort(),
        row: load('db/recordingsDb').recordings.getById(rec.id) || null,
        journal: journalOf(rec.id),
        verified: [...media.verifiedNativeFiles].filter(p => path.basename(p).startsWith(`${name}.`))
    };
}

/** The three jobs that publish by rename, each started on `rec`, and which rename is theirs (the file it moves). */
const renameJobs = {
    remux: { run: (rec) => engine.ensureNativePlayback(rec), from: (rec, file) => file.startsWith(load('services/recordingMedia').nativePlaybackTargetPath(rec.file_path) + '.') },
    adopt: { run: (rec) => engine._prepareRecording(rec), from: (rec, file) => file === load('services/recordingMedia').nativePlaybackTargetPath(rec.file_path) },
    compress: { run: (rec) => engine._compressRecording(rec, { postRecordKeepOriginal: false }), from: (rec, file) => file.startsWith(load('services/recordingMedia').compressionTargetPath(rec.file_path) + '.') }
};

for (const [job, { run, from }] of Object.entries(renameJobs)) {
    test(`a recording deleted while its ${job} renames the result into place: the deletion waits, and nothing of it is left`, async () => {
        const rec = postRecording(slowRecordings, `Deleted mid ${job}`);
        const name = path.basename(rec.file_path, '.mkv');
        const owners = load('services/recordingOwners');
        // The rename lands at once; its answer comes only after the deletion has begun.
        const helper = answerLateHelper((op, file) => op === 'rename' && from(rec, file));
        const realFork = shareFs._spawner.fork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 10000; // answered (late) well within its deadline
        shareFs._spawner.fork = () => helper.fake;
        try {
            const working = run(rec).catch(e => e);
            assert.ok(await until(() => helper.heldCount() === 1, 10000), 'the rename is out');
            const deleting = engine.deleteRecording(rec.id);
            assert.ok(await until(() => !owners.owned(rec.id), 5000), 'the deletion has begun');
            await new Promise(r => setTimeout(r, 300)); // an old build's deletion completes meanwhile
            helper.release();
            await deleting;
            await working;
            assert.ok(await until(() => leftOf(rec, name).journal.length === 0, 3000), `journal: ${JSON.stringify(leftOf(rec, name).journal)}`);
            assert.deepEqual(leftOf(rec, name), { files: [], row: null, journal: [], verified: [] }, 'no output, no partial, no row, nothing verified');
        } finally {
            helper.release();
            shareFs._spawner.fork = realFork;
            shareFs.reset();
            shareFs.tuning.timeoutMs = 1500;
        }
    });

    test(`a ${job} rename that misses its deadline and lands after the recording is deleted is withdrawn`, async () => {
        const rec = postRecording(slowRecordings, `Late ${job} deleted`);
        const name = path.basename(rec.file_path, '.mkv');
        const owners = load('services/recordingOwners');
        // Held past its deadline; on release it is made (it lands) and the killed helper exits only then.
        const helpers = stallingHelpers((op, file) => op === 'rename' && from(rec, file), { exitOnRelease: true });
        const realFork = shareFs._spawner.fork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1000;
        shareFs._spawner.fork = helpers.fork;
        try {
            await run(rec).catch(e => e);
            assert.equal(helpers.heldCount(), 1, 'the rename went out and missed its deadline');
            const deleting = engine.deleteRecording(rec.id);
            assert.ok(await until(() => !owners.owned(rec.id), 5000), 'the deletion has begun');
            await new Promise(r => setTimeout(r, 300)); // an old build's deletion completes meanwhile
            helpers.release(); // the rename lands now, after the deletion began
            await deleting;
            assert.ok(await until(() => leftOf(rec, name).files.length === 0 && leftOf(rec, name).journal.length === 0, 5000),
                `left: ${JSON.stringify(leftOf(rec, name))}`);
            assert.deepEqual(leftOf(rec, name), { files: [], row: null, journal: [], verified: [] }, 'no output, no partial, no row, nothing verified');
        } finally {
            helpers.release();
            shareFs._spawner.fork = realFork;
            shareFs.reset();
            shareFs.tuning.timeoutMs = 1500;
        }
    });
}

test('a compression whose rename misses its deadline is pending again, and a later pass completes it with no copy left over', async () => {
    const { recordings } = load('db/recordingsDb');
    const media = load('services/recordingMedia');
    const rec = postRecording(slowRecordings, 'Squeeze retried');
    const others = sqlDb().prepare(`SELECT id FROM recordings WHERE compress_status = 'pending' AND id != ?`).all(rec.id).map(r => r.id);
    for (const id of others) sqlDb().prepare(`UPDATE recordings SET compress_status = NULL WHERE id = ?`).run(id);
    sqlDb().prepare(`UPDATE recordings SET compress_status = 'pending' WHERE id = ?`).run(rec.id);
    const kept = (await db.settings.get()).postRecordKeepOriginal;
    await db.settings.update({ postRecordKeepOriginal: false });
    const output = media.compressionTargetPath(rec.file_path);
    const helpers = stallingHelpers((op, file) => op === 'rename' && file.startsWith(output + '.'));
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    try {
        await engine.processCompressionQueue();
        assert.equal(helpers.heldCount(), 1, 'the rename missed its deadline');
        let row = recordings.getById(rec.id);
        assert.equal(row.compress_status, 'pending', 'tried again later, not failed');
        assert.match(row.compress_error || '', /did not answer/);
        assert.equal(row.file_path, rec.file_path);
        helpers.release(); // the rename lands late: a full-size copy beside the original
        assert.equal(real(() => fs.existsSync(output)), true, 'the late rename landed');
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        await engine.processCompressionQueue();
        row = recordings.getById(rec.id);
        assert.equal(row.compress_status, 'done');
        assert.equal(row.file_path, output);
        assert.deepEqual(real(() => fs.readdirSync(slowRecordings)).filter(n => n.startsWith('Squeeze retried.')), ['Squeeze retried.compressed.mp4'],
            'the original replaced, and no other copy or partial left');
        assert.ok(await until(() => journalOf(rec.id).length === 0, 3000), `journal: ${JSON.stringify(journalOf(rec.id))}`);
    } finally {
        helpers.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
        for (const id of others) sqlDb().prepare(`UPDATE recordings SET compress_status = 'pending' WHERE id = ?`).run(id);
        await db.settings.update({ postRecordKeepOriginal: kept });
    }
});

test('preparation stays pending through more deadline misses than its attempts, each pass bounded; then it completes', async () => {
    const { recordings } = load('db/recordingsDb');
    const media = load('services/recordingMedia');
    const rec = postRecording(slowRecordings, 'Prepare retried');
    const native = media.nativePlaybackTargetPath(rec.file_path);
    // The share answers its checks, but every rename of the remux is held past its deadline (and never lands).
    const helpers = stallingHelpers((op, file) => op === 'rename' && file.startsWith(native + '.'));
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1000;
    shareFs._spawner.fork = helpers.fork;
    try {
        for (let pass = 1; pass <= 5; pass++) {
            const remuxes = remuxed.length;
            const began = Date.now();
            await engine._prepareRecording(recordings.getById(rec.id));
            const row = recordings.getById(rec.id);
            assert.equal(row.native_status, 'pending', `pass ${pass}: tried again later, never failed`);
            assert.equal(row.native_attempts || 0, 0, `pass ${pass}: no attempt used`);
            assert.equal(helpers.heldCount(), pass, `pass ${pass}: one deadline missed`);
            assert.equal(remuxed.length - remuxes, 1, `pass ${pass}: one remux`);
            assert.ok(Date.now() - began < 2500, `pass ${pass} took ${Date.now() - began} ms`);
        }
        assert.equal(recordings.getById(rec.id).file_path, rec.file_path);
    } finally {
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
    }
    helpers.release();
    await engine._prepareRecording(recordings.getById(rec.id));
    const done = recordings.getById(rec.id);
    assert.equal(done.native_status, 'ready');
    assert.equal(done.file_path, media.preparedTargetPath(rec.file_path));
    assert.deepEqual(real(() => fs.readdirSync(slowRecordings)).filter(n => n.startsWith('Prepare retried.')), ['Prepare retried.mp4'], 'nothing else left');
    assert.ok(await until(() => journalOf(rec.id).length === 0, 3000), `journal: ${JSON.stringify(journalOf(rec.id))}`);
});

test('a prepared file whose size cannot be read is not adopted: the row and the original stay', async () => {
    const { recordings } = load('db/recordingsDb');
    const media = load('services/recordingMedia');
    const rec = postRecording(slowRecordings, 'Unreadable prepared');
    const native = media.nativePlaybackTargetPath(rec.file_path);
    const target = media.preparedTargetPath(rec.file_path);
    real(() => fs.writeFileSync(target, 'a stray file of that name')); // so the .native.mp4 is adopted under its own name
    const duration = engine._nativeTools.duration;
    const stat = shareFs.stat;
    engine._nativeTools.duration = async (f, o) => (f === target ? null : duration(f, o));
    shareFs.stat = async (f, o) => (f === native ? null : stat(f, o));
    try {
        await engine._prepareRecording(rec);
        const row = recordings.getById(rec.id);
        assert.equal(row.file_path, rec.file_path, 'the row still has the original');
        assert.notEqual(row.native_status, 'ready');
        assert.equal(real(() => fs.existsSync(rec.file_path)), true, 'the original is kept');
    } finally {
        engine._nativeTools.duration = duration;
        shareFs.stat = stat;
        real(() => { for (const f of [target, native]) fs.rmSync(f, { force: true }); });
    }
});

test('Settings checks a typed folder on a helper of its own: answered while the share helper is stuck, refused on a hung path', async () => {
    const folder = load('services/recordingsFolder');
    shareFs.reset();
    shareFs.tuning.timeoutMs = 1500;
    try {
        // A job of the shared helper is stuck on the hung share.
        const stuckJob = shareFs.exists(path.join(recordingsPath, 'busy.mkv')).catch(e => e);
        assert.deepEqual(await folder.validateRecordingsPathSetting(path.join(healthy, 'Typed')), { ok: true }, 'a healthy local path is accepted, not refused behind the stuck call');
        assert.equal((await stuckJob).code, 'SHARE_UNRESPONSIVE');
        // Earlier helpers still stuck in the kernel, as many as allowed: the shared helper's calls fail at once.
        shareFs.reset();
        shareFs._stuck.add({ stand: 'in' }).add({ stand: 'in too' });
        await assert.rejects(() => shareFs.exists(healthy), { code: 'SHARE_UNRESPONSIVE' });
        assert.deepEqual(await folder.validateRecordingsPathSetting(path.join(healthy, 'Typed')), { ok: true }, 'still accepted');
        // The hung path itself is refused as not responding, within its deadline.
        const t = Date.now();
        const hung = await folder.validateRecordingsPathSetting(path.join(recordingsPath, 'Typed'));
        assert.equal(hung.ok, false);
        assert.match(hung.reason, /not responding/);
        assert.ok(Date.now() - t < 3000, `refused in ${Date.now() - t} ms`);
    } finally {
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
    }
});

/** Stand-in helpers for the Settings check: one that never answers and ignores kill until released, and one that answers. */
function ownHelperStandIns() {
    const { EventEmitter } = require('node:events');
    const { run } = load('services/shareFsWorker');
    const forks = [];
    const fork = () => {
        const helper = Object.assign(new EventEmitter(), {
            connected: true, exitCode: null, signalCode: null, unref() {}, channel: { ref() {}, unref() {} }, hung: false,
            kill() { this.connected = false; if (!this.hung) this.release(); },
            release() { if (this.exitCode === null && this.signalCode === null) { this.signalCode = 'SIGKILL'; this.emit('exit', null, 'SIGKILL'); } },
            send(msg) {
                const { id, op, file, ...rest } = msg;
                if (String(file).startsWith(slowShare)) { this.hung = true; return; }
                setImmediate(() => {
                    let result;
                    try { result = real(() => run(op, String(file), rest)); } catch (err) { this.emit('message', { id, error: err.message, code: err.code || 'SHARE_ERROR' }); return; }
                    if (this.connected) this.emit('message', { id, result });
                });
            }
        });
        forks.push(helper);
        return helper;
    };
    return { fork, forks, releaseAll: () => { for (const h of forks) h.release(); } };
}

test('Settings: a hung typed path forks one helper however often it is saved; hung paths stop forking at the cap; a healthy path still answers; once released it is checked again', async () => {
    const folder = load('services/recordingsFolder');
    const stand = ownHelperStandIns();
    const realFork = shareFs._spawner.fork;
    shareFs.reset();
    shareFs.tuning.timeoutMs = 300;
    shareFs._spawner.fork = stand.fork;
    const refusedAsHung = (r) => r.ok === false && /not responding/.test(r.reason);
    try {
        const hungDir = path.join(slowRecordings, 'Typed');
        assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(hungDir)));
        assert.equal(stand.forks.length, 1);
        for (let i = 0; i < 5; i++) {
            const t = Date.now();
            assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(hungDir)));
            assert.ok(Date.now() - t < 100, `answered in ${Date.now() - t} ms`);
        }
        const under = await folder.validateRecordingsPathSetting(path.join(hungDir, 'Deeper'));
        assert.ok(refusedAsHung(under), 'a path under the stuck one counts as the same');
        assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(slowShare)), 'so does a parent');
        assert.equal(stand.forks.length, 1, 'one helper for six saves');
        // A healthy path is still checked on a helper of its own.
        assert.deepEqual(await folder.validateRecordingsPathSetting(path.join(healthy, 'Typed')), { ok: true });
        assert.equal(stand.forks.length, 2);
        // Distinct hung paths stop forking at the cap (4 un-exited in all, the healthy one having exited).
        for (const n of ['a', 'b', 'c']) assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(path.join(slowShare, 'x', n))));
        const forked = stand.forks.length;
        const t = Date.now();
        assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(path.join(slowShare, 'x', 'd'))));
        assert.ok(Date.now() - t < 100);
        assert.equal(stand.forks.length, forked, 'no fork beyond the cap');
        assert.ok(shareFs._ownHelpers.size <= 4);
        // Released (they exit): the path can be checked again.
        stand.releaseAll();
        assert.equal(shareFs._ownHelpers.size, 0);
        assert.deepEqual(await folder.validateRecordingsPathSetting(path.join(healthy, 'Typed')), { ok: true });
        assert.ok(refusedAsHung(await folder.validateRecordingsPathSetting(hungDir)));
        assert.equal(stand.forks.length, forked + 2, 'the hung path forked a new helper once the old one had exited');
    } finally {
        shareFs._spawner.fork = realFork;
        stand.releaseAll();
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1500;
    }
});
