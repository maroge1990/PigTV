const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-audioenc-'));
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

// --- resolve(): the request reaches the HLS session (the remux URL it used to ride on is gone, 0103) ---

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const CAPS = { ...strategy.DEFAULT_CAPABILITIES };

// Seed the probe cache the way a real probe would, so resolve() needs no ffprobe.
function seedProbe(url) {
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                            { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                  format: { format_name: 'mpegts' } };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(CAPS).filter(k => CAPS[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, url, CAPS), timestamp: Date.now() });
}

async function resolveSession(url, extra = {}) {
    seedProbe(url);
    const real = transcodeSession.createSession;
    const seen = {};
    transcodeSession.createSession = async (u, options) => { seen.options = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    const realLog = console.log;
    console.log = () => {};
    try {
        const decision = await strategy.resolve({ url, capabilities: {}, settings: SETTINGS, ...extra });
        return { decision, options: seen.options };
    } finally {
        console.log = realLog;
        transcodeSession.createSession = real;
    }
}

test('a stream whose codecs are fine is an HLS session with both streams copied - never a remux any more', async () => {
    // No segmentedDelivery in the request: it used to be the one thing that got a remux URL back.
    const { decision, options } = await resolveSession('http://provider.invalid/live/u/p/1.ts');
    assert.equal(decision.strategy, 'transcode');
    assert.equal(decision.url, '/api/transcode/stub/stream.m3u8');
    assert.equal(options.videoMode, 'copy');
    assert.equal(options.audioMode, 'copy');
    assert.equal(options.segmentType, 'fmp4', 'fMP4, the container /api/remux used to produce');
});

test('audioEncode asks the session to re-encode the audio, and nothing else', async () => {
    const { decision, options } = await resolveSession('http://provider.invalid/live/u/p/2.ts', { audioEncode: true });
    assert.equal(decision.strategy, 'transcode');
    assert.equal(options.audioMode, 'encode');
    assert.equal(options.videoMode, 'copy', 'the video is still copied');
});

// --- HLS session: 'encode' must beat the "smart copy" shortcuts ---

function sessionArgs(options) {
    const session = new TranscodeSession('http://provider.invalid/live/u/p/3.ts', {
        videoMode: 'copy', segmentType: 'mpegts', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, ...options
    });
    return session.buildFFmpegArgs();
}
const audioCodecArg = (args) => args[args.indexOf('-c:a') + 1];

test('a stereo AAC source is normally copied ("smart copy") in an HLS session', () => {
    assert.equal(audioCodecArg(sessionArgs({ audioMixPreset: 'auto' })), 'copy');
});

test("audioMode 'encode' re-encodes even a stereo AAC source, which is the audio that failed", () => {
    for (const preset of ['auto', 'passthrough']) {
        const args = sessionArgs({ audioMode: 'encode', audioMixPreset: preset });
        assert.equal(audioCodecArg(args), 'aac', `preset ${preset}`);
        assert.ok(args.includes('aresample=async=1') || args.join(' ').includes('aresample=async=1'), 'and conceals damaged frames the way a re-encode does');
    }
});

test("audioMode 'copy' from the strategy is still honoured when nothing asks for a re-encode", () => {
    assert.equal(audioCodecArg(sessionArgs({ audioMode: 'copy', audioMixPreset: 'auto' })), 'copy');
});
