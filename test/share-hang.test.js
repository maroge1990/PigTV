const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

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
let shareFs = null; // absent before #8: the proof runs this file against the old server too
try { shareFs = load('services/shareFs'); } catch { /* old server */ }

// Any synchronous call on the share from this process blocks, as on a hung mount.
const blocked = [];
let bypass = false; // a stand-in helper's own calls (deferringHelper) are not this process's
const onShare = (p) => !bypass && (String(p).startsWith(share) || String(p).startsWith(slowShare));
const hang = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
for (const name of ['existsSync', 'statSync', 'statfsSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'unlinkSync']) {
    const real = fs[name];
    fs[name] = function (p, ...rest) {
        if (onShare(p)) { blocked.push(`${name} ${p}`); hang(); }
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

test('#144: a recording starts and its capture ends without a synchronous call on the share', async () => {
    const ffmpeg = path.join(sandbox, 'ffmpeg-fake');
    fs.writeFileSync(ffmpeg, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(out, Buffer.alloc(4000));
const t = setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', d => { if (String(d).includes('q')) { clearInterval(t); process.exit(0); } });
`);
    fs.chmodSync(ffmpeg, 0o755);
    const source = await db.sources.create({ type: 'm3u', name: 'Provider', url: 'http://provider.invalid/list.m3u' });
    load('db/sqlite').getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
        VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 0, 1, 'ff', 'http://provider.invalid/ff.ts')`).run(`${source.id}:pos_1`, source.id);
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings'), sharedIngestEnabled: false, maxConcurrentRecordings: 2 });
    engine.init({ ffmpegPath: ffmpeg, ffprobePath: 'ffprobe' });
    engine.shutdown();
    const { scheduled, recordings } = load('db/recordingsDb');
    const now = Date.now();
    const s = scheduled.create({ title: 'Show', description: null, source_id: source.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
        channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    blocked.length = 0;
    try {
        const { worst } = await loopFreeze(async () => {
            for (let i = 0; i < 100 && recordings.listBySchedule(s.id)[0]?.status !== 'recording'; i++) { await engine.tick(); await new Promise(r => setTimeout(r, 50)); }
            assert.equal(recordings.listBySchedule(s.id)[0]?.status, 'recording', 'started');
            await new Promise(r => setTimeout(r, 300));
            await engine.cancelScheduled(s.id);
            for (let i = 0; i < 100 && recordings.listBySchedule(s.id)[0]?.status === 'recording'; i++) await new Promise(r => setTimeout(r, 50));
        });
        const rec = recordings.listBySchedule(s.id)[0];
        assert.equal(rec.status, 'completed');
        assert.ok(rec.file_size_bytes >= 4000, `size ${rec.file_size_bytes}`);
        assert.deepEqual(blocked, [], 'no synchronous call on the share');
        assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    } finally {
        await engine.stopAllActive(3000);
        await db.settings.update({ recordingsPath });
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
    let realFs = null;
    const fake = Object.assign(new EventEmitter(), {
        connected: true, exitCode: null, signalCode: null, unref() {}, channel: { ref() {}, unref() {} },
        kill() { this.connected = false; this.emit('exit', null, 'SIGKILL'); },
        send(msg) {
            const answer = () => {
                // The helper's calls are not this process's: run them with the real (unblocked) fs.
                let result;
                try { result = realFs(() => run(msg.op, msg.file)); } catch (err) { return fake.emit('message', { id: msg.id, error: err.message }); }
                fake.emit('message', { id: msg.id, result });
            };
            if (hold(msg.op, msg.file)) { held.push(answer); onHeld(); } else setImmediate(answer);
        }
    });
    realFs = (fn) => { bypass = true; try { return fn(); } finally { bypass = false; } };
    return { fake, release: () => { for (const a of held.splice(0)) a(); }, heldCount: () => held.length };
}

async function recordingSetup(title) {
    const { scheduled, recordings } = load('db/recordingsDb');
    let source = (await db.sources.getAll()).find(s => s.name === 'Provider');
    if (!source) {
        source = await db.sources.create({ type: 'm3u', name: 'Provider', url: 'http://provider.invalid/list.m3u' });
        load('db/sqlite').getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
            VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 0, 1, 'ff', 'http://provider.invalid/ff.ts')`).run(`${source.id}:pos_1`, source.id);
    }
    const ffmpeg = path.join(sandbox, 'ffmpeg-fake');
    if (!fs.existsSync(ffmpeg)) {
        fs.writeFileSync(ffmpeg, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(out, Buffer.alloc(4000));
const t = setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', d => { if (String(d).includes('q')) { clearInterval(t); process.exit(0); } });
`);
        fs.chmodSync(ffmpeg, 0o755);
    }
    engine.init({ ffmpegPath: ffmpeg, ffprobePath: 'ffprobe' });
    engine.shutdown();
    const now = Date.now();
    const s = scheduled.create({ title, description: null, source_id: source.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
        channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    return { s, scheduled, recordings };
}

test('#145: a cancel while the file name is looked up on the share starts nothing', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings'), sharedIngestEnabled: false });
    const realFork = shareFs._spawner.fork;
    const helper = deferringHelper((op, file) => op === 'exists' && String(file).endsWith('.ts'));
    shareFs.reset();
    shareFs._spawner.fork = () => helper.fake;
    try {
        const { s, scheduled, recordings } = await recordingSetup('Cancelled while naming');
        const ticks = [];
        for (let i = 0; i < 100 && helper.heldCount() === 0; i++) {
            ticks.push(engine.tick());
            await new Promise(r => setTimeout(r, 30));
        }
        assert.equal(helper.heldCount(), 1, 'the name lookup is waiting on the share');
        await engine.cancelScheduled(s.id);
        helper.release();
        await Promise.all(ticks);
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(recordings.listBySchedule(s.id), [], 'no recording was created');
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
        assert.ok(!engine.listActive().some(r => r.id === s.id), 'no capture runs');
    } finally {
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        await engine.stopAllActive(3000);
        await db.settings.update({ recordingsPath });
    }
});

test('#146: a cancel stays cancelled when the capture\'s size answers late', async () => {
    await db.settings.update({ recordingsPath: path.join(slowShare, 'Recordings'), sharedIngestEnabled: false });
    const realFork = shareFs._spawner.fork;
    let holdStat = false;
    // The size read at the capture's exit is answered 100 ms late: after the stop has seen the capture close.
    const helper = deferringHelper((op, file) => holdStat && op === 'stat' && String(file).endsWith('.ts'),
        () => setTimeout(() => helper.release(), 100));
    shareFs.reset();
    shareFs._spawner.fork = () => helper.fake;
    try {
        const { s, scheduled, recordings } = await recordingSetup('Cancelled at the end');
        for (let i = 0; i < 100 && recordings.listBySchedule(s.id)[0]?.status !== 'recording'; i++) { await engine.tick(); await new Promise(r => setTimeout(r, 30)); }
        assert.equal(recordings.listBySchedule(s.id)[0]?.status, 'recording');
        holdStat = true;
        await engine.cancelScheduled(s.id);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(scheduled.getById(s.id).status, 'cancelled', 'the cancel is the last word');
    } finally {
        holdStat = false;
        helper.release();
        shareFs._spawner.fork = realFork;
        shareFs.reset();
        await engine.stopAllActive(3000);
        await db.settings.update({ recordingsPath });
    }
});

// ---- #141: deleting recordings and the start-up clean-up ----

/** Real file calls on the share, from this process, for a test's own setup and checks. */
const real = (fn) => { bypass = true; try { return fn(); } finally { bypass = false; } };
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
