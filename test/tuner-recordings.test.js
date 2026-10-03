const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0127 (T2) and 0129 (T4): with PIGTV_TUNER=1 a scheduled recording takes its
// segments from a tuner - a live viewer's when one is on the channel (one provider
// connection for both), or one started just for it - into its own folder with its
// own playlist: EVENT while recording (playable from its start, T4), VOD with
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

// Timeshift is on (the default): the tuners live in <recordings>/.timeshift. Plenty of
// room, whatever the machine running this has.
tuner.hooks.freeSpaceGB = () => 1000;

let spawns = [];
let script = {};
tuner.hooks.spawnArgs = (t) => { spawns.push(t.id); return fakeHlsArgs({ ext: t.options.segmentType === 'fmp4' ? 'm4s' : 'ts', everyMs: 200, duration: 0.2, ...script }); };

let joins = [];
engine._nativeTools.codecs = async () => ({ video: 'h264', audio: 'aac' });
engine._nativeTools.duration = async () => null;
engine._nativeTools.ffmpeg = async (args) => {
    joins.push(args);
    fs.writeFileSync(args[args.length - 1], 'joined-mp4');
    return { code: 0, tail: [] };
};

let server, base, userToken, ownerId;
function deviceToken(deviceId) {
    sqlite.getDb().prepare(
        'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, String(ownerId), deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: ownerId, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    ownerId = user.id; // stream auth (R01) looks the token's user up, so device tokens must name the real account
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
    app.locals.ffmpegPath = process.execPath;
    app.locals.ffprobePath = path.join(sandbox, 'no-ffprobe');
    const streamAuth = auth.streamAuth;
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
    script = {};
    await db.settings.update({ maxProviderStreams: 1 });
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    delete process.env.PIGTV_TUNER;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// Stream auth is always on (R01), so a request carries the owner's bearer unless a test passes {} to go without.
async function get(route, headers = bearer()) {
    const r = await fetch(`${base}${route}`, { headers });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, body, headers: r.headers };
}
const bearer = () => ({ Authorization: `Bearer ${userToken}` });

let n = 0;
function due({ pos = 'pos_1', startInMs = -300, lengthMs = 4000, title } = {}) {
    n++;
    return scheduled.create({
        title: title || `Show ${n}`, description: null, source_id: 2, channel_item_id: pos,
        channel_name: 'News 24', channel_logo: null,
        program_start: Date.now() + startInMs, program_end: Date.now() + startInMs + lengthMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: Date.now()
    });
}
async function until(fn, ms = 20000) {
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
        const r = await fetch(`${base}/api/recordings/${rec.id}/${f}`, { headers: bearer() });
        assert.equal(r.status, 200, f);
    }
});

