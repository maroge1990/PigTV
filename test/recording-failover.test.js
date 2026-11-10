const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakeSegmentFfmpeg, stubNativeTools, drainSegmentQueue, until: untilWith } = require('./helpers/fakeSegmentFfmpeg');

// 0177 (multi-provider P7): recordings choose a provider with a free connection, move to the next provider when ffmpeg
// cannot start on one, and continue when their provider dies (or stalls) mid-recording. #271 (D-48): every recording is
// segmented, so a move is a new epoch of the same recording (one row, one work folder), never a part 2. The real engine,
// coordinator and routing in a sandboxed database; ffmpeg is the shared fake (test/helpers/fakeSegmentFfmpeg.js),
// which behaves per stream URL. What one recording's ends do with one provider, and the #284 pace of starts on a route
// whose providers all refuse, are in recording-segments.test.js.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rec-failover-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const engine = load('services/recordingEngine');
// 0193: background preparation of earlier tests' recordings would run ffmpeg too (recording-prepare.test.js).
engine._setPrepareQueue(false);
const routing = load('services/providerRouting');
const segments = load('services/recordingSegments');
const { scheduled, recordings } = load('db/recordingsDb');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tuning = engine._failoverTuning;
const TUNING = { ...tuning };

// ---- fake ffmpeg: what each stream URL does (the helper's header has the kinds) ----------------------
// ok (default) writes segments; on "q" (a stop) exits with a provider-looking error, so a requested stop taken
// for a provider failure would show. refuses: an HTTP 502 at once. dies: reset by peer after 400 ms. stall: one
// segment, then nothing.
const fake = createFakeSegmentFfmpeg(sandbox);
const FFMPEG = fake.path;
const { setBehaviour, captures } = fake;
const remuxed = stubNativeTools(engine); // the remux and the preparation checks are stood in for
const inputs = () => captures().map(a => a[a.indexOf('-i') + 1]);

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

    fs.mkdirSync(path.join(sandbox, 'recordings'), { recursive: true });
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: path.join(sandbox, 'no-ffprobe') });
    engine.shutdown(); // the test drives tick() itself
});

afterEach(async () => {
    await db.settings.update({ minFreeSpaceGB: 0 }); // first: the MP4 of a recording stopped for low space must be able to move
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) {
        await engine.cancelScheduled(s.id);
        scheduled.setStatus(s.id, 'cancelled');
    }
    // Whatever the test left to finish is finished (or moved) before the next one starts.
    await drainSegmentQueue(segments, recordings);
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    routing.reset();
    Object.assign(tuning, TUNING);
    fake.reset();
    remuxed.length = 0;
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: true });
});

