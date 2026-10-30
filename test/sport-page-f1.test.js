const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// #21 (0340, C-P): the Formula 1 page from ESPN's F1 feeds. The answers are real ESPN responses captured on 30 Oct
// 2026 (between the United States and Mexico City weekends), trimmed: test/fixtures/sport-page-f1.json.
const f1 = require('../server/services/sportPageF1');
const { answers } = require('./fixtures/sport-page-f1.json');

const NOW = Date.parse('2026-10-30T12:00:00Z');
let asked = [];
/** ESPN as the fixture answers it; `down` makes every request fail. */
function fakeEspn({ down = false } = {}) {
    asked = [];
    f1.fetcher.get = async (url) => {
        asked.push(url);
        if (down) return { ok: false, error: 'HTTP 503' };
        const u = new URL(url);
        const p = u.pathname;
        let key;
        if (p.endsWith('/racing/f1/scoreboard')) key = u.searchParams.get('dates') ? `/scoreboard?dates=${u.searchParams.get('dates')}` : '/scoreboard';
        else if (p.endsWith('/racing/f1/standings')) key = 'standings';
        else key = `core${p.split('/leagues/f1')[1]}`;
        return key in answers ? { ok: true, json: answers[key] } : { ok: false, error: 'HTTP 404' };
    };
}
const registerImage = (u) => `/api/logo/${Buffer.from(u).toString('hex').slice(-12)}`;

beforeEach(() => f1.reset());

test('the page leads with the next weekend: Mexico City, round 21 of 25, its circuit and five sessions', async () => {
    fakeEspn();
    const page = await f1.page(NOW, { registerImage });
    assert.equal(page.available, true);
    const w = page.weekend;
    assert.deepEqual([w.round, w.rounds, w.name, w.circuit, w.city, w.country, w.phase],
        [21, 25, 'Mexico City Grand Prix', 'Autodromo Hermanos Rodriguez', 'Mexico city', 'Mexico', 'before']);
    assert.deepEqual(w.sessions.map(s => [s.id, s.name, new Date(s.start).toISOString(), s.status, s.top]), [
        ['practice 1', 'Practice 1', '2026-10-30T18:30:00.000Z', 'scheduled', null],
        ['practice 2', 'Practice 2', '2026-10-30T22:00:00.000Z', 'scheduled', null],
        ['practice 3', 'Practice 3', '2026-10-31T17:30:00.000Z', 'scheduled', null],
        ['qualifying', 'Qualifying', '2026-10-31T21:00:00.000Z', 'scheduled', null],
        ['race', 'Race', '2026-11-01T20:00:00.000Z', 'scheduled', null]
    ]);
    assert.equal(w.sessions[4].end - w.sessions[4].start, 2 * 3600e3, 'no end from ESPN: a race is estimated at two hours');
    assert.deepEqual(w.sessions.map(s => s.channels), [[], [], [], [], []], 'no guide airing given');
    const { map, ...info } = w.info;
    assert.deepEqual(info, { length: '4.304 km', laps: 71, turns: 17, lapRecord: '1:17.774', lapRecordYear: 2021 });
    assert.equal(map, registerImage('https://a.espncdn.com/i/venues/f1/circuit/50.jpg'), 'the raster map, through the logo cache');
});

test('results are the last race (Austin), with each car\'s team; standings are both top tens after round 20', async () => {
    fakeEspn();
    const { results, standings } = await f1.page(NOW, { registerImage });
    assert.equal(results.kind, 'race');
    assert.equal(results.title, 'Last race · United States GP', 'the sponsor is not part of the name');
    assert.equal(results.rows.length, 10);
    assert.deepEqual(results.rows[0], { pos: 1, driver: 'Kimi Antonelli', team: 'Mercedes', teamColor: '00D2BE', points: null },
        'ESPN gives no awarded points with the results (#158)');
    assert.ok(results.rows.every(r => r.team), 'every top-ten car has its team');
    assert.equal(standings.afterRound, 20);
    assert.equal(standings.drivers.length, 10);
    assert.equal(standings.constructors.length, 10);
    assert.deepEqual(standings.drivers[0], { pos: 1, name: 'Kimi Antonelli', team: 'Mercedes', teamColor: '00D2BE', points: 365 });
    assert.deepEqual(standings.constructors[0], { pos: 1, name: 'Mercedes', team: null, teamColor: '00D2BE', points: 607 });
    assert.deepEqual(standings.drivers.map(d => d.points), [365, 242, 241, 236, 233, 211, 144, 105, 77, 42]);
});

test('kept, then refreshed once stale; nothing at all until it is asked for', async () => {
    fakeEspn();
    assert.equal(asked.length, 0, 'nothing is fetched until the page is asked for');
    await f1.page(NOW, { registerImage });
    const first = asked.length;
    await f1.page(NOW + 5 * 60 * 1000, { registerImage });
    assert.equal(asked.length, first, 'kept: within a day of Practice 1 it is a race weekend, so for 10 minutes');
    const stale = await f1.page(NOW + 15 * 60 * 1000, { registerImage });
    assert.equal(stale.updatedAt, NOW, 'a stale page is served at once while one refresh runs');
    for (let i = 0; i < 50 && asked.length === first; i++) await new Promise(r => setImmediate(r));
    assert.ok(asked.length > first, 'and refreshed in the background');
});

test('ESPN down: not available, and no throw', async () => {
    fakeEspn({ down: true });
    assert.deepEqual(await f1.page(NOW, { registerImage }), { available: false });
});

