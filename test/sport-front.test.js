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
let server, base, token, viewer, guideEvents = [];

before(async () => {
    // #193 (D-41): the server's owner (its first admin) takes over the household's follows; other accounts start empty.
    token = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    viewer = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
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
async function call(url, body, as = token) {
    const r = await fetch(base + url, { method: body ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
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

test('prefs: the owner\'s migrated once from the follow list; another account starts empty; following still writes; bad sports or teams are a 400', async () => {
    const ins = sql().prepare('INSERT INTO sports_follow (position, keyword) VALUES (?, ?)');
    ['NFL', 'NFL: Green Bay Packers', 'F1'].forEach((k, i) => ins.run(i, k));
    const got = (await call('/api/sports/pages/preferences')).body;
    assert.deepEqual(got.sports, ['NFL', 'F1']);
    assert.deepEqual(got.teams, { NFL: ['Green Bay Packers'] });
    assert.equal(got.following.NFL, 'Green Bay Packers');
    assert.deepEqual((await call('/api/sports/pages/preferences', null, viewer)).body,
        { spoilerFree: false, sports: [], teams: {}, following: { F1: null, NFL: null } }, 'only the owner takes over the household\'s');
    assert.deepEqual((await call('/api/sports/front', null, viewer)).body.sports, []);
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
        assert.deepEqual(f.hero, { reason: 'follow-live', followIndex: 0, gameId: 'espn:football/nfl:401' }, 'the live follow, now first (0427)');
        assert.deepEqual(f.rails.map(r => r.league), ['NFL', 'NBA', 'F1', 'Cricket'], 'leagues with a game on now first (D-41)');
        assert.deepEqual(f.rails.map(r => r.gameIds), [['espn:football/nfl:401', 'espn:football/nfl:405', 'espn:football/nfl:406'],
            ['espn:basketball/nba:1'], ['espn:racing/f1:1'], []],
            'a guide listing without a fixture game makes no card (#194, D-41)');
        assert.deepEqual(f.follows.map(x => [x.league, x.name, x.state, x.gameId]),
            [['NFL', 'Green Bay Packers', 'live', 'espn:football/nfl:401'], ['F1', 'Oscar Piastri', 'next', 'espn:racing/f1:1']],
            'a follow playing now first, then the account\'s order (0427, D-43)');
        assert.equal(f.follows[1].logo, null, 'a driver has no logo');
        assert.equal(f.follows[0].logo, '/api/logo/espn-gb', 'the matching competitor\'s logo, through the logo cache');
        assert.deepEqual(f.sports.map(s => [s.league, s.live, s.line]), [['NFL', 1, 'live'], ['NBA', 1, 'live'], ['F1', 0, 'next'], ['Cricket', 0, 'quiet']],
            'leagues playing now first, each part in the account\'s order (0427, D-43)');
        assert.deepEqual(f.sports[2].next, { gameId: 'espn:racing/f1:1', start: f.games.find(g => g.id === 'espn:racing/f1:1').start });
        assert.deepEqual(f.sports[0].next, { gameId: 'espn:football/nfl:406', start: now + 55 * MIN });
        const byId = Object.fromEntries(f.games.map(g => [g.id, g]));
        assert.equal(byId['espn:football/nfl:401'].followed, true);
        assert.equal(byId['espn:racing/f1:1'].followed, true, 'a followed driver races in every session');
        assert.equal(byId['espn:basketball/nba:1'].followed, false);
        assert.equal(byId['espn:football/nfl:405'].status, 'finished');
        assert.deepEqual(byId['espn:football/nfl:405'].scores, ['27', '20']);
        assert.deepEqual(byId['espn:football/nfl:406'].channels.map(c => [c.start, c.end]), [[now + 50 * MIN, now + 4 * H + 5 * MIN]]);
        assert.equal(f.games.length, 5);
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

// #194 (D-41): Mark saw one game twice, its fixture card and a card made from a guide listing the join could not match.
test('front: a guide listing the join cannot match never becomes a second card of the same game', async () => {
    const now = Date.now();
    const id = 'espn:football/nfl:408';
    removeGame('espn:football/nfl:404'); // the previous test's game
    dashboard.store().ingest([game(id, 'NFL', now - 30 * MIN, [packers, team('3', 'Bears')], live())], now - 100000);
    guideEvents = [{ id: 'ev-gb-odd', league: 'NFL', title: 'NFL Football: Green Bay at Chicago', kind: 'event', start: now - 30 * MIN,
        end: now + 3 * H, live: true, channels: [{ sourceId: 1, id: 'pos_9', stableId: 's9', name: 'ESPN2', quality: 'HD', start: now - 30 * MIN, end: now + 3 * H }] }];
    try {
        const f = await front();
        assert.deepEqual(f.games.filter(g => g.league === 'NFL' && g.status === 'live').map(g => g.id), [id], 'one card: the fixture\'s');
        assert.equal(f.games.some(g => g.id.startsWith('guide:')), false);
        assert.deepEqual(f.games.find(g => g.id === id).channels, [], 'an unmatched airing adds no channel ("No TV listing found")');
    } finally { guideEvents = []; removeGame(id); }
});

// #191 (0386): a live game past its guide slot keeps its channel on the front page, its end rolled on (sportOverrun.js).
test('front: a live game whose only airing ended 30 min ago keeps its channel, overrun, end now + 10 min, and Watch', async () => {
    const now = Date.now();
    const id = 'espn:football/nfl:407';
    dashboard.store().ingest([game(id, 'NFL', now - 3.5 * H, [packers, team('3', 'Bears')], live())], now - 100000);
    const events = load('services/sportsEvents'), asked = [];
    const realEnded = events.endedEvents;
    events.endedEvents = async ({ leagues }) => { asked.push([...leagues].sort()); return [{ id: 'ev-gb-ended', league: 'NFL', title: 'Packers v Bears',
        kind: 'event', start: now - 3.5 * H, end: now - 30 * MIN, live: false,
        channels: [{ sourceId: 1, id: 'pos_3', stableId: 's3', name: 'Fox HD', quality: 'HD', start: now - 3.5 * H, end: now - 30 * MIN }] }]; };
    try {
        const before = Date.now();
        const card = (await front()).games.find(c => c.id === id);
        assert.ok(asked.length && asked[0].includes('NFL'), 'asked for the followed sports\' ended airings');
        assert.equal(card.status, 'live');
        assert.equal(card.canWatch, true);
        assert.equal(card.broadcastStatus, 'on-tv');
        assert.equal(card.channels.length, 1);
        const c = card.channels[0];
        assert.deepEqual([c.stableId, c.start, c.overrun], ['s3', now - 3.5 * H, true]);
        assert.ok(c.end >= before + 10 * MIN && c.end <= Date.now() + 10 * MIN, `end ${c.end - before} ms after the request`);
    } finally { events.endedEvents = realEnded; removeGame(id); }
});

test('front: no fixture games, one guide listing on now: scores unavailable, no card and no hero (#194, D-41)', async () => {
    clearGames();
    const now = Date.now();
    await call('/api/sports/pages/preferences', { sports: ['F1', 'NFL', 'AFL'] });
    guideEvents = [{ id: 'ev-afl', league: 'AFL', title: 'Cats v Swans', kind: 'event', start: now - 30 * MIN, end: now + H, live: true,
        channels: [{ sourceId: 1, id: 'pos_4', stableId: 's4', name: 'Seven', quality: 'HD', start: now - 30 * MIN, end: now + H }] }];
    const f = await front();
    assert.equal(f.scores, 'unavailable');
    assert.deepEqual(f.hero, { reason: 'none', followIndex: null, gameId: null });
    assert.deepEqual(f.rails.find(r => r.league === 'AFL').gameIds, []);
    assert.deepEqual(f.games, []);
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

// #195 (D-41, D-42): an International group shows tournaments in full, and qualifiers and friendlies only for followed
// nations; everything when the account follows none of its nations.
test('front: Internationals: a followed nation narrows qualifiers and friendlies to its own; tournaments stay; none followed shows all', async () => {
    clearGames();
    const now = Date.now();
    sql().prepare('INSERT OR REPLACE INTO sport_fixture_teams (league, data, updated_at) VALUES (?, ?, ?)').run('Internationals',
        JSON.stringify([{ displayName: 'Australia', abbreviation: 'AUS' }, { displayName: 'England' }, { displayName: 'Japan' }]), now);
    dashboard.store().ingest([
        game('espn:soccer/fifa.worldq.afc:1', 'Internationals', now + H, [team('628', 'Australia'), team('627', 'Japan')], scheduled),
        game('espn:soccer/fifa.friendly:2', 'Internationals', now + 2 * H, [team('448', 'England'), team('580', 'Wales')], scheduled),
        game('espn:soccer/fifa.world:3', 'Internationals', now + 3 * H, [team('205', 'Brazil'), team('478', 'France')], scheduled)
    ], now - 100000);
    const ids = async () => (await front()).games.map(g => g.id).sort();
    await call('/api/sports/follows', { sports: [{ sport: 'Football', leagues: ['Internationals'], teams: ['Australia'] }] });
    assert.deepEqual(await ids(), ['espn:soccer/fifa.world:3', 'espn:soccer/fifa.worldq.afc:1'], 'Australia\'s qualifier and the World Cup, not England v Wales');
    await call('/api/sports/follows', { sports: [{ sport: 'Football', leagues: ['Internationals'], teams: ['Arsenal'] }] });
    assert.equal((await ids()).length, 3, 'no followed nation: every game');
    clearGames();
});

test('arrange: between live followed cards the one closest to finishing leads, by its end or the league\'s typical length', () => {
    const { arrange } = load('services/sportFront');
    const now = Date.now();
    const card = (id, league, start, extra) => ({ id, league, start, end: null, status: 'live', followed: true, freshness: 'fresh',
        competitors: [], channels: [], canWatch: true, ...extra });
    const prefs = { spoilerFree: false, sports: [{ sport: 'Cricket', leagues: ['Cricket'], teams: ['Australia'] },
        { sport: 'American football', leagues: ['NFL'], teams: ['Green Bay Packers'] }] };
    const respond = games => ({ now, timezone: 'Etc/GMT', games, followMatches: {
        'espn:cricket/1:1': [{ name: 'Australia', competitor: null }], 'espn:football/nfl:9': [{ name: 'Green Bay Packers', competitor: null }] } });
    const testMatch = card('espn:cricket/1:1', 'Cricket', now - 6 * H, { format: 'test' });
    let f = arrange(respond([testMatch, card('espn:football/nfl:9', 'NFL', now - 3 * H, { end: now + 10 * MIN })]), prefs);
    assert.deepEqual(f.hero, { reason: 'follow-live', followIndex: 1, gameId: 'espn:football/nfl:9' });
    f = arrange(respond([testMatch, card('espn:football/nfl:9', 'NFL', now - 3 * H)]), prefs);
    assert.equal(f.hero.gameId, 'espn:football/nfl:9', 'NFL (3.25 h) before a Test (120 h) without an end on either');
});

test('arrange: a team followed in a sport is one follow across its leagues, and every tile and rail names its sport (#193)', () => {
    const { arrange } = load('services/sportFront');
    const now = Date.now();
    const card = (id, league, start, status) => ({ id, league, start, end: null, status, followed: true, freshness: 'fresh',
        competitors: [{ name: 'Arsenal', logo: '/api/logo/ars' }, { name: 'Other', logo: null }], channels: [], canWatch: false });
    const prefs = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL', 'UEFA'], teams: ['Arsenal'] }] };
    const games = [card('espn:soccer/eng.1:1', 'EPL', now + 5 * H, 'scheduled'), card('espn:soccer/uefa.champions:2', 'UEFA', now + 2 * H, 'scheduled')];
    const followMatches = Object.fromEntries(games.map(g => [g.id, [{ name: 'Arsenal', competitor: 0 }]]));
    const f = arrange({ now, timezone: 'Etc/GMT', games, followMatches }, prefs);
    assert.deepEqual(f.follows, [{ league: 'UEFA', sport: 'Football', name: 'Arsenal', logo: '/api/logo/ars', state: 'next',
        gameId: 'espn:soccer/uefa.champions:2', start: now + 2 * H }], 'one follow, its next game in either league');
    assert.deepEqual(f.sports.map(s => [s.league, s.sport]), [['EPL', 'Football'], ['UEFA', 'Football']]);
    assert.deepEqual(f.rails.map(r => [r.league, r.sport]), [['EPL', 'Football'], ['UEFA', 'Football']]);
    // A league with a game on now moves to the top of the rails (D-41 point 10) and, since 0427 (D-43), of `sports`.
    const onNow = arrange({ now, timezone: 'Etc/GMT', followMatches, games: [games[0], { ...games[1], status: 'live' }] },
        { ...prefs, sports: [{ sport: 'Football', leagues: ['EPL', 'UEFA'], teams: [] }] });
    assert.deepEqual(onNow.rails.map(r => r.league), ['UEFA', 'EPL']);
    assert.deepEqual(onNow.sports.map(r => r.league), ['UEFA', 'EPL']);
    assert.deepEqual(f.hero, { reason: 'follow-next', followIndex: 0, gameId: 'espn:soccer/uefa.champions:2' });
});

test('0427 (D-43 points 3 and 5): sports and follows keep the account\'s order, with what plays now (live, break, suspended, on air) first', () => {
    const { arrange } = load('services/sportFront');
    const now = Date.now();
    const card = (id, league, status, extra) => ({ id, league, start: now - H, end: null, status, followed: true, freshness: 'fresh',
        competitors: [], channels: [], canWatch: false, ...extra });
    const prefs = { spoilerFree: false, sports: [
        { sport: 'Australian football', leagues: ['AFL'], teams: ['Carlton'] },
        { sport: 'Basketball', leagues: ['NBA', 'NBL'], teams: ['Boston Celtics', 'Melbourne United'] },
        { sport: 'Tennis', leagues: ['ATP Tour'], teams: ['Jannik Sinner'] },
        { sport: 'Golf', leagues: ['PGA Tour'], teams: ['Scottie Scheffler'] },
        { sport: 'American football', leagues: ['NFL'], teams: ['Green Bay Packers'] }] };
    const games = [card('espn:afl:1', 'AFL', 'scheduled', { start: now + 5 * H }),
        card('espn:nba:1', 'NBA', 'suspended'), card('espn:nbl:1', 'NBL', 'scheduled', { start: now + 2 * H }),
        card('espn:tennis/atp:1', 'ATP Tour', 'break'), card('espn:golf/pga:1', 'PGA Tour', 'finished'),
        card('espn:nfl:1', 'NFL', 'scheduled', { start: now + 10 * MIN, onAir: true })];
    const followMatches = { 'espn:afl:1': [{ name: 'Carlton', competitor: null }], 'espn:nba:1': [{ name: 'Boston Celtics', competitor: null }],
        'espn:nbl:1': [{ name: 'Melbourne United', competitor: null }], 'espn:tennis/atp:1': [{ name: 'Jannik Sinner', competitor: null }],
        'espn:golf/pga:1': [{ name: 'Scottie Scheffler', competitor: null }], 'espn:nfl:1': [{ name: 'Green Bay Packers', competitor: null }] };
    const f = arrange({ now, timezone: 'Etc/GMT', games, followMatches }, prefs);
    assert.deepEqual(f.sports.map(s => s.league), ['NBA', 'ATP Tour', 'NFL', 'AFL', 'NBL', 'PGA Tour']);
    assert.deepEqual(f.follows.map(x => [x.name, x.state]), [['Boston Celtics', 'live'], ['Jannik Sinner', 'live'], ['Green Bay Packers', 'live'],
        ['Carlton', 'next'], ['Melbourne United', 'next'], ['Scottie Scheffler', 'none']]);
    // The hero's followIndex points into the reordered list: the follow-live card closest to finishing (NFL's, typical 3.25 h).
    assert.equal(f.follows[f.hero.followIndex].gameId, f.hero.gameId);
    // Once it ends, a follow goes back to its place.
    const later = arrange({ now, timezone: 'Etc/GMT', followMatches, games: games.map(g => g.id === 'espn:nba:1' ? { ...g, status: 'finished' } : g) }, prefs);
    assert.deepEqual(later.follows.map(x => x.name).slice(2), ['Carlton', 'Boston Celtics', 'Melbourne United', 'Scottie Scheffler']);
    assert.deepEqual(later.sports.map(s => s.league), ['ATP Tour', 'NFL', 'AFL', 'NBA', 'NBL', 'PGA Tour']);
});

test('#213: a followed cricket nation and AFL club with no card in range carry their ESPN badge (catalogue, then roster)', async () => {
    clearGames();
    const now = Date.now();
    // AFL off-season: no card at all; the league's roster (ESPN /teams, saved by the fixtures refresh) has the badge.
    const afl = require('./fixtures/espn/teams-afl.json');
    const teams = JSON.parse(JSON.stringify(afl));
    for (const e of teams.sports[0].leagues[0].teams) e.team.logos = [{ href: `https://a.espncdn.com/i/teamlogos/afl/500/${e.team.id}.png` }];
    const realFetch = global.fetch;
    global.fetch = async url => String(url).includes('/australian-football/afl/teams')
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => teams } : realFetch(url);
    let roster;
    try { roster = await load('services/sportsFixturesEspn').fetchTeams('australian-football/afl'); } finally { global.fetch = realFetch; }
    assert.equal(roster.ok, true);
    assert.ok(roster.teams.every(t => /^https:\/\/a\.espncdn\.com\//.test(t.logo)), 'the roster keeps each badge');
    const club = roster.teams[0].displayName;
    sql().prepare('INSERT OR REPLACE INTO sport_fixture_teams (league, data, updated_at) VALUES (?, ?, ?)').run('AFL', JSON.stringify(roster.teams), now);
    // Cricket between series: Australia's last match (6 days ago, out of the front page's range) is in the catalogue.
    const { teamsFromScoreboard } = load('services/sportsFixturesEspn');
    const day = Object.values(require('./fixtures/sport-page-cricket/scoreboard-24203.json'))[0];
    const aus = teamsFromScoreboard(day).find(t => t.displayName === 'Australia');
    assert.equal(aus.logo, 'https://a.espncdn.com/i/teamlogos/cricket/500/2.png', 'a cricket scoreboard\'s team keeps its badge');
    dashboard.store().ingest([game('espn:cricket/24203:1', 'Cricket', now - 6 * 24 * H,
        [{ id: '2', name: 'Australia', aliases: ['Australia', 'AUS'], logo: aus.logo }, { id: '3', name: 'South Africa', aliases: ['South Africa'], logo: null }],
        { state: 'finished', progress: {}, scores: null, situation: null })], now - 6 * 24 * H);
    assert.equal((await call('/api/sports/follows', { sports: [{ sport: 'Cricket', leagues: ['Cricket'], teams: ['Australia'] },
        { sport: 'Australian football', leagues: ['AFL'], teams: [club] }] })).status, 200);
    const f = await front();
    const byName = Object.fromEntries(f.follows.map(x => [x.name, x]));
    assert.equal(byName.Australia.state, 'none');
    assert.equal(byName[club].state, 'none');
    for (const name of ['Australia', club]) assert.match(byName[name].logo || '', /^\/api\/logo\/[0-9a-f]{32}$/, `${name} has its badge`);
    const keys = sql().prepare('SELECT url FROM logo_cache WHERE key IN (?, ?)').all(...f.follows.map(x => x.logo.slice(10))).map(r => r.url).sort();
    assert.deepEqual(keys, [aus.logo, roster.teams[0].logo].sort());
    clearGames();
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

// #198 (D-42 point 4): a game's recording rides on its card, flagged when it loses a clash and waits.
test('#198: a recording on the card\'s channel during its airing is on the card; clashesWith only when it waits', () => {
    const { annotateRecordings } = require('../server/services/sportFront');
    const T = Date.parse('2026-11-01T09:00Z'), H = 3600000;
    const cards = [
        { id: 'a', channels: [{ sourceId: 1, id: 'pos_1', stableId: 'ff' }], events: [{ id: 'e1', start: T, end: T + 3 * H }] },
        { id: 'b', channels: [{ sourceId: 1, id: 'm3u_1_pos_2', stableId: null }], events: [{ id: 'e2', start: T, end: T + 2 * H }] },
        { id: 'c', channels: [{ sourceId: 1, id: 'pos_3', stableId: 'abc' }], events: [{ id: 'e3', start: T, end: T + H }] },
        { id: 'd', channels: [], events: [] }];
    const schedules = [
        { id: 1, title: 'Collingwood v Carlton', status: 'waiting', rule_id: 4, source_id: 1, channel_item_id: 'pos_1', channel_stable_id: 'ff',
            program_start: T, program_end: T + 3 * H, beatenBy: [2] },
        { id: 2, title: 'Arsenal v Liverpool', status: 'scheduled', rule_id: null, source_id: 1, channel_item_id: 'pos_2', channel_stable_id: null,
            program_start: T + 30 * 60000, program_end: T + 2 * H, conflictsWith: [1] },
        { id: 3, title: 'Later', status: 'scheduled', rule_id: null, source_id: 1, channel_item_id: 'pos_3', channel_stable_id: 'abc',
            program_start: T + 5 * H, program_end: T + 6 * H }];
    annotateRecordings(cards, schedules);
    assert.deepEqual(cards[0].recording, { scheduleId: 1, status: 'waiting', ruleId: 4, clashesWith: ['Arsenal v Liverpool'] });
    assert.deepEqual(cards[1].recording, { scheduleId: 2, status: 'scheduled', ruleId: null }, 'the winner: no flag');
    assert.equal(cards[2].recording, undefined, 'another time on that channel');
    assert.equal(cards[3].recording, undefined);
});

// 0416 (0415 Codex round 1, medium): a recording between two staggered broadcasts of a game is not the game's.
test('0416: a card\'s recording is matched against each channel\'s own airing, not the span of all of them', () => {
    const { annotateRecordings } = require('../server/services/sportFront');
    const T = Date.parse('2026-11-01T09:00Z'), H = 3600000;
    const card = { id: 'a', channels: [{ sourceId: 1, id: 'pos_1', stableId: 'ff', start: T, end: T + 2 * H },
        { sourceId: 1, id: 'pos_1', stableId: 'ff', start: T + 6 * H, end: T + 8 * H }],
    events: [{ id: 'e1', start: T, end: T + 2 * H }, { id: 'e2', start: T + 6 * H, end: T + 8 * H }] };
    annotateRecordings([card], [{ id: 1, title: 'The News', status: 'scheduled', rule_id: null, source_id: 1, channel_item_id: 'pos_1',
        channel_stable_id: 'ff', program_start: T + 3 * H, program_end: T + 4 * H }]);
    assert.equal(card.recording, undefined);
});
