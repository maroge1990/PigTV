const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0124 (W2.2): GET /api/status for the web Status page. The real routes in a sandbox
// copy of the server: a live session whose URL carries provider credentials, a sync
// error that quotes a URL, scheduled recordings, and plays reported through the real
// client-event and resolve routes. The old code has no /api/status (404).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-status-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const playbackEvents = load('services/playbackEvents');

// The provider's credentials, in every form they reach the server in.
const SECRET = 'hunter2secret';
const STREAM_URL = `http://viewer:${SECRET}@provider.invalid/live/viewer/${SECRET}/441360.ts?token=${SECRET}`;

let server, base, adminToken, viewerToken, admin, source, session;

const get = async (route, token) => {
    const r = await fetch(`${base}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, body };
};
const post = (route, body, token = adminToken) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
});

before(async () => {
    admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: `http://viewer:${SECRET}@provider.invalid/get.php?password=${SECRET}` });

    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
               VALUES (?, ?, 'pos_7', 'live', 'Fox Sports 505', 'Sport', 0, 7, 's441360', ?)`).run(`${source.id}:pos_7`, source.id, STREAM_URL);
    d.prepare(`INSERT INTO sync_status (source_id, type, last_sync, status, error) VALUES (?, 'live', ?, 'error', ?)`)
        .run(source.id, Date.now() - 60000, `fetch failed: ${STREAM_URL}`);

    load('db/recordingsDb').initSchema(); // creates the recording tables
    const sched = d.prepare(`INSERT INTO scheduled_recordings (title, source_id, channel_item_id, channel_name, channel_logo, program_start, program_end, status, created_at)
                             VALUES (?, ?, 'pos_7', 'Fox Sports 505', ?, ?, ?, 'scheduled', ?)`);
    for (let i = 7; i >= 1; i--) {
        const start = Date.now() + i * 3600000;
        sched.run(`Show ${i}`, source.id, `http://logo.invalid/${SECRET}.png`, start, start + 1800000, Date.now());
    }

    // 0156: a schedule that ended up failed a few hours ago - the Status page's
    // "Recent problems" panel, same 7-day window as the Recordings page's.
    d.prepare(`INSERT INTO scheduled_recordings (title, source_id, channel_item_id, channel_name, channel_logo, program_start, program_end, status, error, created_at)
               VALUES (?, ?, 'pos_7', 'Fox Sports 505', ?, ?, ?, 'failed', ?, ?)`)
        .run('The Big Game', source.id, `http://logo.invalid/${SECRET}.png`, Date.now() - 3600000, Date.now() - 1800000,
            'Only 0.0 GB free at /app/recordings, below the 10 GB minimum', Date.now());

    // A live session on that channel. Its "ffmpeg" is node idling, so it is really running.
    session = await transcodeSession.createSession(STREAM_URL, {
        ffmpegPath: process.execPath, owner: `user:${admin.id}`, live: true, videoMode: 'copy', segmentType: 'fmp4',
        stallMs: 60000, startupMs: 60000
    });
    session.buildFFmpegArgs = () => ['-e', 'setTimeout(() => {}, 30000)'];
    await session.start();

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/status', load('routes/status'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await transcodeSession.removeSession(session.id).catch(() => {});
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('admin only: no token is a 401, a viewer a 403', async () => {
    assert.equal((await get('/api/status')).status, 401);
    assert.equal((await get('/api/status', viewerToken)).status, 403);
    assert.equal((await get('/api/status', adminToken)).status, 200);
});

test('the status document has the build, live sessions, recordings, recent plays, sync and disk', async () => {
    playbackEvents.reset();
    // A play as the web reports it: resolve notes the channel and how it started, then the
    // player's play-start and play-end arrive through the real client-event route.
    playbackEvents.noteResolve(`user:${admin.id}`, { channel: 'Fox Sports 505', start: 'warm', strategy: 'transcode', videoMode: 'copy' });
    assert.equal((await post('/api/playback/client-event', { event: 'play-start', strategy: 'transcode', container: 'hls', totalMs: 4230, resolveMs: 1500 })).status, 204);
    assert.equal((await post('/api/playback/client-event', { event: 'play-end', strategy: 'transcode', watchedSec: 95, stalls: 1 })).status, 204);
    // And a start that failed, through the real resolve route.
    const failed = await post('/api/playback/resolve', { sourceId: source.id, channelId: 'pos_404', capabilities: {} });
    assert.equal(failed.status, 404);

    const { status, body } = await get('/api/status', adminToken);
    assert.equal(status, 200);
    assert.equal(body.build.build, load('version').build);
    assert.ok(body.build.display);

    assert.equal(body.sessions.length, 1);
    const s = body.sessions[0];
    assert.equal(s.id, session.id);
    assert.equal(s.channel, 'Fox Sports 505', 'looked up from the stream identity (s441360)');
    assert.equal(s.owner, `user:${admin.id}`);
    assert.equal(s.video, 'copy');
    assert.equal(s.segmentType, 'fmp4');
    assert.equal(typeof s.uptimeSec, 'number');
    assert.equal(typeof s.idleSec, 'number');
    assert.match(s.ffmpeg, /^running/);

    assert.deepEqual(body.recordings.active, []);
    assert.deepEqual(body.recordings.upcoming.map(r => r.title), ['Show 1', 'Show 2', 'Show 3', 'Show 4', 'Show 5'], 'the next five, soonest first');

    // 0156: a missed/failed schedule from the last 7 days - invisible before this
    // build, in both this document and the plain scheduled list.
    assert.deepEqual(body.recentProblems.map(r => r.title), ['The Big Game']);
    assert.equal(body.recentProblems[0].status, 'failed');
    assert.match(body.recentProblems[0].error, /Only 0\.0 GB free/);
    assert.ok(!body.recordings.upcoming.some(r => r.title === 'The Big Game'), 'a failure never shows up as upcoming');

    assert.deepEqual(body.events.map(e => e.type), ['failure', 'play-end', 'play-start'], 'newest first');
    const [failure, end, start] = body.events;
    assert.equal(start.channel, 'Fox Sports 505');
    assert.equal(start.firstPictureSec, 4.2);
    assert.equal(start.resolveSec, 1.5);
    assert.equal(start.start, 'warm');
    assert.equal(end.watchedSec, 95);
    assert.equal(end.stalls, 1);
    assert.match(failure.reason, /^This channel is not available/, 'the client-safe resolve error');

    const src = body.sync.find(x => x.sourceId === source.id);
    assert.equal(src.name, 'Household');
    assert.equal(src.feeds[0].status, 'error');
    assert.match(src.feeds[0].error, /fetch failed: \[url removed\]/);

    assert.equal(typeof body.disk.transcodeCache.available, 'boolean');
    assert.equal(typeof body.disk.recordings.available, 'boolean');
    if (body.disk.transcodeCache.available) assert.ok(body.disk.transcodeCache.freeBytes > 0);
});

test('never a provider URL: not the session\'s, the sync error\'s, a logo\'s or the source\'s', async () => {
    const { text } = await get('/api/status', adminToken);
    assert.ok(!text.includes(SECRET), 'no credential');
    assert.ok(!text.includes('provider.invalid'), 'no provider host');
    assert.ok(!text.includes('logo.invalid'), 'no stored logo URL');
    assert.ok(!text.includes('://'), 'nothing URL-shaped at all');
});

test('0176: the status document lists providers with state, connections and expiry, and names each session\'s provider', async () => {
    const { body, text } = await get('/api/status', adminToken);
    assert.ok(Array.isArray(body.providers));
    const p = body.providers.find(x => x.id === source.id);
    assert.ok(p, 'the stream source is listed');
    assert.equal(p.name, 'Household');
    assert.equal(p.role, 'primary');
    assert.equal(p.state, 'up');
    assert.deepEqual(Object.keys(p.connections).sort(), ['limit', 'used']);
    assert.equal(p.accountOk, null, 'never read: neither OK nor an error');
    assert.deepEqual(Object.keys(p).sort(), ['accountCheckedAt', 'accountOk', 'connections', 'downUntil', 'enabled', 'expired',
        'expiresAt', 'expirySource', 'id', 'name', 'role', 'state', 'uses'], 'whitelisted fields only');
    assert.ok(!text.includes(SECRET));
    assert.ok('provider' in body.sessions[0], 'sessions carry a provider name field');
});

test('R16: the status document carries the preparation queue, loop delay, sport builds and connection use', async () => {
    const { body, text, status } = await get('/api/status', adminToken);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.preparation.counts).sort(), ['failed', 'pending', 'preparing', 'ready']);
    assert.ok('current' in body.preparation && 'lastError' in body.preparation);
    for (const w of ['sinceStart', 'lastMinute']) assert.deepEqual(Object.keys(body.loopDelay[w]).sort(), ['max', 'p50', 'p99']);
    assert.ok('lastBuildMs' in body.sportEvents && 'lastMaxLoopDelayMs' in body.sportEvents && 'staleSinceMs' in body.sportEvents);
    const p = body.providers.find(x => x.id === source.id);
    assert.ok(Array.isArray(p.uses));
    for (const u of p.uses) assert.deepEqual(Object.keys(u).sort(), ['ageSec', 'channel', 'purpose']);
    assert.ok(!text.includes(SECRET));
    assert.equal((await get('/api/status', viewerToken)).status, 403, 'a viewer sees none of it');
});

