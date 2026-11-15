const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// #332: the provider's placeholder. When a provider has nothing on a stream it sends one still picture at ~193 kbps,
// closes within about a second, and sends it again on every reconnect, so the shared ingest went back to live each
// time and nothing ended the play. The rule (feedPlaceholder.js) and the real ingest, route, strategy and sessions
// against a fake provider over local HTTP (never a real one): a feed whose connections keep ending after a short
// low-rate burst ends as `placeholder`, quarantined 3 min for the channel only; a viewer gets C-B's "This channel is
// not available right now" or the next candidate; a real low-bitrate feed is never taken for one.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-placeholder-')));
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
const { ALLOWED_PREFIXES } = load('services/playbackErrors');
const { probeCache } = load('services/streamProbe');
const rule = load('services/feedPlaceholder');
const originalTuning = { ...ingest.tuning };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(25); }
    assert.fail(`timed out waiting for: ${label}`);
}
const PLACEHOLDER_TEXT = 'This channel is not available right now: nothing is on this stream at the moment.';

// ---- MPEG-TS with a clock: a PCR packet per 10 ms of media and `perTick - 1` other packets beside it ------------
function pcrPacket(sec) {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = 0x01; b[2] = 0x00; b[3] = 0x30; b[4] = 7; b[5] = 0x10;
    const v = Math.round(sec * 90000);
    b[6] = Math.floor(v / 33554432) & 0xff; b[7] = Math.floor(v / 131072) & 0xff; b[8] = Math.floor(v / 512) & 0xff; b[9] = Math.floor(v / 2) & 0xff; b[10] = (v % 2) << 7;
    return b;
}
function plainPacket(pid) {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff; b[3] = 0x10;
    return b;
}
/** `seconds` of media from `from`: per 10 ms one PCR packet and `perTick - 1` others (1: ~150 kbps, 3: ~451 kbps). */
function media(from, seconds, perTick) {
    const out = [];
    for (let k = 0; k < Math.round(seconds * 100); k++) {
        out.push(k % 20 === 0 ? plainPacket(0) : pcrPacket(from + k / 100));
        for (let j = 1; j < perTick; j++) out.push(plainPacket(0x101));
    }
    return Buffer.concat(out);
}
const SLATE = media(0, 1, 1); // the placeholder: 1 s of media, 18.8 kB (~150 kbps)
const LONG_SLATE = media(0, 4, 1); // 4 s of it in one burst (75 kB): enough for a session's first segment

// ---- the provider: '/slate.ts' sends 1 s of slate and closes, every time; '/real.ts' a 451 kbps feed (no end;
// '?drop=MS' ends each connection after MS); '/turns.ts' a 1.2 Mb/s channel for 1.5 s on its first connection, then
// the slate ----
let connections = {};
let provider, base;
function realFeed(res, { dropMs = null, untilMs = null, then = null, perTick = 3 } = {}) {
    let t = 0;
    const started = Date.now();
    const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        const age = Date.now() - started;
        if ((dropMs && age >= dropMs) || (untilMs && age >= untilMs)) { clearInterval(timer); return then ? then() : res.end(); }
        res.write(media(t, 0.02, perTick)); t += 0.02;
    }, 20);
    res.on('close', () => clearInterval(timer));
}
function slate(res) {
    res.write(SLATE);
    setTimeout(() => res.end(), 30);
}

