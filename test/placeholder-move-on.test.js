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
const { ALLOWED_PREFIXES } = load('services/playbackErrors');
const { probeCache } = load('services/streamProbe');

const PLACEHOLDER_TEXT = 'This channel is not available right now: nothing is on this stream at the moment.';

// ---- the provider: '/file*.ts' a file with a length (the placeholder file); '/longfile.ts' a long real file;
// '/real*.ts' a live feed (no length, never ends) ----
let connections = {};
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
    assert.equal(isPlaceholderFile({ ...shape, finite: false }, { refusedFinite: true }), true, 'the ingest refused it as a file');
});
