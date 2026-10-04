const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs the real ffmpeg/ffprobe against tiny generated files. The native-playback
// tests substitute the codec probe, so they cannot notice if the probe's own
// parsing of ffprobe output is wrong (it once read every field swapped).
//
// Same sandbox approach as native-playback.test.js so the server's relative
// data paths never touch real data.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-probe-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

// recordingEngine spawns plain 'ffmpeg' / 'ffprobe' until init() overrides them,
// so make those names resolve: the system binaries if present, otherwise the
// ones the server falls back to in server/index.js.
function works(bin) {
    try { return spawnSync(bin, ['-version'], { timeout: 10000 }).status === 0; } catch { return false; }
}
function fallback(mod) {
    try {
        const p = require(path.resolve(__dirname, '../node_modules', mod));
        return typeof p === 'string' ? p : p.path;
    } catch { return null; }
}
const binDir = path.join(sandbox, 'bin');
fs.mkdirSync(binDir);
let toolsOk = true;
for (const [name, mod] of [['ffmpeg', 'ffmpeg-static'], ['ffprobe', '@ffprobe-installer/ffprobe']]) {
    if (works(name)) continue;
    const alt = fallback(mod);
    if (alt && fs.existsSync(alt) && works(alt)) fs.symlinkSync(alt, path.join(binDir, name));
    else toolsOk = false;
}
process.env.PATH = binDir + path.delimiter + process.env.PATH;
const skipReason = toolsOk ? false : 'ffmpeg/ffprobe are not available';

const engine = require(path.join(sandbox, 'server/services/recordingEngine'));

const dir = path.join(sandbox, 'fixtures');
fs.mkdirSync(dir);
const files = {};

function encoders() {
    return spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
}
function makeFixture(name, videoArgs, audioArgs) {
    const out = path.join(dir, name);
    const r = spawnSync('ffmpeg', ['-y', '-nostdin', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        ...videoArgs, ...audioArgs, '-t', '1', out], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `fixture ${name} failed: ${r.stderr}`);
    return out;
}

before(() => {
    if (!toolsOk) return;
    files.h264aac = makeFixture('h264-aac.mkv', ['-c:v', 'libx264'], ['-c:a', 'aac']);
    files.h264mp2 = makeFixture('h264-mp2.mkv', ['-c:v', 'libx264'], ['-c:a', 'mp2']);
    if (/\blibx265\b/.test(encoders())) {
        files.hevcaac = makeFixture('hevc-aac.mkv', ['-c:v', 'libx265', '-x265-params', 'log-level=error'], ['-c:a', 'aac']);
    }
});

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* still open on Windows; leave it to the OS temp cleaner */ }
});

test('probeCodecs reads H.264 + AAC', { skip: skipReason }, async () => {
    const c = await engine.probeCodecs(files.h264aac);
    assert.deepEqual({ video: c.video, audio: c.audio }, { video: 'h264', audio: 'aac' });
    assert.ok(c.audioChannels >= 1, '0203: the channel count, for the AAC re-encode');
});

test('probeCodecs reads HEVC + AAC, and the remux args tag it hvc1', { skip: skipReason }, async (t) => {
    if (!files.hevcaac) return t.skip('the libx265 encoder is not available');
    const codecs = await engine.probeCodecs(files.hevcaac);
    assert.deepEqual({ video: codecs.video, audio: codecs.audio }, { video: 'hevc', audio: 'aac' });
    const args = engine.buildNativeRemuxArgs('in.mkv', 'out.mp4', codecs);
    assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
});

test('probeCodecs reads H.264 + MP2, and the remux args re-encode the audio to AAC', { skip: skipReason }, async () => {
    const codecs = await engine.probeCodecs(files.h264mp2);
    assert.deepEqual({ video: codecs.video, audio: codecs.audio }, { video: 'h264', audio: 'mp2' });
    const args = engine.buildNativeRemuxArgs('in.mkv', 'out.mp4', codecs);
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.ok(!args.includes('-tag:v'));
});

