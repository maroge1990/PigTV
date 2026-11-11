const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #272 (D-1): the fixture refresh and the score collector read the SAME ESPN scoreboards into two stores, each with its
// own normaliser (sportsFixturesEspn.recordsFromScoreboard -> sportsFixtures.toFixture, and sportsScoresEspn.normalize).
// This feeds every recorded scoreboard to both and lists every field where they disagree about the same game: the design
// input for making the collector's catalogue the only store (docs/architecture/sports.md, One store).
const fixturesEspn = require('../server/services/sportsFixturesEspn');
const scoresEspn = require('../server/services/sportsScoresEspn');
const fixtures = require('../server/services/sportsFixtures');

const FX = path.join(__dirname, 'fixtures/espn');
const SCOREBOARDS = [
    ['afl-20260926', 'AFL', 'australian-football/afl'], ['bbl-scoreboard', 'BBL', 'cricket/8044'],
    ['cricket-24377-20260927', 'Cricket', 'cricket/24377'], ['f1-scoreboard', 'F1', 'racing/f1'],
    ['ipl-scoreboard', 'IPL', 'cricket/8048'], ['mlb-20260927', 'MLB', 'baseball/mlb'], ['nba-20261003', 'NBA', 'basketball/nba'],
    ['nfl-20260927', 'NFL', 'football/nfl'], ['nfl/scoreboard-week7', 'NFL', 'football/nfl'], ['nfl/scoreboard-week8', 'NFL', 'football/nfl'],
    ['league/afl-scoreboard', 'AFL', 'australian-football/afl'], ['league/afl-week4', 'AFL', 'australian-football/afl'],
    ['league/aleague-scoreboard', 'A-League', 'soccer/aus.1'], ['league/epl-scoreboard', 'EPL', 'soccer/eng.1'],
    ['league/epl-20261101', 'EPL', 'soccer/eng.1'], ['league/nba-scoreboard', 'NBA', 'basketball/nba'],
    ['league/nrl-scoreboard', 'NRL', 'rugby-league/3'], ['league/nrl-week3', 'NRL', 'rugby-league/3']
];
const words = side => side.tokens.join(' ');

/** Every disagreement between the two normalisers for one scoreboard: { field: [example, ...] }. */
function disagreements(json, league, source) {
    const out = {};
    const add = (field, example) => (out[field] ||= []).push(example);
    const records = fixturesEspn.recordsFromScoreboard(json);
    const games = new Map(scoresEspn.normalize(json, league, source).map(g => [g.id, g]));
    const seen = new Set();
    for (const rec of records) {
        const id = `espn:${source}:${rec.id}`;
        const fixture = fixtures.toFixture(rec);
        const game = games.get(id);
        if (!game) { add(fixture ? 'only the fixture store keeps it (usable by the classifier)' : 'only the fixture store keeps it (unusable)', rec.id); continue; }
        seen.add(id);
        if (!fixture) { add('only the catalogue can use it', rec.id); continue; }
        if (game.start !== fixture.start) add('start', rec.id);
        if ((game.end ?? null) !== (fixture.end ?? null)) add('end (fixture: ESPN endDate of the competition, else the event; catalogue: the competition\'s, none for cricket)', rec.id);
        if (fixture.teamsAliases) {
            const fromCatalog = game.competitors.map(c => new Set([c.name, ...c.aliases].map(a => fixtures.teamAliasSides({ displayName: a })?.[0]).filter(Boolean).map(words)));
            fixture.teamsAliases.forEach((sides, i) => {
                const missing = sides.map(words).filter(w => !fromCatalog[i]?.has(w));
                if (missing.length) add('team names (the catalogue drops the location)', `${rec.id}: ${missing.join(', ')}`);
            });
        }
        if (fixture.session) {
            if (game.session !== fixture.session.label) add('session', rec.id);
            const location = game.title ? require('../server/services/sportsClassify').parseTitle(game.title).location : [];
            if (JSON.stringify(location) !== JSON.stringify(fixture.location)) add('location', rec.id);
        }
        if (rec.state === 'post' && game.snapshot.state !== 'finished' || rec.state === 'pre' && game.snapshot.state !== 'scheduled')
            add('status (the fixture keeps ESPN\'s raw state, read by nothing)', `${rec.id}: ${rec.state} / ${game.snapshot.state}`);
    }
    for (const id of games.keys()) if (!seen.has(id)) add('only the catalogue keeps it', id);
    return out;
}

test('the same scoreboard in both stores: where the fixture record and the collector\'s card disagree', () => {
    const all = {};
    for (const [file, league, source] of SCOREBOARDS) {
        const json = JSON.parse(fs.readFileSync(path.join(FX, `${file}.json`), 'utf8'));
        for (const [field, examples] of Object.entries(disagreements(json, league, source))) (all[field] ||= []).push(`${file}: ${examples.length} (${examples.slice(0, 2).join('; ')})`);
    }
    // The trimmed NFL week files have no competition id (real ESPN answers always carry one): the fixture store falls back to
    // the event id, the catalogue skips the competition.
    assert.deepEqual(all, {
        'end (fixture: ESPN endDate of the competition, else the event; catalogue: the competition\'s, none for cricket)': [
            'bbl-scoreboard: 1 (1545498)', 'cricket-24377-20260927: 1 (1535684)', 'f1-scoreboard: 5 (401839108; 401839109)', 'ipl-scoreboard: 1 (1535465)'],
        'team names (the catalogue drops the location)': [
            'bbl-scoreboard: 2 (1545498: australia; 1545498: australia)', 'cricket-24377-20260927: 2 (1535684: india; 1535684: australia)',
            'ipl-scoreboard: 2 (1535465: india; 1535465: india)', 'mlb-20260927: 8 (401817103: new york; 401817103: baltimore)',
            'nba-20261003: 2 (401902644: toronto; 401902644: miami)', 'nfl-20260927: 8 (401872953: buffalo; 401872953: los angeles)',
            'league/nba-scoreboard: 20 (401909277: washington; 401909277: charlotte)'],
        "status (the fixture keeps ESPN's raw state, read by nothing)": ['mlb-20260927: 1 (401817103: post / cancelled)'],
        'only the fixture store keeps it (usable by the classifier)': ['nfl/scoreboard-week7: 14 (401873010; 401873011)', 'nfl/scoreboard-week8: 14 (401873023; 401873026)']
    });
});
