const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// #272 (D-1): the score collector is to be the only fetcher and store of ESPN's scoreboards. The guide's live/replay
// classifier reads, besides each game, how far ESPN was asked: a league's window, when, and which games it listed (the
// fixture refresh's coverage, sport_fixture_status). The collector now keeps that per league (sports_dashboard_coverage)
// once every day of the window has answered, and asks the day 36 hours back that the classifier reads (before noon UTC
// the day before yesterday) while the event list is needed. The old collector keeps no coverage and never asks that day.
const dashboard = require('../server/services/sportsDashboard');
const { createStore } = require('../server/services/sportsDashboardStore');
const espn = require('../server/services/sportsScoresEspn');
const requestPolicy = require('../server/services/espnRequestPolicy');
const databases = [];
after(() => databases.forEach(db => db.close()));

const FX = path.join(__dirname, 'fixtures/espn');
const readFx = name => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const H = 3600000;

function run({ now, league = 'NFL', path: source = 'football/nfl', days, windowDemand = () => true, fail = () => false, panel = null }) {
    requestPolicy.reset();
    const db = new Database(':memory:'); databases.push(db);
    const store = createStore(db);
    const clock = { now: Date.parse(now) };
    const asked = [];
    const fetchJson = async (url) => {
        asked.push(url);
        if (fail(url)) throw Object.assign(new Error('Score source unavailable'), { status: 500, hostBackoffRecorded: true });
        if (url.includes('cricket/scorepanel')) return panel || { scores: [] };
        const day = /dates=(\d{8})/.exec(url)?.[1];
        return url.includes(`/${source}/scoreboard`) && days[day] ? readFx(days[day]) : { events: [] };
    };
    const c = dashboard.createCollector({ store, clock: () => clock.now, enabled: () => true, leagues: () => new Set([league]),
        fetchJson, followed: () => new Map(), feedGames: async () => ({ ok: true, games: [] }), recordFeed: () => {},
        busy: () => true, every: () => null, windowDemand });
    const coverage = () => {
        const row = db.prepare('SELECT * FROM sports_dashboard_coverage WHERE league = ?').get(league);
        return row && { from: new Date(row.covered_from).toISOString(), to: new Date(row.covered_to).toISOString(),
            at: new Date(row.observed_at).toISOString(), listed: JSON.parse(row.listed) };
    };
    const refresh = async (n = 4) => { for (let i = 0; i < n; i++) await c.refresh(); };
    return { c, clock, asked, coverage, refresh, store };
}

test('a whole window answered: the league\'s coverage is its span, its oldest answer and every game it listed', async () => {
    const r = run({ now: '2026-09-27T12:00Z', days: { 20260927: 'nfl-20260927' } });
    await r.refresh();
    r.c.stop();
    assert.deepEqual(r.coverage(), {
        from: '2026-09-26T00:00:00.000Z', to: '2026-09-30T12:00:00.000Z', at: '2026-09-27T12:00:00.000Z',
        listed: ['espn:football/nfl:401872949', 'espn:football/nfl:401872951', 'espn:football/nfl:401872953', 'espn:football/nfl:401872954']
    });
    const asked = [...new Set(r.asked.map(u => /dates=(\d{8})/.exec(u)?.[1]))].sort();
    assert.deepEqual(asked.filter(d => d <= '20260930'), ['20260926', '20260927', '20260928', '20260929', '20260930'], 'the window (later days: the look-ahead, #218)');
});

test('before noon UTC, the day 36 hours back is asked (every 30 minutes) while the event list is needed, and only then', async () => {
    const needed = run({ now: '2026-09-26T08:00Z', league: 'F1', path: 'racing/f1', days: { 20260924: 'f1-scoreboard', 20260925: 'f1-scoreboard', 20260926: 'f1-scoreboard' } });
    await needed.refresh();
    assert.ok(needed.asked.some(u => u.includes('dates=20260924')), 'the day before yesterday is asked');
    assert.equal(needed.coverage().from, '2026-09-24T20:00:00.000Z', '36 hours back, as the fixture refresh covered');
    const count = () => needed.asked.filter(u => u.includes('dates=20260924')).length;
    const once = count();
    needed.clock.now += 20 * 60000; await needed.refresh();
    assert.equal(count(), once, 'not again within 30 minutes');
    needed.clock.now += 11 * 60000; await needed.refresh();
    assert.equal(count(), once + 1, 'again after 30 minutes');
    needed.c.stop();

    const idle = run({ now: '2026-09-26T08:00Z', league: 'F1', path: 'racing/f1', days: { 20260925: 'f1-scoreboard' }, windowDemand: () => false });
    await idle.refresh();
    idle.c.stop();
    assert.ok(!idle.asked.some(u => u.includes('dates=20260924')), 'nobody needs it: not asked');
    assert.equal(idle.coverage().from, '2026-09-25T00:00:00.000Z', 'the coverage starts where the asked days do');
});

