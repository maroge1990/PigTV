const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// R5 (Wave 4): recording rules. "Record my team" (a follow keyword over Sport's events, never a
// replay, on the event's best channel) and "record this series" (a title on one channel, episodes
// told apart by the guide's episode number or subtitle, now kept at ingest). De-duplicated by
// identity, by an existing schedule within 15 minutes, and by hits: a cancelled one never comes
// back, not even after the guide nudges its time. The old code has no rules at all.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rules-')));
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
const rules = load('services/recordingRules');
const { scheduled, initSchema } = load('db/recordingsDb');
const { programmeData } = load('services/syncService');

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const D = 24 * H;
const NOW = Date.now();
let source, server, base, token;

before(async () => {
    initSchema();
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', ?, ?, ?, 0, ?)`);
    item.run(`${source.id}:pos_1`, source.id, 'pos_1', 'Fox Footy', 1, 'ff', 'ff', 'http://provider.invalid/1.ts');
    item.run(`${source.id}:pos_2`, source.id, 'pos_2', 'Fox Footy HD', 2, 'ffhd', 'ffhd', 'http://provider.invalid/2.ts');
    item.run(`${source.id}:pos_3`, source.id, 'pos_3', 'ABC', 3, 'abc', 'abc', 'http://provider.invalid/3.ts');
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const sport = '["Sport","AFL"]';
    prog.run('ff', source.id, NOW + 2 * H, NOW + 5 * H, 'AFL: Collingwood v Carlton', sport, 8, null);
    prog.run('ffhd', source.id, NOW + 2 * H, NOW + 5 * H, 'AFL: Collingwood v Carlton', sport, 8, null);
    prog.run('ff', source.id, NOW + 30 * H, NOW + 33 * H, 'AFL: Collingwood v Carlton', sport, 1, null); // the replay
    prog.run('ff', source.id, NOW + 50 * H, NOW + 53 * H, 'AFL: Richmond v Geelong', sport, 8, null);
    const garden = 'Gardening Australia';
    prog.run('abc', source.id, NOW + 1 * D, NOW + 1 * D + 30 * M, garden, null, 0, programmeData({ subtitle: 'Spring Planting', episodeNum: 'S35E01' }));
    prog.run('abc', source.id, NOW + 2 * D, NOW + 2 * D + 30 * M, garden, null, 1, programmeData({ subtitle: 'Spring Planting', episodeNum: 'S35E01' }));
    prog.run('abc', source.id, NOW + 3 * D, NOW + 3 * D + 30 * M, garden, null, 0, programmeData({ subtitle: 'Natives', episodeNum: 'S35E02' }));
    prog.run('abc', source.id, NOW + 4 * D, NOW + 4 * D + 30 * M, garden, null, 1, null); // no episode data: a repeat by its flag only
    prog.run('abc', source.id, NOW + 1 * D + H, NOW + 1 * D + 2 * H, 'Gardening Australia Extra', null, 0, null);

    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(user);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/recordings', auth.streamAuth, load('routes/recordings'));
    app.use('/api/info', load('routes/info'));
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

async function call(method, route, body, { withToken = true } = {}) {
    const res = await fetch(`${base}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...(withToken ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
}
const active = () => scheduled.listUpcoming();
const byRule = (id) => sqlite.getDb().prepare(`SELECT * FROM scheduled_recordings WHERE rule_id = ? ORDER BY program_start`).all(id);

test('the guide sync keeps a programme\'s subtitle and episode number (and nothing when it has neither)', () => {
    assert.deepEqual(JSON.parse(programmeData({ subtitle: '  Spring   Planting ', episodeNum: 'S35E01' })), { sub: 'Spring Planting', ep: 'S35E01' });
    assert.deepEqual(JSON.parse(programmeData({ episodeNum: '34.0.0/1' })), { ep: '34.0.0/1' });
    assert.equal(programmeData({ title: 'News', subtitle: '', episodeNum: null }), null);
});

test('a rule is checked before it is kept', async () => {
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'film', match: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'sport', match: '  ' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'series', match: 'Gardening Australia' })).status, 400, 'a series needs its channel');
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'series', match: 'X', sourceId: source.id, channelId: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/rules', { kind: 'sport', match: 'AFL', preBufferMin: -1 })).status, 400);
    assert.equal((await call('GET', '/api/recordings/rules', undefined, { withToken: false })).status, 401);
    assert.deepEqual((await call('GET', '/api/recordings/rules')).body, []);
});

test('"record my team": the live game on its best channel, never the replay; again does nothing; a league rule does not record it twice', async () => {
    const created = await call('POST', '/api/recordings/rules', { kind: 'sport', match: 'Collingwood', postBufferMin: 30 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.scheduled, 1);
    const team = created.body;
    const [s] = byRule(team.id);
    assert.equal(s.channel_name, 'Fox Footy HD', 'the event\'s best channel');
    assert.equal(s.channel_item_id, 'pos_2');
    assert.equal(s.program_start, NOW + 2 * H);
    assert.equal(s.post_buffer_min, 30);
    assert.equal(s.status, 'scheduled');
    assert.equal(active().filter(r => /Collingwood/.test(r.title)).length, 1, 'the replay is not recorded');

    assert.deepEqual(await rules.evaluate(), [], 'evaluating again schedules nothing new');
    const again = await call('POST', '/api/recordings/rules', { kind: 'sport', match: 'collingwood' });
    assert.equal(again.status, 200, 'the same rule twice is the same rule');
    assert.equal(again.body.id, team.id);

    const league = await call('POST', '/api/recordings/rules', { kind: 'sport', match: 'AFL' });
    assert.equal(league.status, 201);
    assert.equal(league.body.scheduled, 1, 'only Richmond v Geelong is new');
    assert.equal(active().filter(r => /Collingwood/.test(r.title)).length, 1, 'two rules, one recording');
    assert.equal(byRule(league.body.id)[0].title.includes('Richmond'), true);

    const list = (await call('GET', '/api/recordings/rules')).body;
    assert.deepEqual(list.map(r => [r.kind, r.match, r.upcoming]), [['sport', 'Collingwood', 1], ['sport', 'AFL', 1]]);
    for (const r of list) assert.ok(!JSON.stringify(r).includes('://'), 'no addresses in a rule');
});

test('a schedule the viewer cancels is never made again, even after the guide moves its time', async () => {
    const team = (await call('GET', '/api/recordings/rules')).body.find(r => r.match === 'Collingwood');
    const [s] = byRule(team.id);
    await load('services/recordingEngine').cancelScheduled(s.id);
    assert.deepEqual(await rules.evaluate(), []);
    // The guide nudges the game 10 minutes later: a new Sport event id.
    sqlite.getDb().prepare(`UPDATE epg_programs SET start_time = start_time + ? WHERE title = 'AFL: Collingwood v Carlton' AND start_time = ?`).run(10 * M, NOW + 2 * H);
    sportsEvents.reset();
    assert.deepEqual((await rules.evaluate()).filter(m => /Collingwood/.test(m.title)), [], 'still cancelled');
    assert.equal(active().filter(r => /Collingwood/.test(r.title)).length, 0);
});

test('"record this series": each episode once (the repeat of one is skipped by its episode), only on its channel, only that title', async () => {
    const res = await call('POST', '/api/recordings/rules', { kind: 'series', match: 'gardening australia', sourceId: source.id, channelId: 'pos_3' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.channelName, 'ABC');
    const made = byRule(res.body.id);
    assert.deepEqual(made.map(s => (s.program_start - NOW) / D), [1, 3, 4], 'S35E01, S35E02 and the airing with no episode data; not the S35E01 repeat');
    assert.ok(made.every(s => s.title === 'Gardening Australia' && s.channel_item_id === 'pos_3'));

    // New episodes only: the airing flagged previously shown is not recorded either.
    await call('DELETE', `/api/recordings/rules/${res.body.id}`);
    const fresh = await call('POST', '/api/recordings/rules', { kind: 'series', match: 'Gardening Australia', sourceId: source.id, channelId: 'pos_3', newOnly: true });
    assert.deepEqual(byRule(fresh.body.id).map(s => (s.program_start - NOW) / D), [1, 3]);
    assert.equal(fresh.body.newOnly, true);
});

test('switching a rule off stops it; deleting one cancels what it scheduled that has not started', async () => {
    const all = (await call('GET', '/api/recordings/rules')).body;
    const league = all.find(r => r.match === 'AFL');
    const off = await call('PUT', `/api/recordings/rules/${league.id}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal((await call('PUT', `/api/recordings/rules/${league.id}`, { enabled: 'no' })).status, 400);
    assert.equal((await call('PUT', '/api/recordings/rules/9999', { enabled: true })).status, 404);

    const series = all.find(r => r.kind === 'series');
    const before = byRule(series.id).filter(s => s.status === 'scheduled').length;
    assert.ok(before > 0);
    const del = await call('DELETE', `/api/recordings/rules/${series.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.cancelled, before);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(byRule(series.id).filter(s => s.status === 'scheduled').length, 0);
    assert.equal((await call('DELETE', `/api/recordings/rules/${series.id}`)).status, 404);
});

test('/api/info lists recordingRules; scheduled rows carry rule_id', async () => {
    const info = await call('GET', '/api/info');
    assert.equal(info.body.features.recordingRules, true);
    const rows = (await call('GET', '/api/recordings/scheduled')).body;
    assert.ok(rows.some(r => Number.isInteger(r.rule_id)));
    assert.ok(rows.every(r => 'rule_id' in r));
});
