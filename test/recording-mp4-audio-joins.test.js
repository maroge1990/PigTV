const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #333: the MP4 made from a segmented recording's parts, with the REAL ffmpeg and the server's own argument builders
// (recordingSegments.captureArgs / stitchArchive, recordingMedia.probeCodecs / buildNativeRemuxArgs). The 16 Nov NFL
// recording's MP4 held ~850,000 AAC packets of < 15 ms at two joins where the audio changed (the channel's, then the
// provider's placeholder's): AVPlayer reads the whole sample table and its sound stopped. A join whose audio changes
// format re-creates ffmpeg's audio filter, and `aresample=first_pts=0` then padded silence from 0 up to the join, all
// of it behind the audio already written, which the muxer "fixed" one tick apart. Skips without ffmpeg.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-mp4-joins-'));
const segments = require('../server/services/recordingSegments');
const media = require('../server/services/recordingMedia');
segments._setWorkRoot(path.join(sandbox, 'work'));

const ff = (args, input) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 1 << 30 });
    assert.equal(r.status, 0, String(r.stderr));
};
/** 20 s of MPEG-TS: H.264 and `audio` (encoder arguments) at `rate` Hz, `channels` channels. */
function source(name, { rate = 48000, channels = 1, audio = ['-c:a', 'aac', '-b:a', '64k'], video = 'testsrc=size=320x180:rate=25' } = {}) {
    const file = path.join(sandbox, name);
    ff(['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', `sine=frequency=500:sample_rate=${rate}`, '-t', '20',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
        ...audio, '-ac', String(channels), '-f', 'mpegts', file]);
    return file;
}
/** One part of a recording, captured with the capture's own arguments (from stdin, as from a shared feed). */
function capturePart(workDir, file) {
    const epoch = segments.nextEpoch(workDir);
    ff(segments.captureArgs({ epochDir: epoch.dir, offsetSec: epoch.offsetSec, feed: true }).slice(1), fs.readFileSync(file));
}
/** The recording's MP4, made as finishAttempt makes it: its arguments and the remux's ffmpeg. */
async function makeMp4(workDir) {
    const stitched = segments.stitchArchive(workDir);
    const codecs = await media.probeCodecs(stitched.file);
    const out = path.join(workDir, 'final.mp4');
    const args = media.buildNativeRemuxArgs(stitched.file, out, codecs);
    ff(args.slice(1));
    return { out, args, stitched };
}
function audioPackets(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=duration_time:stream=codec_name,sample_rate,duration',
        '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 30 });
    const j = JSON.parse(r.stdout);
    const s = j.streams[0];
    return { codec: s.codec_name, rate: Number(s.sample_rate), duration: Number(s.duration), durations: j.packets.map(p => Number(p.duration_time)) };
}

after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ } });

let channel, slate;
before(() => {
    if (!hasFfmpeg) return;
    channel = source('channel.ts');                                                                   // 48 kHz mono
    slate = source('slate.ts', { rate: 44100, channels: 2, video: 'color=c=0x203040:size=320x180:rate=25' }); // the placeholder's audio differs
});

test('a join where the audio changes format makes an MP4 with one audio packet per AAC frame, none under 10 ms', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const workDir = path.join(sandbox, 'work', 'rec-1');
    capturePart(workDir, channel);
    capturePart(workDir, slate);
    capturePart(workDir, channel);
    const { out, stitched } = await makeMp4(workDir);
    const a = audioPackets(out);
    assert.equal(a.codec, 'aac');
    const frames = a.duration * a.rate / 1024;
    assert.ok(Math.abs(a.durations.length - frames) / frames < 0.01,
        `${a.durations.length} audio packets for ${a.duration} s (${Math.round(frames)} AAC frames)`);
    assert.ok(Math.abs(a.duration - stitched.durationSec) / stitched.durationSec < 0.01, `audio ${a.duration} s, recording ${stitched.durationSec} s`);
    // The very last packet may be short: the encoder's final frame, trimmed to the end of the audio (as in any encode).
    const tiny = a.durations.slice(0, -1).filter(d => d < 0.010);
    assert.equal(tiny.length, 0, `${tiny.length} audio packets under 10 ms`);
});

test('a clean multi-part recording: AAC is re-encoded as before, AC-3 still copied, both with sane audio', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const ac3 = source('ac3.ts', { audio: ['-c:a', 'ac3', '-b:a', '96k'] });
    for (const [name, file, codec, frameSamples, copied] of [['aac', channel, 'aac', 1024, false], ['ac3', ac3, 'ac3', 1536, true]]) {
        const workDir = path.join(sandbox, 'work', `rec-clean-${name}`);
        for (let i = 0; i < 3; i++) capturePart(workDir, file);
        const { out, args, stitched } = await makeMp4(workDir);
        assert.equal(args.includes('-c:a'), !copied, `${name}: ${copied ? 'copied' : 're-encoded'} as before`);
        assert.equal(args[args.indexOf('-c') + 1], 'copy', 'the video is stream-copied');
        const a = audioPackets(out);
        assert.equal(a.codec, codec);
        const frames = a.duration * a.rate / frameSamples;
        assert.ok(Math.abs(a.durations.length - frames) / frames < 0.01, `${name}: ${a.durations.length} packets for ${Math.round(frames)} frames`);
        assert.ok(Math.abs(a.duration - stitched.durationSec) / stitched.durationSec < 0.01, `${name}: audio ${a.duration} s of ${stitched.durationSec} s`);
        assert.equal(a.durations.slice(0, -1).filter(d => d < 0.010).length, 0, `${name}: no audio packet under 10 ms (but the last)`);
    }
});
