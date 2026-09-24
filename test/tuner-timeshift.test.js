const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const compression = require('compression');
const jwt = require('jsonwebtoken');

// 0128 (T3): timeshift. With PIGTV_TUNER=1 a tuner keeps up to
// PIGTV_TIMESHIFT_HOURS of segments (default 3) in <recordings>/.timeshift/<id>,
// trimmed by time and by a free-space floor, cleaned up when it stops and at
// startup; its playlist offers delta updates (CAN-SKIP-UNTIL / _HLS_skip=YES) and
// may be gzipped - playlists only, never segments.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-timeshift-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_TUNER = '1';
delete process.env.PIGTV_TIMESHIFT_HOURS;
delete process.env.PIGTV_TIMESHIFT_MIN_FREE_GB;
process.chdir(sandbox);
const recordingsRoot = path.join(sandbox, 'recordings');

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const tuner = load('services/tuner');
const strategy = load('services/playbackStrategy');
const recordingEngine = load('services/recordingEngine');
const { shouldCompress } = load('services/compressionFilter');
const { HlsRecorder } = load('services/hlsRecorder');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const { fakeHlsArgs } = require('./helpers/fakeHls');
recordingEngine.listActive = () => [];

const URL_A = 'http://provider.invalid/live/u/p/441367.ts';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const APPLE = { hls: true, segmentedDelivery: true, fmp4: true, hevc: true, ac3: true, eac3: true };
let script = {};
tuner.hooks.spawnArgs = (t) => fakeHlsArgs({ ext: t.options.segmentType === 'fmp4' ? 'm4s' : 'ts', ...script });
// Plenty of room, whatever the machine running this has (a CI runner has ~14 GB).
const PLENTY = () => 1000;
tuner.hooks.freeSpaceGB = PLENTY;

let server, base;
before(async () => {
    await db.settings.update({ recordingsPath: recordingsRoot, maxProviderStreams: 1 });
    const app = express();
    app.use(compression({ filter: shouldCompress }));
    app.use(express.json());
    app.locals.ffmpegPath = process.execPath;
    app.locals.ffprobePath = path.join(sandbox, 'no-ffprobe');
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/transcode', load('routes/transcode'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await tuner.destroyAll('test over');
    script = {};
    tuner.hooks.freeSpaceGB = PLENTY;
    tuner.hooks.spaceCheckMs = null;
    delete process.env.PIGTV_TIMESHIFT_HOURS;
    process.env.PIGTV_TUNER = '1';
});

after(() => {
    server.closeAllConnections?.();
    server.close();
    delete process.env.PIGTV_TUNER;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

/** A started timeshift tuner (fake ffmpeg), with a viewer. */
async function timeshiftTuner(timeshiftSec, extra = {}) {
    const { tuner: t } = tuner.prepare(URL_A, { ffmpegPath: process.execPath, videoMode: 'copy', segmentType: 'fmp4',
        ...tuner.placement({ recordingsPath: recordingsRoot }), ...(timeshiftSec ? { timeshiftSec } : {}), ...extra });
    tuner.register(t);
    tuner.addViewer(t, {});
    await tuner.start(t);
    assert.equal(await t.waitForPlaylist(5000), true);
    return t;
}
async function produce(t, lastSeq) {
    for (let i = 0; i < 300 && t.lastSeq < lastSeq; i++) { await t.ingest(); await sleep(50); }
    await t.ingest();
}
function get(p, headers = {}) {
    // node's http, not fetch: fetch decodes gzip silently, and the encoding is the point.
    return new Promise((resolve, reject) => {
        http.get(`${base}${p}`, { headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const text = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString();
                resolve({ status: res.statusCode, headers: res.headers, text, bytes: raw.length });
            });
        }).on('error', reject);
    });
}

