const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Codex review of 0287 (27 Oct): the shared ingest's channel and provider names (for feed_lag) were
// dropped when playbackStrategy.resolve handed the session its ingestSource, which it rebuilt from
// four fields. A play that probes keeps them (the probe opens the ingest with the full source), but
// a play served from the analysis cache or a stored profile - most plays, "probe profile (age 0d)"
// in the live log - has its session open the ingest, unnamed. Relay legs resolve the same way.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-lag-naming-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.PIGTV_DB_BACKUPS = '0';
process.chdir(sandbox);
const load = (p) => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const db = load('db');
after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('a play served from a cached analysis gives its session the ingest source with the channel and provider names', async () => {
    const url = 'http://provider.invalid/live/u/p/505.ts';
    const settings = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
    const caps = { ...strategy.DEFAULT_CAPABILITIES };
    const key = `${url}|${db.getUserAgent(settings) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    const info = analyzeProbeResult({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }], format: { format_name: 'mpegts' } }, url, {});
    assert.equal(info.compatible, false, 'an HLS session, not a direct play');
    probeCache.set(key, { result: info, timestamp: Date.now(), fromProfile: true, probedAt: Date.now() });

    let given = null;
    const real = transcodeSession.createSession;
    transcodeSession.createSession = async (u, options) => { given = options; throw Object.assign(new Error('captured'), { captured: true }); };
    try {
        await assert.rejects(strategy.resolve({ url, settings, live: true, providerId: 3,
            ingestSource: { pool: 'primary', url, userAgent: 'ua', providerId: 3, key: 'primary|abc', channel: 'NBC Sports Boston', providerName: 'Strong8K' } }),
            (err) => err.captured === true);
    } finally {
        transcodeSession.createSession = real;
    }
    assert.ok(given && given.ingestSource, 'the session reads through the ingest');
    assert.equal(given.ingestSource.channel, 'NBC Sports Boston');
    assert.equal(given.ingestSource.providerName, 'Strong8K');
    assert.equal(given.ingestSource.providerId, 3);
});
