const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0113: a session whose ffmpeg cannot open the provider's stream fails fast, says why
// in words a viewer can use, and is retried once when the provider refused the first
// connection (it allows one, and may not have let go of the resolve probe's yet).
//
// Mark's log, build 0109, 7 Flix Sydney: ffmpeg logged "Error opening input: Server
// returned 4XX Client Error, but not one of 40{0,1,3,4}" right after the probe's
// connection closed, exited, and resolve still waited out its full 15 s before
// answering "Transcode failed to produce a playlist in time".
//
// Sandbox copy of the server, and ffmpeg played by node running a one-line script, as
// in session-hardening.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-startfail-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const transcodeSession = load('services/transcodeSession');
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const db = load('db');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_ = 'http://provider.invalid/live/u/p/441372.ts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What ffmpeg 6 prints when the provider answers the input request with an HTTP error.
const refusal = (what) => [
    `[http @ 0x55d0] HTTP error ${what.split(' ')[0]}`,
    `[in#0 @ 0x55d0] Error opening input: Server returned ${what}`,
    `Error opening input file ${URL_}.`,
    `Error opening input files: Server returned ${what}`
].map(l => `process.stderr.write(${JSON.stringify(l + '\n')});`).join(' ');
const FORBIDDEN = '403 Forbidden (access denied)';
const OTHER_4XX = '4XX Client Error, but not one of 40{0,1,3,4}';
const NOT_FOUND = '404 Not Found';
const SERVER_5XX = '5XX Server Error reply';

// Writes a playable playlist into its working directory (the session folder) and stays up.
const PRODUCES = `require('fs').writeFileSync('stream.m3u8', '#EXTM3U\\n#EXTINF:4,\\nseg0000.ts\\n'); setInterval(() => {}, 1000);`;

// A script that refuses on its first run and plays on its second: the marker file lives
// outside the session folder, which the retry clears.
function refusesOnceThenPlays(what) {
    const marker = path.join(sandbox, `ran-${Math.random().toString(36).slice(2)}`);
    return `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); ${refusal(what)} process.exitCode = 1; } else { ${PRODUCES} }`;
}

async function fakeSession(script, options = {}) {
    const s = await transcodeSession.createSession(URL_, { ffmpegPath: process.execPath, live: true, videoMode: 'copy', stallMs: 60000, startupMs: 60000, ...options });
    s.buildFFmpegArgs = () => ['-e', script];
    return s;
}
function countStarts(s) {
    let n = 0;
    const real = s.start.bind(s);
    s.start = (...a) => { n++; return real(...a); };
    return () => n;
}
async function captureLogs(fn) {
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const keep = (...a) => { lines.push(a.join(' ')); };
    console.log = keep; console.warn = keep; console.error = keep;
    try { return { result: await fn(), lines }; } finally { Object.assign(console, real); }
}

// ---- (a) fail fast ----

test('waitForPlaylist gives up as soon as ffmpeg has exited without a playlist, not at the timeout', async () => {
    const s = await fakeSession(`${refusal(FORBIDDEN)} process.exitCode = 1;`);
    await s.start();
    const t0 = Date.now();
    const { result: ready } = await captureLogs(() => s.waitForPlaylist(15000));
    const waited = Date.now() - t0;
    assert.equal(ready, false);
    assert.ok(waited < 5000, `answered after ${waited} ms; the old code polled the full 15 s`);
    await transcodeSession.removeSession(s.id);
});

test('a session that does produce its playlist is still reported ready', async () => {
    const s = await fakeSession(PRODUCES);
    await s.start();
    assert.equal(await s.waitForPlaylist(10000), true);
    await transcodeSession.removeSession(s.id);
});

// ---- (b) a reason the viewer can use ----

test('the failure reason names the HTTP status and never the URL or ffmpeg\'s own words', () => {
    const cases = [
        [[`[in#0 @ 0x1] Error opening input: Server returned ${OTHER_4XX}`], /refused this channel \(HTTP 4xx\).*still releasing the previous stream/],
        [[`Error opening input files: Server returned ${FORBIDDEN}`], /refused this channel \(HTTP 403\)/],
        [[`Error opening input files: Server returned ${NOT_FOUND}`], /not available from the provider \(HTTP 404\)/],
        [[`Error opening input files: Server returned ${SERVER_5XX}`], /provider refused this channel \(HTTP 5xx\): its server had a problem/],
        [[`[tcp @ 0x1] Connection to tcp://provider.invalid:80 failed: Connection refused`], /did not respond \(connection refused\)/]
    ];
    for (const [tail, want] of cases) {
        const reason = transcodeSession.classifyInputFailure(tail);
        assert.ok(reason, `no reason for ${tail[0]}`);
        assert.match(reason.message, want);
        assert.ok(!/provider\.invalid|http:\/\/|Error opening|0x/.test(reason.message), `leaks: ${reason.message}`);
    }
    assert.equal(transcodeSession.classifyInputFailure(['Could not write header for output file #0']), null, 'anything else keeps the generic error');
    assert.equal(transcodeSession.classifyInputFailure([]), null);
});

