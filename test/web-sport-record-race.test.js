'use strict';
// Codex review of #327 (high): the record page is opened on a game not set to record; meanwhile another tab, person or
// rule sets it to record. Record game then must not make a second recording (the server tells schedules apart by
// channel and start only, not by game): the list is read again at the press and the person's padding goes to the
// recording that is there (0662). A list that cannot be read records nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness() {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start, end: nxt.start + 2 * H });
    const state = { scheduled: [], fail: false };
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') { if (state.fail) throw new Error('offline'); return state.scheduled; }
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openRecord('nxt');
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const choose = (id, v) => { const el = b.document.getElementById(id); el.value = v; el.dispatchEvent(new FakeEvent('change')); };
    const pick = (index) => { const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-on'); el.setAttribute('data-index', String(index)); b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); };
    const save = async () => { b.document.body.querySelector('dialog [data-act="r-save"]').click(); await new Promise(setImmediate); await new Promise(setImmediate); };
    return { b, p, f, nxt, calls, state, body, choose, pick, save };
}
const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2',
    channel_name: 'Stan Sport 2', ...o });

test('set to record on its best channel while the page is open, another channel chosen: no second recording, the padding goes to it', async () => {
    const h = await harness();
    h.pick(1);
    assert.match(h.body(), /aria-checked="true" data-act="r-on" data-index="1"/, 'Kayo 5 chosen');
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [row({ program_start: h.nxt.start, program_end: h.nxt.start + 2 * H })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'no POST /recordings/schedule');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'PUT'))), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
    assert.equal(h.b.document.body.querySelector('dialog'), null);
    assert.equal(h.b.context.toasts.at(-1)[0], 'This game was already set to record, so your changes went to that recording.');
});

test('set to record as C-R now says (a refresh while the page is open): found by its schedule id, nothing new', async () => {
    const h = await harness();
    h.nxt.recording = { scheduleId: 9, status: 'scheduled' };
    h.state.scheduled = [row({ id: 9, source_id: 3, channel_stable_id: 'zz', channel_item_id: '9', program_start: 0, program_end: 1 })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, 'Usual padding: nothing to change');
    assert.equal(h.b.context.toasts.at(-1)[0], 'This game is already set to record.');
});

test('the list cannot be read: nothing is recorded, the page stays open and says so', async () => {
    const h = await harness();
    h.state.fail = true;
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'never a blind POST');
    assert.ok(h.b.document.body.querySelector('dialog'));
    assert.match(h.body(), /<p class="rerr" role="alert">PigTV couldn’t check whether this game is already set to record, so nothing was recorded\. Try again\.<\/p>/);
});

test('another programme on the same channel, or a cancelled schedule, is not this game: it records', async () => {
    const h = await harness();
    h.state.scheduled = [row({ program_start: h.nxt.start + 3 * H, program_end: h.nxt.start + 4 * H }), row({ id: 5, status: 'cancelled', program_start: h.nxt.start, program_end: h.nxt.start + 2 * H })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 1);
});