after(() => {
    Object.assign(console, realConsole);
    for (const [, f] of segments._followers) { try { f.proc?.kill?.('SIGKILL'); } catch { /* gone */ } }
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
const until = (cond, label, ms) => untilWith(engine, cond, label, ms);
/** Poll without ticking (a tick would start the next capture itself, or wait on a held start). */
async function settle(cond, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(40); }
    assert.fail(`timed out waiting for: ${label}`);
}
const rowsOf = (id) => recordings.listBySchedule(id);
const activeFor = (id) => engine.listActive().some(r => r.id === id);
/** The capture of epoch `n` of `rec` writes into its own folder of the recording's work folder. */
const epochOut = (rec, n) => path.join(rec.work_dir, `e${n}`, 'archive.m3u8');
const lastOut = (args) => args[args.length - 1];
const noUrl = (text, label) => {
    assert.ok(!String(text).includes('://'), `${label}: carries a URL: ${text}`);
    assert.ok(!/\.invalid|\/u\/p\//.test(String(text)), `${label}: leaks a stream address: ${text}`);
};

// ------------------------------------------------------------------ choosing --

test('primary busy with a viewer, backup free: records on the backup, nobody is asked', async () => {
    await viewerOn(A.id);
    const s = due();
    await until(() => scheduled.getById(s.id).status === 'recording' && captures().length === 1, 'recording');
    assert.deepEqual(inputs(), [url.B(5001)]);
    const [rec] = rowsOf(s.id);
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
    assert.deepEqual(captures(), [], 'nothing started');
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
// Every provider refusing (one immediate try each, then one per tick, failed at the cap) is recording-segments.test.js's
// "#284: every provider of a multi-provider route refuses at the start".

test('502 on the primary as it starts: the backup takes over the same recording, which carries on there to its end', async () => {
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'refuses');
    const s = due({ windowMs: 3000 });
    await until(() => captures().length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'on the backup');
    assert.deepEqual(inputs(), [url.A(101), url.B(5001)]);
    const rows = rowsOf(s.id);
    assert.equal(rows.length, 1, 'one recording, not a failed stub plus the real one');
    const [rec] = rows;
    assert.equal(rec.provider_id, B.id);
    assert.equal(rec.status, 'recording');
    assert.equal(rec.segment_state, 'capturing');
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.ok(routing.isQuarantined(A.id, 's101'), 'the primary is skipped for this channel for a while');
    assert.ok(!routing.isQuarantined(B.id, 's101'), 'the backup is not');
    assert.equal(lastOut(captures()[1]), epochOut(rec, 2), 'a new epoch of the same recording');
    await until(() => segments.captureBytes(path.dirname(epochOut(rec, 2))) > 3000, 'the backup writes');
    await until(() => scheduled.getById(s.id).status === 'completed', 'the stop time', 8000);
    assert.equal(captures().length, 2, 'it stayed on the backup to the end');
    await until(() => recordings.getById(rec.id).status === 'completed', 'its MP4', 10000);
    assert.equal(rowsOf(s.id).length, 1);
    assert.equal(recordings.getById(rec.id).provider_id, B.id);
});

// ------------------------------------------------------------ continuation --
// A provider dying mid-recording with a backup (one row, a second epoch on the backup, the gap noted, completed) is
// recording-segments.test.js's "provider dies mid-recording with a backup".

// 0177: an old part-based recording (before D-48) is two rows and two files: each is still listed and deleted on its own.
test('an old two-part recording lists each part with its provider\'s name; deleting one part deletes only that part', async () => {
    const now = Date.now();
    const s = scheduled.create({ title: 'Old match', description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's101',
        channel_name: 'Fox Sports 505', channel_logo: null, program_start: now - 7200e3, program_end: now - 3600e3,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now - 7300e3 });
    const dir = path.join(sandbox, 'recordings', 'Fox Sports 505');
    fs.mkdirSync(dir, { recursive: true });
    const part = (n, provider, name, error) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, Buffer.alloc(3000));
        const r = recordings.create({ scheduled_id: s.id, title: s.title, channel_name: s.channel_name, channel_logo: null,
            source_id: A.id, channel_item_id: 'pos_1', file_path: file, started_at: now - 7200e3, provider_id: provider.id, part: n });
        recordings.finish(r.id, { status: 'completed', ended_at: now - 3600e3, file_size_bytes: 3000, duration_sec: 1800, error });
        recordings.markPartial(r.id, 0);
        return recordings.getById(r.id);
    };
    const one = part(1, A, 'Old match - 2026-10-01 19-30.ts', 'Stopped early: Strong8K lost the stream; the recording continues in part 2.');
    const two = part(2, B, 'Old match - 2026-10-01 19-30 (part 2).ts', null);
    scheduled.setStatus(s.id, 'completed', { recording_id: two.id });

    const listed = engine.listRecordings().filter(r => r.scheduled_id === s.id).sort((a, b) => a.part - b.part);
    assert.deepEqual(listed.map(r => [r.part, r.provider_id, r.provider_name]), [[1, A.id, 'Strong8K'], [2, B.id, 'Trex']]);
    for (const r of listed) noUrl(JSON.stringify(r), 'list item');

    await engine.deleteRecording(two.id);
    assert.ok(fs.existsSync(one.file_path), 'part 1 kept');
    assert.ok(!fs.existsSync(two.file_path), 'part 2 gone');
    assert.deepEqual(rowsOf(s.id).map(r => r.id), [one.id]);
});

test('a stalled recording (no new segments) continues in the same recording on the next provider', async () => {
    tuning.endGraceMs = 0;
    tuning.stallMs = 300;
    setBehaviour(url.A(101), 'stall');
    const s = due();
    await until(() => captures().length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'continued on Trex', 10000);
    const rows = rowsOf(s.id);
    assert.equal(rows.length, 1, 'one recording');
    const [rec] = rows;
    assert.equal(rec.provider_id, B.id);
    assert.equal(rec.segment_state, 'capturing');
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.equal(lastOut(captures()[1]), epochOut(rec, 2), 'a new epoch of the same recording');
    assert.match(rec.error, /^Gaps: 1, \d+ s in all \(the last: the provider dropped out\)\.$/);
    assert.ok(logLines.some(l => /no data for \d+s from Strong8K/.test(l)), 'the stall is logged with the provider\'s name');
    assert.ok(routing.isQuarantined(A.id, 's101'), 'the stalled provider is skipped for this channel');
});

test('a recording whose provider died, with no other free, waits (no prompt, no connection held), then continues when one frees up', async () => {
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'dies');
    const s = due();
    const onB = await viewerOn(B.id);
    const onC = await viewerOn(C.id);
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1 && !activeFor(s.id), 'its capture ended');
    await engine.tick();
    assert.equal(captures().length, 1, 'nothing started: no provider is free');
    const [rec] = rowsOf(s.id);
    assert.equal(rowsOf(s.id).length, 1);
    assert.equal(rec.status, 'recording');
    assert.equal(rec.segment_state, 'capturing', 'the recording is not ended');
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.equal(coordinator._prompts.has(s.id), false, 'a continuation never asks');
    assert.ok(!activeFor(s.id), 'it holds no connection while it waits');
    await transcodeSession.removeSession(onC.id);
    await until(() => captures().length === 2, 'continued once Dream4K is free');
    assert.equal(inputs()[1], url.C(7001));
    assert.equal(lastOut(captures()[1]), epochOut(rec, 2), 'in the same recording');
    assert.equal(rowsOf(s.id).length, 1);
    assert.equal(recordings.getById(rec.id).provider_id, C.id);
    void onB;
});

