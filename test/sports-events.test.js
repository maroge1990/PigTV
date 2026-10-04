const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0148 (contract C-I): sport is recognised per programme - (a) an EPG category in the sport
// vocabulary, (b) a followed keyword in the title or a category, (c) a C-H sport category's
// channel with a live-looking title - minus common non-events unless a keyword matches.
// Programmes with the same normalised title at overlapping times are one event; channels
// are ordered by quality, health, favourite, guide order. GET /api/sports/events (any user),
// GET/PUT /api/sports/follow and GET /api/sports/preview (admin), flag sportsEvents.
// The old code has none of it (no flag, and every route is a 404).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
// R09: builds normally run on a worker thread, which has its own copy of the modules. This file
// neutralises sportsClassify.LIVE_HOURS in THIS thread (below), which a worker would not see, so
// it builds inline; the worker path is covered by sports-background-rebuild.test.js and
// sports-worker.test.js.

process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
load('services/sportsEvents')._buildInline(true); // see the R09 note above
const perf = require('./helpers/perf'); // a speed budget: see helpers/perf.js
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

let server, base, adminToken, viewerToken, viewer, source;
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const NOW = Date.now();

// [stream id, name, group, tvg-id]
const PLAYLIST = [
    [301, 'Kayo 1', 'Sport', 'k1'],
    [302, 'Kayo 2 HD', 'Sport', 'k2'],
    [303, 'Seven', 'Entertainment', 'seven'],
    [304, 'Fox Sports 505 SD', 'US Sports', 'fs505'],
    [305, 'ESPN', 'US Sports', 'espn'],
    [306, 'ESPN 2 HD', 'US Sports', 'espn2'],
    [307, 'Sky Sports UHD', 'US Sports', 'sky'],
    [308, 'Hidden HD', 'US Sports', 'hidden'],
    [309, 'Secret', 'Adults', 'secret'],
    [301, 'Kayo 1', 'US Sports', 'k1'] // cross-listed: the same channel again
];
function playlist(channels) {
    return '#EXTM3U\n' + channels.map(([id, name, group, tvg]) =>
        `#EXTINF:-1 tvg-id="${tvg}" group-title="${group}",${name}\nhttp://provider.invalid/live/user/pass/${id}.ts`
    ).join('\n') + '\n';
}