// ---- the tools: ffprobe answers a 1080p25 feed; a session's ffmpeg writes its playlist once it has read 60 kB (a first
// segment needs seconds of media: more than the placeholder's two connections bring) and exits at the end of input ----
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.length - 1];
const playlist = () => { fs.writeFileSync(require('path').join(require('path').dirname(out), 'seg0000.ts'), Buffer.alloc(2000)); fs.writeFileSync(out, '#EXTM3U\\n#EXT-X-TARGETDURATION:4\\n#EXTINF:4,\\nseg0000.ts\\n'); };
if (args[args.indexOf('-i') + 1] === 'pipe:0') {
  let got = 0;
  process.stdin.on('data', d => { got += d.length; if (got > 60000 && !fs.existsSync(out)) playlist(); });
  process.stdin.on('end', () => process.exit(0));
} else { playlist(); setInterval(() => {}, 1000); }
`);
const FFPROBE = path.join(sandbox, 'ffprobe-fake');
fs.writeFileSync(FFPROBE, `#!${process.execPath}
const args = process.argv.slice(2);
const answer = () => { process.stdout.write(JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 } ], format: { format_name: 'mpegts' } })); process.exit(0); };
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
async function play(channelId, device = 'device:tv') {
    const response = await fetch(`${routeBase}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(device)}` },
        body: JSON.stringify({ sourceId: A.id, channelId, capabilities: { segmentedDelivery: true } })
    });
    return { status: response.status, body: await response.json() };
}

before(async () => {
    provider = http.createServer((req, res) => {
        const [p, query] = req.url.split('?');
        connections[p] = (connections[p] || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        if (p.startsWith('/slate')) return slate(res);
        // Held open 1.5 s after its burst: the play has started (and is followed) before the second connection ends.
        if (p === '/longslate.ts') { res.write(LONG_SLATE); setTimeout(() => res.end(), 1500); return; }
        if (p === '/turns.ts') return connections[p] === 1 ? realFeed(res, { untilMs: 1500, perTick: 8 }) : slate(res);
        const drop = /drop=(\d+)/.exec(query || '');
        return realFeed(res, { dropMs: drop ? Number(drop[1]) : null });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;

    userId = (await db.users.create({ username: 'owner', role: 'admin' })).id;
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    B = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://backup.invalid/list.m3u', role: 'backup', priority: 1 });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                         VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Sky Sports Main Event', 1, 's1', `${base}/slate.ts`);
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'TNT Sports 1', 2, 's2', `${base}/slate2.ts`);
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'TNT Sports 2', 3, 's3', `${base}/turns.ts`);
    item.run(`${A.id}:pos_4`, A.id, 'pos_4', 'TNT Sports 3', 4, 's4', `${base}/longslate.ts`);
    // TNT Sports 4 is listed twice by the same provider (no "(Backup)" marker): the second plays (#332 copies).
    item.run(`${A.id}:pos_5`, A.id, 'pos_5', 'TNT Sports 4', 5, 's5', `${base}/slate5.ts`);
    item.run(`${A.id}:pos_6`, A.id, 'pos_6', 'ᴛɴᴛ ꜱᴘᴏʀᴛꜱ 4 ᴴᴰ', 6, 's6', `${base}/real.ts`);
    // TNT Sports 1 has a backup on Dream 4K that plays.
    sqlite.getDb().prepare(`INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, '901', 'TNT Sports 1', ?)`).run(B.id, `${base}/real.ts`);
    sqlite.getDb().prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, updated_at)
                            VALUES (?, 's2', ?, '901', 'exact', 'auto', 1, ?)`).run(A.id, B.id, Date.now());
    sqlite.getDb().prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, updated_at)
                            VALUES (?, 's4', ?, '901', 'exact', 'auto', 1, ?)`).run(A.id, B.id, Date.now());
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
    Object.assign(ingest.tuning, originalTuning);
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
    const log = console.log, warn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => { console.log = log; console.warn = warn; } };
}

// ---- the rule ---------------------------------------------------------------------------------------------------

