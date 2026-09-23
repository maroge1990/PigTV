const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0115 (roadmap S1.2): every session whose probe gives a usable frame rate is handed out
// through a master playlist carrying FRAME-RATE and VIDEO-RANGE. Apple TV's Match Frame
// Rate can only switch the TV to 50 Hz for 25/50 fps channels when a master playlist
// declares FRAME-RATE; before this only HDR copy sessions had one (0100), so every SDR
// channel (the provider's 25 fps H.264 ones included) played at the TV's 60 Hz.
//
// Sandbox copy of the server, as in hdr-master-playlist.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fpsmaster-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const db = load('db');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// ffprobe's fields for the real captures of 7 Mate Melbourne / 7 Flix Sydney (pos_1165,
// pos_1164): H.264 High, 1920x1080... avg 25/1, r 25/1.
const H264_25 = { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '25/1', r_frame_rate: '25/1', color_transfer: 'bt709' };
const HDR10 = { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', width: 3840, height: 2160,
                avg_frame_rate: '50/1', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020' };
const AAC = { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 };

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const APPLE = { segmentedDelivery: true, hevc: true, fmp4: true };
const WEB = { segmentedDelivery: true, hevc: false, fmp4: true };

let n = 0;
async function resolveWith(video, capabilities = APPLE) {
    const url = `http://provider.invalid/live/u/p/fps-${n++}.ts`;
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
const variant = (options) => transcodeSession.buildMasterPlaylist(options).split('\n').find(l => l.startsWith('#EXT-X-STREAM-INF:'));

test('an SDR 25 fps channel gets a master playlist with FRAME-RATE=25.000 and VIDEO-RANGE=SDR', async () => {
    const r = await resolveWith(H264_25);
    assert.equal(r.decision.url, '/api/transcode/stub/master.m3u8', 'the old code handed out stream.m3u8, so the TV never learned the rate');
    assert.equal(r.options.videoRange, 'SDR');
    const inf = variant(r.options);
    assert.match(inf, /FRAME-RATE=25\.000/);
    assert.match(inf, /VIDEO-RANGE=SDR/);
    assert.match(inf, /RESOLUTION=1920x1080/);
    assert.match(inf, /BANDWIDTH=8000000/);
    assert.ok(!/CODECS=/.test(inf), 'still no CODECS: a wrong one makes AVPlayer refuse the variant');
    assert.match(r.line, /, master playlist \(SDR, 25\.000 fps\)$/);
});

test('the web client gets the same master playlist (hls.js follows it to stream.m3u8)', async () => {
    const r = await resolveWith(H264_25, WEB);
    assert.equal(r.decision.url, '/api/transcode/stub/master.m3u8');
});

test('the rate comes from avg_frame_rate, falling back to r_frame_rate; 0/0 and absurd values are ignored', async () => {
    const fallback = await resolveWith({ ...H264_25, avg_frame_rate: '0/0', r_frame_rate: '50/1' });
    assert.match(variant(fallback.options), /FRAME-RATE=50\.000/);

    const ntsc = await resolveWith({ ...H264_25, avg_frame_rate: '30000/1001' });
    assert.match(variant(ntsc.options), /FRAME-RATE=29\.970/);

    for (const [avg, r] of [['0/0', '0/0'], [undefined, undefined], ['90000/1', '90000/1'], ['0/0', '1200000/1'], ['25/0', '0/1']]) {
        const none = await resolveWith({ ...H264_25, avg_frame_rate: avg, r_frame_rate: r });
        assert.equal(none.decision.url, '/api/transcode/stub/stream.m3u8', `no usable rate (${avg}, ${r}): the media playlist, as before`);
        assert.equal(none.options.videoRange, null);
    }
});

test('HDR copy sessions are unchanged: PQ, and the HDR log line', async () => {
    const r = await resolveWith(HDR10);
    assert.equal(r.decision.url, '/api/transcode/stub/master.m3u8');
    assert.equal(r.options.videoRange, 'PQ');
    assert.match(variant(r.options), /FRAME-RATE=50\.000,VIDEO-RANGE=PQ/);
    assert.match(r.line, /, HDR PQ - master playlist$/);
});

test('an HDR source copied into MPEG-TS gets no master playlist: it must never be declared SDR', async () => {
    const r = await resolveWith(HDR10, { segmentedDelivery: true, hevc: true, fmp4: false });
    assert.equal(r.options.videoMode, 'copy');
    assert.equal(r.options.segmentType, 'mpegts');
    assert.equal(r.options.videoRange, null);
    assert.equal(r.decision.url, '/api/transcode/stub/stream.m3u8');
});

test('an encode is SDR, and leaves RESOLUTION out (its output size is not the source\'s)', async () => {
    const r = await resolveWith(HDR10, WEB);
    assert.equal(r.options.videoMode, 'encode');
    assert.equal(r.options.videoRange, 'SDR');
    const inf = variant(r.options);
    assert.match(inf, /FRAME-RATE=50\.000/);
    assert.match(inf, /VIDEO-RANGE=SDR/);
    assert.ok(!/RESOLUTION=/.test(inf));
});

test('an SDR session serves its master playlist from the route, token carried to the variant', async () => {
    const s = await transcodeSession.createSession('http://provider.invalid/z.ts', { videoRange: 'SDR', width: 1920, height: 1080, fps: '25/1' });
    try {
        const master = s.getMasterPlaylist();
        assert.match(master, /FRAME-RATE=25\.000,VIDEO-RANGE=SDR/);
        const router = load('routes/transcode');
        const layer = router.stack.find(l => l.route && l.route.path === '/:sessionId/master.m3u8');
        const res = { headers: {}, code: 200, body: null,
            setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
            send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
        layer.route.stack[0].handle({ params: { sessionId: s.id }, query: { token: 'T0K' } }, res);
        assert.equal(res.code, 200);
        assert.ok(res.body.split('\n').includes('stream.m3u8?token=T0K'));
    } finally {
        await transcodeSession.removeSession(s.id);
    }
});
