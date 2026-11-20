'use strict';
// #327 with #217 (Mark, 15 Nov 2026): a recording made from the web's Sport section follows the game's end as iOS's
// does. Every way to record a game there sends the C-R card's `id` as `gameId` (C-M since 0440: the server keeps
// recording while the game is in play past the guide end, stops at the final + Finish late, the guide end + Finish late
// the floor and fallback); Change recording keeps the link (it sends only padding). A page game without a card sends none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page, stepTo } = require('./helpers/sportWeb');

const H = 3600000;
async function harness({ phone = false, scheduled = [] } = {}) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start, end: nxt.start + 2 * H });
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings/scheduled' ? scheduled : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; }, addRule: async (r) => { calls.push(['rule', r]); return {}; } } });
    b.context.matchMedia = (q) => ({ matches: phone && /max-width/.test(q), addEventListener() {} });
    b.context.window.matchMedia = b.context.matchMedia;
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const el = (attrs) => { const x = b.document.createElement('button'); for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v); b.document.body.appendChild(x); return x; };
    const inDialog = (attrs) => { const x = el(attrs); b.document.body.querySelector('dialog .ui-dialog-body').appendChild(x); x.click(); };
    const save = () => b.document.body.querySelector('dialog [data-act="r-save"]').click();
    const scheduledBodies = () => calls.filter(c => c[0] === 'schedule').map(c => c[1]);
    return { b, p, f, calls, el, inDialog, save, scheduledBodies, settle: () => new Promise(setImmediate) };
}

const paths = {
    'a card\'s ⋯ menu, Record this game': async (h) => { h.p.act('more', h.el({ 'data-id': 'nxt' })); h.p.act('record', h.el({ 'data-id': 'nxt' })); },
    'the banner\'s Record (the hero), then Record this game': async (h) => {
        h.p.pin('nxt');
        assert.match(h.p.root.innerHTML, /data-act="record-menu" aria-haspopup="menu" data-id="nxt" data-key="hero:record"/);
        h.p.act('record-menu', h.el({ 'data-id': 'nxt' }));
        assert.ok(h.b.document.body.querySelector('.sp-menu'));
        h.p.act('record', h.el({ 'data-id': 'nxt' }));
    },
    'More options…, Record game': async (h) => { h.p.act('record-options', h.el({ 'data-id': 'nxt' })); h.save(); },
    // #345: a press on a game to come opens its menu (the record options); the record page can start on another channel
    'a press on the card (its menu), More options…, Record game': async (h) => { h.p.select('nxt', h.el({ 'data-key': 'card:nxt' })); h.p.act('record-options', h.el({ 'data-id': 'nxt' })); h.save(); },
    'the record page on another channel, Record game': async (h) => { h.p.openRecord('nxt', { channel: '2:k5' }); h.save(); }
};
for (const [name, run] of Object.entries(paths)) {
    test(`${name}: the recording is linked to the game (gameId), so it stops when the game ends`, async () => {
        const h = await harness();
        await run(h);
        await h.settle();
        const sent = h.scheduledBodies();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].gameId, 'nxt');
    });
}

test('the phone carousel\'s Record (its menu on the card), then Record this game: linked to the game', async () => {
    const h = await harness({ phone: true });
    assert.match(h.p.root.innerHTML, /data-act="record-menu" aria-haspopup="menu" data-id="ars" data-key="[^"]+:record"/, 'the carousel card has Record');
    h.p.act('record-menu', h.el({ 'data-id': 'ars' }));
    assert.doesNotMatch(h.b.document.body.querySelector('.sp-menu').className, /\bsheet\b/, '#345: no bottom sheet on a phone');
    h.p.act('record', h.el({ 'data-id': 'ars' }));
    await h.settle();
    assert.equal(h.scheduledBodies()[0].gameId, 'ars');
});

test('Change recording keeps the link: it sends only padding, with PUT', async () => {
    const h = await harness({ scheduled: [{ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_stable_id: 's2', channel_item_id: '102', channel_name: 'Stan Sport 2' }] });
    h.f.games.find(g => g.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
    h.p.act('change-recording', h.el({ 'data-id': 'nxt' }));
    await h.settle();
    stepTo(h.b, h.p, 'sp-rec-post', 30);
    h.save();
    await h.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'PUT'))), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
    assert.equal(h.scheduledBodies().length, 0);
});

// #358: no "When it stops" (it had one option); a schedule's usual Finish late is 0 when it is linked to its game (ESPN's
// end, the server's default since #358), else Settings': either way untouched padding reads "Usual".
test('#358: Usual is the schedule\'s own usual: Finish late 0 for one linked to its game, Settings\' for one that is not', async () => {
    for (const [o, words] of [[{ gameId: 'nxt', pre_buffer_min: 1, post_buffer_min: 0 }, 'Usual'], [{ gameId: null, pre_buffer_min: 1, post_buffer_min: 5 }, 'Usual'],
        [{ gameId: 'nxt', pre_buffer_min: 1, post_buffer_min: 5 }, '1 min early, 5 min late']]) {
        const h = await harness({ scheduled: [{ id: 4, status: 'scheduled', endsWith: 'event', ...o }] });
        h.f.games.find(g => g.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
        h.p.openRecord('nxt');
        await h.settle();
        const html = h.b.document.body.querySelector('dialog .ui-dialog-body').innerHTML;
        assert.match(html, new RegExp(`<span class="rrn">Extra time</span><span class="rrv"><b>${words}</b>`), JSON.stringify(o));
        assert.doesNotMatch(html, /When it stops|When the game ends|When the guide says/);
    }
});

