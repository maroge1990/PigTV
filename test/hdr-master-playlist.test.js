const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// An HDR channel (Sky Sports Main Event UHD, HDR10) never switched the Apple TV into HDR, in
// either player. A capture showed the copy path is not the fault: the fMP4 init segment keeps
// colr/nclx with PQ + BT.2020 and Main 10. What was missing is VIDEO-RANGE, which only a master
// playlist can carry - and the server only ever handed out a media playlist, which Apple's
// players treat as SDR. So an HDR copy session is now fronted by master.m3u8.
//
// Sandbox copy of the server, as in hls-finite-source.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-hdr-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult, classifyVideoRange } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const db = load('db');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// The stream fields ffprobe reported for the real capture (pos_31, 23 Sept 2026).
const HDR10 = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', width: 3840, height: 2160,
                avg_frame_rate: '50/1', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020' };
const SDR = { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '50/1',
              color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' };
const AAC = { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 };

test('the probe names the HDR transfer function, and nothing else', () => {
    assert.equal(classifyVideoRange(HDR10), 'PQ');
    assert.equal(classifyVideoRange({ color_transfer: 'arib-std-b67' }), 'HLG');
    assert.equal(classifyVideoRange(SDR), null);
    assert.equal(classifyVideoRange({}), null, 'an unreported transfer is SDR - never guess HDR');
    assert.equal(classifyVideoRange(undefined), null);
});

test('the master playlist carries VIDEO-RANGE and points at the media playlist', () => {
    const m = transcodeSession.buildMasterPlaylist({ videoRange: 'PQ', width: 3840, height: 2160, fps: '50/1' });
    const lines = m.split('\n');
    assert.equal(lines[0], '#EXTM3U');
    const inf = lines.find(l => l.startsWith('#EXT-X-STREAM-INF:'));
    assert.match(inf, /VIDEO-RANGE=PQ/);
    assert.match(inf, /BANDWIDTH=\d+/, 'BANDWIDTH is required on every variant');
    assert.match(inf, /RESOLUTION=3840x2160/);
    assert.match(inf, /FRAME-RATE=50\.000/);
    assert.ok(!/CODECS=/.test(inf), 'no CODECS: a wrong one makes AVPlayer refuse the variant');
    assert.equal(lines[lines.indexOf(inf) + 1], 'stream.m3u8');
});

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
// What the Apple client asks for.
const APPLE = { segmentedDelivery: true, hevc: true, fmp4: true };

async function resolveWith(video, url, capabilities = APPLE) {
    const caps = { ...strategy.DEFAULT_CAPABILITIES, ...capabilities };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult({ streams: [video, AAC], format: { format_name: 'mpegts' } }, url, caps), timestamp: Date.now() });

    const real = transcodeSession.createSession;
    const seen = {};
    transcodeSession.createSession = async (u, options) => { seen.options = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    let decision;
    try { decision = await strategy.resolve({ url, capabilities, settings: SETTINGS }); }
    finally { console.log = realLog; transcodeSession.createSession = real; }
    return { decision, options: seen.options, line: lines.find(l => l.includes('resolve timing')) };
}

test('an HDR feed copied into fMP4 is handed out through its master playlist', async () => {
    const r = await resolveWith(HDR10, 'http://provider.invalid/live/u/p/950402.ts');
    assert.equal(r.decision.url, '/api/transcode/stub/master.m3u8');
    assert.equal(r.options.videoRange, 'PQ');
    assert.equal(r.options.videoMode, 'copy');
    assert.equal(r.options.segmentType, 'fmp4');
    assert.match(r.line, /, HDR PQ - master playlist$/);
});

test('an SDR feed is unchanged: the media playlist, no range, nothing in the log', async () => {
    const r = await resolveWith(SDR, 'http://provider.invalid/live/u/p/sdr.ts');
    assert.equal(r.decision.url, '/api/transcode/stub/stream.m3u8');
    assert.equal(r.options.videoRange, null);
    assert.ok(!r.line.includes('HDR'));
});

test('an HDR feed the client cannot take as copied HEVC gets no master playlist', async () => {
    // Without hevc the video is re-encoded: the output is not the source's HDR, so claiming PQ would be wrong.
    const r = await resolveWith(HDR10, 'http://provider.invalid/live/u/p/950402-web.ts', { segmentedDelivery: true, hevc: false, fmp4: true });
    assert.equal(r.options.videoMode, 'encode');
    assert.equal(r.options.videoRange, null);
    assert.equal(r.decision.url, '/api/transcode/stub/stream.m3u8');
});

test('only an HDR session has a master playlist, and it carries the stream token to its variant', async () => {
    const hdr = await transcodeSession.createSession('http://provider.invalid/x.ts', { videoRange: 'PQ', width: 3840, height: 2160, fps: '50/1' });
    const sdr = await transcodeSession.createSession('http://provider.invalid/y.ts', {});
    try {
        assert.match(hdr.getMasterPlaylist(), /VIDEO-RANGE=PQ/);
        assert.equal(sdr.getMasterPlaylist(), null);

        // The route: served before the segment route's allow-list could 404 it, with ?token= on the variant.
        const router = load('routes/transcode');
        const layer = router.stack.find(l => l.route && l.route.path === '/:sessionId/master.m3u8');
        assert.ok(layer, 'GET /:sessionId/master.m3u8 exists');
        const segIdx = router.stack.findIndex(l => l.route && l.route.path === '/:sessionId/:segment');
        assert.ok(router.stack.indexOf(layer) < segIdx, 'and is registered before the segment route');

        const res = { headers: {}, code: 200, body: null,
            setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
            send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
        layer.route.stack[0].handle({ params: { sessionId: hdr.id }, query: { token: 'T0K' } }, res);
        assert.equal(res.code, 200);
        assert.equal(res.headers['Content-Type'], 'application/vnd.apple.mpegurl');
        assert.ok(res.body.split('\n').includes('stream.m3u8?token=T0K'));

        const miss = { ...res, code: 200, body: null };
        layer.route.stack[0].handle({ params: { sessionId: sdr.id }, query: {} }, miss);
        assert.equal(miss.code, 404, 'an SDR session has no master playlist');
    } finally {
        await transcodeSession.removeSession(hdr.id);
        await transcodeSession.removeSession(sdr.id);
    }
});
