const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (batch D): a sport page's games take their state from the score collector's store for the asking account
// (services/sportPageState.js), laid over the page's own cached ESPN answer per request. The cache stays one per league
// and account-independent; where the collector has nothing usable the page answers exactly as before.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-page-state-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const dashboard = load('services/sportsDashboard');
const espn = load('services/sportsScoresEspn');
const pageState = load('services/sportPageState');
const lp = load('services/sportPageLeague');
const { scriptedGame, scoreboard } = require('../scripts/fake-scores');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const MIN = 60000;
const K = Date.parse('2026-11-04T09:00:00Z');
const game = scriptedGame({ at: K, guideMin: 10, finalMin: 25 });
let fetches;
/** The page's own ESPN answer is the game as it was at `pageAt` (an older read than the collector's). */
function pageSees(pageAt) {
    fetches = 0;
    lp.fetcher.get = async url => { if (url.endsWith('/scoreboard')) fetches++; /* one per build: its default scoreboard */ return url.includes('soccer/eng.1/scoreboard') ? { ok: true, json: scoreboard(game, pageAt) } : { ok: false, error: 'HTTP 404' }; };
}
/** The collector's store holds the game as observed at each of `times`. */
function collected(...times) {
    const store = dashboard.store();
    for (const t of times) store.ingest(espn.normalize(scoreboard(game, t), 'EPL', 'soccer/eng.1'), t);
}
const the = page => page.rounds.flatMap(r => r.games).find(g => g.id === '9917001');
const brief = g => `${g.status} ${g.detail} ${g.home.score}-${g.away.score}`;

beforeEach(() => {
    lp.reset();
    const db = sqlite.getDb();
    dashboard.store();
    for (const t of ['sports_dashboard_catalog', 'sports_score_history', 'sports_score_confirmed', 'sports_user_preferences', 'sports_dashboard_coverage']) {
        try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* not in this build */ }
    }
    dashboard.store().updatePreferences(2, { revision: 0, scoreDelaySeconds: 0 }); // account 1 keeps the default 90 s
    delete process.env.PIGTV_SPORTS_DASHBOARD;
});

test('two accounts with different delays on the same cached page: each sees its own delayed state; the cache is built once and stays neutral', async () => {
    pageSees(K - 30 * MIN);
    for (let t = K - 2 * MIN; t <= K + 4 * MIN; t += 30000) collected(t); // the collector's 30 s pace
    const now = K + 4 * MIN;
    const delayed = await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(1, now) });
    const instant = await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(2, now) });
    const neutral = await lp.page('EPL', now, { zone: 'UTC' });
    assert.equal(fetches, 1, 'one build of the league\'s cached answer for both accounts');
    assert.equal(brief(the(delayed)), "live 1st Half 3' 0-0", 'account 1: the snapshot at or before now - 90 s');
    assert.equal(brief(the(instant)), "live 1st Half 5' 1-0", 'account 2: the newest');
    assert.equal(brief(the(neutral)), 'scheduled null null-null', 'the cached answer itself is the page\'s own read, untouched by either account');
    const again = await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(1, now) });
    assert.equal(brief(the(again)), "live 1st Half 3' 0-0", 'account 1 again, after account 2: nothing of 2\'s view was kept');
});

test('the final: done with the collector\'s result once the account\'s delay has passed it', async () => {
    pageSees(K + 20 * MIN);
    collected(K + 20 * MIN, K + 24 * MIN, K + 25 * MIN + 30000, K + 27 * MIN);
    const now = K + 27 * MIN + 30000;
    assert.equal(brief(the(await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(1, now) }))), 'done FT 1-1');
    assert.equal(brief(the(await lp.page('EPL', now, { zone: 'UTC' }))), "live 1st Half 21' 1-1", 'the page\'s own (older) read');
});

test('where the collector has nothing usable the page answers exactly as before', async () => {
    const now = K + 5 * MIN;
    pageSees(K + 3 * MIN);
    const own = brief(the(await lp.page('EPL', now, { zone: 'UTC' })));
    assert.equal(own, "live 1st Half 4' 1-0");
    // the collector off (PIGTV_SPORTS_DASHBOARD=0): no state at all
    collected(K + 4 * MIN + 30000);
    process.env.PIGTV_SPORTS_DASHBOARD = '0';
    assert.deepEqual(pageState.deps(2, now), {});
    assert.equal(brief(the(await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(2, now) }))), own, 'collector off');
    delete process.env.PIGTV_SPORTS_DASHBOARD;
    // a game (or league) the collector does not hold
    dashboard.store().forget(['espn:soccer/eng.1:9917001']);
    assert.equal(brief(the(await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(2, now) }))), own, 'not held');
    // the first minutes after start: held, but nothing yet at or before now - 90 s
    collected(K + 4 * MIN + 30000);
    assert.equal(brief(the(await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(1, now) }))), own, 'nothing old enough for the delay');
    // a 429 cooldown: the collector's last answer ages past the delay plus two minutes
    const later = K + 9 * MIN;
    assert.equal(brief(the(await lp.page('EPL', later, { zone: 'UTC', ...pageState.deps(2, later) }))), own, 'stale: the page\'s own');
    // a snapshot stored before the page facts were kept (an upgrade): the page's own
    const store = dashboard.store();
    const [card] = espn.normalize(scoreboard(game, K + 8 * MIN), 'EPL', 'soccer/eng.1');
    delete card.snapshot.espn;
    store.ingest([card], K + 8 * MIN + 30000);
    assert.equal(brief(the(await lp.page('EPL', later, { zone: 'UTC', ...pageState.deps(2, later) }))), own, 'no page facts');
});

test('a covered league keeps its cached answer 10 minutes while a game is on, not 2: the state comes from the collector', async () => {
    const db = sqlite.getDb();
    pageSees(K + 3 * MIN);
    const now = K + 5 * MIN;
    await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(2, now) });
    await lp.page('EPL', now + 3 * MIN, { zone: 'UTC', ...pageState.deps(2, now + 3 * MIN) });
    await new Promise(r => setImmediate(r));
    assert.equal(fetches, 2, 'not covered: refreshed after 2 minutes, as before');
    lp.reset(); pageSees(K + 3 * MIN);
    dashboard.store().putCoverage('EPL', { from: K - 36 * 60 * MIN, to: K + 72 * 60 * MIN, at: now - MIN, listed: ['espn:soccer/eng.1:9917001'] });
    await lp.page('EPL', now, { zone: 'UTC', ...pageState.deps(2, now) });
    await lp.page('EPL', now + 3 * MIN, { zone: 'UTC', ...pageState.deps(2, now + 3 * MIN) });
    await lp.page('EPL', now + 9 * MIN, { zone: 'UTC', ...pageState.deps(2, now + 9 * MIN) });
    await new Promise(r => setImmediate(r));
    assert.equal(fetches, 1, 'covered: one read in 9 minutes');
    await lp.page('EPL', now + 11 * MIN, { zone: 'UTC', ...pageState.deps(2, now + 11 * MIN) });
    await new Promise(r => setImmediate(r));
    assert.equal(fetches, 2, 'and again after 10');
    db.prepare('DELETE FROM sports_dashboard_coverage').run();
});
