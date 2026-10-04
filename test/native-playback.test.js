const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
// ffmpeg and ffprobe are stood in for, so this needs neither.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-native-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const { recordings } = load('db/recordingsDb');

const dir = path.join(sandbox, 'recordings');
fs.mkdirSync(dir, { recursive: true });

// Stand-ins. `ffmpegCalls` records each remux; the fake writes whatever file the
// arguments name as the output (the last argument), after an optional delay.
const calls = { ffmpeg: [], duration: [], codecs: [] };
let behaviour;
function resetTools() {
    calls.ffmpeg = []; calls.duration = []; calls.codecs = [];
    behaviour = { delayMs: 20, exitCode: 0, codecs: { video: 'h264', audio: 'aac' }, durations: {} };
    engine._nativeTools.codecs = async (file) => { calls.codecs.push(file); return behaviour.codecs; };
    // A file listed as null is one ffprobe cannot read; anything unlisted is a healthy 60 s.
    engine._nativeTools.duration = async (file) => { calls.duration.push(file); return file in behaviour.durations ? behaviour.durations[file] : 60; };
    engine._nativeTools.audioErrors = async () => 0;
    engine._nativeTools.ffmpeg = async (args) => {
        calls.ffmpeg.push(args);
        const out = args[args.length - 1];
        fs.writeFileSync(out, 'work in progress'); // ffmpeg creates its output straight away
        await new Promise(r => setTimeout(r, behaviour.delayMs));
        if (behaviour.exitCode === 0) fs.writeFileSync(out, `remuxed:${calls.ffmpeg.length}`);
        // else: a failed run leaves its half-written output behind, as ffmpeg does
        return { code: behaviour.exitCode, tail: behaviour.exitCode ? ['Error muxing a packet'] : [] };
    };
}

let n = 0;
function makeRecording() {
    const base = `Show ${++n} - 2026-09-19 19-30`;
    const file = path.join(dir, `${base}.mkv`);
    fs.writeFileSync(file, 'mkv-bytes');
    const row = recordings.create({ scheduled_id: n, title: `Show ${n}`, channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() });
    return { rec: row, file, native: path.join(dir, `${base}.native.mp4`), partial: path.join(dir, `${base}.native.mp4.partial`),
        compressed: path.join(dir, `${base}.compressed.mp4`) };
}

beforeEach(resetTools);

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* still open on Windows; leave it to the OS temp cleaner */ }
});

before(resetTools);

test('HEVC is tagged hvc1 so AVPlayer will open it; H.264 is left alone', () => {
    const hevc = engine.buildNativeRemuxArgs('in.mkv', 'out.mp4', { video: 'hevc', audio: 'ac3' });
    assert.deepEqual(hevc.slice(hevc.indexOf('-tag:v'), hevc.indexOf('-tag:v') + 2), ['-tag:v', 'hvc1']);
    assert.ok(!engine.buildNativeRemuxArgs('in.mkv', 'out.mp4', { video: 'h264', audio: 'ac3' }).includes('-tag:v'));
});

test('audio: AAC (any flavour) and MP2 are re-encoded to AAC-LC, AC-3 is copied (0203)', () => {
    // A copied AAC track keeps its first frame's config for the whole file; broadcast HE-AAC
    // that changes at an ad break then fails to decode (recording #5, 4 Oct).
    const aac = engine.buildNativeRemuxArgs('i', 'o', { video: 'h264', audio: 'aac', audioChannels: 2 });
    assert.ok(!aac.includes('aac_adtstoasc'), 'no longer copied');
    assert.deepEqual(aac.slice(aac.indexOf('-c:a'), aac.indexOf('-c:a') + 4), ['-c:a', 'aac', '-profile:a', 'aac_low']);
    assert.ok(aac.includes('aresample=async=1:first_pts=0'), 'gaps from a reconnect are absorbed');
    assert.deepEqual(aac.slice(aac.indexOf('-ac'), aac.indexOf('-ac') + 2), ['-ac', '2']);
    const surround = engine.buildNativeRemuxArgs('i', 'o', { video: 'h264', audio: 'aac', audioChannels: 6 });
    assert.deepEqual(surround.slice(surround.indexOf('-ac'), surround.indexOf('-ac') + 4), ['-ac', '6', '-b:a', '384k'], '5.1 stays 5.1');
    const mp2 = engine.buildNativeRemuxArgs('i', 'o', { video: 'h264', audio: 'mp2' });
    assert.deepEqual(mp2.slice(mp2.indexOf('-c:a'), mp2.indexOf('-c:a') + 2), ['-c:a', 'aac'], 'MP2 cannot be played from MP4 by AVPlayer');
    const ac3 = engine.buildNativeRemuxArgs('i', 'o', { video: 'h264', audio: 'ac3' });
    assert.ok(!ac3.includes('-bsf:a') && !ac3.includes('aac'), 'AC-3 is valid in MP4 and stays a stream copy');
    const eac3 = engine.buildNativeRemuxArgs('i', 'o', { video: 'h264', audio: 'eac3' });
    assert.ok(!eac3.includes('-c:a'), 'so does E-AC-3');
});

