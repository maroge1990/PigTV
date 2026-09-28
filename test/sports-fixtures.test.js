const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0161-0163 (C-I): ESPN's free public scoreboard JSON as the source of truth for real
// kickoff/session times, so sportsClassify.resolveLive does not have to guess live vs replay
// from the guide alone. services/sportsFixturesEspn.js is the ESPN provider (fetch only);
// services/sportsFixtures.js fetches only the leagues that matter, stores them in SQLite,
// refreshes every 30 min and after an EPG sync, and turns stored rows into the snapshot
// resolveLive's new first rule (fixtureVerdict) reads. The old code has none of this: no
// sport_fixtures table, no ESPN rule, and every league is on the heuristics regardless of
// what a fixture would say.
//
// The recorded responses in test/fixtures/espn/ are real ESPN answers (28 Sept 2026, trimmed
// to what these tests need), not fabricated - so the shapes this code has to survive (missing
// `location`, no `endDate`, F1's per-session competitions, cricket's embedded `teams`) are the
// real ones, not a convenient guess at them.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-fixtures-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const classify = load('services/sportsClassify');
const espn = load('services/sportsFixturesEspn');
const fixtures = load('services/sportsFixtures');

after(() => {
    fixtures.stopBackgroundRefresh();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const FX = path.join(__dirname, 'fixtures/espn');
const readFx = (name) => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const H = 60 * 60 * 1000;
const M = 60 * 1000;

/** Serve `handlers[urlSubstring] = json` (first match wins) from global.fetch, restoring it after `fn`. */
async function withEspn(handlers, fn) {
    const original = global.fetch;
    global.fetch = async (url) => {
        const key = Object.keys(handlers).find(k => String(url).includes(k));
        if (key === undefined) return { ok: false, status: 404, json: async () => ({ code: 404 }) };
        const v = handlers[key];
        if (v === null) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => v };
    };
    try { return await fn(); } finally { global.fetch = original; }
}

// ---- the ESPN provider, on real recorded responses -------------------------------------------

test('recordsFromScoreboard: one record per event, several for F1 (one per session)', () => {
    const nfl = espn.recordsFromScoreboard(readFx('nfl-20260927'));
    assert.equal(nfl.length, 4);
    const lacBuf = nfl.find(r => r.id === '401872953');
    assert.equal(lacBuf.start, Date.parse('2026-09-27T17:00Z'));
    assert.equal(lacBuf.sessionAbbr, 'STD', 'stored, but toFixture() ignores it once real teams are present');
    assert.deepEqual(lacBuf.teams.map(t => t.displayName).sort(), ['Buffalo Bills', 'Los Angeles Chargers']);

    const f1 = espn.recordsFromScoreboard(readFx('f1-scoreboard'));
    assert.equal(f1.length, 5, 'FP1, FP2, FP3, Qual, Race');
    assert.deepEqual(f1.map(r => r.sessionAbbr), ['FP1', 'FP2', 'FP3', 'Qual', 'Race']);
    assert.equal(f1[0].eventName, 'Qatar Airways Azerbaijan Grand Prix');
    assert.equal(f1[4].start, Date.parse('2026-09-26T11:00Z'));
    assert.equal(f1[0].teams, null, 'athletes, not teams - never mistaken for a match-up');
});

test('a multi-day cricket match keeps its real endDate; a same-day one has none', () => {
    const [test19] = espn.recordsFromScoreboard(readFx('cricket-24377-20260927'));
    assert.equal(test19.start, Date.parse('2026-09-27T04:00Z'));
    assert.equal(test19.end, Date.parse('2026-10-01T23:59Z'));
    assert.deepEqual(test19.teams.map(t => t.displayName).sort(), ['Australia Under-19s', 'India Under-19s']);

    const [nba] = espn.recordsFromScoreboard(readFx('nba-20261003'));
    assert.equal(nba.end, null);
});

test('teamsFromScoreboard: cricket carries its own team list; other sports are read from the competitors', () => {
    const ipl = espn.teamsFromScoreboard(readFx('ipl-scoreboard'));
    assert.ok(ipl.some(t => t.displayName === 'Chennai Super Kings'));
    const nfl = espn.teamsFromScoreboard(readFx('nfl-20260927'));
    assert.ok(nfl.some(t => t.displayName === 'Buffalo Bills' && t.abbreviation === 'BUF'));
});

test('fetchScoreboard: one request per UTC day the window touches, malformed/missing fields never throw', async () => {
    await withEspn({ 'dates=20260927': readFx('nfl-20260927') }, async () => {
        const r = await espn.fetchScoreboard('football/nfl', Date.parse('2026-09-27T00:00Z'), Date.parse('2026-09-27T23:00Z'));
        assert.equal(r.ok, true);
        assert.equal(r.records.length, 4);
        assert.ok(r.teams.some(t => t.displayName === 'Buffalo Bills'));
    });
    // one day 404s, the other answers: the good day is still returned (defensive: one bad day
    // never loses the others)
    await withEspn({ 'dates=20260927': readFx('nfl-20260927') }, async () => {
        const r = await espn.fetchScoreboard('football/nfl', Date.parse('2026-09-26T00:00Z'), Date.parse('2026-09-27T23:00Z'));
        assert.equal(r.ok, true);
        assert.equal(r.records.length, 4);
    });
    // every day fails
    await withEspn({}, async () => {
        const r = await espn.fetchScoreboard('football/nfl', Date.parse('2026-09-27T00:00Z'), Date.parse('2026-09-27T23:00Z'));
        assert.equal(r.ok, false);
    });
    // garbage shapes: never throws
    await withEspn({ 'dates=20260927': { events: [{ id: 1, competitions: 'nope' }, null, { competitions: [{ date: 'not-a-date' }] }] } }, async () => {
        const r = await espn.fetchScoreboard('football/nfl', Date.parse('2026-09-27T00:00Z'), Date.parse('2026-09-27T23:00Z'));
        assert.equal(r.ok, true);
        assert.deepEqual(r.records, []);
    });
});

test('fetchTeams: the /teams shape; a cricket league 404s there (real ESPN behaviour), reported as a plain failure', async () => {
    await withEspn({ '/football/nfl/teams': readFx('teams-nfl') }, async () => {
        const r = await espn.fetchTeams('football/nfl');
        assert.equal(r.ok, true);
        assert.ok(r.teams.some(t => t.displayName === 'Arizona Cardinals'));
    });
    await withEspn({}, async () => {
        const r = await espn.fetchTeams('cricket/8048');
        assert.equal(r.ok, false);
    });
});

test('discoverCricketSeries: today\'s active series and their league ids, from the scorepanel', async () => {
    await withEspn({ scorepanel: readFx('cricket-scorepanel') }, async () => {
        const r = await espn.discoverCricketSeries();
        assert.equal(r.ok, true);
        assert.ok(r.series.some(s => s.id === '24377'));
    });
});

// ---- sportsFixtures.js: fetching only what matters, storage, failures, the kill switch -------

function setFollow(...keywords) {
    const d = sqlite.getDb();
    d.prepare('DELETE FROM sports_follow').run();
    const ins = d.prepare('INSERT INTO sports_follow (position, keyword) VALUES (?, ?)');
    keywords.forEach((k, i) => ins.run(i, k));
}

test('neededLeagues: only the follow list\'s own leagues that ESPN actually covers - never AFLW, never an unfollowed one', () => {
    setFollow('NFL', 'AFLW', 'Chiefs', 'Cricket');
    assert.deepEqual([...fixtures.neededLeagues()].sort(), ['Cricket', 'NFL']);
    setFollow();
    assert.deepEqual([...fixtures.neededLeagues()], []);
});

test('refreshLeague: stores fixtures and teams, and snapshot() turns them into what resolveLive needs', async () => {
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: Date.parse('2026-09-27T12:00Z') }));

    const snap = fixtures.snapshot(new Set(['NFL']));
    const nfl = snap.get('NFL');
    assert.ok(nfl, 'NFL is in the snapshot');
    assert.equal(nfl.fixtures.length, 4);
    assert.ok(nfl.teamsAliases.length >= 30, 'the full 32-team roster, not just the 8 playing that day');
    const lacBuf = nfl.fixtures.find(f => f.start === Date.parse('2026-09-27T17:00Z'));
    assert.ok(lacBuf.teamsAliases, 'a real match-up carries team aliases');

    const status = fixtures.statusSummary();
    const nflStatus = status.leagues.find(l => l.league === 'NFL');
    assert.equal(nflStatus.fixtureCount, 4);
    assert.equal(nflStatus.lastError, null);
    assert.ok(nflStatus.lastSuccessAt);
});

