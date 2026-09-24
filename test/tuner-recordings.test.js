const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0127 (T2): with PIGTV_TUNER=1 a scheduled recording takes its
// segments from a tuner - a live viewer's when one is on the channel (one provider
// connection for both), or one started just for it - into its own folder with its
// own playlist: EVENT while recording, VOD with
// ENDLIST when done, then joined into one MP4 for download and ad detection.
//
// Real routes and engine over a sandbox; ffmpeg is node writing an hls muxer's
// files with 0.2 s segments every 0.2 s (so the dates keep pace with the clock),
// the join is stood in for, and the probe is pre-seeded.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tuner-rec-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json')); // routes/info.js reads it
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_TUNER = '1';
process.chdir(sandbox);
const recordingsRoot = path.join(sandbox, 'recordings');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'data/db.json'), JSON.stringify({
    sources: [{ id: 2, name: 'Test M3U', type: 'm3u', url: 'http://provider.invalid/list.m3u', enabled: true }],
    settings: { recordingsPath: recordingsRoot, maxProviderStreams: 1, minFreeSpaceGB: 0 }, users: [], nextId: 3
}));

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const tuner = load('services/tuner');
const engine = load('services/recordingEngine');
const strategy = load('services/playbackStrategy');
const { scheduled, recordings } = load('db/recordingsDb');
const { probeCache, analyzeProbeResult } = load('services/streamProbe');
const { fakeHlsArgs } = require('./helpers/fakeHls');

const URL_A = 'http://provider.invalid/live/u/p/441367.ts';
const URL_B = 'http://provider.invalid/live/u/p/441372.ts';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
function channel(pos, url) {
    sqlite.getDb().prepare(`
        INSERT OR REPLACE INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, 2, ?, 'live', ?, 'News', NULL, ?, 1, NULL)
    `).run(`2:${pos}`, pos, `Channel ${pos}`, JSON.stringify({ url }));
}

let spawns = [];
tuner.hooks.spawnArgs = (t) => { spawns.push(t.id); return fakeHlsArgs({ ext: t.options.segmentType === 'fmp4' ? 'm4s' : 'ts', everyMs: 200, duration: 0.2 }); };

let joins = [];
engine._nativeTools.codecs = async () => ({ video: 'h264', audio: 'aac' });
engine._nativeTools.duration = async () => null;
engine._nativeTools.ffmpeg = async (args) => {
    joins.push(args);
    fs.writeFileSync(args[args.length - 1], 'joined-mp4');
    return { code: 0, tail: [] };
};

