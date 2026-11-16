const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #333: a recording's direct capture (not the shared ingest) answered with the provider's placeholder: a finite
// 10-minute file with a length, read in about a second (production: six such parts, an hour of slate in the MP4). The
// real engine and real ffmpeg over a sandboxed database, the fake provider in its `file` mode. The part is the
// placeholder: nothing of it is kept, the channel is held back as #332's placeholder, and the recording keeps trying
// (D-59) until the channel is back.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-placeholder-file-')));
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
const { createFakeProvider } = require('../scripts/fake-provider');
const realPlan = routing.plan;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await engine.tick(); await sleep(100); }
    assert.fail(`timed out waiting for: ${label}`);
}

let fake, base, channel, A;
let backups = true;
const streamUrl = () => `${base}/live/pigtv/fake/${channel.id}.ts`;
const setMode = (mode) => fetch(`${base}/fake/fail?stream=${channel.id}&mode=${mode}`, { method: 'POST' }).then(r => assert.equal(r.status, 200));

before(async () => {
    if (!hasFfmpeg) return;
    fake = createFakeProvider({ quiet: true });
    base = await fake.listen(0);
    channel = fake.lineup.find(c => !c.kind || c.kind === 'normal');
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                            VALUES (?, ?, 'pos_1', 'live', 'NFL Network', 'Sport', 0, 1, 'nfl', ?)`).run(`${A.id}:pos_1`, A.id, streamUrl());
    // The real plan needs channel links; what it returns is what matters. `backups`: a server with backups, this
    // channel on one provider (a route with the channel's key, so it can be held back); else the 'single' route.
    routing.plan = async () => ({
        candidates: [{ providerId: A.id, providerName: 'Strong8K', role: 'primary', via: 'primary', url: streamUrl(), channelKey: 'nfl', channelName: 'NFL Network' }],
        primaryKey: 'nfl', channelName: 'NFL Network', backupsConfigured: backups, channelProviders: 1
    });
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5, maxProviderStreams: 2 });
    engine.init({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    engine.shutdown();
    stubNativeTools(engine);
});

afterEach(async () => {
    if (!hasFfmpeg) return;
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    await drainSegmentQueue(segments, recordings);
    ingest.closeAll('test over');
    routing.reset();
    await setMode('ok');
});

after(async () => {
    routing.plan = realPlan;
    await fake?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

function schedule() {
    const now = Date.now();
    return scheduled.create({ title: 'Cardinals at Seahawks', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 'nfl',
        channel_name: 'NFL Network', channel_logo: null, program_start: now - 1000, program_end: now + 180000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
const epochsOf = (rec) => segments.epochs(rec.work_dir).map(e => ({ n: e.n, count: segments.epochSegmentCount(e.dir) }));

async function placeholderThenLive({ shared, withBackups }) {
    await db.settings.update({ sharedIngestEnabled: shared });
    backups = withBackups;
    await setMode('file');
    const logged = [];
    const realLog = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); realLog(...a); };
    try {
        const s = schedule();
        await until(() => { const [r] = recordings.listBySchedule(s.id); return r && segments.epochs(r.work_dir).length >= 2 && !engine.listActive().some(x => x.id === s.id); },
            'two parts tried, the second over');
        const [rec] = recordings.listBySchedule(s.id);
        assert.equal(recordings.listBySchedule(s.id).length, 1, 'one recording');
        assert.equal(scheduled.getById(s.id).status, 'recording', 'still recording: not failed, not finished (D-59)');
        for (const e of epochsOf(rec)) assert.equal(e.count, 0, `part ${e.n} was the placeholder file: not kept`);
        assert.equal(segments.recordedSeconds(rec.work_dir), 0, 'none of the placeholder\'s 600 s is in the recording');
        assert.ok(logged.some(l => /part 1 held only the provider's placeholder \(a file\); not kept/.test(l)), 'the part is logged as the placeholder');
        // A single route has no channel key to hold back (as #332's placeholder): it simply tries again on the next tick.
        if (withBackups) {
            assert.equal(routing.isPlaceholder(A.id, 'nfl'), true, 'noted as the provider\'s placeholder');
            const now = Date.now();
            assert.equal(routing.isQuarantined(A.id, 'nfl', now), true, 'the channel is held back');
            assert.equal(routing.isQuarantined(A.id, 'nfl', now + routing.PLACEHOLDER_MS + 1000), false, 'for #332\'s 3 min');
        }
        assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'not counted toward the provider');
        // The channel comes back: the next try records it, in real time, in the same recording.
        await setMode('ok');
        await until(() => epochsOf(rec).some(e => e.count > 0), 'the live channel is recorded again', 30000);
        await engine.cancelScheduled(s.id);
    } finally {
        console.log = realLog;
    }
}

test('a direct capture answered with a 10-minute file keeps none of it and keeps trying (shared ingest refused it for its length)', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    await placeholderThenLive({ shared: true, withBackups: true });
});

test('the same on a single route with the shared ingest off: read far faster than real time, the file is the placeholder', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    await placeholderThenLive({ shared: false, withBackups: false });
});

/** An epoch's playlist of `n` 4 s segments, each a file at `kbps`. */
function writeEpoch(epochDir, n, kbps) {
    fs.rmSync(epochDir, { recursive: true, force: true });
    fs.mkdirSync(epochDir, { recursive: true });
    let pl = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
    for (let i = 0; i < n; i++) {
        const name = `a${String(i).padStart(6, '0')}.ts`;
        fs.writeFileSync(path.join(epochDir, name), Buffer.alloc(Math.round(kbps * 1000 / 8 * 4)));
        pl += `#EXTINF:4.000000,\n${name}\n`;
    }
    fs.writeFileSync(path.join(epochDir, 'archive.m3u8'), pl);
}

