const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// 0428 (C-V, #197, D-43): the tennis, golf, UFC, IndyCar and NASCAR pages, from ESPN's free feeds as captured on
// 1 Nov 2026 about 09:00 UTC (test/fixtures/espn-events, trimmed to the fields read): the WTA's Guangzhou final in its
// first set (4–5) and Chennai's qualifying; the ATP's Paris Masters; the PGA Tour's Mexico Open after round 3 (its
// scoreboard and its leaderboard); the UFC night of 31 Oct and the next one; NASCAR's Martinsville week; IndyCar's season
// over (its last race 6 Sep). The old code has no such page.
const pe = require('../server/services/sportPageEvents');
const fx = (name, dir = 'espn-events') => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf8'));
const NOW = Date.parse('2026-11-01T09:30:00Z');
const MIN = 60000, H = 60 * MIN;
let asked;

const ROUTES = [
    [/tennis\/wta\/scoreboard$/, 'tennis-wta-2026-11-01'], [/tennis\/atp\/scoreboard$/, 'tennis-atp-2026-11-01'],
    [/golf\/pga\/scoreboard$/, 'golf-pga-scoreboard-2026-11-01'], [/golf\/leaderboard\?league=pga$/, 'golf-pga-leaderboard-2026-11-01'],
    [/mma\/ufc\/scoreboard\?dates=20261029-20261108$/, 'ufc-2026-10-29-2026-11-08'],
    [/nascar-premier\/scoreboard$/, 'nascar-scoreboard-2026-11-01'], [/nascar-premier\/scoreboard\?dates=20261029-20261108$/, 'nascar-2026-10-29-2026-11-08'],
    [/nascar-premier\/scoreboard\?dates=20261024-20261026$/, 'nascar-2026-10-25'], [/nascar-premier\/scoreboard\?dates=20261107-20261109$/, 'nascar-2026-11-08'],
    [/irl\/scoreboard$/, 'irl-scoreboard-2026-11-01'], [/irl\/scoreboard\?dates=20260905-20260907$/, 'irl-2026-09-06']
];
function stub(overrides = {}) {
    asked = [];
    pe.fetcher.get = async (url) => {
        asked.push(url);
        for (const [re, answer] of Object.entries(overrides)) if (new RegExp(re).test(url)) return typeof answer === 'function' ? answer(url) : answer;
        for (const [re, name] of ROUTES) if (re.test(url)) return { ok: true, json: fx(name) };
        if (/irl\/scoreboard\?dates=/.test(url)) return { ok: true, json: { events: [] } };
        return { ok: false, error: 'HTTP 400' };
    };
}
beforeEach(() => { pe.reset(); stub(); });
const KEYS = ['id', 'name', 'start', 'end', 'status', 'venue', 'followed'];

test('leagues: the five sports\' catalogue leagues, any case; anything else is null', () => {
    assert.deepEqual(pe.LEAGUES, ['Grand Slams', 'ATP Tour', 'WTA Tour', 'Majors', 'PGA Tour', 'DP World Tour', 'LIV', 'LPGA', 'UFC', 'IndyCar', 'NASCAR']);
    assert.equal(pe.leagueOf('wta tour'), 'WTA Tour');
    assert.equal(pe.leagueOf(' UFC '), 'UFC');
    for (const no of ['EPL', 'F1', 'MotoGP', 'Tennis', '', null, undefined, ['UFC']]) assert.equal(pe.leagueOf(no), null, String(no));
});

