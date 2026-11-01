const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

// #197 (D-41 points 5 and 6): tennis, golf, UFC, IndyCar and NASCAR Cup from ESPN, captured on 1 Nov 2026 and trimmed
// (a few matches per draw, five golfers, six drivers): ATP's and WTA's feeds this week and on 25 Jan (the Australian
// Open, in both), PGA Tour's this week and at the Masters, LPGA's, UFC's night of 31 Oct and NASCAR's Martinsville race.
// The old code has none of these leagues.
const individual = require('../server/services/sportIndividual');
const dashboard = require('../server/services/sportsDashboard');
const classify = require('../server/services/sportsClassify');
const catalog = require('../server/services/sportCatalog');
const { createStore } = require('../server/services/sportsDashboardStore');
const json = (name) => require(path.join(__dirname, 'fixtures/espn-individual', name));
const NOW = Date.parse('2026-11-01T06:00Z');
const H = 3600000;
const databases = [];
after(() => databases.forEach(db => db.close()));
const store = () => { const db = new Database(':memory:'); databases.push(db); return createStore(db); };
const titles = (league, source, file) => individual.normalize(json(file), league, source).map(g => g.title);

test('#197: a major appears only under its majors league; WTA\'s copy of a Grand Slam is never taken', () => {
    assert.deepEqual(titles('ATP Tour', 'tennis/atp', 'tennis-atp-2026-11-01.json'), ['Erste Bank Open', 'Swiss Indoors Basel', 'Rolex Paris Masters']);
    assert.deepEqual(titles('Grand Slams', 'tennis/atp', 'tennis-atp-2026-11-01.json'), []);
    assert.deepEqual(titles('Grand Slams', 'tennis/atp', 'tennis-atp-australian-open-2026.json'), ['Australian Open']);
    assert.deepEqual(titles('ATP Tour', 'tennis/atp', 'tennis-atp-australian-open-2026.json'), []);
    assert.deepEqual(titles('WTA Tour', 'tennis/wta', 'tennis-wta-2026-01-25.json'), ["Philippine Women's Open"], 'the Australian Open is in WTA\'s feed too');
    const [ao] = individual.normalize(json('tennis-atp-australian-open-2026.json'), 'Grand Slams', 'tennis/atp');
    assert.ok(ao.players.includes('Aryna Sabalenka') && ao.players.some(p => /Sinner|Alcaraz|Djokovic/.test(p)), 'men\'s and women\'s draws together');
    assert.deepEqual(titles('Majors', 'golf/pga', 'golf-pga-masters-2026.json'), ['Masters Tournament']);
    assert.deepEqual(titles('PGA Tour', 'golf/pga', 'golf-pga-masters-2026.json'), []);
    assert.deepEqual(titles('PGA Tour', 'golf/pga', 'golf-pga-2026-11-01.json'), ['VidantaWorld Mexico Open']);
    assert.deepEqual(titles('Majors', 'golf/pga', 'golf-pga-2026-11-01.json'), []);
    assert.deepEqual(titles('PGA Tour', 'golf/eur', 'golf-pga-2026-11-01.json'), [], 'only a league\'s own feed');
});

test('#197: one card per tournament, night or race, its status from what is played, its names in name order', () => {
    const atp = individual.normalize(json('tennis-atp-2026-11-01.json'), 'ATP Tour', 'tennis/atp');
    const vienna = atp.find(g => g.title === 'Erste Bank Open');
    assert.deepEqual([vienna.id, vienna.start, vienna.end, vienna.circuit.city], ['espn:tennis/atp:10-2026', Date.parse('2026-10-24T04:00Z'), Date.parse('2026-11-02T04:59Z'), 'Vienna']);
    assert.deepEqual([vienna.snapshot.state, vienna.snapshot.breakLabel], ['break', 'Between matches'], 'ESPN says "Final" for the whole tournament: its matches say otherwise');
    assert.deepEqual(vienna.players, [...vienna.players].sort((a, b) => a.localeCompare(b)));
    assert.ok(!atp.flatMap(g => g.players).includes('TBD'));
    const [mexico] = individual.normalize(json('golf-pga-2026-11-01.json'), 'PGA Tour', 'golf/pga');
    assert.deepEqual([mexico.snapshot.state, mexico.snapshot.breakLabel, mexico.snapshot.progress.period], ['break', 'Round 3 complete', 3]);
    assert.equal(mexico.end, Date.parse('2026-11-02T04:00Z'), 'ESPN\'s endDate is the last round\'s day: the card runs through it');
    assert.equal(individual.normalize(json('golf-lpga-2026-11-01.json'), 'LPGA', 'golf/lpga')[0].snapshot.state, 'live');
    const [night] = individual.normalize(json('ufc-2026-10-31.json'), 'UFC', 'mma/ufc');
    assert.deepEqual([night.title, night.start, night.end, night.snapshot.state, night.circuit.city],
        ['UFC Fight Night: Moicano vs. Nolan', Date.parse('2026-10-31T21:00Z'), Date.parse('2026-11-01T04:00Z'), 'finished', 'Las Vegas']);
    assert.ok(night.players.includes('Renato Moicano'));
    const [race] = individual.normalize(json('nascar-2026-11-01.json'), 'NASCAR', 'racing/nascar-premier');
    assert.deepEqual([race.title, race.session, race.start, race.end, race.snapshot.state],
        ['NASCAR Cup Series at Martinsville', 'Race', Date.parse('2026-11-01T19:00Z'), Date.parse('2026-11-01T23:00Z'), 'scheduled']);
    for (const g of [vienna, mexico, night, race]) assert.equal(g.snapshot.scores, null, 'no score, no leader: a card never spoils');
});

