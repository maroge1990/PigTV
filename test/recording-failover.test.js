const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0177 (multi-provider P7): recordings choose a provider with a free connection, fail
// over when ffmpeg cannot start on one, and continue in a new part when their provider
// dies (or stalls) mid-recording. Default path only; with no backup configured nothing
// changes. The real engine, coordinator and routing in a sandboxed database; ffmpeg is a
// node script that behaves per stream URL.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rec-failover-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
delete process.env.PIGTV_TUNER;
// 0193: the fake ffmpeg below counts every start; background preparation of the
// recordings earlier tests finished would run it too and be counted. Preparation has
// its own tests (recording-prepare.test.js).
process.env.PIGTV_NATIVE_PREPARE = '0';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const engine = load('services/recordingEngine');
const routing = load('services/providerRouting');
const { scheduled, recordings } = load('db/recordingsDb');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tuning = engine._failoverTuning;
const TUNING = { ...tuning };

// ---- fake ffmpeg: what each stream URL does --------------------------------------
// ok     writes, keeps writing; on "q" (a stop) exits with a provider-looking error, so
//        a requested stop that were taken for a provider failure would show.
// 502    the provider's HTTP 502 at once, nothing written.
// dies   writes for a moment, then the connection is reset.
// stall  writes once, then nothing (the provider went silent); exits on "q".
const behaviourFile = path.join(sandbox, 'ffmpeg-behaviour.json');
const startsFile = path.join(sandbox, 'ffmpeg-starts.log');
const behaviour = {};
const setBehaviour = (u, kind) => { behaviour[u] = kind; fs.writeFileSync(behaviourFile, JSON.stringify(behaviour)); };
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const url = args[args.indexOf('-i') + 1];
const out = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(startsFile)}, url + '\\n');
let map = {};
try { map = JSON.parse(fs.readFileSync(${JSON.stringify(behaviourFile)}, 'utf8')); } catch (e) {}
const kind = map[url] || 'ok';
const chunk = Buffer.alloc(4000);
process.stdin.on('data', (d) => {
  if (!String(d).includes('q')) return;
  if (kind === 'stall') process.exit(0);
  process.stderr.write('[tcp @ 0x1] Connection reset by peer\\n');
  process.exit(1);
});
if (kind === '502') {
  process.stderr.write('[in#0 @ 0x1] Error opening input: Server returned 5XX Server Error reply\\n');
  process.exit(1);
}
fs.writeFileSync(out, chunk);
if (kind !== 'stall') setInterval(() => fs.appendFileSync(out, chunk.subarray(0, 500)), 50);
else setInterval(() => {}, 1000);
if (kind === 'dies') setTimeout(() => {
  process.stderr.write('[tcp @ 0x1] Connection reset by peer\\nError during demuxing: Connection reset by peer\\n');
  process.exit(1);
}, 400);
`);
fs.chmodSync(FFMPEG, 0o755);
const startsOf = () => (fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').split('\n').filter(Boolean) : []);

// ---- logs: kept, so no line this feature writes may carry a URL -------------------
const logLines = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logLines.push(a.join(' ')); if (process.env.DEBUG_REC_FAILOVER) realConsole[k](...a); };

let A, B, C;
const url = {
    A: (n) => `http://strong.invalid/live/u/p/${n}.ts`,
    B: (n) => `http://trex.invalid/live/u/p/${n}.ts`,
    C: (n) => `http://dream.invalid/live/u/p/${n}.ts`
};