test('fastReadOf: a live channel\'s connect burst or buffered start is never a file; nothing measurable keeps the part', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    const epochDir = path.join(fs.mkdtempSync(path.join(sandbox, 'e')), 'e1');
    fs.mkdirSync(epochDir);
    const entry = (wallSec, extra = {}) => ({ outputPath: epochDir, spawnedAt: 1_000_000 - wallSec * 1000, feed: null, finiteAnswer: false, ...extra });
    const at = 1_000_000;
    assert.equal(engine._fastReadOf(entry(10), at), null, 'nothing listed: not measured');
    writeEpoch(epochDir, 10, 100); // 40 s of media in 10 s: a provider's burst at connect, under the 60 s floor
    assert.equal(engine._fastReadOf(entry(10), at), null);
    writeEpoch(epochDir, 150, 71); // 600 s in 2 s at the slate's 71 kbps: the placeholder file
    assert.deepEqual(engine._fastReadOf(entry(2), at), { mediaSec: 600, wallSec: 2, finiteAnswer: false });
    writeEpoch(epochDir, 150, 2000); // 600 s in 2 s at a programme's rate: 598 s ahead of real time, no live buffer is
    assert.ok(engine._fastReadOf(entry(2), at));
    writeEpoch(epochDir, 30, 100); // 120 s in 60 s: twice real time is not enough
    assert.equal(engine._fastReadOf(entry(60), at), null);
    writeEpoch(epochDir, 15, 2000); // Codex #333 high: a buffered live start, 60 s in 10 s at a programme's rate
    assert.equal(engine._fastReadOf(entry(10), at), null, 'a buffered live start is not a file');
    writeEpoch(epochDir, 15, 100); // the same at a blank picture's rate
    assert.ok(engine._fastReadOf(entry(10), at));
    writeEpoch(epochDir, 5, 100); // 20 s in 2 s, after the shared ingest saw a length: the lower floor
    assert.equal(engine._fastReadOf(entry(2), at), null);
    assert.ok(engine._fastReadOf(entry(2, { finiteAnswer: true }), at));
    assert.equal(engine._fastReadOf(entry(2, { finiteAnswer: true, feed: {} }), at), null, 'a shared feed is the ingest\'s to judge');
});