test('stop, a viewer taking the stream, and low disk space never start a continuation', async () => {
    tuning.endGraceMs = 0;
    // "ok" answers a stop with a provider-looking error: only a requested stop is ignored.
    const a = due();
    await until(() => scheduled.getById(a.id).status === 'recording' && captures().length === 1, 'a records');
    await sleep(100);
    await engine.cancelScheduled(a.id);
    assert.equal(scheduled.getById(a.id).status, 'cancelled');
    assert.equal(rowsOf(a.id).length, 1);
    assert.notEqual(rowsOf(a.id)[0].segment_state, 'capturing', 'its capture is over');

    const b = due();
    await until(() => scheduled.getById(b.id).status === 'recording' && captures().length === 2, 'b records');
    await sleep(100);
    assert.equal(await engine.stopForViewer(b.id), true);
    assert.equal(scheduled.getById(b.id).status, 'completed');
    assert.equal(scheduled.getById(b.id).error, 'Stopped early: the provider stream was needed for live viewing.');
    assert.ok(!activeFor(b.id), 'the connection is the viewer\'s');
    await engine.tick();
    assert.equal(rowsOf(b.id).length, 1);
    assert.notEqual(rowsOf(b.id)[0].segment_state, 'capturing', 'its capture is over: what it recorded is kept');
    assert.equal(rowsOf(b.id)[0].is_partial, 1);

    const c = due();
    await until(() => scheduled.getById(c.id).status === 'recording' && captures().length === 3, 'c records');
    await sleep(100);
    await db.settings.update({ minFreeSpaceGB: 1e9 });
    await engine.tick();
    // Segmented (R3): appdata is what fills; the recording ends with what it has, as a completed recording.
    assert.equal(scheduled.getById(c.id).status, 'completed');
    assert.ok(!activeFor(c.id));
    await engine.tick();
    assert.equal(rowsOf(c.id).length, 1);
    assert.notEqual(rowsOf(c.id)[0].segment_state, 'capturing', 'its capture is over');
    assert.notEqual(rowsOf(c.id)[0].status, 'failed', 'what it recorded is kept');
    assert.equal(captures().length, 3, 'nothing restarted');
    assert.ok(!routing.isQuarantined(A.id, 's101'), 'and nothing was held against the provider');
});

