const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same approach as
// audio-encode.test.js; a junction so it works on Windows without admin rights).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-resolvetiming-'));
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

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };

// Seed the probe cache the way a real probe would, so resolve() needs no ffprobe.
function seedProbe(url, caps, { container = 'mpegts', video = 'h264', audio = 'aac' } = {}) {
    const merged = { ...strategy.DEFAULT_CAPABILITIES, ...caps };
    const raw = { streams: [{ codec_type: 'video', codec_name: video, width: 1280, height: 720 },
                            { codec_type: 'audio', codec_name: audio, profile: 'LC', channels: 2 }],
                  format: { format_name: container } };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(merged).filter(k => merged[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(raw, url, merged), timestamp: Date.now() });
}

async function timingLines(fn) {
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try { await fn(); } finally { console.log = realLog; }
    return lines.filter(l => l.includes('resolve timing'));
}

test('a remux resolve says it was remux, and that the probe came from the cache', async () => {
    const url = 'http://provider.invalid/live/u/p/1.ts';
    seedProbe(url, {});
    const lines = await timingLines(() => strategy.resolve({ url, capabilities: {}, settings: SETTINGS }));
    assert.deepEqual(lines, ['[Playback] resolve timing: remux, probe cached']);
});

test('a direct-play resolve is timed too', async () => {
    const url = 'http://provider.invalid/live/u/p/2.m3u8';
    seedProbe(url, {}, { container: 'hls' });
    const lines = await timingLines(() => strategy.resolve({ url, capabilities: {}, settings: SETTINGS }));
    assert.deepEqual(lines, ['[Playback] resolve timing: direct, probe cached']);
});

function stubSession(readyAfterMs) {
    const real = transcodeSession.createSession;
    const removed = [];
    const realRemove = transcodeSession.removeSession;
    transcodeSession.createSession = async () => ({
        id: 'stub', start: async () => {},
        waitForPlaylist: async () => { await new Promise(r => setTimeout(r, Math.abs(readyAfterMs))); return readyAfterMs >= 0; }
    });
    transcodeSession.removeSession = async (id) => { removed.push(id); };
    return { removed, restore() { transcodeSession.createSession = real; transcodeSession.removeSession = realRemove; } };
}

test('an HLS session resolve says how long the first segment took', async () => {
    const url = 'http://provider.invalid/live/u/p/3.ts';
    seedProbe(url, { segmentedDelivery: true });
    const stub = stubSession(120);
    try {
        const lines = await timingLines(() => strategy.resolve({ url, capabilities: { segmentedDelivery: true }, settings: SETTINGS }));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^\[Playback\] resolve timing: HLS session, probe cached, first segment after 0\.\ds$/);
    } finally { stub.restore(); }
});

test('a session that never produced a segment says so - the case that ends in an error', async () => {
    const url = 'http://provider.invalid/live/u/p/4.ts';
    seedProbe(url, { segmentedDelivery: true });
    const stub = stubSession(-30);
    try {
        let failure;
        const lines = await timingLines(async () => {
            try { await strategy.resolve({ url, capabilities: { segmentedDelivery: true }, settings: SETTINGS }); } catch (err) { failure = err; }
        });
        assert.match(failure && failure.message, /failed to produce a playlist/, 'it still fails as before');
        assert.deepEqual(lines, ['[Playback] resolve timing: HLS session, probe cached, first segment NOT produced in time']);
        assert.deepEqual(stub.removed, ['stub'], 'the abandoned session is still cleaned up');
    } finally { stub.restore(); }
});