test('probeCodecs resolves nulls for a missing or unreadable file', { skip: skipReason }, async () => {
    assert.deepEqual(await engine.probeCodecs(path.join(dir, 'nope.mkv')), { video: null, audio: null });
    const junk = path.join(dir, 'junk.mkv');
    fs.writeFileSync(junk, 'not a media file');
    assert.deepEqual(await engine.probeCodecs(junk), { video: null, audio: null });
});

test('a real remux of an MP2 recording leaves AAC audio in the MP4', { skip: skipReason }, async () => {
    const out = path.join(dir, 'remuxed.mp4');
    const codecs = await engine.probeCodecs(files.h264mp2);
    const result = await engine._nativeTools.ffmpeg(engine.buildNativeRemuxArgs(files.h264mp2, out, codecs));
    assert.equal(result.code, 0, result.tail.join('\n'));
    const outCodecs = await engine.probeCodecs(out);
    assert.deepEqual({ video: outCodecs.video, audio: outCodecs.audio }, { video: 'h264', audio: 'aac' });
});

// ---- 0203: a channel that changes its audio mid-programme (recording #5, 4 Oct) ----
// Two halves with different AAC configs (48 kHz stereo, then 24 kHz mono), joined as the
// provider's MPEG-TS would carry them across an ad break.
function ff(args) {
    const r = spawnSync('ffmpeg', ['-y', '-nostdin', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
}
function audioDecodeErrors(file) {
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
    return (r.stderr || '').split('\n').filter(l => l.trim()).length;
}
function meanVolume(file, from, secs) {
    const r = spawnSync('ffmpeg', ['-nostdin', '-ss', String(from), '-t', String(secs), '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
    const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr || '');
    return m ? parseFloat(m[1]) : -Infinity;
}
function changingAudioTs() {
    const a = path.join(dir, 'half-a.ts');
    const b = path.join(dir, 'half-b.ts');
    ff(['-f', 'lavfi', '-i', 'testsrc=d=6:s=160x120:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000',
        '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-f', 'mpegts', a]);
    ff(['-f', 'lavfi', '-i', 'testsrc=d=6:s=160x120:r=25', '-f', 'lavfi', '-i', 'sine=f=660:d=6:sample_rate=24000',
        '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-ac', '1', '-b:a', '64k', '-output_ts_offset', '6', '-f', 'mpegts', b]);
    const joined = path.join(dir, 'joined.ts');
    fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(a), fs.readFileSync(b)]));
    return joined;
}

test('audio that changes mid-programme survives a TS capture and the real preparation (0203)', { skip: skipReason }, async () => {
    const provider = changingAudioTs();
    // The capture, as spawnPart records it now: MPEG-TS, stream copy.
    const capture = path.join(dir, 'capture.ts');
    ff(['-i', provider, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'mpegts', capture]);
    assert.equal(audioDecodeErrors(capture), 0, 'the TS capture keeps each frame\'s own audio header');
    const out = path.join(dir, 'changing.native.mp4');
    const codecs = await engine.probeCodecs(capture);
    const result = await engine._nativeTools.ffmpeg(engine.buildNativeRemuxArgs(capture, out, codecs));
    assert.equal(result.code, 0, result.tail.join('\n'));
    assert.equal(audioDecodeErrors(out), 0, 'the prepared MP4 decodes cleanly');
    assert.ok(meanVolume(out, 7, 4) > -30, 'and the second half still has its sound, not silence');
});

test('control: the old Matroska capture loses that audio, which is why captures are TS now', { skip: skipReason }, () => {
    const provider = changingAudioTs();
    const mkv = path.join(dir, 'capture.mkv');
    ff(['-i', provider, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'matroska', mkv]);
    assert.ok(audioDecodeErrors(mkv) > 50, 'one audio config for the whole file: the second half does not decode');
});
