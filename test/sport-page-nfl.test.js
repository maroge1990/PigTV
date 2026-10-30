const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// #21 (0376, C-Q): the NFL page's data from ESPN's free NFL feeds, as captured on 31 Oct 2026 08:42 (Melbourne): week 8
// of the 2026 regular season (Thursday's Panthers at Packers final, the rest to come; Saints, Giants, 49ers and Texans
// on a bye), week 7's finals, and the eight divisions. The old code has no NFL page.
const nfl = require('../server/services/sportPageNFL');
const fixture = (name) => JSON.parse(JSON.stringify(require(path.join(__dirname, 'fixtures/espn/nfl', name))));
const NOW = Date.parse('2026-10-30T21:42:00Z');
let asked;

function stub(overrides = {}) {
    asked = [];
    nfl.fetcher.get = async (url) => {
        asked.push(url);
        for (const [re, answer] of Object.entries(overrides)) if (new RegExp(re).test(url)) return typeof answer === 'function' ? answer(url) : answer;
        if (/standings/.test(url)) return { ok: true, json: fixture('standings.json') };
        if (/week=7/.test(url)) return { ok: true, json: fixture('scoreboard-week7.json') };
        if (/scoreboard$/.test(url)) return { ok: true, json: fixture('scoreboard-week8.json') };
        return { ok: false, error: 'unexpected' };
    };
}
beforeEach(() => { nfl.reset(); stub(); });

