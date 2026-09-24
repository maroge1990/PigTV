const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0126-0129: the tuner model is OFF unless PIGTV_TUNER=1. Off, resolve, the HLS
// routes, DELETE and /api/info are today's: sessions (not tuners), ffmpeg's own
// playlist served as written (no PROGRAM-DATE-TIME), no tuner flags.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tuner-off-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
delete process.env.PIGTV_TUNER;
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const tuner = load('services/tuner');
const transcodeSession = load('services/transcodeSession');
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const recordingEngine = load('services/recordingEngine');
recordingEngine.listActive = () => [];

const URL_ = 'http://provider.invalid/live/u/p/441367.ts';
const FFMPEG_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000000,\nseg0000.m4s\n';

let server, base;
let tunedCalls = 0;
before(async () => {
    const realTuned = strategy.resolveTuned;
    strategy.resolveTuned = async (...a) => { tunedCalls++; return realTuned(...a); };
    // A session whose "ffmpeg" writes the playlist ffmpeg would and stays up.
    const realCreate = transcodeSession.createSession;
    transcodeSession.createSession = async (u, o) => {
        const s = await realCreate(u, { ...o, ffmpegPath: process.execPath });
        s.buildFFmpegArgs = () => ['-e', `require('fs').writeFileSync('seg0000.m4s', 'x'); require('fs').writeFileSync('stream.m3u8', ${JSON.stringify(FFMPEG_PLAYLIST)}); setInterval(() => {}, 1000);`];
        return s;
    };
    const app = express();
    app.use(express.json());
    app.locals.ffmpegPath = process.execPath;
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/transcode', load('routes/transcode'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    server.closeAllConnections?.();
    server.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

function token() {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('tv', '1', 'tv', 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId: 'tv' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

test('off by default: resolve starts a session exactly as before, and its playlist is ffmpeg\'s, byte for byte', async () => {
    assert.equal(tuner.enabled(), false);
    const caps = { ...strategy.DEFAULT_CAPABILITIES, fmp4: true, segmentedDelivery: true };
    const key = `${URL_}|${db.getUserAgent({}) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult({ streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac', channels: 2 }], format: { format_name: 'mpegts' } }, URL_, caps), timestamp: Date.now() });

    const r = await fetch(`${base}/api/playback/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ url: URL_, capabilities: { fmp4: true, segmentedDelivery: true } }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(tunedCalls, 0, 'the tuner path is never entered');
    assert.equal(tuner.list().length, 0);
    assert.equal(transcodeSession.getAllSessions().length, 1);
    assert.equal(body.sessionId, transcodeSession.getAllSessions()[0].id);
    const playlist = await (await fetch(`${base}/api/transcode/${body.sessionId}/stream.m3u8`)).text();
    assert.equal(playlist, FFMPEG_PLAYLIST, 'no PROGRAM-DATE-TIME, nothing rewritten');

    const del = await fetch(`${base}/api/playback/${body.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
    assert.deepEqual(await del.json(), { success: true });
    assert.equal(transcodeSession.getAllSessions().length, 0);
});

test('off: the tuner module holds nothing', () => {
    assert.equal(tuner.list().length, 0);
    assert.equal(tuner.listViewers().length, 0);
});