test('on by default with the tuner: /api/info says timeshift, and tuners live on the recordings volume', async () => {
    const info = JSON.parse((await get('/api/info')).text);
    assert.equal(info.features.timeshift, true);
    assert.deepEqual(tuner.placement({ recordingsPath: recordingsRoot }),
        { baseDir: path.join(recordingsRoot, '.timeshift'), timeshiftSec: 3 * 3600 });
    process.env.PIGTV_TIMESHIFT_HOURS = '0';
    assert.deepEqual(tuner.placement({ recordingsPath: recordingsRoot }), {}, 'PIGTV_TIMESHIFT_HOURS=0: the 0126 window on the tmpfs');
    assert.ok(!('timeshift' in JSON.parse((await get('/api/info')).text).features));
    process.env.PIGTV_TIMESHIFT_HOURS = '1.5';
    assert.equal(tuner.placement({}).timeshiftSec, 5400);
});

test('the window is kept by time, not 90 segments, and the files behind it are deleted', async () => {
    script = { everyMs: 15, duration: 0.5 };
    const t = await timeshiftTuner(60); // one minute: 120 half-second segments
    assert.ok(t.dir.startsWith(path.join(recordingsRoot, '.timeshift') + path.sep));
    await produce(t, 160);
    const total = t.window.reduce((s, x) => s + x.duration, 0);
    assert.ok(t.window.length > 90, `more than the old 90 (${t.window.length})`);
    assert.ok(total >= 60 && total < 60.5, `a minute (${total} s)`);
    assert.equal(t.window[0].seq, t.lastSeq - t.window.length + 1, 'contiguous');
    const onDisk = fs.readdirSync(t.dir).filter(n => n.endsWith('.m4s')).length;
    assert.ok(onDisk <= t.window.length + 12 + 2, `old files deleted (${onDisk} on disk)`);
    assert.ok(!fs.existsSync(path.join(t.dir, 'seg0000.m4s')));
});

test('below the free-space floor the oldest segments go at once, down to the 90-segment window at most', async () => {
    script = { everyMs: 10, duration: 4 };
    const t = await timeshiftTuner(3 * 3600);
    await produce(t, 130);
    assert.ok(t.window.length >= 120, 'nothing trimmed while there is room');
    tuner.hooks.spaceCheckMs = 0;
    tuner.hooks.freeSpaceGB = (dir) => {
        assert.equal(dir, path.join(recordingsRoot, '.timeshift'), 'asks about the timeshift volume');
        return 1; // far below the 20 GB floor
    };
    const logs = [];
    const warn = console.warn;
    console.warn = (...a) => logs.push(a.join(' '));
    try { await t.ingest(); await t.trim(); } finally { console.warn = warn; }
    assert.equal(t.window.length, 90, 'kept the 0126 window, no less');
    const first = t.window[0].name;
    const names = fs.readdirSync(t.dir).filter(n => n.endsWith('.m4s')).sort();
    assert.equal(names[0], first, 'the dropped files are gone at once, not 12 segments later');
    assert.ok(logs.some(l => /Only 1\.0 GB free for timeshift \(floor 20 GB\): dropped the oldest \d+ segments/.test(l)), logs.join('\n'));

    // Room again: nothing more goes (the time window is 3 h).
    tuner.hooks.freeSpaceGB = () => 500;
    await produce(t, t.lastSeq + 5);
    assert.ok(t.window.length > 90);
});

