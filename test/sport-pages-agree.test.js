const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (batch D, owner's call of 11 Nov 2026): on the rig the Premier League page said a game was live at +2:57 and over
// at +0:51 while the front page said +2:07 and +2:11: the league pages read ESPN on their own cache (10 min on a game day,
// 2 min while a game is on) and took no score delay, the front the score collector's store with the account's delay. For
// the same account at the same moment a game's status and score on a league page must be the front page's, in each
// contract's own words (C-R `finished`, C-T/C-Q `done`). Spoilers: the front leaves scores out when the household's
// spoiler-free switch is on; the pages always send them and the client hides them by that same switch (C-P, C-Q, C-T).
// This replays one scripted game (scripts/fake-scores.js, the rig's) through the collector and both answers, for an
// account with the default 90 s delay and one with none, at instants before, at kick-off, mid-game, at the final, after.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-pages-agree-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
process.env.TZ = 'UTC';

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const dashboard = load('services/sportsDashboard');
const requestPolicy = load('services/espnRequestPolicy');
const { scriptedGame, scoreboard } = require('../scripts/fake-scores');
/** What the page routes hand a page for this account (sportPageState, from 0557), or nothing before it existed. */
const pageDeps = (userId, now) => { try { return load('services/sportPageState').deps(userId, now); } catch { return {}; } };

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const MIN = 60000;
const K = Date.parse('2026-11-04T09:00:00Z');
// C-R's words as each page says them (0548/0554 edge tables); `unknown` (stale) has no page word and is never asked here.
const C_T = { scheduled: 'scheduled', live: 'live', break: 'break', finished: 'done', postponed: 'postponed', cancelled: 'cancelled' };
const ACCOUNTS = { delayed: 1, instant: 2 };

/** The front's card for the game (sportsDashboard.buildDashboard with the front page's options, as its worker runs it). */
function frontCard(userId, now, spoilerFree) {
    const r = dashboard.buildDashboard(dashboard.store(), { now, userId, leagues: new Set(['EPL']), timezone: 'UTC', keepFinishedToday: true,
        teams: null, spoilerFree, channelTimes: true, upcomingHours: 72, guideCards: false });
    return r.games.find(g => g.id.endsWith(':9917001'));
}

// todo until the League page reads the collector's store (0557): it fails at the kick-off and final instants today.
test('a league page and the front page agree about a game\'s status and score at every moment, with and without a delay', { todo: 'the League page reads its own cache until 0557' }, async () => {
    const store = dashboard.store();
    store.updatePreferences(ACCOUNTS.instant, { revision: 0, scoreDelaySeconds: 0 }); // the other keeps the default 90 s
    const game = scriptedGame({ at: K, guideMin: 10, finalMin: 25 });
    const clock = { now: K - 17.5 * MIN }; // the page's own refreshes then fall as they may, not on the kick-off
    requestPolicy.reset();
    const collector = dashboard.createCollector({ store, clock: () => clock.now, enabled: () => true, leagues: () => new Set(['EPL']),
        followed: () => new Map(), feedGames: async () => ({ ok: true, games: [] }), recordFeed: () => {}, busy: () => true,
        every: () => null, windowDemand: () => false,
        fetchJson: async url => (url.includes('soccer/eng.1/scoreboard') ? scoreboard(game, clock.now) : { events: [] }) });
    const lp = load('services/sportPageLeague');
    lp.reset();
    lp.fetcher.get = async url => (url.includes('soccer/eng.1/scoreboard') ? { ok: true, json: scoreboard(game, clock.now) } : { ok: false, error: 'HTTP 404' });
    const instants = { before: K - 5 * MIN, 'kick-off': K + 2 * MIN, 'mid-game': K + 12 * MIN, final: K + 26 * MIN, after: K + 40 * MIN };
    const seen = [], bad = [];
    try {
        // the server's pace: a collector pass every 30 s (someone is looking), each account asking both answers as it goes
        for (; clock.now <= K + 40 * MIN; clock.now += 30000) {
            await collector.refresh();
            for (const userId of Object.values(ACCOUNTS)) {
                const page = await lp.page('EPL', clock.now, { zone: 'UTC', ...pageDeps(userId, clock.now) });
                await new Promise(r => setImmediate(r)); // a background page refresh lands as it would between requests
                const name = Object.entries(instants).find(([, at]) => at === clock.now)?.[0];
                if (!name) continue;
                const g = page.rounds.flatMap(r => r.games).find(x => x.id === '9917001');
                for (const spoilerFree of [false, true]) {
                    const card = frontCard(userId, clock.now, spoilerFree);
                    assert.notEqual(card.status, 'unknown', `${name}: the front's snapshot is fresh`);
                    const who = `${name}, account ${userId}${spoilerFree ? ', scores hidden' : ''}`;
                    seen.push(`${who}: front ${card.status} ${card.scores?.join('-') ?? '(none)'}, page ${g.status} ${g.home.score ?? '-'}-${g.away.score ?? '-'}`);
                    if (g.status !== C_T[card.status]) bad.push(`${who}: the page says ${g.status}, the front ${card.status}`);
                    if (spoilerFree) assert.equal(card.scores, undefined, `${who}: the front leaves the score out (the page sends it; the client hides it)`);
                    const pageScore = JSON.stringify([g.home.score, g.away.score]);
                    if (!spoilerFree && pageScore !== JSON.stringify(card.scores || [null, null])) bad.push(`${who}: the page's score ${pageScore}, the front's ${JSON.stringify(card.scores || null)}`);
                }
            }
        }
    } finally {
        collector.stop();
    }
    assert.equal(seen.length, 20);
    assert.deepEqual(bad, [], seen.join('\n'));
});
