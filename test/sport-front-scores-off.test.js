const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// 0503 (D-54): with the score collector off (PIGTV_SPORTS_DASHBOARD=0, or ESPN fixtures off with PIGTV_SPORT_FIXTURES=0)
// GET /api/sports/front still answers, in its usual shape, with the account's follows and leagues: it never reads the
// collector's (possibly frozen) catalogue and never makes an outbound request. /api/info's features.sportFront still
// reports whether scores are collected. With fixtures off there is no game card. #282: with fixtures on, every game of
// the schedule read (sport_fixtures) is a card drawn like a future game, with the guide's channels and no score.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-front-off-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-sport-front-off-key-at-least-32-chars';
process.env.PIGTV_DB_BACKUPS = '0';
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
const H = 3600000;
const auth = load('auth'), db = load('db'), dashboard = load('services/sportsDashboard');
let server, base, token, guideEvents = [];
const outbound = [], realFetch = globalThis.fetch;

before(async () => {
    // Every request that leaves this machine is recorded and refused (ESPN's scores and fixtures go through fetch).
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url instanceof Request ? url.url : url));
        if (u.hostname !== '127.0.0.1') { outbound.push(u.href); throw new Error('no network in this test'); }
        return realFetch(url, opts);
    };
    token = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    load('services/sportsEvents').eventsResponse = async () => ({ body: Buffer.from(JSON.stringify({ events: guideEvents })) });
    load('db/recordingsDb').initSchema();
    const app = express(); app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    globalThis.fetch = realFetch;
    dashboard.stop();
    load('services/sportsEvents').shutdown();
    if (server?.listening) await new Promise(r => server.close(r));
    load('db/sqlite').getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
    delete process.env.PIGTV_SPORTS_DASHBOARD;
    delete process.env.PIGTV_SPORT_FIXTURES;
});
async function call(url, body) {
    const r = await fetch(base + url, { method: body ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
}
const ID = 'espn:football/nfl:900';
const KEYS = ['now', 'timezone', 'spoilerFree', 'scores', 'sports', 'follows', 'hero', 'rails', 'games'];

async function scoresOffFront(label, { rails = [] } = {}) {
    dashboard.start(); // as the server's start-up does: with the collector off it must start nothing
    const r = await call('/api/sports/front');
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    const f = r.body;
    assert.deepEqual(Object.keys(f).sort(), [...KEYS].sort(), `${label}: the usual shape`);
    assert.equal(f.scores, 'unavailable');
    assert.deepEqual(f.games, [], `${label}: no card, so the frozen catalogue's final (and its score) is not served`);
    assert.deepEqual(f.rails, rails);
    assert.deepEqual(f.hero, { reason: 'none', followIndex: null, gameId: null });
    assert.deepEqual(f.sports.map(s => [s.league, s.live, s.next, s.line]), [['NFL', 0, null, 'quiet']]);
    assert.equal(typeof f.sports[0].sport, 'string');
    assert.deepEqual(f.follows.map(x => [x.league, x.name, x.state, x.gameId, x.start]), [['NFL', 'Green Bay Packers', 'none', null, null]]);
    assert.ok(!JSON.stringify(f).includes('"scores":['), `${label}: no score anywhere`);
    assert.equal((await call('/api/info')).body.features.sportFront, false, `${label}: features.sportFront still reports scores off`);
    assert.equal(dashboard.cadence().why, 'off');
    assert.deepEqual(outbound, [], `${label}: no outbound request`);
}

test('front with scores off: 200, follows and leagues, no cards, no frozen score, no network; collector on is unchanged', async () => {
    // What a household that had the collector on before has: a followed team and a final with its score from today.
    assert.equal((await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } })).status, 200);
    const now = Date.now();
    const final = { id: ID, league: 'NFL', title: 'Packers v Lions', start: now - 4 * H, end: null, session: null, circuit: null,
        competitors: [{ id: '9', name: 'Packers', aliases: ['Green Bay Packers', 'Packers'], logo: null }, { id: '8', name: 'Lions', aliases: ['Lions'], logo: null }] };
    dashboard.store().ingest([{ ...final, snapshot: { state: 'live', progress: {}, scores: ['7', '3'], situation: null } }], now - 3 * H);
    dashboard.store().ingest([{ ...final, snapshot: { state: 'finished', progress: {}, scores: ['24', '17'], situation: null } }], now - H);

    // Collector on: unchanged (the stored final is a card with its result).
    const on = await call('/api/sports/front');
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.games.find(g => g.id === ID)?.scores, ['24', '17']);
    assert.equal((await call('/api/info')).body.features.sportFront, true);

    process.env.PIGTV_SPORTS_DASHBOARD = '0'; // (a) scores off, fixtures on, nothing in the schedule yet
    await scoresOffFront('scores off', { rails: [{ league: 'NFL', sport: 'American football', gameIds: [] }] });
    // Follow settings still save with scores off.
    assert.equal((await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } })).status, 200);
    assert.equal((await call('/api/sports/follows')).status, 200);

    delete process.env.PIGTV_SPORTS_DASHBOARD;
    process.env.PIGTV_SPORT_FIXTURES = '0'; // (b) ESPN fixtures off
    await scoresOffFront('fixtures off');
    delete process.env.PIGTV_SPORT_FIXTURES;
});

