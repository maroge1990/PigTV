const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore } = require('../server/services/sportsDashboardStore');
const dashboard = require('../server/services/sportsDashboard');
const { arrange } = require('../server/services/sportFront');
const f1 = require('../server/services/sportPageF1');
const { answers } = require('./fixtures/sport-page-f1.json');

// #203 (D-42 point 5): coverage before play. While a matched airing (a channel's own start) has begun and play starts
// within 30 min, the card or session is `onAir`: Watch, the live dot and a place among live, its status still scheduled.
const H = 3600000, MIN = 60000, NOW = Date.parse('2026-10-29T01:00Z');
const databases = [];
const store = () => { const db = new Database(':memory:'); databases.push(db); return createStore(db); };
after(() => databases.forEach(db => db.close()));

const game = (start, snapshot) => ({ id: 'espn:football/nfl:1', league: 'NFL', start, end: null,
    title: 'Kansas City Chiefs v Buffalo Bills', session: null, circuit: null,
    competitors: [{ id: '12', name: 'Kansas City Chiefs', aliases: ['Kansas City Chiefs', 'Chiefs', 'KC'], logo: null },
        { id: '2', name: 'Buffalo Bills', aliases: ['Buffalo Bills', 'Bills', 'BUF'], logo: null }], snapshot });
const scheduled = { state: 'scheduled', progress: {}, scores: null, situation: null };
const live = { state: 'live', progress: { clock: '14:00', period: 1 }, scores: ['0', '0'], situation: null };
// The game's airing: the channel's own coverage begins `lead` before the game's start.
const airing = (start, lead) => ({ id: 'ev-kc', league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: start - lead, end: start + 4 * H,
    live: false, channels: [{ sourceId: 1, id: 'pos_1', stableId: '301', name: 'ESPN', quality: 'HD', start: start - lead, end: start + 4 * H }] });
/** The card at `now` for a game starting at `start` whose coverage begins `lead` before it. */
function card({ now, start, lead, snapshot = scheduled }) {
    const s = store();
    s.ingest([game(start, snapshot)], now - 100000);
    return dashboard.buildDashboard(s, { now, userId: '1', timezone: 'Australia/Melbourne', events: [airing(start, lead)], channelTimes: true,
        upcomingHours: 72 }).games.find(g => g.id === 'espn:football/nfl:1');
}

test('dashboard: coverage began 20 min before a start 10 min away: on air, scheduled, start unchanged, Watch', () => {
    const start = NOW + 10 * MIN;
    const c = card({ now: NOW, start, lead: 20 * MIN });
    assert.equal(c.onAir, true);
    assert.equal(c.status, 'scheduled', 'never read as live play or a result');
    assert.equal(c.start, start);
    assert.equal(c.canWatch, true);
    assert.equal(c.broadcastStatus, 'on-tv');
});

test('dashboard: coverage began 40 min before the start: not on air while the start is over 30 min away; on air from 30 min', () => {
    const start = NOW + 35 * MIN;
    const early = card({ now: NOW, start, lead: 40 * MIN });
    assert.equal(early.onAir, undefined, '35 min to go');
    assert.equal(early.status, 'scheduled');
    assert.equal(card({ now: NOW, start: NOW + 30 * MIN, lead: 40 * MIN }).onAir, true, 'exactly 30 min to go');
    assert.equal(card({ now: NOW, start: NOW + 30 * MIN + 1, lead: 40 * MIN }).onAir, undefined, '30 min and 1 ms');
});

test('dashboard: coverage not begun yet: not on air; after the start: normal live, no onAir', () => {
    assert.equal(card({ now: NOW, start: NOW + 10 * MIN, lead: 5 * MIN }).onAir, undefined, 'the airing starts 5 min before play, 5 min from now');
    const started = card({ now: NOW, start: NOW - 5 * MIN, lead: 20 * MIN, snapshot: live });
    assert.equal(started.status, 'live');
    assert.equal(started.onAir, undefined);
});

// ---- the front page (C-R) ----
const prefs = { spoilerFree: false, sports: [{ sport: 'Basketball', leagues: ['NBA'], teams: [] },
    { sport: 'American football', leagues: ['NFL'], teams: [] }] };
const front = (games) => arrange({ now: NOW, timezone: 'Etc/GMT', games, followMatches: {} }, prefs);
const fc = (id, league, start, extra = {}) => ({ id, league, start, end: null, status: 'scheduled', followed: false, freshness: 'fresh',
    competitors: [], channels: [], canWatch: false, ...extra });

