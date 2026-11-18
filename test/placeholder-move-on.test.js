const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// #348: a live play that turns out to be the provider's placeholder moves on by itself. Production, 18 Nov (0819):
// Sportsnet Event's only stream answered with a 10-minute 1080p30 file (the shared ingest refused it as "a file with a
// length"), the play went on without a feed, and the 20 s blank verdict only noted it: the viewer sat on black. The real
// route, strategy and sessions against a fake provider over local HTTP (never a real one): the placeholder file is caught
// at resolve (the next candidate, else C-B's "not available right now"); a long real-rate file still plays.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-move-on-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const ingest = load('services/ingest');
const routing = load('services/providerRouting');
const interruptions = load('services/playbackInterruptions');
const playbackEvents = load('services/playbackEvents');
const channelProfiles = load('services/channelProfiles');
const sportsEvents = load('services/sportsEvents');
const { ALLOWED_PREFIXES } = load('services/playbackErrors');
const { probeCache } = load('services/streamProbe');

const PLACEHOLDER_TEXT = 'This channel is not available right now: nothing is on this stream at the moment.';

// ---- the provider: '/file*.ts' a file with a length (the placeholder file); '/longfile.ts' a long real file;
// '/real*.ts' a live feed (no length, never ends) ----
let connections = {};
const stalled = [];
let stalledClosed = 0;
let provider, base;
function liveFeed(res) {
    const timer = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(188 * 40, 0x47)); }, 50);
    res.on('close', () => clearInterval(timer));
}

// ---- the tools: ffprobe answers by the stream's name (the placeholder file: 10 min at 1080p30; '/file25': 10 min at
// 1080p25; the long file: 2 h at 720p25; a live feed: 1080p25, no length); a session's ffmpeg writes its playlist and
// runs until stopped ----
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.length - 1];
fs.writeFileSync(require('path').join(require('path').dirname(out), 'seg0000.ts'), Buffer.alloc(2000));
fs.writeFileSync(out, '#EXTM3U\\n#EXT-X-TARGETDURATION:4\\n#EXTINF:4,\\nseg0000.ts\\n');
if (args[args.indexOf('-i') + 1] === 'pipe:0') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
setInterval(() => {}, 1000);
`);
const FFPROBE = path.join(sandbox, 'ffprobe-fake');
fs.writeFileSync(FFPROBE, `#!${process.execPath}
const args = process.argv.slice(2);
const target = args.find(a => /^https?:/.test(a)) || '';
let video = { width: 1920, height: 1080, avg_frame_rate: '25/1' }, format = { format_name: 'mpegts' };
if (/\\/file25/.test(target)) { video = { width: 1920, height: 1080, avg_frame_rate: '25/1' }; format = { format_name: 'mpegts', duration: '600.0', size: '9000000' }; }
else if (/\\/file/.test(target)) { video = { width: 1920, height: 1080, avg_frame_rate: '30/1' }; format = { format_name: 'mpegts', duration: '600.0', size: '9000000' }; }
else if (/\\/hls/.test(target)) { video = { width: 1920, height: 1080, avg_frame_rate: '30/1' }; format = { format_name: 'hls' }; }
else if (/\\/longfile/.test(target)) { video = { width: 1280, height: 720, avg_frame_rate: '25/1' }; format = { format_name: 'mpegts', duration: '7200.0', size: '3000000000' }; }
const answer = () => { process.stdout.write(JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', ...video },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 } ], format })); process.exit(0); };
if (args[args.length - 1] === 'pipe:0') { let got = 0; process.stdin.on('data', d => { got += d.length; if (got > 2000) answer(); }); process.stdin.on('end', answer); }
else answer();
`);
for (const f of [FFMPEG, FFPROBE]) fs.chmodSync(f, 0o755);

let A, B, server, routeBase, userId;
function tokenFor(deviceId) {
    sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(deviceId, String(userId), deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: userId, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function play(channelId, extra = {}, device = 'device:tv') {
    const response = await fetch(`${routeBase}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(device)}` },
        body: JSON.stringify({ sourceId: A.id, channelId, capabilities: { segmentedDelivery: true }, ...extra })
    });
    return { status: response.status, body: await response.json() };
}

before(async () => {
    provider = http.createServer((req, res) => {
        const [p] = req.url.split('?');
        connections[p] = (connections[p] || 0) + 1;
        if (p.startsWith('/stall')) { stalled.push(req); req.on('close', () => { stalledClosed++; }); return; } // headers never come
        if (p.startsWith('/hls')) {
            // A live HLS playlist: its answer has a length (the manifest's), its media does not end.
            const body = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4,\nseg7.ts\n');
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(body.length) });
            return res.end(body);
        }
        if (p.startsWith('/file') || p.startsWith('/longfile')) {
            const body = Buffer.alloc(188 * 100, 0x47);
            res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
            return res.end(body);
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return liveFeed(res);
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;

    userId = (await db.users.create({ username: 'owner', role: 'admin' })).id;
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    B = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://backup.invalid/list.m3u', role: 'backup', priority: 1 });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                         VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    // Each name is its own channel (a same-provider copy is found by name).
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'TNT Sports 1', 1, 's101', `${base}/file1.ts`);       // has a backup that plays
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'Sportsnet Event', 2, 's1803789', `${base}/file2.ts`); // nothing else
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'Movie Loop', 3, 's103', `${base}/longfile.ts`);     // a long real file
    item.run(`${A.id}:pos_4`, A.id, 'pos_4', 'Racing Replay', 4, 's104', `${base}/file25.ts`);      // a short 25 fps file
    item.run(`${A.id}:pos_5`, A.id, 'pos_5', 'Sportsnet One', 5, 's105', `${base}/real5.ts`);      // a live channel
    item.run(`${A.id}:pos_6`, A.id, 'pos_6', 'Sportsnet East', 6, 's106', `${base}/file6.ts`);     // the placeholder too
    item.run(`${A.id}:pos_7`, A.id, 'pos_7', 'Sportsnet Ontario', 7, 's107', `${base}/real7.ts`);  // a live channel
    item.run(`${A.id}:pos_8`, A.id, 'pos_8', 'TSN 4', 8, 's108', `${base}/file8.ts`);             // in two live games
    item.run(`${A.id}:pos_9`, A.id, 'pos_9', 'NHL Center Ice 1', 9, 's1803789', `${base}/file9.ts`); // Sportsnet Event's stream again
    item.run(`${A.id}:pos_10`, A.id, 'pos_10', 'TSN 5', 10, 's110', `${base}/real10.ts`);          // a live channel
    item.run(`${A.id}:pos_11`, A.id, 'pos_11', 'Sky Sports Arena', 11, 's111', `${base}/hls11.m3u8`); // a live HLS channel, 1080p30
    item.run(`${B.id}:pos_1`, B.id, 'pos_1', 'Sportsnet West', 1, 'sw1', `${base}/realB.ts`);       // on the backup's own pool (1 connection)
    sqlite.getDb().prepare(`INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, '901', 'TNT Sports 1', ?)`).run(B.id, `${base}/real.ts`);
    sqlite.getDb().prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, updated_at)
                            VALUES (?, 's101', ?, '901', 'exact', 'auto', 1, ?)`).run(A.id, B.id, Date.now());
    await db.settings.update({ maxProviderStreams: 2, sharedIngestEnabled: true, relayEnabled: false });

    const app = express();
    app.use(express.json());
    app.locals.ffmpegPath = FFMPEG;
    app.locals.ffprobePath = FFPROBE;
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    routeBase = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    sportsEvents._useBuilt(null);
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    coordinator._leases.clear();
    ingest.closeAll('test over');
    probeCache.clear();
    routing.reset();
    interruptions.reset();
    playbackEvents.reset();
    connections = {};
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    provider?.closeAllConnections?.(); provider?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

