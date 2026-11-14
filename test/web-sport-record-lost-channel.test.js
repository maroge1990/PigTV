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
    f.games.find(g => g.id === 'ars').channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 1 HD', start: NOW - H, end: NOW + 2 * H });
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings/scheduled' ? [] : {}),
        recordings: { schedule: async (d) => { calls.push(d); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openDetails('ars');
    p.received = Date.now() - 1.5 * H; // Stan Sport 1's airing has ended; the HD channel's has not
    p.detailsAct('d-record-on', { getAttribute: (k) => (k === 'data-channel' ? '1:s1' : null) }, p.game('ars'));
    const body = b.document.body.querySelector('dialog .ui-dialog-body').innerHTML;
    assert.match(body, /<p class="rerr" role="alert">Stan Sport 1 isn’t showing the game any more\. Choose a channel to record on\.<\/p>/);
    assert.doesNotMatch(body, /aria-checked="true" data-act="r-on"/, 'no channel chosen for the person');
    assert.match(body, /data-act="r-on" data-index="0"[^>]*>[\s\S]*?<b>Stan Sport 1 HD<\/b>/);
    assert.doesNotMatch(body, /class="rmeta pig-amount">[^<]*· Stan Sport 1</, 'the header names no channel');
    const save = () => b.document.body.querySelector('dialog [data-act="r-save"]');
    assert.equal(save().disabled, true);
    const pick = b.document.createElement('button'); pick.setAttribute('data-act', 'r-on'); pick.setAttribute('data-index', '0');
    b.document.body.querySelector('dialog .ui-dialog-body').appendChild(pick); pick.click();
    assert.ok(!save().disabled);
    save().click();
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channelItemId, '109');
});
