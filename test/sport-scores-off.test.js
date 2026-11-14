const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

// #297 item 2: with the score collector off (PIGTV_SPORTS_DASHBOARD=0) and ESPN fixtures on, the only ESPN read is the
// schedule read: the 30-minute fixture refresh (sportsFixtures.refreshAll), which asks each followed league's scoreboard
// once per day of its window and keeps only what a schedule says (teams, start, end, F1 session), never a score or a
// status. The collector never starts and never asks; nothing writes its catalogue or score history.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-scores-off-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
process.env.PIGTV_SPORTS_DASHBOARD = '0';
delete process.env.PIGTV_SPORT_FIXTURES;
const H = 3600000;
const fixtures = load('services/sportsFixtures'), dashboard = load('services/sportsDashboard');
const sqlite = load('db/sqlite');

after(() => {
    dashboard.stop();
    fixtures.stopBackgroundRefresh();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
    delete process.env.PIGTV_SPORTS_DASHBOARD;
});

const team = (id, name, abbr) => ({ id, displayName: name, shortDisplayName: name.split(' ').pop(), name: name.split(' ').pop(),
    location: name.split(' ').slice(0, -1).join(' '), abbreviation: abbr, logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr}.png` });
/** An ESPN NFL scoreboard with a game in play: its status, score and situation are exactly what must not be kept. */
function liveBoard(now) {
    return { events: [{ id: '401', name: 'Detroit Lions at Green Bay Packers', date: new Date(now - H).toISOString(), competitions: [{
        id: '401', date: new Date(now - H).toISOString(),
        status: { clock: 412, displayClock: '6:52', period: 2, type: { state: 'in', name: 'STATUS_IN_PROGRESS', detail: '6:52 - 2nd Quarter' } },
        situation: { down: 2, distance: 7, yardLine: 35, possession: '9' },
        competitors: [{ homeAway: 'home', score: '14', team: team('9', 'Green Bay Packers', 'GB') },
            { homeAway: 'away', score: '10', team: team('8', 'Detroit Lions', 'DET') }] }] }] };
}

test('=0: the collector never starts or asks; the schedule read keeps no score or status', async () => {
    const now = Date.now();
    load('services/sportPagePrefs').setFollows(1, { sports: [{ sport: 'American football', teams: ['Green Bay Packers'] }] });
    const asked = [], realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        asked.push(u.pathname + u.search);
        if (u.pathname.endsWith('/football/nfl/scoreboard')) return new Response(JSON.stringify(liveBoard(now)), { status: 200 });
        if (u.pathname.endsWith('/football/nfl/teams')) return new Response(JSON.stringify({ sports: [] }), { status: 200 });
        return new Response('{}', { status: 404 });
    };
    try {
        dashboard.start(); // as the server's start-up does
        assert.equal(dashboard.cadence().why, 'off', 'the collector is off');
        await fixtures.refreshAll(now);
        await new Promise(r => setTimeout(r, 50)); // anything a start or a refresh might have set going
    } finally { globalThis.fetch = realFetch; }

    // Only the schedule read asked: each day of its window once, plus the roster. No other score request.
    const days = asked.filter(p => p.startsWith('/apis/site/v2/sports/football/nfl/scoreboard?dates='));
    assert.ok(days.length >= 4 && days.length <= 6, `one scoreboard read per day of the window: ${asked.join(', ')}`);
    assert.equal(new Set(days).size, days.length, 'no day asked twice');
    assert.deepEqual(asked.filter(p => !days.includes(p) && !p.endsWith('/football/nfl/teams')), [], 'nothing else asked');

    const db = sqlite.getDb();
    const rows = db.prepare('SELECT data FROM sport_fixtures WHERE league = ?').all('NFL').map(r => JSON.parse(r.data));
    assert.equal(rows.length, 1, 'the game is in the schedule');
    const stored = JSON.stringify(rows);
    for (const word of ['score', 'status', 'situation', '"state"', 'clock', 'period', 'STATUS_IN_PROGRESS', '6:52'])
        assert.ok(!stored.includes(word), `the schedule keeps no ${word}: ${stored}`);
    assert.deepEqual(rows[0].teams.map(t => t.displayName), ['Green Bay Packers', 'Detroit Lions']);

    // The collector's own tables: never written (absent, or empty).
    for (const table of ['sports_dashboard_catalog', 'sports_score_history', 'sports_dashboard_coverage']) {
        let n = 0;
        try { n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { /* no table: never written */ }
        assert.equal(n, 0, `${table} is not written`);
    }
});