test('tennis: every match flat with its draw, round, court, players in order (seed, country, winner) and set scores; draws by round', async () => {
    const p = await pe.page('WTA Tour', NOW, { names: ['Harriet Dart', 'peangtarn plipuech'] });
    assert.deepEqual(Object.keys(p), ['available', 'league', 'sport', 'kind', 'updatedAt', 'events']);
    assert.deepEqual([p.available, p.league, p.sport, p.kind, p.updatedAt], [true, 'WTA Tour', 'Tennis', 'tennis', NOW]);
    assert.deepEqual(p.events.map(e => [e.id, e.name, e.status]), [['espn:tennis/wta:232-2026', 'Guangzhou Open', 'live'], ['espn:tennis/wta:889-2026', 'Chennai Open', 'live']],
        'the C-R cards\' ids and states');
    const [gz, chennai] = p.events;
    for (const k of [...KEYS, 'matches', 'draws']) assert.ok(k in gz, k);
    assert.deepEqual(gz.venue, { name: 'Guangzhou, China PR', city: 'Guangzhou', country: 'China PR' });
    const final = gz.matches.find(m => m.round === 'Final');
    // The live check (D-43): the set in play is in the linescores, games so far; no point score or server.
    assert.deepEqual(final, { id: final.id, draw: "Women's Singles", round: 'Final', start: Date.parse('2026-11-01T08:35Z'), status: 'live', court: 'Center Court',
        players: [{ name: 'Lilli Tagger', seed: 4, country: 'Austria', winner: null }, { name: 'Harriet Dart', seed: null, country: 'Great Britain', winner: null }],
        sets: [[5, 4]] });
    const semi = gz.matches.find(m => m.draw === "Women's Singles" && m.round === 'Semifinal');
    assert.deepEqual(semi.sets, [[7, 5], [6, 7], [0, 6]], 'sets by player, in the players\' order');
    assert.deepEqual(semi.players.map(x => [x.name, x.winner]), [['Xinran Sun', false], ['Harriet Dart', true]]);
    const doubles = gz.matches.find(m => m.draw === "Women's Doubles" && m.round === 'Quarterfinal');
    assert.deepEqual(doubles.players[0], { name: 'Mariia Kozyreva / Maia Lumsden', seed: 1, country: null, winner: false }, 'a pair: names joined, the seed; a country only when both share it');
    assert.equal(gz.matches.find(m => m.round === 'Semifinal' && m.draw === "Women's Doubles").players[1].country, 'Chinese Taipei');
    assert.deepEqual(gz.matches.map(m => m.start), gz.matches.map(m => m.start).slice().sort((a, b) => a - b), 'matches by start');
    assert.deepEqual(gz.draws.map(d => [d.name, d.rounds.map(r => r.name)]), [["Women's Singles", ['Round 2', 'Quarterfinal', 'Semifinal', 'Final']], ["Women's Doubles", ['Quarterfinal', 'Semifinal']]]);
    assert.deepEqual(gz.draws[0].rounds[3].matchIds, [final.id]);
    assert.ok(gz.draws.every(d => d.rounds.every(r => r.matchIds.every(id => gz.matches.some(m => m.id === id)))));
    // A walkover: finished, its winner, no sets. A retirement: finished with the sets as they stood. Scheduled: no sets, no
    // winner, the court when ESPN has one.
    const wo = gz.matches.find(m => m.round === 'Round 2');
    assert.deepEqual([wo.status, wo.sets, wo.players.map(x => [x.name, x.winner])], ['finished', null, [['Claire Liu', true], ['Katerina Siniakova', false]]]);
    const ret = chennai.matches.find(m => m.round === 'Qualifying 1st Round');
    assert.deepEqual([ret.status, ret.sets, ret.players.map(x => x.winner)], ['finished', [[1, 6], [1, 2]], [false, true]]);
    const later = chennai.matches.filter(m => m.status === 'scheduled');
    assert.ok(later.length >= 3 && later.every(m => m.sets === null && m.players.every(x => x.winner === null)));
    assert.ok(later.some(m => m.court === null));
    assert.deepEqual(chennai.draws[0].rounds.map(r => r.name), ['Qualifying 1st Round', 'Qualifying Final', 'Round 1'], 'qualifying before the main draw');
    // Followed: the account's names found in the event, as the event spells them (accents and case aside), a doubles player too.
    assert.deepEqual(gz.followed, ['Harriet Dart']);
    assert.deepEqual(chennai.followed, ['Peangtarn Plipuech']);
    assert.equal(JSON.stringify(p).includes('espncdn'), false, 'no ESPN image addresses (flags are country names)');
    assert.equal(JSON.stringify(p).includes('players":["'), false, 'the internal name list never leaves');
});