function captureLog() {
    const lines = [];
    const log = console.log, warn = console.warn, error = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => { console.log = log; console.warn = warn; console.error = error; } };
}
const profileCount = () => sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM channel_profiles').get().n;
/** The probe cache and profile key the strategy uses for this stream and the test's capabilities. */
async function analysisKeyOf(p) {
    const strategy = load('services/playbackStrategy');
    const caps = { ...strategy.DEFAULT_CAPABILITIES, segmentedDelivery: true };
    const capKey = Object.keys(caps).filter(k => caps[k]).sort().join(',');
    const userAgent = db.getUserAgent(await db.settings.get());
    return { key: `${base}${p}|${userAgent || ''}|${capKey}`, caps };
}

// ---- part 1: the placeholder file, caught at resolve ------------------------------------------------------------

test('the placeholder file (10 min at 1080p30) is never started: the play goes to the next candidate', async () => {
    const r = await play('pos_1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider.name, 'Dream 4K');
    assert.equal(r.body.provider.failover, true);
    assert.equal(routing.isPlaceholder(A.id, 's101'), true, 'held back PLACEHOLDER_MS');
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
    assert.equal(transcodeSession.getAllSessions().length, 1, 'only the backup\'s session');
});

test('the placeholder file with no other candidate (and no game) answers C-B\'s "not available right now"; its analysis is not kept', async () => {
    const profiles = profileCount();
    const log = captureLog();
    let r;
    try { r = await play('pos_2'); } finally { log.restore(); }
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, PLACEHOLDER_TEXT);
    assert.ok(ALLOWED_PREFIXES.some(p => r.body.error.startsWith(p)), 'a C-B text the clients show');
    assert.equal(transcodeSession.getAllSessions().length, 0, 'no session started on the slate');
    assert.equal(probeCache.size, 0, 'the slate\'s probe is not cached');
    assert.equal(profileCount(), profiles, 'nor kept as the channel\'s profile');
    assert.ok(log.lines.some(l => /the provider's placeholder, not the channel/.test(l)), log.lines.join('\n'));
    assert.ok(!log.lines.some(l => l.includes(base)), 'no provider URL in the log');
    const before = connections['/file2.ts'];
    const again = await play('pos_2');
    assert.equal(again.status, 503);
    assert.equal(again.body.error, PLACEHOLDER_TEXT);
    assert.equal(connections['/file2.ts'], before, 'held back: no connection for it');
});

test('a profile kept by an earlier undetected play of the placeholder file is dropped, not reused', async () => {
    // An earlier build played the slate and kept its analysis as the channel's profile.
    const first = await play('pos_2');
    assert.equal(first.status, 503);
    routing.reset();
    const { analyzeProbeResult } = load('services/streamProbe');
    const { key, caps } = await analysisKeyOf('/file2.ts');
    const info = analyzeProbeResult({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }], format: { format_name: 'mpegts', duration: '600.0' } }, `${base}/file2.ts`, caps);
    channelProfiles.save(key, info, Date.now());
    assert.ok(channelProfiles.get(key));
    const before = connections['/file2.ts'] || 0;
    const r = await play('pos_2');
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, PLACEHOLDER_TEXT);
    assert.equal(connections['/file2.ts'] || 0, before, 'caught from the profile: no connection at all');
    assert.equal(channelProfiles.get(key), null, 'the slate\'s profile is dropped');
});