test('low disk space in appdata stops a recording while the recordings share is down, as with it up', async () => {
    const recordingsPath = path.join(sandbox, 'recordings');
    const c = due();
    await until(() => scheduled.getById(c.id).status === 'recording' && captures().length === 1, 'c records');
    await sleep(100);
    try {
        // The share is not mounted: its parent is gone, so getRecordingsRoot() throws (nothing on the share is needed here).
        await db.settings.update({ recordingsPath: path.join(sandbox, 'unmounted', 'recordings'), minFreeSpaceGB: 1e9 });
        await engine.tick();
        assert.equal(scheduled.getById(c.id).status, 'completed', 'stopped by the appdata check');
        assert.ok(!activeFor(c.id));
        assert.equal(rowsOf(c.id).length, 1);
        assert.notEqual(rowsOf(c.id)[0].segment_state, 'capturing', 'its capture is over');
        assert.notEqual(rowsOf(c.id)[0].status, 'failed', 'what it recorded is kept');
        assert.equal(captures().length, 1, 'nothing restarted');
    } finally {
        await db.settings.update({ recordingsPath, minFreeSpaceGB: 0 }); // the share is back: its MP4 can move
    }
});

// ------------------------------------------------------------ no backup --
// One provider refusing waits for the next tick each time (not at once): recording-segments.test.js's "#284: a
// single-provider route that refuses at the start"; one dropping mid-recording continues (0499): its "0499" test.

test('no backup configured: a 502 at start is held against nobody; the recording is tried again, and nothing it stored carries a URL', async () => {
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: false });
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'refuses');
    const s = due();
    await engine.tick();
    await settle(() => captures().length === 1 && !activeFor(s.id), 'the first capture ended');
    const rows = rowsOf(s.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider_id, A.id);
    assert.equal(rows[0].part, 1);
    assert.equal(scheduled.getById(s.id).status, 'recording', 'not failed at once (0499: it is tried again)');
    await engine.tick();
    await settle(() => captures().length === 2 && !activeFor(s.id), 'tried again');
    assert.deepEqual(inputs(), [url.A(101), url.A(101)], 'on the only provider');
    assert.ok(!routing.isQuarantined(A.id, 's101') && !routing.isQuarantined(A.id, null), 'nothing noted');
    assert.equal(routing.snapshot().providers.find(p => p.id === A.id).recentFailures, 0, 'nor counted toward its breaker');
    await engine.cancelScheduled(s.id);
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
    const rec = recordings.getById(rows[0].id);
    assert.equal(rec.status, 'failed', 'nothing was recorded');
    noUrl(rec.error, 'recording error');
    noUrl(scheduled.getById(s.id).error || '', 'schedule error');
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

// An old part-based recording (before D-48) that a server stopped mid-part: the first start after the upgrade meets it.
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
    await engine.init({ ffmpegPath: FFMPEG, ffprobePath: path.join(sandbox, 'no-ffprobe') }); // #141: the part's size is read through shareFs
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
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: path.join(sandbox, 'no-ffprobe') });
    engine.shutdown();
    assert.equal(recordings.getById(three.id).file_size_bytes, 5000);
    assert.equal(recordings.getById(three.id).error, 'Stopped early: x');
});

// ---- F3 (0244), D2: the move to the next provider after a 502 is owned; a cancel, shutdown or delete stops it ----

/** The backup's shared feed held until the test settles it; the primary is not shared (its 502 fails as ever). */
async function holdBackupFeed() {
    const ingest = load('services/ingest');
    const real = ingest.subscribe;
    const held = {};
    ingest.subscribe = async ({ url: target }) => {
        if (target === url.B(5001)) return new Promise(resolve => Object.assign(held, { resolve, asked: true }));
        throw Object.assign(new Error('fixture: not shared'), { ingestRefused: true });
    };
    await db.settings.update({ sharedIngestEnabled: true });
    held.restore = async () => { ingest.subscribe = real; await db.settings.update({ sharedIngestEnabled: false }); };
    return held;
}
function lateFeed() {
    const { PassThrough } = require('node:stream');
    const feed = new PassThrough();
    feed.left = 0;
    feed.leave = () => { feed.left++; feed.destroy(); };
    return feed;
}

