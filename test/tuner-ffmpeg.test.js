const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 0126: a tuner's real ffmpeg arguments, run by real ffmpeg on a small synthetic
// H.264 + AAC MPEG-TS (lavfi testsrc/sine), the way stream-doctor runs the session's
// arguments against a local file (only the -i value is swapped). Proves the hls
// muxer writes what the server reads: base-name URIs, init.mp4, exact durations,
// and ENDLIST when the source ends. Skipped without ffmpeg.
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tuner-ffmpeg-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const tuner = load('services/tuner');
const hls = load('services/hlsPlaylist');

const source = path.join(sandbox, 'source.ts');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(() => {
    if (!haveFfmpeg) return;
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '13', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
        '-f', 'mpegts', source]);
    assert.equal(made.status, 0, String(made.stderr));
});

after(async () => {
    await tuner.destroyAll('test over');
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

for (const segmentType of ['fmp4', 'mpegts']) {
    test(`real ffmpeg with the tuner's arguments (${segmentType}): the server reads every segment and serves them with dates`,
        { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
            const { tuner: t } = tuner.prepare('http://provider.invalid/live/1.ts', {
                ffmpegPath: 'ffmpeg', videoMode: 'copy', segmentType, videoCodec: 'h264',
                audioCodec: 'aac', audioChannels: 2, audioMode: segmentType === 'fmp4' ? 'copy' : undefined
            });
            // The real arguments, with only the input swapped for the local file.
            tuner.hooks.spawnArgs = (x) => {
                const a = x.buildTunerArgs();
                for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max']) {
                    const i = a.indexOf(flag);
                    if (i >= 0) a.splice(i, 2); // http protocol options, which a file does not take
                }
                a[a.indexOf('-i') + 1] = source;
                return a;
            };
            try {
                tuner.register(t);
                tuner.addViewer(t, {});
                await tuner.start(t);
                assert.equal(await t.waitForPlaylist(15000), true);
                for (let i = 0; i < 100 && !t.ended; i++) { await t.ingest(); await sleep(100); }
                assert.equal(t.ended, true, 'ffmpeg reached the end of the file and said so');

                const ffmpegOwn = hls.parseMediaPlaylist(fs.readFileSync(t.playlistPath, 'utf8'));
                const text = await t.getPlaylist();
                const served = hls.parseMediaPlaylist(text);
                assert.deepEqual(served.segments, ffmpegOwn.segments, 'the same segments, names and durations');
                const total = served.segments.reduce((s, x) => s + x.duration, 0);
                assert.ok(total > 12 && total < 14, `about 13 s in all (${total})`);
                for (const s of served.segments) assert.ok(fs.existsSync(path.join(t.dir, s.name)), `${s.name} is on disk`);
                assert.equal(text.split('\n').filter(l => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).length, served.segments.length);
                assert.match(text, /#EXT-X-ENDLIST\n$/);
                if (segmentType === 'fmp4') {
                    assert.equal(served.map, 'init.mp4');
                    assert.ok(fs.existsSync(path.join(t.dir, 'init.mp4')));
                } else {
                    assert.equal(served.map, null);
                }
            } finally {
                tuner.hooks.spawnArgs = null;
                await tuner.destroyAll('test over');
            }
        });
}