test('resolve answers a refused channel quickly, with that reason, in the same {error, info} shape', async () => {
    const caps = { ...strategy.DEFAULT_CAPABILITIES, segmentedDelivery: true };
    const settings = { userAgentPreset: 'chrome', ffmpegPath: process.execPath };
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
                            { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                  format: { format_name: 'mpegts' } };
    const key = `${URL_}|${db.getUserAgent(settings) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, URL_, caps), timestamp: Date.now() });

    // The real session class, with ffmpeg replaced by a script that is refused a 404 (no retry for that).
    const realCreate = transcodeSession.createSession;
    transcodeSession.createSession = async (u, o) => {
        const s = await realCreate(u, { ...o, ffmpegPath: process.execPath });
        s.buildFFmpegArgs = () => ['-e', `${refusal(NOT_FOUND)} process.exitCode = 1;`];
        return s;
    };
    let failure;
    const t0 = Date.now();
    try {
        const { lines } = await captureLogs(async () => {
            try { await strategy.resolve({ url: URL_, capabilities: { segmentedDelivery: true }, settings }); } catch (err) { failure = err; }
        });
        const waited = Date.now() - t0;
        assert.ok(failure, 'resolve failed');
        assert.ok(waited < 5000, `answered after ${waited} ms, not the 15 s timeout`);
        assert.match(failure.message, /not available from the provider \(HTTP 404\)/);
        assert.ok(!failure.message.includes('provider.invalid'), 'no URL in what the client is shown');
        assert.ok(failure.info && failure.info.video === 'h264', 'info still rides on the error, for the {error, info} body');
        const timing = lines.find(l => l.includes('resolve timing'));
        assert.match(timing, /first segment NOT produced - ffmpeg ended after [\d.]+s \(provider HTTP 404\)/);
    } finally { transcodeSession.createSession = realCreate; }
});

// ---- (c) one retry when the provider refused the first connection ----

test('a 4xx right after the probe gets exactly one retry, after 1.5 s, in a cleared folder', async () => {
    const s = await fakeSession(refusesOnceThenPlays(OTHER_4XX));
    const count = countStarts(s);
    // A leftover from the failed attempt must not survive into the retry.
    fs.mkdirSync(s.dir, { recursive: true });
    const { result: ready, lines } = await captureLogs(async () => {
        await s.start();
        fs.writeFileSync(path.join(s.dir, 'seg0099.ts'), 'stale');
        return s.waitForPlaylist(15000);
    });
    assert.equal(ready, true, 'the retry produced the playlist');
    assert.equal(count(), 2, 'started twice');
    assert.ok(lines.some(l => new RegExp(`\\[TranscodeSession ${s.id}\\] Provider refused the first connection; retrying once in 1\\.5s`).test(l)));
    assert.equal(fs.existsSync(path.join(s.dir, 'seg0099.ts')), false, 'the folder was cleared before the retry');
    await transcodeSession.removeSession(s.id);
});

test('a 5xx is retried the same way', async () => {
    const s = await fakeSession(refusesOnceThenPlays(SERVER_5XX));
    const count = countStarts(s);
    const { result: ready } = await captureLogs(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, true);
    assert.equal(count(), 2);
    await transcodeSession.removeSession(s.id);
});

test('only once: a provider that keeps refusing fails with the reason after the one retry', async () => {
    const s = await fakeSession(`${refusal(FORBIDDEN)} process.exitCode = 1;`);
    const count = countStarts(s);
    const { result: ready } = await captureLogs(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, false);
    assert.equal(count(), 2, 'one retry, no more');
    await sleep(2000);
    assert.equal(count(), 2, 'and nothing restarts it later');
    assert.equal(s.status, 'error');
    assert.match(s.failureReason(), /refused this channel \(HTTP 403\)/);
    await transcodeSession.removeSession(s.id);
});

test('a 404 is not retried: the channel is not there, and asking again will not change that', async () => {
    const s = await fakeSession(`${refusal(NOT_FOUND)} process.exitCode = 1;`);
    const count = countStarts(s);
    const { result: ready } = await captureLogs(async () => { await s.start(); return s.waitForPlaylist(15000); });
    assert.equal(ready, false);
    await sleep(2000);
    assert.equal(count(), 1);
    await transcodeSession.removeSession(s.id);
});

test('a refusal later than the first ~3 s is not retried (that is a feed dropping, not the probe\'s connection)', async () => {
    const s = await fakeSession(`setTimeout(() => { ${refusal(FORBIDDEN)} process.exitCode = 1; }, 3500);`);
    const count = countStarts(s);
    await captureLogs(async () => { await s.start(); return s.waitForPlaylist(15000); });
    await sleep(2000);
    assert.equal(count(), 1);
    await transcodeSession.removeSession(s.id);
});

test('a session removed during the 1.5 s wait is not started again', async () => {
    const s = await fakeSession(`${refusal(FORBIDDEN)} process.exitCode = 1;`);
    const count = countStarts(s);
    await captureLogs(async () => {
        await s.start();
        const end = Date.now() + 5000;
        while (s.process !== null && Date.now() < end) await sleep(20);
        await sleep(300);
        await transcodeSession.removeSession(s.id);
        await sleep(2000);
    });
    assert.equal(count(), 1, 'the retry noticed the session had gone');
    assert.equal(s.process, null);
});
