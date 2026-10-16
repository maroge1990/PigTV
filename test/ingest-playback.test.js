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
async function play(channelId, device) {
    const response = await fetch(`${routeBase}/api/playback/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(device)}` },
        body: JSON.stringify({ sourceId: A.id, channelId, capabilities: { segmentedDelivery: true } })
    });
    return { status: response.status, body: await response.json() };
}
const sessionsNow = () => transcodeSession.getAllSessions();

before(async () => {
    provider = http.createServer((req, res) => {
        connections[req.url] = (connections[req.url] || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const timer = setInterval(() => res.write(Buffer.concat(Array.from({ length: 30 }, () => { const n = seq++; return packet(n % 20 === 0 ? 0 : 256, n); }))), 20);
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
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    for (const s of sessionsNow()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    coordinator._leases.clear();
    ingest.closeAll('test over');
    probeCache.clear();
    connections = {};
    try { fs.unlinkSync(log); } catch { /* none */ }
    await db.settings.update({ sharedIngestEnabled: true });
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
