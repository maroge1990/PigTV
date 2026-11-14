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
// newest key frame (behind a copy of the PAT and PMT), the first segment's audio and video start together.
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

/**
 * Join an 8 s H.264 + AAC feed (a key frame every 2 s exactly, no scene cuts) 3.0 s in - one second
 * after the key frame at 2 s - and run the joiner through a copy session: the first segment's first
 * audio and video PTS. `mux` is extra mpegts muxer arguments; `seconds`, `gop` (frames at 25 a
 * second) and `joinMs` change the feed and when the joiner comes.
 */
async function joinedStarts(mux, port, { seconds = 8, gop = 50, joinMs = 3000 } = {}) {
    const SECONDS = seconds;
    const work = fs.mkdtempSync(path.join(sandbox, 'work-'));
    const source = path.join(work, 'feed.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'veryfast', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', ...mux, '-f', 'mpegts', source], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);

    ingest.tuning.reconnectMs = 1000; // the file ends: every reader ends soon after
    const { server, base, started } = await pacedServer(source, SECONDS);
    try {
        const url = `${base}/feed.ts`;
        const opener = await ingest.subscribe({ pool: port, url, userAgent: 'test', purpose: 'viewer' });
        opener.resume();
        while (!started.get('/feed.ts') || Date.now() - started.get('/feed.ts') < joinMs) await sleep(20);
        const viewer = await ingest.subscribe({ pool: port, url, userAgent: 'test', purpose: 'viewer' });
        const outDir = fs.mkdtempSync(path.join(work, 'joined-'));
        const stderr = await runFed(viewer, await copySessionArgs(transcodeSession, outDir), outDir);
        opener.leave();
        assert.ok(fs.existsSync(path.join(outDir, 'seg0000.m4s')), `a first segment was written\n${stderr}`);
        const starts = firstSegmentStarts(outDir);
        assert.ok(starts.audio !== null && starts.video !== null, `both streams in the first segment (audio ${starts.audio}, video ${starts.video})`);
        return { ...starts, stderr, backlog: viewer.backlogBytes };
    } finally {
        server.closeAllConnections?.();
        server.close();
        fs.rmSync(work, { recursive: true, force: true });
    }
}

test('a viewer joining a running feed mid-GOP gets a first segment whose audio and video start within 100 ms',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        // One AAC frame per PES: the join alone decides where sound starts.
        const { audio, video } = await joinedStarts(['-pes_payload_size', '0'], 'sync');
        assert.ok(Math.abs(video - audio) <= 0.1, `audio ${audio.toFixed(3)} s and video ${video.toFixed(3)} s start together`);
    });

test('the same with ffmpeg\'s default muxing (several AAC frames per PES): sound leads by no more than the muxer puts it',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        // ffmpeg's muxer gathers ~2930 B of AAC per PES (0.24 s at 96k) and writes each PES whole when
        // it is full: the one holding the sound from 1.771 s to the key frame at 2.000 s is written just
        // after the key frame, so it reaches every reader that starts at the key frame, a new connection
        // too. Measured 0.229 s on this stream (0578 the same; 0577: 1.077 s). The join cannot drop it
        // without rewriting packets.
        const { audio, video, stderr } = await joinedStarts([], 'sync-default');
        assert.ok(Math.abs(video - audio) <= 0.25, `audio ${audio.toFixed(3)} s and video ${video.toFixed(3)} s: no more apart than the muxer's PES`);
        assert.doesNotMatch(stderr, /error|corrupt|continuity/i, 'the copy session reports nothing about the join');
    });

test('#309: a 30 Mb/s feed with a key frame every 4 s, joined 2.8 s after one, still starts on the key frame (T2)',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        // About 10.5 MB from the key frame: over half the default 16 MiB slow-reader limit, so 0579 took
        // the old join at the newest PAT and the first segment started with sound and no picture until
        // the next key frame. The backlog is now not counted as lag, and the key-frame join is used up to
        // the limit. The muxer pads the feed with null packets (the bitrate is what the backlog measures);
        // 30 Mb/s and 2.8 s keep the backlog over half the limit with 0.5 s to spare and the join 1.2 s
        // before the next key frame.
        assert.equal(ingest.tuning.slowBytes, 16 * 1024 * 1024, 'the default limit');
        const { audio, video, backlog } = await joinedStarts(['-pes_payload_size', '0', '-muxrate', '30000000'], 'sync-30mbit',
            { seconds: 12, gop: 100, joinMs: 6800 });
        assert.ok(backlog > 8 * 1024 * 1024 && backlog <= 16 * 1024 * 1024, `a key-frame backlog over half the limit (${backlog} B)`);
        assert.ok(Math.abs(video - audio) <= 0.1, `audio ${audio.toFixed(3)} s and video ${video.toFixed(3)} s start together`);
    });
