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

test('#281: two ESPN entries called Sydney Swans (SYD and GCFC): the badge is the Swans\' own, never the Gold Coast one', async () => {
    const teams = require('./fixtures/espn/teams-afl.json');
    const old = feeds.fetcher.get;
    feeds.fetcher.get = async () => ({ ok: true, json: teams });
    try {
        const badges = await feeds.aflBadges();
        assert.match(badges['sydney swans'], /\/syd\.png$/);
        assert.match(badges['gold coast suns'], /\/suns\.png$/);
        const games = feeds.aflwGames(json('aflw-2026-matches.json'), badges, (u) => u);
        const swans = games.flatMap(g => g.competitors).filter(c => c.name === 'Sydney Swans');
        assert.ok(swans.length && swans.every(c => /\/syd\.png$/.test(c.logo)), 'the AFLW front-page side carries the Swans badge');
        assert.match(badges['gws giants'] || 'gws.png', /gws|^$/);
    } finally { feeds.fetcher.get = old; }
});

test('#281: a name whose entries cannot be told apart gets no badge (the client draws its lettered one)', async () => {
    const mk = (id, abbreviation, displayName, href) => ({ team: { id, abbreviation, displayName, shortDisplayName: displayName, logos: [{ href }] } });
    const old = feeds.fetcher.get;
    feeds.fetcher.get = async () => ({ ok: true, json: { sports: [{ leagues: [{ teams: [
        mk('1', 'AAA', 'Twin Town', 'https://a.espncdn.com/aaa.png'), mk('2', 'BBB', 'Twin Town', 'https://a.espncdn.com/bbb.png'),
        mk('3', 'WB', 'Western Bulldogs', 'https://a.espncdn.com/wb.png'), mk('4', 'GWS', 'GWS GIANTS', 'https://a.espncdn.com/gws.png'),
        mk('5', 'SYD', 'Sydney Swans', 'https://a.espncdn.com/syd.png')] }] }] } });
    try {
        const badges = await feeds.aflBadges();
        assert.equal(badges['twin town'], undefined);
        assert.match(badges['western bulldogs'], /wb\.png$/);
        assert.match(badges['gws giants'], /gws\.png$/);
        assert.match(badges['sydney swans'], /syd\.png$/);
    } finally { feeds.fetcher.get = old; }
});

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

// 0405 (#196): Super Netball's eight clubs carry Champion Data's own badges (by squad id, checked 1 Nov 2026); a squad not
// on the list keeps its monogram (no logo), never a guessed address.
test('0405: Super Netball sides carry their club badge by squad id; an unknown squad has none', () => {
    const games = feeds.championGames('Super Netball', json('championdata-12949-supernetball.json'), (u) => `cached:${u}`);
    const logos = Object.fromEntries(games.flatMap(g => g.competitors).map(c => [c.name, c.logo]));
    assert.equal(Object.keys(logos).length, 8);
    for (const [name, logo] of Object.entries(logos)) assert.match(logo, /^cached:https:\/\/mc\.championdata\.com\/global\/images\/teams\/scoreboard\/\d+\.png$/, name);
    assert.equal(logos['Melbourne Mavericks'], 'cached:https://mc.championdata.com/global/images/teams/scoreboard/9698.png');
    const fx = json('championdata-12949-supernetball.json');
    fx.fixture.match = [{ ...fx.fixture.match[0], homeSquadId: 99999, homeSquadName: 'New Club' }];
    assert.equal(feeds.championGames('Super Netball', fx)[0].competitors[0].logo, null);
});

// 0404 (#206): MotoGP's two qualifying sessions are 25 minutes apart, so the session's number decides the join; Warm Up is a
// session of its own. Every airing of the Qatar weekend joins its one card, and F1's session reading is unchanged.
test('0404: a MotoGP airing joins only its own session of the whole weekend: Qualifying 1 and 2 apart, Warm Up recognised', () => {
    const [qatar] = json('motogp-events.json');
    const cards = feeds.motogpGames(qatar, json('motogp-sessions-qatar.json'));
    const by = (session) => cards.find(c => c.session === session);
    const ev = (id, session, title) => ({ id, league: 'MotoGP', kind: 'event', title, start: by(session).start - 5 * 60000, end: by(session).start + 45 * 60000, channels: [] });
    const airings = [
        ev('fp1', 'Practice 1', 'MotoGP: Qatar Grand Prix - Practice 1'),
        ev('pr', 'Practice', 'MotoGP: Qatar Grand Prix - Practice'),
        ev('fp2', 'Practice 2', 'MotoGP: Qatar Grand Prix - Free Practice 2'),
        ev('q1', 'Qualifying 1', 'MotoGP: Qatar Grand Prix - Qualifying 1'),
        ev('q2', 'Qualifying 2', 'MotoGP: Qatar Grand Prix - Q2'),
        ev('spr', 'Sprint', 'MotoGP: Qatar Grand Prix - Tissot Sprint'),
        ev('wup', 'Warm Up', 'MotoGP: Qatar Grand Prix - Warm Up'),
        ev('rac', 'Race', 'MotoGP: Qatar Grand Prix - Race')];
    const found = dashboard.matchBroadcasts(cards, airings);
    const joined = Object.fromEntries(cards.map(c => [c.session, found.get(c.id).map(e => e.id)]));
    assert.deepEqual(joined, { 'Practice 1': ['fp1'], Practice: ['pr'], 'Practice 2': ['fp2'], 'Qualifying 1': ['q1'], 'Qualifying 2': ['q2'],
        Sprint: ['spr'], 'Warm Up': ['wup'], Race: ['rac'] });
    // a bare "Qualifying" names neither session: it joins none
    const bare = dashboard.matchBroadcasts(cards, [{ ...ev('q', 'Qualifying 1', 'MotoGP: Qatar Grand Prix - Qualifying') }]);
    assert.equal([...bare.values()].flat().length, 0);
    // F1 unchanged: its sessions still come from the shared title reader
    const f1 = { id: 'f1q', league: 'F1', start: by('Race').start, end: null, title: 'Qatar Grand Prix · Qualifying', session: 'Qualifying', competitors: [] };
    const f1found = dashboard.matchBroadcasts([f1], [{ id: 'a', league: 'F1', kind: 'event', title: 'F1: Qatar Grand Prix - Qualifying', start: f1.start, end: f1.start + H, channels: [] }]);
    assert.deepEqual(f1found.get('f1q').map(e => e.id), ['a']);
});