// #282: what the schedule read stores (sportsFixtures.refreshAll with the collector off), from ESPN's scoreboard: a game in
// play (its score and clock are not kept), one later today, one that ended this morning.
const team = (id, name, abbr) => ({ id, displayName: name, shortDisplayName: name.split(' ').pop(), name: name.split(' ').pop(),
    location: name.split(' ').slice(0, -1).join(' '), abbreviation: abbr, logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr}.png` });
const comp = (id, start, home, away, extra = {}) => ({ id, date: new Date(start).toISOString(), competitors: [
    { homeAway: 'home', team: home, ...(extra.scores ? { score: extra.scores[0] } : {}) },
    { homeAway: 'away', team: away, ...(extra.scores ? { score: extra.scores[1] } : {}) }], ...(extra.status ? { status: extra.status } : {}) });
const GB = team('9', 'Green Bay Packers', 'GB'), DET = team('8', 'Detroit Lions', 'DET'), KC = team('12', 'Kansas City Chiefs', 'KC'),
    BUF = team('2', 'Buffalo Bills', 'BUF'), CHI = team('3', 'Chicago Bears', 'CHI'), MIN = team('16', 'Minnesota Vikings', 'MIN');
async function storeSchedule(now) {
    const board = { events: [
        { id: '501', name: 'Lions at Packers', competitions: [comp('501', now - H, GB, DET, { scores: ['14', '10'],
            status: { displayClock: '6:52', period: 2, type: { state: 'in', name: 'STATUS_IN_PROGRESS' } } })] },
        { id: '502', name: 'Bills at Chiefs', competitions: [comp('502', now + 2 * H, KC, BUF)] },
        { id: '503', name: 'Vikings at Bears', competitions: [comp('503', now - 10 * H, CHI, MIN, { scores: ['20', '17'],
            status: { type: { state: 'post', name: 'STATUS_FINAL', completed: true } } })] }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/football/nfl/scoreboard')) return new Response(u.search.includes(new Date(now).toISOString().slice(0, 10).replace(/-/g, ''))
            ? JSON.stringify(board) : JSON.stringify({ events: [] }), { status: 200 });
        return new Response(JSON.stringify({ sports: [] }), { status: 200 });
    };
    try { await load('services/sportsFixtures').refreshAll(now); } finally { globalThis.fetch = realFetch; }
}

test('#282: scores off, fixtures on: the schedule read\'s games are future-style cards with the guide\'s channels, no score, no request', async () => {
    const now = Date.now();
    const MIN_ = 60000;
    process.env.PIGTV_SPORTS_DASHBOARD = '0';
    try {
        assert.equal((await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } })).status, 200);
        await storeSchedule(now);
        guideEvents = [
            { id: 'ev-gb', league: 'NFL', title: 'Packers v Lions', kind: 'event', start: now - H - 5 * MIN_, end: now + 2 * H, live: true,
                channels: [{ sourceId: 1, id: 'pos_5', stableId: 's5', name: 'Fox HD', quality: 'HD', start: now - H - 5 * MIN_, end: now + 2 * H }] },
            { id: 'ev-kc', league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: now + 2 * H - 5 * MIN_, end: now + 5 * H, live: false,
                channels: [{ sourceId: 1, id: 'pos_6', stableId: 's6', name: 'ESPN HD', quality: 'HD', start: now + 2 * H - 5 * MIN_, end: now + 5 * H }] },
            // D-41: a guide listing with no game in the schedule never becomes a card
            { id: 'ev-guide', league: 'NFL', title: 'Cowboys v Giants', kind: 'event', start: now + 3 * H, end: now + 6 * H, live: false,
                channels: [{ sourceId: 1, id: 'pos_7', stableId: 's7', name: 'NFL Network', quality: 'HD', start: now + 3 * H, end: now + 6 * H }] }
        ];
        outbound.length = 0;
        dashboard.start(); // with the collector off it must start nothing
        const r = await call('/api/sports/front');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const f = r.body;
        assert.deepEqual(Object.keys(f).sort(), [...KEYS].sort(), 'the usual shape');
        assert.equal(f.scores, 'unavailable', 'the page says the scores feed is off');
        // The game in play and the later one; not the morning's (over), the frozen catalogue's final or the guide-only listing.
        assert.deepEqual(f.games.map(g => g.id), ['espn:football/nfl:501', 'espn:football/nfl:502']);
        for (const g of f.games) {
            assert.equal(g.status, 'scheduled', `${g.id}: drawn like a future game`);
            assert.equal(g.freshness, 'unavailable');
            assert.equal(g.observedAt, null);
            assert.deepEqual(g.progress, {});
            for (const k of ['scores', 'situation', 'breakLabel']) assert.equal(k in g, false, `${g.id}: no ${k}`);
            for (const k of ['id', 'league', 'title', 'start', 'end', 'session', 'circuit', 'format', 'competitors', 'availability',
                'broadcastStatus', 'channels', 'events', 'canWatch', 'followed']) assert.ok(k in g, `${g.id}: the card keeps ${k}`);
            assert.equal(g.competitors.length, 2);
            assert.ok(g.competitors.every(c => typeof c.id === 'string' && c.name && c.logo), `${g.id}: teams with ids and badges`);
        }
        const [live, later] = f.games;
        assert.equal(live.title, 'Green Bay Packers v Detroit Lions');
        assert.deepEqual(live.channels.map(c => c.name), ['Fox HD'], 'the guide\'s channel is joined');
        assert.equal(live.broadcastStatus, 'on-tv');
        assert.equal(live.canWatch, true, 'on air now: Watch');
        assert.equal(live.followed, true);
        assert.deepEqual(later.channels.map(c => c.name), ['ESPN HD']);
        assert.equal(later.broadcastStatus, 'scheduled');
        assert.equal(later.canWatch, false);
        assert.equal(later.start, now + 2 * H);
        assert.ok(!JSON.stringify(f).includes('"14"') && !JSON.stringify(f).includes('"24"'), 'no score anywhere');
        assert.deepEqual(f.rails, [{ league: 'NFL', sport: 'American football', gameIds: ['espn:football/nfl:501', 'espn:football/nfl:502'] }]);
        assert.deepEqual(f.follows.map(x => [x.name, x.state, x.gameId]), [['Green Bay Packers', 'next', 'espn:football/nfl:501']]);
        assert.equal(f.hero.reason, 'follow-next');
        assert.equal(dashboard.cadence().why, 'off', 'the collector is not started');
        assert.deepEqual(outbound, [], 'serving the page makes no request');
        assert.equal((await call('/api/info')).body.features.sportFront, false);

        // Fixtures off as well: the page stays as in 0503, whatever the schedule holds.
        process.env.PIGTV_SPORT_FIXTURES = '0';
        const off = (await call('/api/sports/front')).body;
        assert.deepEqual([off.games, off.rails, off.scores], [[], [], 'unavailable']);
    } finally {
        delete process.env.PIGTV_SPORTS_DASHBOARD;
        delete process.env.PIGTV_SPORT_FIXTURES;
        guideEvents = [];
    }
});
