const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// #21 (0388, C-T): the page of any other ESPN team league, from ESPN's free feeds as captured on 31 Oct 2026 18:40
// (Melbourne): the AFL's 2026 Grand Final (round mode: ESPN reports week 5 of the postseason, after the Preliminary
// Finals) and its ladder; the EPL's Saturday (day mode: ESPN reports no rounds) and table; the NBA's Thursday, Friday and
// Saturday nights (US) - Melbourne's yesterday, today and tomorrow - and its conferences; the NRL's Grand Final; and an
// A-League Saturday with a game in its second half. The old code has no such page.
const lp = require('../server/services/sportPageLeague');
const fixture = (name) => JSON.parse(JSON.stringify(require(path.join(__dirname, 'fixtures/espn/league', `${name}.json`))));
const NOW = Date.parse('2026-10-31T07:40:00Z'); // 18:40 in Melbourne
const ZONE = 'Australia/Melbourne';
let asked;

// What ESPN answered, by URL; anything else is a failed request (as ESPN's 400 for date ranges).
const ROUTES = [
    [/afl\/scoreboard$/, 'afl-scoreboard'], [/afl\/scoreboard\?seasontype=3&week=4&dates=2026$/, 'afl-week4'], [/afl\/standings$/, 'afl-standings'],
    [/rugby-league\/3\/scoreboard$/, 'nrl-scoreboard'], [/rugby-league\/3\/scoreboard\?seasontype=2&week=3&dates=2026$/, 'nrl-week3'],
    [/eng\.1\/scoreboard$/, 'epl-scoreboard'], [/eng\.1\/scoreboard\?dates=(20261029|20261030|20261101)&limit=100$/, 'epl-$1'], [/eng\.1\/standings$/, 'epl-standings'],
    [/nba\/scoreboard$/, 'nba-scoreboard'], [/nba\/scoreboard\?dates=(20261029|20261031|20261101)&limit=100$/, 'nba-$1'], [/nba\/standings$/, 'nba-standings'],
    [/aus\.1\/scoreboard$/, 'aleague-scoreboard']
];
function stub(overrides = {}) {
    asked = [];
    lp.fetcher.get = async (url) => {
        asked.push(url);
        for (const [re, answer] of Object.entries(overrides)) if (new RegExp(re).test(url)) return typeof answer === 'function' ? answer(url) : answer;
        for (const [re, name] of ROUTES) {
            const m = re.exec(url);
            if (m) return { ok: true, json: fixture(name.replace('$1', m[1] || '')) };
        }
        return { ok: false, error: 'HTTP 400' };
    };
}
beforeEach(() => { lp.reset(); stub(); });

