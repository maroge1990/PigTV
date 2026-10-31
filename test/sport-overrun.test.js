const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore } = require('../server/services/sportsDashboardStore');
const dashboard = require('../server/services/sportsDashboard');
const overrun = require('../server/services/sportOverrun');
const f1 = require('../server/services/sportPageF1');
const nfl = require('../server/services/sportPageNFL');
const cricket = require('../server/services/sportPageCricket');

// #191 (0386): a live game that overruns its guide slot keeps Watch. While the score feed says it is ongoing (as the
// surface reports it), a channel whose airing of it ended within OVERRUN_MAX is projected to now + OVERRUN_STEP, overrun.
const H = 3600000, MIN = 60000, NOW = Date.parse('2026-10-29T01:00Z');
const { OVERRUN_MAX, OVERRUN_STEP, overrunEnd } = overrun;
const databases = [];
const store = () => { const db = new Database(':memory:'); databases.push(db); return createStore(db); };
after(() => databases.forEach(db => db.close()));

test('overrunEnd: ongoing and ended within 4 h rolls on 10 min; 4 h + 1 ms, not ongoing or not yet ended is null', () => {
    assert.equal(OVERRUN_MAX, 4 * H);
    assert.equal(OVERRUN_STEP, 10 * MIN);
    assert.equal(overrunEnd(NOW - 30 * MIN, true, NOW), NOW + 10 * MIN);
    assert.equal(overrunEnd(NOW, true, NOW), NOW + 10 * MIN, 'ending this instant has ended');
    assert.equal(overrunEnd(NOW - 4 * H, true, NOW), NOW + 10 * MIN, 'exactly 4 h ago still counts');
    assert.equal(overrunEnd(NOW - 4 * H - 1, true, NOW), null, '4 h + 1 ms is too old');
    assert.equal(overrunEnd(NOW - 30 * MIN, false, NOW), null, 'not ongoing');
    assert.equal(overrunEnd(NOW + 1, true, NOW), null, 'not yet ended: unchanged');
    assert.equal(overrunEnd(null, true, NOW), null);
    assert.equal(overrunEnd(NOW - MIN, true, NaN), null);
});

test('keep: a page extends only from an ESPN answer at most 15 min old', () => {
    const c = { sourceId: 1, id: 'a', start: NOW - 3 * H, end: NOW - 30 * MIN }, e = { end: NOW - 30 * MIN };
    assert.equal(overrun.PAGE_FRESH_MS, 15 * MIN);
    assert.deepEqual(overrun.keep(c, e, true, NOW, NOW - 15 * MIN), { ...c, end: NOW + 10 * MIN, overrun: true });
    assert.equal(overrun.keep(c, e, true, NOW, NOW - 15 * MIN - 1), null);
    assert.equal(overrun.keep(c, e, true, NOW, undefined), null, 'no observation time: no extension');
    assert.equal(overrun.keep(c, e, true, undefined, undefined), c, 'callers before 0386: unchanged');
});

// ---- dashboard / front page (buildDashboard) ----
const game = (snapshot, extra = {}) => ({ id: 'espn:football/nfl:1', league: 'NFL', start: NOW - 3.5 * H, end: null,
    title: 'Kansas City Chiefs v Buffalo Bills', session: null, circuit: null,
    competitors: [{ id: '12', name: 'Kansas City Chiefs', aliases: ['Kansas City Chiefs', 'Chiefs', 'KC'], logo: null },
        { id: '2', name: 'Buffalo Bills', aliases: ['Buffalo Bills', 'Bills', 'BUF'], logo: null }], snapshot, ...extra });
const live = { state: 'live', progress: { clock: '2:00', period: 4 }, scores: ['17', '14'], situation: null };
const finished = { state: 'finished', progress: { period: 4 }, scores: ['24', '21'], situation: null };
const scheduled = { state: 'scheduled', progress: {}, scores: null, situation: null };
// The game's only airing: 3.5 h slot that ended 30 min before NOW (the game is still on).
const endedAiring = (extra = {}) => ({ id: 'ev-kc', league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: NOW - 3.5 * H, end: NOW - 30 * MIN,
    live: false, channels: [{ sourceId: 1, id: 'pos_1', stableId: '301', name: 'ESPN', quality: 'HD', start: NOW - 3.5 * H, end: NOW - 30 * MIN }], ...extra });
