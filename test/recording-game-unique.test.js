const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #329: one game, one active schedule. POST /recordings/schedule told schedules apart by source, channel and start only,
// so two clients (or a client and a rule) could record one game twice on two channels, with two provider connections.
// Now a schedule for a `gameId` that an active schedule (scheduled, waiting, recording) already has answers 200 with
// that one and `alreadyScheduled: true`, and makes nothing; the check and the insert are one transaction.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-game-unique-')));
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

test('#329: the same game on another channel answers 200 with the first schedule, alreadyScheduled, and makes no row', async () => {
    const first = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 10 * H, { gameId: 'g:one' }));
    assert.equal(first.status, 201);
    assert.equal(first.body.alreadyScheduled, undefined);
    const second = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 10 * H + 30 * 60000, { gameId: 'g:one' }));
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.alreadyScheduled, true);
    assert.equal(second.body.channel_name, 'Fox Footy 2', 'the existing schedule, so a client can say where it records');
    assert.equal(second.body.endsWith, 'event', 'listed as GET /scheduled lists it');
    assert.deepEqual(ofGame('g:one').map(r => r.channel_name), ['Fox Footy 2']);
    assert.equal(sqlite.getDb().prepare(`SELECT COUNT(*) AS n FROM scheduled_recordings WHERE channel_name = 'Fox Footy' AND program_start = ?`)
        .get(NOW + 10 * H + 30 * 60000).n, 0);
});

test('#329: two schedules of one game sent back to back, neither awaited: one row, both answers name it', async () => {
    const [a, b] = await Promise.all([
        call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 12 * H, { gameId: 'g:race' })),
        call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 12 * H, { gameId: 'g:race' }))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.equal(ofGame('g:race').length, 1);
    // the engine itself, as rules call it: both started in one tick
    const engine = load('services/recordingEngine');
    const [x, y] = await Promise.all([
        engine.scheduleFromProgram({ ...on('pos_1', 'Fox Footy', NOW + 14 * H), gameId: 'g:engine' }),
        engine.scheduleFromProgram({ ...on('pos_2', 'Fox Footy 2', NOW + 14 * H), gameId: 'g:engine' })]);
    assert.equal(x.id, y.id);
    assert.equal(ofGame('g:engine').length, 1);
});

test('#329: a completed, cancelled or failed schedule of the game does not block a new one', async () => {
    for (const status of ['completed', 'cancelled', 'failed', 'missed']) {
        const id = `g:${status}`;
        const old = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 16 * H, { gameId: id }));
        scheduled.setStatus(old.body.id, status);
        const again = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 16 * H, { gameId: id }));
        assert.equal(again.status, 201, status);
        assert.notEqual(again.body.id, old.body.id);
        assert.equal(again.body.alreadyScheduled, undefined);
    }
});

test('#329: schedules without a gameId are as before (one per channel and start, each its own)', async () => {
    const a = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 18 * H));
    const b = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 18 * H));
    const c = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 18 * H));
    assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
    assert.notEqual(a.body.id, b.body.id);
    assert.equal(c.body.id, a.body.id, 'the same programme is still the same schedule');
    assert.ok([a, b, c].every(r => r.body.alreadyScheduled === undefined));
});

test('#329: a "Record every game" rule finds the game set to record on another channel: it makes no second, and leaves it as it is', async () => {
    const gameId = 'espn:australian-football/afl:1';
    const mine = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 2 * H, { gameId }));
    assert.equal(mine.status, 201);
    const rule = await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Collingwood', sport: 'australian football' });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    assert.equal(rule.body.scheduled, 0);
    assert.deepEqual(ofGame(gameId).map(r => [r.id, r.channel_name, r.status]), [[mine.body.id, 'Fox Footy 2', 'scheduled']]);
    assert.equal(scheduled.getById(mine.body.id).rule_id, null, 'the viewer\'s schedule is not taken over by the rule');
    // a later evaluation keeps it so
    await load('services/recordingRules').evaluate();
    assert.deepEqual(ofGame(gameId).map(r => [r.id, r.status]), [[mine.body.id, 'scheduled']]);
});

// Codex round 1 of #329 (high): the web's "Record on B instead" scheduled B (now answered with A) and cancelled A, so a
// game could end up recorded nowhere, or a live capture be stopped. The server now moves the schedule in one transaction.
const row = (id) => sqlite.getDb().prepare('SELECT id, source_id, channel_item_id, channel_name, program_start, status, sport_game_id, rule_id FROM scheduled_recordings WHERE id = ?').get(id);