test('a long real-rate file on a live channel plays as before; a 10-minute file of another shape is still the placeholder file', async () => {
    const r = await play('pos_3');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.strategy, 'transcode');
    assert.equal(routing.isPlaceholder(A.id, 's103'), false);
    // A file of at most 15 min is the provider's placeholder file whatever its shape (#333's rule for recordings).
    const short = await play('pos_4');
    assert.equal(short.status, 503, JSON.stringify(short.body));
    assert.equal(routing.isPlaceholder(A.id, 's104'), true);
});

test('the rule: a source with a length that has the slate\'s shape or lasts at most 15 min', () => {
    const { isPlaceholderFile } = load('services/playbackStrategy');
    const shape = { width: 1920, height: 1080, fps: 30 };
    assert.equal(isPlaceholderFile({ ...shape, finite: true, durationSec: 7200 }), true, 'the slate\'s shape');
    assert.equal(isPlaceholderFile({ width: 1280, height: 720, fps: 25, finite: true, durationSec: 600 }), true, '10 min');
    assert.equal(isPlaceholderFile({ width: 1280, height: 720, fps: 25, finite: true, durationSec: 7200 }), false, 'a long real file');
    assert.equal(isPlaceholderFile({ width: 1920, height: 1080, fps: 29.97, finite: true, durationSec: 7200 }), false, '29.97 is a real US channel\'s');
    assert.equal(isPlaceholderFile({ ...shape, finite: false, durationSec: null }), false, 'a live stream');
    assert.equal(isPlaceholderFile({ ...shape, container: 'hls', finite: true, durationSec: null }), false, 'an HLS manifest\'s size');
    assert.equal(isPlaceholderFile({ ...shape, container: 'hls', finite: true, durationSec: 600 }), true, 'a 10-minute HLS VOD list');
    assert.equal(isPlaceholderFile({ ...shape, finite: false }), false,
        'the ingest\'s Content-Length alone is no evidence the media ends (an HLS manifest has one)');
});

// ---- part 2: mid-play, a feed-less blank verdict with the placeholder's shape ends the play as the placeholder --------

/** A live session that has played 24 s at `kbps` (its folder kept, nothing spawned), watched as the route watches it. */
function playedSession(name, options, { kbps = 117 } = {}) {
    const dir = fs.mkdtempSync(path.join(sandbox, `played-${name}-`));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
    for (let i = 0; i < 6; i++) {
        const seg = `seg${String(i).padStart(4, '0')}.ts`;
        fs.writeFileSync(path.join(dir, seg), Buffer.alloc(Math.round((kbps * 1000 / 8) * 4)));
        lines.push('#EXTINF:4.000000,', seg);
    }
    fs.writeFileSync(path.join(dir, 'stream.m3u8'), lines.join('\n') + '\n');
    const s = new transcodeSession.TranscodeSession(`${base}/file2.ts`, { live: true, segmentType: 'mpegts', videoMode: 'copy', height: 1080, providerId: A.id, ...options });
    s.dir = dir;
    s.playlistPath = path.join(dir, 'stream.m3u8');
    s.retainDir = true;
    s.timings.playlistReady = Date.now();
    const seen = { lost: [], blank: [], placeholder: 0 };
    s.on('lost', (info) => seen.lost.push(info));
    s.on('blank', (info) => seen.blank.push(info));
    s.on('placeholder', () => { seen.placeholder++; });
    return { s, seen };
}

