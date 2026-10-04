const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0192 (audit R06/R08): recordings are prepared for the Apple client when they
// finish, the MP4 replaces the .mkv once checked, and compression only ever
// publishes - or deletes an original for - a result it could actually verify.
// Same sandbox and ffmpeg/ffprobe stand-ins as native-playback.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-prepare-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const { recordings } = load('db/recordingsDb');
const { getDb } = load('db/sqlite');

const dir = path.join(sandbox, 'recordings');
fs.mkdirSync(dir, { recursive: true });

const calls = { ffmpeg: [] };
let behaviour;
beforeEach(() => {
    calls.ffmpeg = [];
    // durations/codecs: by file; a file listed as null is one ffprobe cannot read.
    behaviour = { exitCode: 0, durations: {}, codecs: {}, audioErrors: {} };
    engine._nativeTools.audioErrors = async (file) => (file in behaviour.audioErrors ? behaviour.audioErrors[file] : 0);
    engine._nativeTools.duration = async (file) => (file in behaviour.durations ? behaviour.durations[file] : 60);
    engine._nativeTools.codecs = async (file) => behaviour.codecs[file] || { video: 'h264', audio: 'aac' };
    engine._nativeTools.ffmpeg = async (args) => {
        calls.ffmpeg.push(args);
        const out = args[args.length - 1];
        fs.writeFileSync(out, behaviour.exitCode === 0 ? 'encoded' : 'half');
        return { code: behaviour.exitCode, tail: behaviour.exitCode ? ['Error'] : [] };
    };
});

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

let n = 0;
function makeRecording({ bytes = 'x'.repeat(4096) } = {}) {
    const base = `Prep ${++n} - 2026-10-03 19-30`;
    const file = path.join(dir, `${base}.mkv`);
    fs.writeFileSync(file, bytes);
    const row = recordings.create({ scheduled_id: 1000 + n, title: `Prep ${n}`, channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() - 3600e3 });
    recordings.finish(row.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: bytes.length, duration_sec: 3600 });
    return {
        id: row.id, file,
        mp4: path.join(dir, `${base}.mp4`),
        native: path.join(dir, `${base}.native.mp4`),
        compressed: path.join(dir, `${base}.compressed.mp4`)
    };
}
const row = id => recordings.getById(id);

// ---- compression (R08) ------------------------------------------------------

test('compression never deletes the original when the original\'s length cannot be read', async () => {
    const r = makeRecording();
    behaviour.durations[r.file] = null;
    await engine._compressRecording(row(r.id), { postRecordKeepOriginal: false });
    assert.ok(fs.existsSync(r.file), 'original kept');
    assert.ok(!fs.existsSync(r.compressed) && !fs.existsSync(`${r.compressed}.partial`), 'no result left behind');
    assert.equal(row(r.id).compress_status, 'failed');
    assert.match(row(r.id).compress_error, /could not be verified/);
    assert.equal(row(r.id).file_path, r.file);
});

test('compression never deletes the original when the result\'s length cannot be read', async () => {
    const r = makeRecording();
    behaviour.durations[`${r.compressed}.partial`] = null;
    await engine._compressRecording(row(r.id), { postRecordKeepOriginal: false });
    assert.ok(fs.existsSync(r.file));
    assert.ok(!fs.existsSync(r.compressed));
    assert.equal(row(r.id).compress_status, 'failed');
});

test('compression encodes under a temporary name and publishes only a verified result', async () => {
    const r = makeRecording();
    let seenFinalDuringEncode = null;
    engine._nativeTools.ffmpeg = async (args) => {
        const out = args[args.length - 1];
        assert.equal(out, `${r.compressed}.partial`);
        assert.deepEqual(args.slice(-3, -1), ['-f', 'mp4'], 'format is explicit for the temporary name');
        fs.writeFileSync(out, 'y'.repeat(2048)); // over the 1 KB floor, under the original
        seenFinalDuringEncode = fs.existsSync(r.compressed);
        return { code: 0, tail: [] };
    };
    await engine._compressRecording(row(r.id), { postRecordKeepOriginal: false });
    assert.equal(seenFinalDuringEncode, false, 'the final name never holds a file mid-encode');
    assert.equal(row(r.id).compress_status, 'done');
    assert.equal(row(r.id).file_path, r.compressed, 'the row moved to the result');
    assert.ok(fs.existsSync(r.compressed) && !fs.existsSync(r.file), 'original removed after the row moved');
});

