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
let shareFs = null; // absent before #8: the proof runs this file against the old server too
try { shareFs = load('services/shareFs'); } catch { /* old server */ }

// Any synchronous call on the share from this process blocks, as on a hung mount.
const blocked = [];
const onShare = (p) => String(p).startsWith(share) || String(p).startsWith(slowShare);
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