test('tennis: a player not drawn yet is null; ATP Tour leaves a major out and Grand Slams takes only it', async () => {
    const atp = await pe.page('ATP Tour', NOW);
    const paris = atp.events.find(e => e.name === 'Rolex Paris Masters');
    assert.equal(paris.status, 'break');
    assert.equal(paris.breakLabel, 'Between matches');
    const r2 = paris.matches.find(m => m.draw === "Men's Singles" && m.round === 'Round 2');
    assert.deepEqual(r2.players.map(x => x.name), [null, null], 'TBD is no name');
    assert.equal(paris.matches.find(m => m.draw === "Men's Doubles" && m.round === 'Round 2').players.find(x => x.seed === 1).name, 'Harri Heliovaara / Henry Patten');
    assert.deepEqual(paris.matches.find(m => m.round === 'Qualifying 1st Round').sets, [[1, 6], [6, 7]], 'a tiebreak set is its games');
    assert.deepEqual(paris.draws[0].rounds.map(r => r.name), ['Qualifying 1st Round', 'Round 1', 'Round 2']);
    pe.reset();
    stub({ 'tennis/atp/scoreboard$': () => ({ ok: true, json: fx('tennis-atp-australian-open-2026', 'espn-individual') }) });
    assert.deepEqual((await pe.page('ATP Tour', NOW)).events, []);
    const slams = await pe.page('Grand Slams', NOW);
    assert.deepEqual(slams.events.map(e => e.name), ['Australian Open']);
    assert.deepEqual(slams.events[0].draws.map(d => d.name), ["Women's Singles", "Men's Singles", "Men's Doubles", "Women's Doubles", 'Mixed Doubles'], 'men\'s and women\'s draws together');
});

test('golf: the whole field in position order, positions and cuts from the leaderboard, each round\'s strokes; a round in play is null', async () => {
    const p = await pe.page('PGA Tour', NOW, { names: ['Ben Griffin'] });
    assert.deepEqual([p.sport, p.kind], ['Golf', 'golf']);
    const [mx] = p.events;
    assert.deepEqual([mx.id, mx.name, mx.status, mx.breakLabel, mx.round], ['espn:golf/pga:401850978', 'VidantaWorld Mexico Open', 'break', 'Round 3 complete', 3]);
    for (const k of [...KEYS, 'round', 'leaderboard']) assert.ok(k in mx, k);
    assert.deepEqual(mx.leaderboard.slice(0, 4), [
        { pos: '1', name: 'Andrew Novak', country: 'USA', toPar: '-23', rounds: [67, 61, 62, null], status: null },
        { pos: '2', name: 'Matthieu Pavon', country: 'France', toPar: '-17', rounds: [65, 66, 65, null], status: null },
        { pos: '3', name: 'Doug Ghim', country: 'USA', toPar: '-16', rounds: [65, 68, 64, null], status: null },
        { pos: 'T4', name: 'Pierceson Coody', country: 'USA', toPar: '-15', rounds: [65, 69, 64, null], status: null }]);
    assert.deepEqual(mx.leaderboard.slice(-2), [{ pos: null, name: 'Eli Ortego', country: 'USA', toPar: '+4', rounds: [71, 75, null, null], status: 'cut' },
        { pos: null, name: 'Billy Horschel', country: 'USA', toPar: 'E', rounds: [null, null, null, null], status: 'cut' }]);
    assert.deepEqual(mx.followed, ['Ben Griffin']);
    assert.ok(asked.some(u => /golf\/leaderboard\?league=pga$/.test(u)));
    assert.equal(/tee|hole|thru/i.test(JSON.stringify(mx.leaderboard)), false, 'no tee times or hole (D-43)');

    // Round 4 under way: Novak's nine holes so far are not a round's strokes.
    pe.reset();
    const sb = fx('golf-pga-scoreboard-2026-11-01');
    const novak = sb.events[0].competitions[0].competitors[0];
    novak.linescores.push({ value: 33, displayValue: '-3', period: 4, linescores: Array.from({ length: 9 }, (_, i) => ({ value: 4, period: i + 1 })) });
    stub({ 'golf/pga/scoreboard$': { ok: true, json: sb }, 'golf/leaderboard': { ok: false, error: 'HTTP 503' } });
    const without = (await pe.page('PGA Tour', NOW)).events[0];
    assert.deepEqual(without.leaderboard[0].rounds, [67, 61, 62, null]);
    assert.ok(without.leaderboard.every(r => r.pos === null && r.status === null), 'without the leaderboard, no position or cut is worked out');
    assert.equal(without.leaderboard.length, 8, 'the field still');
});

