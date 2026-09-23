const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0118 (roadmap A1.3, contract C-B): the Apple client shows a resolve `error`
// only when it starts with one of three prefixes and holds no URL. Every
// provider/channel failure resolve can return must therefore use that wording,
// and nothing resolve returns may carry a URL.
//
// On the old code: a 404 from ffmpeg said "The provider could not find this
// channel", a 5xx "The provider had a problem serving", a refused connection
// "The provider's server refused", a timeout "Transcode failed to produce a
// playlist in time", a missing channel "Channel pos_x not found", and a failed
// ffprobe returned its stderr - the stream's URL included.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-resolve-errors-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const transcodeSession = load('services/transcodeSession');
const strategy = load('services/playbackStrategy');
const recordingEngine = load('services/recordingEngine');
const db = load('db');
recordingEngine.listActive = () => [];

const ALLOWED = ['The provider refused this channel', 'The provider did not respond', 'This channel is not available'];
const assertShowable = (message, label) => {
    assert.ok(ALLOWED.some(p => message.startsWith(p)), `${label}: "${message}" does not start with an allowed prefix`);
    assert.ok(!message.includes('://'), `${label}: "${message}" carries a URL`);
    assert.ok(!/provider\.invalid|441367|user|pass/.test(message), `${label}: "${message}" leaks the stream address`);
};

const STREAM = 'http://provider.invalid/live/user/pass/441367.ts';
let server, base, token, fakeProbe, source;

function fakeFfprobe(name, stderr) {
    const file = path.join(sandbox, name);
    fs.writeFileSync(file, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exit(1);\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

async function resolve(body) {
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ capabilities: { segmentedDelivery: true }, ...body })
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
}

before(async () => {
    token = jwt.sign({ id: 1, username: 'owner', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const app = express();
    app.use(express.json());
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    fakeProbe = app;
});

after(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    server?.closeAllConnections?.();
    server?.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('every reason ffmpeg can give starts with an allowed prefix and holds no URL', () => {
    const tails = {
        '403': [`[http @ 0x1] ${STREAM}: Server returned 403 Forbidden (access denied)`],
        '4XX': ['Error opening input: Server returned 4XX Client Error, but not one of 40{0,1,3,4}'],
        '404': [`Error opening input files: Server returned 404 Not Found`],
        '5XX': ['Error opening input files: Server returned 5XX Server Error reply'],
        refused: ['[tcp @ 0x1] Connection to tcp://provider.invalid:80 failed: Connection refused']
    };
    for (const [label, tail] of Object.entries(tails)) {
        const reason = transcodeSession.classifyInputFailure(tail);
        assert.ok(reason, label);
        assertShowable(reason.message, label);
    }
    assert.match(transcodeSession.classifyInputFailure(tails['404']).message, /^This channel is not available.*HTTP 404/);
    assert.match(transcodeSession.classifyInputFailure(tails['5XX']).message, /^The provider refused this channel \(HTTP 5xx\)/);
    assert.match(transcodeSession.classifyInputFailure(tails.refused).message, /^The provider did not respond \(connection refused\)/);
});

// A session that never produces a playlist, without spawning anything.
function stubSession({ ended }) {
    const realCreate = transcodeSession.createSession;
    transcodeSession.createSession = async () => ({
        id: `stub-${ended}`,
        stderrTail: ['Some unrecognised ffmpeg complaint about http://provider.invalid/live/user/pass/441367.ts'],
        timings: ended ? { endedEarly: Date.now() } : {},
        start: async () => {},
        waitForPlaylist: async () => false,
        failureReason: () => null
    });
    return () => { transcodeSession.createSession = realCreate; };
}
function primeProbe(settings) {
    const caps = { ...strategy.DEFAULT_CAPABILITIES, segmentedDelivery: true };
    const { probeCache, analyzeProbeResult } = load('services/streamProbe');
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
                            { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                  format: { format_name: 'mpegts' } };
    const key = `${STREAM}|${db.getUserAgent(settings) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, STREAM, caps), timestamp: Date.now() });
}

test('no first segment in time, and no clue from ffmpeg: "The provider did not respond in time"', async () => {
    const settings = { userAgentPreset: 'chrome', ffmpegPath: process.execPath };
    primeProbe(settings);
    const restore = stubSession({ ended: false });
    try {
        await assert.rejects(strategy.resolve({ url: STREAM, capabilities: { segmentedDelivery: true }, settings }), err => {
            assert.match(err.message, /^The provider did not respond in time/);
            assertShowable(err.message, 'timeout');
            return true;
        });
    } finally { restore(); }
});

test('ffmpeg ended with no recognisable reason: "This channel is not available right now"', async () => {
    const settings = { userAgentPreset: 'chrome', ffmpegPath: process.execPath };
    primeProbe(settings);
    const restore = stubSession({ ended: true });
    try {
        await assert.rejects(strategy.resolve({ url: STREAM, capabilities: { segmentedDelivery: true }, settings }), err => {
            assert.match(err.message, /^This channel is not available right now/);
            assertShowable(err.message, 'ended');
            return true;
        });
    } finally { restore(); }
});

test('a channel or source that is not in the playlist is 404 "This channel is not available"', async () => {
    for (const body of [{ sourceId: source.id, channelId: 'pos_424242' }, { sourceId: 999, channelId: 'pos_1' }]) {
        const r = await resolve(body);
        assert.equal(r.status, 404);
        assert.match(r.body.error, /^This channel is not available\./);
        assertShowable(r.body.error, JSON.stringify(body));
    }
});

test('a failed probe never hands its stderr (and so the stream URL) to the client', async () => {
    const cases = [
        [`${STREAM}: Server returned 403 Forbidden (access denied)\n`, /^The provider refused this channel \(HTTP 403\)/],
        [`${STREAM}: Server returned 404 Not Found\n`, /^This channel is not available from the provider \(HTTP 404\)/],
        [`${STREAM}: Invalid data found when processing input\n`, /^This channel is not available right now/]
    ];
    const { probeCache } = load('services/streamProbe');
    let i = 0;
    for (const [stderr, want] of cases) {
        probeCache.clear(); // earlier tests primed it; this one must really probe
        fakeProbe.locals.ffprobePath = fakeFfprobe(`ffprobe-${i++}`, stderr);
        const r = await resolve({ url: STREAM });
        assert.equal(r.status, 500);
        assert.match(r.body.error, want);
        assertShowable(r.body.error, stderr.trim());
        assert.ok(!r.text.includes('://'), `no URL anywhere in the response: ${r.text}`);
    }
});

test('a probe timeout says the provider did not respond in time', () => {
    const message = strategy.probeFailureMessage(new Error('Probe timeout'));
    assert.match(message, /^The provider did not respond in time/);
});

test('whatever else reaches the route, a URL in it is removed', () => {
    const { clientSafe } = load('services/playbackErrors');
    const out = clientSafe('Something failed for https://provider.invalid/a/b/c.ts and rtmp://x.invalid/live');
    assert.ok(!out.includes('://'), out);
    assert.match(out, /^Something failed for/);
});
