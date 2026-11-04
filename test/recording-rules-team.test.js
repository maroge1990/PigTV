const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #198 (D-41 point 11): "Record every game" on a followed team: a 'team' rule records the team's games from the fixture
// (the collector's cards), each on the channel the guide airs it on, never a replay, only in the leagues of the sport
// its maker follows; Recordings shows who set it. The old code has no 'team' rules.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-team-rule-')));
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
    initSchema();
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', ?, ?, ?, 0, ?)`);
    item.run(`${source.id}:pos_1`, source.id, 'pos_1', 'Fox Footy', 1, 'ff', 'ff', 'http://provider.invalid/1.ts');
    item.run(`${source.id}:pos_2`, source.id, 'pos_2', 'Fox Footy 2', 2, 'ff2', 'ff2', 'http://provider.invalid/2.ts');
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const sport = '["Sport"]';
    prog.run('ff', source.id, NOW + 2 * H, NOW + 5 * H, 'AFL: Collingwood v Carlton', sport, 8, null);
    prog.run('ff', source.id, NOW + 30 * H, NOW + 33 * H, 'AFL Replay: Collingwood v Carlton', sport, 1, null);
    prog.run('ff', source.id, NOW + 40 * H, NOW + 43 * H, 'AFLW: Collingwood v Carlton', sport, 8, null);
    prog.run('ff', source.id, NOW + 60 * H, NOW + 63 * H, 'AFL: Richmond v Geelong', sport, 8, null);

    user = await db.users.create({ username: 'mark', role: 'admin' });
    token = auth.generateToken(user);
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL'], teams: ['Collingwood'] }] });
    const store = dashboard.store();
    store.ingest([game('espn:australian-football/afl:1', 'AFL', NOW + 2 * H + 10 * 60000, 'Collingwood', 'Carlton'),
        game('espn:australian-football/afl:2', 'AFL', NOW + 50 * H, 'Collingwood', 'Essendon'), // no airing in the guide yet
        game('espn:australian-football/afl:3', 'AFL', NOW + 60 * H, 'Richmond', 'Geelong'),
        game('aflw:9', 'AFLW', NOW + 40 * H, 'Collingwood', 'Carlton'), // a league the maker does not follow
        game('espn:australian-football/afl:5', 'AFL', NOW + 20 * H, 'Hawthorn', 'Geelong'),
        game('aflw:10', 'AFLW', NOW + 20 * H + 30 * 60000, 'Hawthorn', 'Geelong')], NOW - 1000);

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

test('#198: a team rule needs a catalogue sport', async () => {
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Collingwood' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Collingwood', sport: 'Quidditch' })).status, 400);
});

test('#198: "Record every game" records the team\'s fixture games on their airing, never a replay, only in the maker\'s leagues', async () => {
    const made = await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Collingwood', sport: 'australian football' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.kind, made.body.match, made.body.sport, made.body.createdByName], ['team', 'Collingwood', 'Australian football', 'mark']);
    assert.equal(made.body.scheduled, 1, 'the game with an airing; the one not yet in the guide waits for a later evaluation');
    const mine = scheduled.listUpcoming().filter(s => s.rule_id === made.body.id);
    assert.deepEqual(mine.map(s => [s.title, s.channel_name, s.program_start]), [['Collingwood v Carlton', 'Fox Footy', NOW + 2 * H]],
        'never the replay, nor the AFLW game (a league the maker does not follow), nor another team\'s');
    assert.equal(mine[0].sport_game_id, 'espn:australian-football/afl:1', '#217: linked to its game, so it records until the game ends');
    // again: nothing more
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'team', match: 'collingwood', sport: 'Australian football' })).body.scheduled, 0);
    // once the maker follows AFLW too, its game is recorded
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL', 'AFLW'], teams: ['Collingwood'] }] });
    sportsEvents.reset(); // the guide's event list is rebuilt in the background after a follow change; here, at once
    await load('services/recordingRules').evaluate();
    assert.deepEqual(scheduled.listUpcoming().filter(s => s.rule_id === made.body.id).map(s => s.program_start).sort((a, b) => a - b),
        [NOW + 2 * H, NOW + 40 * H]);
});

// 0416 (0415 Codex round 1, high): team rules paired schedules by title, so one game's schedule could be taken over by
// another game of the same name (here when the guide drops the AFL airing as the AFLW one appears): moved to the other
// game's time but left on the first game's channel.
test('0416: a game of the same name in another league never takes over a schedule: each game its own, on its own channel', async () => {
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL', 'AFLW'], teams: ['Collingwood', 'Sydney'] }] });
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('ff', source.id, NOW + 26 * H, NOW + 29 * H, 'AFL: Sydney v Fremantle', '["Sport"]', 8, null);
    dashboard.store().ingest([game('espn:australian-football/afl:7', 'AFL', NOW + 26 * H, 'Sydney', 'Fremantle'),
        game('aflw:11', 'AFLW', NOW + 27 * H, 'Sydney', 'Fremantle')], NOW);
    sportsEvents.reset();
    const made = await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Sydney', sport: 'Australian football' });
    assert.equal(made.status, 201);
    const rows = () => scheduled.listUpcoming().filter(s => s.rule_id === made.body.id).map(s => [s.channel_name, s.program_start]).sort((x, y) => x[1] - y[1]);
    assert.deepEqual(rows(), [['Fox Footy', NOW + 26 * H]]);
    // the guide drops the AFL airing; the AFLW game's appears on another channel an hour later
    d.prepare(`DELETE FROM epg_programs WHERE title = 'AFL: Sydney v Fremantle'`).run();
    d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('ff2', source.id, NOW + 27 * H, NOW + 30 * H, 'AFLW: Sydney v Fremantle', '["Sport"]', 8, null);
    sportsEvents.reset();
    await load('services/recordingRules').evaluate();
    assert.deepEqual(rows(), [['Fox Footy', NOW + 26 * H], ['Fox Footy 2', NOW + 27 * H]], 'the AFL schedule stays; the AFLW game gets its own');
});