test('the rule: a short connection at a blank picture\'s rate counts; two in a row are the placeholder', () => {
    const slateConn = { bytes: 24000, wallMs: 1000, mediaSec: 1 }; // 192 kbps for 1 s (the audit's median)
    assert.equal(rule.isShortLowRate(slateConn), true);
    // Sent in one burst: measured by the seconds its clock covers, not the milliseconds it took to arrive.
    assert.equal(rule.isShortLowRate({ bytes: 24000, wallMs: 5, mediaSec: 1 }), true);
    // Long, or at a channel's rate, it does not count.
    assert.equal(rule.isShortLowRate({ ...slateConn, wallMs: rule.SHORT_CONNECTION_MS + 1 }), false);
    assert.equal(rule.isShortLowRate({ bytes: 64000, wallMs: 1000, mediaSec: 1 }), false); // 512 kbps
    // Nothing to measure it by: never low.
    assert.equal(rule.isShortLowRate({ bytes: 24000, wallMs: 0, mediaSec: 0 }), false);
    // A real 448 kbps 400p feed is over the threshold below 720p (250 kbps), even on a short connection.
    assert.equal(rule.isShortLowRate({ bytes: 56000, wallMs: 1000, mediaSec: 1 }, { height: 400 }), false);
    assert.equal(rule.blankKbps(400), 250);
    assert.equal(rule.blankKbps(null), 500);
    // The run: one more, or back to nothing; two in a row is the placeholder.
    assert.equal(rule.nextRun(0, slateConn), 1);
    assert.equal(rule.nextRun(1, slateConn), 2);
    assert.equal(rule.nextRun(1, { bytes: 10e6, wallMs: 60000, mediaSec: 60 }), 0);
    assert.equal(rule.isPlaceholderRun(1), false);
    assert.equal(rule.isPlaceholderRun(rule.PLACEHOLDER_RUN), true);
    assert.equal(rule.PLACEHOLDER_RUN, 2);
    assert.equal(rule.SHORT_CONNECTION_MS, 15000);
    // The 20 s blank verdict is the placeholder after a short low-rate connection, or with its shape.
    assert.equal(rule.hasPlaceholderShape({ width: 1920, height: 1080, fps: '30/1' }), true);
    assert.equal(rule.hasPlaceholderShape({ width: 1920, height: 1080, fps: '30000/1001' }), false);
    assert.equal(rule.hasPlaceholderShape({ width: 1920, height: 1080, fps: '25/1' }), false);
    assert.equal(rule.blankIsPlaceholder({ shortLowSeen: true }), true);
    assert.equal(rule.blankIsPlaceholder({ width: 1920, height: 1080, fps: 30 }), true);
    assert.equal(rule.blankIsPlaceholder({ width: 1280, height: 720, fps: 50 }), false);
});

// ---- the ingest -------------------------------------------------------------------------------------------------

const settingsNow = async () => ({ ...(await db.settings.get()), ffmpegPath: FFMPEG });
const cand = (p, key = 's1') => ({ providerId: A.id, providerName: 'Strong8K', role: 'primary', via: 'primary', url: `${base}${p}`, channelKey: key, channelName: 'Sky Sports Main Event' });