test('R16: the preparation summary counts by native_status and reports the last failure', () => {
    const rdb = load('db/recordingsDb').recordings;
    const d = sqlite.getDb();
    const ins = d.prepare(`INSERT INTO recordings (title, status, file_path, native_status, native_error, ended_at) VALUES (?, 'completed', ?, ?, ?, ?)`);
    ins.run('A', '/x/a.mp4', 'pending', null, 1);
    ins.run('B', '/x/b.mp4', 'failed', 'remux failed', 2);
    const s = rdb.nativeQueueSummary();
    assert.ok(s.counts.pending >= 1 && s.counts.failed >= 1);
    assert.equal(s.lastError.error, 'remux failed');
});

test('the recent-plays buffer keeps the last 50, newest first', () => {
    playbackEvents.reset();
    for (let i = 1; i <= 60; i++) playbackEvents.record({ type: 'play-end', channel: `Channel ${i}`, watchedSec: i });
    const recent = playbackEvents.recent();
    assert.equal(playbackEvents.MAX_EVENTS, 50);
    assert.equal(recent.length, 50);
    assert.equal(recent[0].channel, 'Channel 60');
    assert.equal(recent[49].channel, 'Channel 11');
    playbackEvents.record({ type: 'failure', reason: `Server returned 403 for ${STREAM_URL}` });
    assert.ok(!playbackEvents.recent()[0].reason.includes(SECRET), 'a URL handed to the buffer is removed on the way in');
});