test('sessions carry the channels their airing is on (C-I, each with its own times)', async () => {
    fakeEspn();
    const ch = { sourceId: 1, id: '7', name: 'Fox Sports 506 UHD', start: Date.parse('2026-10-30T18:15:00Z'), end: Date.parse('2026-10-30T20:00:00Z') };
    const page = await f1.page(NOW, { registerImage, channelsFor: async (sessions) => new Map([[sessions[0].id, [ch]]]) });
    assert.deepEqual(page.weekend.sessions[0].channels, [ch]);
    assert.deepEqual(page.weekend.sessions[1].channels, []);
});

test('a session gets the channels of the F1 event naming it whose own airing covers its start', () => {
    const at = Date.parse('2026-10-31T21:00:00Z');
    const sessions = [{ id: 'practice 3', name: 'Practice 3', start: at - 3.5 * 3600e3 }, { id: 'qualifying', name: 'Qualifying', start: at },
        { id: 'race', name: 'Race', start: at + 23 * 3600e3 }];
    const ch = (id, start, end) => ({ sourceId: 1, id, name: `C${id}`, start, end });
    const events = [
        { league: 'F1', kind: 'event', title: 'Mexico City GP · Qualifying', start: at - 3600e3, end: at + 2 * 3600e3,
            channels: [ch('a', at - 15 * 60e3, at + 3600e3), ch('b', at - 3600e3, at - 40 * 60e3)] },
        { league: 'F1', kind: 'replay', title: 'Mexico City GP · Qualifying', start: at + 6 * 3600e3, end: at + 7 * 3600e3, channels: [ch('r', at + 6 * 3600e3, at + 7 * 3600e3)] },
        { league: 'F1', kind: 'event', title: 'Mexico City Grand Prix', start: at + 22.5 * 3600e3, end: at + 25 * 3600e3, channels: [ch('a', at + 22.5 * 3600e3, at + 25 * 3600e3)] },
        { league: 'F1', kind: 'event', title: 'Mexico City GP · Practice 3', start: at - 3.5 * 3600e3, end: at - 2.5 * 3600e3, channels: [ch('c', at - 3.5 * 3600e3, at - 2.5 * 3600e3)] },
        { league: 'MotoGP', kind: 'event', title: 'Qualifying', start: at, end: at + 3600e3, channels: [ch('m', at, at + 3600e3)] }
    ];
    const got = f1.channelsForSessions(sessions, events);
    assert.deepEqual(got.get('qualifying').map(c => c.id), ['a'], 'b\'s own airing ended 40 min before; the replay and MotoGP never count');
    assert.deepEqual(got.get('race').map(c => c.id), ['a'], 'the race as "Grand Prix"');
    assert.deepEqual(got.get('practice 3').map(c => c.id), ['c']);
});

// #156: team lookups are optional; a stalled ESPN core endpoint must not hold a cold request for minutes.
test('#156: a stalled team lookup cannot hold the first request: a bounded wait, the page without those teams', async () => {
    fakeEspn();
    const real = f1.fetcher.get;
    f1.fetcher.get = async (url) => {
        if (/\/competitors\//.test(url)) await new Promise(r => setTimeout(r, 1000)); // each car's request, slow
        return real(url);
    };
    if (f1.tuning) Object.assign(f1.tuning, { teamDeadlineMs: 1500 });
    const began = Date.now();
    const page = await f1.page(NOW, { registerImage });
    const took = Date.now() - began;
    assert.ok(took < 4000, `the first request waited ${took} ms`);
    assert.equal(page.available, true);
    assert.equal(page.results.rows.length, 10, 'the results without waiting for every team');
    if (f1.tuning) Object.assign(f1.tuning, { teamDeadlineMs: f1.TUNING.teamDeadlineMs });
});

// #157: the cache keeps ESPN's data only; each request gets its own user's channels from the current guide.
test('#157: channels are attached per request, never kept with the page', async () => {
    fakeEspn();
    const ch = (id) => ({ sourceId: 1, id, name: id, start: Date.parse('2026-10-30T18:15:00Z'), end: Date.parse('2026-10-30T20:00:00Z') });
    const first = await f1.page(NOW, { registerImage, channelsFor: async (s) => new Map([[s[0].id, [ch('mine')]]]) });
    const second = await f1.page(NOW + 60e3, { registerImage, channelsFor: async (s) => new Map([[s[0].id, [ch('theirs')]]]) });
    assert.deepEqual(first.weekend.sessions[0].channels.map(c => c.id), ['mine']);
    assert.deepEqual(second.weekend.sessions[0].channels.map(c => c.id), ['theirs'], 'another viewer, a newer guide');
});

// #158: points are what the feed says, never a guessed scale (ESPN's results give none, so null).
test('#158: race points are not invented', async () => {
    fakeEspn();
    const { results } = await f1.page(NOW, { registerImage });
    assert.deepEqual(results.rows.map(r => r.points), Array(10).fill(null));
});

// #161: a weekend that cannot be fetched is a failed refresh, never an empty "before" page kept for an hour.
test('#161: a failed weekend fetch keeps the last good page; cold, it is not available', async () => {
    fakeEspn();
    const good = await f1.page(NOW, { registerImage });
    assert.equal(good.weekend.sessions.length, 5);
    const real = f1.fetcher.get;
    f1.fetcher.get = async (url) => (/scoreboard\?dates=/.test(url) ? { ok: false, error: 'timed out' } : real(url));
    await f1.page(NOW + 20 * 60e3, { registerImage }); // stale: a refresh starts, and its weekend fetch fails
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
    const after = await f1.page(NOW + 21 * 60e3, { registerImage });
    assert.equal(after.weekend.sessions.length, 5, 'the good page stays');
    f1.reset();
    assert.deepEqual(await f1.page(NOW, { registerImage }), { available: false }, 'cold: not an empty weekend');
    f1.fetcher.get = real;
});