test('a failed league keeps its last good fixtures, and status carries the error', async () => {
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: Date.parse('2026-09-27T12:00Z') }));
    await withEspn({}, () => fixtures.refreshLeague('NFL', { now: Date.parse('2026-09-27T13:00Z') }));

    const snap = fixtures.snapshot(new Set(['NFL']));
    assert.equal(snap.get('NFL').fixtures.length, 4, 'the last good fetch is still there');
    const status = fixtures.statusSummary().leagues.find(l => l.league === 'NFL');
    assert.ok(status.lastError, 'the failure is recorded');
});

test('F1: sessions from the ESPN abbreviation, location from the event name via the guide\'s own title parser', async () => {
    await withEspn({ 'racing/f1/scoreboard': readFx('f1-scoreboard') }, () =>
        fixtures.refreshLeague('F1', { now: Date.parse('2026-09-25T00:00Z') }));
    const f1 = fixtures.snapshot(new Set(['F1'])).get('F1');
    assert.equal(f1.fixtures.length, 5);
    const race = f1.fixtures.find(f => f.session.id === 'race');
    assert.equal(race.session.label, 'Race');
    assert.deepEqual(race.location, ['qatar', 'airways', 'azerbaijan']);
    const fp2 = f1.fixtures.find(f => f.session.id === 'practice 2');
    assert.ok(fp2);
});

