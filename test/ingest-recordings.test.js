const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// Wave 5 (R2, phase 5a): recordings are the shared ingest's first consumer, behind
// `sharedIngestEnabled` (off by default). The real engine, coordinator and ingest over a sandboxed
// database and a fake MPEG-TS provider on local HTTP; ffmpeg is a script that writes its stdin to
// the output (so the file is exactly the bytes it was fed). With the switch on: the capture reads
// pipe:0 with today's output arguments, the file is the provider's own bytes, two recordings of
// one channel share ONE connection (even at a limit of 1), a different channel still waits, a
// stream that is not MPEG-TS falls back to today's path. With it off: nothing changes.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-ingest-rec-')));
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
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5,
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
    await db.settings.update({ sharedIngestEnabled: true });
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function due(item = 'pos_1', stable = 'ff', windowMs = 60000) {
    const now = Date.now();
    return scheduled.create({ title: `Show ${++n}`, description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stable,
        channel_name: item, channel_logo: null, program_start: now - 1000, program_end: now + windowMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
const fileOf = (s) => recordings.listBySchedule(s.id)[0]?.file_path;

test('switch on: the capture reads pipe:0 with today\'s output arguments, and the file is the provider\'s own bytes', async () => {
    const s = due();
    await until(() => captures().length === 1 && fs.existsSync(fileOf(s) || '') && fs.statSync(fileOf(s)).size > 20000, 'recording');
    const args = captures()[0];
    assert.deepEqual(args.slice(0, 3), ['-y', '-i', 'pipe:0']);
    assert.ok(!args.includes('-user_agent') && !args.includes('-reconnect'), 'the ingest connects, not ffmpeg');
    assert.deepEqual(args.slice(3, -1), ['-map', '0:v?', '-map', '0:a?', '-ignore_unknown', '-sn', '-dn', '-c', 'copy',
        '-avoid_negative_ts', 'make_zero', '-f', 'mpegts'], 'the output arguments are today\'s');
    await engine.cancelScheduled(s.id);
    await until(() => recordings.listBySchedule(s.id)[0]?.status === 'completed', 'finished by end of input');
    const file = fs.readFileSync(fileOf(s));
    assert.equal(file.length % 188, 0);
    const provider = Buffer.concat(sent['/ff.ts']);
    assert.ok(provider.indexOf(file.subarray(0, 188 * 50)) >= 0, 'the file\'s bytes are the provider\'s, in order');
    assert.equal(((file[1] & 0x1f) << 8) | file[2], 0, 'it starts at a PAT');
    assert.equal(connections['/ff.ts'], 1);
});

test('two recordings of one channel share one connection, even at a limit of 1; a different channel is another connection', async () => {
    const one = due();
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    const two = due();
    await until(() => recordings.listBySchedule(two.id)[0]?.status === 'recording', 'second, on the same ingest');
    assert.equal(connections['/ff.ts'], 1, 'one provider connection for both');
    const active = engine.listActive().filter(r => r.ingestKey);
    assert.equal(active.length, 2);
    assert.equal(active[0].ingestKey, active[1].ingestKey);
    assert.equal(coordinator.canRecordFreely(A.id, await db.settings.get()), false, 'the connection is in use');
    // Without a backup provider, recordings do not count against each other (maxConcurrentRecordings
    // does that, as today): a different channel records too, on its own connection and ingest.
    const other = due('pos_2', 'fl');
    await until(() => recordings.listBySchedule(other.id)[0]?.status === 'recording', 'the other channel');
    assert.equal(connections['/fl.ts'], 1, 'its own connection');
    const keys = new Set(engine.listActive().map(r => r.ingestKey));
    assert.equal(keys.size, 2, 'its own ingest');
    assert.equal(connections['/ff.ts'], 1, 'still one for the shared channel');
});

test('a stream that is not MPEG-TS falls back to today\'s path', async () => {
    const s = due('pos_3', 'odd');
    await until(() => captures().length === 1, 'started');
    const args = captures()[0];
    assert.equal(args[args.indexOf('-i') + 1], `${base}/html`, 'its own connection, as today');
    assert.ok(args.includes('-reconnect'));
    await engine.cancelScheduled(s.id);
});

test('switch off: today\'s arguments, no ingest', async () => {
    await db.settings.update({ sharedIngestEnabled: false });
    const s = due();
    await until(() => captures().length === 1, 'started');
    const args = captures()[0];
    assert.equal(args[args.indexOf('-i') + 1], `${base}/ff.ts`);
    assert.deepEqual(ingest.list(), []);
    await engine.cancelScheduled(s.id);
});

test('the pool counts recordings on one ingest as one connection', async () => {
    const settings = { ...(await db.settings.get()), maxProviderStreams: 2 };
    const row = (id, ingestKey) => ({ id, source_id: A.id, providerId: A.id, ...(ingestKey ? { ingestKey } : {}) });
    assert.equal(coordinator.canRecordFreely(A.id, settings, [row(1, 'k'), row(2, 'k')]), true, 'two on one ingest: one of two connections used');
    assert.equal(coordinator.canRecordFreely(A.id, settings, [row(1, 'k'), row(2, 'j')]), false, 'two ingests: both used');
    assert.equal(coordinator.canRecordFreely(A.id, settings, [row(1), row(2)]), false, 'without an ingest, as today');
});

test('a provider that dies for good: the ingest gives up and the recording ends with what it captured', async () => {
    ingest.tuning.reconnectMs = 1500;
    try {
        const s = due('pos_4', 'shaky');
        await until(() => recordings.listBySchedule(s.id)[0]?.status === 'completed', 'ended', 15000);
        const rec = recordings.listBySchedule(s.id)[0];
        assert.ok(fs.statSync(rec.file_path).size > 1024, 'what it recorded is kept');
        assert.ok(connections['/dies.ts'] >= 2, 'the ingest tried to reconnect');
        assert.deepEqual(ingest.list(), []);
    } finally {
        ingest.tuning.reconnectMs = 10000;
    }
});