// [tvg-id, title, start offset, end offset, categories]
const GUIDE = [
    // game A on three channels, titled three ways, live now
    ['fs505', 'NFL: Chiefs v Bills', -30 * M, 150 * M, ['Sport', 'American Football']],
    ['espn2', 'LIVE: NFL: Chiefs vs Bills (HD)', -30 * M, 150 * M, ['Sport', 'American Football']],
    ['sky', 'NFL Chiefs v Bills [Sky]', -45 * M, 150 * M, ['Sports', 'Football', 'American Football']],
    // a different game at the same time
    ['espn', 'NBA: Lakers v Celtics', -10 * M, 2 * H, ['Basketball']],
    // the same title again later, not overlapping: another event
    ['espn', 'NBA: Lakers v Celtics', 5 * H, 7 * H, ['Basketball']],
    // C-H: a sport category's channel with a live-looking title, no categories at all
    ['k1', 'Liverpool v Arsenal', -20 * M, 90 * M, []],
    ['k1', 'Fishing Show', 90 * M, 150 * M, []],
    ['seven', 'Liverpool v Arsenal', -20 * M, 90 * M, []],
    // non-events
    ['espn', 'NFL Highlights', 2 * H, 3 * H, ['Sport']],
    // 0150: a replay of an identifiable game (listed by default, after the events)
    ['espn2', 'Classic: Chiefs v Bills 2024', 3 * H, 5 * H, ['Sport', 'American Football']],
    ['fs505', 'Sports Tonight', 150 * M, 4 * H, ['Sport', 'News']],
    // ordering: four channels, two HD
    ['k2', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['espn2', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['seven', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['espn', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    // a keyword only
    ['seven', 'F1: Monaco Grand Prix', 5.5 * H, 7 * H, []],
    // hidden channel and hidden category
    ['hidden', 'Cricket: The Ashes', -1 * H, 5 * H, ['Cricket']],
    ['secret', 'Cricket: The Ashes', -1 * H, 5 * H, ['Cricket']],
    // for the hours window
    ['sky', 'Golf: The Open', 10 * H, 14 * H, ['Golf']],
    ['sky', 'Tennis: The Final', 30 * H, 33 * H, ['Tennis']],
    // 0153: a whole weekend ahead (72 h), and beyond it
    ['sky', 'Darts: World Final', 70 * H, 73 * H, ['Darts']],
    ['sky', 'Snooker: World Final', 80 * H, 83 * H, ['Snooker']]
];

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
// Direct database changes below do not move library_rev, so drop the cached list first.
const events = async (query = '', token = adminToken) => {
    load('services/sportsEvents').reset();
    const r = await call('GET', `/api/sports/events${query}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
const titles = (body) => body.events.map(e => e.title);
// 0150: an event's title is its cleanest form ("Chiefs v Bills"); the raw titles are its aliases.
const find = (body, prefix) => body.events.filter(e => [e.title, ...(e.aliases || [])].some(t => t.startsWith(prefix)));
const follow = (keywords) => call('PUT', '/api/sports/follow', { body: { keywords } });

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    viewerToken = auth.generateToken(viewer);
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(playlist(PLAYLIST));
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }

    const d = sqlite.getDb();
    const ins = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 99, ?, ?, ?, ?)');
    for (const [tvg, title, s, e, cats] of GUIDE) ins.run(tvg, NOW + s, NOW + e, title, cats.length ? JSON.stringify(cats) : null);
    d.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE name = 'Hidden HD'`).run();
    d.prepare(`UPDATE categories SET is_hidden = 1 WHERE name = 'Adults'`).run();
    load('services/sportCategories').setSport(source.id, 'Sport', true);
    // 0152: these tests use the wall clock, so the leagues' live hours (an NBA game "now" is a
    // replay when now is 7 am in New York) are switched off here; test/sports-live.test.js has them.
    const { LIVE_HOURS } = load('services/sportsClassify');
    for (const league of Object.keys(LIVE_HOURS)) delete LIVE_HOURS[league];

    const app = express();
    app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    try { load('services/sportsEvents').shutdown(); } catch { /* never loaded */ }
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('/api/info advertises sportsEvents', async () => {
    assert.equal((await call('GET', '/api/info')).body.features.sportsEvents, true);
});

test('the same game on three channels is one event; a different game at the same time is another', async () => {
    const body = await events();
    assert.ok(body.now <= Date.now() && Date.now() - body.now < 65000, "now is the start of the current minute (the answer is kept per minute)");
    const nfl = find(body, 'NFL');
    assert.equal(nfl.length, 1, JSON.stringify(titles(body)));
    assert.deepEqual(nfl[0].channels.map(c => c.name).sort(), ['ESPN 2 HD', 'Fox Sports 505 SD', 'Sky Sports UHD']);
    assert.equal(nfl[0].title, 'Chiefs v Bills', 'the cleanest form names it (0150)');
    assert.deepEqual([...nfl[0].aliases].sort(), ['LIVE: NFL: Chiefs vs Bills (HD)', 'NFL Chiefs v Bills [Sky]', 'NFL: Chiefs v Bills']);
    assert.equal(nfl[0].kind, 'event');
    assert.equal(nfl[0].start, NOW - 45 * M);
    assert.equal(nfl[0].end, NOW + 150 * M);
    assert.equal(nfl[0].live, true);
    assert.equal(nfl[0].league, 'American Football', 'the most specific category');
    assert.match(nfl[0].id, /^[0-9a-f]{16}$/);
    const nba = find(body, 'NBA');
    assert.equal(nba.length, 2, 'the later, non-overlapping airing is its own item');
    assert.deepEqual(nba.map(e => e.live), [true, false]);
    assert.deepEqual(nba.map(e => e.kind), ['event', 'replay'], '0152: the same game 5 h later is a replay of the first airing');
});

test('(a) an EPG category in the sport vocabulary makes a programme sport', async () => {
    const body = await events('?hours=24');
    assert.equal(find(body, 'Rugby').length, 1);
    assert.equal(find(body, 'Rugby')[0].league, 'Rugby Union');
    assert.equal(find(body, 'Golf')[0].league, 'Golf');
});

test('(c) a C-H sport category channel with a live-looking title is sport; the same title elsewhere is not', async () => {
    const body = await events();
    const game = find(body, 'Liverpool');
    assert.equal(game.length, 1);
    assert.deepEqual(game[0].channels.map(c => c.name), ['Kayo 1'], 'once, though cross-listed; not Seven (not a sport category)');
    assert.equal(game[0].league, 'Sport');
    assert.equal(find(body, 'Fishing').length, 0, 'a sport channel\'s programme that does not read like an event');
});

test('non-events are excluded; hidden channels and categories never count', async () => {
    const body = await events('?hours=24');
    assert.equal(find(body, 'NFL Highlights').length, 0);
    assert.equal(find(body, 'Sports Tonight').length, 0, 'a News category');
    assert.equal(find(body, 'Cricket').length, 0);
    assert.equal(find(body, 'F1').length, 0, 'no category and not followed yet');
});

test('(b) a followed keyword makes a programme sport and names the league; highlights stay a show', async () => {
    assert.equal((await follow(['F1', 'NFL'])).status, 200);
    try {
        const body = await events('?hours=24');
        assert.equal(find(body, 'F1')[0].league, 'F1');
        assert.equal(find(body, 'F1')[0].title, 'Monaco Grand Prix');
        assert.equal(find(body, 'NFL Highlights').length, 0, 'NFL is followed, but highlights are a show (0150)');
        const all = await events('?hours=24&include=all');
        assert.deepEqual(find(all, 'NFL Highlights').map(e => [e.kind, e.league]), [['show', 'NFL']]);
        assert.equal(find(body, 'NFL Chiefs')[0].league, 'NFL', 'the keyword beats the category');
    } finally {
        await follow([]);
    }
    assert.equal(find(await events('?hours=24'), 'F1').length, 0, 'unfollowed again');
});

test('channels are ordered by quality, then health ok, then favourite, then guide order', async () => {
    const body = await events();
    assert.deepEqual(find(body, 'NFL')[0].channels.map(c => c.quality), ['UHD', 'HD', 'SD']);
    const nflSky = find(body, 'NFL')[0].channels[0];
    assert.deepEqual(Object.keys(nflSky).sort(), ['id', 'logo', 'name', 'number', 'quality', 'sourceId', 'stableId']);
    assert.equal(nflSky.sourceId, source.id);
    assert.equal(typeof nflSky.number, 'number');

    const rugby = async (token) => find(await events('?hours=24', token), 'Rugby')[0].channels.map(c => c.name);
    // Guide order alone: Kayo 2 HD before ESPN 2 HD, Seven before ESPN.
    assert.deepEqual(await rugby(), ['Kayo 2 HD', 'ESPN 2 HD', 'Seven', 'ESPN']);

    // A good start on ESPN 2 HD puts it ahead of the other HD channel.
    const d = sqlite.getDb();
    const espn2 = d.prepare(`SELECT stable_id FROM playlist_items WHERE name = 'ESPN 2 HD'`).get().stable_id;
    d.prepare('INSERT INTO channel_health (source_id, channel_key, name, at, ok) VALUES (?, ?, ?, ?, 1)').run(source.id, espn2, 'ESPN 2 HD', Date.now());
    load('services/channelHealth').reset();
    assert.deepEqual(await rugby(), ['ESPN 2 HD', 'Kayo 2 HD', 'Seven', 'ESPN']);

    // The viewer's favourite ESPN goes ahead of Seven for the viewer only.
    const espn = d.prepare(`SELECT item_id, stable_id FROM playlist_items WHERE name = 'ESPN'`).get();
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, ?, ?, 'channel', ?)`)
        .run(String(viewer.id), source.id, espn.item_id, espn.stable_id);
    assert.deepEqual(await rugby(viewerToken), ['ESPN 2 HD', 'Kayo 2 HD', 'ESPN', 'Seven']);
    assert.deepEqual(await rugby(), ['ESPN 2 HD', 'Kayo 2 HD', 'Seven', 'ESPN']);
});

test('events are live first, then upcoming, each by start; then replays', async () => {
    const body = await events('?hours=24');
    const kinds = body.events.map(e => e.kind);
    assert.deepEqual([...new Set(kinds)], ['event', 'replay'], 'events, then replays (0150)');
    const list = body.events.filter(e => e.kind === 'event');
    const live = list.filter(e => e.live);
    assert.ok(live.length >= 3);
    assert.ok(list.slice(0, live.length).every(e => e.live), 'live ones first');
    for (let i = 1; i < list.length; i++) {
        const [a, b] = [list[i - 1], list[i]];
        if (a.live === b.live) assert.ok(a.start <= b.start, `${a.title} before ${b.title}`);
    }
});

test('0150: replays are listed by default with kind "replay"; shows and placeholders only with include=all', async () => {
    const body = await events('?hours=24');
    const replay = find(body, 'Classic: Chiefs');
    assert.deepEqual(replay.map(e => [e.kind, e.title]), [['replay', 'Chiefs v Bills']], 'not merged into the live game');
    assert.equal(find(body, 'NFL: Chiefs')[0].kind, 'event');
    assert.ok(body.events.every(e => e.kind === 'event' || e.kind === 'replay'));
    assert.equal(find(body, 'NFL Highlights').length, 0);
    assert.equal(find(body, 'Sports Tonight').length, 0);

    const all = await events('?hours=24&include=all');
    assert.deepEqual(find(all, 'NFL Highlights').map(e => e.kind), ['show']);
    assert.deepEqual(find(all, 'Sports Tonight').map(e => e.kind), ['show']);
    assert.ok(all.events.length > body.events.length);
    const order = { event: 0, replay: 1, show: 2, placeholder: 3 };
    assert.ok(all.events.every((e, i) => i === 0 || order[all.events[i - 1].kind] <= order[e.kind]), 'grouped by kind');
    assert.ok(!('kindRule' in all.events[0]), 'the rule is for the admin preview');
});

test('hours defaults to 6 and is clamped to 1-72 (0153: a whole weekend; was 24)', async () => {
    assert.equal(find(await events(), 'Golf').length, 0, 'starts in 10 h');
    assert.equal(find(await events('?hours=12'), 'Golf').length, 1);
    const day = await events('?hours=24');
    assert.equal(find(day, 'Tennis').length, 0, '30 h away is beyond 24');
    const all = await events('?hours=99');
    assert.equal(find(all, 'Golf').length, 1, '99 is 72');
    assert.equal(find(all, 'Tennis').length, 1, '30 h away is within 72');
    assert.equal(find(all, 'Darts').length, 1, '70 h away is within 72');
    assert.equal(find(all, 'Snooker').length, 0, '80 h away is beyond 72');
    assert.equal(find(await events('?hours=72'), 'Darts').length, 1);
    const one = await events('?hours=0');
    assert.equal(find(one, 'Rugby').length, 0, '0 is 1 hour: the rugby starts in 3');
    assert.ok(one.events.length >= 3 && one.events.every(e => e.live || e.start < Date.now() + H));
    assert.equal(find(await events('?hours=abc'), 'NBA').length, 2, 'not a number: the default 6 (the second NBA starts in 5 h)');
});

test('0185: a followed team ("NFL: Arizona Cardinals") follows its games by full name, or by a short name inside its league', async () => {
    const ev = load('services/sportsEvents');
    const roster = [
        { displayName: 'Arizona Cardinals', shortDisplayName: 'Cardinals', name: 'Cardinals', location: 'Arizona', abbreviation: 'ARI' },
        { displayName: 'Seattle Seahawks', shortDisplayName: 'Seahawks', name: 'Seahawks', location: 'Seattle', abbreviation: 'SEA' },
        { displayName: 'New York Giants', shortDisplayName: 'Giants', name: 'Giants', location: 'New York', abbreviation: 'NYG' },
        { displayName: 'New York Jets', shortDisplayName: 'Jets', name: 'Jets', location: 'New York', abbreviation: 'NYJ' }
    ];
    sqlite.getDb().prepare('INSERT OR REPLACE INTO sport_fixture_teams (league, data, updated_at) VALUES (?, ?, ?)').run('NFL', JSON.stringify(roster), Date.now());
    const follow = ev.compileFollow(['NFL: Arizona Cardinals', 'nfl: New York Jets']);
    const hit = (title, categories = []) => ev.classify({ title, categories }, follow);
    assert.deepEqual(hit('Arizona Cardinals at Seattle Seahawks'), { rule: 'keyword', match: 'NFL: Arizona Cardinals', league: 'NFL' }, 'the full name needs no league');
    assert.equal(hit('NFL: Cardinals @ Seahawks').match, 'NFL: Arizona Cardinals', 'the nickname, in an NFL programme');
    assert.equal(hit('Arizona at Seattle', ['NFL']).match, 'NFL: Arizona Cardinals', 'the place, when one team has it');
    assert.equal(hit('MLB: St. Louis Cardinals at Chicago Cubs'), null, 'another league\'s Cardinals');
    assert.equal(hit('Cardinals in the Vatican'), null, 'the nickname alone, outside the league');
    assert.equal(hit('NFL: Seahawks @ 49ers'), null, 'another NFL game is not followed');
    assert.equal(hit('NFL: New York at Dallas'), null, 'a place two teams share names neither');
    assert.equal(hit('NFL: Jets @ Bills').match, 'nfl: New York Jets');
    // With no roster yet, the name as written still works.
    const bare = ev.compileFollow(['EPL: Arsenal']);
    assert.equal(ev.classify({ title: 'Premier League: Arsenal v Leeds United', categories: [] }, bare).league, 'EPL');
    // The team's league gets its fixtures fetched, and the team list is served to the admin.
    await call('PUT', '/api/sports/follow', { body: { keywords: ['NFL: Arizona Cardinals'] } });
    assert.deepEqual([...load('services/sportsFixtures').neededLeagues()], ['NFL']);
    const teams = await call('GET', '/api/sports/teams?league=nfl');
    assert.deepEqual(teams.body, { league: 'NFL', teams: ['Arizona Cardinals', 'New York Giants', 'New York Jets', 'Seattle Seahawks'] });
    assert.equal((await call('GET', '/api/sports/teams?league=Quidditch')).status, 400);
    assert.equal((await call('GET', '/api/sports/teams?league=NFL', { token: viewerToken })).status, 403);
    await call('PUT', '/api/sports/follow', { body: { keywords: [] } });
    sqlite.getDb().prepare('DELETE FROM sport_fixture_teams').run();
});

test('the follow list: admin only, trimmed and de-duplicated, at most 100', async () => {
    const saved = await follow([' NFL ', 'nfl', 'Chiefs', '', '  AFL  ']);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { keywords: ['NFL', 'Chiefs', 'AFL'] });
    const read = (await call('GET', '/api/sports/follow')).body;
    assert.deepEqual(read.keywords, ['NFL', 'Chiefs', 'AFL']);
    // 0185: with the leagues the Sports tab offers, and whether each has real fixture times
    assert.deepEqual(read.leagues.find(l => l.name === 'EPL'), { name: 'EPL', fixtures: true, teams: true });
    assert.deepEqual(read.leagues.find(l => l.name === 'MotoGP'), { name: 'MotoGP', fixtures: false, teams: false });
    assert.deepEqual(read.leagues.find(l => l.name === 'Cricket'), { name: 'Cricket', fixtures: true, teams: false });
    assert.deepEqual(read.leagues.find(l => l.name === 'F1'), { name: 'F1', fixtures: true, teams: false });
    assert.equal((await call('PUT', '/api/sports/follow', { body: { keywords: 'NFL' } })).status, 400);
    assert.equal((await call('PUT', '/api/sports/follow', { body: { keywords: [3] } })).status, 400);
    assert.equal((await follow(Array.from({ length: 101 }, (_, i) => `k${i}`))).status, 400);
    assert.equal((await follow(Array.from({ length: 100 }, (_, i) => `k${i}`))).status, 200);
    assert.equal((await call('GET', '/api/sports/follow', { token: viewerToken })).status, 403);
    assert.equal((await call('PUT', '/api/sports/follow', { token: viewerToken, body: { keywords: [] } })).status, 403);
    await follow([]);
    assert.deepEqual((await call('GET', '/api/sports/follow')).body.keywords, []);
});

test('the preview is admin only and says which rule matched', async () => {
    await follow(['F1']);
    try {
        const { status, body } = await call('GET', '/api/sports/preview');
        assert.equal(status, 200);
        const rule = (prefix) => { const e = find(body, prefix)[0]; return e && [e.rule, e.match]; };
        assert.deepEqual(rule('F1'), ['keyword', 'F1']);
        assert.deepEqual(rule('Rugby'), ['category', 'Sport']);
        assert.deepEqual(rule('Liverpool'), ['sportChannel', 'Sport category + live title']);
        assert.equal(find(body, 'Golf').length, 1, 'the next 72 hours (0153)');
        assert.equal(find(body, 'Darts').length, 1, 'the whole weekend');
        assert.equal(find(body, 'Snooker').length, 0);
        // 0150: every kind, with why
        assert.equal(find(body, 'F1')[0].kindRule, 'event: a session (Race)');
        assert.deepEqual(find(body, 'NFL Highlights').map(e => [e.kind, e.kindRule]), [['show', 'show: highlights ("highlights")']]);
        assert.equal(find(body, 'Classic: Chiefs')[0].kindRule, 'replay: a game with "classic"');
    } finally {
        await follow([]);
    }
    assert.equal((await call('GET', '/api/sports/preview', { token: viewerToken })).status, 403);
});

test('events are for any signed-in user or device, not anonymous callers', async () => {
    assert.equal((await call('GET', '/api/sports/events', { token: viewerToken })).status, 200);
    assert.equal((await call('GET', '/api/sports/events', { token: null })).status, 401);
});

test('the list is built once per 5 minutes (0153; a minute before) and guide version, not per request', async () => {
    const svc = load('services/sportsEvents');
    svc.reset();
    await call('GET', '/api/sports/events');
    const builds = svc.stats.builds;
    await call('GET', '/api/sports/events?hours=24');
    await call('GET', '/api/sports/events', { token: viewerToken });
    assert.equal(svc.stats.builds, builds, 'served from the cache');
    await follow(['Chiefs']);
    await call('GET', '/api/sports/events');
    assert.equal(svc.stats.builds, builds + 1, 'a new follow list rebuilds it');
    await follow([]);
});

test('normalisation: case, live, channel tags, quality markers, punctuation and vs', () => {
    const { normaliseTitle } = load('services/sportsEvents');
    assert.equal(normaliseTitle('LIVE: NFL: Chiefs vs. Bills (HD)'), 'nfl chiefs v bills');
    assert.equal(normaliseTitle('NFL - Chiefs v Bills [Kayo] 4K'), 'nfl chiefs v bills');
    assert.equal(normaliseTitle('ESPN: NFL Chiefs v Bills (Live)', 'ESPN HD'), 'nfl chiefs v bills', 'the channel\'s own name');
    assert.equal(normaliseTitle('Liverpool UHD'), 'liverpool');
    assert.equal(normaliseTitle('Deliverance'), 'deliverance', 'only whole words');
});

test('quality comes from the channel name', () => {
    const { qualityFromName } = load('services/sportsEvents');
    assert.deepEqual(['Sky Sports UHD', 'ESPN 4K', 'Fox 505 FHD', 'Kayo HD', 'ESPN SD', 'ESPN', 'HDTV'].map(qualityFromName),
        ['UHD', 'UHD', 'HD', 'HD', 'SD', null, null]);
});

// C-I asks for a request under ~100 ms warm on 1,000 channels x 30 programmes. Measured, and
// printed; the bounds asserted here are loose because CI runs every file at once on 2 vCPUs.
test('1,000 channels x 30 programmes: built once, then served from the cache', perf, async () => {
    const d = sqlite.getDb();
    const svc = load('services/sportsEvents');
    const insItem = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
                               VALUES (?, 500, ?, 'live', ?, 'Bulk', ?, ?, ?, 0)`);
    const insProg = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 500, ?, ?, ?, ?)');
    const cats = ['["Sport","Football"]', '["Movie"]', '["News"]', '["Sport","Tennis"]', null];
    d.transaction(() => {
        for (let c = 0; c < 1000; c++) {
            insItem.run(`500:b${c}`, `b${c}`, `Bulk ${c}${c % 3 === 0 ? ' HD' : ''}`, c, `sb${c}`, `bulk${c}`);
            for (let p = 0; p < 30; p++) {
                const start = NOW - 2 * H + p * H;
                insProg.run(`bulk${c}`, start, start + H, `Programme ${(c * 7 + p) % 400} v Team ${p % 11}`, cats[(c + p) % cats.length]);
            }
        }
    })();
    try {
        svc.reset();
        const t0 = performance.now();
        const cold = await call('GET', '/api/sports/events?hours=24');
        const coldMs = performance.now() - t0;
        const builds = svc.stats.builds;
        const warm = [];
        for (let i = 0; i < 5; i++) {
            const t = performance.now();
            await call('GET', '/api/sports/events?hours=24');
            warm.push(performance.now() - t);
        }
        warm.sort((a, b) => a - b);
        console.log(`# sports events, 1,000 channels x 30 programmes: ${cold.body.events.length} events; cold ${coldMs.toFixed(0)} ms (build ${svc.stats.lastBuildMs.toFixed(0)} ms), warm median ${warm[2].toFixed(1)} ms`);
        assert.equal(svc.stats.builds, builds, 'warm requests do not rebuild');
        assert.ok(cold.body.events.length > 100);
        assert.ok(warm[2] < 1000, `warm median ${warm[2]} ms`);
    } finally {
        d.prepare('DELETE FROM playlist_items WHERE source_id = 500').run();
        d.prepare('DELETE FROM epg_programs WHERE source_id = 500').run();
        svc.reset();
    }
});

// 0153: the build covers 72 h ahead (a whole weekend) and, since 0152, reads the 36 h before now.
// The same 1,000 channels with hourly programmes over that whole span: 108 per channel.
test('1,000 channels x 108 hours (36 h back, 72 h ahead): built once, then served from the cache', perf, async () => {
    const d = sqlite.getDb();
    const svc = load('services/sportsEvents');
    const insItem = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
                               VALUES (?, 501, ?, 'live', ?, 'Bulk', ?, ?, ?, 0)`);
    const insProg = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 501, ?, ?, ?, ?)');
    const cats = ['["Sport","Football"]', '["Movie"]', '["News"]', '["Sport","Tennis"]', null];
    d.transaction(() => {
        for (let c = 0; c < 1000; c++) {
            insItem.run(`501:w${c}`, `w${c}`, `Weekend ${c}${c % 3 === 0 ? ' HD' : ''}`, c, `sw${c}`, `wknd${c}`);
            for (let p = 0; p < 108; p++) {
                const start = NOW - 36 * H + p * H;
                insProg.run(`wknd${c}`, start, start + H, `Programme ${(c * 7 + p) % 400} v Team ${p % 11}`, cats[(c + p) % cats.length]);
            }
        }
    })();
    try {
        svc.reset();
        const t0 = performance.now();
        const cold = await call('GET', '/api/sports/events?hours=72');
        const coldMs = performance.now() - t0;
        const builds = svc.stats.builds;
        const warm = [];
        for (let i = 0; i < 5; i++) {
            const t = performance.now();
            await call('GET', '/api/sports/events?hours=72');
            warm.push(performance.now() - t);
        }
        warm.sort((a, b) => a - b);
        console.log(`# sports events, 1,000 channels x 108 hours: ${cold.body.events.length} events; cold ${coldMs.toFixed(0)} ms (build ${svc.stats.lastBuildMs.toFixed(0)} ms), warm median ${warm[2].toFixed(1)} ms`);
        assert.equal(svc.stats.builds, builds, 'warm requests do not rebuild');
        assert.ok(cold.body.events.every(e => e.end > cold.body.now && e.start < cold.body.now + 72 * H), 'nothing past or beyond 72 h');
        assert.ok(cold.body.events.some(e => e.start > cold.body.now + 60 * H), 'the third day is in');
        assert.ok(warm[2] < 2000, `warm median ${warm[2]} ms`);
    } finally {
        d.prepare('DELETE FROM playlist_items WHERE source_id = 501').run();
        d.prepare('DELETE FROM epg_programs WHERE source_id = 501').run();
        svc.reset();
    }
});

test('a sync logs how far ahead the guide reaches, and says when it is less than 72 h', () => {
    const { epgCoverageLine } = sync;
    const now = Date.parse('2026-09-25T00:00:00Z');
    assert.equal(epgCoverageLine(now + 96 * H, now), '[Sync] EPG covers until 2026-09-29T00:00:00.000Z, 96 h ahead');
    assert.equal(epgCoverageLine(now + 48 * H, now),
        '[Sync] EPG covers until 2026-09-27T00:00:00.000Z, 48 h ahead (less than the 72 h the Sport list looks ahead)');
    assert.equal(epgCoverageLine(0, now), '[Sync] EPG coverage: no programme has an end time');
});

test('0153: one build serves 5 minutes, and still covers the full 72 h at the end of them', async () => {
    const svc = load('services/sportsEvents');
    const bucket = Math.floor(NOW / (5 * M)) * 5 * M + 10 * 5 * M; // a bucket boundary in the future
    const late = bucket + 5 * M - 1000;
    // starts 72 h after the late request, less 2 minutes: beyond 72 h of the build's own start
    const d = sqlite.getDb();
    d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 99, ?, ?, ?, ?)')
        .run('sky', late + 72 * H - 2 * M, late + 73 * H, 'Bowls: World Final', '["Bowls"]');
    try {
        svc.reset();
        assert.equal((await svc.eventsFor({ now: bucket, hours: 72 })).events.filter(e => e.aliases.includes('Bowls: World Final')).length, 0,
            'the first request: beyond its 72 h');
        const builds = svc.stats.builds;
        const { events: list } = await svc.eventsFor({ now: late, hours: 72 });
        assert.equal(svc.stats.builds, builds, 'no rebuild within the 5 minutes');
        assert.equal(list.filter(e => e.aliases.includes('Bowls: World Final')).length, 1, 'the late request still sees its whole 72 h');
        // R09: the next bucket is stale when asked: the request is served the old result at once
        // and the rebuild runs on the worker
        await svc.eventsFor({ now: bucket + 5 * M, hours: 72 });
        await svc.idle();
        assert.equal(svc.stats.builds, builds + 1, 'the next bucket rebuilds');
    } finally {
        d.prepare(`DELETE FROM epg_programs WHERE title = 'Bowls: World Final'`).run();
        svc.reset();
    }
});