test('#197: the catalogue offers tennis, golf, UFC, IndyCar and NASCAR Cup; the guide names their leagues', () => {
    assert.deepEqual(catalog.sport('Tennis').leagues, ['Grand Slams', 'ATP Tour', 'WTA Tour']);
    assert.deepEqual(catalog.sport('Golf').leagues, ['Majors', 'PGA Tour', 'DP World Tour', 'LIV', 'LPGA']);
    assert.deepEqual(catalog.sport('Combat').leagues, ['UFC']);
    assert.deepEqual(catalog.sport('Motorsport').leagues, ['F1', 'IndyCar', 'NASCAR', 'MotoGP', 'Supercars']);
    assert.equal(catalog.labelOf('NASCAR'), 'NASCAR Cup');
    const said = {
        'Australian Open Tennis: Day 3': 'Grand Slams', 'ATP Tennis: Rolex Paris Masters': 'ATP Tour', 'WTA Finals Riyadh': 'WTA Tour',
        'The Masters: Final Round': 'Majors', 'LPGA: KPMG Womens PGA Championship': 'LPGA', 'PGA Tour Golf: Mexico Open': 'PGA Tour',
        'DP World Tour: Abu Dhabi Championship': 'DP World Tour', 'LIV Golf Adelaide': 'LIV', 'UFC 334: Gane vs Hokit': 'UFC',
        'NASCAR Cup Series: Martinsville': 'NASCAR', 'INDYCAR: Grand Prix of Monterey': 'IndyCar',
        // never a major: another tour's championship, a football club, snooker's Masters, golf's Australian Open
        'BMW Australian PGA Championship': null, 'AFC Wimbledon v Bolton': null, 'Snooker: The Masters': null, 'Australian Open Golf': null };
    for (const [title, league] of Object.entries(said)) assert.equal(classify.detectLeague(title), league, title);
});

test('#197: a guide airing joins its tournament, night or race by name, never another one on at the same time', () => {
    const cards = [...individual.normalize(json('tennis-atp-2026-11-01.json'), 'ATP Tour', 'tennis/atp'),
        ...individual.normalize(json('ufc-2026-10-31.json'), 'UFC', 'mma/ufc'),
        ...individual.normalize(json('golf-pga-2026-11-01.json'), 'PGA Tour', 'golf/pga'),
        ...individual.normalize(json('nascar-2026-11-01.json'), 'NASCAR', 'racing/nascar-premier')];
    const ev = (id, league, title, start, hours = 3) => ({ id, league, kind: 'event', title, start, end: start + hours * H, channels: [] });
    const day = Date.parse('2026-11-01T10:00Z');
    const found = dashboard.matchBroadcasts(cards, [
        ev('paris', 'ATP Tour', 'ATP Tennis: Rolex Paris Masters - Day 2', day),
        ev('basel', 'ATP Tour', 'Swiss Indoors Basel: Final', day),
        ev('tennis', 'ATP Tour', 'ATP Tennis', day),
        ev('ufc', 'UFC', 'UFC Fight Night: Moicano vs Nolan - Main Card', Date.parse('2026-11-01T00:00Z')),
        ev('golf', 'PGA Tour', 'PGA Tour Golf: VidantaWorld Mexico Open, Final Round', Date.parse('2026-11-01T17:00Z'), 5),
        ev('nascar', 'NASCAR', 'NASCAR Cup Series: Xfinity 500 from Martinsville', Date.parse('2026-11-01T18:30Z'), 4),
        ev('practice', 'NASCAR', 'NASCAR Cup Series Practice: Martinsville', Date.parse('2026-10-31T15:00Z'), 1)]);
    const joined = Object.fromEntries(cards.map(c => [c.title, found.get(c.id).map(e => e.id)]));
    assert.deepEqual(joined, { 'Erste Bank Open': [], 'Swiss Indoors Basel': ['basel'], 'Rolex Paris Masters': ['paris'],
        'UFC Fight Night: Moicano vs. Nolan': ['ufc'], 'VidantaWorld Mexico Open': ['golf'], 'NASCAR Cup Series at Martinsville': ['nascar'] },
        'a bare "ATP Tennis" names no tournament; Friday\'s practice is not the race');
});

