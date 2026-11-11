const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (D-1): the score collector is the one fetcher of ESPN's scoreboards; the 30-minute fixture refresh no longer asks
// for them while the collector is on (it keeps a league's /teams roster, once a day). This runs the server's two loops
// over a simulated day (the collector's 30 s heartbeat and the fixture refresh's 30-minute pass, each with its own demand
// rule) for three demand profiles and counts what is asked of ESPN. Before (0551) the fixture refresh asked every
// scoreboard day of its window every 30 minutes whenever sportDemand.loopDemand() held, on top of the collector.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-espn-requests-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const fixtures = load('services/sportsFixtures');
const dashboard = load('services/sportsDashboard');
const sportDemand = load('services/sportDemand');
const requestPolicy = load('services/espnRequestPolicy');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const FX = path.join(__dirname, 'fixtures/espn');
const readFx = name => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const H = 3600000, M = 60000;
const DAY = Date.parse('2026-09-27T00:00Z');
const { scriptedGame, scoreboard } = require('../scripts/fake-scores');
// the rig's scripted Premier League game, kicking off at 19:00 UTC that day (final 25 minutes later)
const EPL_GAME = scriptedGame({ at: DAY + 19 * 3600000, guideMin: 10, finalMin: 25 });

function reset() {
    const db = sqlite.getDb();
    load('db/recordingsDb').initSchema();
    dashboard.store();
    for (const t of ['sport_fixtures', 'sport_fixture_teams', 'sport_fixture_status', 'sports_dashboard_catalog', 'sports_score_history',
        'recording_rules', 'scheduled_recordings']) db.prepare(`DELETE FROM ${t}`).run();
    try { db.prepare('DELETE FROM sports_dashboard_coverage').run(); } catch { /* before 0550 */ }
    sportDemand.reset();
    fixtures.reset();
    requestPolicy.reset();
}

/** One simulated day; -> counts by kind of request. */
async function day({ look = () => false, rule = false, leaguePage = false }) {
    reset();
    load('services/sportPagePrefs').setFollows(1, { sports: [{ sport: 'American football', leagues: ['NFL'] }, { sport: 'Football', leagues: ['EPL'] }] });
    if (rule) sqlite.getDb().prepare(`INSERT INTO recording_rules (kind, match, pre_buffer_min, post_buffer_min, new_only, enabled, created_at, sport)
        VALUES ('team', 'Bills', 0, 0, 0, 1, 0, 'American football')`).run();
    const counts = { scoreboard: 0, teams: 0, other: 0, fixtureScoreboard: 0, pageScoreboard: 0 };
    let inFixture = false, inPage = false;
    const original = global.fetch;
    const body = json => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new Response(JSON.stringify(json)).body });
    global.fetch = async (url) => {
        url = String(url);
        if (url.includes('/scoreboard')) {
            counts.scoreboard++;
            if (inFixture) counts.fixtureScoreboard++;
            if (inPage) counts.pageScoreboard++;
            if (leaguePage && url.includes('soccer/eng.1/scoreboard')) return body(scoreboard(EPL_GAME, clock.now));
            return body(url.includes('football/nfl/scoreboard') && url.includes('dates=20260927') ? readFx('nfl-20260927') : { events: [] });
        }
        if (/\/teams(\?|$)/.test(url)) { counts.teams++; return body(url.includes('football/nfl') ? readFx('teams-nfl') : { sports: [] }); }
        counts.other++;
        return body({ events: [] });
    };
    const clock = { now: DAY };
    let beat = null;
    const c = dashboard.createCollector({ store: dashboard.store(), clock: () => clock.now, enabled: () => true,
        feedGames: async () => ({ ok: true, games: [] }), recordFeed: () => {}, every: (fn) => { beat = fn; return null; } });
    try {
        if (look(clock.now)) sportDemand.noteLook(clock.now);
        c.start();
        await c.refresh();
        const pass = async () => { inFixture = true; try { await fixtures.refreshAll(clock.now); } finally { inFixture = false; } };
        if (sportDemand.loopDemand(clock.now)) await pass();
        for (let t = 30000; t < 24 * H; t += 30000) {
            clock.now = DAY + t;
            if (look(clock.now) && t % M === 0) sportDemand.noteLook(clock.now);
            beat();
            await c.refresh();
            if (leaguePage && look(clock.now)) { // the Premier League page asked every 30 s, as the route asks it (C-T)
                const lp = load('services/sportPageLeague');
                let deps = {};
                try { deps = load('services/sportPageState').deps(1, clock.now); } catch { /* before 0557 */ }
                inPage = true;
                try { await lp.page('EPL', clock.now, { zone: 'UTC', ...deps }); for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }
                finally { inPage = false; }
            }
            if (t % (30 * M) === 0 && sportDemand.loopDemand(clock.now)) await pass();
        }
    } finally {
        c.stop();
        global.fetch = original;
    }
    return counts;
}

// Measured by this test on 0549, before batch D's item 10 (0551 asks 48 more in the rule profile: the day 36 h back,
// 0550), the same simulated day: NFL and EPL followed, the recorded NFL Sunday on its day. idle: nobody looks, no rule;
// viewer: someone on the Sport page 18:00-21:00 UTC; rule: an enabled team rule all day, nobody looking. Of those, the
// fixture refresh's scoreboards: idle 0, viewer 70, rule 528. Now (0552): idle 1048, viewer 1048, rule 1096 scoreboards.
const BEFORE = { idle: { scoreboard: 1048, teams: 0 }, viewer: { scoreboard: 1118, teams: 8 }, rule: { scoreboard: 1576, teams: 49 } };

test('a viewer on the Premier League page 18:00-21:00 UTC (a game 19:00-19:25): the page reads ESPN\'s scoreboard far less', async t => {
    load('services/sportPageLeague').reset();
    const got = await day({ look: now => now >= DAY + 18 * H && now < DAY + 21 * H, leaguePage: true });
    t.diagnostic(JSON.stringify(got));
    // 0556 (the page on its own cache: 2 min while the game is on, 10 min on the game day): 105 page scoreboard requests,
    // 1286 in all. 0557: the game's state comes from the collector, so the page's cache keeps 10 min while the game is
    // on: 55, 1236 in all (each page build asks ESPN's default scoreboard and up to 4 days around it).
    assert.ok(got.pageScoreboard <= 55, `${got.pageScoreboard} page scoreboard requests`);
    assert.ok(got.scoreboard <= 1236, `${got.scoreboard} scoreboard requests in all`);
});

test('a simulated day: ESPN is asked no more than before, and the fixture refresh asks no scoreboard', async t => {
    const got = {
        idle: await day({}),
        viewer: await day({ look: now => now >= DAY + 18 * H && now < DAY + 21 * H }),
        rule: await day({ rule: true })
    };
    t.diagnostic(JSON.stringify(got));
    for (const profile of Object.keys(BEFORE)) {
        assert.equal(got[profile].fixtureScoreboard, 0, `${profile}: the fixture refresh asked for no scoreboard`);
        assert.ok(got[profile].scoreboard <= BEFORE[profile].scoreboard, `${profile}: ${got[profile].scoreboard} scoreboard requests, ${BEFORE[profile].scoreboard} before`);
        assert.ok(got[profile].teams <= BEFORE[profile].teams, `${profile}: ${got[profile].teams} /teams requests, ${BEFORE[profile].teams} before`);
    }
});