test('delta updates: CAN-SKIP-UNTIL of six target durations; _HLS_skip=YES leaves out exactly what precedes the Skip Boundary', async () => {
    script = { everyMs: 10, duration: 4 };
    const { status, body } = await (async () => {
        const caps = { ...strategy.DEFAULT_CAPABILITIES, ...APPLE };
        const key = `${URL_A}|${db.getUserAgent({}) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
        probeCache.set(key, { result: analyzeProbeResult({ streams: [{ codec_type: 'video', codec_name: 'h264', avg_frame_rate: '25/1' },
            { codec_type: 'audio', codec_name: 'aac', channels: 2 }], format: { format_name: 'mpegts' } }, URL_A, caps), timestamp: Date.now() });
        sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('tv', '1', 'tv', 'test', Date.now(), Date.now());
        const tok = jwt.sign({ id: 1, username: 'o', role: 'admin', deviceId: 'tv' }, process.env.JWT_SECRET);
        const r = await fetch(`${base}/api/playback/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
            body: JSON.stringify({ url: URL_A, capabilities: APPLE }) });
        return { status: r.status, body: await r.json() };
    })();
    assert.equal(status, 200, JSON.stringify(body));
    const t = tuner.list()[0];
    await produce(t, 40);
    // Freeze the list for the comparison: the fake keeps writing.
    t.ingest = async () => {};
    const full = (await get(`/api/transcode/${body.sessionId}/stream.m3u8`)).text;
    const delta = (await get(`/api/transcode/${body.sessionId}/stream.m3u8?_HLS_skip=YES`)).text;

    assert.match(full, /#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=24\.0\n/);
    assert.ok(!full.includes('#EXT-X-SKIP'));
    const uris = (txt) => txt.split('\n').filter(l => /^seg\d+\.m4s$/.test(l));
    const fullUris = uris(full);
    const n = fullUris.length;
    const skipped = Number(/#EXT-X-SKIP:SKIPPED-SEGMENTS=(\d+)/.exec(delta)[1]);
    assert.equal(skipped, n - 6, 'all but the last 24 s (six 4 s segments)');
    assert.deepEqual(uris(delta), fullUris.slice(skipped), 'the rest, unchanged');
    const seq = (txt) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(txt)[1]);
    assert.equal(seq(delta), seq(full), 'MEDIA-SEQUENCE still counts from the first (skipped) segment');
    assert.equal(Number(/seg(\d+)/.exec(uris(delta)[0])[1]), seq(full) + skipped, 'so the first listed segment keeps its number');
    assert.match(delta, /^#EXTM3U\n#EXT-X-VERSION:9\n/);
    assert.match(delta, /#EXT-X-SKIP:SKIPPED-SEGMENTS=\d+\n#EXT-X-MAP:URI="init\.mp4"\n#EXT-X-PROGRAM-DATE-TIME:/);
    // Every PROGRAM-DATE-TIME in the delta is the one the full playlist gives that segment.
    const tail = full.slice(full.indexOf(`${fullUris[skipped - 1]}\n`) + fullUris[skipped - 1].length + 1);
    assert.ok(delta.endsWith(tail), 'the segment lines are the full playlist\'s, byte for byte');
});

test('playlists may be gzipped, segments never; and nothing is when the tuner is off', async () => {
    script = { everyMs: 10, duration: 4 };
    const t = await timeshiftTuner(3 * 3600);
    await produce(t, 60);
    const viewer = [...t.viewers][0];
    const gz = { 'Accept-Encoding': 'gzip' };
    const playlist = await get(`/api/transcode/${viewer}/stream.m3u8`, gz);
    assert.equal(playlist.status, 200);
    assert.equal(playlist.headers['content-encoding'], 'gzip');
    assert.ok(playlist.bytes < playlist.text.length / 3, `compressed (${playlist.bytes} of ${playlist.text.length} bytes)`);
    assert.match(playlist.text, /^#EXTM3U\n/);
    const seg = /\n(seg\d+\.m4s)\n/.exec(playlist.text)[1];
    for (const f of [seg, 'init.mp4']) {
        const r = await get(`/api/transcode/${viewer}/${f}`, gz);
        assert.equal(r.status, 200);
        assert.equal(r.headers['content-encoding'], undefined, `${f} is sent as it is`);
    }
    const ranged = await get(`/api/transcode/${viewer}/stream.m3u8`, { ...gz, Range: 'bytes=0-10' });
    assert.equal(ranged.headers['content-encoding'], undefined, 'never with a Range');

    // The filter itself: exact playlist paths only, and only with the tuner on.
    const res = (type) => ({ getHeader: () => type });
    const req = (p) => ({ headers: {}, path: p.replace(/^\/api\/[^/]+/, ''), originalUrl: `${p}?token=x` }); // as inside a mounted router
    const M = 'application/vnd.apple.mpegurl';
    assert.equal(shouldCompress(req('/api/transcode/abc/stream.m3u8'), res(M)), true);
    assert.equal(shouldCompress(req('/api/transcode/abc/master.m3u8'), res(M)), true);
    assert.equal(shouldCompress(req('/api/recordings/12/index.m3u8'), res(`${M}; charset=utf-8`)), true);
    assert.equal(shouldCompress(req('/api/transcode/abc/seg0001.m4s'), res('video/MP2T')), false);
    assert.equal(shouldCompress(req('/api/recordings/12/seg00001.m4s'), res('video/MP2T')), false);
    assert.equal(shouldCompress(req('/api/transcode/abc/stream.m3u8'), res('application/json')), false, 'a JSON 404 from there stays as before');
    delete process.env.PIGTV_TUNER;
    assert.equal(shouldCompress(req('/api/transcode/abc/stream.m3u8'), res(M)), false, 'off: exactly as 0108');
    assert.equal(shouldCompress(req('/api/recordings/12/index.m3u8'), res(M)), false);
});

test('a stopped tuner takes its timeshift directory with it; a restart removes what a previous run left', async () => {
    const t = await timeshiftTuner(3600);
    const dir = t.dir;
    assert.ok(fs.existsSync(dir));
    await tuner.destroyTuner(t, 'test');
    assert.ok(!fs.existsSync(dir), 'removed on stop');

    const ts = path.join(recordingsRoot, '.timeshift');
    fs.mkdirSync(path.join(ts, 'deadbeef00000001'), { recursive: true });
    fs.writeFileSync(path.join(ts, 'deadbeef00000001', 'seg0001.m4s'), 'x');
    fs.mkdirSync(path.join(ts, 'deadbeef00000002'));
    const live = await timeshiftTuner(3600);
    const logs = [];
    const log = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try { assert.equal(await tuner.sweepOrphanedTimeshift(recordingsRoot), 2); } finally { console.log = log; }
    assert.ok(!fs.existsSync(path.join(ts, 'deadbeef00000001')));
    assert.ok(fs.existsSync(live.dir), 'a running tuner\'s directory is left alone');
    assert.ok(logs.some(l => l.includes('Removing 2 timeshift directories')));
    assert.equal(await tuner.sweepOrphanedTimeshift(path.join(sandbox, 'nowhere')), 0, 'silent when there is none');
});

test('a recording takes its pre-buffer from the timeshift window, hard-linked on the same volume', async () => {
    script = { everyMs: 200, duration: 0.2 };
    const t = await timeshiftTuner(3600);
    await sleep(1500); // the tuner has been on the channel for a while
    const folder = path.join(recordingsRoot, 'News', 'Show - 2026-09-24 20-00');
    fs.mkdirSync(folder, { recursive: true });
    const attachedAt = Date.now();
    const recorder = new HlsRecorder({ dir: folder, from: attachedAt - 1000, to: attachedAt + 600 });
    recorder.attach(t);
    await sleep(1400);
    await recorder.finish();
    assert.ok(recorder.segments[0].pdt < attachedAt - 500, 'segments from before the recording started');
    assert.ok(recorder.segments[recorder.segments.length - 1].pdt < attachedAt + 600);
    assert.ok(recorder.links.link > 0 && recorder.links.copy === 0, `hard-linked (${JSON.stringify(recorder.links)})`);
    const ino = (f) => fs.statSync(f).ino;
    const src = t.window.find(s => Math.abs(s.pdt - recorder.segments[0].pdt) < 1);
    assert.equal(ino(path.join(folder, recorder.segments[0].name)), ino(path.join(t.dir, src.name)), 'the same file, not a copy');
    await tuner.destroyTuner(t, 'test');
    assert.ok(fs.existsSync(path.join(folder, recorder.segments[0].name)), 'and it outlives the tuner\'s directory');
});