test('UFC: the bouts in the feed\'s order, the main card the ones that start last, each finished bout\'s winner, round and clock', async () => {
    const p = await pe.page('UFC', NOW, { names: ['Lucia Szabova', 'Tom Nolan'] });
    assert.deepEqual([p.sport, p.kind], ['Combat', 'fight']);
    assert.deepEqual(p.events.map(e => [e.id, e.status]), [['espn:mma/ufc:600061420', 'finished'], ['espn:mma/ufc:600061268', 'scheduled']]);
    const [night, next] = p.events;
    for (const k of [...KEYS, 'bouts']) assert.ok(k in night, k);
    assert.deepEqual(night.venue, { name: 'Meta APEX', city: 'Las Vegas', country: 'USA' });
    assert.deepEqual(night.bouts.map(b => [b.weightClass, b.card]), [['W Flyweight', 'prelims'], ['W Strawweight', 'prelims'], ['Welterweight', 'main'], ['Lightweight', 'main']]);
    assert.deepEqual(night.bouts[3], { id: '401921310', start: Date.parse('2026-11-01T00:00Z'), status: 'finished', weightClass: 'Lightweight', card: 'main',
        fighters: [{ name: 'Renato Moicano', winner: false }, { name: 'Tom Nolan', winner: true }], result: { round: 3, clock: '1:28' } });
    assert.deepEqual(night.followed, ['Lucia Szabová', 'Tom Nolan'], 'as the card spells them');
    assert.deepEqual(next.bouts.map(b => [b.card, b.status, b.result, b.fighters.map(f => f.winner)]),
        [['prelims', 'scheduled', null, [null, null]], ['main', 'scheduled', null, [null, null]]]);
    assert.equal(/method|record|decision|kotko/i.test(JSON.stringify(p)), false, 'no method or record (D-43)');
    // One start time for every bout: all of it is the main card.
    pe.reset();
    const one = fx('ufc-2026-10-29-2026-11-08');
    for (const b of one.events[0].competitions) b.date = '2026-11-01T00:00Z';
    stub({ 'mma/ufc/scoreboard': { ok: true, json: one } });
    assert.deepEqual((await pe.page('UFC', NOW)).events[0].bouts.map(b => b.card), ['main', 'main', 'main', 'main']);
});