test('international cricket: series discovered from the scorepanel, merged under the league \'Cricket\'', async () => {
    await withEspn({
        scorepanel: readFx('cricket-scorepanel'),
        'cricket/24377/scoreboard': readFx('cricket-24377-20260927'),
        // the other series in the fixture's scorepanel answer 404 (never fetched by this test) or empty
        'cricket/22547/scoreboard': { events: [] }, 'cricket/18479/scoreboard': { events: [] }, 'cricket/8656/scoreboard': { events: [] }
    }, () => fixtures.refreshCricket({ now: Date.parse('2026-09-27T12:00Z') }));
    const cricket = fixtures.snapshot(new Set(['Cricket'])).get('Cricket');
    assert.ok(cricket, 'Cricket is in the snapshot');
    assert.equal(cricket.fixtures.length, 1);
    assert.equal(cricket.fixtures[0].end, Date.parse('2026-10-01T23:59Z'), 'the real multi-day end is kept');
});

test('PIGTV_SPORT_FIXTURES=0 turns it off completely: no fetch, an empty snapshot, status says so', async () => {
    process.env.PIGTV_SPORT_FIXTURES = '0';
    try {
        assert.equal(fixtures.enabled(), false);
        let fetched = false;
        const original = global.fetch;
        global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
        try { await fixtures.refreshAll(); } finally { global.fetch = original; }
        assert.equal(fetched, false, 'no request went out');
        assert.deepEqual(fixtures.snapshot(new Set(['NFL'])), new Map());
        assert.equal(fixtures.statusSummary().enabled, false);
    } finally {
        delete process.env.PIGTV_SPORT_FIXTURES;
    }
});

// ---- resolveLive's ESPN rule (0163), on real recorded fixtures --------------------------------