const build = (s, extra = {}) => dashboard.buildDashboard(s, { now: NOW, userId: '1', timezone: 'Australia/Melbourne', events: [],
    endedEvents: [endedAiring()], channelTimes: true, ...extra }).games.find(g => g.id === 'espn:football/nfl:1');

test('dashboard: a live, fresh game whose only matched airing ended 30 min ago keeps its channel, overrun, and Watch', () => {
    const s = store(); s.ingest([game(live)], NOW - 100000);
    const card = build(s);
    assert.equal(card.status, 'live');
    assert.deepEqual(card.channels.map(c => [c.stableId, c.start, c.end, c.overrun]), [['301', NOW - 3.5 * H, NOW + 10 * MIN, true]]);
    assert.equal(card.canWatch, true);
    assert.equal(card.broadcastStatus, 'on-tv');
    assert.equal(card.availability, 'matched');
    assert.deepEqual(card.events, [], 'an ended airing is not added to the card\'s event references');
    // /dashboard (no channel times) flips the same way.
    const plain = build(s, { channelTimes: false });
    assert.deepEqual(plain.channels.map(c => [c.stableId, c.end, c.overrun]), [['301', undefined, true]]);
    assert.equal(plain.canWatch, true);
    // Without the ended airings (off by default) nothing changes.
    assert.equal(build(s, { endedEvents: undefined }).canWatch, false);
});

test('dashboard: a current airing\'s channel whose own slot ended is extended while live; never a channel ended over 4 h ago', () => {
    const s = store(); s.ingest([game(live)], NOW - 100000);
    const current = endedAiring({ id: 'ev-now', end: NOW + H, channels: [
        { sourceId: 1, id: 'pos_1', stableId: '301', name: 'ESPN', quality: 'HD', start: NOW - 3.5 * H, end: NOW - 20 * MIN },
        { sourceId: 1, id: 'pos_2', stableId: '302', name: 'ESPN2', quality: 'HD', start: NOW - 3.5 * H, end: NOW + H }] });
    const card = build(s, { events: [current], endedEvents: [] });
    assert.deepEqual(card.channels.map(c => [c.stableId, c.end, c.overrun]), [['301', NOW + 10 * MIN, true], ['302', NOW + H, undefined]]);
    const old = build(s, { endedEvents: [endedAiring({ end: NOW - 4 * H - 1, channels: [{ ...endedAiring().channels[0], end: NOW - 4 * H - 1 }] })] });
    assert.equal(old.canWatch, false);
    assert.deepEqual(old.channels, []);
});

test('dashboard: a finished (delayed, eligible) game, a stale live one or an unmatched airing gets no extension', () => {
    let s = store(); s.ingest([game(live)], NOW - 3 * H); s.ingest([game(finished)], NOW - 100000); // past the 90 s delay
    let card = build(s);
    assert.equal(card.status, 'finished');
    assert.deepEqual(card.channels, []);
    assert.equal(card.canWatch, false);
    s = store(); s.ingest([game(live)], NOW - 90000 - 121000); // older than the delay plus the 2 min freshness margin
    card = build(s);
    assert.equal(card.freshness, 'stale');
    assert.deepEqual(card.channels, []);
    assert.equal(card.canWatch, false);
    s = store(); s.ingest([game(live)], NOW - 100000);
    card = build(s, { endedEvents: [endedAiring({ title: 'Chiefs v Cowboys' })] });
    assert.deepEqual(card.channels, [], 'an airing that does not match the game is never extended');
});

