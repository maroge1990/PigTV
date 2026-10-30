const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// #12 (D-28: one connection, one stream; same-channel recordings share it; clashes are shown, never silent).
// The real engine, coordinator and shared ingest over a sandboxed database and a fake MPEG-TS provider on local
// HTTP; ffmpeg is a script that copies its input. At the default cap of one recording: a second recording of the
// same channel joins the first's connection instead of being held; another channel waits with the slot as its
// reason and, if never started, is missed with that reason; the schedule list and the schedule answer name clashes.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-clash-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const ingest = load('services/ingest');
const coordinator = load('services/streamCoordinator');
const { scheduled, recordings } = load('db/recordingsDb');
const perf = require(path.join(__dirname, 'helpers', 'perf'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await engine.tick(); await sleep(50); }
    assert.fail(`timed out waiting for: ${label}`);
}

// ---- the provider: MPEG-TS packets with a running counter, a PAT every 20 ----------------
let connections = {};
const sent = {}; // path -> every byte sent on its FIRST connection
let seq = 0;
function packet(pid, n) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47; p[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); p[2] = pid & 0xff; p[3] = 0x10 | (n & 0x0f);
    p.writeUInt32BE(n, 4);
    return p;
}
let server, base;

// ---- ffmpeg: stdin to the output file when reading pipe:0; else a growing file -----------
const argsLog = path.join(sandbox, 'ffmpeg-args.log');
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const out = args[args.length - 1];
if (args[args.indexOf('-i') + 1] === 'pipe:0') {
  const file = fs.createWriteStream(out);
  process.stdin.pipe(file);
  process.stdin.on('end', () => file.end(() => process.exit(0)));
} else {
  fs.writeFileSync(out, Buffer.alloc(4000));
  setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
  process.stdin.on('data', d => { if (String(d).includes('q')) process.exit(0); });
}
`);
fs.chmodSync(FFMPEG, 0o755);
const captures = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

let A;
before(async () => {
    server = http.createServer((req, res) => {
        const p = req.url;
        connections[p] = (connections[p] || 0) + 1;
        if (p.startsWith('/html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>' + 'x'.repeat(4000)); }
        if (p.startsWith('/dies') && connections[p] > 1) { req.socket.destroy(); return; } // gone for good
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const first = connections[p] === 1;
        if (first) sent[p] = [];
        const timer = setInterval(() => {
            const chunk = Buffer.concat(Array.from({ length: 30 }, () => { const n = seq++; return packet(n % 20 === 0 ? 0 : 256, n); }));
            if (first) sent[p].push(chunk);
            res.write(chunk);
        }, 20);
        if (p.startsWith('/dies')) setTimeout(() => { clearInterval(timer); req.socket.destroy(); }, 400);
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Fox Footy', 1, 'ff', `${base}/ff.ts`);
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'Fox League', 2, 'fl', `${base}/fl.ts`);
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'Odd', 3, 'odd', `${base}/html`);
    item.run(`${A.id}:pos_4`, A.id, 'pos_4', 'Shaky', 4, 'shaky', `${base}/dies.ts`);
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 1,
        maxProviderStreams: 1, sharedIngestEnabled: true });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    ingest.closeAll('test over');
    connections = {};
    try { fs.unlinkSync(argsLog); } catch { /* none */ }
    await db.settings.update({ sharedIngestEnabled: true, maxConcurrentRecordings: 1, maxProviderStreams: 1 });
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function schedule(item = 'pos_1', stable = 'ff', { startIn = -1000, lengthMs = 60000, pre = 0, post = 0 } = {}) {
    const now = Date.now();
    return scheduled.create({ title: `Show ${++n}`, description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stable,
        channel_name: item, channel_logo: null, program_start: now + startIn, program_end: now + startIn + lengthMs,
        pre_buffer_min: pre, post_buffer_min: post, created_by: 1, created_at: now });
}
const statusOf = (s) => scheduled.getById(s.id).status;

test('at the default cap of one, a second recording of the same channel joins the first\'s connection', async () => {
    const one = schedule();
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    const two = schedule();
    await until(() => recordings.listBySchedule(two.id)[0]?.status === 'recording', 'second, not held by the cap', 5000);
    assert.equal(connections['/ff.ts'], 1, 'one provider connection for both');
});

test('another channel at the cap waits, saying the recording slot is in use', async () => {
    const one = schedule();
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    const other = schedule('pos_2', 'fl');
    await until(() => statusOf(other) === 'waiting', 'waiting, not silently scheduled', 3000);
    assert.equal(scheduled.getById(other.id).error, 'Another recording is using the recording slot.');
    assert.equal(connections['/fl.ts'] || 0, 0);
    await engine.cancelScheduled(one.id);
    await until(() => recordings.listBySchedule(other.id)[0]?.status === 'recording', 'starts once the slot is free');
});

test('a recording held for the slot all programme is missed with that reason', async () => {
    const one = schedule('pos_1', 'ff', { lengthMs: 120000 });
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    const other = schedule('pos_2', 'fl', { lengthMs: 1500 });
    await until(() => statusOf(other) === 'waiting', 'waiting');
    await until(() => statusOf(other) === 'missed', 'missed when its window passes', 6000);
    assert.match(scheduled.getById(other.id).error, /recording slot/);
});

test('the schedule list names clashes: other channels at once over the limit, back-to-back padding too; not one channel', async () => {
    const a = schedule('pos_1', 'ff', { startIn: 3600000, lengthMs: 3600000 });
    const sameChannel = schedule('pos_1', 'ff', { startIn: 3600000, lengthMs: 2400000 }); // with a: one channel, one connection
    const b = schedule('pos_2', 'fl', { startIn: 5400000, lengthMs: 3600000 });
    // Back-to-back on two channels: 1 min before and 5 min after overlap by 6 minutes.
    const c = schedule('pos_1', 'ff', { startIn: 4 * 3600000, lengthMs: 3600000, pre: 1, post: 5 });
    const d = schedule('pos_2', 'fl', { startIn: 5 * 3600000, lengthMs: 3600000, pre: 1, post: 5 });
    const list = new Map(engine.listScheduled({ settings: await db.settings.get() }).map(r => [r.id, r]));
    assert.deepEqual(list.get(a.id).conflictsWith, [b.id]);
    assert.deepEqual(list.get(sameChannel.id).conflictsWith, [b.id]);
    assert.deepEqual(list.get(b.id).conflictsWith, [a.id, sameChannel.id]);
    assert.deepEqual(list.get(c.id).conflictsWith, [d.id]);
    assert.deepEqual(list.get(d.id).conflictsWith, [c.id]);
    // Room for two channels: no clash.
    await db.settings.update({ maxConcurrentRecordings: 2, maxProviderStreams: 2 });
    const roomy = engine.listScheduled({ settings: await db.settings.get() });
    assert.ok(roomy.every(r => r.conflictsWith === undefined), 'two connections and two slots: nothing clashes');
    // The cap alone still limits it.
    await db.settings.update({ maxConcurrentRecordings: 1, maxProviderStreams: 2 });
    assert.deepEqual(engine.listScheduled({ settings: await db.settings.get() }).find(r => r.id === a.id).conflictsWith, [b.id]);
});

test('scheduling answers with the clash (POST /api/recordings/schedule)', async () => {
    const express = require(path.join(sandbox, 'node_modules', 'express'));
    const app = express();
    app.use(express.json());
    app.use('/api/recordings', load('routes/recordings'));
    const token = load('auth').generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    const web = app.listen(0, '127.0.0.1');
    await once(web, 'listening');
    try {
        const at = Date.now() + 7200000;
        const post = async (channelItemId) => {
            const r = await fetch(`http://127.0.0.1:${web.address().port}/api/recordings/schedule`, {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ sourceId: A.id, channelItemId, channelName: channelItemId, title: channelItemId,
                    programStart: at, programEnd: at + 3600000, preBufferMin: 0, postBufferMin: 0 })
            });
            assert.equal(r.status, 201);
            return r.json();
        };
        const first = await post('pos_1');
        assert.equal(first.conflictsWith, undefined, 'nothing to clash with yet');
        const second = await post('pos_2');
        assert.deepEqual(second.conflictsWith, [first.id]);
    } finally {
        web.close();
    }
});