before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    B = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    C = await db.sources.create({ type: 'm3u', name: 'Dream4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 2 });
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Sports 505', 'Sport', 0, 1, 's101', ?)`).run(`${A.id}:pos_1`, A.id, url.A(101));
    d.prepare('INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, ?, ?, ?)').run(B.id, '5001', 'Trex 5001', null);
    d.prepare('INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, ?, ?, ?)').run(C.id, '7001', 'Dream 7001', url.C(7001));
    const link = d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
                            VALUES (?, 's101', ?, ?, 'exact', 'auto', 1, 100, ?)`);
    link.run(A.id, B.id, '5001', Date.now());
    link.run(A.id, C.id, '7001', Date.now());

    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown(); // the test drives tick() itself
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) {
        await engine.cancelScheduled(s.id);
        scheduled.setStatus(s.id, 'cancelled');
    }
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    routing.reset();
    Object.assign(tuning, TUNING);
    for (const k of Object.keys(behaviour)) delete behaviour[k];
    fs.writeFileSync(behaviourFile, '{}');
    try { fs.unlinkSync(startsFile); } catch { /* none */ }
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: true });
    await db.settings.update({ minFreeSpaceGB: 0 });
});

after(() => {
    Object.assign(console, realConsole);
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function due({ windowMs = 60000 } = {}) {
    const now = Date.now();
    return scheduled.create({ title: `Match ${++n}`, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's101',
        channel_name: 'Fox Sports 505', channel_logo: null, program_start: now - 1000, program_end: now + windowMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
async function viewerOn(providerId) {
    const s = await transcodeSession.createSession(`http://elsewhere.invalid/live/${Math.random()}.ts`, { owner: `device:${providerId}`, live: true, providerId });
    s.lastAccess = Date.now();
    return s;
}
async function until(cond, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await engine.tick();
        await sleep(40);
    }
    assert.fail(`timed out waiting for: ${label}`);
}
const partsOf = (id) => recordings.listBySchedule(id);
const noUrl = (text, label) => {
    assert.ok(!String(text).includes('://'), `${label}: carries a URL: ${text}`);
    assert.ok(!/\.invalid|\/u\/p\//.test(String(text)), `${label}: leaks a stream address: ${text}`);
};

// ------------------------------------------------------------------ choosing --

test('primary busy with a viewer, backup free: records on the backup, nobody is asked', async () => {
    await viewerOn(A.id);
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'recording' && startsOf().length === 1, 'recording');
    assert.deepEqual(startsOf(), [url.B(5001)]);
    const [rec] = partsOf(s.id);
    assert.equal(rec.provider_id, B.id);
    assert.equal(rec.part, 1);
    assert.equal(coordinator._prompts.has(s.id), false, 'no prompt');
    assert.deepEqual(engine.listActive().filter(r => r.id === s.id).map(r => r.providerId), [B.id], 'it holds the backup\'s connection');
    assert.equal(coordinator.activeStreams().length, 1, 'the viewer on the primary is left alone');
});

test('every provider busy: the prompt is put on the first candidate, as before', async () => {
    for (const p of [A, B, C]) await viewerOn(p.id);
    const s = due();
    await engine.tick();
    assert.equal(scheduled.getById(s.id).status, 'waiting');
    assert.equal(coordinator._prompts.get(s.id).providerId, A.id);
    assert.deepEqual(startsOf(), [], 'nothing started');
});

test('no warning ahead of a recording when a provider has a free connection for it', async () => {
    await viewerOn(A.id);
    const now = Date.now();
    const s = scheduled.create({ title: 'Later', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's101',
        channel_name: 'Fox Sports 505', channel_logo: null, program_start: now + 60000, program_end: now + 120000,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    await engine.tick();
    assert.equal(coordinator._prompts.has(s.id), false);
    await viewerOn(B.id);
    await viewerOn(C.id);
    await engine.tick();
    assert.equal(coordinator._prompts.get(s.id)?.providerId, A.id, 'every provider busy: announced on the first');
});

// ------------------------------------------------------------ start failover --

test('502 on the primary as it starts: the backup takes over the same recording row', async () => {
    setBehaviour(url.A(101), '502');
    const s = due();
    await until(() => startsOf().length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'on the backup');
    assert.deepEqual(startsOf(), [url.A(101), url.B(5001)]);
    const parts = partsOf(s.id);
    assert.equal(parts.length, 1, 'one recording, not a failed stub plus the real one');
    assert.equal(parts[0].provider_id, B.id);
    assert.equal(parts[0].status, 'recording');
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.ok(routing.isQuarantined(A.id, 's101'), 'the primary is skipped for this channel for a while');
    await until(() => fs.existsSync(parts[0].file_path) && fs.statSync(parts[0].file_path).size > 1024, 'the file is written');
});

test('502 everywhere: fails as before, with a plain reason', async () => {
    for (const u of [url.A(101), url.B(5001), url.C(7001)]) setBehaviour(u, '502');
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'failed', 'failed');
    assert.equal(startsOf().length, 3);
    assert.equal(partsOf(s.id).length, 1);
    assert.equal(partsOf(s.id)[0].status, 'failed');
    assert.match(scheduled.getById(s.id).error, /Dream4K did not deliver the stream, and no other provider had a free connection/);
    noUrl(scheduled.getById(s.id).error, 'schedule error');
    noUrl(partsOf(s.id)[0].error, 'recording error');
});

// ------------------------------------------------------------ continuation --

test('provider dies mid-recording: part 2 on the next provider, part 1 kept and partial, completed at the stop time', async () => {
    tuning.startFailoverMs = 200;
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'dies');
    const s = due({ windowMs: 3000 });
    await until(() => partsOf(s.id).length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'part 2');
    const [one, two] = partsOf(s.id);
    assert.equal(one.status, 'completed');
    assert.equal(one.is_partial, 1);
    assert.equal(one.part, 1);
    assert.equal(one.provider_id, A.id);
    assert.match(one.error, /Strong8K lost the stream; the recording continues in part 2/);
    assert.equal(two.part, 2);
    assert.equal(two.provider_id, B.id);
    assert.equal(two.is_partial, 1, 'it is missing what went by between the parts');
    assert.equal(path.dirname(two.file_path), path.dirname(one.file_path), 'same folder');
    assert.equal(path.basename(two.file_path), path.basename(one.file_path, '.mkv') + ' (part 2).mkv');
    assert.equal(scheduled.getById(s.id).status, 'recording', 'the schedule carries on');
    assert.equal(scheduled.getById(s.id).recording_id, two.id);

    await until(() => scheduled.getById(s.id).status === 'completed', 'the stop time', 8000);
    assert.equal(recordings.getById(two.id).status, 'completed');
    assert.equal(partsOf(s.id).length, 2, 'the stop ends it: no part 3');
    assert.ok(fs.statSync(one.file_path).size > 1024 && fs.statSync(two.file_path).size > 1024, 'both files kept');
    for (const r of partsOf(s.id)) assert.equal(r.ad_detect_status, 'pending', 'each part queued for break detection');

    // The list: each part its own item, with part and the provider's name.
    const listed = engine.listRecordings().filter(r => r.scheduled_id === s.id).sort((a, b) => a.part - b.part);
    assert.deepEqual(listed.map(r => [r.part, r.provider_id, r.provider_name]), [[1, A.id, 'Strong8K'], [2, B.id, 'Trex']]);
    for (const r of listed) noUrl(JSON.stringify(r), 'list item');

    // Deleting one part deletes only that part's files.
    await engine.deleteRecording(two.id);
    assert.ok(fs.existsSync(one.file_path));
    assert.ok(!fs.existsSync(two.file_path));
    assert.deepEqual(partsOf(s.id).map(r => r.id), [one.id]);
});