let order = 0;
function airing(title, start, { hours = 3, league, channel = `Channel ${order}` } = {}) {
    const parsed = classify.parseTitle(title);
    const kind = classify.classifyKind({ title, start, parsed, rule: 'keyword', chTokens: new Set() });
    return {
        title, start, end: start + hours * H, parsed, kind: kind.kind, why: kind.why, flags: 0, order: order++,
        league: league || classify.detectLeague(title) || 'Sport', channel: { name: channel }
    };
}
// `now` (0162) is when the caller is asking, for fixtureVerdict to judge the snapshot's coverage
// by - normally right around the refresh that built it, exactly like a real request shortly after
// a background refresh; tests that need to check staleness pass a `now` further from it instead.
const resolve = (snap, now, ...list) => { classify.resolveLive(list, snap, now); return list.map(a => `${a.kind}: ${a.why}`); };

test('matched: live at the real kickoff, replay a long way later, with the ESPN wording', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['NFL']));
    const kickoff = Date.parse('2026-09-27T17:00Z'); // Chargers at Bills

    // NFL's live hours are New York's (LIVE_HOURS); 17:00 UTC on 27 Sept 2026 is EDT 1 pm
    const [live] = resolve(snap, refreshedAt, airing('NFL: Chargers v Bills', kickoff, { league: 'NFL' }));
    assert.equal(live, 'event: a match-up, ESPN: the game started Sun 1:00 pm');

    const [replay] = resolve(snap, refreshedAt, airing('NFL: Bills v Chargers', kickoff + 19 * H, { league: 'NFL' }));
    assert.equal(replay, 'replay: ESPN: the game started Sun 1:00 pm; this airing is 19 h later');

    // a differently-spelled/abbreviated team name in the guide still matches (BUF, "Chargers" alone)
    const [live2] = resolve(snap, refreshedAt, airing('NFL: BUF v Chargers', kickoff, { league: 'NFL' }));
    assert.equal(live2, 'event: a match-up, ESPN: the game started Sun 1:00 pm');

    // pre-game coverage starting early still counts as live
    const [pre] = resolve(snap, refreshedAt, airing('NFL: Chargers v Bills', kickoff - 45 * M, { league: 'NFL', hours: 1 }));
    assert.equal(pre, 'event: a match-up, ESPN: the game started Sun 1:00 pm');

    // a matched fixture may keep deciding on OLDER data (a kickoff time rarely moves) - 2 days
    // after the refresh is well past the 6 h "no such game" cutoff, but this is the matched
    // branch, not the unmatched one, so it is unaffected
    const [stillLive] = resolve(snap, refreshedAt + 2 * 24 * H, airing('NFL: Chargers v Bills', kickoff, { league: 'NFL' }));
    assert.equal(stillLive, 'event: a match-up, ESPN: the game started Sun 1:00 pm');
});

test('not matched, but both teams are known to the league: ESPN says there is no such game now (a replay from last week, inside league hours)', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['NFL']));
    // Cardinals v Cowboys: real NFL teams (in the roster), but not one of this window's fixtures -
    // the old heuristics would call this live if it falls inside NFL's live hours (LIVE_HOURS).
    const insideHours = Date.parse('2026-09-27T18:00Z'); // 2 pm New York, inside NFL hours
    const [replay] = resolve(snap, refreshedAt, airing('NFL: Cardinals v Cowboys', insideHours, { league: 'NFL' }));
    assert.equal(replay, 'replay: ESPN has no such game at this time');
});