test('a day that did not answer leaves the last coverage as it was', async () => {
    let failing = false;
    const r = run({ now: '2026-09-27T12:00Z', days: { 20260927: 'nfl-20260927' }, fail: u => failing && u.includes('dates=20260928') });
    await r.refresh();
    const first = r.coverage();
    failing = true;
    r.clock.now += 16 * 60000; // every answer due again; one day fails
    await r.refresh();
    r.c.stop();
    assert.deepEqual(r.coverage(), first);
});

test('International cricket: coverage only from whole series lists (every series readable and classed)', async () => {
    const panel = classed => ({ scores: [{ leagues: [{ id: '24377', name: 'Tour' }], events: [{ competitions: [{ class: { internationalClassId: '3' } }] }] },
        { leagues: [{ id: '22547', name: 'Other' }], events: classed ? [{ competitions: [{ class: { internationalClassId: '0' } }] }] : [] }] });
    const whole = run({ now: '2026-09-27T12:00Z', league: 'Cricket', path: 'cricket/24377', days: { 20260927: 'cricket-24377-20260927' }, panel: panel(true) });
    await whole.refresh(6);
    whole.c.stop();
    assert.deepEqual(whole.coverage()?.listed, ['espn:cricket/24377:1535684']);
    const unclassed = run({ now: '2026-09-27T12:00Z', league: 'Cricket', path: 'cricket/24377', days: { 20260927: 'cricket-24377-20260927' }, panel: panel(false) });
    await unclassed.refresh(6);
    unclassed.c.stop();
    assert.equal(unclassed.coverage(), undefined, 'a series without a class may be the group\'s: no coverage');
});

test('a card keeps what the classifier reads of it: ESPN\'s own end, each side\'s town, an F1 session\'s event name', () => {
    const [bbl] = espn.normalize(readFx('bbl-scoreboard'), 'BBL', 'cricket/8044');
    assert.equal(bbl.end, null, 'the card has no end for cricket (unchanged)');
    assert.deepEqual(bbl.fixture, { end: Date.parse('2026-12-13T23:59Z'), locations: ['Australia', 'Australia'] });
    const [fp1] = espn.normalize(readFx('f1-scoreboard'), 'F1', 'racing/f1');
    assert.deepEqual(fp1.fixture, { end: Date.parse('2026-09-26T11:00Z'), locations: [], event: 'Qatar Airways Azerbaijan Grand Prix' });
    const nfl = espn.normalize(readFx('nfl-20260927'), 'NFL', 'football/nfl').find(g => g.id.endsWith('401872953'));
    assert.deepEqual(nfl.fixture, { end: null, locations: ['Buffalo', 'Los Angeles'] });
});

// 0555 (batch D review M2): whether a group's series list is whole was judged from the cached list, but its series were taken
// only from this tick's answer. In a cooldown (or past the tick's deadline) after the list's 15 minutes, a series with no card
// yet dropped out, and the group's coverage was written without it: the classifier could then say "ESPN has no such game"
// for a real match of that series for up to 6 hours.
test('International cricket: a series the held list names but whose window has not answered keeps the coverage back during a cooldown', async () => {
    const klass = [{ competitions: [{ class: { internationalClassId: '3' } }] }];
    const panel = { scores: [{ leagues: [{ id: '24377', name: 'Tour' }], events: klass }, { leagues: [{ id: '99999', name: 'Second tour' }], events: klass }] };
    let failing = true;
    const r = run({ now: '2026-09-27T12:00Z', league: 'Cricket', path: 'cricket/24377', days: { 20260927: 'cricket-24377-20260927' }, panel,
        fail: u => failing && u.includes('cricket/99999') });
    await r.refresh(6);
    assert.equal(r.coverage(), undefined, 'the second series has not answered: no coverage');
    r.clock.now += 16 * 60000; // the series list is past its 15 minutes...
    requestPolicy.observe(429, '600', r.clock.now); // ...and ESPN asks us to wait: nothing is fetched this tick
    failing = false;
    await r.refresh(1);
    r.c.stop();
    assert.equal(r.coverage(), undefined, 'written without the second series\' matches');
});
