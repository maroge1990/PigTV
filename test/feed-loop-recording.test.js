const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { haveFfmpeg, makeFeeds } = require('./helpers/loopFeeds');

// #324 (Opus review): a recording on a provider feed that loops the same clip, end to end. The real engine, coordinator,
// routing and shared ingest over a sandboxed database; the provider serves a clip looped by ffmpeg (fresh timestamps,
// the same payloads) on local HTTP, the backup an endless feed; ffmpeg is a script that writes pipe:0 into its segment.
// The recording's planned candidates carry the channel (channelRef) to its ingest, the loop is found, the backup is
// somewhere the recording would really go (its route, a connection for it), so the feed ends and the recording carries
// on in the same row on the backup; the looping provider is quarantined for the channel only. Skips without libx264.
const skip = !haveFfmpeg && 'ffmpeg with libx264 is not installed here';
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-loop-rec-')));
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

let server, base, A, B, feeds;
const connections = {};
function dummyPacket(n) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47; p[1] = n % 20 === 0 ? 0x40 : 0x01; p[2] = 0; p[3] = 0x10 | (n & 0x0f);
    return p;
}

before(async () => {
    if (skip) return;
    feeds = makeFeeds(path.join(sandbox, 'feeds'));
    server = http.createServer((req, res) => {
        connections[req.url] = (connections[req.url] || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        if (req.url === '/loop.ts') {
            const data = fs.readFileSync(feeds.loop);
            (async () => { for (let at = 0; at < data.length && !res.destroyed; at += 65536) { res.write(data.subarray(at, at + 65536)); await sleep(5); } })();
            return; // and stays open
        }
        let n = 0;
        const timer = setInterval(() => res.write(Buffer.concat(Array.from({ length: 30 }, () => dummyPacket(n++)))), 20);
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    B = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 1 });
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                            VALUES (?, ?, 'pos_1', 'live', 'FOX Footy', 'Sport', 0, 1, 'ff', ?)`).run(`${A.id}:pos_1`, A.id, `${base}/loop.ts`);
    // The channel's providers (the real plan needs channel links; what it returns is what matters here).
    routing.plan = async () => ({
        candidates: [
            { providerId: A.id, providerName: 'Strong8K', role: 'primary', via: 'primary', url: `${base}/loop.ts`, channelKey: 'ff', channelName: 'FOX Footy' },
            { providerId: B.id, providerName: 'Dream 4K', role: 'backup', via: 'backup', url: `${base}/live.ts`, channelKey: '504', channelName: 'FOX Footy' }
        ].filter(c => !routing.isQuarantined(c.providerId, c.channelKey)),
        primaryKey: 'ff', channelName: 'FOX Footy', backupsConfigured: true, channelProviders: 2
    });
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5,
        maxProviderStreams: 1, sharedIngestEnabled: true });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
    stubNativeTools(engine);
});

afterEach(async () => {
    if (skip) return;
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    await drainSegmentQueue(segments, recordings);
    ingest.closeAll('test over');
    routing.reset();
});

after(() => {
    routing.plan = realPlan;
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('a recording on a looping provider feed carries on in the same recording on the backup; the loop is the channel\'s alone', { skip }, async () => {
    const lines = [];
    const log = console.log, warn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try {
        const now = Date.now();
        const s = scheduled.create({ title: 'The Match', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
            channel_name: 'FOX Footy', channel_logo: null, program_start: now - 1000, program_end: now + 120000,
            pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
        // The recording reads the looping feed, and its candidates told the ingest which channel it is.
        await until(() => ingest.list().some(i => i.repeatingSec === null && i.state === 'live'), 'recording through the shared feed');
        await until(() => engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'carried on on Dream 4K', 30000);
        const rows = recordings.listBySchedule(s.id);
        assert.equal(rows.length, 1, 'one recording');
        assert.equal(rows[0].provider_id, B.id);
        // The engine lists a capture as soon as it spawns it; the stand-in ffmpeg logs its arguments once node has
        // started, which on a loaded machine (CI: every file at once on 2 vCPUs) can come later. Wait for it.
        await until(() => captures().length >= 2, 'the second part\'s ffmpeg started');
        assert.equal(captures().length, 2, 'a second part, on the backup');
        const closed = ingest.status().recent.find(r => r.repeatingSec !== null);
        assert.ok(closed && Math.abs(closed.repeatingSec - feeds.clipSec) < 0.5, 'the looping feed was ended for repeating');
        assert.equal(closed.why, `Strong8K kept repeating the same ${feeds.clipSec} s clip`);
        assert.ok(lines.some(l => l.includes('Strong8K is repeating the same') && l.includes('Dream 4K can take over')), lines.filter(l => l.includes('repeating')).join(' | '));
        assert.equal(routing.isQuarantined(A.id, 'ff'), true, 'quarantined for the channel');
        assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
        assert.ok(!lines.join('\n').includes(base), 'no provider URL in the log');
        await engine.cancelScheduled(s.id);
    } finally { console.log = log; console.warn = warn; }
});

test('the recording\'s candidates carry the channel they play (channelRef), from the schedule', { skip }, async () => {
    const now = Date.now();
    const s = scheduled.create({ title: 'Plumbing', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
        channel_name: 'FOX Footy', channel_logo: null, program_start: now - 1000, program_end: now + 60000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    let seen = null;
    const subscribe = ingest.subscribe;
    ingest.subscribe = async (opts) => { if (opts.purpose === 'recording') seen = opts.channelRef; return subscribe(opts); };
    try {
        await until(() => seen !== null, 'the recording subscribed');
        assert.deepEqual(seen, { sourceId: A.id, channelId: 'pos_1' });
    } finally { ingest.subscribe = subscribe; await engine.cancelScheduled(s.id); }
});