test('NASCAR: the entry list alphabetical, the last winner from the calendar\'s race by its day, the next race with its own time', async () => {
    const p = await pe.page('NASCAR', NOW, { names: ['Kyle Larson'] });
    assert.deepEqual([p.sport, p.kind], ['Motorsport', 'race']);
    assert.deepEqual(Object.keys(p), ['available', 'league', 'sport', 'kind', 'updatedAt', 'events', 'lastWinner', 'next']);
    const [mart] = p.events;
    assert.deepEqual([mart.id, mart.status, mart.start], ['espn:racing/nascar-premier:202611010020', 'scheduled', Date.parse('2026-11-01T19:00Z')]);
    assert.deepEqual(mart.entryList, [{ name: 'Austin Cindric' }, { name: 'Denny Hamlin' }, { name: 'Joey Logano' }, { name: 'Kyle Larson' }, { name: 'Ty Gibbs' }]);
    assert.deepEqual(mart.followed, ['Kyle Larson']);
    assert.deepEqual(p.lastWinner, { name: 'Kyle Larson', race: 'NASCAR Cup Series at Talladega', date: Date.parse('2026-10-25T18:00Z') });
    assert.deepEqual(p.next, { name: 'NASCAR Cup Series at Martinsville', start: Date.parse('2026-11-01T19:00Z') }, 'this week\'s, at its own time (the calendar says 22:00)');
    assert.ok(asked.some(u => /dates=20261024-20261026$/.test(u)), 'the last race asked for by its days');

    // The day after: Martinsville won, so it is the last winner, and the next race (Miami) is asked for by its day.
    pe.reset();
    const week = fx('nascar-2026-10-29-2026-11-08');
    const race = week.events[0];
    race.status = race.competitions[0].status = { type: { name: 'STATUS_FINAL', state: 'post', completed: true } };
    race.competitions[0].competitors[2].winner = true;
    stub({ 'nascar-premier/scoreboard\\?dates=20261030-20261109$': { ok: true, json: week } });
    const after = await pe.page('NASCAR', Date.parse('2026-11-02T09:30Z'));
    assert.deepEqual(after.lastWinner, { name: 'Kyle Larson', race: 'NASCAR Cup Series at Martinsville', date: Date.parse('2026-11-01T19:00Z') });
    assert.deepEqual(after.next, { name: 'NASCAR Cup Series at Miami', start: Date.parse('2026-11-08T20:00Z') }, 'the race\'s own time, not the calendar\'s 23:00');
    assert.equal(/running|standing|practice|number|team/i.test(JSON.stringify(after)), false, 'nothing the feed lacks (D-43)');
});

test('IndyCar after its season: no event this week, the last race\'s winner, no next race; quiet, so kept an hour', async () => {
    const p = await pe.page('IndyCar', NOW);
    assert.deepEqual(p.events, []);
    assert.deepEqual(p.lastWinner, { name: 'Scott McLaughlin', race: 'Grand Prix of Monterey', date: Date.parse('2026-09-06T18:30Z') });
    assert.equal(p.next, null);
    const n = asked.length;
    await pe.page('IndyCar', NOW + 30 * MIN);
    assert.equal(asked.length, n, 'kept');
    await pe.page('IndyCar', NOW + 61 * MIN);
    await new Promise(r => setImmediate(r));
    assert.ok(asked.length > n, 'asked again after an hour');
});

test('0428 Codex round 1: a quiet answer is never kept past the next start, so play is not missed for an hour', async () => {
    const first = await pe.page('NASCAR', NOW);
    const start = [...first.events.map(e => e.start), first.next?.start].filter(t => Number.isFinite(t) && t > NOW).sort((a, b) => a - b)[0];
    assert.ok(start, 'the sample has a start to come');
    pe.reset();
    await pe.page('NASCAR', start - MIN);
    const n = asked.length;
    await pe.page('NASCAR', start + 30 * MIN);
    await new Promise(r => setImmediate(r));
    assert.ok(asked.length > n, 'asked again once the event has started');
});

