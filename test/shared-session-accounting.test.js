const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
// R1-M1: actual sessions, actual ffmpeg, actual recording engine and Status route.
const available = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-real-accounting-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(tmp, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(tmp, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(tmp, 'node_modules'), 'junction');
process.chdir(tmp); process.env.JWT_SECRET = 'offline-accounting-test-secret-'.repeat(3);
const load = p => require(path.join(tmp, 'server', p));
const db = load('db'), sql = load('db/sqlite');
const sessions = load('services/transcodeSession'), ingest = load('services/ingest'), c = load('services/streamCoordinator');
const engine = load('services/recordingEngine'); engine._setPrepareQueue(false);
const { scheduled, recordings } = load('db/recordingsDb');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 8000; while (Date.now() < end) { if (fn()) return; await sleep(50); } assert.fail('accounting timeout'); }
let provider, api, base, apiBase, A, settings, token, connections = 0;
const generators = new Set();
before(async () => {
    if (!available) return;
    provider = http.createServer((req, res) => {
        connections++;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']);
        generators.add(p); p.stdout.pipe(res); p.stderr.resume();
        res.on('close', () => { p.kill('SIGKILL'); generators.delete(p); });
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); base = `http://127.0.0.1:${provider.address().port}/a.ts`;
    A = await db.sources.create({ type: 'm3u', name: 'A', url: 'http://a.invalid/list.m3u' });
    await db.sources.create({ type: 'm3u', name: 'B', role: 'backup', url: 'http://b.invalid/list.m3u' });
    sql.getDb().prepare(`INSERT INTO playlist_items (id,source_id,item_id,stable_id,type,name,stream_url) VALUES (?,?,? ,?,'live','Test',?)`).run(`${A.id}:pos_1`, A.id, 'pos_1', 's1', base);
    await db.settings.update({ sharedIngestEnabled: true, maxProviderStreams: 1, recordingsPath: path.join(tmp, 'recordings'), minFreeSpaceGB: 0 });
    settings = await db.settings.get();
    const user = await db.users.create({ username: 'admin', role: 'admin' });
    token = jwt.sign({ id: user.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET);
    sql.getDb().prepare(`INSERT INTO playlist_items (id,source_id,item_id,stable_id,type,name,stream_url) VALUES (?,?,? ,?,'live','Other',?)`).run(`${A.id}:pos_2`, A.id, 'pos_2', 's2', base.replace('/a.ts', '/b.ts'));
    const app = express(); app.use(express.json()); app.locals.ffmpegPath = 'ffmpeg'; app.locals.ffprobePath = 'ffprobe';
    app.use('/api/playback', load('routes/playback')); app.use('/api/status', load('routes/status')); api = app.listen(0, '127.0.0.1'); await once(api, 'listening'); apiBase = `http://127.0.0.1:${api.address().port}`;
    engine.init({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }); engine.shutdown();
});
afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const x of sessions.getAllSessions()) await sessions.removeSession(x.id);
    ingest.closeAll('test over'); connections = 0;
});
after(() => {
    provider?.closeAllConnections(); provider?.close(); api?.closeAllConnections(); api?.close();
    for (const p of generators) p.kill('SIGKILL');
    try { sql.getDb().close(); } catch {}
    process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true });
});
async function viewer(mode = {}) {
    const s = await sessions.createSession(base, { ffmpegPath: 'ffmpeg', live: true, videoMode: 'copy', audioMode: 'copy',
        videoCodec: 'h264', audioCodec: 'aac', providerId: A.id, owner: `device:${Math.random()}`, ...mode,
        ingestSource: { pool: c.poolOf(A.id), url: base, providerId: A.id } });
    await s.start(); return s;
}
async function used() {
    const r = await fetch(`${apiBase}/api/status`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(r.status, 200);
    const body = await r.json(); return body.providers.find(p => p.id === A.id).connections.used;
}
test('R1-M1: real viewers and mixed warm/standby readers share one counted connection and force closes every member', { skip: !available }, async () => {
    const one = await viewer(); const two = await viewer();
    const warm = await viewer({ warm: true }), standby = await viewer({ standby: true });
    for (const s of [one, two, warm, standby]) assert.equal(await s.waitForPlaylist(15000), true, 'real ffmpeg produced a playlist');
    assert.equal(connections, 1);
    assert.equal(sessions.getAllSessions().filter(s => s.ingestKey === one.ingestKey).length, 4);
    assert.equal(await used(), 1, 'Status counts physical connections');
    const ask = { owner: 'device:other', settings, providerId: A.id, activeRecordings: [] };
    const v = c.requestForViewer(ask);
    assert.equal(v.allowed, false, 'mixed group is not reclaimable as warm/standby');
    assert.equal(v.conflict.type, 'viewer-in-progress');
    const forced = await c.admitViewer({ ...ask, force: true }); c.releaseUnbound(forced.lease);
    await until(() => sessions.getAllSessions().length === 0 && ingest.list().length === 0);
    assert.equal(one.stopRequested, true); assert.equal(two.stopRequested, true);
    assert.equal(await used(), 0);
});
test('R1-M1: real viewer riding a real recording adds no connection and forced takeover stops both', { skip: !available }, async () => {
    const one = await viewer();
    assert.equal(await one.waitForPlaylist(15000), true);
    const now = Date.now();
    const sch = scheduled.create({ title: 'Offline', description: null, channel_logo: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's1', channel_name: 'Test', program_start: now - 1000, program_end: now + 60000, pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    await engine.tick(); await until(() => engine.listActive().some(r => r.ingestKey === one.ingestKey));
    await until(() => { const r = recordings.listBySchedule(sch.id)[0]; return r?.file_path && fs.existsSync(r.file_path) && fs.statSync(r.file_path).size > 0; });
    assert.equal(connections, 1); assert.equal(await used(), 1);
    const source = one.feed.ingest;
    const response = await fetch(`${apiBase}/api/playback/resolve`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: A.id, channelId: 'pos_2', force: true, capabilities: { segmentedDelivery: true } }) });
    const next = await response.json(); assert.equal(response.status, 200, JSON.stringify(next));
    await until(() => source.closed && sessions.getAllSessions().length === 1 && ingest.list().length === 1);
    assert.equal(one.stopRequested, true);
    assert.notEqual(recordings.listBySchedule(sch.id)[0]?.status, 'recording');
    assert.equal(connections, 2, 'one old shared connection, one replacement');
    assert.equal(await used(), 1);
});
