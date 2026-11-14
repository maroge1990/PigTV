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

// Opus review of #296: a replay or highlights in another language ("Rediffusion", "Faits saillants") is not the game;
// English titles are read as before.
test('#296 review: replays and highlights named in French, Spanish or Portuguese never join; English is unchanged', () => {
    const classify = require('../server/services/sportsClassify');
    const { page: g, game } = pairs[0];
    const own = (title) => matchBroadcasts(catalog, [event(title, g, 0)]).get(game.id).length;
    assert.equal(own(french(g)), 1);
    for (const word of ['Rediffusion', 'En différé', 'En differe', 'Reprise', 'Repetición', 'Repeticion', 'Faits saillants', 'Résumé',
        'Resume', 'Resumen', 'Melhores momentos']) {
        const title = `${word} : ${french(g)}`;
        assert.equal(own(title), 0, title);
        assert.notEqual(classify.classifyKind({ title }).kind, 'event', title);
    }
    const a = teams.get(g.away.abbr), h = teams.get(g.home.abbr);
    assert.equal(classify.classifyKind({ title: `${a.full} at ${h.full}` }).kind, 'event');
    assert.equal(classify.classifyKind({ title: `${a.full} at ${h.full} (Replay)` }).kind, 'replay');
    assert.equal(classify.classifyKind({ title: `${a.name} v ${h.name} Highlights` }).kind, 'show');
    assert.equal(classify.classifyKind({ title: `NFL: ${a.name} v ${h.name} - Play Resumes` }).kind, 'event', 'not "resume"');
});

// Opus review of #296: a women's, under-age or reserve side's game is not the senior game of the same clubs.
test('#296 review: a women\'s, U21 or reserves title does not join the senior game; a women\'s game still joins its own', () => {
    const { page: g, game } = pairs[0];
    const own = (title) => matchBroadcasts(catalog, [event(title, g, 0)]).get(game.id).length;
    assert.equal(own(french(g)), 1);
    for (const tag of ['(Women)', "Women's", '(Femmes)', 'féminin', 'Mujeres', 'U21', 'U-19', 'Réserves', 'Reserves', 'Espoirs']) {
        assert.equal(own(`${french(g)} ${tag}`), 0, tag);
    }
    const start = Date.parse('2026-12-01T19:00:00Z');
    const side = (id, name, nick, abbr) => ({ id, name, aliases: [name, nick, abbr], logo: null });
    const wsl = [{ id: 'wsl:1', league: 'WSL', title: 'Arsenal Women v Chelsea Women', start,
        competitors: [side('1', 'Arsenal Women', 'Arsenal', 'ARS'), side('2', 'Chelsea Women', 'Chelsea', 'CHE')] }];
    const listing = { id: 'w', league: 'WSL', kind: 'event', title: 'Arsenal (Femmes) c. Chelsea (Femmes) en direct', start, end: start + 2 * 3600e3, channels: [] };
    assert.equal(matchBroadcasts(wsl, [listing]).get('wsl:1').length, 1, 'the women\'s game itself');
});

// Codex review of #296 (high): a team rule joins only its own team's games, a recording's link only the games near it; the
// nickname join must still see the rest of the league's catalogue, or a title naming another game's teams (or a name two
// clubs share) joins the part it was given.
const byAbbr = (away, home) => pairs.find(p => p.page.away.abbr === away && p.page.home.abbr === home);
const AFL_AT = Date.parse('2026-12-01T09:30:00Z');
const aflClub = (id, name, nick, abbr) => ({ id, name, aliases: [name, nick, abbr], logo: null });
const aflGames = (secondAt) => [
    { id: 'afl:1', league: 'AFL', title: 'Sydney Swans v Geelong Cats', start: AFL_AT, competitors: [aflClub('1', 'Sydney Swans', 'Swans', 'SYD'), aflClub('2', 'Geelong Cats', 'Cats', 'GEEL')] },
    { id: 'afl:2', league: 'AFL', title: 'Sydney Swans v Carlton Blues', start: secondAt, competitors: [aflClub('3', 'Sydney Swans', 'Swans', 'GCS'), aflClub('4', 'Carlton Blues', 'Blues', 'CARL')] }
];

test('#296 review: a team rule does not schedule a listing that also names another game, nor one by a shared nickname', async () => {
    const rules = require('../server/services/recordingRules');
    const { page: g, game } = byAbbr('GB', 'DET'), { page: other } = byAbbr('LAR', 'LV');
    assert.equal(other.start, g.start, 'the two games kick off together');
    const now = game.start - 6 * 3600e3;
    const listing = (title) => ({ ...event(title, g, 0), channels: [{ sourceId: 1, id: 'pos_4', name: 'RDS' }] });
    const lions = { sport: 'American football', match: 'Detroit Lions', created_by: null };
    assert.equal((await rules.teamCandidates(lions, now, { games: catalog, events: [listing(french(g))] })).length, 1, 'its own French listing');
    assert.deepEqual(await rules.teamCandidates(lions, now, { games: catalog, events: [listing(`${french(g)} et ${french(other)}`)] }), [],
        'a listing that also names the Rams and the Raiders');

    const cats = { sport: 'Australian football', match: 'Geelong Cats', created_by: null };
    const swans = { id: 'x', league: 'AFL', kind: 'event', title: 'Les Swans de Sydney c. les Cats de Geelong', start: AFL_AT - 15 * M,
        end: AFL_AT + 3 * 3600e3, channels: [{ sourceId: 1, id: 'pos_5', name: 'Fox Footy' }] };
    assert.deepEqual(await rules.teamCandidates(cats, AFL_AT - 6 * 3600e3, { games: aflGames(AFL_AT + 24 * 3600e3), events: [swans] }), [],
        '"Swans" names two clubs, though the other plays tomorrow');
});

test('#296 review: a recording\'s game link does not take a title that also names a later game, nor a shared nickname', () => {
    const guideEnd = require('../server/services/recordingGuideEnd');
    const { page: g, game } = byAbbr('GB', 'DET'), { page: later } = byAbbr('KC', 'SEA');
    assert.ok(later.start - g.start > 3 * 3600e3, 'the other game is not near the recording');
    const schedule = (title, start) => ({ id: 7, title, program_start: start, program_end: start + 3 * 3600e3, status: 'scheduled' });
    assert.equal(guideEnd.gameFor(schedule(french(g), g.start), catalog)?.id, game.id, 'its own French title');
    assert.equal(guideEnd.gameFor(schedule(`${french(g)}, puis ${french(later)}`, g.start), catalog), null);
    assert.equal(guideEnd.gameFor(schedule('Les Swans de Sydney c. les Cats de Geelong', AFL_AT), aflGames(AFL_AT + 4 * 3600e3)), null);
});
