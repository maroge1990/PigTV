const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// 0207: Comskip follows a recording while it is captured (live mode), with a fake Comskip
// standing in for the binary. Same sandbox as recording-prepare.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-live-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const adDetect = load('services/adDetect');
const post = load('services/recordingPost');
const jobs = load('services/recordingJobs');
const db = load('db');
const { recordings } = load('db/recordingsDb');

const dir = path.join(sandbox, 'recordings');
fs.mkdirSync(dir, { recursive: true });

let procs;   // every fake Comskip started, in order
function fakeSpawn(cmd, args) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.args = args;
    proc.killed = false;
    const arg = (name) => (args.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
    proc.outDir = arg('output');
    proc.ini = arg('ini') && fs.existsSync(arg('ini')) ? fs.readFileSync(arg('ini'), 'utf8') : null;
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('close', null)); };
    // Comskip's own end: an EDL (or not) and an exit code.
    proc.exit = (edl, code = 1) => {
        if (edl !== null) fs.writeFileSync(path.join(proc.outDir, 'x.edl'), edl);
        proc.emit('close', code);
    };
    procs.push(proc);
    return proc;
}

beforeEach(async () => {
    procs = [];
    adDetect._setForTests({
        available: true,
        spawn: fakeSpawn
    });
    await db.settings.update({ adDetectionEnabled: true, comskipIniPath: '' });
});