// The answer is kept per minute and carries an ETag: a client that sends If-None-Match gets a 304
// while nothing changed; one that does not (the Apple client today) gets the 200 it always did.
test('/events: ETag and 304 when unchanged; no If-None-Match is a plain 200; the same bytes either way', async () => {
    const svc = load('services/sportsEvents');
    svc.reset();
    sqlite.getDb().prepare('DELETE FROM favorites').run(); // earlier tests leave the viewer a favourite
    // the answer is per minute: do not straddle a minute boundary
    if (60000 - (Date.now() % 60000) < 4000) await new Promise(r => setTimeout(r, 4100));
    // node:http, not fetch: fetch adds `Cache-Control: no-cache` to a conditional request, which is
    // (correctly) never answered with a 304; URLSession and the browsers do not
    const get = (headers = {}, token = adminToken) => new Promise((resolve, reject) => {
        require('node:http').get(`${base}/api/sports/events?hours=72`, { headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: { get: (n) => res.headers[n.toLowerCase()] ?? null }, text: async () => Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
    const first = await get({ 'Accept-Encoding': 'identity' });
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag, /^W\/"/);
    const text = await first.text();
    assert.ok(JSON.parse(text).events.length > 0);
    assert.match(first.headers.get('content-type'), /application\/json/);

    const plain = await get({ 'Accept-Encoding': 'identity' });
    assert.equal(plain.status, 200, 'no If-None-Match: a full answer');
    assert.equal(await plain.text(), text, 'the same bytes');

    const same = await get({ 'If-None-Match': etag });
    assert.equal(same.status, 304);
    assert.equal(await same.text(), '');
    assert.equal((await get({ 'If-None-Match': '"something else"' })).status, 200);

    // two users with the same (no) favourites have the same answer, so the same ETag; a favourite
    // added changes this user's
    const other = await get({ 'If-None-Match': etag }, viewerToken);
    assert.equal(other.status, 304);
    const d = sqlite.getDb();
    const espn = d.prepare(`SELECT item_id, stable_id FROM playlist_items WHERE name = 'ESPN'`).get();
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, ?, ?, 'channel', ?)`)
        .run(String(viewer.id), source.id, espn.item_id, espn.stable_id);
    try {
        const changed = await get({ 'If-None-Match': etag }, viewerToken);
        assert.equal(changed.status, 200, 'a favourite changed the answer');
        assert.notEqual(changed.headers.get('etag'), etag);
    } finally {
        d.prepare('DELETE FROM favorites WHERE user_id = ?').run(String(viewer.id));
    }

    // a client that takes gzip gets the same JSON compressed (once, then kept)
    const zipped = await fetch(`${base}/api/sports/events?hours=72`, { headers: { Authorization: `Bearer ${adminToken}`, 'Accept-Encoding': 'gzip' } });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.equal(await zipped.text(), text);
});