test('the remux is written to the given path in mp4 format, with the index up front', () => {
    const args = engine.buildNativeRemuxArgs('in.mkv', 'x.native.mp4.partial', {});
    assert.equal(args[args.length - 1], 'x.native.mp4.partial');
    assert.deepEqual(args.slice(-5, -1), ['-movflags', '+faststart', '-f', 'mp4'], '-f is needed because the temporary name has no .mp4 extension');
});

test('HEVC compression output is tagged hvc1 as well', () => {
    const hevc = engine.buildCompressArgs('in.mkv', 'out.mp4', { postRecordCodec: 'hevc', postRecordBitrateKbps: 3000, hwEncoder: 'software' });
    assert.ok(hevc.join(' ').includes('-tag:v hvc1'));
    const h264 = engine.buildCompressArgs('in.mkv', 'out.mp4', { postRecordCodec: 'h264', postRecordBitrateKbps: 3000, hwEncoder: 'software' });
    assert.ok(!h264.includes('-tag:v'));
});

test('two requests for the same recording share one remux', async () => {
    const r = makeRecording();
    const [a, b, c] = await Promise.all([engine.ensureNativePlayback(r.rec), engine.ensureNativePlayback(r.rec), engine.ensureNativePlayback(r.rec)]);
    assert.equal(calls.ffmpeg.length, 1, 'ffmpeg ran once, not once per request');
    assert.equal(a, r.native);
    assert.equal(b, r.native);
    assert.equal(c, r.native);
    assert.equal(fs.readFileSync(r.native, 'utf8'), 'remuxed:1');
});

test('the final file only appears once the remux has finished', async () => {
    const r = makeRecording();
    behaviour.delayMs = 150;
    const pending = engine.ensureNativePlayback(r.rec);
    await new Promise(res => setTimeout(res, 60));
    assert.ok(!fs.existsSync(r.native), 'a half-written file must never sit under the final name');
    assert.ok(fs.existsSync(r.partial), 'work in progress is under the temporary name');
    await pending;
    assert.ok(fs.existsSync(r.native));
    assert.ok(!fs.existsSync(r.partial), 'the temporary file was renamed away, not copied');
});

test('a failed remux leaves nothing behind and reports why', async () => {
    const r = makeRecording();
    behaviour.exitCode = 1;
    await assert.rejects(engine.ensureNativePlayback(r.rec), /Error muxing a packet/);
    assert.ok(!fs.existsSync(r.native));
    assert.ok(!fs.existsSync(r.partial));
    // And the next attempt is a fresh one, not a cached failure.
    behaviour.exitCode = 0;
    assert.equal(await engine.ensureNativePlayback(r.rec), r.native);
});

test('debris from a killed remux is cleared before the next one starts', async () => {
    const r = makeRecording();
    fs.writeFileSync(r.partial, 'debris from a killed process');
    await engine.ensureNativePlayback(r.rec);
    assert.equal(fs.readFileSync(r.native, 'utf8'), 'remuxed:1');
    assert.ok(!fs.existsSync(r.partial));
});

test('an incomplete file left by an older version is remade; a good one is reused without a remux', async () => {
    const bad = makeRecording();
    fs.writeFileSync(bad.native, 'truncated - no moov atom');
    behaviour.durations[bad.native] = null; // ffprobe cannot read it
    await engine.ensureNativePlayback(bad.rec);
    assert.equal(calls.ffmpeg.length, 1, 'the truncated file was regenerated');
    assert.equal(fs.readFileSync(bad.native, 'utf8'), 'remuxed:1');

    resetTools();
    const good = makeRecording();
    fs.writeFileSync(good.native, 'a complete file');
    assert.equal(await engine.ensureNativePlayback(good.rec), good.native);
    assert.equal(calls.ffmpeg.length, 0, 'a readable file is served as it is');
    assert.equal(fs.readFileSync(good.native, 'utf8'), 'a complete file');
});

test('a file already verified is not probed again on every Range request', async () => {
    const r = makeRecording();
    fs.writeFileSync(r.native, 'a complete file');
    await engine.ensureNativePlayback(r.rec);
    await engine.ensureNativePlayback(r.rec);
    await engine.ensureNativePlayback(r.rec);
    assert.equal(calls.duration.length, 1, 'ffprobe ran once for the file, not once per request');
});

test('deleting a recording removes what was made from it, not just the .mkv', async () => {
    const r = makeRecording();
    fs.writeFileSync(r.native, 'native');
    fs.writeFileSync(r.partial, 'partial');
    fs.writeFileSync(r.compressed, 'compressed');
    await engine.deleteRecording(r.rec.id);
    for (const f of [r.file, r.native, r.partial, r.compressed]) assert.ok(!fs.existsSync(f), `${path.basename(f)} should be gone`);
    assert.equal(recordings.getById(r.rec.id) ?? null, null);
});

test("deleting one recording leaves another's files alone", async () => {
    const keep = makeRecording();
    fs.writeFileSync(keep.native, 'native');
    const gone = makeRecording();
    await engine.deleteRecording(gone.rec.id);
    assert.ok(fs.existsSync(keep.file) && fs.existsSync(keep.native));
});
