const { test, before, after } = require('node:test');
process.env.PIGTV_PART_RECORDINGS = '1'; // 0494: the part-based path, for its tests
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #217: a recording of a sport event ends when the score feed says the event has; the guide end + post-padding is the
// fallback and the floor. Before 0434 a recording always stopped at the guide end + post-padding, however long the game
// ran past it. The rule with fixed times and a fake score store; then the real engine in a sandboxed database with the
// collector's real store (filled directly: nothing here asks ESPN) and a fake ffmpeg.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rec-event-end-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const guideEnd = load('services/recordingGuideEnd');
const overrun = load('services/sportOverrun');
const dashboard = load('services/sportsDashboard');
const { scheduled } = load('db/recordingsDb');

const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(out, Buffer.alloc(4000));
setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(0); });
`);
fs.chmodSync(FFMPEG, 0o755);

const realConsole = { log: console.log, warn: console.warn };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIN = 60000, H = 60 * MIN;
const T = Date.UTC(2026, 10, 7, 9); // a fixed bounce, for the rule's tests
let A;

before(async () => {
    console.log = () => {}; console.warn = () => {};
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, tvg_id, stream_url)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Footy 504', 'Sport', 0, 1, 's504', 'foxfooty.au', 'http://strong.invalid/live/u/p/504.ts')`).run(`${A.id}:pos_1`, A.id);
    // 0494: recordings are always segmented; these tests cover the part-based (.ts) path, so they ask for it
    // (PIGTV_PART_RECORDINGS, set at the top of this file).
    await db.settings.update({ segmentedRecordings: false, recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown(); // the test drives tick() itself
});

