const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// Wave 5 (R2, phase 5b): live channel plays read the shared ingest - the probe and the session
// both, so a cold play is ONE provider connection - and the coordinator counts one connection per
// ingest: a second device watching the same channel, and a recording of it, take no connection and
// ask nobody; a different channel still meets the limit (a 409 at a limit of 1); a lingering ingest
// is reclaimed for somebody else. The real route, strategy, sessions, coordinator and engine over a
// sandboxed database and a fake MPEG-TS provider; ffmpeg and ffprobe are scripts that read stdin
// when given pipe:0. With the switch off nothing changes.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-ingest-play-')));
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
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const ingest = load('services/ingest');
const relay = load('services/streamRelay');
const routing = load('services/providerRouting');
const interruptions = load('services/playbackInterruptions');
const originalTuning = { ...ingest.tuning };
const responses = new Map();
const { probeCache } = load('services/streamProbe');
const { scheduled, recordings } = load('db/recordingsDb');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(50); }
    assert.fail(`timed out waiting for: ${label}`);
}

// ---- the provider -------------------------------------------------------------------------
let connections = {};
let open = {}; // provider connections open now, per path
let seq = 0;
function packet(pid, n) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47; p[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); p[2] = pid & 0xff; p[3] = 0x10 | (n & 0x0f);
    p.writeUInt32BE(n, 4);
    return p;
}
let provider, base;