// 0417 (0416 Codex round 2, high): a game on two channels whose coverage starts at different times is one guide event with
// the widest bounds: once one channel's coverage had begun, the rule dropped the game, never recording the other airing.
test('0417: a game whose coverage has begun on one channel is recorded on another channel\'s airing still to come, on its own times', async () => {
    const d = sqlite.getDb();
    const ins = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('ff', source.id, NOW - 30 * 60000, NOW + 3 * H, 'AFL: Brisbane v Adelaide', '["Sport"]', 8, null);
    ins.run('ff2', source.id, NOW + H, NOW + 3 * H + 30 * 60000, 'AFL: Brisbane v Adelaide', '["Sport"]', 8, null);
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL', 'AFLW'], teams: ['Brisbane'] }] });
    dashboard.store().ingest([game('espn:australian-football/afl:8', 'AFL', NOW + 10 * 60000, 'Brisbane', 'Adelaide')], NOW);
    sportsEvents.reset();
    const made = await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Brisbane', sport: 'Australian football' });
    assert.equal(made.status, 201);
    assert.deepEqual(scheduled.listUpcoming().filter(s => s.rule_id === made.body.id).map(s => [s.channel_name, s.program_start, s.program_end]),
        [['Fox Footy 2', NOW + H, NOW + 3 * H + 30 * 60000]]);
});

// #217 (C-M): a schedule made from a sport card names its game (`gameId`) and then ends with it; rows say how they end.
test('#217: POST /schedule with gameId links the schedule to its game; listed rows say endsWith', async () => {
    const made = await call('POST', '/api/recordings/schedule', { sourceId: source.id, channelItemId: 'pos_2', channelName: 'Fox Footy 2',
        title: 'Saturday Night Footy', programStart: NOW + 20 * H, programEnd: NOW + 23 * H, gameId: 'espn:australian-football/afl:5' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.endsWith, 'event');
    assert.equal(made.body.stopsAt, NOW + 23 * H + made.body.post_buffer_min * 60000, 'stopsAt: the guide end + post-padding until the game runs past it');
    assert.ok(!('sport_game_id' in made.body) && !('event_stop' in made.body), 'internal columns are not answered');
    assert.equal(scheduled.getById(made.body.id).sport_game_id, 'espn:australian-football/afl:5');
    const plain = await call('POST', '/api/recordings/schedule', { sourceId: source.id, channelItemId: 'pos_2', title: 'The Late Show',
        programStart: NOW + 26 * H, programEnd: NOW + 27 * H });
    assert.equal(plain.body.endsWith, 'guide');
    const listed = (await call('GET', '/api/recordings/scheduled')).body;
    assert.deepEqual([made.body.id, plain.body.id].map(id => listed.find(r => r.id === id)?.endsWith), ['event', 'guide']);
    assert.ok(listed.every(r => r.endsWith === 'event' || r.endsWith === 'guide'));
});

// #234 (Mark, 4 Nov): Record on a game the guide does not list yet (Monday's Cardinals game) did nothing. A 'game' rule
// holds that one game and schedules it once a listing joins it, as "Record every game" does; then it is spent.
test('#234: a game rule waits for its game\'s listing, then schedules that game alone; spent a day and a half after it', async () => {
    const rules = load('services/recordingRules');
    const id = 'espn:australian-football/afl:2'; // Collingwood v Essendon: no airing in the guide yet
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'game', gameId: 'espn:x/y:not-a-number' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'game', gameId: 'espn:australian-football/afl:999' })).status, 400, 'an unknown game');
    const made = await call('POST', '/api/recordings/rules', { kind: 'game', gameId: id });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.kind, made.body.match, made.body.gameId, made.body.sport, made.body.scheduled],
        ['game', 'Collingwood v Essendon', id, 'Australian football', 0], 'nothing to record yet: no listing');
    // the guide lists it
    sqlite.getDb().prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('ff2', source.id, NOW + 50 * H, NOW + 53 * H, 'AFL: Collingwood v Essendon', '["Sport"]', 8, null);
    sportsEvents.reset();
    await rules.evaluate();
    // that one game, on its listing (by this rule, or by an earlier "Record every Collingwood game" rule: never twice)
    const mine = scheduled.listUpcoming().filter(s => s.sport_game_id === id);
    assert.deepEqual(mine.map(s => [s.title, s.channel_name, s.program_start]), [['Collingwood v Essendon', 'Fox Footy 2', NOW + 50 * H]]);
    await rules.evaluate();
    assert.equal(scheduled.listUpcoming().filter(s => s.sport_game_id === id).length, 1, 'once');
    // a day and a half after the game it is spent: the rule goes, the recording stays
    await rules.evaluate({ now: NOW + 50 * H + 37 * H });
    assert.equal(rules.get(made.body.id), null);
    assert.ok(scheduled.getById(mine[0].id), 'its schedule stays');
});