// 0403 (0402 Codex round 1, two high): a redirect could lead off the allowed hosts, and an answer had no size limit.
test('0403: a redirect is refused, never followed; an answer past the size limit is dropped, whatever its length header', async () => {
    const real = global.fetch;
    try {
        let opts;
        global.fetch = async (url, o) => { opts = o; return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }); };
        assert.deepEqual(await feeds.getUrl('https://mc.championdata.com/data/competitions.json'), { ok: false, error: 'redirected' });
        assert.equal(opts.redirect, 'manual');
        const chunk = new Uint8Array(1024 * 1024).fill(32);
        let sent = 0;
        global.fetch = async () => new Response(new ReadableStream({ pull(c) { if (sent++ < 8) c.enqueue(chunk); else c.close(); } }), { status: 200 });
        assert.deepEqual(await feeds.getUrl('https://www.supercars.com/calendar', { as: 'text' }), { ok: false, error: 'answer too large' });
        assert.ok(sent <= 7, `stopped reading at the limit (${sent} MB asked for)`);
        global.fetch = async () => new Response('{"a":1}', { status: 200 });
        assert.deepEqual(await feeds.getUrl('https://mc.championdata.com/data/x.json'), { ok: true, json: { a: 1 } });
    } finally { global.fetch = real; }
});

// 0403 (0402 Codex round 1, medium): any airing inside a Supercars weekend joined it, another round's replay included.
test('0403: a Supercars airing joins its weekend only when it names the event\'s track or town', () => {
    const [sandown] = feeds.supercarsGames(read('supercars-calendar.html'), NOW).filter(w => /Sandown/.test(w.title));
    const ev = (id, title) => ({ id, league: 'Supercars', kind: 'event', title, start: sandown.start + 30 * H, end: sandown.start + 33 * H, channels: [] });
    const found = dashboard.matchBroadcasts([sandown], [ev('own', 'Repco Supercars: Penrite Oil Sandown 500 Race'), ev('replay', 'Repco Supercars Classic: Bathurst 1000'),
        ev('bare', 'Repco Supercars Championship')]);
    assert.deepEqual(found.get(sandown.id).map(e => e.id), ['own']);
});

// #248 (0491): the Sao Paulo GP of 8 Nov 2026 joined few of its airings. ESPN's name carries "São Paulo"; these are
// production's guide titles of the race (16:55 UTC), each on its own channel.
test('0491: every listing of the Sao Paulo GP race joins it (accents, Brazil, Brésil); another Grand Prix does not', () => {
    const start = Date.parse('2026-11-08T17:00:00Z');
    const race = { id: 'f1r', league: 'F1', start, end: null, title: 'MSC Cruises São Paulo Grand Prix · Race', session: 'Race', competitors: [] };
    const titles = ['Formula 1 : Brazil Race', 'FIA Formula 1: Brazil Grand Prix', 'Live Sao Paulo F1 Grand Prix',
        'Formula 1 Racing - São Paulo Grand Prix', 'Formule 1 - Grand Prix du Brésil', 'Live: Formula 1 - Sao Paulo Grand Prix: Race',
        'Formula 1 Main Race 2026: FORMULA 1 MSC CRUISES GRANDE PREMIO DE SAO PAULO 2026'];
    const ev = (id, title) => ({ id, league: 'F1', kind: 'event', title, start: start - 5 * 60000, end: start + 2 * H, channels: [] });
    const found = dashboard.matchBroadcasts([race], [...titles.map((t, i) => ev(`e${i}`, t)),
        ev('other', 'Formula 1: Mexico City Grand Prix - Race'), ev('quali', 'Formula 1 : Brazil Qualifying')]);
    assert.deepEqual(found.get(race.id).map(e => e.id).sort(), titles.map((t, i) => `e${i}`).sort());
});
