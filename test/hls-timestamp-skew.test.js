const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-skew-'));
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
    return { session, args: session.buildFFmpegArgs() };
};
const optionValue = (args, name) => args[args.indexOf(name) + 1];

// ---- the arguments ----

test('the session raises ffmpeg\'s timestamp-jump threshold, as an input option, to 60 s', async () => {
    const { args } = await sessionArgs();
    assert.equal(transcodeSession.DTS_DELTA_THRESHOLD_SEC, 60);
    assert.equal(optionValue(args, '-dts_delta_threshold'), '60');
    assert.ok(args.indexOf('-dts_delta_threshold') < args.indexOf('-i'),
        'it has to come before -i: it is an input option, and after -i it would apply to the output');
});

test('it is set for a re-encoding session too, not only for copy-video', async () => {
    const { args } = await sessionArgs({ videoMode: 'encode', hwEncoder: 'software' });
    assert.equal(optionValue(args, '-dts_delta_threshold'), '60');
});

test('the value can be tuned with PIGTV_DTS_DELTA_THRESHOLD_SEC, and nonsense falls back to 60', () => {
    const modulePath = path.join(sandbox, 'server/services/transcodeSession');
    const valueWith = (env) => execFileSync(process.execPath, ['-e',
        `console.log(require(${JSON.stringify(modulePath)}).DTS_DELTA_THRESHOLD_SEC)`],
        { cwd: sandbox, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
    assert.equal(valueWith({ PIGTV_DTS_DELTA_THRESHOLD_SEC: '120' }), '120');
    assert.equal(valueWith({ PIGTV_DTS_DELTA_THRESHOLD_SEC: '0' }), '60');
    assert.equal(valueWith({ PIGTV_DTS_DELTA_THRESHOLD_SEC: '-5' }), '60');
    assert.equal(valueWith({ PIGTV_DTS_DELTA_THRESHOLD_SEC: 'soon' }), '60');
    assert.equal(valueWith({ PIGTV_DTS_DELTA_THRESHOLD_SEC: '' }), '60');
});

// ---- the behaviour, on a real stream with the fault ----

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// A transport stream whose video clock runs 23.76 s ahead of its audio clock, as
// in the live log this fixed. ffmpeg's muxers normalise the two back together, so
// the shift is done on the bytes: every video PES timestamp and PCR moves by the
// same amount.
const SKEW_TICKS = Math.round(23.76 * 90000); // 90 kHz clock
const readTs = (b, o) => ((b[o] >> 1) & 0x07) * 1073741824 + b[o + 1] * 4194304 + (b[o + 2] >> 1) * 32768 + b[o + 3] * 128 + (b[o + 4] >> 1);
const writeTs = (b, o, v, marker) => {
    b[o] = (marker << 4) | ((Math.floor(v / 1073741824) & 7) << 1) | 1;
    const lo = v % 1073741824;
    b[o + 1] = (lo >> 22) & 0xff;
    b[o + 2] = (((lo >> 15) & 0x7f) << 1) | 1;
    b[o + 3] = (lo >> 7) & 0xff;
    b[o + 4] = ((lo & 0x7f) << 1) | 1;
};

function makeSkewedStream(dir) {
    const plain = path.join(dir, 'plain.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440,aformat=channel_layouts=5.1',
        '-t', '30', '-c:v', 'libx264', '-g', '50', '-c:a', 'eac3', '-b:a', '384k', '-f', 'mpegts', plain], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);

    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=id,codec_type', '-of', 'json', plain], { encoding: 'utf8' }));
    const videoPid = parseInt(info.streams.find((s) => s.codec_type === 'video').id, 16);

    const buf = Buffer.from(fs.readFileSync(plain));
    for (let i = 0; i + 188 <= buf.length; i += 188) {
        if (buf[i] !== 0x47 || (((buf[i + 1] & 0x1f) << 8) | buf[i + 2]) !== videoPid) continue;
        const payloadStart = (buf[i + 1] & 0x40) !== 0;
        const adaptation = (buf[i + 3] >> 4) & 3;
        let p = i + 4;
        if (adaptation & 2) {
            const len = buf[p];
            if (len >= 7 && (buf[p + 1] & 0x10)) { // a PCR
                const base = buf[p + 2] * 33554432 + buf[p + 3] * 131072 + buf[p + 4] * 512 + buf[p + 5] * 2 + (buf[p + 6] >> 7);
                const moved = base + SKEW_TICKS;
                buf[p + 2] = Math.floor(moved / 33554432) & 0xff;
                buf[p + 3] = Math.floor(moved / 131072) & 0xff;
                buf[p + 4] = Math.floor(moved / 512) & 0xff;
                buf[p + 5] = Math.floor(moved / 2) & 0xff;
                buf[p + 6] = ((moved & 1) << 7) | (buf[p + 6] & 0x7f);
            }
            p += 1 + len;
        }
        if (payloadStart && (adaptation & 1) && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) {
            const flags = buf[p + 7] >> 6; // 2 = PTS, 3 = PTS and DTS
            if (flags & 2) {
                writeTs(buf, p + 9, readTs(buf, p + 9) + SKEW_TICKS, flags === 3 ? 3 : 2);
                if (flags === 3) writeTs(buf, p + 14, readTs(buf, p + 14) + SKEW_TICKS, 1);
            }
        }
    }
    const file = path.join(dir, 'skewed.ts');
    fs.writeFileSync(file, buf);
    return file;
}

// The session's own arguments, pointed at a file instead of the provider URL.
function runSession(args, input, outDir) {
    const a = args.slice();
    for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max']) {
        const i = a.indexOf(flag);
        if (i >= 0) a.splice(i, 2); // these options belong to the http protocol, not to files
    }
    a[a.indexOf(URL_)] = input;
    const at = a.indexOf('-hls_segment_filename');
    a[at + 1] = path.join(outDir, 'seg%04d.ts');
    a[a.length - 1] = path.join(outDir, 'stream.m3u8');
    return spawnSync('ffmpeg', a, { encoding: 'utf8' });
}