test('mid-play: a feed-less blank picture with the placeholder\'s shape ends the play as the placeholder, held back 3 min', async () => {
    const { s, seen } = playedSession('slate', { width: 1920, fps: '30/1', paceInput: false });
    const candidate = { providerId: A.id, providerName: 'Strong8K', channelKey: 's1803789' };
    routing.watchSession(s, candidate, 's1803789', 'Sportsnet Event');
    const log = captureLog();
    try { await s.checkPicture(); } finally { log.restore(); }
    assert.equal(s.blank, true);
    assert.deepEqual(seen.blank.map(b => b.placeholder), [true]);
    assert.equal(seen.placeholder, 1, 'the resolve forgets the analysis it played from');
    assert.deepEqual(seen.lost, [{ how: 'exit', providerReason: true }], 'lost for a provider reason: the player asks again');
    assert.equal(s.feedLost.reason, 'placeholder');
    assert.equal(interruptions.reasonOf('exit', s), 'placeholder');
    assert.equal(routing.isPlaceholder(A.id, 's1803789'), true, 'its re-resolve skips it');
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
    assert.equal(s.ended(), true, 'the session is ended');
    assert.ok(!log.lines.some(l => l.includes(base)), 'no provider URL in the log');
});

test('mid-play: a feed-less blank picture from a source with a length (an encode: no shape on the session) ends the play too', async () => {
    const encode = playedSession('encode', { videoMode: 'encode', width: 0, height: 0, fps: '30/1', placeholderShape: true });
    await encode.s.checkPicture();
    assert.deepEqual(encode.seen.lost, [{ how: 'exit', providerReason: true }]);
    const file = playedSession('file', { width: 1280, height: 720, fps: '25/1', paceInput: true });
    await file.s.checkPicture();
    assert.deepEqual(file.seen.lost, [{ how: 'exit', providerReason: true }]);
});

test('mid-play: a dark real channel of another shape is noted only, as before (quarantined 10 min, the play goes on)', async () => {
    const { s, seen } = playedSession('dark', { width: 1920, fps: '30000/1001' });
    const candidate = { providerId: A.id, providerName: 'Strong8K', channelKey: 's105' };
    routing.watchSession(s, candidate, 's105', 'Sportsnet One');
    await s.checkPicture();
    assert.deepEqual(seen.blank.map(b => b.placeholder), [false]);
    assert.equal(seen.lost.length, 0);
    assert.equal(seen.placeholder, 0);
    assert.equal(s.ended(), false);
    assert.equal(routing.isPlaceholder(A.id, 's105'), false);
    assert.equal(routing.isQuarantined(A.id, 's105'), true, 'the next play tries another provider first');
});

test('mid-play: PIGTV_INGEST_PLACEHOLDER_CHECK=0 leaves a feed-less blank as a note', async () => {
    ingest.tuning.placeholderCheck = false;
    try {
        const { s, seen } = playedSession('off', { width: 1920, fps: '30/1' });
        await s.checkPicture();
        assert.deepEqual(seen.blank.map(b => b.placeholder), [false]);
        assert.equal(seen.lost.length, 0);
    } finally { ingest.tuning.placeholderCheck = true; }
});

// ---- part 3: no copy left: another channel showing the same live game ---------------------------------------------

const ch = (id, stableId, name, sourceId = null) => ({ id, stableId, name, sourceId });
/** A built C-I list with these live games (kind "event", on now), each listing its channels in this order. */
function liveGames(...games) {
    const now = Date.now();
    sportsEvents._useBuilt({ from: now - 3600e3, events: games.map(({ id, title, channels, kind = 'event', start = now - 3600e3, end = now + 3600e3 }) => ({
        id, kind, title, league: 'NHL', start, end, rule: 'keyword', match: 'NHL', aliases: [],
        channels: channels.map((c, i) => ({ key: `${c.sourceId || A.id}:${c.stableId || c.id}`, sourceId: c.sourceId || A.id, id: c.id, stableId: c.stableId, name: c.name, quality: 'HD', order: i })),
        airingTimes: {}
    })) });
}
const GAME = { id: 'game-tor-mtl', title: 'NHL: Toronto vs Montreal', channels: [
    ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_9', 's1803789', 'NHL Center Ice 1'), ch('pos_6', 's106', 'Sportsnet East'),
    ch('pos_5', 's105', 'Sportsnet One'), ch('pos_7', 's107', 'Sportsnet Ontario')] };

