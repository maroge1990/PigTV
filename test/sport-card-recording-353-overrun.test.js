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

test('#353 r1: the front answer keeps `guideEnd` on an overrunning channel and its slot (C-R), and only there', async () => {
    const c = card([airing('ev-2', NOW + 5 * MIN, NOW + 3 * H)]);
    const sportFront = require('../server/services/sportFront');
    // withRecordings (the settings read fails here, so no database is opened) leaves the field in the answer
    const fakes = { '../server/db': { settings: { get: async () => { throw new Error('no database'); } } },
        '../server/services/logoCache': { applyLogoCache() {} } };
    const saved = Object.keys(fakes).map(m => { const p = require.resolve(m), was = require.cache[p];
        require.cache[p] = { id: p, filename: p, loaded: true, exports: fakes[m] }; return [p, was]; });
    const warn = console.warn; console.warn = () => {};
    try { await sportFront.withRecordings([c]); } finally {
        console.warn = warn;
        for (const [p, was] of saved) if (was) require.cache[p] = was; else delete require.cache[p];
    }
    assert.deepEqual(c.slots.map(x => x.guideEnd), [NOW - 30 * MIN, undefined]);
    assert.equal(c.channels[0].guideEnd, NOW - 30 * MIN);
});

// The web: More options on the overrunning game, with the News after it on its channel set to record. The padding goes to
// a new recording of the game, never to the News.
test('#353 r1: More options on an overrunning game never pads the programme that follows it on its channel', async () => {
    const { browser, answer, NOW: WEB_NOW, page } = require('./helpers/sportWeb');
    const at = (ms) => ms - NOW + WEB_NOW;
    const db = new Database(':memory:'); databases.push(db);
    const s = createStore(db);
    s.ingest([{ id: ID, league: 'Cricket', format: 'test', start: at(NOW - 3.5 * H), end: null, title: 'Australia v India', session: null, circuit: null,
        competitors: [{ id: '1', name: 'Australia', aliases: ['Australia', 'AUS'], logo: null }, { id: '2', name: 'India', aliases: ['India', 'IND'], logo: null }],
        snapshot: { state: 'live', progress: { day: 'Day 1' }, scores: ['120/2', ''], situation: null } }], WEB_NOW - 100000);
    const c = dashboard.buildDashboard(s, { now: WEB_NOW, userId: '1', timezone: 'Etc/GMT', events: [airing('ev-k', at(NOW + 20 * H), at(NOW + 27 * H), KAYO)],
        channelTimes: true, upcomingHours: 72, endedEvents: [airing('ev-1', at(NOW - 3.5 * H), at(NOW - 30 * MIN))] }).games.find(g => g.id === ID);
    assert.equal(c.channels[0].overrun, true);
    const newsRow = news({ program_start: at(NOW - 30 * MIN), program_end: at(NOW + 30 * MIN), channel_name: 'Fox Cricket', pre_buffer_min: 2, post_buffer_min: 15 });
    annotateRecordings([c], [newsRow]);
    assert.equal(c.recording, undefined);
    const f = answer();
    f.games.push({ ...c, sport: 'Cricket' });
    f.rails[0].gameIds.push(ID);
    const calls = [];
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return [newsRow];
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.act('record-options', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    const post = b.document.getElementById('sp-rec-post');
    post.value = '30'; post.dispatchEvent(new (require('./helpers/fakeDom').FakeEvent)('change'));
    b.document.body.querySelector('dialog [data-act="r-save"]').click();
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
    assert.equal(calls.filter(x => x[0] === 'PUT').length, 0, 'the News is untouched');
    const made = calls.filter(x => x[0] === 'schedule').map(x => x[1]);
    assert.deepEqual(made.map(d => [d.channelItemId, d.postBufferMin, d.gameId]), [['pos_1', 30, ID]]);
});

// ---- Codex sign-off: the web by guide bounds, an overrunning airing and the next one on its channel (adjacent slots) ----
const { browser: webBrowser, answer: webAnswer, NOW: WEB_NOW2, page: webPage } = require('./helpers/sportWeb');
const shift = (ms) => ms - NOW + WEB_NOW2;
/** The overrunning Test (Fox Cricket, guide end 30 min ago) with its next airing on Fox Cricket in 5 min, on the web page. */
async function adjacent({ rows = [], annotate = rows } = {}) {
    const db = new Database(':memory:'); databases.push(db);
    const s = createStore(db);
    s.ingest([{ id: ID, league: 'Cricket', format: 'test', start: shift(NOW - 3.5 * H), end: null, title: 'Australia v India', session: null, circuit: null,
        competitors: [{ id: '1', name: 'Australia', aliases: ['Australia', 'AUS'], logo: null }, { id: '2', name: 'India', aliases: ['India', 'IND'], logo: null }],
        snapshot: { state: 'live', progress: { day: 'Day 1' }, scores: ['120/2', ''], situation: null } }], WEB_NOW2 - 100000);
    const c = dashboard.buildDashboard(s, { now: WEB_NOW2, userId: '1', timezone: 'Etc/GMT', events: [airing('ev-2', shift(NOW + 5 * MIN), shift(NOW + 3 * H))],
        channelTimes: true, upcomingHours: 72, endedEvents: [airing('ev-1', shift(NOW - 3.5 * H), shift(NOW - 30 * MIN))] }).games.find(g => g.id === ID);
    assert.deepEqual(c.slots.map(x => [x.start, x.end, x.guideEnd]), [[shift(NOW - 3.5 * H), WEB_NOW2 + 10 * MIN, shift(NOW - 30 * MIN)],
        [shift(NOW + 5 * MIN), shift(NOW + 3 * H), undefined]]);
    annotateRecordings([c], annotate);
    const f = webAnswer();
    f.games.push({ ...c, sport: 'Cricket' });
    f.rails[0].gameIds.push(ID);
    const calls = [], state = { rows, front: f };
    const b = webBrowser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return state.rows;
        return url === '/sports/front' ? state.front : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; } } });
    const p = webPage(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const save = () => b.document.body.querySelector('dialog [data-act="r-save"]');
    const pick = (i) => { const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-on'); el.setAttribute('data-index', String(i));
        b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); };
    return { b, p, c, f, calls, state, settle, body, save, pick };
}
const schedRow = (o) => ({ title: 'Australia v India', status: 'scheduled', rule_id: null, gameId: ID, source_id: 1, channel_item_id: 'pos_1',
    channel_stable_id: '301', channel_name: 'Fox Cricket', program_end_original: null, pre_buffer_min: 2, post_buffer_min: 15, ...o });

