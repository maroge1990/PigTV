const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// #332: a recording on a feed that is the provider's placeholder (a still slate on a connection closed within a
// second, again on every reconnect). The real engine, routing and shared ingest over a sandboxed database, a fake
// provider on local HTTP; ffmpeg is a script that writes pipe:0 into its one segment. The feed ends as `placeholder`;
// with another feed the recording carries on there in the same row; with none it keeps trying (D-59), and a part that
// held nothing but the slate is not kept; a part that recorded the programme before the slate came keeps it.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-placeholder-rec-')));
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
const routing = load('services/providerRouting');
const segments = load('services/recordingSegments');
const { scheduled, recordings } = load('db/recordingsDb');
const { stubNativeTools, drainSegmentQueue } = require('./helpers/fakeSegmentFfmpeg');
const realPlan = routing.plan;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await engine.tick(); await sleep(50); }
    assert.fail(`timed out waiting for: ${label}`);
}
/** The same without the engine's tick: a part that ended soon waits for the next tick, so this sees it between tries. */
async function untilNoTick(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(25); }
    assert.fail(`timed out waiting for: ${label}`);
}

// ---- ffmpeg: a segmented capture reading pipe:0 (every byte into its one segment; the end of input ends it) ----
const argsLog = path.join(sandbox, 'ffmpeg-args.log');
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const out = args[args.length - 1];
const dir = path.dirname(out);
const putPlaylist = (text) => { fs.writeFileSync(out + '.tmp', text); fs.renameSync(out + '.tmp', out); };
if (args.includes('-live_start_index')) { setInterval(() => {}, 1000); return; }
let pl = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n';
const file = fs.createWriteStream(path.join(dir, 'a000000.ts'));
let listed = false;
process.stdin.on('data', (d) => { file.write(d); if (!listed) { listed = true; pl += '#EXTINF:4.000000,\\na000000.ts\\n'; putPlaylist(pl); } });
process.stdin.on('end', () => file.end(() => { putPlaylist(pl + '#EXT-X-ENDLIST\\n'); process.exit(0); }));
`);
fs.chmodSync(FFMPEG, 0o755);
const captures = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    .filter(a => !a.includes('-live_start_index'));

// ---- MPEG-TS with a clock (a PCR per 10 ms of media) ----
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
function media(from, seconds, perTick) {
    const out = [];
    for (let k = 0; k < Math.round(seconds * 100); k++) {
        out.push(k % 20 === 0 ? plainPacket(0) : pcrPacket(from + k / 100));
        for (let j = 1; j < perTick; j++) out.push(plainPacket(0x101));
    }
    return Buffer.concat(out);
}
const SLATE = media(0, 1, 1); // ~150 kbps for 1 s

// '/slate.ts' sends the slate and closes (or, once `slateOver`, a channel); '/live.ts' a 1.2 Mb/s channel without end;
// '/turns.ts' that channel for 1.5 s on its first connection, then the slate.
let server, base, A, B;
let connections = {};
let slateOver = false;
function channel(res, untilMs = null, perTick = 8) {
    let t = 0;
    const started = Date.now();
    const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (untilMs && Date.now() - started >= untilMs) { clearInterval(timer); return res.end(); }
        res.write(media(t, 0.02, perTick)); t += 0.02;
    }, 20);
    res.on('close', () => clearInterval(timer));
}
function slate(res) { res.write(SLATE); setTimeout(() => res.end(), 30); }

let plan = null; // what routing.plan answers (the real plan needs channel links; what it returns is what matters here)
const candA = (p) => ({ providerId: A.id, providerName: 'Strong8K', role: 'primary', via: 'primary', url: `${base}${p}`, channelKey: 'sme', channelName: 'Sky Sports Main Event' });

before(async () => {
    server = http.createServer((req, res) => {
        connections[req.url] = (connections[req.url] || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        if (req.url === '/slate.ts') return slateOver ? channel(res) : slate(res);
        if (req.url === '/turns.ts') return connections[req.url] === 1 ? channel(res, 1500) : slate(res);
        if (req.url === '/drops.ts') return channel(res, 1000, 3); // a real 451 kbps (400p) channel whose connections drop after 1 s
        return channel(res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    B = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 1 });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                         VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Sky Sports Main Event', 1, 'sme', `${base}/slate.ts`);
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'TNT Sports 2', 2, 'tnt2', `${base}/turns.ts`);
    // Another listing of Sky Sports Main Event by the same provider (#332: a copy), which plays.
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'Sky Sports Main Event FHD', 3, 'sme2', `${base}/live.ts`);
    item.run(`${A.id}:pos_4`, A.id, 'pos_4', 'Racing 400p', 4, 'low', `${base}/drops.ts`);
    routing.plan = async () => plan();
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5,
        maxProviderStreams: 1, sharedIngestEnabled: true });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
    stubNativeTools(engine);
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    await drainSegmentQueue(segments, recordings);
    ingest.closeAll('test over');
    routing.reset();
    connections = {};
    slateOver = false;
    try { fs.unlinkSync(argsLog); } catch { /* none */ }
});

after(() => {
    routing.plan = realPlan;
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

function schedule(item, stableId, name) {
    const now = Date.now();
    return scheduled.create({ title: 'The Golf', description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stableId,
        channel_name: name, channel_logo: null, program_start: now - 1000, program_end: now + 120000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
const epochsOf = (rec) => segments.epochs(rec.work_dir).map(e => ({ n: e.n, count: segments.epochSegmentCount(e.dir) }));

test('a recording on the placeholder carries on in the same recording on another feed; the slate part is not kept', async () => {
    plan = () => ({
        candidates: [candA('/slate.ts'), { providerId: B.id, providerName: 'Dream 4K', role: 'backup', via: 'backup', url: `${base}/live.ts`, channelKey: '901', channelName: 'Sky Sports Main Event' }]
            .filter(c => !routing.isQuarantined(c.providerId, c.channelKey)),
        primaryKey: 'sme', channelName: 'Sky Sports Main Event', backupsConfigured: true, channelProviders: 2
    });
    const s = schedule('pos_1', 'sme', 'Sky Sports Main Event');
    await until(() => engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'carried on on Dream 4K');
    const [rec] = recordings.listBySchedule(s.id);
    assert.equal(recordings.listBySchedule(s.id).length, 1, 'one recording');
    await until(() => captures().length >= 2 && epochsOf(rec).some(e => e.n === 2 && e.count > 0), 'the second part records');
    assert.deepEqual(epochsOf(rec)[0], { n: 1, count: 0 }, 'the part that held only the slate was not kept');
    assert.equal(routing.isPlaceholder(A.id, 'sme'), true);
    const now = Date.now();
    assert.equal(routing.isQuarantined(A.id, 'sme', now + routing.PLACEHOLDER_MS + 1000), false, 'held back 3 min, not a failure\'s 10');
    assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
    await engine.cancelScheduled(s.id);
});

test('with nowhere else to go a recording keeps trying (D-59) without keeping the slate, and records once the channel is back', async () => {
    // One provider, no backups: the 'single' route.
    plan = () => ({ candidates: [candA('/slate.ts')], primaryKey: 'sme', channelName: 'Sky Sports Main Event', backupsConfigured: false, channelProviders: 1 });
    const s = schedule('pos_1', 'sme', 'Sky Sports Main Event');
    await until(() => captures().length >= 3, 'tried again, and again');
    const [rec] = recordings.listBySchedule(s.id);
    await untilNoTick(() => !engine.listActive().some(r => r.id === s.id), 'between tries');
    assert.equal(scheduled.getById(s.id).status, 'recording', 'still recording: not failed, not finished');
    assert.equal(recordings.getById(rec.id).status, 'recording');
    assert.ok(epochsOf(rec).length >= 3);
    for (const e of epochsOf(rec)) assert.equal(e.count, 0, `part ${e.n} held only the slate: not kept`);
    assert.equal(segments.recordedSeconds(rec.work_dir), 0, 'nothing of the slate is in the recording');
    assert.equal(segments.viewPlaylist(rec.work_dir).segments, 0, 'nor in its watch copy');
    // The channel comes back: the next try records it.
    slateOver = true;
    await until(() => epochsOf(rec).some(e => e.count > 0) && engine.listActive().some(r => r.id === s.id), 'recording the channel');
    await sleep(300);
    assert.equal(engine.listActive().some(r => r.id === s.id), true, 'and goes on');
    await engine.cancelScheduled(s.id);
});

test('a part that recorded the programme before the placeholder came keeps it', async () => {
    plan = () => ({ candidates: [{ ...candA('/turns.ts'), channelKey: 'tnt2', channelName: 'TNT Sports 2' }], primaryKey: 'tnt2', channelName: 'TNT Sports 2', backupsConfigured: false, channelProviders: 1 });
    const s = schedule('pos_2', 'tnt2', 'TNT Sports 2');
    await until(() => recordings.listBySchedule(s.id).length === 1 && engine.listActive().some(r => r.id === s.id), 'recording');
    const [rec] = recordings.listBySchedule(s.id);
    await untilNoTick(() => !engine.listActive().some(r => r.id === s.id), 'the part ended as the placeholder');
    assert.equal((connections['/turns.ts'] || 0), 3, 'the channel, then two connections of the slate');
    assert.equal(epochsOf(rec)[0].count, 1, 'the programme recorded before the slate is kept');
    assert.ok(fs.statSync(path.join(rec.work_dir, 'e1', 'a000000.ts')).size > 100000);
    await engine.cancelScheduled(s.id);
});

test('a part ended by the placeholder is held against the channel only, like a loop', () => {
    const entry = { route: { multi: true, oneProvider: false }, stalled: false, feedLost: { reason: 'placeholder', providerReason: true, onlyPlaceholder: true } };
    assert.equal(engine._heldAgainst(entry, { failover: true, ranLong: false }), 'channel');
    assert.equal(engine._heldAgainst({ ...entry, feedLost: { reason: 'upstream-lost', providerReason: true } }, { failover: true, ranLong: false }), 'provider');
});

test('with a same-provider copy of the channel the recording carries on on the copy (the real plan)', async () => {
    plan = () => realPlan(A.id, 'pos_1', Date.now(), { keepTrying: true });
    const s = schedule('pos_1', 'sme', 'Sky Sports Main Event');
    await until(() => (connections['/live.ts'] || 0) >= 1 && engine.listActive().some(r => r.id === s.id), 'carried on on the copy');
    const [rec] = recordings.listBySchedule(s.id);
    assert.equal(recordings.listBySchedule(s.id).length, 1, 'one recording');
    await until(() => epochsOf(rec).some(e => e.n === 2 && e.count > 0), 'the copy records');
    assert.deepEqual(epochsOf(rec)[0], { n: 1, count: 0 }, 'the slate part was not kept');
    assert.equal(routing.isQuarantined(A.id, 'sme'), true);
    await engine.cancelScheduled(s.id);
});

test('Codex high: a recording-only real 448 kbps feed with short drops keeps its programme and is not quarantined', async () => {
    plan = () => ({ candidates: [{ ...candA('/drops.ts'), channelKey: 'low', channelName: 'Racing 400p' }], primaryKey: 'low', channelName: 'Racing 400p', backupsConfigured: false, channelProviders: 1 });
    const s = schedule('pos_4', 'low', 'Racing 400p');
    await until(() => (connections['/drops.ts'] || 0) >= 3, 'three connections, each dropped after 1 s');
    const [rec] = recordings.listBySchedule(s.id);
    assert.ok(epochsOf(rec).some(e => e.count > 0), 'its programme is recorded');
    assert.equal(epochsOf(rec)[0].count, 1, 'the first part is kept');
    assert.equal(routing.isPlaceholder(A.id, 'low'), false);
    assert.equal(routing.isQuarantined(A.id, 'low'), false);
    await engine.cancelScheduled(s.id);
});

test('Codex high: a part is deleted only with every connection the placeholder\'s AND a recorded rate under 250 kbps', () => {
    const dir = path.join(sandbox, 'rec-unit', 'e1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000000,\na000000.ts\n#EXT-X-ENDLIST\n');
    const entry = (onlyPlaceholder) => ({ outputPath: dir, feedLost: { reason: 'placeholder', providerReason: true, onlyPlaceholder } });
    fs.writeFileSync(path.join(dir, 'a000000.ts'), Buffer.alloc(100000)); // 200 kbps over 4 s: the slate's rate
    assert.equal(engine._slatePart(entry(true)), true);
    assert.equal(engine._slatePart(entry(false)), false, 'not every connection was the placeholder\'s');
    fs.writeFileSync(path.join(dir, 'a000000.ts'), Buffer.alloc(224000)); // 448 kbps: a channel's rate
    assert.equal(engine._slatePart(entry(true)), false, 'recorded at a channel\'s rate: kept');
    // Codex sign-off: a rate that cannot be measured keeps the part (fail closed), with recorded files present.
    fs.writeFileSync(path.join(dir, 'a000000.ts'), Buffer.alloc(100000));
    fs.renameSync(path.join(dir, 'archive.m3u8'), path.join(dir, 'archive.off'));
    assert.equal(engine._slatePart(entry(true)), false, 'no playlist: kept');
    fs.renameSync(path.join(dir, 'archive.off'), path.join(dir, 'archive.m3u8'));
    fs.writeFileSync(path.join(dir, 'archive.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000000,\na000000.ts\n#EXTINF:4.000000,\na000001.ts\n#EXT-X-ENDLIST\n');
    fs.symlinkSync(path.join(dir, 'missing.ts'), path.join(dir, 'a000001.ts')); // a segment whose stat fails
    assert.equal(engine._slatePart(entry(true)), false, 'a failed segment stat: kept');
    assert.ok(fs.existsSync(path.join(dir, 'a000000.ts')));
    // discardEpoch fails closed: its playlist cannot be rewritten (a folder in its way) -> nothing deleted.
    const dir2 = path.join(sandbox, 'rec-unit2', 'e1');
    fs.mkdirSync(path.join(dir2, 'archive.m3u8.tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'a000000.ts'), Buffer.alloc(1000));
    assert.equal(segments.discardEpoch(99, dir2), false);
    assert.ok(fs.existsSync(path.join(dir2, 'a000000.ts')), 'kept');
});
