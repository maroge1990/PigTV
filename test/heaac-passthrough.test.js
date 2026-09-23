const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0116: HE-AAC is copied, not re-encoded, for a client that says it can decode it
// (capability `heaac`). Chrome cannot (see streamProbe's HE-AAC note), so it stays
// false by default and the web never sends it; AVPlayer decodes HE-AAC natively, and
// the Apple client will send `heaac: true` once a device check has passed.
//
// The provider's 7 channels (7 Flix Sydney 441372, 7 Mate Melbourne 441367; samples
// pos_1164/pos_1165) are H.264 + HE-AAC stereo 48 kHz: today every one of them has its
// audio re-encoded to AAC-LC and goes out as MPEG-TS.
//
// Sandbox copy of the server, as in audio-encode.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-heaac-'));
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

// ffprobe's fields for pos_1165 (7 Mate Melbourne).
const H264 = { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '25/1' };
const HEVC = { ...H264, codec_name: 'hevc', profile: 'Main' };
const HE_AAC = { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2, sample_rate: '48000' };
const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const APPLE = { segmentedDelivery: true, hevc: true, fmp4: true };

let n = 0;
async function resolveArgs(capabilities, { video = H264, audioEncode = false } = {}) {
    const url = `http://provider.invalid/live/u/p/heaac-${n++}.ts`;
    const caps = { ...strategy.DEFAULT_CAPABILITIES, ...capabilities };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult({ streams: [video, HE_AAC], format: { format_name: 'mpegts' } }, url, caps), timestamp: Date.now() });

    const real = transcodeSession.createSession;
    const seen = {};
    transcodeSession.createSession = async (u, options) => { seen.options = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    const realLog = console.log;
    console.log = () => {};
    try {
        const decision = await strategy.resolve({ url, capabilities, settings: SETTINGS, audioEncode });
        // The session's own argument builder, with the options resolve passed it.
        const args = new TranscodeSession(url, seen.options).buildFFmpegArgs();
        return { decision, options: seen.options, args, audio: args.slice(args.indexOf('-c:a')).join(' ') };
    } finally {
        console.log = realLog;
        transcodeSession.createSession = real;
    }
}

test('heaac is a known capability, off unless the client says so', () => {
    assert.equal(strategy.DEFAULT_CAPABILITIES.heaac, false);
});

test('the probe counts HE-AAC as decodable only for a client that says heaac: true', () => {
    const probe = { streams: [H264, HE_AAC], format: { format_name: 'mpegts' } };
    assert.equal(analyzeProbeResult(probe, 'http://p/1.ts', {}).audioOk, false);
    assert.equal(analyzeProbeResult(probe, 'http://p/1.ts', { heaac: false }).audioOk, false);
    assert.equal(analyzeProbeResult(probe, 'http://p/1.ts', { heaac: 'yes' }).audioOk, false, 'only a real true');
    const ok = analyzeProbeResult(probe, 'http://p/1.ts', { heaac: true });
    assert.equal(ok.audioOk, true);
    assert.equal(ok.isHeAac, true, 'still reported as HE-AAC');
});

test('heaac: true -> the audio is copied into fMP4, with aac_adtstoasc, on the codecs-fine path', async () => {
    const r = await resolveArgs({ ...APPLE, heaac: true });
    assert.equal(r.options.videoMode, 'copy');
    assert.equal(r.options.audioMode, 'copy');
    assert.equal(r.options.segmentType, 'fmp4');
    assert.match(r.audio, /^-c:a copy -bsf:a aac_adtstoasc /, 'the old code re-encoded to AAC-LC for every client');
    assert.ok(!r.args.includes('aac_low'));
    assert.match(r.decision.reason, /Codecs are fine/);
});

test('heaac false or absent -> re-encoded to AAC-LC as today (MPEG-TS, video copied)', async () => {
    for (const caps of [APPLE, { ...APPLE, heaac: false }, { segmentedDelivery: true, hevc: false, fmp4: true }]) {
        const r = await resolveArgs(caps);
        assert.equal(r.options.segmentType, 'mpegts', JSON.stringify(caps));
        assert.equal(r.options.audioMode, undefined);
        assert.match(r.audio, /^-c:a aac -profile:a aac_low -ar 48000 -b:a 128k /);
    }
});

test('an explicit audioEncode still re-encodes HE-AAC to AAC-LC, even for a heaac client', async () => {
    const r = await resolveArgs({ ...APPLE, heaac: true }, { audioEncode: true });
    assert.equal(r.options.audioMode, 'encode');
    assert.match(r.audio, /^-c:a aac -profile:a aac_low /);
});

test('heaac with the video re-encoded: the audio is still copied (into MPEG-TS, so no ADTS conversion)', async () => {
    const r = await resolveArgs({ segmentedDelivery: true, hevc: false, fmp4: true, heaac: true }, { video: HEVC });
    assert.equal(r.options.videoMode, 'encode');
    assert.equal(r.options.segmentType, 'mpegts');
    assert.match(r.audio, /^-c:a copy /);
    assert.ok(!r.args.includes('aac_adtstoasc'));
});

test('the capability key keeps heaac and non-heaac clients apart (a separate probe cache entry and profile)', async () => {
    const a = await resolveArgs(APPLE);
    const b = await resolveArgs({ ...APPLE, heaac: true });
    assert.notEqual(a.options.segmentType, b.options.segmentType);
});

test('the web player never sends heaac', () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');
    assert.ok(!/heaac/i.test(src.replace(/HE-AAC/g, '')));
});
