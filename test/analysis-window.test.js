const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #240: a channel whose stored profile (channel_profiles, 0114) already says what it carries starts with
// a shorter ffmpeg analysis window; a start that fails with it runs once more with the full window, and a
// channel that needed that keeps the full window in its profile (`fullWindow`). A fresh probe's start,
// and every start before #240, use the full 5 MB / 5 s.
//
// Sandbox copy of the server, as in channel-profiles.test.js; ffmpeg is played by node, as in start-failure.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-window-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const streamProbe = load('services/streamProbe');
let probeCalls = 0;
const RAW = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '50/1' },
                        { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
              format: { format_name: 'mpegts' }, packets: [] };
streamProbe.probeStream = async () => { probeCalls++; return JSON.parse(JSON.stringify(RAW)); };

const strategy = load('services/playbackStrategy');
const transcodeSession = load('services/transcodeSession');
const { getDb } = load('db/sqlite');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const WEB = { segmentedDelivery: true };
const URL_ = 'http://provider.invalid/live/user/secret/441367.ts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quietly(fn) {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const keep = (...a) => { lines.push(a.join(' ')); };
    console.log = keep; console.warn = keep; console.error = keep;
    try { return { result: await fn(), lines }; } finally { Object.assign(console, real); }
}

// ---- (a) the resolve: which window a start asks for, and what a fallback leaves in the profile ----

// A stub session per start: `ready` and whether it fell back to the full window (what TranscodeSession reports).
let created = [];
let nextSession = { ready: true, fellBack: false };
const realCreate = transcodeSession.createSession;
const realRemove = transcodeSession.removeSession;
function stubSessions() {
    transcodeSession.createSession = async (url, options) => {
        created.push(options);
        const { ready, fellBack } = nextSession;
        return { id: 'stub', start: async () => {}, waitForPlaylist: async () => ready, analysisWindowFellBack: fellBack };
    };
    transcodeSession.removeSession = async () => {};
}
function realSessions() { transcodeSession.createSession = realCreate; transcodeSession.removeSession = realRemove; }

beforeEach(() => {
    probeCalls = 0;
    created = [];
    nextSession = { ready: true, fellBack: false };
    streamProbe.probeCache.clear();
    getDb().prepare('DELETE FROM channel_profiles').run();
});

async function play() {
    stubSessions();
    try {
        const { result, lines } = await quietly(async () => {
            try { return { decision: await strategy.resolve({ url: URL_, capabilities: WEB, settings: SETTINGS }) }; }
            catch (error) { return { error }; }
        });
        return { ...result, timing: lines.find(l => l.includes('resolve timing')) };
    } finally { realSessions(); }
}
const laterOn = () => streamProbe.probeCache.clear(); // a repeat play after the 5-minute in-memory cache
const row = () => getDb().prepare('SELECT info, probed_at FROM channel_profiles').get();

test('a fresh probe starts with the full window; a repeat play from the profile with the short one', async () => {
    const first = await play();
    assert.equal(created[0].analysisWindow, 'full');
    assert.doesNotMatch(first.timing, /analysis window/);

    laterOn();
    const second = await play();
    assert.equal(probeCalls, 1, 'the second play came from the profile');
    assert.equal(created[1].analysisWindow, 'short', 'before #240 a profiled start ran ffmpeg\'s full 5 s analysis');
    assert.match(second.timing, /probe profile \(age 0d\), first segment after [\d.]+s, analysis window short/);
});

test('a profiled start whose short window failed and full window played keeps the full window from then on', async () => {
    await play();
    const probedAt = row().probed_at;
    laterOn();
    nextSession = { ready: true, fellBack: true };
    const fellBack = await play();
    assert.ok(fellBack.decision, 'it played');
    assert.match(fellBack.timing, /analysis window full after the short one failed/);
    assert.equal(JSON.parse(row().info).fullWindow, true, 'the profile is marked');
    assert.equal(row().probed_at, probedAt, 'the analysis held: its age is kept');
    assert.equal(fellBack.decision.info.fullWindow, undefined, 'the mark is the server\'s, never in the client\'s info');

    // The next start, from the in-memory copy and then from the stored profile, asks for the full window.
    nextSession = { ready: true, fellBack: false };
    const fromMemory = await play();
    assert.equal(created[2].analysisWindow, 'full');
    assert.doesNotMatch(fromMemory.timing, /analysis window/);
    laterOn();
    const fromProfile = await play();
    assert.equal(probeCalls, 1, 'still no probe');
    assert.equal(created[3].analysisWindow, 'full');
    assert.equal(fromProfile.decision.info.fullWindow, undefined);
});

