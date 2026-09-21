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
//
// 0085 put igndts on every stream-copy session. Measured against four real captures
// that turned out to be wrong for three of them: a feed with a good clock comes out
// WORSE, because ffmpeg throws the clock away and re-derives it imperfectly. The flag
// is now chosen per feed from the probe (streamProbe.classifyTimestamps).

test('a copy session whose source timing is uneven has ffmpeg rebuild DTS from PTS order', async () => {
    for (const segmentType of ['fmp4', 'mpegts']) {
        const args = await sessionArgs({ segmentType, dtsUneven: true });
        assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt+igndts', segmentType);
        assert.ok(args.indexOf('-fflags') < args.indexOf('-i'), 'before -i: it is an input option');
    }
});

test('a copy session whose source timing is even keeps the source DTS', async () => {
    for (const segmentType of ['fmp4', 'mpegts']) {
        const args = await sessionArgs({ segmentType, dtsUneven: false });
        assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt', segmentType);
    }
});

test('an unclassifiable source keeps its DTS too - the probe said nothing, so nothing is thrown away', async () => {
    for (const dtsUneven of [null, undefined]) {
        const args = await sessionArgs({ segmentType: 'fmp4', dtsUneven });
        assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt', String(dtsUneven));
    }
});

test('a re-encoding session is left as it was - the encoder makes its own timestamps', async () => {
    for (const dtsUneven of [true, false]) {
        const args = await sessionArgs({ videoMode: 'encode', hwEncoder: 'software', dtsUneven });
        assert.equal(optionValue(args, '-fflags'), '+genpts+discardcorrupt');
    }
});

// ---- the behaviour, on real streams with and without the fault ----

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function makeCleanStream(dir) {
    const clean = path.join(dir, 'clean.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '100', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', clean], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    return clean;
}

// The uneven feed, built the way a real one arises: rewrite the timestamps so every
// fifth packet repeats the previous DTS, then write that back out through the mpegts
// muxer, which bumps each repeat by +1 rather than fixing it. What comes out has
// strictly increasing DTS with near-zero steps - exactly the shape measured on
// Fox Sports 505 (a third of steps ~1 tick, each followed by a double).
function makeUnevenStream(dir, clean) {
    const broken = path.join(dir, 'uneven.ts');
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
// Microseconds, because a 59.94 fps period rounded to whole milliseconds alternates
// 16/17 for a perfectly even stream.
function videoDtsSteps(dir) {
    const joined = path.join(dir, 'all.mp4');
    const parts = ['init.mp4', ...fs.readdirSync(dir).filter((f) => f.endsWith('.m4s')).sort()];
    fs.writeFileSync(joined, Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f)))));
    const csv = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', joined],
        { encoding: 'utf8' });
    const dts = csv.split(/\r?\n/).filter(Boolean).map((l) => Number(l.split(',')[0])).filter(Number.isFinite);
    const steps = dts.slice(1).map((d, i) => Math.round((d - dts[i]) * 1e6));
    const mean = steps.reduce((t, s) => t + s, 0) / steps.length;
    return { packets: dts.length, steps, mean, outliers: steps.filter((s) => Math.abs(s - mean) > 1000).length };
}

async function segmentsFor(input, outDir, dtsUneven) {
    const args = await sessionArgs({ segmentType: 'fmp4', audioMode: 'copy', audioCodec: 'aac', videoCodec: 'h264', dtsUneven });
    const run = runSession(args, input, outDir);
    assert.equal(run.status, 0, run.stderr);
    return videoDtsSteps(outDir);
}

test('an uneven source needs the rebuild: without it the frames come out unevenly timed',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copydts-uneven-'));
        try {
            const input = makeUnevenStream(work, makeCleanStream(work));
            const on = path.join(work, 'on'); fs.mkdirSync(on);
            const off = path.join(work, 'off'); fs.mkdirSync(off);

            const rebuilt = await segmentsFor(input, on, true);
            const kept = await segmentsFor(input, off, false);

            assert.equal(rebuilt.packets, kept.packets, 'no video packets are lost either way');
            assert.ok(kept.outliers > kept.steps.length / 20,
                `keeping this source's DTS does reproduce the uneven timing (${kept.outliers} of ${kept.steps.length} steps)`);
            assert.equal(rebuilt.outliers, 0, `rebuilding it makes every frame one step long (${rebuilt.outliers} outliers)`);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });

test('an even source must be left alone: rebuilding its DTS is what makes it judder',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        // The case 0085 missed, and the reason this is decided per feed. Reintroducing
        // 0085's unconditional igndts fails here.
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copydts-even-'));
        try {
            const input = makeCleanStream(work);
            const on = path.join(work, 'on'); fs.mkdirSync(on);
            const off = path.join(work, 'off'); fs.mkdirSync(off);

            const kept = await segmentsFor(input, off, false);
            const rebuilt = await segmentsFor(input, on, true);

            assert.equal(kept.outliers, 0, `keeping a good clock gives even frames (${kept.outliers} outliers)`);
            assert.ok(rebuilt.outliers >= kept.outliers,
                'and rebuilding it is never better - it is what 0085 did to every feed');
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
