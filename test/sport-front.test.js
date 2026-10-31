const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// 0381 (D-39): GET /api/sports/front (the Sport front page, "Blend 1"), the household's followed sports and teams
// (sportPagePrefs), and the score collector on by default with the legacy dashboard routes still opt-in.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-front-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-sport-front-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
// A zone where it is mid-morning now, so every game below (from 5 h before to 3 h after now) is on today's date.
const H = 3600000, MIN = 60000;
let offset = 10 - new Date().getUTCHours(); // UTC+offset, from -12 to +14 (Etc/GMT-14 is the furthest east)
if (offset < -12) offset += 24;
process.env.TZ = offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
const auth = load('auth'), db = load('db'), dashboard = load('services/sportsDashboard');
let server, base, token, guideEvents = [];

before(async () => {
    token = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    load('services/sportsEvents').eventsResponse = async () => ({ body: Buffer.from(JSON.stringify({ events: guideEvents })) });
    load('db/recordingsDb').initSchema();
    const app = express(); app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    dashboard.stop();
    load('services/sportsEvents').shutdown();
    if (server?.listening) await new Promise(r => server.close(r));
    load('db/sqlite').getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
});
async function call(url, body) {
    const r = await fetch(base + url, { method: body ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, cache: r.headers.get('cache-control'), body: parsed };
}
const sql = () => load('db/sqlite').getDb();
function clearGames() { dashboard.store(); sql().prepare('DELETE FROM sports_score_history').run(); sql().prepare('DELETE FROM sports_dashboard_catalog').run(); }
function removeGame(id) { sql().prepare('DELETE FROM sports_score_history WHERE game_id = ?').run(id); sql().prepare('DELETE FROM sports_dashboard_catalog WHERE id = ?').run(id); }
const packers = { id: '9', name: 'Packers', aliases: ['Green Bay Packers', 'Packers', 'GB'], logo: '/api/logo/espn-gb' }; // as the logo cache hands it out
const team = (id, name) => ({ id, name, aliases: [name], logo: null });
const game = (id, league, start, competitors, snapshot, extra = {}) => ({ id, league, title: competitors.map(c => c.name).join(' v ') || 'Mexico City Grand Prix',
    start, end: null, session: league === 'F1' ? 'Race' : null, circuit: null, competitors, snapshot, ...extra });
const live = (scores = ['7', '3']) => ({ state: 'live', progress: { clock: '5:00', period: 2 }, scores, situation: { down: 3 } });
const scheduled = { state: 'scheduled', progress: {}, scores: null, situation: null };
const front = async () => { const r = await call('/api/sports/front'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.cache, /private.*no-store/); return r.body; };

test('prefs: migrated once from the follow list; following still writes; bad sports or teams are a 400', async () => {
    const ins = sql().prepare('INSERT INTO sports_follow (position, keyword) VALUES (?, ?)');
    ['NFL', 'NFL: Green Bay Packers', 'F1'].forEach((k, i) => ins.run(i, k));
    const got = (await call('/api/sports/pages/preferences')).body;
    assert.deepEqual(got.sports, ['NFL', 'F1']);
    assert.deepEqual(got.teams, { NFL: ['Green Bay Packers'] });
    assert.equal(got.following.NFL, 'Green Bay Packers');
    const put = await call('/api/sports/pages/preferences', { following: { F1: 'Oscar Piastri' } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.teams.F1, ['Oscar Piastri']);
    assert.equal((await call('/api/sports/pages/preferences', { sports: ['Bogus'] })).status, 400);
    assert.equal((await call('/api/sports/pages/preferences', { teams: { NBA: ['x'] } })).status, 400);
    assert.deepEqual((await call('/api/sports/pages/preferences')).body, put.body, 'a refused change changes nothing');
    // Written back once: a later change to the follow list does not re-migrate.
    sql().prepare('DELETE FROM sports_follow').run();
    assert.deepEqual((await call('/api/sports/pages/preferences')).body.sports, ['NFL', 'F1']);
    assert.ok(load('services/sportsFixtures').neededLeagues().has('NFL'), 'the collector fetches what the household follows');
});

test('front: shape, rails in the household order, a followed team live leads (follow-live)', async () => {
    clearGames();
    const now = Date.now();
    dashboard.store().ingest([
        game('espn:football/nfl:401', 'NFL', now - H, [packers, team('3', 'Bears')], live()),
        game('espn:basketball/nba:1', 'NBA', now - 30 * MIN, [team('1', 'Lakers'), team('2', 'Celtics')], live(['50', '48'])),
        game('espn:racing/f1:1', 'F1', now + 2 * H, [], scheduled),
        game('espn:football/nfl:406', 'NFL', now + 55 * MIN, [team('12', 'Chiefs'), team('2', 'Bills')], scheduled)
    ], now - 100000);
    // A final from earlier today: seen live, then finished three hours ago.
    const final = s => game('espn:football/nfl:405', 'NFL', now - 5 * H, [packers, team('16', 'Vikings')], s);
    dashboard.store().ingest([final(live(['14', '10']))], now - 4 * H);
    dashboard.store().ingest([final({ state: 'finished', progress: { clock: '0:00', period: 4 }, scores: ['27', '20'], situation: null })], now - 3 * H);
    guideEvents = [
        { id: 'ev-kc', league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: now + 55 * MIN, end: now + 4 * H, live: false,
            channels: [{ sourceId: 1, id: 'pos_5', stableId: 's5', name: 'ESPN HD', quality: 'HD', start: now + 50 * MIN, end: now + 4 * H + 5 * MIN }] },
        { id: 'ev-cricket', league: 'Cricket', title: 'Australia v India - 1st ODI', kind: 'event', start: now - 2 * H, end: now + 5 * H, live: true,
            channels: [{ sourceId: 1, id: 'pos_6', stableId: 's6', name: 'Fox Cricket', quality: 'HD', start: now - 2 * H, end: now + 5 * H }] }
    ];
    try {
        assert.equal((await call('/api/sports/pages/preferences', { sports: ['F1', 'NFL', 'NBA', 'Cricket'],
            teams: { F1: ['Oscar Piastri'], NFL: ['Green Bay Packers'] } })).status, 200);
        const f = await front();
        assert.equal(f.scores, 'fresh');
        assert.deepEqual(f.hero, { reason: 'follow-live', followIndex: 1, gameId: 'espn:football/nfl:401' });
        assert.deepEqual(f.rails.map(r => r.league), ['F1', 'NFL', 'NBA', 'Cricket']);
        assert.deepEqual(f.rails.map(r => r.gameIds), [['espn:racing/f1:1'],
            ['espn:football/nfl:401', 'espn:football/nfl:405', 'espn:football/nfl:406'], ['espn:basketball/nba:1'], ['guide:ev-cricket']]);
        assert.deepEqual(f.follows.map(x => [x.league, x.name, x.state, x.gameId]),
            [['F1', 'Oscar Piastri', 'next', 'espn:racing/f1:1'], ['NFL', 'Green Bay Packers', 'live', 'espn:football/nfl:401']]);
        assert.equal(f.follows[0].logo, null, 'a driver has no logo');
        assert.equal(f.follows[1].logo, '/api/logo/espn-gb', 'the matching competitor\'s logo, through the logo cache');
        assert.deepEqual(f.sports.map(s => [s.league, s.live, s.line]), [['F1', 0, 'next'], ['NFL', 1, 'live'], ['NBA', 1, 'live'], ['Cricket', 0, 'quiet']]);
        assert.deepEqual(f.sports[0].next, { gameId: 'espn:racing/f1:1', start: f.games.find(g => g.id === 'espn:racing/f1:1').start });
        assert.deepEqual(f.sports[1].next, { gameId: 'espn:football/nfl:406', start: now + 55 * MIN });
        const byId = Object.fromEntries(f.games.map(g => [g.id, g]));
        assert.equal(byId['espn:football/nfl:401'].followed, true);
        assert.equal(byId['espn:racing/f1:1'].followed, true, 'a followed driver races in every session');
        assert.equal(byId['espn:basketball/nba:1'].followed, false);
        assert.equal(byId['guide:ev-cricket'].followed, false);
        assert.equal(byId['espn:football/nfl:405'].status, 'finished');
        assert.deepEqual(byId['espn:football/nfl:405'].scores, ['27', '20']);
        assert.deepEqual(byId['espn:football/nfl:406'].channels.map(c => [c.start, c.end]), [[now + 50 * MIN, now + 4 * H + 5 * MIN]]);
        assert.equal(f.games.length, 6);
        assert.equal(f.followMatches, undefined, 'internal matching stays internal');
        // The Apple client's tests decode this real answer (PigTV-Swift PigTVTests/Fixtures/sport-front-0381.json).
        if (process.env.PIGTV_WRITE_FIXTURES === '1') fs.writeFileSync(path.join(__dirname, 'fixtures', 'sport-front-0381.json'), JSON.stringify(f, null, 2) + '\n');
    } finally { guideEvents = []; }
});

test('front: hero falls back to a live followed sport (league-live), then the next followed game (follow-next)', async () => {
    const now = Date.now();
    for (const id of ['espn:football/nfl:401', 'espn:football/nfl:405', 'espn:football/nfl:406']) removeGame(id);
    await call('/api/sports/pages/preferences', { teams: { F1: [] } }); // the driver would make every F1 session a followed one
    dashboard.store().ingest([
        game('espn:racing/f1:2', 'F1', now - 20 * MIN, [], live(null)),
        game('espn:football/nfl:402', 'NFL', now + 3 * H, [packers, team('8', 'Lions')], scheduled)
    ], now - 100000);
    let f = await front();
    assert.deepEqual(f.hero, { reason: 'league-live', followIndex: null, gameId: 'espn:racing/f1:2' });
    assert.deepEqual(f.follows.map(x => [x.name, x.state]), [['Green Bay Packers', 'next']]);
    removeGame('espn:racing/f1:2'); removeGame('espn:basketball/nba:1');
    f = await front();
    assert.deepEqual(f.hero, { reason: 'follow-next', followIndex: 0, gameId: 'espn:football/nfl:402' });
});

test('front: today\'s final stays with its result; spoiler-free hides scores and keeps neutral progress', async () => {
    const now = Date.now();
    const id = 'espn:football/nfl:403', g = s => game(id, 'NFL', now - 5 * H, [packers, team('8', 'Lions')], s);
    dashboard.store().ingest([g(live(['14', '10']))], now - 4 * H);
    dashboard.store().ingest([g({ state: 'finished', progress: { clock: '0:00', period: 4 }, scores: ['24', '17'], situation: { lastPlay: 'Kneel' } })], now - 3 * H);
    let f = await front();
    let card = f.games.find(c => c.id === id);
    assert.ok(card, 'a final from three hours ago is still on the front page');
    assert.equal(card.status, 'finished');
    assert.deepEqual(card.scores, ['24', '17']);
    assert.deepEqual(f.rails.find(r => r.league === 'NFL').gameIds, [id, 'espn:football/nfl:402'], 'finals before what is next');
    await call('/api/sports/pages/preferences', { spoilerFree: true });
    f = await front();
    card = f.games.find(c => c.id === id);
    assert.equal(f.spoilerFree, true);
    assert.equal(card.scores, undefined);
    assert.equal(card.situation, undefined);
    assert.deepEqual(card.progress, { clock: '0:00', period: 4 });
    await call('/api/sports/pages/preferences', { spoilerFree: false });
});

test('front: each channel carries its own airing start and end', async () => {
    const now = Date.now();
    const id = 'espn:football/nfl:404';
    dashboard.store().ingest([game(id, 'NFL', now - 30 * MIN, [packers, team('3', 'Bears')], live())], now - 100000);
    guideEvents = [{ id: 'ev-gb', league: 'NFL', title: 'Packers v Bears', kind: 'event', start: now - 30 * MIN, end: now + 3 * H, live: true,
        channels: [{ sourceId: 1, id: 'pos_3', stableId: 's3', name: 'Fox HD', quality: 'HD', start: now - 35 * MIN, end: now + 3 * H + 5 * MIN, url: 'http://provider.invalid/x' }] }];
    const card = (await front()).games.find(c => c.id === id);
    assert.equal(card.channels.length, 1);
    assert.equal(card.channels[0].start, now - 35 * MIN);
    assert.equal(card.channels[0].end, now + 3 * H + 5 * MIN);
    assert.equal(card.channels[0].url, undefined);
    guideEvents = [];
});

test('front: no scores, one guide listing on now: scores unavailable, the guide card leads and sits in its rail', async () => {
    clearGames();
    const now = Date.now();
    await call('/api/sports/pages/preferences', { sports: ['F1', 'NFL', 'AFL'] });
    guideEvents = [{ id: 'ev-afl', league: 'AFL', title: 'Cats v Swans', kind: 'event', start: now - 30 * MIN, end: now + H, live: true,
        channels: [{ sourceId: 1, id: 'pos_4', stableId: 's4', name: 'Seven', quality: 'HD', start: now - 30 * MIN, end: now + H }] }];
    const f = await front();
    assert.equal(f.scores, 'unavailable');
    assert.deepEqual(f.hero, { reason: 'guide', followIndex: null, gameId: 'guide:ev-afl' });
    assert.deepEqual(f.rails.find(r => r.league === 'AFL').gameIds, ['guide:ev-afl']);
    assert.equal(f.games.find(g => g.id === 'guide:ev-afl').followed, false);
    guideEvents = [];
    await call('/api/sports/pages/preferences', { sports: [] });
    const empty = await front();
    assert.deepEqual(empty, { now: empty.now, timezone: process.env.TZ, spoilerFree: false, scores: 'unavailable',
        sports: [], follows: [], hero: { reason: 'none', followIndex: null, gameId: null }, rails: [], games: [] });
});

test('front: a followed team\'s game tomorrow is its sport\'s next and leads with nothing live; /dashboard keeps today only', async () => {
    clearGames();
    const now = Date.now(), id = 'espn:football/nfl:420';
    await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } });
    dashboard.store().ingest([game(id, 'NFL', now + 20 * H, [packers, team('8', 'Lions')], scheduled)], now - 100000);
    const f = await front();
    assert.deepEqual(f.games.map(g => g.id), [id], 'tomorrow\'s fixture is on the front page (0382)');
    assert.deepEqual(f.sports[0].next, { gameId: id, start: now + 20 * H });
    assert.deepEqual([f.follows[0].state, f.follows[0].gameId], ['next', id]);
    assert.deepEqual(f.hero, { reason: 'follow-next', followIndex: 0, gameId: id });
    process.env.PIGTV_SPORTS_DASHBOARD = '1';
    try {
        const legacy = await call('/api/sports/dashboard');
        assert.equal(legacy.status, 200);
        assert.equal(legacy.body.games.some(g => g.id === id), false, 'the legacy dashboard\'s scope is unchanged');
    } finally { delete process.env.PIGTV_SPORTS_DASHBOARD; }
    clearGames();
});