test('the placeholder file, no copy, one live game listing the channel: the game\'s next channel plays, with `fallback`', async () => {
    liveGames(GAME, { id: 'other', title: 'NBA: Raptors vs Celtics', channels: [ch('pos_10', 's110', 'TSN 5')] });
    const log = captureLog();
    let r;
    try { r = await play('pos_2'); } finally { log.restore(); }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fallback, {
        reason: 'placeholder',
        from: { sourceId: A.id, id: 'pos_2', name: 'Sportsnet Event' },
        to: { sourceId: A.id, id: 'pos_5', stableId: 's105', name: 'Sportsnet One' }
    });
    assert.equal(r.body.strategy, 'transcode');
    assert.equal(r.body.provider.name, 'Strong8K');
    assert.equal(connections['/real5.ts'] > 0, true, 'Sportsnet One played');
    assert.equal(connections['/file9.ts'], undefined, 'the same stream listed again is never tried');
    assert.equal(connections['/file6.ts'] > 0, true, 'Sportsnet East was tried first and found the placeholder too');
    assert.equal(routing.isPlaceholder(A.id, 's106'), true);
    assert.equal(connections['/real7.ts'], undefined, 'nothing after the channel that played');
    const session = transcodeSession.getSession(r.body.sessionId);
    assert.equal(session.options.channelName, 'Sportsnet One', 'the Status page names the channel played');
    assert.ok(log.lines.some(l => l.includes('[Playback] "Sportsnet Event" is the provider\'s placeholder; playing "Sportsnet One" for NHL: Toronto vs Montreal')), log.lines.join('\n'));
    assert.ok(!log.lines.some(l => l.includes(base)), 'no provider URL in the log');
    const history = sqlite.getDb().prepare('SELECT channel_item_id FROM channel_history ORDER BY watched_at DESC LIMIT 1').get();
    assert.equal(history.channel_item_id, 'pos_5', 'history names the channel watched');
});

test('two live games list the channel: no game is inferred, C-B\'s placeholder text; a client naming the game gets it', async () => {
    liveGames({ id: 'g1', title: 'NHL: A vs B', channels: [ch('pos_8', 's108', 'TSN 4'), ch('pos_5', 's105', 'Sportsnet One')] },
        { id: 'g2', title: 'NHL: C vs D', channels: [ch('pos_8', 's108', 'TSN 4'), ch('pos_10', 's110', 'TSN 5')] });
    const r = await play('pos_8');
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, PLACEHOLDER_TEXT);
    assert.equal(r.body.fallback, undefined);
    assert.equal(connections['/real5.ts'], undefined);
    assert.equal(connections['/real10.ts'], undefined);
    routing.reset();
    const named = await play('pos_8', { eventId: 'g2' });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.body.fallback.to.id, 'pos_10');
});

