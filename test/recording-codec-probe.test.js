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
    assert.deepEqual(await engine.probeCodecs(files.h264aac), { video: 'h264', audio: 'aac' });
});

test('probeCodecs reads HEVC + AAC, and the remux args tag it hvc1', { skip: skipReason }, async (t) => {
    if (!files.hevcaac) return t.skip('the libx265 encoder is not available');
    const codecs = await engine.probeCodecs(files.hevcaac);
    assert.deepEqual(codecs, { video: 'hevc', audio: 'aac' });
    const args = engine.buildNativeRemuxArgs('in.mkv', 'out.mp4', codecs);
    assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
});

test('probeCodecs reads H.264 + MP2, and the remux args re-encode the audio to AAC', { skip: skipReason }, async () => {
    const codecs = await engine.probeCodecs(files.h264mp2);
    assert.deepEqual(codecs, { video: 'h264', audio: 'mp2' });
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
    assert.deepEqual(await engine.probeCodecs(out), { video: 'h264', audio: 'aac' });
});