test('dashboard: the delayed snapshot rules: delayed live / latest finished keeps Watch; latest live / delayed not live gives nothing', () => {
    let s = store(); s.ingest([game(live)], NOW - 150000); s.ingest([game(finished)], NOW - 30000); // finished 30 s ago: inside the 90 s delay
    let card = build(s);
    assert.equal(card.status, 'live', 'the delayed card');
    assert.equal(card.canWatch, true, 'Watch does not go early and so give the result away');
    assert.equal(card.channels[0].overrun, true);
    s = store(); s.ingest([game(scheduled)], NOW - 100000); s.ingest([game(live)], NOW - 30000);
    card = build(s);
    assert.equal(card.freshness, 'fresh');
    assert.notEqual(card.status, 'live');
    assert.deepEqual(card.channels, []);
    assert.equal(card.canWatch, false);
});

// ---- sport pages ----
const ch = (id, start, end) => ({ sourceId: 1, id, name: `C${id}`, start, end });

test('F1 page: a live session\'s ended airing is extended; a done session\'s ended airing is not listed', () => {
    const at = NOW - 2 * H;
    const session = (status) => [{ id: 'race', name: 'Race', start: at, end: at + 2 * H, status }];
    const events = [{ league: 'F1', kind: 'event', title: 'Mexico City Grand Prix', start: at - 30 * MIN, end: NOW - 15 * MIN,
        channels: [ch('a', at - 30 * MIN, NOW - 15 * MIN)] }];
    const got = f1.channelsForSessions(session('live'), events, { now: NOW, observedAt: NOW - MIN });
    assert.deepEqual(got.get('race').map(c => [c.id, c.start, c.end, c.overrun]), [['a', at - 30 * MIN, NOW + 10 * MIN, true]]);
    assert.equal(f1.channelsForSessions(session('done'), events, { now: NOW, observedAt: NOW - MIN }).get('race'), undefined);
    assert.equal(f1.channelsForSessions(session('live'), events, { now: NOW, observedAt: NOW - 16 * MIN }).get('race'), undefined,
        'a live status from an answer over 15 min old does not extend');
});

test('NFL page: a live game\'s ended airing is extended; a finished game\'s is not listed', () => {
    const teams = new Map([['KC', { abbr: 'KC', name: 'Chiefs', location: 'Kansas City' }], ['BUF', { abbr: 'BUF', name: 'Bills', location: 'Buffalo' }]]);
    const kick = NOW - 3.5 * H;
    const game = (status) => [{ id: 'g1', start: kick, status, away: { abbr: 'BUF' }, home: { abbr: 'KC' } }];
    const events = [{ league: 'NFL', kind: 'event', title: 'NFL: Bills at Chiefs', start: kick - 15 * MIN, end: NOW - 20 * MIN,
        channels: [ch('fox', kick - 15 * MIN, NOW - 20 * MIN)] }];
    const got = nfl.channelsForGames(game('live'), events, teams, { now: NOW, observedAt: NOW - MIN });
    assert.deepEqual(got.get('g1').map(c => [c.id, c.end, c.overrun]), [['fox', NOW + 10 * MIN, true]]);
    assert.equal(nfl.channelsForGames(game('done'), events, teams, { now: NOW, observedAt: NOW - MIN }).get('g1'), undefined);
});

test('Cricket page: a day in play past its slot keeps its channel; stumps (not in play) does not', () => {
    const airing = (inPlay) => [{ id: 'm1', start: NOW - 8 * H, end: NOW + H, teams: ['Australia', 'India'], inPlay }];
    const events = [{ league: 'Cricket', kind: 'event', title: 'Cricket: Australia v India', aliases: [], start: NOW - 7 * H, end: NOW - 40 * MIN,
        channels: [ch('fox', NOW - 7 * H, NOW - 40 * MIN)] }];
    const got = cricket.channelsForMatches(airing(true), events, { now: NOW, observedAt: NOW - MIN });
    assert.deepEqual(got.get('m1').map(c => [c.id, c.end, c.overrun]), [['fox', NOW + 10 * MIN, true]]);
    assert.equal(cricket.channelsForMatches(airing(false), events, { now: NOW, observedAt: NOW - MIN }).get('m1'), undefined);
    assert.equal(cricket.channelsForMatches(airing(true), events, { now: NOW, observedAt: NOW - 16 * MIN }).get('m1'), undefined,
        'an in-play day from an answer over 15 min old does not extend');
});