test('a profiled start that fails with both windows still deletes the profile (0114)', async () => {
    await play();
    laterOn();
    nextSession = { ready: false, fellBack: true };
    const failed = await play();
    assert.ok(failed.error, 'it failed');
    assert.equal(row(), undefined, 'the profile is gone: the next play probes afresh');
    laterOn();
    nextSession = { ready: true, fellBack: false };
    await play();
    assert.equal(probeCalls, 2);
    assert.equal(created[2].analysisWindow, 'full');
});

// ---- (b) the session: the arguments, and the one retry with the full window ----

test('the short window shortens -analyzeduration only; the byte limit and the default are unchanged', async () => {
    const args = (o) => new transcodeSession.TranscodeSession(URL_, { videoMode: 'copy', ...o }).buildSourceArgs(); // the input half: the output half names the session folder
    const at = (a, flag) => a[a.indexOf(flag) + 1];
    const full = args({});
    assert.equal(at(full, '-probesize'), '5000000');
    assert.equal(at(full, '-analyzeduration'), '5000000');
    assert.deepEqual(args({ analysisWindow: 'full' }), full);
    const short = args({ analysisWindow: 'short' });
    assert.equal(at(short, '-probesize'), '5000000');
    assert.equal(at(short, '-analyzeduration'), transcodeSession.ANALYZE_US.short);
    assert.ok(Number(transcodeSession.ANALYZE_US.short) < 5000000);
    // Nothing else moves.
    assert.deepEqual(short.filter((a, i) => short[i - 1] !== '-analyzeduration'), full.filter((a, i) => full[i - 1] !== '-analyzeduration'));
});

// What ffmpeg says when its analysis ended before it saw a key frame (a join mid-GOP; captured on the
// Fox Footy sample with a 1 s window): no picture size, so the muxer cannot write its header.
const NO_PARAMS = [
    '[mpegts @ 0x5975] Could not find codec parameters for stream 0 (Video: h264 ([27][0][0][0] / 0x001B), none): unspecified size',
    'Consider increasing the value for the \'analyzeduration\' (2000000) and \'probesize\' (5000000) options',
    '[mp4 @ 0x5975] dimensions not set',
    '[out#0/hls @ 0x5975] Could not write header (incorrect codec parameters ?): Invalid argument'
].map(l => `process.stderr.write(${JSON.stringify(l + '\n')});`).join(' ');
const PRODUCES = `require('fs').writeFileSync('stream.m3u8', '#EXTM3U\\n#EXTINF:4,\\nseg0000.m4s\\n'); setInterval(() => {}, 1000);`;
const NOT_FOUND = ['[http @ 0x55d0] HTTP error 404 Not Found', '[in#0 @ 0x55d0] Error opening input: Server returned 404 Not Found']
    .map(l => `process.stderr.write(${JSON.stringify(l + '\n')});`).join(' ');

/** A session whose "ffmpeg" runs `scriptFor(windowArg)`; `windows` lists the -analyzeduration of every start. */
async function fakeSession(scriptFor, options = {}) {
    const s = await transcodeSession.createSession(URL_, { ffmpegPath: process.execPath, live: true, videoMode: 'copy', segmentType: 'fmp4',
        stallMs: 60000, startupMs: 60000, ...options });
    const real = s.buildFFmpegArgs.bind(s);
    s.windows = [];
    s.buildFFmpegArgs = () => {
        const a = real();
        const w = a[a.indexOf('-analyzeduration') + 1];
        s.windows.push(w);
        return ['-e', scriptFor(w)];
    };
    return s;
}
const failsWhenShort = (w) => (w === transcodeSession.ANALYZE_US.short ? `${NO_PARAMS} process.exitCode = 234;` : PRODUCES);