test('the playback answer (C-E): hls while recording (inProgress, growing), then finished; the old shape for .mkv recordings', async () => {
    const s = due({ lengthMs: 5000 });
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
    const s = due({ lengthMs: 3000 });
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

test('the new routes take the same auth as media.mp4 (always enforced): ?token= or bearer, carried onto every URI', async () => {
    const s = due({ lengthMs: 3000 });
    await engine.tick();
    const rec = recordingOf(s);
    await until(() => recordings.getById(rec.id).status === 'completed');
    assert.equal((await get(`/api/recordings/${rec.id}/index.m3u8`, {})).status, 401);
    assert.equal((await get(`/api/recordings/${rec.id}/seg00000.m4s`, {})).status, 401);
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
    const s = due({ lengthMs: 3000, title: 'Join Me' });
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
    const dl = await fetch(`${base}/api/recordings/${id}/download`, { headers: bearer() });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'joined-mp4');
    const stream = await fetch(`${base}/api/recordings/${id}/stream`, { headers: bearer() });
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

test('T4: an in-progress recording plays from its start with no live viewer, without disturbing it; inProgress flips with ENDLIST', async () => {
    const s = due({ lengthMs: 4000 });
    await engine.tick();
    const rec = recordingOf(s);
    await sleep(600);
    // A client plays it from the start: playlist, init and the first segments.
    const answer = (await get(`/api/recordings/${rec.id}/playback`, bearer())).body;
    assert.equal(answer.inProgress, true);
    const first = await get(answer.url);
    assert.match(first.text, /#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-START:TIME-OFFSET=0\.0\n/,
        'EXT-X-START: a player starts at the beginning, not the live end an EVENT playlist otherwise gets');
    assert.equal((await fetch(`${base}/api/recordings/${rec.id}/init.mp4`, { headers: bearer() })).status, 200);
    assert.equal((await fetch(`${base}/api/recordings/${rec.id}/seg00000.m4s`, { headers: bearer() })).status, 200);
    assert.equal(tuner.list()[0].viewers.size, 0, 'playing a recording is not a tuner viewer: no provider slot, no idle rules');
    // It grows under the player (EVENT: only appended to). The tuner is read once a second.
    await sleep(1300);
    const later = await get(answer.url);
    assert.ok(later.text.startsWith(first.text.split('\n').slice(0, -1).join('\n')), `the start of the playlist never changes:\n${first.text}\n---\n${later.text}`);
    assert.ok(later.text.length > first.text.length);
    await until(() => recordings.getById(rec.id).status === 'completed');
    const final = (await get(`/api/recordings/${rec.id}/playback`, bearer())).body;
    assert.equal(final.inProgress, false);
    const vod = (await get(answer.url)).text;
    assert.match(vod, /#EXT-X-ENDLIST\n$/);
    assert.match(vod, /#EXT-X-START:TIME-OFFSET=0\.0\n/);
    assert.equal(scheduled.getById(s.id).status, 'completed');
});

test('T4: Play pressed the moment a recording starts waits for its first segment instead of getting an empty playlist', async () => {
    script = { firstAfterMs: 1500 }; // the tuner is slow to its first segment (probe + ffmpeg start)
    const s = due({ lengthMs: 6000 });
    const ticking = engine.tick();
    await until(() => scheduled.getById(s.id).status === 'recording', 3000);
    const rec = recordingOf(s);
    assert.equal(rec.status, 'recording');
    const t0 = Date.now();
    const answer = await get(`/api/recordings/${rec.id}/playback`, bearer());
    assert.equal(answer.status, 200);
    assert.equal(answer.body.inProgress, true);
    const waited = Date.now() - t0;
    assert.ok(waited > 500 && waited < 9000, `held until the first segment (${waited} ms)`);
    assert.ok(engine.tunedRecordingProgress(rec.id).segments >= 1, 'answered once there was something to play');
    const playlist = await get(answer.body.url);
    assert.match(playlist.text, /\nseg00000\.m4s\n/, 'never an empty playlist');
    await ticking;
});

test('T4: a finished recording is not held up by the wait', async () => {
    const s = due({ lengthMs: 3000 });
    await engine.tick();
    const rec = recordingOf(s);
    await until(() => recordings.getById(rec.id).status === 'completed');
    const t0 = Date.now();
    assert.equal((await get(`/api/recordings/${rec.id}/playback`, bearer())).body.inProgress, false);
    assert.equal((await get(`/api/recordings/${rec.id}/index.m3u8`)).status, 200);
    assert.ok(Date.now() - t0 < 3000, 'no wait');
});

test('0130: an Apple TV tuning to an HE-AAC channel that is being recorded joins the recording\'s tuner (no 409)', async () => {
    // The provider's 7 channels: H.264 + HE-AAC. The recording starts first, on a tuner of its own.
    const HEAAC = { streams: [RAW.streams[0], { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2 }], format: { format_name: 'mpegts' } };
    const put = (caps) => {
        const c = { ...strategy.DEFAULT_CAPABILITIES, ...caps };
        probeCache.set(`${URL_B}|${db.getUserAgent({}) || ''}|${Object.keys(c).filter(k => c[k]).sort().join(',')}`,
            { result: analyzeProbeResult(HEAAC, URL_B, c), timestamp: Date.now() });
    };
    put(strategy.RECORDING_CAPABILITIES);
    put(APPLE);
    try {
        const s = due({ pos: 'pos_2', lengthMs: 60000 });
        await engine.tick();
        assert.equal(scheduled.getById(s.id).status, 'recording');
        assert.equal(spawns.length, 1);
        const r = await fetch(`${base}/api/playback/resolve`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken('tv')}` },
            body: JSON.stringify({ sourceId: 2, channelId: 'pos_2', capabilities: APPLE }) });
        assert.equal(r.status, 200, 'shared, not "recording in progress"');
        assert.equal(spawns.length, 1, 'one tuner for both');
        assert.equal(tuner.list()[0].viewers.size, 1);
        assert.deepEqual(tuner.list()[0].recordingIds(), [s.id]);
    } finally {
        // Leave URL_B as the H.264 + AAC-LC channel the other tests expect.
        seed(URL_B, strategy.RECORDING_CAPABILITIES);
        seed(URL_B, APPLE);
    }
});

test('0131: a recording whose tuner dies lets go of it and takes the channel up again (new init segment, discontinuity)', async () => {
    const s = due({ lengthMs: 60000 });
    await engine.tick();
    const first = tuner.list()[0];
    await until(() => first.window.length >= 2);
    await sleep(300);
    first.process.kill('SIGKILL'); // the tuner's ffmpeg dies (not asked to)
    await until(() => !tuner.list().includes(first), 5000);
    assert.ok(!tuner.list().includes(first), 'the dead tuner is released, not kept by the recording\'s hold');
    await engine.tick(); // the recording takes the channel up again
    assert.equal(spawns.length, 2);
    const second = tuner.list()[0];
    assert.deepEqual(second.recordingIds(), [s.id]);
    const rec = recordingOf(s);
    await until(async () => (await get(`/api/recordings/${rec.id}/index.m3u8`)).text.includes('init-2.mp4'));
    const text = (await get(`/api/recordings/${rec.id}/index.m3u8`)).text;
    assert.match(text, /\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-2\.mp4"\n/);
    assert.ok(fs.existsSync(path.join(rec.hls_dir, 'init-2.mp4')));
    assert.equal(scheduled.getById(s.id).status, 'recording');
});

// 0155: compatible joining. Since app build 27 the Apple client always sends heaac: true,
// so on an HE-AAC channel its own arguments (HE-AAC copied into fMP4) differ from a
// recording's (planned without heaac: AAC-LC in MPEG-TS). A viewer now joins a running
// tuner on the same stream whose output it can play, instead of needing a second slot.
const URL_C = 'http://provider.invalid/live/u/p/441399.ts'; // H.264 + HE-AAC (the 7 channels)
const URL_D = 'http://provider.invalid/live/u/p/441400.ts'; // HEVC + AAC-LC
const RAW_HEAAC = { streams: [RAW.streams[0], { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2 }], format: { format_name: 'mpegts' } };
const RAW_HEVC = { streams: [{ ...RAW.streams[0], codec_name: 'hevc' }, RAW.streams[1]], format: { format_name: 'mpegts' } };
const APPLE_27 = { ...APPLE, heaac: true };
const WEB = { segmentedDelivery: true, fmp4: true }; // hls.js: fMP4, no HEVC, no HE-AAC
function seedRaw(url, raw, capabilities) {
    const c = { ...strategy.DEFAULT_CAPABILITIES, ...capabilities };
    probeCache.set(`${url}|${db.getUserAgent({}) || ''}|${Object.keys(c).filter(k => c[k]).sort().join(',')}`,
        { result: analyzeProbeResult(raw, url, c), timestamp: Date.now() });
}
function resolveAs(device, pos, capabilities) {
    return fetch(`${base}/api/playback/resolve`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken(device)}` },
        body: JSON.stringify({ sourceId: 2, channelId: pos, capabilities }) });
}
async function withLogs(fn) {
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); log(...a); };
    try { return { result: await fn(), lines }; } finally { console.log = log; }
}

test('0155: an Apple TV (heaac: true) joins a recording\'s tuner on an HE-AAC channel: no 409, no second ffmpeg; the answer describes that tuner', async () => {
    channel('pos_3', URL_C);
    seedRaw(URL_C, RAW_HEAAC, strategy.RECORDING_CAPABILITIES);
    const s = due({ pos: 'pos_3', lengthMs: 60000 });
    await engine.tick();
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.equal(spawns.length, 1);
    const t = tuner.list()[0];
    assert.deepEqual({ ...t.output }, { video: 'h264', videoCopied: true, segmentType: 'mpegts', audio: 'aac', audioCopied: false, videoRange: 'SDR' },
        'the recording\'s tuner: H.264 copied, HE-AAC re-encoded to AAC-LC, MPEG-TS');

    // Not seeded for the Apple TV: its analysis is the running tuner's, re-read for its capabilities.
    const { result: r, lines } = await withLogs(() => resolveAs('tv', 'pos_3', APPLE_27));
    const decision = await r.json();
    assert.equal(r.status, 200, JSON.stringify(decision));
    assert.equal(spawns.length, 1, 'one ffmpeg, one provider connection');
    assert.equal(tuner.list().length, 1);
    assert.equal(t.viewers.size, 1);
    assert.deepEqual(t.recordingIds(), [s.id]);
    // What the joined tuner writes, not what the TV would ideally have had (fMP4, HE-AAC copied).
    assert.equal(decision.segmentType, 'mpegts');
    assert.equal(decision.videoMode, 'copy');
    assert.equal(decision.url, `/api/transcode/${decision.sessionId}/master.m3u8`);
    assert.ok(lines.some(l => l.includes(`joined compatible tuner ${t.id} (viewer wanted `) && l.includes('fmp4 segments') && l.includes('HE-AAC copied')),
        lines.join('\n'));
    const master = await get(`/api/transcode/${decision.sessionId}/master.m3u8`);
    assert.equal(master.status, 200);
    assert.match(master.text, /VIDEO-RANGE=SDR/);
    assert.match(master.text, /FRAME-RATE=25\.000/);
});

test('0155: a viewer that cannot play the running tuner\'s output (web, no HEVC, on a copied-HEVC tuner) still needs its own: 409, or a new tuner with a free slot', async () => {
    channel('pos_4', URL_D);
    seedRaw(URL_D, RAW_HEVC, strategy.RECORDING_CAPABILITIES);
    seedRaw(URL_D, RAW_HEVC, WEB);
    const s = due({ pos: 'pos_4', lengthMs: 60000 });
    await engine.tick();
    assert.equal(tuner.list()[0].output.video, 'hevc');
    assert.equal(tuner.list()[0].output.segmentType, 'fmp4');

    const refused = await resolveAs('web', 'pos_4', WEB);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).conflict.type, 'recording-in-progress');
    assert.equal(spawns.length, 1);

    await db.settings.update({ maxProviderStreams: 2 });
    const r = await resolveAs('web', 'pos_4', WEB);
    const decision = await r.json();
    assert.equal(r.status, 200, JSON.stringify(decision));
    assert.equal(spawns.length, 2, 'a tuner of its own');
    assert.equal(tuner.list().length, 2);
    const own = tuner.list().find(t => t.viewers.size === 1);
    assert.equal(own.output.video, 'h264', 'HEVC encoded to H.264 for the browser');
    assert.equal(scheduled.getById(s.id).status, 'recording');
});