// ---- ffmpeg (sessions), ffprobe, and the recording's ffmpeg --------------------------------
const log = path.join(sandbox, 'tools.log');
const tools = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'ffmpeg', args }) + '\\n');
const out = args[args.length - 1];
const playlist = () => fs.writeFileSync(out, '#EXTM3U\\n#EXTINF:4,\\nseg0000.ts\\n');
if (args[args.indexOf('-i') + 1] === 'pipe:0') {
  let got = 0;
  process.stdin.on('data', d => { got += d.length; if (got > 4000 && !fs.existsSync(out)) playlist(); });
  process.stdin.on('end', () => process.exit(0));
} else { playlist(); setInterval(() => {}, 1000); }
`);
const FFPROBE = path.join(sandbox, 'ffprobe-fake');
fs.writeFileSync(FFPROBE, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'ffprobe', args }) + '\\n');
const answer = () => { process.stdout.write(JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 } ], format: { format_name: 'mpegts' } })); process.exit(0); };
if (args[args.length - 1] === 'pipe:0') { let got = 0; process.stdin.on('data', d => { got += d.length; if (got > 2000) answer(); }); }
else answer();
`);
const RECFF = path.join(sandbox, 'rec-ffmpeg-fake');
fs.writeFileSync(RECFF, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'record', args }) + '\\n');
const out = fs.createWriteStream(args[args.length - 1]);
if (args[args.indexOf('-i') + 1] === 'pipe:0') { process.stdin.pipe(out); process.stdin.on('end', () => out.end(() => process.exit(0))); }
else { out.write(Buffer.alloc(4000)); setInterval(() => out.write(Buffer.alloc(500)), 50); }
`);
for (const f of [FFMPEG, FFPROBE, RECFF]) fs.chmodSync(f, 0o755);

let A, server, routeBase, userId;
function tokenFor(deviceId) {
    sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(deviceId, String(userId), deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: userId, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function play(channelId, device, { force = false } = {}) {
    const response = await fetch(`${routeBase}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(device)}` },
        body: JSON.stringify({ sourceId: A.id, channelId, capabilities: { segmentedDelivery: true }, ...(force ? { force: true } : {}) })
    });
    return { status: response.status, body: await response.json() };
}
const sessionsNow = () => transcodeSession.getAllSessions();

before(async () => {
    provider = http.createServer((req, res) => {
        connections[req.url] = (connections[req.url] || 0) + 1;
        open[req.url] = (open[req.url] || 0) + 1;
        res.on('close', () => { open[req.url]--; });
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        responses.set(req.url, res);
        // '/slow.ts': headers at once, the first bytes after 600 ms (a start that takes a while).
        if (req.url === '/slow.ts') res.flushHeaders();
        const startAt = Date.now() + (req.url === '/slow.ts' ? 600 : 0);
        const timer = setInterval(() => { if (Date.now() >= startAt) res.write(Buffer.concat(Array.from({ length: 30 }, () => { const n = seq++; return packet(n % 20 === 0 ? 0 : 256, n); }))); }, 20);
        res.on('close', () => clearInterval(timer));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;

    userId = (await db.users.create({ username: 'owner', role: 'admin' })).id;
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                         VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Fox Footy', 1, 's1', `${base}/1.ts`);
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'Fox League', 2, 's2', `${base}/2.ts`);
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'Slow Starter', 3, 's3', `${base}/slow.ts`);
    await db.settings.update({ maxProviderStreams: 1, sharedIngestEnabled: true, recordingsPath: path.join(sandbox, 'recordings'),
        minFreeSpaceGB: 0, maxConcurrentRecordings: 3 });

    engine.init({ ffmpegPath: RECFF, ffprobePath: FFPROBE });
    engine.shutdown();
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
    await relay.closeAll();
    Object.assign(ingest.tuning, originalTuning);
    interruptions.reset();
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    for (const s of sessionsNow()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    coordinator._leases.clear();
    ingest.closeAll('test over');
    probeCache.clear();
    connections = {};
    try { fs.unlinkSync(log); } catch { /* none */ }
    await db.settings.update({ sharedIngestEnabled: true, relayEnabled: false });
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    provider?.closeAllConnections?.(); provider?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('a cold play: the probe and the session both read the ingest - one provider connection', async () => {
    const r = await play('pos_1', 'tv');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const probe = tools().find(t => t.tool === 'ffprobe');
    assert.equal(probe.args[probe.args.length - 1], 'pipe:0', 'the probe read the ingest');
    const ff = tools().find(t => t.tool === 'ffmpeg');
    assert.equal(ff.args[ff.args.indexOf('-i') + 1], 'pipe:0', 'the session read the ingest');
    assert.ok(!ff.args.includes('-user_agent') && !ff.args.includes('-reconnect'), 'the ingest faces the provider');
    assert.ok(ff.args.includes('-dts_delta_threshold') && ff.args.includes('-probesize'), 'the classification flags are kept');
    assert.equal(connections['/1.ts'], 1, 'one connection for the probe and the session');
});

test('two devices on one channel at a limit of 1: one connection, nobody asked; a different channel is a 409', async () => {
    assert.equal((await play('pos_1', 'tv')).status, 200);
    const ipad = await play('pos_1', 'ipad');
    assert.equal(ipad.status, 200, JSON.stringify(ipad.body));
    assert.equal(sessionsNow().length, 2);
    assert.equal(connections['/1.ts'], 1, 'still one connection');
    assert.equal(coordinator.requestForViewer({ owner: 'device:phone', settings: await db.settings.get() }).allowed, false, 'the one connection is in use');
    const phone = await play('pos_2', 'phone');
    assert.equal(phone.status, 409, 'a different channel needs the connection');
    assert.equal(phone.body.conflict.type, 'viewer-in-progress');
    assert.equal(connections['/2.ts'] || 0, 0);
});

test('recording the channel being watched: no prompt, no second connection', async () => {
    assert.equal((await play('pos_1', 'tv')).status, 200);
    const now = Date.now();
    const s = scheduled.create({ title: 'Footy', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's1',
        channel_name: 'Fox Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    await engine.tick();
    await until(() => recordings.listBySchedule(s.id)[0]?.status === 'recording', 'recording');
    assert.equal(coordinator._prompts.has(s.id), false, 'the viewer was not asked');
    await until(() => tools().some(t => t.tool === 'record'), 'the recording ffmpeg started');
    const rec = tools().find(t => t.tool === 'record');
    assert.equal(rec.args[rec.args.indexOf('-i') + 1], 'pipe:0');
    assert.equal(connections['/1.ts'], 1, 'one connection for watching and recording');
});

test('a lingering ingest is reclaimed for somebody else\'s channel', async () => {
    const tv = await play('pos_1', 'tv');
    assert.equal(tv.status, 200);
    await transcodeSession.removeSession(tv.body.sessionId); // the TV stops: the ingest lingers
    await until(() => ingest.idleInPool(coordinator.poolOf(A.id)).length === 1, 'lingering');
    const phone = await play('pos_2', 'phone');
    assert.equal(phone.status, 200, 'the lingering connection was free to take');
    assert.equal(connections['/2.ts'], 1);
    assert.ok(!ingest.list().some(i => i.subscribers.length === 0), 'the lingering one was closed first');
});

test('switch off: today\'s session reads the URL itself', async () => {
    await db.settings.update({ sharedIngestEnabled: false });
    const r = await play('pos_1', 'tv');
    assert.equal(r.status, 200);
    const ff = tools().find(t => t.tool === 'ffmpeg');
    assert.equal(ff.args[ff.args.indexOf('-i') + 1], `${base}/1.ts`);
    assert.ok(ff.args.includes('-user_agent'));
    assert.deepEqual(ingest.list(), []);
});

test('PB1: the same device asks twice while the first start is still waiting - one session, one ffmpeg, the first answered 499', async () => {
    const first = play('pos_3', 'tv');
    await until(() => connections['/slow.ts'] === 1, 'the first start is connecting');
    const second = play('pos_3', 'tv');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(a.status, 499, JSON.stringify(a.body));
    await sleep(300);
    assert.equal(sessionsNow().length, 1, 'only the newer play has a session');
    assert.equal(tools().filter(t => t.tool === 'ffmpeg').length, 1, 'one ffmpeg started');
    assert.equal(open['/slow.ts'], 1, 'one provider connection open');
});

// ---- PB2 (0233): a takeover of a shared connection releases every one of its readers ----------

let recN = 0;
async function recordNow(item = 'pos_1', stable = 's1') {
    const now = Date.now();
    const s = scheduled.create({ title: `Rec ${++recN}`, description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stable,
        channel_name: item, channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now + recN });
    await engine.tick();
    await until(() => recordings.listBySchedule(s.id)[0]?.status === 'recording', `recording ${s.title}`);
    return s;
}
const openNow = (p) => open[p] || 0;

test('PB2: forced onto another channel - a recording and the viewer sharing its connection both go, and that connection closes', async () => {
    assert.equal((await play('pos_1', 'tv')).status, 200);
    const rec = await recordNow();
    assert.equal(openNow('/1.ts'), 1, 'one connection for both');
    const asked = await play('pos_2', 'phone');
    assert.equal(asked.status, 409, 'asked first');
    assert.equal(openNow('/1.ts'), 1, 'declining releases nothing');
    assert.equal(recordings.listBySchedule(rec.id)[0].status, 'recording');
    const forced = await play('pos_2', 'phone', { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    await until(() => openNow('/1.ts') === 0, 'the shared connection is closed');
    assert.equal(openNow('/2.ts'), 1);
    assert.equal(scheduled.getById(rec.id).status, 'completed', 'the recording stopped, keeping what it captured');
    assert.deepEqual(sessionsNow().map(x => x.id), [forced.body.sessionId], 'the TV\'s session went too');
    assert.equal(ingest.list().length, 1, 'only the new channel\'s ingest');
});

test('PB2: two recordings on one connection - forcing another channel stops both, not one', async () => {
    const one = await recordNow();
    const two = await recordNow();
    assert.equal(openNow('/1.ts'), 1);
    const forced = await play('pos_2', 'phone', { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    await until(() => openNow('/1.ts') === 0, 'the shared connection is closed');
    assert.equal(scheduled.getById(one.id).status, 'completed');
    assert.equal(scheduled.getById(two.id).status, 'completed');
    assert.equal(engine.listActive().length, 0);
    assert.equal(openNow('/2.ts'), 1, 'one connection in all, at a limit of 1');
});

test('PB2: two viewers on one connection - forcing another channel ends both and closes it', async () => {
    assert.equal((await play('pos_1', 'tv')).status, 200);
    assert.equal((await play('pos_1', 'ipad')).status, 200);
    const forced = await play('pos_2', 'phone', { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    await until(() => openNow('/1.ts') === 0, 'closed');
    assert.equal(sessionsNow().length, 1);
});

test('PB5: a browser that aborts its resolve (stop) leaves no session behind once the start finishes', async () => {
    const abort = new AbortController();
    const asked = fetch(`${routeBase}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('browser')}` },
        body: JSON.stringify({ sourceId: A.id, channelId: 'pos_3', capabilities: { segmentedDelivery: true } }), signal: abort.signal
    }).catch(err => err);
    await until(() => connections['/slow.ts'] === 1, 'the start is under way');
    abort.abort();
    assert.equal((await asked).name, 'AbortError');
    await sleep(1500); // the slow provider's first bytes come at 600 ms; the start completes after the client left
    assert.deepEqual(sessionsNow(), [], 'nobody will play it: given back, not left to the idle sweep');
});

// FR-22: real routes, coordinator, recording engine and HTTP reconnects. The stand-in
// ffmpeg only saves a playlist; relay-rig/reconnect.js cover actual muxing and players.
for (const drops of [1, 3]) test(`FR-22: ${drops} HTTP reconnect(s) renew one viewer timeline on the same ingest; recording carries on`, async () => {
    await db.settings.update({ relayEnabled: true });
    Object.assign(ingest.tuning, { backoffMs: [40] });
    const r = await play('pos_1', 'tv');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const followed = relay.get(r.body.sessionId);
    assert.ok(followed);
    const front = followed.active.session;
    ingest.tuning.lingerMs = 0;
    const rec = await recordNow();
    await until(() => tools().some(t => t.tool === 'record'), 'recording process');
    const feed = front.feed;
    const events = [];
    feed.on('reconnected', info => events.push(info));
    let failures = 0;
    const originalFailure = routing.noteFailure;
    routing.noteFailure = () => { failures++; };
    const recordBefore = tools().filter(t => t.tool === 'record').length;
    try {
        for (let i = 0; i < drops; i++) {
            responses.get('/1.ts').destroy();
            await until(() => connections['/1.ts'] === i + 2 && feed.ingest.state === 'live', 'reconnected');
            if (i + 1 < drops) await sleep(3500); // spaced flaps: quicker retries alone are not enough to coalesce
        }
        await until(() => followed.switches === 1 && !followed.switching, 'one timeline restart', 12000);
        await followed.tick();
        const text = await followed.getPlaylist();
        assert.match(text, /#EXT-X-DISCONTINUITY\n/);
        assert.match(text, /L1-seg0000/);
        assert.equal(followed.active.candidate.providerId, A.id);
        assert.notEqual(followed.active.session.id, front.id);
        assert.equal(failures, 0, 'a planned renewal never quarantines');
        assert.equal(interruptions.summary().count, 0, 'not a lost play');
        assert.equal(connections['/1.ts'], drops + 1, 'only the requested reconnects, no replacement connection');
        assert.equal(openNow('/1.ts'), 1);
        assert.equal(followed.active.session.feed.ingest, feed.ingest, 'same ingest');
        assert.equal(tools().filter(t => t.tool === 'ffmpeg').length, 2, 'one new ffmpeg, including a reconnect burst');
        assert.equal(tools().filter(t => t.tool === 'record').length, recordBefore, 'recording never restarted');
        assert.equal(recordings.listBySchedule(rec.id)[0].status, 'recording');
        assert.equal(ingest.list().length, 1);
        assert.equal(coordinator.requestForViewer({ owner: 'device:other', settings: await db.settings.get() }).allowed, false, 'pool remains full');
        assert.equal(events.length, 1, 'old leg detached after its planned boundary');
        assert.equal(events[0].forLag, false);
        assert.ok(events[0].gapSec >= 0);
        await sleep(700);
        assert.equal(followed.switches, 1);
    } finally { routing.noteFailure = originalFailure; }
});

test('FR-22: zero linger retains the viewer ingest without a recording; cancelling during settle releases the pin', async () => {
    await db.settings.update({ relayEnabled: true });
    Object.assign(ingest.tuning, { backoffMs: [40] });
    const r = await play('pos_1', 'tv');
    const followed = relay.get(r.body.sessionId);
    ingest.tuning.lingerMs = 0;
    responses.get('/1.ts').destroy();
    await until(() => followed.switching, 'settling');
    assert.equal(ingest.list().length, 1, 'pin retained after old ffmpeg leaves');
    assert.equal(coordinator.requestForViewer({ owner: 'device:other', settings: await db.settings.get() }).allowed, false, 'settling viewer still owns the connection');
    assert.ok(!String(await followed.getPlaylist()).includes('#EXT-X-ENDLIST'));
    await followed.close('test cancellation');
    await until(() => ingest.list().length === 0 && !followed.switching, 'pin released');
    assert.equal(connections['/1.ts'], 2);
    assert.equal(tools().filter(t => t.tool === 'ffmpeg').length, 1, 'cancelled before replacement');
});

test('FR-22: a reconnect while the replacement is starting is absorbed before publishing its timeline', async () => {
    await db.settings.update({ relayEnabled: true });
    Object.assign(ingest.tuning, { backoffMs: [40] });
    const r = await play('pos_1', 'tv');
    const followed = relay.get(r.body.sessionId);
    const strategy = load('services/playbackStrategy');
    const resolve = strategy.resolve;
    let interrupted = false;
    strategy.resolve = async opts => {
        const decision = await resolve(opts);
        if (!interrupted && opts.sessionOptions?.relayTimeline) {
            interrupted = true;
            const n = connections['/1.ts'];
            responses.get('/1.ts').destroy();
            await until(() => connections['/1.ts'] > n && followed.active.session.plannedRestart, 'in-flight reconnect');
            await until(() => ingest.list()[0].state === 'live', 'live again');
        }
        return decision;
    };
    try {
        responses.get('/1.ts').destroy();
        await until(() => followed.switches === 1 && !followed.switching, 'one completed renewal', 18000);
        await followed.tick();
        assert.equal(interrupted, true);
        assert.equal(connections['/1.ts'], 3, 'two requested reconnects, no extra provider read');
        assert.equal(followed.active.session.stopRequested, undefined, 'published leg is running');
        assert.equal(followed.active.session.status, 'running');
        const text = await followed.getPlaylist();
        assert.equal((text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
        assert.equal(interruptions.summary().count, 0);
        await sleep(700);
        assert.equal(followed.switches, 1);
    } finally { strategy.resolve = resolve; }
});

test('FR-22: bare, warm and standby sessions carry on when a managed viewer renews', async () => {
    await db.settings.update({ relayEnabled: true });
    Object.assign(ingest.tuning, { backoffMs: [40] });
    const r = await play('pos_1', 'tv');
    const followed = relay.get(r.body.sessionId);
    const others = [];
    for (const mode of [{}, { warm: true }, { standby: true }]) {
        const s = await transcodeSession.createSession(`${base}/1.ts`, { ffmpegPath: FFMPEG, live: true, ...mode,
            ingestSource: { pool: coordinator.poolOf(A.id), url: `${base}/1.ts`, providerId: A.id } });
        await s.start();
        assert.equal(await s.waitForPlaylist(3000), true);
        others.push({ session: s, process: s.process, feed: s.feed });
    }
    responses.get('/1.ts').destroy();
    await until(() => followed.switches === 1 && !followed.switching, 'managed renewal');
    for (const old of others) {
        assert.equal(old.session.process, old.process);
        assert.equal(old.session.feed, old.feed);
        assert.equal(old.session.status, 'running');
    }
    assert.equal(connections['/1.ts'], 2);
});

test('FR-22: zero-linger renewal holds the viewer slot without a recording, and a forced takeover cancels it', async () => {
    await db.settings.update({ relayEnabled: true });
    Object.assign(ingest.tuning, { backoffMs: [40] });
    const r = await play('pos_1', 'tv');
    const followed = relay.get(r.body.sessionId);
    const source = followed.active.session.feed.ingest;
    ingest.tuning.lingerMs = 0;
    responses.get('/1.ts').destroy();
    await until(() => followed.switching, 'settling');
    assert.equal((await play('pos_2', 'phone')).status, 409, 'still owns the provider slot');
    await until(() => followed.switches === 1 && !followed.switching, 'renewed without a recording');
    assert.equal(followed.active.session.feed.ingest, source);
    assert.equal(connections['/1.ts'], 2);
    responses.get('/1.ts').destroy();
    await until(() => followed.switching, 'settling again');
    const forced = await play('pos_2', 'phone', { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    await until(() => followed.closed && !followed.switching, 'renewal cancelled by takeover');
    assert.equal(followed.failed, false, 'an intentional takeover is not a failed relay');
    assert.equal(connections['/1.ts'], 3, 'no resurrection after takeover');
    assert.equal(connections['/2.ts'], 1);
    assert.equal(ingest.list().length, 1, 'only the replacement channel remains');
});
