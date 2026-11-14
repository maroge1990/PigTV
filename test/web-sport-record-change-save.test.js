'use strict';
// Opus review of #327: Change recording reads its schedule again at Save. One that started recording while the page was
// open locks Start early and says so instead of sending a change the server refuses (409); one gone changes nothing. A
// page closed while it saves still tells a failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, page } = require('./helpers/sportWeb');

const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2', ...o });
async function harness({ schedule } = {}) {
    const calls = [];
    const f = answer();
    const state = { scheduled: [row()] };
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return state.scheduled;
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: schedule || (async (d) => { calls.push(['schedule', d]); return {}; }) } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const choose = (id, v) => { const el = b.document.getElementById(id); el.value = v; el.dispatchEvent(new FakeEvent('change')); };
    const save = async () => { b.document.body.querySelector('dialog [data-act="r-save"]').click(); await settle(); };
    return { b, p, f, calls, state, settle, body, choose, save };
}

test('started recording while the page was open: no 409, Start early locked with its value, then Finish late alone is saved', async () => {
    const h = await harness();
    h.p.openRecord('nxt'); // C-R: nxt is set to record (scheduleId 4)
    await h.settle();
    h.choose('sp-rec-pre', '5');
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [row({ status: 'recording' })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, 'nothing the server would refuse');
    assert.match(h.body(), /<p class="rerr" role="alert">It has started recording, so only Finish late can change now\. Nothing was changed\.<\/p>/);
    assert.match(h.body(), /<select id="sp-rec-pre" data-key="r:sp-rec-pre" disabled>[\s\S]*?<option value="2" selected>/);
    assert.match(h.body(), /CHANGE RECORDING · RECORDING NOW/);
    await h.save();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'PUT'))), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
});

test('gone by Save: nothing is sent, the page says so', async () => {
    const h = await harness();
    h.p.openRecord('nxt');
    await h.settle();
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0);
    assert.match(h.body(), /This recording has finished or no longer exists, so it cannot be changed\./);
});

test('a failure after the page was closed is still told', async () => {
    let fail;
    const h = await harness({ schedule: () => new Promise((resolve, reject) => { fail = reject; }) });
    h.f.games.find(g => g.id === 'nxt').recording = null;
    h.state.scheduled = [];
    h.p.openRecord('nxt');
    h.b.document.body.querySelector('dialog [data-act="r-save"]').click();
    await h.settle();
    h.p.closeWindow();
    fail(new Error('boom'));
    await h.settle();
    const last = h.b.context.toasts.at(-1);
    assert.equal(last[0], 'The recording could not be scheduled.');
    assert.equal(last[1].kind, 'error');
});