test('at most 3 parts', async () => {
    tuning.startFailoverMs = 200;
    tuning.endGraceMs = 0;
    for (const u of [url.A(101), url.B(5001), url.C(7001)]) setBehaviour(u, 'dies');
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'completed', 'completed after part 3');
    const parts = partsOf(s.id);
    assert.deepEqual(parts.map(r => [r.part, r.provider_id, r.status]), [[1, A.id, 'completed'], [2, B.id, 'completed'], [3, C.id, 'completed']]);
    assert.ok(parts.every(r => r.is_partial === 1));
    assert.deepEqual(startsOf(), [url.A(101), url.B(5001), url.C(7001)]);
    assert.match(parts[2].error, /part 3 of at most 3/);
});

test('a stalled recording (file stops growing) continues in part 2', async () => {
    tuning.startFailoverMs = 200;
    tuning.endGraceMs = 0;
    tuning.stallMs = 300;
    setBehaviour(url.A(101), 'stall');
    const s = due();
    await until(() => partsOf(s.id).length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'part 2');
    const [one] = partsOf(s.id);
    assert.equal(one.status, 'completed');
    assert.match(one.error, /Strong8K stalled/);
    assert.ok(logLines.some(l => /no data for \d+s from Strong8K/.test(l)));
});

test('a part with no free provider waits (no prompt), then starts when one frees up', async () => {
    tuning.startFailoverMs = 200;
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'dies');
    const s = due();
    const onB = await viewerOn(B.id);
    const onC = await viewerOn(C.id);
    await until(() => partsOf(s.id)[0]?.status === 'completed', 'part 1 over');
    await engine.tick();
    assert.equal(partsOf(s.id).length, 1);
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.equal(coordinator._prompts.has(s.id), false, 'a continuation never asks');
    assert.ok(!engine.listActive().some(r => r.id === s.id), 'it holds no connection while it waits');
    await transcodeSession.removeSession(onC.id);
    await until(() => partsOf(s.id).length === 2, 'part 2 once Dream4K is free');
    assert.equal(partsOf(s.id)[1].provider_id, C.id);
    void onB;
});

test('stop, a viewer taking the stream, and low disk space never start a continuation', async () => {
    tuning.startFailoverMs = 0;
    tuning.endGraceMs = 0;
    // "ok" answers a stop with a provider-looking error: only a requested stop is ignored.
    const a = due();
    await until(() => scheduled.getById(a.id).status === 'recording' && fs.existsSync(partsOf(a.id)[0].file_path), 'a records');
    await sleep(100);
    await engine.cancelScheduled(a.id);
    assert.equal(scheduled.getById(a.id).status, 'cancelled');
    assert.equal(partsOf(a.id).length, 1);

    const b = due();
    await until(() => scheduled.getById(b.id).status === 'recording', 'b records');
    await sleep(100);
    await engine.stopForViewer(b.id);
    await engine.tick();
    assert.equal(scheduled.getById(b.id).status, 'completed');
    assert.equal(partsOf(b.id).length, 1);

    const c = due();
    await until(() => scheduled.getById(c.id).status === 'recording', 'c records');
    await sleep(100);
    await db.settings.update({ minFreeSpaceGB: 1e9 });
    await engine.tick();
    assert.equal(scheduled.getById(c.id).status, 'failed');
    assert.match(scheduled.getById(c.id).error, /Stopped early: only/);
    await engine.tick();
    assert.equal(partsOf(c.id).length, 1);
    assert.deepEqual(startsOf().length, 3, 'nothing restarted');
    assert.ok(!routing.isQuarantined(A.id, 's101'), 'and nothing was held against the provider');
});