test('arrange: between live followed cards the one closest to finishing leads, by its end or the league\'s typical length', () => {
    const { arrange } = load('services/sportFront');
    const now = Date.now();
    const card = (id, league, start, extra) => ({ id, league, start, end: null, status: 'live', followed: true, freshness: 'fresh',
        competitors: [], channels: [], canWatch: true, ...extra });
    const prefs = { spoilerFree: false, sports: ['Cricket', 'NFL'], teams: { Cricket: ['Australia'], NFL: ['Green Bay Packers'] } };
    const respond = games => ({ now, timezone: 'Etc/GMT', games, followMatches: {
        'espn:cricket/1:1': [{ name: 'Australia', competitor: null }], 'espn:football/nfl:9': [{ name: 'Green Bay Packers', competitor: null }] } });
    const testMatch = card('espn:cricket/1:1', 'Cricket', now - 6 * H, { format: 'test' });
    let f = arrange(respond([testMatch, card('espn:football/nfl:9', 'NFL', now - 3 * H, { end: now + 10 * MIN })]), prefs);
    assert.deepEqual(f.hero, { reason: 'follow-live', followIndex: 1, gameId: 'espn:football/nfl:9' });
    f = arrange(respond([testMatch, card('espn:football/nfl:9', 'NFL', now - 3 * H)]), prefs);
    assert.equal(f.hero.gameId, 'espn:football/nfl:9', 'NFL (3.25 h) before a Test (120 h) without an end on either');
});

test('features: sportFront on by default, the legacy dashboard off; PIGTV_SPORTS_DASHBOARD=0 turns the front page off', async () => {
    let features = (await call('/api/info')).body.features;
    assert.equal(features.sportFront, true);
    assert.equal(features.sportsDashboard, false);
    process.env.PIGTV_SPORTS_DASHBOARD = '0';
    try {
        features = (await call('/api/info')).body.features;
        assert.equal(features.sportFront, false);
        assert.equal((await call('/api/sports/front')).status, 404);
    } finally { delete process.env.PIGTV_SPORTS_DASHBOARD; }
});
