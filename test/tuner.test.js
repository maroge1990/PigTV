const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0126 (T1): the tuner model. With PIGTV_TUNER=1, viewers of the same channel whose
// resolve produces the same ffmpeg arguments share ONE tuner (one provider
// connection, one ffmpeg); different arguments are a second tuner and need a second
// provider slot (409 at the default limit of 1); the last viewer to leave stops it;
// the playlist is the server's, with #EXT-X-PROGRAM-DATE-TIME on every segment.
//
// Real routes (/api/playback, /api/transcode) over a sandbox copy of the server;
// ffmpeg is node writing an hls muxer's files (test/helpers/fakeHls.js), and the
// probe is pre-seeded in the cache, so neither ffmpeg nor ffprobe is needed.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tuner-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_TUNER = '1';
// T1's window: 90 segments on the transcode cache (timeshift, 0128, has its own tests).
process.env.PIGTV_TIMESHIFT_HOURS = '0';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const tuner = load('services/tuner');
const transcodeSession = load('services/transcodeSession');
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult, reanalyzeForCaps } = load('services/streamProbe');
const coordinator = load('services/streamCoordinator');
const recordingEngine = load('services/recordingEngine');
const { fakeHlsArgs } = require('./helpers/fakeHls');

recordingEngine.listActive = () => [];

const URL_A = 'http://provider.invalid/live/u/p/441367.ts';
const URL_B = 'http://provider.invalid/live/u/p/441372.ts';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// What the provider's H.264 + AAC channels look like to ffprobe: 25 fps, so every
// session is handed out through master.m3u8 (0115).
const RAW = {
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
              { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
    format: { format_name: 'mpegts' }
};
const APPLE = { hls: true, segmentedDelivery: true, fmp4: true, hevc: true, ac3: true, eac3: true };
const WEB_TS = { segmentedDelivery: true, fmp4: false };

function seed(url, capabilities) {
    const caps = { ...strategy.DEFAULT_CAPABILITIES, ...capabilities };
    const key = `${url}|${db.getUserAgent({}) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult(RAW, url, caps), timestamp: Date.now() });
}

let spawns = [];
let script = {};
tuner.hooks.spawnArgs = (t) => { spawns.push(t.id); return fakeHlsArgs({ ext: t.options.segmentType === 'fmp4' ? 'm4s' : 'ts', ...script }); };

let server, base;
function token(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, '1', deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const TV = () => token('apple-tv');
const IPAD = () => token('ipad');

async function resolve(tok, body) {
    const r = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
}
async function get(p) {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, text: await r.text(), headers: r.headers };
}

before(async () => {
    await db.settings.update({ maxProviderStreams: 1 });
    const app = express();
    app.use(express.json());
    app.locals.ffmpegPath = process.execPath;
    app.locals.ffprobePath = path.join(sandbox, 'no-ffprobe-here'); // a probe would fail the test
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/transcode', load('routes/transcode'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await tuner.destroyAll('test over');
    spawns = [];
    script = {};
    probeCache.clear();
    await db.settings.update({ maxProviderStreams: 1 });
});

after(() => {
    server.closeAllConnections?.();
    server.close();
    delete process.env.PIGTV_TUNER;
    delete process.env.PIGTV_TIMESHIFT_HOURS;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('two devices on the same channel share one tuner: one ffmpeg, two viewer ids', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const b = await resolve(IPAD(), { url: URL_A, capabilities: APPLE });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body), 'no 409: joining a tuner needs no provider slot');
    assert.equal(spawns.length, 1, 'one ffmpeg for both');
    assert.notEqual(a.body.sessionId, b.body.sessionId, 'each viewer has its own id (DELETE, terminal-status)');
    assert.equal(tuner.list().length, 1);
    assert.equal(tuner.list()[0].viewers.size, 2);
    // Same response shape as a session: master playlist (25 fps), then the media playlist.
    assert.equal(a.body.strategy, 'transcode');
    assert.equal(a.body.url, `/api/transcode/${a.body.sessionId}/master.m3u8`);
    for (const r of [a, b]) {
        const master = await get(r.body.url);
        assert.equal(master.status, 200);
        assert.match(master.text, /FRAME-RATE=25\.000/);
        assert.match(master.text, /\nstream\.m3u8\n/);
        const media = await get(`/api/transcode/${r.body.sessionId}/stream.m3u8`);
        assert.equal(media.status, 200);
        assert.match(media.text, /#EXT-X-MAP:URI="init\.mp4"/);
        const seg = /\n(seg\d+\.m4s)\n/.exec(media.text)[1];
        assert.equal((await get(`/api/transcode/${r.body.sessionId}/${seg}`)).status, 200);
    }
});

test('the second viewer is not probed: the running tuner\'s analysis is re-read for its capabilities', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    assert.equal(a.status, 200);
    // Nothing cached for these capabilities, and ffprobe does not exist here: only the
    // tuner's own analysis can answer. H.264 + AAC plays the same for both, so same tuner.
    const caps = { ...APPLE, hevc: false, ac3: false };
    const b = await resolve(IPAD(), { url: URL_A, capabilities: caps });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(spawns.length, 1);
    assert.equal(tuner.list()[0].viewers.size, 2);
});

test('different arguments are a different tuner, and need a second provider slot: 409 at the limit of 1', async () => {
    seed(URL_A, APPLE);
    seed(URL_A, WEB_TS);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    assert.equal(a.status, 200);
    const b = await resolve(IPAD(), { url: URL_A, capabilities: WEB_TS }); // MPEG-TS: other arguments
    assert.equal(b.status, 409);
    assert.equal(b.body.conflict.type, 'viewer-in-progress');
    assert.equal(b.body.conflict.streamId, a.body.sessionId, 'the other VIEWER, not the tuner');
    assert.equal(spawns.length, 1);

    // force: the other device's tuner goes, and it may learn why.
    const forced = await resolve(IPAD(), { url: URL_A, capabilities: WEB_TS, force: true });
    assert.equal(forced.status, 200);
    assert.equal(spawns.length, 2);
    assert.equal(tuner.list().length, 1);
    assert.equal(tuner.list()[0].options.segmentType, 'mpegts');
    assert.equal(coordinator.terminalStatus(a.body.sessionId, 'device:apple-tv'), 'taken-over');
    assert.equal((await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`)).status, 404);
});