test('the page opens on the current week, after the one before it: week 7 finals, then week 8 with its byes', async () => {
    const p = await nfl.build(NOW);
    assert.equal(p.available, true);
    assert.deepEqual(p.season, { year: 2026, type: 'regular' });
    assert.deepEqual(p.weeks.map(w => [w.label, w.current, w.games.length]), [['Week 7', false, 14], ['Week 8', true, 14]]);
    assert.ok(asked.some(u => /seasontype=2&week=7&dates=2026$/.test(u)), 'the previous week by number and season');
    const [w7, w8] = p.weeks;
    assert.deepEqual(w8.byes.sort(), ['HOU', 'NO', 'NYG', 'SF']);
    const thursday = w8.games[0];
    assert.deepEqual([thursday.away.abbr, thursday.away.score, thursday.home.abbr, thursday.home.score, thursday.status, thursday.detail],
        ['CAR', 19, 'GB', 27, 'done', 'Final']);
    assert.equal(thursday.home.record, '5-3');
    assert.deepEqual(thursday.broadcasts, ['Prime Video']);
    const next = w8.games[1];
    assert.equal(next.status, 'scheduled');
    assert.equal(next.detail, null);
    assert.equal(next.home.score, 0, 'ESPN sends 0 before kick-off; the page shows the time instead');
    assert.ok(w8.games.every((g, i, a) => !i || a[i - 1].start <= g.start), 'kick-off order');
    assert.ok(w7.games.every(g => g.status === 'done'));
    assert.equal(w7.games.find(g => g.away.abbr === 'NYG').detail, 'Final · OT', 'ESPN\'s "Final/OT"');
    assert.deepEqual(p.teams.GB, { abbr: 'GB', name: 'Packers', full: 'Green Bay Packers', location: 'Green Bay', color: '204E32',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/gb.png' });
    assert.equal(Object.keys(p.teams).length, 32, 'every team, from the games and the standings');
});

test('standings: eight divisions of four, with records, seeds, streaks and points', async () => {
    const p = await nfl.build(NOW);
    const divs = p.standings.divisions;
    assert.deepEqual(divs.map(d => `${d.conference} ${d.name}`), ['AFC AFC East', 'AFC AFC North', 'AFC AFC South', 'AFC AFC West',
        'NFC NFC East', 'NFC NFC North', 'NFC NFC South', 'NFC NFC West']);
    assert.ok(divs.every(d => d.teams.length === 4));
    const buf = divs[0].teams.find(t => t.abbr === 'BUF');
    assert.deepEqual(buf, { abbr: 'BUF', wins: 5, losses: 1, ties: 0, record: '5-1', seed: 2, streak: 'W2', pointsFor: 197, pointsAgainst: 171 });
    const seeds = divs.filter(d => d.conference === 'AFC').flatMap(d => d.teams.map(t => t.seed)).sort((a, b) => a - b);
    assert.deepEqual(seeds, Array.from({ length: 16 }, (_, i) => i + 1), 'each conference seeded 1-16');
});

test('a live game carries the quarter and clock, and down and distance with who has the ball', () => {
    const json = fixture('scoreboard-week8.json');
    const ev = json.events[0];
    const c = ev.competitions[0];
    c.status = { displayClock: '5:54', period: 1, type: { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: '5:54 - 1st' } };
    const car = c.competitors.find(x => x.team.abbreviation === 'CAR');
    car.score = '3'; c.competitors.find(x => x.team.abbreviation === 'GB').score = '0';
    c.situation = { downDistanceText: '3rd & 8 at CAR 12', possession: car.id, isRedZone: true };
    const g = nfl.gameOf(ev, new Map(), (u) => u);
    assert.deepEqual([g.status, g.detail, g.away.score, g.home.score], ['live', 'Q1 5:54', 3, 0]);
    assert.deepEqual(g.situation, { downDistance: '3rd & 8 at CAR 12', possession: 'CAR', redZone: true });
    c.status = { displayClock: '0:00', period: 2, type: { state: 'in', shortDetail: 'Halftime' } };
    assert.equal(nfl.gameOf(ev, new Map(), (u) => u).detail, 'Halftime');
});

test('a game gets the channels of the NFL event naming both teams around its kick-off', async () => {
    const p = await nfl.build(NOW);
    const teams = new Map(Object.entries(p.teams));
    const games = p.weeks[1].games;
    const ravens = games.find(g => g.away.abbr === 'BAL');
    const fox = { sourceId: 8, id: 'pos_7', name: 'Fox Sports 505', start: ravens.start - 1800e3, end: ravens.start + 4 * 3600e3 };
    const events = [
        { league: 'NFL', kind: 'event', title: 'NFL: Baltimore Ravens at Buffalo Bills', start: ravens.start - 1800e3, end: ravens.start + 12600e3, channels: [fox] },
        { league: 'NFL', kind: 'event', title: 'NFL: Tennessee Titans at Cincinnati Bengals', start: ravens.start - 1800e3, end: ravens.start + 12600e3,
            channels: [{ sourceId: 8, id: 'pos_9', name: 'ESPN' }] },
        { league: 'NFL', kind: 'replay', title: 'NFL: Ravens v Bills (replay)', start: ravens.start, end: ravens.start + 1, channels: [{ sourceId: 8, id: 'x' }] },
        { league: 'NFL', kind: 'event', title: 'NFL: Ravens at Bills', start: ravens.start + 7 * 86400e3, end: ravens.start + 7 * 86400e3 + 1, channels: [{ sourceId: 8, id: 'y' }] }
    ];
    const map = nfl.channelsForGames(games, events, teams);
    assert.deepEqual(map.get(ravens.id), [fox], 'by nickname or city, the replay and a game a week later left out');
    assert.deepEqual(map.get(games.find(g => g.away.abbr === 'TEN').id).map(c => c.name), ['ESPN']);
    assert.equal(map.get(games.find(g => g.away.abbr === 'ARI').id), undefined, 'not in the guide yet');
});

test('page(): kept, then refreshed once stale (2 min with a game on); channels per request; ESPN down is not available', async () => {
    let calls = 0;
    const deps = { channelsFor: async (games) => { calls++; return new Map([[games[0].id, [{ sourceId: 1, id: 'a' }]]]); } };
    const first = await nfl.page(NOW, deps);
    assert.deepEqual(first.weeks[0].games[0].channels, [{ sourceId: 1, id: 'a' }]);
    assert.ok(first.weeks[0].games.slice(1).every(g => Array.isArray(g.channels) && !g.channels.length));
    const n = asked.length;
    await nfl.page(NOW + 30 * 60e3, deps);
    assert.equal(asked.length, n, 'within the hour: no ESPN request (no game is on or due within 12 h of 08:42)');
    assert.equal(calls, 2, 'channels are attached to each request');
    assert.equal(nfl.ttlOf({ weeks: [{ games: [{ status: 'live', start: NOW }] }] }, NOW), 2 * 60e3);

    nfl.reset();
    stub({ scoreboard$: { ok: false, error: 'HTTP 503' } });
    assert.deepEqual(await nfl.page(NOW), { available: false });
});

// #183: on 0379 a city was a team identity, so "Los Angeles Rams vs Seattle Seahawks" also matched a Chargers game in
// the same slot, and one "Los Angeles" mention satisfied both sides of Rams v Chargers.
test('#183: a city two teams share names neither; an event naming another team does not match', async () => {
    const p = await nfl.build(NOW);
    const teams = new Map(Object.entries(p.teams));
    const at = Date.parse('2026-11-08T21:05:00Z');
    const game = (id, away, home) => ({ id, start: at, away: { abbr: away }, home: { abbr: home } });
    const ev = (title, id) => ({ league: 'NFL', kind: 'event', title, start: at - 1800e3, end: at + 12600e3, channels: [{ sourceId: 8, id }] });
    const games = [game('a', 'SEA', 'LAR'), game('b', 'KC', 'LAC'), game('c', 'NYJ', 'NYG')];
    let map = nfl.channelsForGames(games, [ev('NFL: Seattle Seahawks at Los Angeles Rams', 'rams')], teams);
    assert.deepEqual(map.get('a').map(c => c.id), ['rams']);
    assert.equal(map.get('b'), undefined, 'the Chargers game is not "Los Angeles"');
    map = nfl.channelsForGames(games, [ev('NFL: New York Jets at New York Giants', 'derby')], teams);
    assert.deepEqual(map.get('c').map(c => c.id), ['derby'], 'by nickname');
    map = nfl.channelsForGames([game('d', 'LAC', 'LAR')], [ev('NFL Live: Los Angeles', 'x')], teams);
    assert.equal(map.get('d'), undefined, 'a bare shared city names no team');
    map = nfl.channelsForGames(games, [ev('NFL: Chiefs v Chargers', 'kc'), ev('Rams Preview Show', 'show')], teams);
    assert.deepEqual(map.get('b').map(c => c.id), ['kc']);
    assert.deepEqual(map.get('a').map(c => c.id), ['show'], 'one team, the only such event around');
    map = nfl.channelsForGames(games, [ev('NFL: Seahawks at Rams, then Chiefs', 'mix')], teams);
    assert.equal(map.get('a'), undefined, 'an event that names a team outside the game is not this game');
});