test('#353 sign-off: Change recording of the next airing binds to it, not to the overrunning one whose Watch end covers its start', async () => {
    const row = schedRow({ id: 31, program_start: shift(NOW + 5 * MIN), program_end: shift(NOW + 3 * H) });
    const h = await adjacent({ rows: [row] });
    assert.equal(h.c.recording?.scheduleId, 31);
    h.p.act('change-recording', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    await h.settle();
    assert.equal(h.p.window.st.index, 1, 'the next airing');
    const UI = h.b.context.window.UI;
    assert.ok(h.body().includes(h.b.context.window.SportView.e(`${UI.clock(row.program_start)} – ${UI.clock(row.program_end)}`)), 'its own times');
    h.b.document.body.querySelector('dialog [data-act="r-cancel"]').click();
    assert.equal(h.p.cancels.has(31), true, 'Cancel recording is of schedule 31');
});

test('#353 sign-off: the next airing being cancelled does not hold Record of the overrunning one (its start is only inside the Watch end)', async () => {
    const going = schedRow({ id: 32, status: 'cancelling', program_start: shift(NOW + 5 * MIN), program_end: shift(NOW + 3 * H) });
    const h = await adjacent({ annotate: [going] });
    assert.deepEqual(h.c.recordingCancelling, [{ scheduleId: 32, start: shift(NOW + 5 * MIN), end: shift(NOW + 3 * H) }]);
    h.p.openMenu(h.p.game(ID), (() => { const n = h.b.document.createElement('button'); h.b.document.body.appendChild(n); return n; })());
    assert.match(h.b.document.body.querySelector('.sp-menu').innerHTML, /<b>Record this game<\/b>/, 'the overrunning airing records');
    h.p.closeMenu();
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Record game', false], 'the overrunning airing chosen');
    h.pick(1);
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Cancelling…', true], 'the airing being cancelled waits');
    h.pick(0);
    h.save().click();
    await h.settle();
    assert.deepEqual(h.calls.filter(x => x[0] === 'schedule').map(x => x[1].programStart), [shift(NOW - 3.5 * H)]);
});

test('#353 sign-off: More options left open follows a cancellation begun and finished elsewhere, and checks the list at the press', async () => {
    const h = await adjacent();
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    h.pick(1);
    assert.equal(h.save().textContent, 'Record game');
    // another client starts cancelling the next airing's schedule: the refresh's card says so
    const going = schedRow({ id: 33, status: 'cancelling', program_start: shift(NOW + 5 * MIN), program_end: shift(NOW + 3 * H) });
    const card = h.f.games.find(g => g.id === ID);
    h.state.front = { ...h.f, games: h.f.games.map(g => (g.id === ID ? { ...card, recordingCancelling: [{ scheduleId: 33, start: going.program_start, end: going.program_end }] } : g)) };
    await h.p.refresh(); await h.settle();
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Cancelling…', true]);
    // it finishes: Record again
    h.state.front = h.f;
    await h.p.refresh(); await h.settle();
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Record game', false]);
    // begun again with no refresh since: the list read at the press says so, and nothing is made
    h.state.rows = [going];
    h.save().click();
    await h.settle();
    assert.equal(h.calls.filter(x => x[0] === 'schedule').length, 0);
    assert.match(h.body(), /class="rerr" role="alert">A recording of this is being cancelled/);
});

test('#353 sign-off: the menu\'s Record this game checks the list at the press: a cancel of that airing begun elsewhere waits', async () => {
    const h = await adjacent();
    h.state.rows = [schedRow({ id: 34, status: 'cancelling', program_start: shift(NOW - 3.5 * H), program_end: shift(NOW - 30 * MIN) })];
    await h.p.record(ID);
    assert.equal(h.calls.filter(x => x[0] === 'schedule').length, 0, 'nothing made');
    assert.match(h.b.context.toasts.at(-1)[0], /being cancelled/);
    // the next airing's cancel does not hold the overrunning one (guide bounds)
    h.state.rows = [schedRow({ id: 35, status: 'cancelling', program_start: shift(NOW + 5 * MIN), program_end: shift(NOW + 3 * H) })];
    await h.p.record(ID);
    assert.deepEqual(h.calls.filter(x => x[0] === 'schedule').map(x => x[1].programStart), [shift(NOW - 3.5 * H)]);
});

// Codex split review (high): a schedule made while the game overran stores the rolled end as `program_end` (no original).
// Bound to its own slot (channel and start), it is the overrunning airing's: the next airing on that channel is another.
test('#353 split: a rolled-end schedule of the overrunning airing never takes the next airing\'s Record, active or cancelling', async () => {
    const rolled = (o) => schedRow({ program_start: shift(NOW - 3.5 * H), program_end: WEB_NOW2 + 10 * MIN, ...o });
    // active: More options on the next airing records it; the earlier recording is not padded
    const active = rolled({ id: 51 });
    const h = await adjacent({ rows: [active] });
    assert.equal(h.c.recording?.scheduleId, 51);
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    h.pick(1);
    h.b.document.getElementById('sp-rec-post').value = '30';
    h.b.document.getElementById('sp-rec-post').dispatchEvent(new (require('./helpers/fakeDom').FakeEvent)('change'));
    h.save().click();
    await h.settle();
    assert.equal(h.calls.filter(x => x[0] === 'PUT').length, 0, 'the earlier recording untouched');
    assert.deepEqual(h.calls.filter(x => x[0] === 'schedule').map(x => [x[1].programStart, x[1].postBufferMin]), [[shift(NOW + 5 * MIN), 30]]);
    // cancelling: the card's bounds are its guide slot, and neither the card nor the press holds the next airing
    const going = rolled({ id: 52, status: 'cancelling' });
    const g2 = await adjacent({ rows: [going] });
    assert.deepEqual(g2.c.recordingCancelling, [{ scheduleId: 52, start: shift(NOW - 3.5 * H), end: shift(NOW - 30 * MIN) }]);
    g2.p.act('record-options', { getAttribute: (k) => ({ 'data-id': ID })[k] ?? null });
    assert.equal(g2.save().textContent, 'Cancelling…', 'the overrunning airing waits');
    g2.pick(1);
    assert.deepEqual([g2.save().textContent, !!g2.save().disabled], ['Record game', false]);
    g2.save().click();
    await g2.settle();
    assert.deepEqual(g2.calls.filter(x => x[0] === 'schedule').map(x => x[1].programStart), [shift(NOW + 5 * MIN)]);
});

// Codex split review (medium): a card on overrun only (its one airing ended, so no `events`) still names its schedules.
test('#353 split: a card built only from its ended airing still carries its cancelling schedule and its recording', () => {
    const going = news({ id: 61, title: 'Australia v India', gameId: ID, status: 'cancelling', program_start: NOW - 3.5 * H, program_end: NOW - 30 * MIN });
    const c = card();
    assert.deepEqual(c.events, []);
    assert.equal(c.channels[0].overrun, true);
    annotateRecordings([c], [going]);
    assert.deepEqual(c.recordingCancelling, [{ scheduleId: 61, start: NOW - 3.5 * H, end: NOW - 30 * MIN }]);
    const own = card();
    annotateRecordings([own], [{ ...going, id: 62, status: 'recording' }]);
    assert.equal(own.recording?.scheduleId, 62);
});