test('with two provider slots the two argument sets run side by side', async () => {
    await db.settings.update({ maxProviderStreams: 2 });
    seed(URL_A, APPLE);
    seed(URL_A, WEB_TS);
    assert.equal((await resolve(TV(), { url: URL_A, capabilities: APPLE })).status, 200);
    assert.equal((await resolve(IPAD(), { url: URL_A, capabilities: WEB_TS })).status, 200);
    assert.equal(spawns.length, 2);
    assert.equal(tuner.list().length, 2);
});

test('the same device changing channel replaces its own tuner without a question', async () => {
    seed(URL_A, APPLE);
    seed(URL_B, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const b = await resolve(TV(), { url: URL_B, capabilities: APPLE });
    assert.equal(b.status, 200);
    assert.equal(tuner.list().length, 1);
    assert.equal(tuner.list()[0].url, URL_B);
    assert.equal(coordinator.terminalStatus(a.body.sessionId, 'device:apple-tv'), 'taken-over');
});

test('the tuner stops with its last viewer, not before', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const b = await resolve(IPAD(), { url: URL_A, capabilities: APPLE });
    const t = tuner.list()[0];
    const del = (id, tok) => fetch(`${base}/api/playback/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
    assert.equal((await del(a.body.sessionId, TV())).status, 200);
    assert.equal(tuner.list().length, 1, 'the iPad is still watching');
    assert.equal((await get(`/api/transcode/${b.body.sessionId}/stream.m3u8`)).status, 200);
    assert.equal((await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`)).status, 404);
    assert.equal((await del(b.body.sessionId, IPAD())).status, 200);
    assert.equal(tuner.list().length, 0);
    assert.ok(!fs.existsSync(t.dir), 'its directory is gone');
    assert.ok(t.process === null || t.process.exitCode !== null || t.process.signalCode !== null, 'and its ffmpeg');
    assert.equal(coordinator.terminalStatus(a.body.sessionId, 'device:apple-tv'), 'none', 'a DELETE leaves no note');
});

test('viewers idle past the idle rules are swept, and the tuner with them', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const v = tuner.getViewer(a.body.sessionId);
    v.lastAccess = Date.now() - transcodeSession.SESSION_TIMEOUT_MS - 1000; // a bare url is not live
    await tuner.sweep();
    assert.equal(tuner.list().length, 0);
});

test('the playlist is the server\'s: PROGRAM-DATE-TIME on every segment, monotonic, consistent with EXTINF', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    await sleep(800);
    const { text } = await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`);
    const lines = text.split('\n');
    const dates = lines.filter(l => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map(l => Date.parse(l.slice(25)));
    const extinf = lines.filter(l => l.startsWith('#EXTINF:'));
    assert.ok(dates.length >= 3, text);
    assert.equal(dates.length, extinf.length, 'one per segment');
    for (let i = 1; i < dates.length; i++) assert.equal(dates[i] - dates[i - 1], 4000, 'each starts where the last ended');
    assert.ok(Math.abs(dates[0] - Date.now()) < 60 * 1000, 'a real wall-clock date');
    assert.match(text, /^#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init\.mp4"\n#EXT-X-PROGRAM-DATE-TIME:/);
    assert.ok(!/SERVER-CONTROL/.test(text), 'no delta updates before timeshift (0128)');
    // Later: the same segments keep the same dates.
    await sleep(400);
    const again = (await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`)).text;
    assert.ok(again.includes(lines.find(l => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))));
});

