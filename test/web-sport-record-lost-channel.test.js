'use strict';
// Opus review of #327: Record on a channel (a details row) whose airing has ended by the press never silently records the
// first channel instead: the record page says so, chooses none, and records only once the person chooses one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;
test('the chosen channel ended by the press: told, nothing chosen, Record game off until a channel is chosen', async () => {
    const calls = [];
    const f = answer();
    f.games.find(g => g.id === 'ars').channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 3 HD', start: NOW - H, end: NOW + 2 * H });
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings/scheduled' ? [] : {}),
        recordings: { schedule: async (d) => { calls.push(d); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.received = Date.now() - 1.5 * H; // Stan Sport 1's airing has ended; the HD channel's has not
    p.openRecord('ars', { channel: '1:s1' });
    const html = () => b.document.body.querySelector('dialog .ui-dialog-body').innerHTML;
    const body = html();
    assert.match(body, /<p class="rerr" role="alert">Stan Sport 1 isn’t showing the game any more\. Choose a channel to record on\.<\/p>/);
    assert.match(body, /data-to="channel" data-key="r:row:channel"><span class="rrn">Channel<\/span><span class="rrv"><b>Choose a channel<\/b>/, '#358: the Channel row asks for one');
    assert.doesNotMatch(body, /class="rmeta pig-amount">[^<]*Stan Sport 1</, 'the header names no channel');
    const open = b.document.createElement('button'); open.setAttribute('data-act', 'r-screen'); open.setAttribute('data-to', 'channel');
    b.document.body.querySelector('dialog .ui-dialog-body').appendChild(open); open.click();
    assert.doesNotMatch(html(), /aria-checked="true" data-act="r-on"/, 'no channel chosen for the person');
    assert.match(html(), /data-act="r-on" data-index="0"[^>]*>[\s\S]*?<b>Stan Sport 3 HD<\/b>/);

    const save = () => b.document.body.querySelector('dialog [data-act="r-save"]');
    assert.equal(save(), null, 'the Channel page has no buttons but Back');
    const back = b.document.createElement('button'); back.setAttribute('data-act', 'r-screen'); back.setAttribute('data-to', 'main');
    b.document.body.querySelector('dialog .ui-dialog-body').appendChild(back); back.click();
    assert.equal(save().disabled, true);
    const pick = b.document.createElement('button'); pick.setAttribute('data-act', 'r-on'); pick.setAttribute('data-index', '0');
    b.document.body.querySelector('dialog .ui-dialog-body').appendChild(pick); pick.click();
    assert.ok(!save().disabled);
    save().click();
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channelItemId, '109');
});