test('a start that ends before its first segment with the short window runs once more with the full one', async () => {
    const s = await fakeSession(failsWhenShort, { analysisWindow: 'short' });
    fs.mkdirSync(s.dir, { recursive: true });
    const { result: ready, lines } = await quietly(async () => {
        await s.start();
        fs.writeFileSync(path.join(s.dir, 'seg0099.m4s'), 'stale');
        return s.waitForPlaylist(15000);
    });
    assert.equal(ready, true, 'the full window played (the old code failed the start here)');
    assert.deepEqual(s.windows, [transcodeSession.ANALYZE_US.short, '5000000']);
    assert.equal(s.analysisWindowFellBack, true);
    assert.ok(lines.some(l => l.includes(`[TranscodeSession ${s.id}] Ended before its first segment with the short analysis window; retrying with the full window`)));
    assert.equal(fs.existsSync(path.join(s.dir, 'seg0099.m4s')), false, 'the folder was cleared before the retry');
    await transcodeSession.removeSession(s.id);
});

test('only once: a feed that fails with the full window too fails the start', async () => {
    const s = await fakeSession(() => `${NO_PARAMS} process.exitCode = 234;`, { analysisWindow: 'short' });
    const { result: ready } = await quietly(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, false);
    assert.deepEqual(s.windows, [transcodeSession.ANALYZE_US.short, '5000000']);
    await sleep(500);
    assert.equal(s.windows.length, 2, 'and nothing restarts it later');
    assert.equal(s.status, 'error');
    await transcodeSession.removeSession(s.id);
});

test('a provider failure is not a window problem: no retry with the full window', async () => {
    const s = await fakeSession(() => `${NOT_FOUND} process.exitCode = 1;`, { analysisWindow: 'short' });
    const { result: ready } = await quietly(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, false);
    assert.deepEqual(s.windows, [transcodeSession.ANALYZE_US.short], 'one start: the 404 is the answer');
    assert.notEqual(s.analysisWindowFellBack, true);
    await transcodeSession.removeSession(s.id);
});

test('a full-window start that fails is not retried (only the short window has a fallback)', async () => {
    const s = await fakeSession(() => `${NO_PARAMS} process.exitCode = 234;`);
    const { result: ready } = await quietly(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, false);
    assert.deepEqual(s.windows, ['5000000']);
    await transcodeSession.removeSession(s.id);
});

test('a session that played is never restarted for its window', async () => {
    // Plays, then ends by itself: a lost session (0174), not a start to retry.
    const script = `require('fs').writeFileSync('stream.m3u8', '#EXTM3U\\n#EXTINF:4,\\nseg0000.m4s\\n'); setTimeout(() => { ${NO_PARAMS} process.exit(234); }, 600);`;
    const s = await fakeSession(() => script, { analysisWindow: 'short' });
    const { result: ready } = await quietly(async () => { await s.start(); const r = await s.waitForPlaylist(15000); await sleep(1200); return r; });
    assert.equal(ready, true);
    assert.equal(s.windows.length, 1);
    await transcodeSession.removeSession(s.id);
});

test('a session stopped while its full-window retry is pending never starts again', async () => {
    let started = 0;
    const s = await fakeSession((w) => { started++; return failsWhenShort(w); }, { analysisWindow: 'short' });
    const realClear = s.clearSegments.bind(s);
    // Hold the retry in its folder-clearing step, and stop the session there (a viewer cancelling).
    let release;
    s.clearSegments = () => new Promise((r) => { release = () => r(realClear()); });
    await quietly(async () => {
        await s.start();
        for (let i = 0; i < 50 && !release; i++) await sleep(50);
        assert.ok(release, 'the retry began');
        await transcodeSession.removeSession(s.id);
        release();
        await sleep(400);
    });
    assert.equal(started, 1, 'no second ffmpeg after the stop');
    assert.equal(transcodeSession.getSession(s.id), undefined, 'and the session is gone from the registry');
});
