// #296: the shared game↔guide join (sportsDashboard.matchBroadcasts, used by the Sport front page, the League pages, the
// recording rules and a recording's game link) found no channel for a game whose guide title is only in another language
// ("Packers de Green Bay c. Bears de Chicago", as RDS lists a game), where the NFL page's own matcher (sportPageNFL
// .channelsForGames, unchanged) does. The shared join now also accepts a title naming both teams by a nickname of theirs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const espn = require('../server/services/sportsScoresEspn');
const nfl = require('../server/services/sportPageNFL');
const { matchBroadcasts } = require('../server/services/sportsDashboard');

const M = 60000;
// The NFL fixtures' 28 games (weeks 7 and 8), read by both: the collector's catalogue for the shared join, the NFL page's
// games and teams for its matcher. The trimmed fixtures have no competition id: the event's stands in.
const fixture = (name) => {
    const json = JSON.parse(JSON.stringify(require(path.join(__dirname, 'fixtures/espn/nfl', name))));
    for (const e of json.events) e.competitions[0].id ??= e.id;
    return json;
};
const catalog = [], pageGames = [], teams = new Map();
for (const week of ['scoreboard-week7.json', 'scoreboard-week8.json']) {
    catalog.push(...espn.normalize(fixture(week), 'NFL', 'football/nfl'));
    for (const e of fixture(week).events) pageGames.push(nfl.gameOf(e, teams, (u) => u));
}
const pairs = pageGames.map(g => ({ page: g, game: catalog.find(c => c.id.endsWith(`:${g.id}`)) }));

// The guide title forms of batch D's comparison, for the game's away (a) and home (h) teams.
const FORMS = {
    nickname: (a, h) => `${a.name} at ${h.name}`,
    full: (a, h) => `${a.full} at ${h.full}`,
    'NFL: full vs': (a, h) => `NFL: ${a.full} vs ${h.full}`,
    'NFL Football - full': (a, h) => `NFL Football - ${a.full} at ${h.full}`,
    'home first': (a, h) => `${h.name} v ${a.name}`,
    abbreviation: (a, h) => `${a.abbr} @ ${h.abbr}`,
    'city only': (a, h) => `${a.location} at ${h.location}`,
    French: (a, h) => `${a.name} de ${a.location} c. ${h.name} de ${h.location}`,
    'French, RDS prefix': (a, h) => `Football NFL - ${a.name} de ${a.location} c. ${h.name} de ${h.location}`,
    'French sentence': (a, h) => `NFL : les ${a.name} de ${a.location} affrontent les ${h.name} de ${h.location}`,
    'show prefix': (a, h) => `Sunday Night Football: ${a.name} at ${h.name}`,
    'NFL Live: full': (a, h) => `NFL Live: ${a.full} at ${h.full}`,
    'dash between': (a, h) => `${a.name} – ${h.name}`,
    'Spanish, cities': (a, h) => `Fútbol americano NFL: ${a.location} vs. ${h.location} en vivo`,
    'one team': (a) => `NFL: ${a.full}`
};
const event = (title, game, i, { from = -15, to = 200 } = {}) => ({ id: `e${i}`, league: 'NFL', kind: 'event', title,
    start: game.start + from * M, end: game.start + to * M, channels: [{ sourceId: 1, id: `c${i}` }] });
// For each form: on how many of the 28 games each matcher finds the game's own airing, and whether either joins it to
// another game. One airing at a time, as each game's only one in the guide.
function compare(form, window) {
    let shared = 0, page = 0, wrong = 0;
    pairs.forEach(({ page: g, game }, i) => {
        const e = event(form(teams.get(g.away.abbr), teams.get(g.home.abbr)), g, i, window);
        for (const [id, on] of matchBroadcasts(catalog, [e])) if (on.length) id === game.id ? shared++ : wrong++;
        for (const [id] of nfl.channelsForGames(pageGames, [e], teams)) id === g.id ? page++ : wrong++;
    });
    return [shared, page, wrong];
}

test('#296: the fixture comparison of the shared join and the NFL page\'s matcher, each difference named', () => {
    assert.equal(pairs.length, 28);
    assert.ok(pairs.every(p => p.game), 'every page game is in the catalogue');
    // [shared join, NFL page, airings joined to another game]. Before #296 the shared join found French 0, French RDS
    // prefix 0, French sentence 0 and dash between 0 (each now 28); nothing else changed.
    const expected = {
        nickname: [28, 28, 0], full: [28, 28, 0], 'NFL: full vs': [28, 28, 0], 'NFL Football - full': [28, 28, 0],
        'home first': [28, 28, 0], 'show prefix': [28, 28, 0], 'NFL Live: full': [28, 28, 0],
        // the differences that stay: abbreviations the shared join only (not "SF @ ATL": "SF" reads as a semi-final);
        // city-only titles, in any language, and one team alone the NFL page only (not Los Angeles or New York, #183;
        // its one-team rule)
        abbreviation: [27, 0, 0], 'city only': [0, 27, 0], 'Spanish, cities': [0, 27, 0], 'one team': [0, 28, 0],
        // #296: names in another language, the nicknames kept
        French: [28, 28, 0], 'French, RDS prefix': [28, 28, 0], 'French sentence': [28, 28, 0], 'dash between': [28, 28, 0]
    };
    const got = Object.fromEntries(Object.entries(FORMS).map(([name, form]) => [name, compare(form)]));
    assert.deepEqual(got, expected);
});

