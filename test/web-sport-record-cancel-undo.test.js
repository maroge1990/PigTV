'use strict';
// Opus review of #327: Cancel recording with its 10 s Undo. As iOS: the card loses its recording at once (so the menu
// and the record page offer Record, never a Change recording of a recording about to go), through refreshes too; Undo
// puts it back; a new Record on the game during the Undo sends the waiting cancel first and then records, so the new
// recording stands and the cancel is sent once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page } = require('./helpers/sportWeb');

async function harness() {
    const calls = [];
    const f = answer(); // nxt: set to record, scheduleId 4
    let deleted = false;
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (m === 'DELETE') { deleted = true; return {}; }
        if (url === '/recordings/scheduled') return deleted ? [] : [{ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2' }];
        if (url === '/sports/front') return JSON.parse(JSON.stringify(f)); // the server still lists it until the cancel is sent
        return url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return { id: 5 }; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
    p.openRecord('nxt');
    await settle();
    // the notice's Undo is not drawn by the fake DOM: what it runs is kept here
    const real = b.context.UI.undoable;
    let options = null;
    b.context.UI.undoable = (message, o) => { options = o; return real.call(b.context.UI, message, o); };
    b.document.body.querySelector('dialog [data-act="r-cancel"]').click();
    return { b, p, calls, settle, undo: () => options, deletes: () => calls.filter(c => c[0] === 'DELETE') };
}
const items = (html) => [...html.matchAll(/data-act="([\w-]+)" data-id="nxt"/g)].map(m => m[1]);

test('cancelled with Undo open: the game has no recording at once, also after a refresh; nothing sent yet', async () => {
    const h = await harness();
    assert.equal(h.deletes().length, 0, 'held for its Undo');
    assert.equal(h.p.game('nxt').recording, null);
    await h.p.refresh();
    assert.equal(h.p.game('nxt').recording, null, 'a refresh that still lists it does not bring it back');
    h.p.openMenu(h.p.game('nxt'), h.b.document.body);
    const list = items(h.b.document.body.querySelector('.sp-menu').innerHTML);
    assert.ok(list.includes('record') && !list.includes('change-recording'), 'Record this game, not Change recording');
});

test('Record again during the Undo: the cancel is sent first and once, then the new recording is made', async () => {
    const h = await harness();
    h.p.openRecord('nxt');
    assert.doesNotMatch(h.b.document.body.querySelector('dialog .ui-dialog-body').innerHTML, /CHANGE RECORDING/);
    h.b.document.body.querySelector('dialog [data-act="r-save"]').click();
    await h.settle();
    const order = h.calls.filter(c => c[0] === 'DELETE' || c[0] === 'schedule').map(c => c[0]);
    assert.deepEqual(order, ['DELETE', 'schedule'], 'the waiting cancel first, then the new recording');
    await h.b.context.UI.flushPending();
    await h.settle();
    assert.equal(h.deletes().length, 1, 'never sent twice (the notice ending later sends nothing more)');
});

test('the quick Record in the menu during the Undo does the same', async () => {
    const h = await harness();
    await h.p.record('nxt');
    await h.settle();
    assert.deepEqual(h.calls.filter(c => c[0] === 'DELETE' || c[0] === 'schedule').map(c => c[0]), ['DELETE', 'schedule']);
});

test('Undo puts the recording back on the game and its card', async () => {
    const h = await harness();
    assert.equal(h.p.game('nxt').recording, null);
    h.undo().undo();
    assert.deepEqual(JSON.parse(JSON.stringify(h.p.game('nxt').recording)), { scheduleId: 4, status: 'scheduled' });
    assert.equal(h.p.cancels.size, 0);
    assert.equal(h.deletes().length, 0);
});