test('cache: 10 min while an event is on; a stale answer is served while one refresh runs; a failed refresh keeps the last good one', async () => {
    await pe.page('WTA Tour', NOW);
    const n = asked.length;
    assert.equal(n, 1);
    await pe.page('WTA Tour', NOW + 9 * MIN);
    assert.equal(asked.length, n, 'fresh for 10 min while a tournament is on');
    let release;
    stub({ 'tennis/wta': () => new Promise(resolve => { release = () => resolve({ ok: false, error: 'HTTP 503' }); }) });
    const stale = await pe.page('WTA Tour', NOW + 11 * MIN);
    assert.equal(stale.updatedAt, NOW, 'the stale answer, at once');
    await pe.page('WTA Tour', NOW + 12 * MIN);
    assert.equal(asked.length, 1, 'one refresh at a time');
    release();
    await new Promise(r => setImmediate(r));
    const kept = await pe.page('WTA Tour', NOW + 13 * MIN);
    assert.equal(kept.available, true);
    assert.equal(kept.events.length, 2, 'the last good answer stays');
    // Leagues are kept apart: the ATP is asked for itself.
    stub();
    await pe.page('ATP Tour', NOW + 13 * MIN);
    assert.deepEqual(asked.map(u => u.replace(/.*sports\//, '')), ['tennis/atp/scoreboard']);
});

test('available: false when ESPN cannot answer and nothing is kept; nothing is fetched until a page is asked for', async () => {
    assert.equal(asked.length, 0);
    stub({ '.': { ok: false, error: 'timed out' } });
    for (const league of ['WTA Tour', 'PGA Tour', 'UFC', 'NASCAR']) assert.deepEqual(await pe.page(league, NOW), { available: false }, league);
    // A cold request waits only so long.
    pe.reset();
    pe.tuning.coldWaitMs = 20;
    try {
        stub({ '.': () => new Promise(() => {}) });
        assert.deepEqual(await pe.page('LPGA', NOW), { available: false });
    } finally { pe.tuning.coldWaitMs = pe.TUNING.coldWaitMs; }
});

test('route: GET /api/sports/pages/events: the flag, signed in only, 400 outside the five sports, the account\'s followed names', async (t) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-events-page-'));
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    const load = p => require(path.join(sandbox, 'server', p));
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-events-page-key-at-least-32-characters';
    process.env.PIGTV_DB_BACKUPS = '0';
    delete process.env.PIGTV_SPORT_FIXTURES;
    const auth = load('auth'), db = load('db');
    const token = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    const sandboxed = load('services/sportPageEvents');
    const urls = [];
    sandboxed.fetcher.get = async (url) => { urls.push(url); return /mma\/ufc\/scoreboard\?dates=/.test(url) ? { ok: true, json: fx('ufc-2026-10-29-2026-11-08') } : { ok: false, error: 'HTTP 404' }; };
    const app = express(); app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    t.after(async () => {
        try { load('services/sportsEvents').shutdown(); } catch { /* never started */ }
        await new Promise(r => server.close(r));
        load('db/sqlite').getDb().close();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { auth: withToken = true, body } = {}) => {
        const r = await fetch(base + route, { method: body ? 'PUT' : 'GET', headers: { ...(withToken ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) };
    };
    assert.equal((await call('/api/info')).body.features.sportPageEvents, true);
    assert.equal((await call('/api/sports/pages/events?league=UFC', { auth: false })).status, 401);
    for (const bad of ['', '?league=EPL', '?league=F1', '?league=Tennis', '?league[]=UFC']) {
        const r = await call(`/api/sports/pages/events${bad}`);
        assert.equal(r.status, 400, bad);
        assert.match(r.body.error, /league/);
    }
    assert.equal(urls.length, 0, 'a refused league asks ESPN nothing');
    assert.equal((await call('/api/sports/follows', { body: { sports: [{ sport: 'Combat', leagues: ['UFC'], teams: ['Tom Nolan'] }] } })).status, 200);
    const r = await call('/api/sports/pages/events?league=ufc');
    assert.equal(r.status, 200);
    assert.match(r.cache, /no-store/);
    assert.deepEqual([r.body.available, r.body.league, r.body.kind], [true, 'UFC', 'fight']);
    assert.deepEqual(r.body.events.map(e => e.followed), [['Tom Nolan'], []]);
    // Another account's follows never show: the cached answer carries none.
    const other = auth.generateToken(await db.users.create({ username: 'other', role: 'viewer' }));
    const theirs = await fetch(`${base}/api/sports/pages/events?league=UFC`, { headers: { authorization: `Bearer ${other}` } }).then(x => x.json());
    assert.deepEqual(theirs.events.map(e => e.followed), [[], []]);
    assert.equal(urls.length, 1, 'one ESPN request for both');
    process.env.PIGTV_SPORT_FIXTURES = '0';
    try {
        assert.equal((await call('/api/info')).body.features.sportPageEvents, false);
        assert.equal((await call('/api/sports/pages/events?league=UFC')).status, 404);
    } finally { delete process.env.PIGTV_SPORT_FIXTURES; }
});
