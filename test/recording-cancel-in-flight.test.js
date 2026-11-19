const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #347: a cancel (DELETE /recordings/scheduled/:id) of a schedule that records can take a while (its capture stops first).
// A client whose connection dropped meanwhile records the same programme again: the schedule request was answered with
// the schedule being cancelled (alreadyScheduled, or the same programme), which the cancel then ended: no recording. The
// schedule is now `cancelling` from the cancel's first moment: a new request makes a new schedule; the old one is listed
// as `cancelling` until the cancel ends; a cancel that fails leaves it as it was.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-cancel-in-flight-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
load('services/sportsEvents')._buildInline(true);
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sportsEvents = load('services/sportsEvents');
const dashboard = load('services/sportsDashboard');
const prefs = load('services/sportPagePrefs');
const { scheduled, initSchema } = load('db/recordingsDb');

const H = 60 * 60 * 1000;
const NOW = Date.now();
let source, server, base, token, user;

const side = (name) => ({ id: name.toLowerCase(), name, aliases: [name], logo: null });
const game = (id, league, start, a, b) => ({ id, league, start, end: null, title: `${a} v ${b}`, session: null, circuit: null, format: null,
    competitors: [side(a), side(b)], snapshot: { state: 'scheduled', progress: {}, scores: null, situation: null } });

