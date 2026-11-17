const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #240 end to end, with no rig: the fake provider's real MPEG-TS (scripts/fake-provider.js) through a real
// TranscodeSession and the real ffmpeg, once per analysis window. A profiled start (short window) must give
// the same streams as a fresh one (full window), and its first segment is timed against the full window's.
// Each start reads a channel nobody else is reading, so its generator starts afresh (on a key frame, as a
// new provider connection does). The kept samples' bench is docs/evidence/2026-11-17-start-speed.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-window-start-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const transcodeSession = require(path.join(sandbox, 'server', 'services/transcodeSession'));
const { createFakeProvider } = require('../scripts/fake-provider');

const LOGIN = { user: 'window-user', pass: 'window-pass' };
let fake, base;

before(async () => {
    if (!hasFfmpeg) return;
    fake = createFakeProvider({ profile: 'a', ...LOGIN, channels: 4, quiet: true, maxConnections: 8, lingerMs: 200 });
    base = await fake.listen(0, '127.0.0.1');
});
after(async () => {
    if (fake) await fake.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function quietly(fn) {
    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try { return await fn(); } finally { Object.assign(console, real); }
}

/** One start on `channel` with `analysisWindow`: { ready, firstSegmentMs, streams, windowArg }. */
async function startOn(channel, analysisWindow) {
    const url = `${base}/live/${LOGIN.user}/${LOGIN.pass}/${channel.id}.ts`;
    const s = await transcodeSession.createSession(url, { ffmpegPath: 'ffmpeg', live: true, videoMode: 'copy', segmentType: 'fmp4',
        audioMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, analysisWindow });
    try {
        return await quietly(async () => {
            const args = s.buildFFmpegArgs();
            const t0 = Date.now();
            await s.start();
            const ready = await s.waitForPlaylist(20000);
            const firstSegmentMs = Date.now() - t0;
            const seg = ready ? fs.readdirSync(s.dir).find(f => /^seg\d+\.m4s$/.test(f)) : null;
            let streams = null;
            if (seg) {
                const joined = path.join(sandbox, `joined-${s.id}.mp4`);
                fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(path.join(s.dir, 'init.mp4')), fs.readFileSync(path.join(s.dir, seg))]));
                const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
                    '-of', 'compact=p=0', joined], { encoding: 'utf8' });
                streams = r.stdout.trim();
            }
            return { ready, firstSegmentMs, streams, windowArg: args[args.indexOf('-analyzeduration') + 1] };
        });
    } finally {
        await quietly(() => transcodeSession.removeSession(s.id));
    }
}

test('a profiled start (short window) gives the same streams as a full-window start, and is not slower', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
    const normal = fake.lineup.filter(c => c.kind === 'normal' && !c.uhd).slice(-4);
    assert.equal(normal.length, 4, 'four ordinary channels');
    // Alternating, each on a channel of its own: full, short, full, short.
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push({ window: i % 2 ? 'short' : 'full', ...(await startOn(normal[i], i % 2 ? 'short' : 'full')) });
    for (const r of runs) assert.equal(r.ready, true, `${r.window} produced a playlist`);
    const full = runs.filter(r => r.window === 'full');
    const short = runs.filter(r => r.window === 'short');
    for (const r of full) assert.equal(r.windowArg, '5000000');
    for (const r of short) assert.equal(r.windowArg, transcodeSession.ANALYZE_US.short, 'the short window reached ffmpeg (before #240 every start had 5 s)');
    assert.match(full[0].streams, /codec_type=video/);
    assert.match(full[0].streams, /codec_type=audio/);
    for (const r of [...full, ...short]) assert.equal(r.streams, full[0].streams, 'the same streams and parameters either way');
    const mean = (rs) => rs.reduce((t, r) => t + r.firstSegmentMs, 0) / rs.length;
    // Evidence, not a budget: the gain depends on the feed (see the bench). Not slower, with CI's 1 s margin.
    console.log(`[#240] first segment: full window ${full.map(r => r.firstSegmentMs).join(', ')} ms; short window ${short.map(r => r.firstSegmentMs).join(', ')} ms`);
    assert.ok(mean(short) <= mean(full) + 1000, `short ${mean(short)} ms vs full ${mean(full)} ms`);
});