// ------------------------------------------------------------ no backup --

test('no backup configured: a 502 at start fails the recording exactly as before', async () => {
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: false });
    setBehaviour(url.A(101), '502');
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'failed', 'failed');
    await sleep(200);
    await engine.tick();
    assert.deepEqual(startsOf(), [url.A(101)], 'tried once, on the primary only');
    const parts = partsOf(s.id);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].status, 'failed');
    assert.equal(parts[0].provider_id, A.id);
    assert.equal(parts[0].part, 1);
    assert.equal(scheduled.getById(s.id).error, 'Recording failed (exit code 1)');
    assert.ok(!routing.isQuarantined(A.id, 's101'), 'nothing noted');
});

test('no backup configured: a provider dying mid-recording ends it as before (no part 2)', async () => {
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: false });
    tuning.startFailoverMs = 0;
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'dies');
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'completed', 'completed');
    assert.equal(partsOf(s.id).length, 1);
    assert.equal(partsOf(s.id)[0].is_partial, 0);
    assert.equal(partsOf(s.id)[0].error, null);
});

test('no backup configured: a viewer on the only connection is asked, as before', async () => {
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: false });
    await viewerOn(A.id);
    const s = due();
    await engine.tick();
    assert.equal(scheduled.getById(s.id).status, 'waiting');
    assert.equal(coordinator._prompts.get(s.id).providerId, A.id);
});

// ------------------------------------------------------------ restart --

test('a restart mid-part finishes that part and keeps the earlier ones', async () => {
    const s = due();
    scheduled.setStatus(s.id, 'recording');
    const dir = path.join(sandbox, 'recordings', 'Fox Sports 505');
    fs.mkdirSync(dir, { recursive: true });
    const mk = (part, status) => {
        const file = path.join(dir, `restart ${part}.mkv`);
        fs.writeFileSync(file, Buffer.alloc(3000));
        const r = recordings.create({ scheduled_id: s.id, title: s.title, channel_name: s.channel_name, channel_logo: null,
            source_id: A.id, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() - 60000, provider_id: A.id, part });
        if (status !== 'recording') recordings.finish(r.id, { status, ended_at: Date.now() - 30000, file_size_bytes: 3000, duration_sec: 30, error: 'Stopped early: Strong8K lost the stream; the recording continues in part 2.' });
        return r;
    };
    const one = mk(1, 'completed');
    const two = mk(2, 'recording');
    scheduled.setStatus(s.id, 'recording', { recording_id: two.id });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
    assert.equal(recordings.getById(one.id).status, 'completed');
    assert.match(recordings.getById(one.id).error, /continues in part 2/, 'part 1 untouched');
    assert.equal(recordings.getById(two.id).status, 'completed');
    assert.equal(recordings.getById(two.id).error, 'Server restarted while this recording was in progress.');
    assert.equal(scheduled.getById(s.id).status, 'failed', 'not resumed');

    // Between parts (the last part already finished): nothing is rewritten.
    const t = due();
    const three = recordings.create({ scheduled_id: t.id, title: t.title, channel_name: t.channel_name, channel_logo: null,
        source_id: A.id, channel_item_id: 'pos_1', file_path: path.join(dir, 'between.mkv'), started_at: Date.now(), provider_id: A.id, part: 1 });
    recordings.finish(three.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 5000, duration_sec: 10, error: 'Stopped early: x' });
    scheduled.setStatus(t.id, 'recording', { recording_id: three.id });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
    assert.equal(recordings.getById(three.id).file_size_bytes, 5000);
    assert.equal(recordings.getById(three.id).error, 'Stopped early: x');
});

test('nothing this feature logged or stored carries a URL', () => {
    for (const line of logLines.filter(l => l.startsWith('[Recordings]') || l.startsWith('[Providers]'))) noUrl(line, 'log');
    for (const r of engine.listRecordings()) noUrl(r.error || '', `recording #${r.id}`);
    for (const s of scheduled.listAll()) noUrl(s.error || '', `schedule #${s.id}`);
});