test('a named game that is not live, not a game, or does not list the channel is not used', async () => {
    const now = Date.now();
    liveGames({ id: 'later', title: 'NHL: E vs F', start: now + 3600e3, end: now + 7200e3, channels: [ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_5', 's105', 'Sportsnet One')] },
        { id: 'replay', kind: 'replay', title: 'NHL: G vs H', channels: [ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_5', 's105', 'Sportsnet One')] },
        { id: 'elsewhere', title: 'NHL: I vs J', channels: [ch('pos_10', 's110', 'TSN 5')] });
    for (const eventId of [undefined, 'later', 'replay', 'elsewhere']) {
        routing.reset();
        const r = await play('pos_2', eventId ? { eventId } : {});
        assert.equal(r.status, 503, `${eventId}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.error, PLACEHOLDER_TEXT);
    }
    assert.equal(connections['/real5.ts'], undefined);
    assert.equal(connections['/real10.ts'], undefined);
});

test('the game\'s channels are tried only without disturbing anybody: a full provider is passed over, its viewer keeps playing', async () => {
    liveGames({ id: 'g', title: 'NHL: Calgary vs Edmonton', channels: [ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_1', 'sw1', 'Sportsnet West', B.id)] });
    // Dream 4K's one connection is another viewer's (TNT Sports 1 plays there).
    const other = await play('pos_1', {}, 'device:a');
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.provider.name, 'Dream 4K');
    const r = await play('pos_2', {}, 'device:c');
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, PLACEHOLDER_TEXT);
    assert.equal(connections['/realB.ts'], undefined, 'Sportsnet West was not started');
    assert.equal(transcodeSession.getSession(other.body.sessionId)?.ended(), false, 'the other viewer keeps playing');
    // With Dream 4K free, the same play goes there.
    await transcodeSession.removeSession(other.body.sessionId);
    coordinator._leases.clear();
    routing.reset();
    const again = await play('pos_2', {}, 'device:c');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.fallback.to.name, 'Sportsnet West');
    assert.equal(again.body.provider.name, 'Dream 4K');
});

test('liveEventFor: matched by stable id (never the stored position of a row that has one), else by id; one game only', () => {
    liveGames({ id: 'g', title: 'NHL: A vs B', channels: [ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_77', null, 'Local')] });
    assert.equal(sportsEvents.liveEventFor({ sourceId: A.id, stableId: 's1803789', itemId: 'pos_99' })?.id, 'g');
    assert.equal(sportsEvents.liveEventFor({ sourceId: A.id, stableId: 's999', itemId: 'pos_2' }), null, 'a row with a stable id is never matched by position');
    assert.equal(sportsEvents.liveEventFor({ sourceId: A.id, stableId: null, itemId: 'pos_77' })?.id, 'g');
    assert.equal(sportsEvents.liveEventFor({ sourceId: A.id + 100, stableId: 's1803789' }), null, 'another source');
    sportsEvents._useBuilt(null);
    assert.equal(sportsEvents.liveEventFor({ sourceId: A.id, stableId: 's1803789' }), null, 'nothing built: nothing inferred (a resolve never builds)');
});

test('after a play ended mid-way as the placeholder, the player\'s re-resolve skips that feed and plays the game\'s next channel', async () => {
    liveGames({ id: 'g', title: 'NHL: Ottawa vs Boston', channels: [ch('pos_5', 's105', 'Sportsnet One'), ch('pos_7', 's107', 'Sportsnet Ontario')] });
    const { s } = playedSession('then-moves', { width: 1920, fps: '30/1' });
    routing.watchSession(s, { providerId: A.id, providerName: 'Strong8K', channelKey: 's105' }, 's105', 'Sportsnet One');
    await s.checkPicture();
    assert.equal(routing.isPlaceholder(A.id, 's105'), true);
    const r = await play('pos_5');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fallback.from.id, 'pos_5');
    assert.equal(r.body.fallback.to.id, 'pos_7');
    assert.equal(connections['/real5.ts'], undefined, 'no connection for the slate');
});

test('Codex high: a live HLS channel answered with a Content-Length (the manifest\'s) at 1080p30 plays; it is not the placeholder file', async () => {
    const r = await play('pos_11');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(routing.isPlaceholder(A.id, 's111'), false, 'not held back');
    assert.equal(routing.isQuarantined(A.id, 's111'), false);
});

test('Codex high: a feed-less play ended as the placeholder still counts its connection until ffmpeg has exited', async () => {
    const s = await transcodeSession.createSession(`${base}/file2.ts`, { live: true, segmentType: 'mpegts', videoMode: 'copy',
        width: 1920, height: 1080, fps: '30/1', providerId: A.id, owner: 'device:tv' });
    const { s: shaped } = playedSession('teardown', {});
    s.dir = shaped.dir;
    s.playlistPath = shaped.playlistPath;
    s.retainDir = true;
    s.timings.playlistReady = Date.now();
    let exited;
    s.stop = () => new Promise((resolve) => { exited = resolve; }); // ffmpeg takes its time to die
    const lost = [];
    s.on('lost', (info) => lost.push(info));
    const counted = () => coordinator.activeStreams().some(x => x.id === s.id);
    assert.equal(counted(), true);
    const checking = s.checkPicture();
    const until = Date.now() + 2000;
    while (!exited && Date.now() < until) await new Promise(r => setImmediate(r));
    assert.ok(exited, 'the teardown is waiting on ffmpeg');
    assert.deepEqual(lost, [{ how: 'exit', providerReason: true }], 'the listeners are told at once');
    assert.equal(counted(), true, 'while ffmpeg is still connected, its connection is counted');
    exited();
    await checking;
    assert.equal(counted(), false, 'gone from the count once ffmpeg has exited');
    assert.equal(transcodeSession.getSession(s.id), undefined);
});

test('Codex high: the game\'s channels are found by stable id after a sync moved them; a reused position is never played', async () => {
    const dbh = sqlite.getDb();
    // The built list says Sportsnet One is pos_5 and TSN 5 is pos_10 (s_gone). A sync since: Sportsnet One (s105) moved to
    // pos_12 and pos_5 now holds an unrelated station; TSN 5's old identity s_gone no longer exists.
    liveGames({ id: 'g', title: 'NHL: Winnipeg vs Vancouver', channels: [ch('pos_2', 's1803789', 'Sportsnet Event'),
        ch('pos_10', 's_gone', 'TSN 5 old'), ch('pos_5', 's105', 'Sportsnet One')] });
    dbh.prepare(`UPDATE playlist_items SET name = 'Shopping Channel', stable_id = 's999', stream_url = ? WHERE id = ?`).run(`${base}/real99.ts`, `${A.id}:pos_5`);
    dbh.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                 VALUES (?, ?, 'pos_12', 'live', 'Sportsnet One', 'Sport', 0, 12, 's105', ?)`).run(`${A.id}:pos_12`, A.id, `${base}/real12.ts`);
    try {
        const r = await play('pos_2');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.fallback.to, { sourceId: A.id, id: 'pos_12', stableId: 's105', name: 'Sportsnet One' });
        assert.equal(connections['/real99.ts'], undefined, 'the station now at pos_5 is never played');
        assert.equal(connections['/real10.ts'], undefined, 'a channel whose identity is gone is skipped, not played by its old position');
        assert.ok(connections['/real12.ts'] > 0);
        const history = dbh.prepare('SELECT channel_item_id, stable_id FROM channel_history ORDER BY watched_at DESC, rowid DESC LIMIT 1').get();
        assert.deepEqual({ ...history }, { channel_item_id: 'pos_12', stable_id: 's105' });
    } finally {
        dbh.prepare('DELETE FROM playlist_items WHERE id = ?').run(`${A.id}:pos_12`);
        dbh.prepare(`UPDATE playlist_items SET name = 'Sportsnet One', stable_id = 's105', stream_url = ? WHERE id = ?`).run(`${base}/real5.ts`, `${A.id}:pos_5`);
    }
});

test('Codex medium: a resolve-time placeholder detection is health reason "placeholder", so the channel sinks in the game\'s order', async () => {
    const dbh = sqlite.getDb();
    const health = load('services/channelHealth');
    dbh.prepare('DELETE FROM channel_health').run();
    health.reset();
    const order = () => {
        const now = Date.now();
        const channels = [{ sourceId: A.id, id: 'pos_2', stableId: 's1803789', name: 'Sportsnet Event', quality: 'HD', order: 0 },
            { sourceId: A.id, id: 'pos_5', stableId: 's105', name: 'Sportsnet One', quality: 'HD', order: 1 }];
        health.applyHealth(channels, now, { blank: true });
        sportsEvents._useBuilt({ from: now - 3600e3, events: [{ id: 'g', kind: 'event', title: 'NHL: K vs L', league: 'NHL', start: now - 3600e3, end: now + 3600e3,
            channels: channels.map(c => ({ ...c, key: `${A.id}:${c.stableId}` })), airingTimes: {} }] });
        return sportsEvents.liveEventFor({ sourceId: A.id, stableId: 's105' }).channels.map(c => c.name);
    };
    try {
        assert.deepEqual(order(), ['Sportsnet Event', 'Sportsnet One']);
        sportsEvents._useBuilt(null); // no game known: the failed resolve's own write
        const r = await play('pos_2');
        assert.equal(r.status, 503);
        assert.equal(r.body.error, PLACEHOLDER_TEXT, 'the client\'s text is unchanged');
        assert.equal(dbh.prepare('SELECT reason FROM channel_health ORDER BY id DESC LIMIT 1').get().reason, 'placeholder');
        assert.deepEqual(order(), ['Sportsnet One', 'Sportsnet Event'], 'sunk below the untried channel');
        // The fallback's write for the requested channel says the same.
        dbh.prepare('DELETE FROM channel_health').run();
        health.reset();
        routing.reset();
        order(); // the game is known now
        const moved = await play('pos_2');
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.ok(moved.body.fallback);
        const failed = dbh.prepare(`SELECT reason FROM channel_health WHERE channel_key = 's1803789' AND ok = 0 ORDER BY id DESC LIMIT 1`).get();
        assert.equal(failed.reason, 'placeholder');
    } finally {
        dbh.prepare('DELETE FROM channel_health').run();
        health.reset();
    }
});

test('Codex medium: the resolve deadline bounds the shared ingest\'s wait and the probe; no direct probe once it is spent', async () => {
    const strategy = load('services/playbackStrategy');
    const marker = path.join(sandbox, 'probe-ran');
    const PROBE = path.join(sandbox, 'ffprobe-marker');
    fs.writeFileSync(PROBE, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => process.exit(1), 30000);\n`);
    fs.chmodSync(PROBE, 0o755);
    const settings = { ...(await db.settings.get()), ffmpegPath: FFMPEG };
    const realSubscribe = ingest.subscribe;
    let left = 0;
    try {
        // The provider never answers (the ingest's own budget is 10 s); the resolve has 1 s left.
        const stall = ingest.sourceFor({ providerId: A.id, providerName: 'Strong8K', url: `${base}/stall77.ts`, channelKey: 's177' }, settings);
        let started = Date.now();
        await assert.rejects(strategy.resolve({ url: `${base}/stall77.ts`, capabilities: { segmentedDelivery: true }, settings, ffprobePath: PROBE, live: true,
            providerId: A.id, ingestSource: stall, deadlineAt: Date.now() + 1000 }),
        (err) => err.providerReason === true && /^The provider did not respond/.test(err.message));
        assert.ok(Date.now() - started < 1400, `gave up at the deadline, not after the ingest's wait (${Date.now() - started} ms)`);
        // The ingest refuses within the budget but leaves under half a second: no direct probe either.
        ingest.subscribe = () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Shared ingest not used: refused'),
            { ingestRefused: true })), 600));
        started = Date.now();
        await assert.rejects(strategy.resolve({ url: `${base}/real77.ts`, capabilities: { segmentedDelivery: true }, settings, ffprobePath: PROBE, live: true,
            providerId: A.id, ingestSource: { pool: 'primary', url: `${base}/real77.ts`, providerId: A.id, channelKey: 's177' }, deadlineAt: Date.now() + 1000 }),
        (err) => err.providerReason === true);
        left = Date.now() - started;
        await new Promise(r => setTimeout(r, 300));
        assert.equal(fs.existsSync(marker), false, 'no direct probe with the budget spent');
        assert.ok(left < 1400, `${left} ms`);
    } finally {
        ingest.subscribe = realSubscribe;
    }
});