test('front: an on-air card counts among live (tile count and line, rails first, hero) and stays scheduled', () => {
    const nba = fc('espn:basketball/nba:1', 'NBA', NOW + 2 * H);
    const nflLater = fc('espn:football/nfl:2', 'NFL', NOW + 5 * MIN);
    const nflOnAir = fc('espn:football/nfl:1', 'NFL', NOW + 10 * MIN, { onAir: true, canWatch: true });
    const f = front([nba, nflLater, nflOnAir]);
    assert.deepEqual(f.sports.map(s => [s.league, s.live, s.line]), [['NBA', 0, 'next'], ['NFL', 1, 'live']]);
    assert.deepEqual(f.rails.map(r => r.league), ['NFL', 'NBA'], 'the league with coverage on air moves up');
    assert.deepEqual(f.rails[0].gameIds, ['espn:football/nfl:1', 'espn:football/nfl:2'], 'on air before what starts sooner but is not on');
    assert.deepEqual(f.hero, { reason: 'league-live', followIndex: null, gameId: 'espn:football/nfl:1' });
    assert.equal(f.games.find(g => g.id === 'espn:football/nfl:1').status, 'scheduled');
    // Without the flag the same cards are all upcoming.
    const plain = front([nba, nflLater, { ...nflOnAir, onAir: undefined }]);
    assert.deepEqual(plain.sports.map(s => s.live), [0, 0]);
    assert.deepEqual(plain.rails.map(r => r.league), ['NBA', 'NFL']);
    assert.equal(plain.hero.reason, 'none');
    // A followed card on air is the hero's follow-live.
    const followed = arrange({ now: NOW, timezone: 'Etc/GMT', games: [{ ...nflOnAir, followed: true }],
        followMatches: { 'espn:football/nfl:1': [{ name: 'Kansas City Chiefs', competitor: 0 }] } },
        { spoilerFree: false, sports: [{ sport: 'American football', leagues: ['NFL'], teams: ['Kansas City Chiefs'] }] });
    assert.deepEqual(followed.hero, { reason: 'follow-live', followIndex: 0, gameId: 'espn:football/nfl:1' });
});

test('front: a follow whose game is on air reads live; its airing not begun, next', () => {
    const p = { spoilerFree: false, sports: [{ sport: 'American football', leagues: ['NFL'], teams: ['Kansas City Chiefs'] }] };
    const at = (onAir) => arrange({ now: NOW, timezone: 'Etc/GMT', followMatches: { 'espn:football/nfl:1': [{ name: 'Kansas City Chiefs', competitor: 0 }] },
        games: [fc('espn:football/nfl:1', 'NFL', NOW + 10 * MIN, { followed: true, ...(onAir ? { onAir: true, canWatch: true } : {}) })] }, p).follows;
    assert.deepEqual(at(true).map(f => [f.state, f.gameId, f.start]), [['live', 'espn:football/nfl:1', NOW + 10 * MIN]], 'on air');
    assert.deepEqual(at(false).map(f => f.state), ['next'], 'airing not begun (no onAir)');
});

// ---- the F1 page (C-P) ----
test('F1 page: a session whose channel\'s coverage began 20 min before it, 10 min out, is on air; the others are not', async () => {
    f1.reset();
    f1.fetcher.get = async (url) => {
        const u = new URL(url), p = u.pathname;
        const key = p.endsWith('/racing/f1/scoreboard') ? (u.searchParams.get('dates') ? `/scoreboard?dates=${u.searchParams.get('dates')}` : '/scoreboard')
            : p.endsWith('/racing/f1/standings') ? 'standings' : `core${p.split('/leagues/f1')[1]}`;
        return key in answers ? { ok: true, json: answers[key] } : { ok: false, error: 'HTTP 404' };
    };
    const fp1 = Date.parse('2026-10-30T18:30:00Z'), fp2 = Date.parse('2026-10-30T22:00:00Z');
    const at = fp1 - 10 * MIN;
    const ch = (id, start) => ({ sourceId: 1, id, name: id, start, end: start + 2 * H });
    const page = await f1.page(at, { registerImage: (u) => u, channelsFor: async () => new Map([
        ['practice 1', [ch('fp1', fp1 - 20 * MIN)]], ['practice 2', [ch('fp2', fp2 - 20 * MIN)]]]) });
    const [s1, s2] = page.weekend.sessions;
    assert.equal(s1.onAir, true);
    assert.equal(s1.status, 'scheduled');
    assert.equal(s1.start, fp1);
    assert.equal(s2.onAir, undefined, 'its coverage has not begun');
    f1.reset();
});