test('#296: the timing differences that stay: the NFL page\'s 2-hour early coverage, the shared join\'s 75-minute late start', () => {
    assert.deepEqual(compare(FORMS.French, { from: -120, to: 120 }), [0, 28, 0], 'coverage from 2 h before kick-off: the NFL page only');
    assert.deepEqual(compare(FORMS.French, { from: 75, to: 240 }), [28, 0, 0], 'an airing from 75 min after kick-off: the shared join only');
});

const french = (g) => FORMS.French(teams.get(g.away.abbr), teams.get(g.home.abbr));
const joined = (games, events) => [...matchBroadcasts(games, events)].filter(([, on]) => on.length).map(([id, on]) => [id, on.map(e => e.id)]);

test('#296: every game\'s French airing at once, the same day\'s games side by side: each joins its own game only', () => {
    const events = pairs.map(({ page: g }, i) => event(french(g), g, i));
    assert.ok(pairs.some(p => pairs.filter(q => q.game.start === p.game.start).length >= 5), 'games share a kick-off');
    assert.deepEqual(joined(catalog, events), pairs.map(({ game }, i) => [game.id, [`e${i}`]]));
});

test('#296: no join for one team, a third team, a replay, another week, or a nickname two teams share', () => {
    const { page: g, game } = pairs[0];
    const own = (title, window) => matchBroadcasts(catalog, [event(title, g, 0, window)]).get(game.id).map(e => e.id);
    const a = teams.get(g.away.abbr), h = teams.get(g.home.abbr);
    const other = teams.get(pairs.find(p => ![g.away.abbr, g.home.abbr].includes(p.page.home.abbr)).page.home.abbr);
    assert.deepEqual(own(french(g)), ['e0'], 'the French title');
    assert.deepEqual(own(`${a.name} de ${a.location} : avant-match`), [], 'one team');
    assert.deepEqual(own(`${french(g)}, puis ${other.name} de ${other.location}`), [], 'a team outside the game');
    assert.deepEqual(own(`${french(g)} (replay)`), [], 'a replay');
    assert.deepEqual(own(`Highlights : ${french(g)}`), [], 'highlights');
    assert.deepEqual(own(french(g), { from: 7 * 1440, to: 7 * 1440 + 200 }), [], 'the same title a week later');
    assert.deepEqual(own(`${a.name.toUpperCase()} DE ${a.location.toUpperCase()} C. ${h.name.toUpperCase()} DE ${h.location.toUpperCase()}`), ['e0'], 'any case');

    // #281: ESPN's AFL list names two clubs "Sydney Swans": "Swans" names neither, so neither game joins by it
    const start = Date.parse('2026-09-26T09:30:00Z');
    const club = (id, name, nick, abbr) => ({ id, name, aliases: [name, nick, abbr], logo: null });
    const afl = [
        { id: 'afl:1', league: 'AFL', start, competitors: [club('1', 'Sydney Swans', 'Swans', 'SYD'), club('2', 'Geelong Cats', 'Cats', 'GEEL')] },
        { id: 'afl:2', league: 'AFL', start, competitors: [club('3', 'Sydney Swans', 'Swans', 'GCS'), club('4', 'Carlton Blues', 'Blues', 'CARL')] }
    ];
    const listing = (title) => ({ id: 'x', league: 'AFL', kind: 'event', title, start, end: start + 3 * 3600e3, channels: [] });
    assert.deepEqual(joined(afl, [listing('Les Swans de Sydney c. les Cats de Geelong')]), [], 'a nickname two teams share');
    // accents folded: Montréal's French name, spelt without its accent
    const nhl = [{ id: 'nhl:1', league: 'NHL', start, competitors: [club('8', 'Montréal Canadiens', 'Canadiens', 'MTL'), club('10', 'Toronto Maple Leafs', 'Maple Leafs', 'TOR')] }];
    assert.deepEqual(joined(nhl, [{ ...listing('Hockey LNH : Canadiens de Montreal c. Maple Leafs de Toronto'), league: 'NHL' }]), [['nhl:1', ['x']]]);
});

test('#296: a "Record every game" rule finds a channel for its team\'s game listed only in French', async () => {
    const rules = require('../server/services/recordingRules');
    const { page: g, game } = pairs.find(p => p.page.home.abbr === 'GB' || p.page.away.abbr === 'GB');
    const now = game.start - 6 * 3600e3;
    const rule = { sport: 'American football', match: 'Green Bay Packers', created_by: null };
    const airing = { ...event(french(g), g, 0), channels: [{ sourceId: 1, id: 'pos_4', name: 'RDS' }] };
    const found = await rules.teamCandidates(rule, now, { games: catalog, events: [airing] });
    assert.deepEqual(found.map(c => [c.gameId, c.channelId]), [[game.id, 'pos_4']]);
});