for (const how of ['cancel', 'shutdown']) {
    test(`F3: ${how} while the recording moves to the backup - no backup ffmpeg, the late feed is released, nothing is lost`, async () => {
        const held = await holdBackupFeed();
        try {
            setBehaviour(url.A(101), 'refuses');
            const s = due();
            await until(() => held.asked, 'the backup feed is awaited');
            const [rec] = rowsOf(s.id);
            if (how === 'cancel') {
                await engine.cancelScheduled(s.id);
                assert.equal(scheduled.getById(s.id).status, 'cancelled', 'the cancel is seen at once');
            } else {
                await engine.stopAllActive(200, { forRestart: true }); // the container's stop (server/index.js)
            }
            const feed = lateFeed();
            held.resolve(feed);
            await settle(() => feed.left > 0 || captures().length > 1, 'the move settles');
            await sleep(300);
            assert.deepEqual(inputs(), [url.A(101)], 'nothing started on the backup');
            assert.equal(feed.left, 1, 'the late subscription is given back');
            assert.ok(!activeFor(s.id));
            if (how === 'cancel') {
                assert.notEqual(recordings.getById(rec.id)?.segment_state, 'capturing', 'the recording is not left capturing');
                assert.equal(scheduled.getById(s.id).status, 'cancelled', 'not overwritten later');
            } else {
                // 0490: a stop before the end leaves it to the next start, which continues it in a new epoch.
                assert.equal(recordings.getById(rec.id).segment_state, 'capturing', 'left for the next start to resume');
                assert.equal(scheduled.getById(s.id).status, 'recording');
            }
        } finally {
            await held.restore();
        }
    });
}

test('D2: the recording is deleted while it moves to the backup - nothing starts again, the late feed is released, no row comes back', async () => {
    const held = await holdBackupFeed();
    try {
        setBehaviour(url.A(101), 'refuses');
        const s = due();
        await until(() => held.asked, 'the backup feed is awaited');
        const [rec] = rowsOf(s.id);
        await engine.deleteRecording(rec.id);
        assert.equal(recordings.getById(rec.id), null);
        assert.notEqual(scheduled.getById(s.id).status, 'recording', 'the schedule is settled at once');
        const settled = scheduled.getById(s.id).status;
        const feed = lateFeed();
        held.resolve(feed);
        // The move's outcome is either a release or a spawn: wait for one, not for a time.
        await settle(() => feed.left > 0 || captures().length > 1 || activeFor(s.id), 'the move settles');
        await sleep(300);
        assert.deepEqual(inputs(), [url.A(101)], 'nothing started on the backup');
        assert.equal(feed.left, 1, 'the late subscription is given back');
        assert.ok(!activeFor(s.id));
        assert.deepEqual(rowsOf(s.id), [], 'no row comes back');
        assert.equal(scheduled.getById(s.id).status, settled, 'not overwritten later');
        assert.equal(fs.existsSync(rec.work_dir), false, 'its work folder is gone');
    } finally {
        await held.restore();
    }
});

/** Hold the settings read continuePart makes once the primary has failed; returns the release, once held. */
async function holdTheMovesSettings(real) {
    let release = null;
    db.settings.get = function (...a) {
        if (!release && new Error().stack.includes('continuePart')) {
            return new Promise(resolve => { release = () => resolve(real.apply(this, a)); });
        }
        return real.apply(this, a);
    };
    await engine.tick();
    // Not until(): a tick would await the held continuation itself.
    await settle(() => release, 'the move is reading its settings');
    return release;
}

test('D2: the recording is deleted while its move reads its settings - it starts nothing and no row comes back', async () => {
    const real = db.settings.get;
    setBehaviour(url.A(101), 'refuses');
    const s = due();
    try {
        const release = await holdTheMovesSettings(real);
        const [rec] = rowsOf(s.id);
        await engine.deleteRecording(rec.id);
        const settled = scheduled.getById(s.id).status;
        assert.notEqual(settled, 'recording');
        release();
        await sleep(1000);
        assert.deepEqual(inputs(), [url.A(101)]);
        assert.deepEqual(rowsOf(s.id), []);
        assert.equal(scheduled.getById(s.id).status, settled);
    } finally {
        db.settings.get = real;
    }
});

// #285: a recording deleted while it waits to continue was settled by finishSchedule, which counts only 'completed' rows
// (a segmented row is 'recording' until its MP4): its schedule failed, "no part recorded anything", with a failure notice,
// even with segments recorded. It now ends as deleting it while it captures does (endSegmentCapture).
/** Count the failure notices sent for schedule `id` while `run` runs. */
async function failureNotices(id, run) {
    const notify = load('services/notify');
    const real = notify.recordingFailed;
    let sent = 0;
    notify.recordingFailed = (schedule, ...rest) => { if (schedule?.id === id) sent++; return real(schedule, ...rest); };
    try { await run(); } finally { notify.recordingFailed = real; }
    return sent;
}
/** A recording on Strong8K that ended early (as `kind`) and now waits for Trex or Dream4K, both busy. */
async function waitingToContinue(kind) {
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), kind);
    const s = due();
    await viewerOn(B.id);
    await viewerOn(C.id);
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1 && !activeFor(s.id), 'waiting to continue');
    return { s, rec: rowsOf(s.id)[0] };
}

