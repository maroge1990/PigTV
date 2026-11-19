'use strict';
// #353 (Codex round 1, high): while a live game overruns its guide slot, its channel's `end` is rolled on for Watch
// (now + 10 min, #191). Which recording is the card's, and which later airings are `slots`, go by the channel's own guide
// bounds: a programme that follows the game on its channel is not the game's, and an airing starting inside the rolled
// window is still an airing of its own. The guide end never reaches the answer.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore } = require('../server/services/sportsDashboardStore');
const dashboard = require('../server/services/sportsDashboard');
const { annotateRecordings } = require('../server/services/sportFront');

const H = 3600000, MIN = 60000, NOW = Date.parse('2026-10-29T01:00Z');
const databases = [];
after(() => databases.forEach(db => db.close()));
const ID = 'espn:cricket/1:9';
const FOX = { sourceId: 1, id: 'pos_1', stableId: '301', name: 'Fox Cricket', quality: 'HD' };
const KAYO = { sourceId: 2, id: 'pos_9', stableId: '909', name: 'Kayo 1', quality: 'HD' };
const airing = (id, start, end, ch = FOX) => ({ id, league: 'Cricket', title: 'Australia v India - 1st Test', kind: 'event', start, end, live: false,
    channels: [{ ...ch, start, end }] });
/** A live Test, its day's airing on Fox Cricket ended 30 min ago (overrunning); `events` more airings. */
function card(events = []) {
    const db = new Database(':memory:'); databases.push(db);
    const s = createStore(db);
    s.ingest([{ id: ID, league: 'Cricket', format: 'test', start: NOW - 3.5 * H, end: null, title: 'Australia v India', session: null, circuit: null,
        competitors: [{ id: '1', name: 'Australia', aliases: ['Australia', 'AUS'], logo: null }, { id: '2', name: 'India', aliases: ['India', 'IND'], logo: null }],
        snapshot: { state: 'live', progress: { day: 'Day 1' }, scores: ['120/2', ''], situation: null } }], NOW - 100000);
    return dashboard.buildDashboard(s, { now: NOW, userId: '1', timezone: 'Australia/Melbourne', events, channelTimes: true, upcomingHours: 72,
        endedEvents: [airing('ev-1', NOW - 3.5 * H, NOW - 30 * MIN)] }).games.find(g => g.id === ID);
}
const news = (o = {}) => ({ id: 21, title: 'The News', status: 'scheduled', rule_id: null, gameId: null, source_id: 1, channel_item_id: 'pos_1',
    channel_stable_id: '301', program_start: NOW - 30 * MIN, program_end: NOW + 30 * MIN, program_end_original: null, ...o });

test('#353 r1: the programme after an overrunning game on its channel is not the card\'s recording; the game\'s own still is', () => {
    const later = [airing('ev-k', NOW + 20 * H, NOW + 27 * H, KAYO)];
    const c = card(later);
    assert.equal(c.channels[0].overrun, true);
    assert.equal(c.channels[0].end, NOW + 10 * MIN, 'Watch keeps its rolled end');
    annotateRecordings([c], [news()]);
    assert.equal(c.recording, undefined, 'News from the game\'s guide end');
    const own = card(later);
    annotateRecordings([own], [news({ id: 22, title: 'Chiefs v Bills', program_start: NOW - 3.5 * H, program_end: NOW - 30 * MIN })]);
    assert.equal(own.recording?.scheduleId, 22);
    const linked = card(later);
    annotateRecordings([linked], [news({ id: 23, gameId: ID, program_start: NOW - 3.5 * H, program_end: NOW + 10 * MIN, program_end_original: NOW - 30 * MIN })]);
    assert.equal(linked.recording?.scheduleId, 23, 'a schedule naming the game, kept to its end');
});

test('#353 r1: an airing starting inside the rolled window is a slot of its own', () => {
    const c = card([airing('ev-2', NOW + 5 * MIN, NOW + 3 * H)]);
    assert.deepEqual(c.channels.map(x => [x.start, x.end, x.overrun]), [[NOW - 3.5 * H, NOW + 10 * MIN, true]]);
    assert.deepEqual((c.slots || []).map(x => [x.start, x.end]), [[NOW - 3.5 * H, NOW + 10 * MIN], [NOW + 5 * MIN, NOW + 3 * H]]);
});

test('#353 r1: the guide end stays on the server: the front answer has no `guideEnd`', async () => {
    const c = card([airing('ev-2', NOW + 5 * MIN, NOW + 3 * H)]);
    const sportFront = require('../server/services/sportFront');
    assert.ok('guideEnd' in c.channels[0], 'the projection keeps it for the server');
    // withRecordings annotates, then strips; here the settings read fails (no database is opened): that path strips too
    const fakes = { '../server/db': { settings: { get: async () => { throw new Error('no database'); } } },
        '../server/services/logoCache': { applyLogoCache() {} } };
    const saved = Object.keys(fakes).map(m => { const p = require.resolve(m), was = require.cache[p];
        require.cache[p] = { id: p, filename: p, loaded: true, exports: fakes[m] }; return [p, was]; });
    const warn = console.warn; console.warn = () => {};
    try { await sportFront.withRecordings([c]); } finally {
        console.warn = warn;
        for (const [p, was] of saved) if (was) require.cache[p] = was; else delete require.cache[p];
    }
    assert.ok(!JSON.stringify(c).includes('guideEnd'));
});