test('Codex high: a removeSession during the placeholder teardown waits for the same teardown; counted until ffmpeg has exited', async () => {
    const s = await transcodeSession.createSession(`${base}/file2.ts`, { live: true, segmentType: 'mpegts', videoMode: 'copy',
        width: 1920, height: 1080, fps: '30/1', providerId: A.id, owner: 'device:tv' });
    const { s: shaped } = playedSession('teardown-race', {});
    s.dir = shaped.dir;
    s.playlistPath = shaped.playlistPath;
    s.retainDir = true;
    s.timings.playlistReady = Date.now();
    let exited;
    let stops = 0;
    s.stop = () => { stops++; return new Promise((resolve) => { exited = resolve; }); };
    const counted = () => coordinator.activeStreams().some(x => x.id === s.id);
    const checking = s.checkPicture();
    const until = Date.now() + 2000;
    while (!exited && Date.now() < until) await new Promise(r => setImmediate(r));
    assert.ok(exited, 'the teardown is waiting on ffmpeg');
    let removed = false;
    const removing = transcodeSession.removeSession(s.id).then(() => { removed = true; }); // a replacement play, or a DELETE
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    assert.equal(removed, false, 'the second caller waits for the teardown in flight');
    assert.equal(counted(), true, 'still counted while ffmpeg is connected');
    assert.equal(stops, 1, 'one teardown');
    exited();
    await Promise.all([checking, removing]);
    assert.equal(counted(), false);
});