after(async () => {
    await engine.stopAllActive(3000);
    Object.assign(console, realConsole);
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const side = (name, ...aliases) => ({ id: name, name, logo: null, aliases: [name, ...aliases] });
const game = (id, start, a = 'Collingwood', b = 'Carlton', league = 'AFL') => ({ id, league, title: `${a} v ${b}`, start, end: null,
    session: null, circuit: null, format: null, competitors: [side(a, `${a} FC`), side(b, `${b} FC`)] });
/** A fake score store: `answers` game id -> { observedAt, finishedAt, data }. */
const fakeStore = (games, answers) => ({ catalog: () => games, latest: (id) => answers[id] || null });
const live = (observedAt) => ({ observedAt, finishedAt: null, data: { state: 'live', progress: {}, scores: null } });
const final = (observedAt, finishedAt) => ({ observedAt, finishedAt, data: { state: 'finished', progress: {}, scores: null } });
// A schedule as recordingGuideEnd sees it: the guide's slot T-10 min to T+3 h, 10 min post-padding: the floor is T+3h10.
const sched = (extra = {}) => ({ id: 1, title: 'AFL: Collingwood v Carlton', program_start: T - 10 * MIN, program_end: T + 3 * H,
    post_buffer_min: 10, status: 'recording', sport_game_id: null, event_stop: null, ...extra });
const FLOOR = T + 3 * H + 10 * MIN;

// ---- the rule (fixed times, no network) ------------------------------------------

test('#217 rule: a game still being played at the floor rolls the stop on; a final stops it at the final + post-padding; the cap holds', () => {
    const at = (now, latest, extra) => overrun.recordingEnd({ floor: FLOOR, postMs: 10 * MIN, now, latest, gameStart: T, ...extra });
    assert.equal(at(FLOOR, live(FLOOR - 30000)), FLOOR + overrun.OVERRUN_STEP, 'live at the floor: on for another step');
    assert.equal(at(FLOOR + H, live(FLOOR + H - 30000)), FLOOR + H + overrun.OVERRUN_STEP, 'rolled on, an hour later');
    for (const state of ['break', 'suspended']) {
        assert.equal(at(FLOOR, { ...live(FLOOR), data: { state } }), FLOOR + overrun.OVERRUN_STEP, state);
    }
    assert.equal(at(FLOOR, { ...live(FLOOR), data: { state: 'break', breakLabel: 'Stumps' } }), undefined, 'stumps is not play');
    assert.equal(at(FLOOR, { ...live(FLOOR), data: { state: 'break' } }, { individual: true }), undefined, 'a tournament between matches');
    assert.equal(at(FLOOR, { ...live(FLOOR), data: { state: 'scheduled' } }, { gameStart: FLOOR + 20 * MIN }), FLOOR + overrun.OVERRUN_STEP,
        'coverage on air, play due within 30 min (0423)');
    assert.equal(at(FLOOR, { ...live(FLOOR), data: { state: 'scheduled' } }), undefined, 'scheduled, its start long gone: no');

    assert.equal(at(FLOOR + 40 * MIN, final(FLOOR + 40 * MIN, FLOOR + 35 * MIN)), FLOOR + 45 * MIN, 'final + post-padding');
    assert.equal(at(FLOOR, final(FLOOR, T + 2.5 * H)), null, 'a final before the guide end: the floor');
    assert.equal(at(FLOOR, final(FLOOR, null)), null, 'a final whose moment was never seen: the floor');

    assert.equal(at(FLOOR, live(FLOOR - 16 * MIN)), undefined, 'an answer over 15 min old: no change (the floor)');
    assert.equal(at(FLOOR, null), undefined, 'no answer');
    assert.equal(at(FLOOR + 3 * H + 55 * MIN, live(FLOOR + 3 * H + 55 * MIN)), FLOOR + overrun.OVERRUN_MAX, 'capped at floor + 4 h');
    assert.equal(at(FLOOR + 4 * H + MIN, live(FLOOR + 4 * H + MIN)), undefined, 'past the cap: never rolled on');
    assert.equal(at(FLOOR + 5 * H, final(FLOOR + 5 * H, FLOOR + 5 * H)), FLOOR + overrun.OVERRUN_MAX, 'a late final is capped too');
});

test('#217 eventStop: linked by id or by the join; stale, unlinked or not yet near the floor is the floor', () => {
    const g = game('espn:afl:1', T);
    const store = (answer) => fakeStore([g, game('espn:afl:2', T, 'Richmond', 'Essendon')], { 'espn:afl:1': answer });
    const stop = (s, now, answer) => guideEnd.eventStop(s, { now, store: store(answer) });

    assert.equal(stop(sched({ sport_game_id: 'espn:afl:1', title: 'Footy Live' }), FLOOR, live(FLOOR)), FLOOR + overrun.OVERRUN_STEP, 'by its stored id');
    assert.equal(stop(sched(), FLOOR, live(FLOOR)), FLOOR + overrun.OVERRUN_STEP, 'by the join: both teams, play within 90 min');
    assert.equal(stop(sched({ event_stop: FLOOR + 10 * MIN }), FLOOR + 12 * MIN, final(FLOOR + 12 * MIN, FLOOR + 11 * MIN)), FLOOR + 21 * MIN,
        'the final moves an extended stop to the final + post-padding');
    assert.equal(stop(sched(), FLOOR, live(FLOOR - 20 * MIN)), null, 'ESPN stale: the floor');
    assert.equal(stop(sched(), FLOOR, null), null, 'no answer (unreachable since start): the floor');
    assert.equal(stop(sched({ event_stop: FLOOR + 10 * MIN }), FLOOR + 9 * MIN, live(FLOOR - 20 * MIN)), FLOOR + 10 * MIN,
        'stale while extended: no new roll, the last one lapses');
    assert.equal(stop(sched({ title: 'Replay: Collingwood v Carlton' }), FLOOR, live(FLOOR)), null, 'a replay never joins');
    assert.equal(stop(sched({ title: 'Collingwood v Carlton', program_start: T + 3 * H }), T + 6 * H, live(T + 6 * H)), null,
        'a start 3 h from play: not this game');
    assert.equal(stop(sched({ title: 'The Project' }), FLOOR, live(FLOOR)), null, 'a non-sport schedule is untouched');
    assert.equal(stop(sched(), FLOOR - 5 * MIN, live(FLOOR - 5 * MIN)), null, 'not decided until just before the floor');
    assert.equal(guideEnd.eventStop(sched(), { now: FLOOR, store: { catalog: () => { throw new Error('locked'); } } }), null, 'a failure is no change');

    assert.deepEqual(guideEnd.endView(sched(), [g], FLOOR), { endsWith: 'event', stopsAt: FLOOR });
    assert.deepEqual(guideEnd.endView(sched({ event_stop: FLOOR + 10 * MIN }), [g], FLOOR + MIN), { endsWith: 'event', stopsAt: FLOOR + 10 * MIN, overrun: true });
    assert.deepEqual(guideEnd.endView(sched({ event_stop: FLOOR + 5 * H }), [g], FLOOR + MIN).stopsAt, FLOOR + overrun.OVERRUN_MAX, 'stopsAt is capped');
    assert.deepEqual(guideEnd.endView(sched({ event_stop: FLOOR - MIN }), [g], FLOOR - 2 * MIN).stopsAt, FLOOR, 'never before the floor');
    assert.deepEqual(guideEnd.endView(sched({ title: 'The Project' }), [g], FLOOR), { endsWith: 'guide', stopsAt: FLOOR });
    assert.deepEqual(guideEnd.endView(sched({ title: 'Footy Live', sport_game_id: 'espn:afl:9' }), [], FLOOR), { endsWith: 'event', stopsAt: FLOOR });
});

// 0443 (0440 Codex round 2, medium): the join built its airing in each candidate game's league, so "AFL: Collingwood v
// Carlton" followed the AFLW game of the same clubs and start. A schedule links only to a game of its own league.
test('#217 join: an AFL broadcast never links to the AFLW game of the same clubs; the AFL game is its own', () => {
    const afl = game('espn:afl:1', T), aflw = { ...game('aflw:1', T), league: 'AFLW' };
    const stop = (s, games) => guideEnd.eventStop(s, { now: FLOOR, store: fakeStore(games, { 'espn:afl:1': live(FLOOR), 'aflw:1': live(FLOOR) }) });
    assert.equal(guideEnd.gameFor(sched(), [aflw]), null, 'only the AFLW game: no link');
    assert.equal(stop(sched(), [aflw]), null, 'so it stops at the floor');
    assert.equal(guideEnd.gameFor(sched(), [afl, aflw])?.id, 'espn:afl:1', 'the AFL game present: linked to it');
    assert.equal(stop(sched(), [afl, aflw]), FLOOR + overrun.OVERRUN_STEP);
    assert.equal(guideEnd.gameFor(sched({ title: 'AFLW: Collingwood v Carlton' }), [afl, aflw])?.id, 'aflw:1', 'and the AFLW broadcast its own');
    assert.equal(guideEnd.gameFor(sched({ title: 'Collingwood v Carlton' }), [aflw])?.id, 'aflw:1', 'a title naming no league: the one game, as before');
});

// ---- the engine ---------------------------------------------------------------------

const scores = () => dashboard.store();
function scoreGame(id, start, state, at, a = 'Collingwood', b = 'Carlton') {
    scores().ingest([{ ...game(id, start, a, b), snapshot: { state, progress: {}, scores: null, situation: null } }], at);
}
let n = 0;
function schedule({ start, end, title, post = 0 }) {
    return scheduled.create({ title, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's504',
        channel_name: 'Fox Footy 504', channel_logo: null, program_start: start, program_end: end,
        pre_buffer_min: 0, post_buffer_min: post, created_by: 1, created_at: Date.now() + n++ });
}
async function untilRecording(id) {
    for (let i = 0; i < 50 && scheduled.getById(id).status !== 'recording'; i++) { await engine.tick(); await sleep(40); }
    assert.equal(scheduled.getById(id).status, 'recording');
}

test('#217 engine: a game still live past its guide end keeps recording, then stops at the final', async () => {
    const now = Date.now();
    scoreGame('espn:afl:live', now - 30 * MIN, 'live', now);
    const s = schedule({ start: now - 1000, end: now + 2000, title: 'AFL: Collingwood v Carlton' }); // linked by the join
    await untilRecording(s.id);
    await sleep(3200);
    assert.equal(scheduled.getById(s.id).status, 'recording', 'still recording past the guide end');
    const listed = engine.listScheduled().find(r => r.id === s.id);
    assert.equal(listed.endsWith, 'event');
    assert.equal(listed.overrun, true);
    assert.equal(listed.stopsAt, scheduled.getById(s.id).event_stop, 'stopsAt: the rolled stop');
    assert.ok(listed.stopsAt > s.program_end, 'past the guide end');
    assert.ok(!('event_stop' in listed) && !('sport_game_id' in listed), 'internal columns are not listed');

    scoreGame('espn:afl:live', now - 30 * MIN, 'finished', Date.now()); // the siren
    await engine.tick();
    for (let i = 0; i < 60 && scheduled.getById(s.id).status === 'recording'; i++) await sleep(50);
    assert.equal(scheduled.getById(s.id).status, 'completed', 'stopped at the final (no post-padding here)');
});

test('#217 engine: a schedule made for a game (gameId) is linked by it, whatever its title', async () => {
    const now = Date.now();
    scoreGame('espn:afl:byid', now - 2 * H, 'live', now, 'Richmond', 'Essendon');
    const made = await engine.scheduleFromProgram({ sourceId: A.id, channelItemId: 'pos_1', channelName: 'Fox Footy 504', title: 'Saturday Footy',
        programStart: now - 1000, programEnd: now + 2000, preBufferMin: 0, postBufferMin: 0, createdBy: 1, gameId: 'espn:afl:byid' });
    await untilRecording(made.id);
    await sleep(3200);
    assert.equal(scheduled.getById(made.id).status, 'recording', 'still recording past the guide end');
    await engine.cancelScheduled(made.id);
});

test('#217 engine: with ESPN stale, or a schedule that is not a game, it stops at the guide end as before', async () => {
    const now = Date.now();
    scoreGame('espn:afl:stale', now - 30 * MIN, 'live', now - 20 * MIN, 'Geelong', 'Hawthorn');
    const stale = schedule({ start: now - 1000, end: now + 2000, title: 'AFL: Geelong v Hawthorn' });
    const plain = schedule({ start: now - 1000, end: now + 2000, title: 'The Front Bar' });
    await untilRecording(stale.id);
    await untilRecording(plain.id);
    assert.equal(engine.listScheduled().find(r => r.id === plain.id).endsWith, 'guide');
    for (let i = 0; i < 60 && [stale, plain].some(s => scheduled.getById(s.id).status === 'recording'); i++) await sleep(50);
    assert.equal(scheduled.getById(stale.id).status, 'completed');
    assert.equal(scheduled.getById(plain.id).status, 'completed');
    assert.equal(scheduled.getById(stale.id).event_stop, null);
});