test('the token is carried onto every URI of the server\'s playlist (as withStreamToken does)', async () => {
    seed(URL_A, APPLE);
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const { text } = await get(`/api/transcode/${a.body.sessionId}/stream.m3u8?token=abc%2Fdef`);
    assert.match(text, /#EXT-X-MAP:URI="init\.mp4\?token=abc%2Fdef"/);
    for (const l of text.split('\n').filter(l => l && !l.startsWith('#'))) assert.match(l, /^seg\d{4}\.m4s\?token=abc%2Fdef$/);
    const master = (await get(`/api/transcode/${a.body.sessionId}/master.m3u8?token=t1`)).text;
    assert.match(master, /\nstream\.m3u8\?token=t1\n/);
});

test('the window is kept at 90 segments and the files behind it are deleted (12 spare)', async () => {
    seed(URL_A, APPLE);
    script = { everyMs: 20 };
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    const t = tuner.list()[0];
    // Read ffmpeg's playlist more often than its 30 entries roll over at this speed.
    for (let i = 0; i < 200 && t.lastSeq < 130; i++) { await t.ingest(); await sleep(100); }
    const { text } = await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`);
    const segs = text.split('\n').filter(l => /^seg\d+\.m4s$/.test(l));
    assert.equal(segs.length, 90);
    const firstSeq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1]);
    assert.equal(Number(/seg(\d+)/.exec(segs[0])[1]), firstSeq, 'MEDIA-SEQUENCE is the first segment\'s number');
    assert.ok(!fs.existsSync(path.join(t.dir, 'seg0000.m4s')), 'the oldest are gone from disk');
});

test('the stall watchdog releases a tuner (and its viewers) whose ffmpeg stops writing', async () => {
    script = { stopAfter: 2 };
    const { tuner: t } = tuner.prepare(URL_A, { ffmpegPath: process.execPath, videoMode: 'copy', segmentType: 'fmp4',
        stallMs: 800, startupMs: 3000, watchdogIntervalMs: 100 });
    tuner.register(t);
    const v = tuner.addViewer(t, { owner: 'device:tv', live: true });
    await tuner.start(t);
    assert.equal(await t.waitForPlaylist(5000), true);
    for (let i = 0; i < 60 && tuner.list().length; i++) await sleep(100);
    assert.equal(tuner.list().length, 0, 'released');
    assert.equal(tuner.viewerTarget(v.id), null);
    assert.equal(coordinator.terminalStatus(v.id, 'device:tv'), 'none', 'a stall is not a takeover');
});

test('a tuner refused on its first connection is retried once, like a session (0113)', async () => {
    const marker = path.join(sandbox, 'refused-once');
    const refusal = ['[in#0 @ 0x1] Error opening input: Server returned 4XX Client Error, but not one of 40{0,1,3,4}']
        .map(l => `process.stderr.write(${JSON.stringify(l + '\n')});`).join('');
    const plays = fakeHlsArgs({})[1];
    tuner.hooks.spawnArgs = () => ['-e', `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); ${refusal} process.exitCode = 1; } else { ${plays} }`];
    try {
        const { tuner: t } = tuner.prepare(URL_A, { ffmpegPath: process.execPath, videoMode: 'copy', segmentType: 'fmp4' });
        tuner.register(t);
        tuner.addViewer(t, {});
        const log = console.warn; const lines = [];
        console.warn = (...a) => lines.push(a.join(' '));
        try {
            await tuner.start(t);
            assert.equal(await t.waitForPlaylist(10000), true);
        } finally { console.warn = log; }
        assert.ok(lines.some(l => /refused the first connection; retrying once/.test(l)));
        assert.equal(tuner.list().length, 1);
    } finally {
        tuner.hooks.spawnArgs = (t) => { spawns.push(t.id); return fakeHlsArgs({ ext: t.options.segmentType === 'fmp4' ? 'm4s' : 'ts', ...script }); };
    }
});

test('a source that ends: ffmpeg\'s ENDLIST reaches the server\'s playlist', async () => {
    seed(URL_A, APPLE);
    script = { endAfter: 3 };
    const a = await resolve(TV(), { url: URL_A, capabilities: APPLE });
    await sleep(900);
    const { status, text } = await get(`/api/transcode/${a.body.sessionId}/stream.m3u8`);
    assert.equal(status, 200, 'the viewer keeps its playlist to the end');
    assert.match(text, /#EXT-X-ENDLIST\n$/);
});

test('an earlier analysis re-read for other capabilities equals a fresh one (no second probe)', () => {
    const raws = [RAW,
        { streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, r_frame_rate: '50/1', color_transfer: 'smpte2084' },
                    { codec_type: 'audio', codec_name: 'eac3', channels: 6 }], format: { format_name: 'mpegts' } },
        { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '0/0', r_frame_rate: '50/1' },
                    { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2 }], format: { format_name: 'mpegts', duration: '1800' } }];
    const capsets = [APPLE, WEB_TS, {}, { ...APPLE, heaac: true }];
    for (const raw of raws) {
        for (const from of capsets) {
            for (const to of capsets) {
                const fresh = analyzeProbeResult(raw, URL_A, to);
                const re = reanalyzeForCaps(analyzeProbeResult(raw, URL_A, from), URL_A, to);
                assert.deepEqual({ ...re, subtitles: [] }, { ...fresh, subtitles: [] });
            }
        }
    }
});