test('Codex high: a sync that reuses the requested position during its probe: the game, the exclusion and the health row stay the requested stream\'s', async () => {
    const dbh = sqlite.getDb();
    const health = load('services/channelHealth');
    dbh.prepare('DELETE FROM channel_health').run();
    health.reset();
    liveGames({ id: 'g', title: 'NHL: Seattle vs Dallas', channels: [ch('pos_2', 's1803789', 'Sportsnet Event'), ch('pos_5', 's105', 'Sportsnet One')] });
    const realSubscribe = ingest.subscribe;
    let synced = false;
    // While the requested channel's probe is pending, a sync moves Sportsnet Event to pos_20 and gives pos_2 to another station.
    ingest.subscribe = (opts) => {
        if (!synced) {
            synced = true;
            dbh.prepare(`UPDATE playlist_items SET name = 'Shopping Channel', stable_id = 's999', stream_url = ? WHERE id = ?`).run(`${base}/real99.ts`, `${A.id}:pos_2`);
            dbh.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                         VALUES (?, ?, 'pos_20', 'live', 'Sportsnet Event', 'Sport', 0, 20, 's1803789', ?)`).run(`${A.id}:pos_20`, A.id, `${base}/file2.ts`);
        }
        return realSubscribe(opts);
    };
    try {
        const r = await play('pos_2');
        assert.ok(synced, 'the sync ran during the play');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.fallback.to.name, 'Sportsnet One', 'the requested stream\'s game, not the new occupant\'s');
        assert.equal(connections['/file2.ts'], 1, 'the requested stream is not tried again under its new position');
        assert.equal(connections['/real99.ts'], undefined);
        const rows = dbh.prepare('SELECT channel_key, ok, reason FROM channel_health WHERE ok = 0').all().map(x => ({ ...x }));
        assert.deepEqual(rows, [{ channel_key: 's1803789', ok: 0, reason: 'placeholder' }], 'the health row is the requested stream\'s');
    } finally {
        ingest.subscribe = realSubscribe;
        dbh.prepare('DELETE FROM playlist_items WHERE id = ?').run(`${A.id}:pos_20`);
        dbh.prepare(`UPDATE playlist_items SET name = 'Sportsnet Event', stable_id = 's1803789', stream_url = ? WHERE id = ?`).run(`${base}/file2.ts`, `${A.id}:pos_2`);
        dbh.prepare('DELETE FROM channel_health').run();
        health.reset();
    }
});

test('Codex high: an ingest wait cut by the resolve deadline drops its waiter and closes the connection nobody else needs', async () => {
    const strategy = load('services/playbackStrategy');
    const settings = { ...(await db.settings.get()), ffmpegPath: FFMPEG };
    const source = ingest.sourceFor({ providerId: A.id, providerName: 'Strong8K', url: `${base}/stall.ts`, channelKey: 's188' }, settings);
    const opened = stalled.length;
    const closed = stalledClosed;
    const started = Date.now();
    await assert.rejects(strategy.resolve({ url: `${base}/stall.ts`, capabilities: { segmentedDelivery: true }, settings, ffprobePath: FFPROBE, live: true,
        providerId: A.id, ingestSource: source, deadlineAt: Date.now() + 700 }), (err) => err.providerReason === true);
    assert.ok(Date.now() - started < 1200, `${Date.now() - started} ms`);
    // By the time the walk gets the failure (and gives back its lease), the stalled connection is gone: nothing holds a
    // waiter on it, it is not in the registry, and another start in the pool opens no second connection beside it.
    const left = ingest._registry.get(source.key);
    const waiting = left ? left.waiters : 0;
    if (left) left.close('test over'); // the old code leaves it connecting, waited on
    assert.equal(!!left, false, `the stalled ingest is closed (still registered, ${waiting} waiter(s))`); // (never inspect an Ingest)
    assert.equal(ingest.idleInPool(source.pool).length, 0);
    for (let i = 0; i < 50 && stalledClosed - closed < stalled.length - opened; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(stalled.length - opened, 1);
    assert.equal(stalledClosed - closed, 1, 'the provider saw the connection closed');
});