before(async () => {
    console.log = () => {};
    initSchema();
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', ?, ?, ?, 0, ?)`);
    item.run(`${source.id}:pos_1`, source.id, 'pos_1', 'Fox Footy', 1, 'ff', 'ff', 'http://provider.invalid/1.ts');
    item.run(`${source.id}:pos_2`, source.id, 'pos_2', 'Fox Footy 2', 2, 'ff2', 'ff2', 'http://provider.invalid/2.ts');
    item.run(`${source.id}:pos_3`, source.id, 'pos_3', 'Kayo 3', 3, 'k3', 'k3', 'http://provider.invalid/3.ts');
    d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('ff', source.id, NOW + 2 * H, NOW + 5 * H, 'AFL: Collingwood v Carlton', '["Sport"]', 8, null);
    user = await db.users.create({ username: 'mark', role: 'admin' });
    token = auth.generateToken(user);
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL'], teams: ['Collingwood'] }] });
    dashboard.store().ingest([game('espn:australian-football/afl:1', 'AFL', NOW + 2 * H + 10 * 60000, 'Collingwood', 'Carlton')], NOW - 1000);

    const app = express();
    app.use(express.json());
    app.use('/api/recordings', auth.streamAuth, load('routes/recordings'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sportsEvents.shutdown(); } catch { /* never started */ }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

async function call(method, route, body) {
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
}

const on = (item, name, start, extra = {}) => ({ sourceId: source.id, channelItemId: item, channelName: name, title: 'A game',
    programStart: start, programEnd: start + 2 * H, ...extra });
const ofGame = (id) => sqlite.getDb().prepare(`SELECT id, channel_name, status FROM scheduled_recordings WHERE sport_game_id = ? ORDER BY id`).all(id);


const { EventEmitter } = require('node:events');
const engine = load('services/recordingEngine');
const GAME = 'espn:australian-football/afl:347';
const START = NOW + 6 * H;

/** A capture in progress for schedule `id` whose stop waits for `release()` (or fails with `fail()`). */
function capturing(id) {
    sqlite.getDb().prepare(`UPDATE scheduled_recordings SET status = 'recording' WHERE id = ?`).run(id);
    const proc = new EventEmitter();
    proc.stdin = { writable: true, destroyed: false, write() {}, end() {} };
    proc.kill = () => {};
    let release, fail;
    const exited = new Promise((res, rej) => { release = res; fail = rej; });
    exited.catch(() => {});
    engine._active.set(id, { proc, exited, stopRequested: false });
    return { release: () => { proc.emit('close'); release(); }, fail: (err) => { proc.emit('close'); fail(err); } };
}
const listed = async () => (await call('GET', '/api/recordings/scheduled')).body;
const status = (id) => sqlite.getDb().prepare('SELECT status FROM scheduled_recordings WHERE id = ?').get(id)?.status;

// #347 (Codex, Apple batch sign-off; Mark, 19 Nov): while the cancel is under way, a request for the same game's airing
// or the same channel and start is refused (409 `cancelling`, nothing made: a replacement would race the stop); once
// the cancel has finished it makes a new schedule.
test('a cancel in flight: the same game and airing, or the same programme, is refused 409 cancelling; once it has ended, a new schedule', async () => {
    const old = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', START, { gameId: GAME }));
    assert.equal(old.status, 201);
    const cap = capturing(old.body.id);
    const cancel = engine.cancelScheduled(old.body.id); // its connection dropped: nobody waits for it
    await new Promise(r => setImmediate(r));
    const during = (await listed()).find(r => r.id === old.body.id);
    assert.equal(during.status, 'cancelling', 'listed as cancelling while its capture stops');
    assert.ok(!('cancelling' in during), 'the mark itself stays internal');
    const count = () => sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_recordings').get().n, before = count();
    const refused = { error: 'That recording is still being cancelled. Try again in a moment.', code: 'cancelling', scheduleId: old.body.id };
    const sameGameNow = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', START, { gameId: GAME }));
    assert.deepEqual([sameGameNow.status, sameGameNow.body], [409, refused], 'the same game on another channel');
    const sameProgrammeNow = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', START));
    assert.deepEqual([sameProgrammeNow.status, sameProgrammeNow.body], [409, refused], 'the same channel and start, no game');
    assert.equal(count(), before, 'nothing made');
    assert.equal((await call('PUT', `/api/recordings/scheduled/${old.body.id}`, { postBufferMin: 30 })).status, 404, 'nothing to change on it');
    cap.release();
    const done = await cancel;
    assert.equal(done.status, 'cancelled');
    assert.equal(status(old.body.id), 'cancelled');
    const sameGame = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', START, { gameId: GAME }));
    assert.equal(sameGame.status, 201, 'once cancelled: a new schedule');
    assert.notEqual(sameGame.body.id, old.body.id);
    const sameProgramme = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', START));
    assert.equal(sameProgramme.status, 201);
    assert.equal(status(sameGame.body.id), 'scheduled', 'the new one stands');
    assert.equal(status(sameProgramme.body.id), 'scheduled');
    const after = await listed();
    assert.ok(!after.some(r => r.id === old.body.id), 'gone from the list once cancelled');
    assert.ok(after.some(r => r.id === sameGame.body.id));
    for (const id of [sameGame.body.id, sameProgramme.body.id]) await engine.cancelScheduled(id);
});

test('a cancel that fails: the schedule is as it was (recording), listed so, and found again by the same game', async () => {
    const old = await call('POST', '/api/recordings/schedule', on('pos_3', 'Kayo 3', START + 24 * H, { gameId: `${GAME}0` }));
    const cap = capturing(old.body.id);
    const cancel = engine.cancelScheduled(old.body.id);
    await new Promise(r => setImmediate(r));
    assert.equal((await listed()).find(r => r.id === old.body.id).status, 'cancelling');
    cap.fail(new Error('the capture would not stop'));
    await assert.rejects(cancel);
    assert.equal(status(old.body.id), 'recording');
    assert.equal((await listed()).find(r => r.id === old.body.id).status, 'recording');
    const again = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', START + 24 * H, { gameId: `${GAME}0` }));
    assert.deepEqual([again.status, again.body.id, again.body.alreadyScheduled], [200, old.body.id, true]);
    engine._active.delete(old.body.id);
});

test('a cancelling schedule is never started', async () => {
    const s = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW - 60000));
    scheduled.setCancelling(s.body.id, true);
    assert.ok(!scheduled.findDueToStart(NOW).some(r => r.id === s.body.id), 'not due to start');
    assert.equal(engine._startStillWanted(scheduled.getById(s.body.id)), false);
    scheduled.setCancelling(s.body.id, false);
    await engine.cancelScheduled(s.body.id);
});

// Codex (high) on the mark: the tick read its due schedules, then awaited (settings, the shared feed, a provider); a
// schedule cancelled meanwhile was written back to `waiting` by the slots-full branch: a cancelled recording revived.
test('a schedule cancelled while a tick that picked it awaits stays cancelled, with every recording slot taken', async () => {
    const s = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', Date.now() - 60000, { programEnd: Date.now() + H }));
    assert.equal(s.status, 201);
    const fake = (id) => { const proc = new EventEmitter(); proc.stdin = { write() {}, end() {} }; proc.kill = () => {}; engine._active.set(id, { proc }); };
    fake(990001); fake(990002); // both slots (the default 2) in use
    try {
        const ticking = engine.tick(); // it has picked the schedule and awaits its settings
        await engine.cancelScheduled(s.body.id);
        await ticking;
        assert.equal(status(s.body.id), 'cancelled');
        await engine.tick();
        assert.equal(status(s.body.id), 'cancelled', 'and on the next tick');
    } finally {
        engine._active.delete(990001); engine._active.delete(990002);
    }
});

// Codex (high): a restart cleared every mark before reconciling, so a capture whose cancel the restart interrupted (its
// replacement already made) resumed beside the replacement: two active schedules of one game.
test('a restart finishes a cancel it interrupted (what it recorded kept, no resume) before anything resumes; the replacement stands', async () => {
    const os = require('node:os');
    const game = `${GAME}:restart`;
    const old = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', Date.now() - 10 * 60000, { gameId: game, programEnd: Date.now() + 2 * H }));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-cancel-restart-'));
    const { recordings } = load('db/recordingsDb');
    const rec = recordings.create({ scheduled_id: old.body.id, title: 't', channel_name: 'Fox Footy', channel_logo: null, source_id: source.id, channel_item_id: 'pos_1', file_path: path.join(workDir, 'x.mp4'), started_at: Date.now() - 5 * 60000 });
    recordings.setSegmentFields(rec.id, { work_dir: workDir, segment_state: 'capturing' });
    sqlite.getDb().prepare(`UPDATE scheduled_recordings SET status = 'recording', recording_id = ? WHERE id = ?`).run(rec.id, old.body.id);
    const pending = await call('POST', '/api/recordings/schedule', on('pos_3', 'Kayo 3', Date.now() + 5 * H, { gameId: `${game}:2` }));
    // a replacement committed before the server stopped (by a build before the #347 refusal, or written directly)
    const replacement = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', Date.now() - 10 * 60000, { gameId: `${game}:r`, programEnd: Date.now() + 2 * H }));
    assert.equal(replacement.status, 201);
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET sport_game_id = ? WHERE id = ?').run(game, replacement.body.id);
    scheduled.setCancelling(old.body.id, true);
    scheduled.setCancelling(pending.body.id, true);
    // the restart
    load('db/recordingsDb').__resetInitForTests(); initSchema();
    await engine._reconcileOnStartup();
    assert.equal(status(old.body.id), 'cancelled', 'the interrupted cancel is finished');
    assert.equal(engine._continuations.has(old.body.id), false, 'never resumed');
    assert.notEqual(recordings.getById(rec.id).segment_state, 'capturing', 'its capture ended (what it recorded made into its file)');
    assert.equal(status(pending.body.id), 'cancelled', 'a pending one whose cancel was interrupted: cancelled too');
    assert.equal(scheduled.listCancelling().length, 0, 'no mark left');
    assert.equal(status(replacement.body.id), 'scheduled');
    const again = await call('POST', '/api/recordings/schedule', on('pos_3', 'Kayo 3', Date.now() - 5 * 60000, { gameId: game, programEnd: Date.now() + 2 * H }));
    assert.deepEqual([again.status, again.body.id], [200, replacement.body.id], 'the game\'s one active schedule is the replacement');
    await engine.cancelScheduled(replacement.body.id);
});