let server, base, userToken;
function deviceToken(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, '1', deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: 1, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    userToken = auth.generateToken(user);
    // What a recording's own tuner is planned from (RECORDING_CAPABILITIES).
    seed(URL_A, strategy.RECORDING_CAPABILITIES);
    seed(URL_B, strategy.RECORDING_CAPABILITIES);
    engine.init({ ffmpegPath: process.execPath, ffprobePath: path.join(sandbox, 'no-ffprobe') });
    engine.shutdown(); // the test drives tick() itself
    channel('pos_1', URL_A);
    channel('pos_2', URL_B);
    const app = express();
    app.use(express.json());
    app.use(auth.passport.initialize());
    app.locals.ffmpegPath = process.execPath;
    app.locals.ffprobePath = path.join(sandbox, 'no-ffprobe');
    const streamAuth = auth.streamAuthFromSettings(db);
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/transcode', streamAuth, load('routes/transcode'));
    app.use('/api/recordings', streamAuth, load('routes/recordings'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    await tuner.destroyAll('test over');
    spawns = [];
    joins = [];
    await db.settings.update({ requireStreamAuth: false, maxProviderStreams: 1 });
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    delete process.env.PIGTV_TUNER;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function get(route, headers = {}) {
    const r = await fetch(`${base}${route}`, { headers });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, body, headers: r.headers };
}
const bearer = () => ({ Authorization: `Bearer ${userToken}` });

let n = 0;
function due({ pos = 'pos_1', startInMs = -300, lengthMs = 2500, title } = {}) {
    n++;
    return scheduled.create({
        title: title || `Show ${n}`, description: null, source_id: 2, channel_item_id: pos,
        channel_name: 'News 24', channel_logo: null,
        program_start: Date.now() + startInMs, program_end: Date.now() + startInMs + lengthMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: Date.now()
    });
}
async function until(fn, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    return null;
}
const recordingOf = (s) => recordings.getById(scheduled.getById(s.id).recording_id);

test('/api/info advertises recordingHls with the tuner on', async () => {
    const { body } = await get('/api/info');
    assert.equal(body.features.recordingHls, true);
});

test('a recording with nobody watching starts a tuner just for itself; EVENT while recording, VOD with ENDLIST after', async () => {
    const s = due();
    await engine.tick();
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.equal(spawns.length, 1);
    const rec = recordingOf(s);
    assert.equal(rec.format, 'hls');
    assert.ok(rec.hls_dir.startsWith(path.join(recordingsRoot, 'News 24') + path.sep));
    assert.equal(tuner.list().length, 1);
    assert.deepEqual(tuner.list()[0].recordingIds(), [s.id]);

    await until(async () => (await get(`/api/recordings/${rec.id}/index.m3u8`)).text.includes('seg00001'));
    const live = await get(`/api/recordings/${rec.id}/index.m3u8`);
    assert.equal(live.status, 200);
    assert.match(live.headers.get('content-type'), /^application\/vnd\.apple\.mpegurl/);
    assert.match(live.text, /#EXT-X-PLAYLIST-TYPE:EVENT\n/);
    assert.match(live.text, /#EXT-X-MAP:URI="init\.mp4"\n/);
    assert.match(live.text, /#EXT-X-PROGRAM-DATE-TIME:/);
    assert.ok(!live.text.includes('#EXT-X-ENDLIST'));

    await until(() => recordings.getById(rec.id).status === 'completed');
    const done = recordings.getById(rec.id);
    assert.equal(scheduled.getById(s.id).status, 'completed');
    const vod = await get(`/api/recordings/${rec.id}/index.m3u8`);
    assert.match(vod.text, /#EXT-X-PLAYLIST-TYPE:VOD\n/);
    assert.match(vod.text, /#EXT-X-ENDLIST\n$/);
    const segs = vod.text.split('\n').filter(l => /^seg\d{5}\.m4s$/.test(l));
    assert.ok(segs.length >= 5, `kept ${segs.length} segments`);
    assert.equal(segs[0], 'seg00000.m4s');
    const dates = vod.text.split('\n').filter(l => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map(l => Date.parse(l.slice(25)));
    assert.ok(dates[0] >= done.started_at - 1000 && dates[dates.length - 1] < scheduled.getById(s.id).program_end, 'only the recording\'s window');
    assert.ok(Math.abs(done.duration_sec - segs.length * 0.2) <= 1);
    assert.equal(tuner.list().length, 0, 'the tuner existed only for the recording, and stopped with it');
    for (const f of ['init.mp4', ...segs]) {
        const r = await fetch(`${base}/api/recordings/${rec.id}/${f}`);
        assert.equal(r.status, 200, f);
    }
});

test('the playback answer (C-E): hls while recording (inProgress, growing), then finished; the old shape for .mkv recordings', async () => {
    const s = due({ lengthMs: 2000 });
    await engine.tick();
    const rec = recordingOf(s);
    await sleep(700);
    const during = await get(`/api/recordings/${rec.id}/playback`, bearer());
    assert.equal(during.status, 200, during.text);
    assert.deepEqual(Object.keys(during.body).sort(), ['container', 'durationSec', 'inProgress', 'url']);
    assert.equal(during.body.url, `/api/recordings/${rec.id}/index.m3u8`);
    assert.equal(during.body.container, 'hls');
    assert.equal(during.body.inProgress, true);
    assert.ok(during.body.durationSec >= 0);
    await until(() => recordings.getById(rec.id).status === 'completed');
    const after = await get(`/api/recordings/${rec.id}/playback`, bearer());
    assert.deepEqual(after.body, { url: `/api/recordings/${rec.id}/index.m3u8`, container: 'hls',
        durationSec: recordings.getById(rec.id).duration_sec, inProgress: false });

    // A .mkv recording (made before, or with the tuner off) answers exactly as before.
    const mkv = path.join(recordingsRoot, 'old.mkv');
    fs.writeFileSync(mkv, 'mkv');
    const old = recordings.create({ scheduled_id: 999, title: 'Old', channel_name: 'ABC', channel_logo: null,
        source_id: 2, channel_item_id: 'pos_9', file_path: mkv, started_at: Date.now() });
    recordings.finish(old.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 3, duration_sec: 60 });
    const oldAnswer = await get(`/api/recordings/${old.id}/playback`, bearer());
    assert.deepEqual(oldAnswer.body, { url: `/api/recordings/${old.id}/media.mp4`, container: 'mp4', durationSec: 60 });
});

test('watching and recording one channel is one tuner: the recording joins the viewer\'s, with no waiting and no 409', async () => {
    seed(URL_A, APPLE);
    const r = await fetch(`${base}/api/playback/resolve`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken('tv')}` },
        body: JSON.stringify({ sourceId: 2, channelId: 'pos_1', capabilities: APPLE }) });
    const viewer = await r.json();
    assert.equal(r.status, 200, JSON.stringify(viewer));
    const s = due({ lengthMs: 1500 });
    await engine.tick();
    assert.equal(scheduled.getById(s.id).status, 'recording', 'not waiting for the viewer');
    assert.equal(spawns.length, 1, 'one ffmpeg, one provider connection');
    const t = tuner.list()[0];
    assert.equal(t.viewers.size, 1);
    assert.deepEqual(t.recordingIds(), [s.id]);

    // The viewer leaves: the recording keeps the tuner.
    await fetch(`${base}/api/playback/${viewer.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deviceToken('tv')}` } });
    assert.equal(tuner.list().length, 1);
    await until(() => recordingOf(s).status === 'completed');
    assert.equal(tuner.list().length, 0, 'and it stops with the recording');
    assert.ok(recordingOf(s).duration_sec > 0);
});

test('while a recording holds the only slot, another channel is a 409 recording-in-progress; force keeps what was recorded', async () => {
    seed(URL_B, APPLE);
    const s = due({ lengthMs: 60000 });
    await engine.tick();
    await sleep(500);
    const body = { sourceId: 2, channelId: 'pos_2', capabilities: APPLE };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken('tv')}` };
    const refused = await fetch(`${base}/api/playback/resolve`, { method: 'POST', headers, body: JSON.stringify(body) });
    const conflict = await refused.json();
    assert.equal(refused.status, 409);
    assert.equal(conflict.conflict.type, 'recording-in-progress');
    assert.equal(conflict.conflict.scheduleId, s.id);
    const forced = await fetch(`${base}/api/playback/resolve`, { method: 'POST', headers, body: JSON.stringify({ ...body, force: true }) });
    assert.equal(forced.status, 200);
    const rec = recordingOf(s);
    assert.equal(rec.status, 'completed', 'what was captured is kept');
    assert.equal(rec.is_partial, 1);
    assert.equal(tuner.list().length, 1);
    assert.equal(tuner.list()[0].url, URL_B);
});

test('a viewer of the same channel with other capabilities needs its own tuner (not shared), so waits its turn like any other', async () => {
    seed(URL_A, WEB_TS);
    const s = due({ lengthMs: 60000 });
    await engine.tick();
    const r = await fetch(`${base}/api/playback/resolve`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken('web')}` },
        body: JSON.stringify({ sourceId: 2, channelId: 'pos_1', capabilities: WEB_TS }) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).conflict.type, 'recording-in-progress');
    assert.equal(scheduled.getById(s.id).status, 'recording');
});

test('the new routes take the same auth as media.mp4: ?token= or bearer, carried onto every URI', async () => {
    const s = due({ lengthMs: 1200 });
    await engine.tick();
    const rec = recordingOf(s);
    await until(() => recordings.getById(rec.id).status === 'completed');
    await db.settings.update({ requireStreamAuth: true });
    assert.equal((await get(`/api/recordings/${rec.id}/index.m3u8`)).status, 401);
    assert.equal((await get(`/api/recordings/${rec.id}/seg00000.m4s`)).status, 401);
    assert.equal((await get(`/api/recordings/${rec.id}/index.m3u8`, bearer())).status, 200);
    const withToken = await get(`/api/recordings/${rec.id}/index.m3u8?token=${encodeURIComponent(userToken)}`);
    assert.equal(withToken.status, 200);
    const q = `token=${encodeURIComponent(userToken)}`;
    assert.ok(withToken.text.includes(`#EXT-X-MAP:URI="init.mp4?${q}"`));
    for (const l of withToken.text.split('\n').filter(l => l && !l.startsWith('#'))) assert.ok(l.endsWith(`?${q}`), l);
    assert.equal((await get(`/api/recordings/${rec.id}/seg00000.m4s?${q}`)).status, 200);
    const sneaky = await get(`/api/recordings/${rec.id}/..%2F..%2Fdata%2Fdb.json?${q}`);
    assert.notEqual(sneaky.status, 200, 'only the recorder\'s names are served');
    assert.ok(!sneaky.text.includes('recordingsPath'));
});

test('once finished it is joined into one MP4 (stream copy) for download and ad detection; deleting removes the folder', async () => {
    const s = due({ lengthMs: 1200, title: 'Join Me' });
    await engine.tick();
    const id = recordingOf(s).id;
    await until(() => String(recordings.getById(id).file_path).endsWith('.mp4'));
    const rec = recordings.getById(id);
    assert.equal(joins.length, 1);
    const args = joins[0];
    assert.equal(args[args.indexOf('-i') + 1], path.join(rec.hls_dir, 'index.m3u8'));
    assert.ok(args.includes('copy') && args.includes('+faststart'), 'the native remux arguments: no re-encode');
    assert.equal(rec.file_path, path.join(rec.hls_dir, `${path.basename(rec.hls_dir)}.mp4`));
    assert.equal(rec.ad_detect_status, 'pending', 'queued for ad detection, as a finished .mkv is');
    assert.equal((await get(`/api/recordings/${id}/index.m3u8`)).status, 200, 'the HLS copy stays, for playback');
    const dl = await fetch(`${base}/api/recordings/${id}/download`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'joined-mp4');
    const stream = await fetch(`${base}/api/recordings/${id}/stream`);
    assert.equal(stream.headers.get('content-type'), 'video/mp4');

    const del = await fetch(`${base}/api/recordings/${id}`, { method: 'DELETE', headers: bearer() });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(rec.hls_dir), 'the folder is gone');
    assert.ok(fs.existsSync(path.join(recordingsRoot, 'News 24')), 'but not the channel folder');
    assert.equal((await get(`/api/recordings/${id}/index.m3u8`)).status, 404);
});

test('deleting a recording while it records stops it, releases the tuner and removes everything', async () => {
    const s = due({ lengthMs: 60000 });
    await engine.tick();
    await sleep(500);
    const rec = recordingOf(s);
    const del = await fetch(`${base}/api/recordings/${rec.id}`, { method: 'DELETE', headers: bearer() });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(rec.hls_dir));
    assert.equal(tuner.list().length, 0);
    assert.equal(joins.length, 0, 'nothing joined for a deleted recording');
});