test('#133: after the channel\'s URL changes, a second recording at the cap waits instead of opening a connection', async () => {
    const one = schedule();
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    sqlite.getDb().prepare('UPDATE playlist_items SET stream_url = ? WHERE id = ?').run(`${base}/ff2.ts`, `${A.id}:pos_1`);
    try {
        const two = schedule();
        await until(() => statusOf(two) === 'waiting', 'waiting for the slot', 3000);
        assert.equal(scheduled.getById(two.id).error, 'Another recording is using the recording slot.');
        for (let i = 0; i < 5; i++) { await engine.tick(); await sleep(50); }
        assert.equal(connections['/ff2.ts'] || 0, 0, 'no second provider connection');
        assert.equal(statusOf(two), 'waiting');
    } finally {
        sqlite.getDb().prepare('UPDATE playlist_items SET stream_url = ? WHERE id = ?').run(`${base}/ff.ts`, `${A.id}:pos_1`);
    }
});

test('#135: with shared ingest off, two overlapping recordings of one channel clash (each needs a connection)', async () => {
    await db.settings.update({ sharedIngestEnabled: false });
    const a = schedule('pos_1', 'ff', { startIn: 3600000, lengthMs: 3600000 });
    const b = schedule('pos_1', 'ff', { startIn: 5400000, lengthMs: 3600000 });
    const list = new Map(engine.listScheduled({ settings: await db.settings.get() }).map(r => [r.id, r]));
    assert.deepEqual(list.get(a.id).conflictsWith, [b.id]);
    assert.deepEqual(list.get(b.id).conflictsWith, [a.id]);
});