test('a compressed file that compression has not finished is never served for playback', async () => {
    const r = makeRecording();
    fs.writeFileSync(r.compressed, 'truncated by an older version');
    const served = await engine.ensureNativePlayback(row(r.id));
    assert.equal(served, r.native, 'remuxed instead of serving the unfinished compressed file');
});

// ---- preparation (R06) ------------------------------------------------------

test('a finished recording is prepared, the MP4 replaces the .mkv, and the .mkv is deleted', async () => {
    const r = makeRecording();
    await engine._prepareRecording(row(r.id));
    const after = row(r.id);
    assert.equal(after.native_status, 'ready');
    assert.equal(after.file_path, r.mp4);
    assert.ok(fs.existsSync(r.mp4));
    assert.ok(!fs.existsSync(r.file), '.mkv deleted');
    assert.ok(!fs.existsSync(r.native), 'nothing left under the temporary .native.mp4 name');
    assert.equal(engine.pollNativePlayback(after).state, 'ready');
    assert.equal(await engine.ensureNativePlayback(after), r.mp4, 'Play serves it with no further work');
});

test('an original whose length cannot be read is kept; the recording is still ready to play', async () => {
    const r = makeRecording();
    behaviour.durations[r.file] = null;
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'ready');
    assert.match(row(r.id).native_error, /Original kept/);
    assert.ok(fs.existsSync(r.file), '.mkv kept');
    assert.equal(row(r.id).file_path, r.file);
});

test('a short result is discarded and retried, then given up on after three attempts; the .mkv survives', async () => {
    const r = makeRecording();
    behaviour.durations[r.file] = 3600;
    behaviour.durations[r.native] = 1200;
    for (let i = 1; i <= 3; i++) {
        await engine._prepareRecording(row(r.id));
        assert.equal(row(r.id).native_attempts, i);
        assert.equal(row(r.id).native_status, i < 3 ? 'pending' : 'failed');
        assert.match(row(r.id).native_error, /short/);
        assert.ok(!fs.existsSync(r.native), 'the short file is not left to be served');
        assert.ok(fs.existsSync(r.file));
    }
});

test('a result that lost the audio is not accepted', async () => {
    const r = makeRecording();
    behaviour.codecs[r.native] = { video: 'h264', audio: null };
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'pending');
    assert.match(row(r.id).native_error, /audio/);
    assert.ok(fs.existsSync(r.file));
});

test('a restart after the rename finishes the job without remuxing again', async () => {
    const r = makeRecording();
    fs.writeFileSync(r.mp4, 'prepared before the restart');
    await engine._prepareRecording(row(r.id));
    assert.equal(calls.ffmpeg.length, 0, 'no second remux');
    assert.equal(row(r.id).file_path, r.mp4);
    assert.ok(!fs.existsSync(r.file));
});

test('a recording that is already an MP4 is simply marked ready', async () => {
    const r = makeRecording();
    fs.renameSync(r.file, r.mp4);
    getDb().prepare('UPDATE recordings SET file_path = ? WHERE id = ?').run(r.mp4, r.id);
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'ready');
    assert.equal(calls.ffmpeg.length, 0);
});