after(() => {
    adDetect._setForTests();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

let n = 0;
function makeRecording({ status = 'recording' } = {}) {
    const file = path.join(dir, `live-${++n}.ts`);
    fs.writeFileSync(file, 'x'.repeat(4096));
    const row = recordings.create({ scheduled_id: 2000 + n, title: `Live ${n}`, channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'x', file_path: file, started_at: Date.now() - 600e3 });
    if (status === 'completed') recordings.finish(row.id, { status, ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    return { id: row.id, file_path: file };
}
const row = id => recordings.getById(id);
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('a live run starts for a capturing part: live ini overlay, 4 threads, status running', async () => {
    const ini = path.join(sandbox, 'custom.ini');
    fs.writeFileSync(ini, 'detect_method=107\nlive_tv=0\n');
    await db.settings.update({ comskipIniPath: ini });
    const r = makeRecording();
    assert.equal(await post.startLiveDetection(r), true);
    await settle();
    assert.equal(procs.length, 1);
    const p = procs[0];
    assert.ok(p.args.includes('--threads=4'));
    assert.ok(p.args.includes(r.file_path));
    assert.match(p.ini, /detect_method=107/, 'the configured ini is kept');
    assert.match(p.ini, /live_tv=1\nlive_tv_retries=15\n$/, 'and the live settings come last, overriding it');
    assert.equal(row(r.id).ad_detect_status, 'running');
    assert.ok(jobs.liveDetecting.has(r.id));
    assert.equal(await post.startLiveDetection(r), false, 'one run per part');
    post.abortLive(r.id);
    await settle();
});

test('nothing starts when detection is off, or Comskip is missing', async () => {
    await db.settings.update({ adDetectionEnabled: false });
    const a = makeRecording();
    assert.equal(await post.startLiveDetection(a), false);
    await db.settings.update({ adDetectionEnabled: true });
    adDetect._setForTests({ available: false });
    const b = makeRecording();
    assert.equal(await post.startLiveDetection(b), false);
    assert.equal(procs.length, 0);
    assert.equal(row(b.id).ad_detect_status, null);
});

test('success after the capture ended writes the markers and marks done; the file stays reserved until then', async () => {
    const r = makeRecording();
    await post.startLiveDetection(r);
    await settle();
    recordings.finish(r.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    assert.equal(post.liveCaptureEnded(r.id, true), true, 'the run is finishing the file');
    assert.ok(jobs.liveDetecting.has(r.id), 'compression and preparation leave it alone meanwhile');
    assert.equal(row(r.id).ad_detect_status, 'running');
    procs[0].exit('10.5\t60.25\t0\n100\t160\t0\n', 1);
    await settle();
    assert.equal(row(r.id).ad_detect_status, 'done');
    assert.deepEqual(recordings.getMarkers(r.id).map(m => [m.start_ms, m.end_ms]), [[10500, 60250], [100000, 160000]]);
    assert.ok(!jobs.liveDetecting.has(r.id));
    assert.ok(!post.isLive(r.id));
});

test('an exit before the capture ended leaves the recording to the queue', async () => {
    const r = makeRecording();
    await post.startLiveDetection(r);
    await settle();
    procs[0].exit('1\t2\t0\n', 1); // Comskip gave up on a stalled file
    await settle();
    assert.equal(recordings.getMarkers(r.id).length, 0, 'partial markers are not kept');
    assert.equal(row(r.id).ad_detect_status, null);
    assert.ok(!jobs.liveDetecting.has(r.id));
    // The capture then ends: no live run is left to follow it, so it is queued as before,
    // and the post-recording run (threads passed, scaled timeout) does the job.
    assert.equal(post.liveCaptureEnded(r.id, true), false);
    recordings.finish(r.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    recordings.setAdDetectStatus(r.id, 'pending');
    const queued = post.processAdDetectionQueue();
    await settle();
    assert.equal(procs.length, 2);
    assert.ok(procs[1].args.includes('--threads=4'));
    assert.doesNotMatch(procs[1].ini || '', /live_tv=1/, 'the post run is not live');
    procs[1].exit('5\t50\t0\n', 1);
    await queued;
    assert.equal(row(r.id).ad_detect_status, 'done');
});

test('a live run that fails after the capture ended falls back to the queue', async () => {
    const r = makeRecording();
    await post.startLiveDetection(r);
    await settle();
    recordings.finish(r.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    post.liveCaptureEnded(r.id, true);
    procs[0].exit(null, 2); // no EDL
    await settle();
    assert.equal(row(r.id).ad_detect_status, 'pending');
});

test('past the grace after the capture ended the run is killed and the recording goes to the queue', async () => {
    adDetect._setForTests({ available: true, graceMs: 30, spawn: fakeSpawn });
    const r = makeRecording();
    await post.startLiveDetection(r);
    await settle();
    // Before the capture ends there is no timeout at all.
    await new Promise(res => setTimeout(res, 60));
    assert.equal(procs[procs.length - 1].killed, false);
    recordings.finish(r.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    post.liveCaptureEnded(r.id, true);
    await new Promise(res => setTimeout(res, 120));
    assert.equal(procs[procs.length - 1].killed, true, 'killed after the grace');
    assert.equal(row(r.id).ad_detect_status, 'pending');
    assert.ok(!jobs.liveDetecting.has(r.id));
});

test('at most two live runs at once; the rest wait for the queue', async () => {
    const a = makeRecording(), b = makeRecording(), c = makeRecording();
    assert.equal(await post.startLiveDetection(a), true);
    assert.equal(await post.startLiveDetection(b), true);
    assert.equal(await post.startLiveDetection(c), false);
    assert.equal(post.MAX_LIVE_RUNS, 2);
    await settle();
    assert.equal(procs.length, 2);
    post.abortLive(a.id);
    await settle();
    assert.equal(await post.startLiveDetection(c), true, 'a free slot is used');
    post.abortLive(b.id);
    post.abortLive(c.id);
    await settle();
});

test('a capture that produced nothing usable stops its run; a delete does too', async () => {
    const a = makeRecording();
    await post.startLiveDetection(a);
    await settle();
    assert.equal(post.liveCaptureEnded(a.id, false), false);
    await settle();
    assert.equal(procs[0].killed, true);
    assert.equal(row(a.id).ad_detect_status, null);

    const b = makeRecording();
    await post.startLiveDetection(b);
    await settle();
    recordings.delete(b.id);
    post.abortLive(b.id);
    await settle();
    assert.equal(procs[1].killed, true);
    assert.equal(recordings.getMarkers(b.id).length, 0);
});

test('post-recording runs: timeout scales with the recording, never below 30 minutes, and threads are passed', async () => {
    const MIN = 30 * 60 * 1000;
    assert.equal(adDetect.postTimeoutMs(0), MIN);
    assert.equal(adDetect.postTimeoutMs(3600), MIN);            // half of 1 h is exactly 30 min
    assert.equal(adDetect.postTimeoutMs(4 * 3600), 2 * 3600 * 1000);
    assert.equal(adDetect.postTimeoutMs(null), MIN);

    const r = makeRecording({ status: 'completed' });
    const result = adDetect.detect(r.file_path, { timeoutMs: adDetect.postTimeoutMs(600) });
    await settle();
    assert.ok(procs[0].args.includes('--threads=4'));
    procs[0].exit('1\t2\t0\n');
    const out = await result;
    assert.equal(out.ok, true);
    assert.equal(typeof out.elapsedSec, 'number');
});
