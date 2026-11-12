const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #3 with real ffmpeg: a viewer joining a running shared feed part-way through a group of pictures.
// Its copy session (fMP4, -c copy) copies audio from the first packet and video from the first key
// frame, so a join at an arbitrary PAT started with up to a GOP of sound and no picture - out of step
// for the whole play on AVPlayer (production, 12 Nov: audio 0.000 s, video 1.149 s). Joined at the
// PAT before the newest key frame, the first segment's audio and video start together.
// Sandbox copy of the server (the session writes its folder relative to the working directory).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-joinsync-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const transcodeSession = require(path.join(sandbox, 'server/services/transcodeSession'));
const ingest = require(path.join(sandbox, 'server/services/ingest'));
const { pacedServer, copySessionArgs, runFed, firstSegmentStarts } = require('./helpers/ingestJoin');

after(() => {
    ingest.closeAll('test over');
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a viewer joining a running feed mid-GOP gets a first segment whose audio and video start within 100 ms',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        const SECONDS = 8;
        const work = fs.mkdtempSync(path.join(sandbox, 'work-'));
        const source = path.join(work, 'feed.ts');
        // H.264 + AAC, a key frame every 2 s exactly (no scene cuts), small. One AAC frame per PES: an
        // audio PES that began before the key frame but is muxed after it is the one thing a join at the
        // key frame still lets through (ffmpeg's default groups 0.24 s; the real feed 0.17 s, 83 ms early).
        const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-pes_payload_size', '0', '-f', 'mpegts', source], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);

        ingest.tuning.reconnectMs = 1000; // the file ends: every reader ends soon after
        const { server, base, started } = await pacedServer(source, SECONDS);
        try {
            const url = `${base}/feed.ts`;
            const opener = await ingest.subscribe({ pool: 'sync', url, userAgent: 'test', purpose: 'viewer' });
            opener.resume();
            // 3.0 s in: one second after the key frame at 2 s, one before the next at 4 s.
            while (!started.get('/feed.ts') || Date.now() - started.get('/feed.ts') < 3000) await sleep(20);
            const viewer = await ingest.subscribe({ pool: 'sync', url, userAgent: 'test', purpose: 'viewer' });
            const outDir = fs.mkdtempSync(path.join(work, 'joined-'));
            const stderr = await runFed(viewer, await copySessionArgs(transcodeSession, outDir), outDir);
            opener.leave();
            assert.ok(fs.existsSync(path.join(outDir, 'seg0000.m4s')), `a first segment was written\n${stderr}`);
            const { audio, video } = firstSegmentStarts(outDir);
            assert.ok(audio !== null && video !== null, `both streams in the first segment (audio ${audio}, video ${video})`);
            assert.ok(Math.abs(video - audio) <= 0.1, `audio ${audio.toFixed(3)} s and video ${video.toFixed(3)} s start together`);
        } finally {
            server.closeAllConnections?.();
            server.close();
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