const audioPackets = (dir) => Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets',
    '-select_streams', 'a', '-show_entries', 'stream=nb_read_packets', '-of', 'json', path.join(dir, 'stream.m3u8')],
    { encoding: 'utf8' })).streams[0].nb_read_packets);
const jumpMessages = (stderr) => stderr.split('\n').filter((l) => /timestamp discontinuity/.test(l)).length;

test('audio and video that start far apart no longer trigger a discontinuity for every packet',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-skew-run-'));
        try {
            const input = makeSkewedStream(work);
            const { args } = await sessionArgs({ audioMode: 'encode' });
            // igndts (added for stream-copy in 0085) hides this fault on its own - the timestamps
            // it derives no longer jump - so it is taken out to keep testing the threshold itself.
            args[args.indexOf('-fflags') + 1] = '+genpts+discardcorrupt';

            const fixedDir = path.join(work, 'fixed'); fs.mkdirSync(fixedDir);
            const fixed = runSession(args, input, fixedDir);
            assert.equal(fixed.status, 0, fixed.stderr);

            // The same arguments without the flag: what shipped before this change.
            const oldArgs = args.slice();
            oldArgs.splice(oldArgs.indexOf('-dts_delta_threshold'), 2);
            const oldDir = path.join(work, 'old'); fs.mkdirSync(oldDir);
            const before = runSession(oldArgs, input, oldDir);

            assert.equal(jumpMessages(fixed.stderr), 0, 'no discontinuity messages');
            assert.ok(jumpMessages(before.stderr) > 100, `the old arguments do reproduce it (${jumpMessages(before.stderr)} messages)`);
            assert.ok(audioPackets(fixedDir) > audioPackets(oldDir) * 1.3,
                `audio is kept: ${audioPackets(fixedDir)} packets, against ${audioPackets(oldDir)} before`);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