test('a feed whose every connection closes after a second of low-rate data ends as `placeholder`, quarantined 3 min for the channel only', async () => {
    const out = captureLog();
    try {
        const feed = await ingest.subscribe({ ...ingest.sourceFor(cand('/slate.ts'), await settingsNow()), purpose: 'recording' });
        feed.resume();
        const ended = new Promise(r => feed.once('ingest-end', r));
        const why = await ended;
        assert.equal(why.reason, 'placeholder');
        assert.equal(why.providerReason, true);
        assert.equal(why.onlyPlaceholder, true, 'this reader was handed nothing but the placeholder');
        assert.equal(connections['/slate.ts'], rule.PLACEHOLDER_RUN, 'ended after two short connections, not reconnected again');
        const now = Date.now();
        assert.equal(routing.isQuarantined(A.id, 's1', now + routing.PLACEHOLDER_MS - 5000), true);
        assert.equal(routing.isQuarantined(A.id, 's1', now + routing.PLACEHOLDER_MS + 1000), false, 'only 3 min, shorter than a failure');
        assert.equal(routing.PLACEHOLDER_MS, 3 * 60 * 1000);
        assert.equal(routing.isPlaceholder(A.id, 's1'), true);
        assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
        const closed = ingest.status().recent[0];
        assert.equal(closed.why, 'Strong8K is sending a placeholder, not the channel');
        const said = out.lines.join('\n');
        assert.match(said, /Strong8K is sending a placeholder on "Sky Sports Main Event" \(2 connections in a row/);
        assert.ok(!said.includes(base), 'never the provider URL');
    } finally { out.restore(); }
});

test('a real low-bitrate feed (451 kbps) whose connections last is never the placeholder; nor a short one at 400p', async () => {
    ingest.tuning.placeholderShortMs = 600; // so a test connection of 1.2 s is a long one
    const feed = await ingest.subscribe({ ...ingest.sourceFor(cand('/real.ts?drop=1200'), await settingsNow()), purpose: 'viewer', owner: 'device:tv' });
    feed.resume();
    await until(() => (connections['/real.ts'] || 0) >= 3 && feed.ingest.state === 'live', 'three connections');
    assert.equal(feed.endReason, null, 'still reading');
    assert.equal(feed.ingest.placeholderRun, 0);
    assert.equal(routing.isQuarantined(A.id, 's1'), false);
    feed.leave();
    ingest.closeAll('next');
    connections = {};

    // Short connections at a 400p channel's 451 kbps: over that height's threshold (250 kbps).
    ingest.tuning.placeholderShortMs = 5000;
    const short = await ingest.subscribe({ ...ingest.sourceFor(cand('/real.ts?drop=400', 's9'), await settingsNow()), purpose: 'viewer', owner: 'device:tv', height: 400 });
    short.resume();
    await until(() => (connections['/real.ts'] || 0) >= 3 && short.ingest.state === 'live', 'three short connections');
    assert.equal(short.endReason, null);
    assert.equal(short.ingest.placeholderRun, 0);
    short.leave();
});

test('PIGTV_INGEST_PLACEHOLDER_CHECK=0 (tuning.placeholderCheck off) leaves the feed reconnecting as before', async () => {
    ingest.tuning.placeholderCheck = false;
    const feed = await ingest.subscribe({ ...ingest.sourceFor(cand('/slate.ts'), await settingsNow()), purpose: 'viewer', owner: 'device:tv' });
    feed.resume();
    await until(() => (connections['/slate.ts'] || 0) >= 3, 'a third connection');
    assert.equal(feed.endReason, null);
    feed.leave();
});

test('a 20 s blank verdict ends the feed as the placeholder after a short low-rate connection or with its shape, not otherwise', async () => {
    const feed = await ingest.subscribe({ ...ingest.sourceFor(cand('/real.ts', 's5'), await settingsNow()), purpose: 'viewer', owner: 'device:tv' });
    feed.resume();
    const i = feed.ingest;
    assert.equal(i.noteBlank({ width: 1280, height: 720, fps: '50/1', kbps: 300 }), false, 'a dark channel: noted only, as before');
    assert.equal(feed.endReason, null);
    assert.equal(i.noteBlank({ width: 1920, height: 1080, fps: '30/1', kbps: 193 }), true, 'the placeholder\'s shape');
    assert.equal(feed.endReason.reason, 'placeholder');
    assert.equal(feed.endReason.onlyPlaceholder, false, 'when it began is not known: not said to be only the placeholder');
    assert.equal(routing.isPlaceholder(A.id, 's5'), true);
});

// ---- the viewer -------------------------------------------------------------------------------------------------

test('a viewer\'s play of a channel sending only the placeholder answers C-B\'s "not available right now"; asked again, no new connection', async () => {
    const r = await play('pos_1');
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, PLACEHOLDER_TEXT);
    assert.ok(ALLOWED_PREFIXES.some(p => r.body.error.startsWith(p)), 'a C-B text the clients show');
    assert.equal(routing.isQuarantined(A.id, 's1'), true);
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
    const before = connections['/slate.ts'];
    const again = await play('pos_1');
    assert.equal(again.status, 503);
    assert.equal(again.body.error, PLACEHOLDER_TEXT);
    assert.equal(connections['/slate.ts'], before, 'held back 3 min: no connection for a still slate');
    assert.equal(transcodeSession.getAllSessions().length, 0, 'no session left behind');
});

test('with another feed of the channel the play goes there', async () => {
    const r = await play('pos_2');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider.name, 'Dream 4K');
    assert.equal(r.body.provider.failover, true);
    assert.equal(routing.isPlaceholder(A.id, 's2'), true);
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0);
});