test('the leagues: every ESPN team league but F1, NFL and cricket\'s IPL and BBL, by canonical name', () => {
    assert.deepEqual(lp.LEAGUES, ['AFL', 'NBA', 'MLB', 'NHL', 'WNBA', 'NBL', 'NRL', 'Super Rugby', 'EPL', 'Championship', 'FA Cup', 'UEFA',
        'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'MLS', 'A-League']);
    assert.equal(lp.leagueOf('Super Rugby'), 'Super Rugby');
    assert.equal(lp.leagueOf('afl'), 'AFL');
    for (const no of ['NFL', 'F1', 'IPL', 'BBL', 'Cricket', 'Quidditch', '', null]) assert.equal(lp.leagueOf(no), null, String(no));
});

test('AFL (round mode): the Preliminary Finals, then the Grand Final, named by ESPN\'s calendar; the ladder as P W L D Pts %', async () => {
    const { value: p } = await lp.build('AFL', NOW, { zone: ZONE });
    assert.equal(p.available, true);
    assert.equal(p.league, 'AFL');
    assert.equal(p.sport, 'australian-football');
    assert.deepEqual(p.season, { year: 2026, type: 'postseason', label: '2026' });
    assert.deepEqual(p.rounds.map(r => [r.key, r.label, r.current, r.games.length]), [['3:4', 'Preliminary Finals', false, 2], ['3:5', 'Grand Final', true, 1]]);
    assert.ok(asked.some(u => /seasontype=3&week=4&dates=2026$/.test(u)), 'the previous round by season type and number');
    assert.equal(asked.filter(u => /scoreboard/.test(u)).length, 2, 'no next round after the Grand Final');
    const gf = p.rounds[1].games[0];
    assert.deepEqual(gf, { id: '1133711', start: Date.parse('2026-09-26T04:30Z'), status: 'done', detail: 'Final',
        home: { id: '1', abbr: 'FRE', score: '89' }, away: { id: '11', abbr: 'BL', score: '96' }, venue: 'MCG', competition: null, channels: [] });
    const ladder = p.standings.groups;
    assert.equal(ladder.length, 1);
    assert.equal(ladder[0].name, null, 'a single table has no name');
    assert.deepEqual(ladder[0].columns.map(c => c.label), ['P', 'W', 'L', 'D', 'Pts', '%']);
    assert.deepEqual(ladder[0].rows[0], { id: '1', abbr: 'FRE', rank: 1, values: { played: '23', wins: '19', losses: '4', draws: '0', points: '76', percentage: '137.200' } });
    assert.equal(ladder[0].rows.length, 18);
    assert.equal(Object.keys(p.teams).length, 18);
    assert.deepEqual(Object.keys(p.teams['1']), ['id', 'abbr', 'name', 'full', 'location', 'color', 'logo'], 'keyed by ESPN team id');
    assert.equal(p.teams['1'].abbr, 'FRE');
});

test('round mode: a regular round is "Round N"; the next round is fetched and shown once the current one is over', async () => {
    const sb = fixture('afl-scoreboard');
    sb.season = { type: 2, year: 2026 };
    sb.week = { number: 20 };
    for (const e of sb.events) { e.week = { number: 20 }; e.season = { type: 2, year: 2026 }; }
    const round = (n, state) => { const j = fixture('afl-week4'); for (const e of j.events) { e.week = { number: n }; e.season = { type: 2, year: 2026 };
        e.competitions[0].status.type = { state, name: state === 'pre' ? 'STATUS_SCHEDULED' : 'STATUS_FINAL', completed: state === 'post' }; } return j; };
    stub({ 'afl/scoreboard$': { ok: true, json: sb }, 'week=19': { ok: true, json: round(19, 'post') }, 'week=21': { ok: true, json: round(21, 'pre') } });
    let p = (await lp.build('AFL', NOW, { zone: ZONE })).value;
    assert.deepEqual(p.rounds.map(r => [r.label, r.current]), [['Round 19', false], ['Round 20', true], ['Round 21', false]]);
    assert.deepEqual(p.rounds[2].games.map(g => [g.status, g.detail, g.home.score]), [['scheduled', null, null], ['scheduled', null, null]]);
    // With a game of round 20 still to come, round 21 is neither fetched nor shown.
    sb.events[0].competitions[0].status.type = { state: 'pre', name: 'STATUS_SCHEDULED', completed: false };
    stub({ 'afl/scoreboard$': { ok: true, json: sb }, 'week=19': { ok: true, json: round(19, 'post') }, 'week=21': { ok: true, json: round(21, 'pre') } });
    p = (await lp.build('AFL', NOW, { zone: ZONE })).value;
    assert.deepEqual(p.rounds.map(r => r.label), ['Round 19', 'Round 20']);
    assert.ok(!asked.some(u => /week=21/.test(u)));
    assert.equal(lp.ttlOf(p, NOW), 60 * 60e3, 'an hour: the scheduled game is months away');
});

test('NRL: ESPN\'s finals weeks keep their names; a postseason ESPN files as season type 2 still reads as postseason', async () => {
    const p = (await lp.build('NRL', NOW, { zone: ZONE })).value;
    assert.equal(p.sport, 'rugby-league');
    assert.equal(p.season.type, 'postseason');
    assert.deepEqual(p.rounds.map(r => [r.label, r.current, r.games.length]), [['Finals Week 3', false, 2], ['Grand Final', true, 1]]);
    assert.equal(p.standings, null, 'the standings request failed: no table, and still a page');
});

test('EPL (day mode, no rounds from ESPN): the local days around today, the US-Eastern days asked for; the table as P W D L GD Pts', async () => {
    const p = (await lp.build('EPL', NOW, { zone: ZONE })).value;
    assert.equal(p.sport, 'soccer');
    assert.deepEqual(p.season, { year: 2026, type: null, label: '2026-27 English Premier League' });
    assert.deepEqual(asked.filter(u => /scoreboard\?dates/.test(u)).map(u => /dates=(\d+)/.exec(u)[1]), ['20261029', '20261030', '20261101'],
        'Melbourne\'s 30 Oct - 1 Nov overlaps four US-Eastern days; the default scoreboard is the fourth (31 Oct)');
    // Saturday 12:30 in London is 23:30 in Melbourne (today); the 15:00 kick-offs are tomorrow, after today's game is over.
    assert.deepEqual(p.rounds.map(r => [r.key, r.label, r.current, r.games.length]), [['2026-10-31', 'Today', true, 1]]);
    const g = p.rounds[0].games[0];
    assert.deepEqual([g.home.abbr, g.away.abbr, g.status, g.detail, g.home.score, g.away.score, g.venue], ['CHE', 'MAN', 'scheduled', null, null, null, 'Stamford Bridge']);
    const table = p.standings.groups[0];
    assert.deepEqual(table.columns.map(c => [c.key, c.label]), [['played', 'P'], ['wins', 'W'], ['draws', 'D'], ['losses', 'L'], ['diff', 'GD'], ['points', 'Pts']]);
    assert.deepEqual(table.rows[0], { id: '382', abbr: 'MNC', rank: 1, values: { played: '8', wins: '7', draws: '0', losses: '1', diff: '+11', points: '21' } });
    assert.equal(lp.ttlOf(p, NOW), 10 * 60e3, 'a game day: kick-off within 12 h');
});

test('NBA (day mode): yesterday, today (all over) and so tomorrow, by Melbourne day; conferences as W L PCT GB', async () => {
    const p = (await lp.build('NBA', NOW, { zone: ZONE })).value;
    assert.equal(p.sport, 'basketball');
    assert.deepEqual(p.season, { year: 2027, type: 'regular', label: '2026-27' });
    assert.deepEqual(p.rounds.map(r => [r.key, r.label, r.current, r.games.length]),
        [['2026-10-30', 'Yesterday', false, 3], ['2026-10-31', 'Today', true, 10], ['2026-11-01', 'Tomorrow', false, 7]]);
    assert.ok(p.rounds[1].games.every(g => g.status === 'done' && g.detail === 'Final'));
    assert.ok(p.rounds.every(r => r.games.every((g, i, a) => !i || a[i - 1].start <= g.start)), 'by start');
    const wsh = p.rounds[1].games.find(g => g.home.abbr === 'WSH');
    assert.deepEqual([wsh.home.score, wsh.away.abbr, wsh.away.score], ['95', 'CHA', '79']);
    assert.deepEqual(p.standings.groups.map(g => [g.name, g.columns.map(c => c.label).join(' '), g.rows.length]),
        [['Eastern Conference', 'W L PCT GB', 15], ['Western Conference', 'W L PCT GB', 15]]);
    assert.deepEqual(p.standings.groups[0].rows.slice(0, 2).map(r => r.rank), [1, 2], 'by seed');
    assert.equal(asked.length, 5, '4 scoreboards (the default one and three US-Eastern days) and the standings');
});

test('statuses and details: live clock by sport, breaks, postponed and cancelled, results', () => {
    const al = fixture('aleague-scoreboard');
    const [ft, live, pre] = al.events.map(e => lp.gameOf(e, { family: 'soccer' }).game);
    assert.deepEqual([ft.status, ft.detail, ft.home.score, ft.away.score], ['done', 'FT', '0', '3']);
    assert.deepEqual([live.status, live.detail, live.home.score], ['live', "2nd Half 82'", '2']);
    assert.deepEqual([pre.status, pre.detail, pre.home.score, pre.away.score], ['scheduled', null, null, null]);
    const at = (family, status) => lp.gameOf({ ...al.events[1], competitions: [{ ...al.events[1].competitions[0], status }] }, { family }).game;
    assert.deepEqual([at('soccer', { period: 1, displayClock: "45'+2'", type: { state: 'in', name: 'STATUS_HALFTIME', shortDetail: 'HT' } })].map(g => [g.status, g.detail]), [['break', 'HT']]);
    assert.deepEqual(['basketball', 'australian-football'].map(f => at(f, { period: 3, displayClock: '5:21', type: { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: '5:21 - 3rd' } }).detail), ['Q3 5:21', 'Q3 5:21']);
    assert.equal(at('australian-football', { period: 1, displayClock: '0:00', type: { state: 'in', name: 'STATUS_END_PERIOD', shortDetail: 'Quarter Time' } }).status, 'break');
    assert.equal(at('australian-football', { period: 1, displayClock: '0:00', type: { state: 'in', name: 'STATUS_END_PERIOD', shortDetail: 'Quarter Time' } }).detail, 'Quarter Time');
    assert.equal(at('hockey', { period: 2, displayClock: '12:34', type: { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: '12:34 - 2nd' } }).detail, '2nd 12:34');
    assert.deepEqual(['status', 'detail'].map(k => at('baseball', { period: 5, displayClock: '0:00', type: { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: 'Top 5th' } })[k]), ['live', 'Top 5th']);
    assert.equal(at('rugby-league', { period: 2, displayClock: "67'", type: { state: 'in', name: 'STATUS_SECOND_HALF', shortDetail: "67'" } }).detail, "2nd Half 67'");
    const pp = at('soccer', { type: { state: 'post', name: 'STATUS_POSTPONED', description: 'Postponed', shortDetail: 'Postponed' } });
    assert.deepEqual([pp.status, pp.detail, pp.home.score], ['postponed', null, null]);
    assert.equal(at('soccer', { type: { state: 'post', name: 'STATUS_CANCELED', description: 'Canceled' } }).status, 'cancelled');
    assert.equal(at('basketball', { type: { state: 'post', name: 'STATUS_FINAL', completed: true, shortDetail: 'Final/OT' } }).detail, 'Final · OT');
    assert.equal(at('soccer', { type: { state: 'post', name: 'STATUS_FINAL_PEN', completed: true, shortDetail: 'FT-Pens' } }).detail, 'FT · Pens');
    // Defensive: nothing missing throws.
    assert.equal(lp.gameOf({}, { family: 'soccer' }), null);
    assert.equal(lp.gameOf({ id: 1, date: 'x', competitions: [{}] }, { family: 'soccer' }), null);
});

// The dashboard's join (sportsDashboard.matchBroadcasts): both teams named, start within 90 min; one airing fitting two
// games joins neither.
test('channels come from the dashboard\'s game-guide join; an airing two games fit gives []', async () => {
    const built = await lp.build('NBA', NOW, { zone: ZONE });
    const join = built.join;
    const bos = join.find(g => g.competitors.some(c => c.aliases.includes('Boston Celtics')) && g.competitors.some(c => c.aliases.includes('Chicago Bulls')));
    const ch = (id) => ({ sourceId: 8, id, name: id, start: bos.start - 15 * 60e3, end: bos.start + 3 * 3600e3 });
    const at = (title, id, start = bos.start - 15 * 60e3) => ({ league: 'NBA', kind: 'event', title, start, end: start + 3.25 * 3600e3, channels: [ch(id)] });
    let map = lp.channelsForGames(join, [at('NBA: Chicago Bulls at Boston Celtics', 'espn'), at('NBA: Bulls v Celtics', 'espn2'),
        at('NBA: Celtics v Bulls (replay)', 'r', bos.start + 6 * 3600e3), { ...at('Bulls v Celtics', 'x'), league: 'NBL' }], { now: bos.start, observedAt: bos.start });
    assert.deepEqual(map.get(bos.id).map(c => c.id), ['espn', 'espn2'], 'by full name or nickname; another league or a later replay is not this game');
    const twins = [{ ...bos, id: 'a' }, { ...bos, id: 'b' }];
    map = lp.channelsForGames(twins, [at('NBA: Bulls v Celtics', 'espn')], { now: bos.start, observedAt: bos.start });
    assert.equal(map.get('a'), undefined, 'ambiguous: joins neither');
    assert.equal(map.get('b'), undefined);
});

test('page(): kept per league, refreshed once stale; channels and following per request; ESPN down is not available', async () => {
    let calls = 0;
    const deps = { channelsFor: async (games) => { calls++; return new Map([[games[0].id, [{ sourceId: 1, id: 'a' }]]]); }, zone: ZONE,
        followed: () => ['brisbane lions'] };
    const first = await lp.page('AFL', NOW, deps);
    assert.deepEqual(first.rounds[0].games[0].channels, [{ sourceId: 1, id: 'a' }]);
    assert.ok(first.rounds.flatMap(r => r.games).slice(1).every(g => Array.isArray(g.channels) && !g.channels.length));
    assert.equal(first.following, '11', 'the household\'s followed name, matched case-insensitively, as the team id (BL)');
    const n = asked.length;
    await lp.page('AFL', NOW + 30 * 60e3, { ...deps, followed: () => ['Nobody', 'FRE'] });
    assert.equal(asked.length, n, 'within the hour: no ESPN request');
    assert.equal((await lp.page('AFL', NOW + 31 * 60e3, { ...deps, followed: () => ['FRE'] })).following, '1', 'by abbreviation, read per request');
    assert.equal(calls, 3, 'channels are attached to each request');
    assert.equal(lp.ttlOf({ rounds: [{ games: [{ status: 'break', start: NOW }] }] }, NOW), 2 * 60e3);

    // Each league has its own entry: fetching the AFL never answers the NRL, nor evicts it.
    const nrl = await lp.page('NRL', NOW, deps);
    assert.equal(nrl.league, 'NRL');
    assert.deepEqual(nrl.rounds.map(r => r.label), ['Finals Week 3', 'Grand Final']);
    const afterNrl = asked.length;
    assert.equal((await lp.page('AFL', NOW + 32 * 60e3, deps)).league, 'AFL');
    assert.equal(asked.length, afterNrl, 'the AFL is still cached');

    lp.reset();
    stub({ scoreboard: { ok: false, error: 'HTTP 503' } });
    assert.deepEqual(await lp.page('EPL', NOW, deps), { available: false });
});

test('standings are asked for at most hourly; a failed refresh keeps the last good table', async () => {
    const deps = { zone: ZONE };
    const p1 = await lp.page('EPL', NOW, deps); // a game day: 10 min
    assert.equal(asked.filter(u => /standings/.test(u)).length, 1);
    await lp.page('EPL', NOW + 11 * 60e3, deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(asked.filter(u => /standings/.test(u)).length, 1, 'refreshed scoreboards, the same table');
    stub({ standings: { ok: false, error: 'HTTP 500' } });
    await lp.page('EPL', NOW + 70 * 60e3, deps);
    await new Promise(resolve => setImmediate(resolve));
    const p3 = await lp.page('EPL', NOW + 71 * 60e3, deps);
    assert.equal(asked.filter(u => /standings/.test(u)).length, 1, 'asked again after the hour');
    assert.deepEqual(p3.standings, p1.standings, 'the last good table');
});

// #191 (0386/0387): the overrun rule trusts the page's live status only while its ESPN answer is at most 15 min old.
test('#191: a live game keeps an overrun channel only while the last good ESPN answer is at most 15 min old', async () => {
    const live = fixture('nba-scoreboard');
    const ev = live.events.find(e => e.competitions[0].competitors.some(c => c.team.abbreviation === 'BOS'));
    ev.competitions[0].status = { period: 4, displayClock: '2:10', type: { state: 'in', name: 'STATUS_IN_PROGRESS', completed: false, shortDetail: '2:10 - 4th' } };
    stub({ 'nba/scoreboard$': { ok: true, json: live } });
    const start = Date.parse(ev.date);
    const at = start + 3 * 3600e3; // on past its 2.5 h slot
    const airing = { league: 'NBA', kind: 'event', title: 'NBA: Chicago Bulls at Boston Celtics', start: start - 15 * 60e3, end: start + 2.5 * 3600e3,
        channels: [{ sourceId: 1, id: 'espn', start: start - 15 * 60e3, end: start + 2.5 * 3600e3 }] };
    const deps = (now) => ({ zone: ZONE, channelsFor: async (games, observedAt) => lp.channelsForGames(games, [airing], { now, observedAt }) });
    const channelsAt = async (now) => (await lp.page('NBA', now, deps(now))).rounds.flatMap(r => r.games).find(g => g.id === ev.id).channels;
    const first = await lp.page('NBA', at, deps(at));
    const game = first.rounds.flatMap(r => r.games).find(g => g.id === ev.id);
    assert.deepEqual([game.status, game.detail], ['live', 'Q4 2:10']);
    assert.deepEqual(game.channels.map(c => [c.id, c.end, c.overrun]), [['espn', at + 10 * 60e3, true]], 'fresh: extended');
    stub({ scoreboard: { ok: false, error: 'HTTP 503' }, standings: { ok: false, error: 'HTTP 503' } });
    const later = at + 14 * 60e3;
    assert.deepEqual((await channelsAt(later)).map(c => [c.id, c.end, c.overrun]), [['espn', later + 10 * 60e3, true]], 'within 15 min');
    await new Promise(resolve => setImmediate(resolve)); // let the failed refresh settle
    assert.deepEqual(await channelsAt(at + 16 * 60e3), [], 'the cached live status is too old to keep renewing Watch');
});

// UEFA merges two competitions, whose clubs can share an abbreviation: teams are keyed by ESPN's id, so both survive.
test('two teams sharing an abbreviation (UEFA): both survive, each game and table row names its own by id', async () => {
    const team = (id, abbr, name) => ({ id, abbreviation: abbr, displayName: name, shortDisplayName: name, name, location: name, color: '112233',
        logo: `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png` });
    const sb = (comp, home, away) => ({ day: { date: '2026-10-31' }, season: { type: 1, year: 2026 }, leagues: [{ season: { year: 2026, displayName: '2026-27' } }],
        events: [{ id: comp, date: '2026-10-31T09:00Z', competitions: [{ date: '2026-10-31T09:00Z', status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
            competitors: [{ homeAway: 'home', score: '0', team: home }, { homeAway: 'away', score: '0', team: away }] }] }] });
    const table = (rows) => ({ children: [{ name: 'League Phase', standings: { entries: rows.map((t, i) => ({ team: { ...t, logos: [{ href: t.logo }] },
        stats: [{ name: 'rank', value: i + 1, displayValue: String(i + 1) }, { name: 'points', value: 9 - i, displayValue: String(9 - i) }] })) } }] });
    const marseille = team('176', 'MAR', 'Marseille'), maribor = team('2604', 'MAR', 'Maribor');
    const psg = team('160', 'PSG', 'Paris Saint-Germain'), roma = team('104', 'ROM', 'Roma');
    stub({ 'champions/scoreboard$': { ok: true, json: sb('cl1', marseille, psg) }, 'europa/scoreboard$': { ok: true, json: sb('el1', maribor, roma) },
        'champions/standings': { ok: true, json: table([psg, marseille]) }, 'europa/standings': { ok: true, json: table([maribor, roma]) } });
    const p = (await lp.build('UEFA', NOW, { zone: ZONE })).value;
    assert.equal(p.teams['176'].full, 'Marseille');
    assert.equal(p.teams['2604'].full, 'Maribor');
    assert.deepEqual(Object.values(p.teams).filter(t => t.abbr === 'MAR').map(t => t.id).sort(), ['176', '2604']);
    const games = p.rounds.flatMap(r => r.games);
    assert.deepEqual(games.map(g => [g.competition, g.home.id, g.home.abbr]).sort(), [['Champions League', '176', 'MAR'], ['Europa League', '2604', 'MAR']]);
    assert.deepEqual(p.standings.groups.map(g => [g.name, g.rows.map(r => r.id)]), [['Champions League', ['160', '176']], ['Europa League', ['2604', '104']]]);
    assert.equal(lp.followingOf(p.teams, ['Maribor']), '2604');
});

// 0389 (0388 Codex round 1, medium): the cached table kept only the teams the games had not already named, so a team that
// left the scoreboard window vanished from `teams` while its standings row stayed.
test('a reused table still resolves every row through `teams` once its teams leave the scoreboard window; following stays set', async () => {
    const deps = { zone: ZONE, followed: () => ['Chelsea'] };
    const first = await lp.page('EPL', NOW, deps);
    assert.equal(first.following, '363');
    const empty = (url) => { const j = fixture('epl-scoreboard'); j.events = []; return { ok: true, json: j }; };
    stub({ 'eng\\.1/scoreboard': empty }); // no games anywhere around the next refresh; the table is under an hour old
    await lp.page('EPL', NOW + 11 * 60e3, deps);
    await new Promise(resolve => setImmediate(resolve));
    const p = await lp.page('EPL', NOW + 12 * 60e3, deps);
    assert.deepEqual(p.rounds, []);
    assert.ok(!asked.some(u => /standings/.test(u)), 'the table was reused');
    const rows = p.standings.groups.flatMap(g => g.rows);
    assert.equal(rows.length, 20);
    assert.deepEqual(rows.filter(r => !p.teams[r.id]).map(r => r.abbr), [], 'every row\'s team is in `teams`');
    assert.equal(p.teams['363'].full, 'Chelsea');
    assert.equal(p.following, '363');
});
