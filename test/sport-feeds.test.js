const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// #196 (D-41): fixtures for the leagues ESPN does not cover, from each sport's own feed, captured on 1 Nov 2026 (trimmed
// to a few matches): AFL's API (AFLW, one game live), Champion Data (NRLW, and the competition list with Super
// Netball), MotoGP's results API (the Qatar weekend's sessions) and supercars.com's calendar page (its event data).
// The old code has none of these feeds.
const feeds = require('../server/services/sportFeeds');
const dashboard = require('../server/services/sportsDashboard');
const { createStore } = require('../server/services/sportsDashboardStore');
const dir = path.join(__dirname, 'fixtures/feeds');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const NOW = Date.parse('2026-11-01T06:00Z');
const H = 3600000;
const databases = [];
after(() => databases.forEach(db => db.close()));

test('AFLW: every match with its state; scores only once played; club badges through the logo cache', () => {
    const games = feeds.aflwGames(json('aflw-2026-matches.json'), { hawthorn: 'https://a.espncdn.com/afl/haw.png' }, (u) => `/api/logo/${u.length}`);
    assert.equal(games.length, 10);
    const done = games.find(g => g.title === 'West Coast Eagles v Hawthorn');
    assert.deepEqual([done.id, done.league, done.snapshot.state, done.snapshot.scores], ['aflw:8982', 'AFLW', 'finished', ['39', '94']]);
    assert.ok(done.competitors[1].aliases.includes('Hawks') && done.competitors[1].aliases.includes('HAW'));
    assert.match(done.competitors[1].logo, /^\/api\/logo\//, 'the club\'s badge, cached');
    assert.equal(done.competitors[0].logo, null, 'no badge known: none');
    assert.ok(games.some(g => g.snapshot.state === 'live'));
    const placeholder = games.find(g => g.competitors.some(c => c.name === '4th'));
    assert.deepEqual([placeholder.snapshot.state, placeholder.snapshot.scores], ['scheduled', null], 'a finals placeholder is a fixture, its teams still to come');
    assert.ok(!placeholder.competitors[1].aliases.includes('TBD'));
});

test('Champion Data: the newest season\'s regular and finals competitions; NRLW games with NRL badges', () => {
    const comps = json('championdata-competitions.json');
    assert.deepEqual(feeds.championComps(comps, /^(\d{4}) NRLW(?: Finals)?$/), [13019, 13020]);
    assert.deepEqual(feeds.championComps(comps, /^(\d{4}) Super Netball(?: Finals)?$/), [12949, 12950]);
    const games = feeds.championGames('NRLW', json('championdata-13019-nrlw.json'));
    assert.equal(games.length, 4);
    const g = games.find(x => x.title === 'Newcastle Knights v Gold Coast Titans');
    assert.deepEqual([g.id, g.snapshot.state, g.snapshot.scores, g.start], ['cd:130191106', 'finished', ['20', '32'], Date.parse('2026-09-13T03:45:00Z')]);
    assert.equal(g.competitors[0].logo, 'https://www.nrl.com/.theme/knights/badge.png');
    assert.ok(g.competitors[1].aliases.includes('Titans'));
});

test('MotoGP: each MotoGP-class session of a weekend is a card with its circuit; Supercars: one card per event weekend', () => {
    const [qatar] = json('motogp-events.json');
    const sessions = feeds.motogpGames(qatar, json('motogp-sessions-qatar.json'));
    assert.deepEqual(sessions.map(s => s.session), ['Practice 1', 'Practice', 'Practice 2', 'Qualifying 1', 'Qualifying 2', 'Sprint', 'Warm Up', 'Race']);
    const race = sessions.find(s => s.session === 'Race');
    assert.deepEqual([race.title, race.start, race.snapshot.state, race.circuit.name], ['Grand Prix of Qatar · Race', Date.parse('2026-11-08T19:00:00Z'), 'scheduled', 'Lusail International Circuit']);
    const weekends = feeds.supercarsGames(read('supercars-calendar.html'), NOW);
    assert.equal(weekends.length, 14, 'the whole 2026 calendar');
    const sandown = weekends.find(w => /Sandown/.test(w.title));
    assert.deepEqual([sandown.league, sandown.snapshot.state, sandown.circuit.city], ['Supercars', 'scheduled', 'Melbourne, VIC']);
    assert.ok(sandown.end > sandown.start && sandown.end - sandown.start < 5 * 24 * H);
    assert.equal(weekends.find(w => /Bathurst/.test(w.title)).snapshot.state, 'finished');
    assert.equal(feeds.supercarsGames('<html>redesigned</html>').length, 0);
});

test('games(): a failing or reshaped feed gives its error and no games; only the allowed hosts; kept 15 min, 1 min while live', async () => {
    const real = feeds.fetcher.get;
    let calls = 0;
    try {
        feeds.reset();
        feeds.fetcher.get = async () => { calls++; return { ok: false, error: 'HTTP 503' }; };
        assert.deepEqual(await feeds.games('NRLW', { now: NOW }), { ok: false, error: 'HTTP 503' });
        await feeds.games('NRLW', { now: NOW + 60000 });
        assert.equal(calls, 1, 'kept');
        feeds.reset();
        feeds.fetcher.get = async (url) => url.endsWith('competitions.json') ? { ok: true, json: json('championdata-competitions.json') } : { ok: true, json: { nope: 1 } };
        assert.deepEqual(await feeds.games('Super Netball', { now: NOW }), { ok: false, error: 'not a Champion Data fixture' });
        assert.equal((await feeds.games('NFL')).ok, false, 'ESPN\'s leagues are not here');
        feeds.reset();
        feeds.fetcher.get = real;
        assert.deepEqual(await feeds.fetcher.get('https://example.com/x'), { ok: false, error: 'host not allowed' });
        let n = 0;
        feeds.fetcher.get = async (url) => { n++; return url.includes('compseasons') ? { ok: true, json: { compSeasons: [{ id: 96 }] } }
            : url.includes('espn') ? { ok: false, error: 'down' } : { ok: true, json: json('aflw-2026-matches.json') }; };
        const live = await feeds.games('AFLW', { now: NOW });
        assert.ok(live.ok && live.observedAt === NOW && live.games.some(g => g.snapshot.state === 'live'));
        await feeds.games('AFLW', { now: NOW + 61000 });
        assert.equal(n, 6, 'a live league is read again after a minute (3 requests each: season, matches, badges)');
    } finally { feeds.fetcher.get = real; feeds.reset(); }
});

test('the collector takes the feed leagues\' games into the catalog, records each answer once, and never asks ESPN for them', async () => {
    const db = new Database(':memory:'); databases.push(db);
    const s = createStore(db);
    const asked = [], recorded = [];
    const answer = { ok: true, observedAt: NOW, games: feeds.aflwGames(json('aflw-2026-matches.json')) };
    const c = dashboard.createCollector({ store: s, clock: () => NOW, enabled: () => true, leagues: () => new Set(['AFLW']),
        fetchJson: async (url) => { asked.push(url); return { events: [] }; },
        feedGames: async () => answer, recordFeed: (league, a) => recorded.push([league, a.ok]) });
    await c.refresh(); await c.refresh(); c.stop();
    assert.deepEqual(asked, []);
    assert.deepEqual(recorded, [['AFLW', true]], 'once for one answer');
    assert.equal(s.catalog().filter(g => g.league === 'AFLW').length, 10);
});

test('guide airings join a MotoGP session by session and place, and a Supercars weekend by its dates; a followed rider rides every session', () => {
    const [qatar] = json('motogp-events.json');
    const race = feeds.motogpGames(qatar, json('motogp-sessions-qatar.json')).find(s => s.session === 'Race');
    const [sandown] = feeds.supercarsGames(read('supercars-calendar.html'), NOW).filter(w => /Sandown/.test(w.title));
    const ev = (id, league, title, start, end) => ({ id, league, kind: 'event', title, start, end, channels: [] });
    const found = dashboard.matchBroadcasts([race, sandown], [
        ev('e1', 'MotoGP', 'MotoGP: Qatar Grand Prix - Race', race.start - 10 * 60000, race.start + 2 * H),
        ev('e2', 'MotoGP', 'MotoGP: Qatar Grand Prix - Qualifying', race.start - 10 * 60000, race.start + 2 * H),
        ev('e3', 'Supercars', 'Supercars: Sandown 500 - Race 2', sandown.start + 30 * H, sandown.start + 34 * H)]);
    assert.deepEqual(found.get(race.id).map(e => e.id), ['e1']);
    assert.deepEqual(found.get(sandown.id).map(e => e.id), ['e3']);
    const db = new Database(':memory:'); databases.push(db);
    const s = createStore(db);
    s.ingest([{ ...race, snapshot: { ...race.snapshot } }], race.start - H);
    const r = dashboard.buildDashboard(s, { now: race.start - 30 * 60000, userId: '1', timezone: 'Australia/Melbourne', events: [], upcomingHours: 72,
        leagues: new Set(['MotoGP']), teams: { MotoGP: ['Jorge Martin'] } });
    assert.equal(r.games[0].followed, true);
});