test('a direct capture still reading a file faster than real time after 10 s is ended there', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    const epochDir = path.join(fs.mkdtempSync(path.join(sandbox, 'r')), 'e1');
    writeEpoch(epochDir, 20, 100);
    const written = [];
    const at = 1_000_000;
    const entry = (ranSec) => ({ recordingId: 9, segmented: { epoch: 1 }, outputPath: epochDir, spawnedAt: at - ranSec * 1000, feed: null, finiteAnswer: false,
        fastRead: null, stopRequested: false, proc: { stdin: { writable: true, destroyed: false, write: (d) => written.push(d) } } });
    const early = entry(5);
    engine._checkFastRead(early, at); // 80 s in 5 s, but before the first 10 s: not judged yet
    assert.equal(early.fastRead, null);
    const late = entry(20);
    engine._checkFastRead(late, at); // 80 s of media in 20 s: 4x real time
    assert.deepEqual(late.fastRead, { mediaSec: 80, wallSec: 20, finiteAnswer: false });
    assert.deepEqual(written, ['q'], 'asked to stop (its exit judges its segments)');
});

test('Codex #333 high: programme then the placeholder file in one ffmpeg run keeps the programme and drops only the slate tail', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    // One response: 20 s of programme at ~800 kbps, then the 10-minute still file (timestamps running on), no length.
    const ff = (args) => assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
    const prog = path.join(sandbox, 'prog.ts');
    const clip = path.join(sandbox, 'slate-clip.ts');
    const slate = path.join(sandbox, 'slate.ts');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-b:v', '800k', '-minrate', '800k', '-maxrate', '800k',
        '-bufsize', '800k', '-x264-params', 'nal-hrd=cbr', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-f', 'mpegts', prog]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x203040:size=640x360:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=10',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-b:v', '40k', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-f', 'mpegts', clip]);
    ff(['-stream_loop', '59', '-i', clip, '-c', 'copy', '-output_ts_offset', '20', '-f', 'mpegts', slate]);
    const body = Buffer.concat([fs.readFileSync(prog), fs.readFileSync(slate)]);
    const http = require('node:http');
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(body); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const setItemUrl = (u) => sqlite.getDb().prepare('UPDATE playlist_items SET stream_url = ? WHERE id = ?').run(u, `${A.id}:pos_1`);
    setItemUrl(`http://127.0.0.1:${server.address().port}/live.ts`);
    await db.settings.update({ sharedIngestEnabled: false });
    backups = true;
    try {
        const s = schedule();
        await until(() => { const [r] = recordings.listBySchedule(s.id); return r && segments.epochs(r.work_dir).length >= 1 && !engine.listActive().some(x => x.id === s.id); },
            'the part read and ended');
        const [rec] = recordings.listBySchedule(s.id);
        const kept = segments.recordedSeconds(rec.work_dir);
        assert.ok(kept >= 16 && kept <= 32, `the programme's ~20 s is kept, the slate's 600 s is not (${kept} s kept)`);
        assert.equal(scheduled.getById(s.id).status, 'recording', 'and it keeps trying (D-59)');
        assert.equal(routing.isPlaceholder(A.id, 'nfl'), true, 'the file is noted as the placeholder');
        await engine.cancelScheduled(s.id);
    } finally {
        setItemUrl(streamUrl());
        server.closeAllConnections?.(); server.close();
    }
});

test('Codex #333 sign-off: PIGTV_BLANK_KBPS=500 never lets a buffered real 448 kbps programme be a file, or be deleted', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    const placeholderRule = load('services/feedPlaceholder');
    const before = process.env.PIGTV_BLANK_KBPS;
    process.env.PIGTV_BLANK_KBPS = '500';
    try {
        assert.equal(placeholderRule.connectionLimitKbps(null), 500, 'the blank-picture threshold follows the override');
        assert.equal(placeholderRule.destructiveKbps(), 250, 'the threshold that deletes never goes above 250');
        const epochDir = path.join(fs.mkdtempSync(path.join(sandbox, 'b')), 'e1');
        writeEpoch(epochDir, 15, 448); // 60 s at 448 kbps delivered in 10 s: a buffered live start
        const at = 1_000_000;
        assert.equal(engine._fastReadOf({ outputPath: epochDir, spawnedAt: at - 10000, feed: null, finiteAnswer: false }, at), null, 'not a file');
        assert.equal(segments.trailingLowRate(epochDir, placeholderRule.destructiveKbps()).trailing, 0, 'no segment deletable');
        assert.equal(engine._slatePart({ outputPath: epochDir, feedLost: { reason: 'placeholder', onlyPlaceholder: true } }), false, '#332\'s slate part is not it either');
    } finally {
        if (before === undefined) delete process.env.PIGTV_BLANK_KBPS; else process.env.PIGTV_BLANK_KBPS = before;
    }
});