test('#285: a recording deleted while it waits to continue, with segments, completes its schedule as an active delete does', async () => {
    const { s, rec } = await waitingToContinue('dies');
    assert.ok(segments.archiveSegmentCount(rec.work_dir) > 0, 'it recorded something before its provider died');
    const sent = await failureNotices(s.id, () => engine.deleteRecording(rec.id));
    const now = scheduled.getById(s.id);
    assert.equal(now.status, 'completed', `settled as: ${now.status}, "${now.error}"`);
    assert.equal(now.error, null, 'no failure text');
    assert.equal(sent, 0, 'no failure notice');
    assert.equal(recordings.getById(rec.id), null);
    await sleep(300);
    assert.equal(captures().length, 1, 'nothing continues it');
});

test('#285: a recording deleted while it waits to continue, with nothing recorded, fails as an active delete does', async () => {
    const { s, rec } = await waitingToContinue('refuses');
    assert.equal(segments.archiveSegmentCount(rec.work_dir), 0);
    const sent = await failureNotices(s.id, () => engine.deleteRecording(rec.id));
    const now = scheduled.getById(s.id);
    assert.equal(now.status, 'failed');
    assert.match(now.error, /^Recording failed \(exit code [^)]*\)$/, 'endSegmentCapture\'s wording');
    assert.equal(sent, 1, 'the failure notice, as for any failed recording');
    assert.equal(recordings.getById(rec.id), null);
});

test('F3: cancel while the move reads its settings - it starts nothing', async () => {
    const real = db.settings.get;
    setBehaviour(url.A(101), 'refuses');
    const s = due();
    try {
        const release = await holdTheMovesSettings(real);
        await engine.cancelScheduled(s.id);
        release();
        await sleep(1000);
        assert.deepEqual(inputs(), [url.A(101)]);
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
    } finally {
        db.settings.get = real;
    }
});

// #217 (0440 Codex round 1, high): a recording waiting for a provider ended once its stored stop passed, though the score
// feed still said the game was on (only running captures checked their game). It must check first.
test('#217: a recording waiting for a provider past the guide end keeps waiting while its game is live, then continues', async () => {
    tuning.endGraceMs = 0;
    setBehaviour(url.A(101), 'dies');
    const now = Date.now();
    const s = due({ windowMs: 2000 });
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET sport_game_id = ? WHERE id = ?').run('espn:afl:wait', s.id);
    const scores = load('services/sportsDashboard').store();
    const live = () => scores.ingest([{ id: 'espn:afl:wait', league: 'AFL', title: 'Collingwood v Carlton', start: now - 30 * 60000, end: null,
        session: null, circuit: null, format: null, competitors: [],
        snapshot: { state: 'live', progress: {}, scores: null, situation: null } }], Date.now());
    const onB = await viewerOn(B.id);
    const onC = await viewerOn(C.id);
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1 && !activeFor(s.id), 'its capture ended');
    const [rec] = rowsOf(s.id);
    assert.equal(scheduled.getById(s.id).event_stop, null, 'no answer yet while it ran: the feed is first heard while it waits');
    while (Date.now() < s.program_end + 1500) { live(); await engine.tick(); await sleep(100); }
    assert.equal(scheduled.getById(s.id).status, 'recording', 'still waiting past the guide end: the game is on');
    assert.equal(recordings.getById(rec.id).segment_state, 'capturing', 'its capture is not ended');
    await transcodeSession.removeSession(onC.id);
    await until(() => captures().length === 2, 'continued once Dream4K is free');
    assert.equal(inputs()[1], url.C(7001));
    assert.equal(lastOut(captures()[1]), epochOut(rec, 2), 'in the same recording');
    assert.equal(rowsOf(s.id).length, 1);
    void onB;
});

test('nothing this feature logged or stored carries a URL', () => {
    for (const line of logLines.filter(l => l.startsWith('[Recordings]') || l.startsWith('[Providers]'))) noUrl(line, 'log');
    for (const r of engine.listRecordings()) noUrl(r.error || '', `recording #${r.id}`);
    for (const s of scheduled.listAll()) noUrl(s.error || '', `schedule #${s.id}`);
});
