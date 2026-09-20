const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

// Copy the server so its relative data paths never touch real data (same
// approach as hls-timestamp-skew.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copydts-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const transcodeSession = require(path.join(sandbox, 'server/services/transcodeSession'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_ = 'http://provider.invalid/live/u/p/1.ts';
const sessionArgs = async (options = {}) => {
    const session = await transcodeSession.createSession(URL_, { videoMode: 'copy', ...options });
    return session.buildFFmpegArgs();
};
const optionValue = (args, name) => args[args.indexOf(name) + 1];

// ---- the arguments ----

test('a stream-copy session has ffmpeg derive DTS from PTS order (igndts), as an input option', async () => {
    for (const segmentType of ['fmp4', 'mpegts']) {
        const args = await sessionArgs({ segmentType });
        assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt+igndts', segmentType);
        assert.ok(args.indexOf('-fflags') < args.indexOf('-i'), 'before -i: it is an input option');
    }
});

test('a re-encoding session is left as it was - the encoder makes its own timestamps', async () => {
    const args = await sessionArgs({ videoMode: 'encode', hwEncoder: 'software' });
    assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt');
});

// ---- the behaviour, on a real stream with the fault ----

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// 50 fps H.264 with B-frames whose DTS repeats on every fifth packet - the shape of the
// fault in the live logs ("Non-monotonic DTS ... previous: N, current: N"). The bitstream
// filter rewrites the timestamps only, so it is the provider's clock being wrong, not the video.
function makeRepeatedDtsStream(dir) {
    const clean = path.join(dir, 'clean.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '100', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', clean], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);

    const broken = path.join(dir, 'repeated-dts.ts');
    const rewritten = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', clean, '-c', 'copy',
        '-bsf:v', 'setts=dts=if(eq(mod(N\\,5)\\,0)\\,PREV_OUTDTS\\,DTS)', '-f', 'mpegts', broken], { encoding: 'utf8' });
    assert.equal(rewritten.status, 0, rewritten.stderr);
    return broken;
}

// The session's own arguments, pointed at a file instead of the provider URL.
function runSession(args, input, outDir) {
    const a = args.slice();
    for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max']) {
        const i = a.indexOf(flag);
        if (i >= 0) a.splice(i, 2); // these options belong to the http protocol, not to files
    }
    a[a.indexOf(URL_)] = input;
    a[a.indexOf('-hls_segment_filename') + 1] = path.join(outDir, 'seg%04d.m4s');
    a[a.length - 1] = path.join(outDir, 'stream.m3u8');
    // The server runs ffmpeg with the session folder as its working directory; a relative
    // init.mp4 is written there, so the test does the same.
    return spawnSync('ffmpeg', a, { encoding: 'utf8', cwd: outDir });
}

// The video DTS steps of what a player would be given: init segment + media segments joined up.
function videoDtsSteps(dir) {
    const joined = path.join(dir, 'all.mp4');
    const parts = ['init.mp4', ...fs.readdirSync(dir).filter((f) => f.endsWith('.m4s')).sort()];
    fs.writeFileSync(joined, Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f)))));
    const csv = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', joined],
        { encoding: 'utf8' });
    const dts = csv.split(/\r?\n/).filter(Boolean).map(Number);
    const steps = dts.slice(1).map((d, i) => Math.round((d - dts[i]) * 1000) / 1000);
    return { packets: dts.length, min: Math.min(...steps), max: Math.max(...steps) };
}

test('repeated source DTS no longer becomes uneven frame timing in the HLS segments',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copydts-run-'));
        try {
            const input = makeRepeatedDtsStream(work);
            const args = await sessionArgs({ segmentType: 'fmp4', audioMode: 'copy', audioCodec: 'aac', videoCodec: 'h264' });

            const fixedDir = path.join(work, 'fixed'); fs.mkdirSync(fixedDir);
            const fixed = runSession(args, input, fixedDir);
            assert.equal(fixed.status, 0, fixed.stderr);

            // The same arguments without the flag: what shipped before this change.
            const oldArgs = args.slice();
            oldArgs[oldArgs.indexOf('-fflags') + 1] = '+genpts+discardcorrupt';
            const oldDir = path.join(work, 'old'); fs.mkdirSync(oldDir);
            const before = runSession(oldArgs, input, oldDir);
            assert.equal(before.status, 0, before.stderr);

            const now = videoDtsSteps(fixedDir);
            const then = videoDtsSteps(oldDir);
            assert.equal(now.packets, then.packets, 'no video packets are lost either way');
            assert.ok(then.min < 0.005 && then.max > 0.05, `the old arguments do reproduce it (steps ${then.min}-${then.max} s)`);
            assert.ok(now.max - now.min < 0.001, `every frame is now one step long (${now.min}-${now.max} s)`);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