test('#329 move: a scheduled game moves to another channel and time, the same row with its game and padding', async () => {
    const a = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 30 * H, { gameId: 'g:move', preBufferMin: 4, postBufferMin: 25 }));
    sqlite.getDb().prepare(`UPDATE scheduled_recordings SET status = 'waiting', error = 'x' WHERE id = ?`).run(a.body.id);
    const moved = await call('POST', `/api/recordings/scheduled/${a.body.id}/move`, on('pos_2', 'Fox Footy 2', NOW + 30 * H + 1800000));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual([moved.body.id, moved.body.channel_name, moved.body.program_start, moved.body.status, moved.body.endsWith],
        [a.body.id, 'Fox Footy 2', NOW + 30 * H + 1800000, 'scheduled', 'event']);
    const r = sqlite.getDb().prepare('SELECT * FROM scheduled_recordings WHERE id = ?').get(a.body.id);
    assert.deepEqual([r.channel_item_id, r.sport_game_id, r.pre_buffer_min, r.post_buffer_min, r.error], ['pos_2', 'g:move', 4, 25, null]);
    assert.equal(ofGame('g:move').length, 1);
});

test('#329 move: refused while recording or once finished, and for a target scheduling would refuse; nothing changes', async () => {
    const a = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 32 * H, { gameId: 'g:refuse' }));
    const was = row(a.body.id);
    for (const bad of [{ channelItemId: undefined }, { programEnd: NOW + 32 * H - 1 }, { sourceId: 'x' }]) {
        const r = await call('POST', `/api/recordings/scheduled/${a.body.id}/move`, { ...on('pos_2', 'Fox Footy 2', NOW + 32 * H), ...bad });
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.deepEqual(row(a.body.id), was, 'untouched');
    }
    scheduled.setStatus(a.body.id, 'recording');
    const live = await call('POST', `/api/recordings/scheduled/${a.body.id}/move`, on('pos_2', 'Fox Footy 2', NOW + 32 * H));
    assert.deepEqual([live.status, live.body.error], [409, 'It is already recording on Fox Footy; stop it first to record on another channel.']);
    assert.deepEqual(row(a.body.id), { ...was, status: 'recording' });
    scheduled.setStatus(a.body.id, 'completed');
    assert.equal((await call('POST', `/api/recordings/scheduled/${a.body.id}/move`, on('pos_2', 'Fox Footy 2', NOW + 32 * H))).status, 409);
    assert.equal((await call('POST', '/api/recordings/scheduled/999999/move', on('pos_2', 'Fox Footy 2', NOW + 32 * H))).status, 404);
});

test('#329 move: a schedule of the game made on C at the same time, and one already on the target, are never clobbered', async () => {
    const a = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 34 * H, { gameId: 'g:both' }));
    const [moved, onC] = await Promise.all([
        call('POST', `/api/recordings/scheduled/${a.body.id}/move`, on('pos_2', 'Fox Footy 2', NOW + 34 * H)),
        call('POST', '/api/recordings/schedule', on('pos_3', 'Kayo 3', NOW + 34 * H, { gameId: 'g:both' }))]);
    assert.equal(moved.status, 200);
    assert.deepEqual([onC.status, onC.body.id, onC.body.alreadyScheduled], [200, a.body.id, true]);
    assert.deepEqual(ofGame('g:both').map(r => [r.id, r.channel_name, r.status]), [[a.body.id, 'Fox Footy 2', 'scheduled']]);
    // another programme's schedule already on the target: 409, both as they were
    const other = await call('POST', '/api/recordings/schedule', on('pos_3', 'Kayo 3', NOW + 36 * H));
    const b = await call('POST', '/api/recordings/schedule', on('pos_1', 'Fox Footy', NOW + 36 * H, { gameId: 'g:taken' }));
    const [o, w] = [row(other.body.id), row(b.body.id)];
    const r = await call('POST', `/api/recordings/scheduled/${b.body.id}/move`, on('pos_3', 'Kayo 3', NOW + 36 * H));
    assert.deepEqual([r.status, r.body.error], [409, 'Something else is already set to record on Kayo 3 at that time.']);
    assert.deepEqual([row(other.body.id), row(b.body.id)], [o, w]);
});
