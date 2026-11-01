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
        game('aflw:9', 'AFLW', NOW + 40 * H, 'Collingwood', 'Carlton')], NOW - 1000); // a league the maker does not follow

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
    // again: nothing more
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'team', match: 'collingwood', sport: 'Australian football' })).body.scheduled, 0);
    // once the maker follows AFLW too, its game is recorded
    prefs.setFollows(user.id, { sports: [{ sport: 'Australian football', leagues: ['AFL', 'AFLW'], teams: ['Collingwood'] }] });
    sportsEvents.reset(); // the guide's event list is rebuilt in the background after a follow change; here, at once
    await load('services/recordingRules').evaluate();
    assert.deepEqual(scheduled.listUpcoming().filter(s => s.rule_id === made.body.id).map(s => s.program_start).sort((a, b) => a - b),
        [NOW + 2 * H, NOW + 40 * H]);
});