test('#197: a followed player, fighter or driver marks only the events they are in; a tournament shows every day it runs', () => {
    const s = store();
    const atp = individual.normalize(json('tennis-atp-2026-11-01.json'), 'ATP Tour', 'tennis/atp');
    const vienna = atp.find(g => g.title === 'Erste Bank Open'), paris = atp.find(g => g.title === 'Rolex Paris Masters');
    const [race] = individual.normalize(json('nascar-2026-11-01.json'), 'NASCAR', 'racing/nascar-premier');
    const f1 = { id: 'espn:racing/f1:1', league: 'F1', start: NOW + 2 * H, end: null, title: 'Mexico City Grand Prix', session: 'Race', competitors: [], circuit: null,
        format: null, players: ['Lewis Hamilton', 'Max Verstappen'], snapshot: { state: 'scheduled', progress: {}, scores: null, situation: null } };
    const motogp = { id: 'motogp:1', league: 'MotoGP', start: NOW + 3 * H, end: null, title: 'Qatar · Race', session: 'Race', competitors: [], circuit: null,
        format: null, snapshot: { state: 'scheduled', progress: {}, scores: null, situation: null } };
    s.ingest([vienna, paris, race, f1, motogp], NOW - 100000);
    const someone = vienna.players.find(p => !paris.players.includes(p));
    const motor = ['Lewis Hamilton', 'Denny Hamlin', 'Marc Márquez'];
    const r = dashboard.buildDashboard(s, { now: NOW, userId: '1', timezone: 'Australia/Melbourne', events: [], upcomingHours: 72, guideCards: false,
        leagues: new Set(['ATP Tour', 'NASCAR', 'F1', 'MotoGP']),
        teams: { 'ATP Tour': [someone.toUpperCase().normalize('NFD').replace(/\p{M}/gu, '')], NASCAR: motor, F1: motor, MotoGP: motor } });
    const card = (id) => r.games.find(g => g.id === id);
    assert.ok(card(paris.id), 'the Paris Masters began yesterday and runs on: it is on today\'s page');
    assert.equal(card(vienna.id).followed, true, 'a name in the draw, any case or accents');
    assert.equal(card(paris.id).followed, false);
    assert.deepEqual(r.followMatches[race.id].map(m => m.name), ['Denny Hamlin'], 'a race is followed for the drivers in its entry list');
    assert.deepEqual(r.followMatches[f1.id].map(m => m.name), ['Lewis Hamilton']);
    assert.deepEqual(r.followMatches[motogp.id].map(m => m.name), ['Marc Márquez'], 'no entry list: every name no other series lists');
    assert.ok(!JSON.stringify(r.games).includes(someone), 'the names a card lists never reach a client');
});

test('#197: the collector asks tennis and golf for this week (one answer serving a tour and its majors), UFC and racing by date', async () => {
    const s = store(), calls = [];
    const answers = { 'tennis/atp': 'tennis-atp-australian-open-2026.json', 'tennis/wta': 'tennis-wta-2026-01-25.json', 'golf/pga': 'golf-pga-2026-11-01.json',
        'mma/ufc': 'ufc-2026-10-31.json' };
    const fetchJson = async (url, options) => {
        calls.push({ url, maxBytes: options?.maxBytes });
        const path = /sports\/(\w+\/[\w-]+)\/scoreboard/.exec(url)[1];
        return json(answers[path]);
    };
    const c = dashboard.createCollector({ store: s, fetchJson, clock: () => NOW, enabled: () => true,
        leagues: () => new Set(['Grand Slams', 'ATP Tour', 'WTA Tour', 'Majors', 'PGA Tour', 'UFC']), feedGames: async () => ({ ok: true, games: [] }) });
    await c.refresh(); c.stop();
    const urls = calls.map(x => x.url);
    assert.equal(urls.filter(u => u.endsWith('/tennis/atp/scoreboard')).length, 1, 'Grand Slams and ATP Tour share one answer');
    assert.equal(urls.filter(u => u.endsWith('/golf/pga/scoreboard')).length, 1);
    assert.ok(urls.some(u => /\/mma\/ufc\/scoreboard\?dates=\d{8}/.test(u)));
    assert.ok(calls.filter(x => x.url.includes('/tennis/')).every(x => x.maxBytes === individual.MAX_BYTES), 'a Grand Slam\'s answer is ~1.9 MB');
    const ids = s.catalog().map(g => `${g.league}|${g.id}`);
    assert.ok(ids.includes('Grand Slams|espn:tennis/atp:154-2026'));
    assert.ok(ids.includes("WTA Tour|espn:tennis/wta:1055-2026"));
    assert.ok(!ids.some(id => id.includes('tennis/wta:154-2026')), 'the Australian Open once, from ATP\'s feed');
    assert.ok(ids.includes('PGA Tour|espn:golf/pga:401850978') && !ids.some(id => id.startsWith('Majors|')));
    assert.ok(ids.includes('UFC|espn:mma/ufc:600061420'));
});
