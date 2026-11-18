const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #347 (Codex sign-off 2, medium): a rule's own schedule follows its programme when the guide moves it (F4), by a direct
// update that skipped the game-and-airing check (one game, one active schedule per airing) and kept the old programme's
// guide end (program_end_original), which then hid the moved schedule from that check. Same setup as
// recording-game-unique.test.js: a team rule for Collingwood, whose game the guide lists on Fox Footy at +2 h.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rule-move-game-')));
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


const GAME = 'espn:australian-football/afl:1';
const rules = () => load('services/recordingRules');
const sched = (id) => sqlite.getDb().prepare('SELECT id, channel_item_id, program_start, program_end, program_end_original, status, rule_id, sport_game_id FROM scheduled_recordings WHERE id = ?').get(id);
const activeOfGame = () => sqlite.getDb().prepare(`SELECT * FROM scheduled_recordings WHERE sport_game_id = ? AND status IN ('scheduled', 'waiting', 'recording') ORDER BY id`).all(GAME);
let ruleRow;

test('setup: the team rule schedules the game on its listing, its own schedule', async () => {
    const rule = await call('POST', '/api/recordings/rules', { kind: 'team', match: 'Collingwood', sport: 'australian football' });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    const mine = activeOfGame();
    assert.equal(mine.length, 1);
    ruleRow = mine[0];
    assert.deepEqual([ruleRow.channel_item_id, ruleRow.program_start, ruleRow.rule_id], ['pos_1', NOW + 2 * H, rule.body.id]);
});

test('a rule\'s schedule whose programme moves onto an airing another schedule of the game records: it stays, never two', async () => {
    // the rule's schedule is (as the guide had it) 5 h later; meanwhile a viewer set the game's +2 h airing on Fox Footy 2
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_start = ?, program_end = ?, program_end_original = NULL WHERE id = ?')
        .run(NOW + 7 * H, NOW + 9 * H, ruleRow.id);
    const viewer = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 2 * H, { gameId: GAME, programEnd: NOW + 5 * H }));
    assert.equal(viewer.status, 201, 'the viewer\'s own airing');
    const before = sched(ruleRow.id);
    await rules().evaluate();
    assert.deepEqual(sched(ruleRow.id), before, 'not moved onto the viewer\'s airing; still the rule\'s');
    const overlapping = activeOfGame().filter(r => r.program_start < NOW + 5 * H && r.program_end > NOW + 2 * H);
    assert.equal(overlapping.length, 1, 'one active schedule of the game at +2 h');
    sqlite.getDb().prepare(`UPDATE scheduled_recordings SET status = 'cancelled' WHERE id = ?`).run(viewer.body.id);
});

test('a rule\'s schedule that follows its programme takes the new slot\'s guide end: a simulcast request then finds it', async () => {
    // the rule's schedule was at +0.2 h, its end moved on by the guide (its own slot ended at +1 h); the programme moves to +2 h
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_start = ?, program_end = ?, program_end_original = ? WHERE id = ?')
        .run(NOW + 0.2 * H, NOW + 1.9 * H, NOW + 1 * H, ruleRow.id);
    await rules().evaluate();
    const moved = sched(ruleRow.id);
    assert.deepEqual([moved.program_start, moved.program_end_original, moved.rule_id, moved.status], [NOW + 2 * H, null, ruleRow.rule_id, 'scheduled'],
        'moved, the old guide end left behind, still the rule\'s');
    const simulcast = await call('POST', '/api/recordings/schedule', on('pos_2', 'Fox Footy 2', NOW + 2 * H + 30 * 60000, { gameId: GAME }));
    assert.deepEqual([simulcast.status, simulcast.body.id, simulcast.body.alreadyScheduled], [200, ruleRow.id, true]);
});
