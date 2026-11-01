const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

// #198 (D-41 point 2): the other competitions a followed team plays in, suggested until the account adds them or says
// "No thanks". Football from ESPN's schedule of the club across competitions (Arsenal's, captured 1 Nov 2026, trimmed
// to date, name and league), other sports from the collector's cards. The old code suggests nothing.
const suggestions = require('../server/services/sportSuggestions');
const prefs = require('../server/services/sportPagePrefs');
const schedule = require(path.join(__dirname, 'fixtures/espn/soccer-all-team-359-schedule.json'));
const NOW = Date.parse('2026-11-01T06:00Z');
const databases = [];
after(() => databases.forEach(db => db.close()));
const fresh = () => { const db = new Database(':memory:'); databases.push(db); return db; };
const arsenal = { id: '359', name: 'Arsenal', aliases: ['Arsenal', 'ARS'], logo: null };
const card = (id, league, start, sides) => ({ id, league, start, title: sides.map(s => s.name).join(' v '), competitors: sides });

test('#198: a followed club\'s other competitions are suggested, with its first fixture there; "No thanks" is remembered', async () => {
    const db = fresh();
    prefs.setFollows(7, { sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] }, db);
    // the FA Cup's third round (January) as ESPN would list it once drawn: one event's league changed for the test
    const answer = JSON.parse(JSON.stringify(schedule));
    answer.events.find(e => e.date > '2027-01-08').league.slug = 'eng.fa';
    const asked = [];
    const fetchJson = async (url) => { asked.push(url); return answer; };
    const games = [card('espn:soccer/eng.1:1', 'EPL', NOW + 10 * 3600000, [{ id: '364', name: 'Liverpool', aliases: ['Liverpool'] }, arsenal])];
    suggestions._schedules.clear();
    const got = await suggestions.suggestions(7, { db, now: NOW, games, fetchJson });
    assert.deepEqual(got.map(s => [s.sport, s.team, s.league, s.label]), [['Football', 'Arsenal', 'Champions League', 'Champions League'], ['Football', 'Arsenal', 'FA Cup', 'FA Cup']]);
    assert.equal(got[0].start, Math.min(...answer.events.filter(e => e.league.slug === 'uefa.champions').map(e => Date.parse(e.date))));
    assert.deepEqual(asked, ['https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?fixture=true'], 'the club\'s id from the cards');
    suggestions.decline(7, { team: 'arsenal', league: 'Champions League' }, db);
    assert.deepEqual((await suggestions.suggestions(7, { db, now: NOW, games, fetchJson })).map(s => s.league), ['FA Cup'], 'remembered, any case');
    assert.equal(asked.length, 1, 'the schedule is kept for a while');
    // added to the follows: no longer suggested
    prefs.setFollows(7, { sports: [{ sport: 'Football', leagues: ['EPL', 'FA Cup'], teams: ['Arsenal'] }] }, db);
    assert.deepEqual(await suggestions.suggestions(7, { db, now: NOW, games, fetchJson }), []);
    // another account has its own "No thanks"
    prefs.setFollows(8, { sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] }, db);
    assert.deepEqual((await suggestions.suggestions(8, { db, now: NOW, games, fetchJson })).map(s => s.league), ['Champions League', 'FA Cup']);
    assert.throws(() => suggestions.decline(7, { team: 'Arsenal', league: 'Nope' }, db), /catalogue league/);
});

test('#198: other sports from the collector\'s cards: an upcoming game in a league of the same sport not picked', async () => {
    const db = fresh();
    prefs.setFollows(9, { sports: [{ sport: 'Rugby union', leagues: ['Six Nations'], teams: ['Ireland'] }] }, db);
    const ireland = { id: '3', name: 'Ireland', aliases: ['Ireland', 'IRE'] }, nz = { id: '8', name: 'New Zealand', aliases: ['New Zealand', 'NZ'] };
    const games = [card('espn:rugby/1:1', 'Rugby World Cup', NOW + 86400000, [ireland, nz]),
        card('espn:rugby/1:2', 'Rugby World Cup', NOW - 86400000, [ireland, nz]), // played: not a reason to suggest
        card('espn:rugby/2:3', 'Super Rugby', NOW + 86400000, [nz, { id: '9', name: 'Fiji', aliases: ['Fiji'] }]),
        card('espn:soccer/x:4', 'EPL', NOW + 86400000, [{ id: '1', name: 'Ireland', aliases: ['Ireland'] }, arsenal])];
    const fetchJson = async () => assert.fail('only football asks ESPN');
    const got = await suggestions.suggestions(9, { db, now: NOW, games, fetchJson });
    assert.deepEqual(got.map(s => [s.league, s.start]), [['Rugby World Cup', NOW + 86400000]], 'its own sport only, fixtures to come');
});