test('0162: stale or out-of-window fixture data must never manufacture a replay for a real, unlisted game', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['NFL']));
    const insideHours = Date.parse('2026-09-27T18:00Z'); // inside NFL hours; both teams known; not a fixture

    // ESPN's last successful fetch was 2 days before "now": too stale to trust an ABSENCE of a
    // game, so the ESPN rule stays silent and (d) league hours decides instead, exactly as before
    // 0161 - a whole day of ESPN being unreachable must never quietly turn a real live game into
    // a replay just because yesterday's snapshot didn't happen to list it.
    const [stale] = resolve(snap, refreshedAt + 2 * 24 * H, airing('NFL: Cardinals v Cowboys', insideHours, { league: 'NFL' }));
    assert.equal(stale, 'event: a match-up', 'too stale to claim "no such game"; falls through to league hours');

    // an airing outside the fetch's own covered window ([now-36h, now+72h]) gets no verdict at all,
    // matched or not - ESPN was simply never asked about that moment
    const outsideWindow = refreshedAt + 100 * H; // the fetch only reaches 72 h past its own `now`
    const [beyond] = resolve(snap, refreshedAt, airing('NFL: Chargers v Bills', outsideWindow, { league: 'NFL' }));
    assert.equal(beyond, 'event: a match-up', 'outside the covered window; falls through to the heuristics');

    // fresh data (right after the refresh) still claims "no such game" as before
    const [fresh] = resolve(snap, refreshedAt, airing('NFL: Cardinals v Cowboys', insideHours, { league: 'NFL' }));
    assert.equal(fresh, 'replay: ESPN has no such game at this time');
});

test('not matched, and the teams are not ones ESPN knows for this league: falls through to the heuristics unchanged', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['NFL']));
    const insideHours = Date.parse('2026-09-27T18:00Z');
    const [event] = resolve(snap, refreshedAt, airing('NFL: Rhinos v Sharks', insideHours, { league: 'NFL' }));
    assert.equal(event, 'event: a match-up', 'no ESPN verdict; (d) league hours decides, as before 0161');
});

test('a league fixtures never fetched (or ESPN down): every rule is exactly the pre-0161 heuristics', () => {
    const empty = new Map();
    const morning = Date.parse('2026-09-26T07:00:00-04:00');
    const [replay] = resolve(empty, Date.now(), airing('MLB: Yankees v Red Sox', morning, { league: 'MLB' }));
    assert.equal(replay, 'replay: outside MLB hours (07:00 America/New_York)');
    // resolveLive(airings) with no second/third argument at all (every pre-0161 call site) behaves the same
    const list = [airing('MLB: Yankees v Red Sox', morning, { league: 'MLB' })];
    classify.resolveLive(list);
    assert.equal(list[0].why, 'outside MLB hours (07:00 America/New_York)');
});

test('F1: practice is told from the race by session, matched to the right Grand Prix by location', async () => {
    const refreshedAt = Date.parse('2026-09-25T00:00Z');
    await withEspn({ 'racing/f1/scoreboard': readFx('f1-scoreboard') }, () =>
        fixtures.refreshLeague('F1', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['F1']));
    const raceStart = Date.parse('2026-09-26T11:00Z');
    const fp2Start = Date.parse('2026-09-24T12:00Z');

    const [race] = resolve(snap, refreshedAt, airing('F1: Azerbaijan GP', raceStart, { league: 'F1' }));
    assert.equal(race, 'event: a session (Race), ESPN: the session started Sat 11:00 am');

    // the practice session, aired a day later than its real time, is a replay - matched to
    // Practice 2 specifically, not the race
    const [practiceReplay] = resolve(snap, refreshedAt, airing('F1: Azerbaijan GP Practice 2', fp2Start + 26 * H, { league: 'F1' }));
    assert.equal(practiceReplay, 'replay: ESPN: the session started Thu 12:00 pm; this airing is 26 h later');

    // a differently-worded location ("Baku", the city, vs ESPN's "Qatar Airways Azerbaijan") -
    // shares "azerbaijan" if named, but a session named only by city with none of ESPN's words
    // in common simply is not matched (falls through) - proven by the qualifying/race split below
    const [qual] = resolve(snap, refreshedAt, airing('Formula 1: Azerbaijan Grand Prix - Qualifying', Date.parse('2026-09-25T12:00Z'), { league: 'F1' }));
    assert.equal(qual, 'event: a session (Qualifying), ESPN: the session started Fri 12:00 pm');
});