test('0155: an exact match is still preferred over a compatible tuner with more segments', async () => {
    channel('pos_3', URL_C);
    seedRaw(URL_C, RAW_HEAAC, APPLE_27);
    await db.settings.update({ maxProviderStreams: 3 });
    // The TV's own tuner (HE-AAC copied, fMP4), slow to write segments...
    script = { everyMs: 1000 };
    const first = await resolveAs('tv1', 'pos_3', APPLE_27);
    assert.equal(first.status, 200);
    const exact = tuner.list()[0];
    assert.equal(exact.output.audio, 'heaac');
    // ...then the web's (AAC-LC in MPEG-TS; it cannot play HE-AAC, so no joining), quicker.
    script = {};
    const web = await resolveAs('web', 'pos_3', WEB);
    assert.equal(web.status, 200);
    assert.equal(spawns.length, 2);
    const other = tuner.list().find(t => t !== exact);
    assert.equal(other.output.audio, 'aac');
    assert.ok(await until(() => other.window.length > exact.window.length + 2, 5000), 'the compatible tuner has more segments');

    // A second TV could play either; it joins the one with its own arguments.
    const { result: r, lines } = await withLogs(() => resolveAs('tv2', 'pos_3', APPLE_27));
    const decision = await r.json();
    assert.equal(r.status, 200, JSON.stringify(decision));
    assert.equal(spawns.length, 2);
    assert.equal(exact.viewers.size, 2);
    assert.equal(other.viewers.size, 1);
    assert.equal(decision.segmentType, 'fmp4');
    assert.ok(!lines.some(l => l.includes('joined compatible tuner')));
});