test('deleting a prepared recording removes the MP4 and any original that was kept', async () => {
    const r = makeRecording();
    behaviour.durations[r.file] = null; // an unreadable length: the original is kept beside the MP4
    await engine._prepareRecording(row(r.id));
    assert.ok(fs.existsSync(r.file) && fs.existsSync(r.native));
    fs.renameSync(r.native, r.mp4);
    getDb().prepare('UPDATE recordings SET file_path = ? WHERE id = ?').run(r.mp4, r.id);
    await engine.deleteRecording(r.id);
    assert.ok(!fs.existsSync(r.mp4) && !fs.existsSync(r.file));
    assert.equal(row(r.id), null);
});

// ---- restart ------------------------------------------------------------------

test('on startup, interrupted jobs are requeued, a cut-short encode is cleared, and the library is queued', () => {
    const compressing = makeRecording();
    const preparing = makeRecording();
    const never = makeRecording();
    getDb().prepare("UPDATE recordings SET compress_status = 'running' WHERE id = ?").run(compressing.id);
    fs.writeFileSync(compressing.compressed, 'written in place by an older version');
    recordings.setNativeStatus(preparing.id, 'preparing');
    getDb().prepare('UPDATE recordings SET native_status = NULL WHERE id = ?').run(never.id);

    engine._reconcileJobsOnStartup();

    assert.equal(row(compressing.id).compress_status, 'pending');
    assert.ok(!fs.existsSync(compressing.compressed), 'truncated encode removed');
    assert.equal(row(preparing.id).native_status, 'pending');
    assert.equal(row(never.id).native_status, 'pending', 'earlier recordings are queued');
    assert.ok(recordings.findPendingNative().some(x => x.id === never.id));
});

// ---- 0203: decode-checked, and old preparations redone ---------------------------

test('a prepared file whose audio does not decode is refused and the .mkv survives (recording #5, 4 Oct)', async () => {
    const r = makeRecording();
    behaviour.audioErrors[r.file] = 2;          // a broadcast glitch or two in the original
    behaviour.audioErrors[r.native] = 400;      // the copied HE-AAC after an ad break
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'pending');
    assert.match(row(r.id).native_error, /does not decode/);
    assert.ok(fs.existsSync(r.file), '.mkv kept');
    assert.ok(!fs.existsSync(r.native) && !fs.existsSync(r.mp4), 'nothing broken left to be served');
});

test('a few audio errors that the original has too are not a reason to refuse', async () => {
    const r = makeRecording();
    behaviour.audioErrors[r.file] = 3;
    behaviour.audioErrors[r.native] = 5;
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'ready');
    assert.equal(row(r.id).native_version, 2);
});

test('if the audio cannot be decode-checked at all, the original is kept', async () => {
    const r = makeRecording();
    behaviour.audioErrors[r.native] = null;
    await engine._prepareRecording(row(r.id));
    assert.equal(row(r.id).native_status, 'ready');
    assert.ok(fs.existsSync(r.file));
    assert.match(row(r.id).native_error, /decode-checked/);
});

test('on startup, an old preparation beside a surviving .mkv is made again; an adopted one is left', () => {
    const kept = makeRecording();
    fs.writeFileSync(kept.native, 'copied audio');
    recordings.setNativeStatus(kept.id, 'ready');
    const adopted = makeRecording();
    fs.renameSync(adopted.file, adopted.mp4);
    getDb().prepare('UPDATE recordings SET file_path = ? WHERE id = ?').run(adopted.mp4, adopted.id);
    recordings.setNativeStatus(adopted.id, 'ready');
    const current = makeRecording();
    fs.writeFileSync(current.native, 'new way');
    recordings.setNativeStatus(current.id, 'ready');
    recordings.setNativeVersion(current.id, 2);

    engine._reconcileJobsOnStartup();

    assert.equal(row(kept.id).native_status, 'pending');
    assert.ok(!fs.existsSync(kept.native), 'the copied-audio MP4 is removed');
    assert.equal(row(adopted.id).native_status, 'ready', 'no .mkv left to redo it from');
    assert.equal(row(current.id).native_status, 'ready');
    assert.ok(fs.existsSync(current.native));
});