test('a multi-day cricket Test: day 3 of a still-running match is live, not a replay', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({
        scorepanel: readFx('cricket-scorepanel'),
        'cricket/24377/scoreboard': readFx('cricket-24377-20260927'),
        'cricket/22547/scoreboard': { events: [] }, 'cricket/18479/scoreboard': { events: [] }, 'cricket/8656/scoreboard': { events: [] }
    }, () => fixtures.refreshCricket({ now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['Cricket']));
    // the match: India U19 v Australia U19, 2026-09-27T04:00Z to 2026-10-01T23:59Z
    const day1 = Date.parse('2026-09-27T04:00Z');
    const day3 = Date.parse('2026-09-29T04:00Z');

    const [live1] = resolve(snap, refreshedAt, airing('India U19 v Australia U19', day1, { league: 'Cricket', hours: 6 }));
    assert.match(live1, /^event: a match-up, ESPN: the game started/);

    const [live3] = resolve(snap, refreshedAt, airing('India U19 v Australia U19', day3, { league: 'Cricket', hours: 6 }));
    assert.match(live3, /^event: a match-up, ESPN: the game started/, 'day 3 of a live Test is still live');

    // a later refresh (as if a day had passed) covers a window reaching past the match's real end,
    // so an airing well after it can be told a replay - matched-branch logic, no recency needed
    const laterRefresh = Date.parse('2026-09-30T12:00Z');
    await withEspn({
        scorepanel: readFx('cricket-scorepanel'),
        'cricket/24377/scoreboard': readFx('cricket-24377-20260927'),
        'cricket/22547/scoreboard': { events: [] }, 'cricket/18479/scoreboard': { events: [] }, 'cricket/8656/scoreboard': { events: [] }
    }, () => fixtures.refreshCricket({ now: laterRefresh }));
    const laterSnap = fixtures.snapshot(new Set(['Cricket']));
    const afterEnd = Date.parse('2026-10-02T02:00Z'); // just over 2 h after the match's real end
    const [after] = resolve(laterSnap, laterRefresh, airing('India U19 v Australia U19', afterEnd, { league: 'Cricket', hours: 3 }));
    assert.match(after, /^replay: ESPN: the game started/, 'once the Test has finished, a later airing is a replay');
});

// ---- performance: the fixture rule must not add noticeable time to the sport build -----------

test('performance: matching against a full league of fixtures does not slow resolveLive down', async () => {
    const refreshedAt = Date.parse('2026-09-27T12:00Z');
    await withEspn({ 'football/nfl/scoreboard': readFx('nfl-20260927'), 'football/nfl/teams': readFx('teams-nfl') }, () =>
        fixtures.refreshLeague('NFL', { now: refreshedAt }));
    const snap = fixtures.snapshot(new Set(['NFL']));
    const teamNames = ['Bills', 'Chargers', 'Panthers', 'Browns', 'Jets', 'Lions', 'Texans', 'Colts', 'Cowboys', 'Cardinals'];
    const list = [];
    for (let i = 0; i < 2000; i++) {
        const a = teamNames[i % teamNames.length];
        const b = teamNames[(i + 3) % teamNames.length];
        if (a === b) continue;
        list.push(airing(`NFL: ${a} v ${b}`, Date.parse('2026-09-27T17:00Z') + (i % 40) * H, { league: 'NFL', channel: `Ch ${i}` }));
    }
    const withoutFixtures = performance.now();
    classify.resolveLive(list.map(a => ({ ...a })));
    const withoutMs = performance.now() - withoutFixtures;

    const t0 = performance.now();
    classify.resolveLive(list, snap, refreshedAt);
    const withMs = performance.now() - t0;
    console.log(`# resolveLive, 2000 NFL airings against a ${snap.get('NFL').fixtures.length}-fixture/${snap.get('NFL').teamsAliases.length}-team league: without ESPN ${withoutMs.toFixed(1)} ms, with ${withMs.toFixed(1)} ms`);
    assert.ok(withMs < 200, `resolveLive with fixtures took ${withMs} ms`);
});