test('a feed that turns into the placeholder mid-play ends the play: quarantined 3 min, recorded as `placeholder`, not on the breaker', async () => {
    const r = await play('pos_3');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const session = transcodeSession.getSession(r.body.sessionId);
    await until(() => session.feedLost && session.feedLost.reason === 'placeholder', 'the feed ends as the placeholder');
    await until(() => interruptions.summary().recent.length > 0, 'the interruption is recorded');
    assert.equal(interruptions.summary().recent[0].reason, 'placeholder');
    const now = Date.now();
    assert.equal(routing.isQuarantined(A.id, 's3', now), true);
    assert.equal(routing.isQuarantined(A.id, 's3', now + routing.PLACEHOLDER_MS + 1000), false, 'not the 10 min of a failure');
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0);
    const reasons = playbackEvents.recent().filter(e => e.type === 'relay').map(e => e.reason);
    assert.ok(reasons.includes('placeholder: Strong8K is sending a still placeholder, not the channel'), reasons.join(' | '));
    // The attempt's health row says so (Status: Least reliable channels, "Provider placeholder").
    await until(() => load('services/channelHealth').leastReliable().some(c => c.name === 'TNT Sports 2' && c.placeholder === true), 'the health row');
    // The player's re-resolve is told so.
    const again = await play('pos_3');
    assert.equal(again.status, 503);
    assert.equal(again.body.error, PLACEHOLDER_TEXT);
});

// ---- the placeholder's probe is never the channel's description (#332 (2)) -----------------------------------------

const profileCount = () => sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM channel_profiles').get().n;

test('a play that started on the placeholder keeps no channel profile and no cached probe of it', async () => {
    sqlite.getDb().prepare('DELETE FROM channel_profiles').run();
    const r = await play('pos_4');
    assert.equal(r.status, 200, JSON.stringify(r.body)); // 4 s of slate is a first segment
    const session = transcodeSession.getSession(r.body.sessionId);
    await until(() => session.feedLost && session.feedLost.reason === 'placeholder', 'the feed ends as the placeholder');
    await sleep(50);
    assert.equal(profileCount(), 0, 'no profile of the slate');
    assert.equal(probeCache.size, 0, 'no cached probe of the slate either');
});

test('a relay whose first leg was the placeholder ends (the player asks again) rather than splice a feed onto the slate\'s description', async () => {
    const relay = load('services/streamRelay');
    await db.settings.update({ relayEnabled: true });
    try {
        const r = await play('pos_4');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const followed = relay.get(r.body.sessionId);
        assert.ok(followed, 'the play is followed by a relay');
        await until(() => !relay.get(r.body.sessionId), 'the relay ends');
        assert.equal(connections['/real.ts'] || 0, 0, 'no leg was started on Dream 4K against the slate\'s fingerprint');
        const ended = relay.list().find(x => x.id === r.body.sessionId);
        assert.equal(ended.state, 'failed');
        assert.equal(ended.lastReason.code, 'placeholder');
    } finally {
        await relay.closeAll();
        await db.settings.update({ relayEnabled: false });
    }
});

test('a session is a placeholder suspect once its feed ended as one or had a short low-rate connection', () => {
    const { placeholderSuspect } = load('services/playbackStrategy');
    assert.equal(placeholderSuspect({ feedLost: { reason: 'placeholder' } }), true);
    assert.equal(placeholderSuspect({ feed: { ingest: { shortLowSeen: true } } }), true);
    assert.equal(placeholderSuspect({ feed: { ingest: { shortLowSeen: false, placeholder: null } } }), false);
    assert.equal(placeholderSuspect({ feedLost: { reason: 'upstream-lost' } }), false);
    assert.equal(placeholderSuspect(null), false);
});

test('with a same-provider copy of the channel (no backup) the play goes to the copy', async () => {
    const r = await play('pos_5');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider.name, 'Strong8K');
    assert.equal(r.body.provider.via, 'copy');
    assert.equal(r.body.provider.failover, true);
    assert.equal(routing.isPlaceholder(A.id, 's5'), true);
    assert.equal(connections['/real.ts'], 1, 'the copy\'s stream');
});