test('#136: an enabled backup that carries neither channel does not hide a clash on a one-connection primary', async () => {
    await db.settings.update({ maxConcurrentRecordings: 2, maxProviderStreams: 1 });
    const backup = await db.sources.create({ type: 'm3u', name: 'Unrelated', url: 'http://backup.invalid/list.m3u', role: 'backup' });
    try {
        const a = schedule('pos_1', 'ff', { startIn: 3600000, lengthMs: 3600000 });
        const b = schedule('pos_2', 'fl', { startIn: 3600000, lengthMs: 3600000 });
        const list = new Map(engine.listScheduled({ settings: await db.settings.get() }).map(r => [r.id, r]));
        assert.deepEqual(list.get(a.id).conflictsWith, [b.id]);
        assert.deepEqual(list.get(b.id).conflictsWith, [a.id]);
    } finally {
        await db.sources.delete(backup.id);
    }
});

test('#134: the clash list over 800 heavily overlapping schedules is quick', perf, async () => {
    const d = sqlite.getDb();
    const now = Date.now() + 86400000;
    const insert = d.transaction(() => {
        for (let i = 0; i < 800; i++) {
            const channel = i % 2 ? ['pos_1', 'ff'] : [`pos_x${i % 40}`, `x${i % 40}`];
            scheduled.create({ title: `Bulk ${i}`, description: null, source_id: A.id, channel_item_id: channel[0], channel_stable_id: channel[1],
                channel_name: channel[0], channel_logo: null, program_start: now + i * 1000, program_end: now + 7200000 + i * 1000,
                pre_buffer_min: 1, post_buffer_min: 5, created_by: 1, created_at: now });
        }
    });
    insert();
    const settings = await db.settings.get();
    const began = process.hrtime.bigint();
    const list = engine.listScheduled({ settings });
    const ms = Number(process.hrtime.bigint() - began) / 1e6;
    assert.ok(list.filter(r => r.conflictsWith).length > 700, 'they clash');
    assert.ok(list.every(r => !r.conflictsWith || r.conflictsWith.length <= 10), 'at most ten ids each');
    assert.ok(ms < 400, `800 schedules took ${ms.toFixed(0)} ms`);
});
