const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #322 (Mark, 14 Nov 2026): a play PigTV has to re-encode is made at up to 1080p, medium quality, audio mixed by
// "auto", whatever an older settings page stored (maxResolution, quality, audioMixPreset are retired settings).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fixed-values-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const { TranscodeSession } = transcodeSession;
const db = load('db');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const quietly = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const OLD_STORED = { maxResolution: '4k', quality: 'high', audioMixPreset: 'night' };

function args(options) {
    const s = new TranscodeSession('http://provider.invalid/live/u/p/1.ts', { userAgent: 'UA/1.0', ffmpegPath: 'ffmpeg', ...options });
    s.dir = '/fixed/session-dir';
    s.playlistPath = '/fixed/session-dir/stream.m3u8';
    return quietly(() => s.buildFFmpegArgs());
}

test('a stored resolution, quality or audio mix no longer changes an encode, on any encoder', () => {
    for (const hwEncoder of ['software', 'nvenc', 'qsv', 'amf', 'vaapi']) {
        const base = { segmentType: 'mpegts', videoMode: 'encode', hwEncoder, videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6 };
        for (const old of [OLD_STORED, { maxResolution: '480p', quality: 'low', audioMixPreset: 'cinematic' }]) {
            assert.deepEqual(args({ ...base, ...old }), args(base), `${hwEncoder} ${JSON.stringify(old)}`);
        }
    }
});

test('a stored "passthrough" audio mix no longer copies audio a client did not say it can play', () => {
    const base = { segmentType: 'fmp4', videoMode: 'copy', videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6 };
    assert.deepEqual(args({ ...base, audioMixPreset: 'passthrough' }), args(base));
    const a = args(base);
    assert.equal(a[a.indexOf('-c:a') + 1], 'aac', 'surround is mixed down to stereo AAC');
});

test('the playback strategy hands the session none of the retired transcode settings', async () => {
    const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg', ...OLD_STORED };
    const caps = { ...strategy.DEFAULT_CAPABILITIES };
    const url = 'http://provider.invalid/live/u/p/2.ts';
    const raw = { streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 },
                            { codec_type: 'audio', codec_name: 'ac3', channels: 6 }],
                  format: { format_name: 'mpegts' } };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, url, caps), timestamp: Date.now() });
    const real = transcodeSession.createSession;
    let seen = null;
    transcodeSession.createSession = async (u, options) => { seen = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    try {
        await quietly(() => strategy.resolve({ url, capabilities: {}, settings: SETTINGS }));
    } finally { transcodeSession.createSession = real; }
    assert.ok(seen, 'an HLS session was asked for');
    for (const k of Object.keys(OLD_STORED)) assert.equal(k in seen, false, k);
});

// #322: web upscaling is removed (upscaleEnabled, upscaleMethod, upscaleTarget are retired). It re-encoded every web
// play; now neither a stored switch nor an older page's `upscale: true` forces a re-encode or changes one.
test('a stored upscaling switch no longer changes an encode, on any encoder', () => {
    for (const hwEncoder of ['software', 'nvenc', 'qsv', 'amf', 'vaapi']) {
        const base = { segmentType: 'mpegts', videoMode: 'encode', hwEncoder, videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6 };
        for (const old of [{ upscaleEnabled: true, upscaleTarget: '4k', upscaleMethod: 'software' },
            { upscaleEnabled: true, upscaleTarget: '720p', upscaleMethod: 'hardware' }]) {
            assert.deepEqual(args({ ...base, ...old }), args(base), `${hwEncoder} ${JSON.stringify(old)}`);
        }
    }
});

test('neither a stored upscaling switch nor an upscale request forces a re-encode of a feed the client can play', async () => {
    const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg', upscaleEnabled: true, upscaleTarget: '4k', upscaleMethod: 'software' };
    const caps = { ...strategy.DEFAULT_CAPABILITIES };
    const url = 'http://provider.invalid/live/u/p/3.ts';
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                            { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                  format: { format_name: 'mpegts' } };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, url, caps), timestamp: Date.now() });
    const real = transcodeSession.createSession;
    let seen = null;
    transcodeSession.createSession = async (u, options) => { seen = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    try {
        const decision = await quietly(() => strategy.resolve({ url, capabilities: {}, settings: SETTINGS, upscale: true }));
        assert.equal(decision.videoMode, 'copy', 'the video is copied, not re-encoded');
    } finally { transcodeSession.createSession = real; }
    for (const k of ['upscaleEnabled', 'upscaleMethod', 'upscaleTarget']) assert.equal(k in seen, false, k);
});
