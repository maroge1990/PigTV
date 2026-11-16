'use strict';
// #266 (D-65 option C) on the web: wherever Sport offers a choice of channels for a game (the menu's "Watch on…", the
// details window, the record page's "Record on"), one row per channel name (quality words aside), with one chip per
// measured quality and frame rate, best first (4K, 1080, 720, SD, then the higher frame rate); copies with the same
// name, quality and frame rate fold into one chip, which plays or records the first of them in the server's best-first
// order; a copy never measured shows a dashed chip with its name's label; a name in one quality has no chips. Narrow
// window (iPhone layout): the row shows its best chip, a tap plays the best copy, and touch and hold opens the chips.
// The old pickers listed every copy as its own row with the name's quality tag only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;
const air = { start: NOW - H, end: NOW + 2 * H };
// the server's order (C-I: best first by the name's quality, then health, favourite, guide order)
const SKY = [
    { sourceId: 1, stableId: 'u1', id: '201', name: 'UK| SKY SPORTS F1 ᵁᴴᴰ', quality: 'UHD', measured: { label: '1080', fps: 50 }, ...air },
    { sourceId: 1, stableId: 'u2', id: '202', name: 'UK| SKY SPORTS F1 FHD', quality: 'FHD', measured: { label: '4K', fps: 50 }, ...air },
    { sourceId: 1, stableId: 'u3', id: '203', name: 'UK| SKY SPORTS F1 HD', quality: 'HD', measured: { label: '1080', fps: 50 }, ...air },
    { sourceId: 1, stableId: 'u4', id: '204', name: 'UK| SKY SPORTS F1 HD', quality: 'HD', measured: { label: '1080', fps: 25 }, ...air },
    { sourceId: 1, stableId: 'u5', id: '205', name: 'UK| SKY SPORTS F1 SD', quality: 'SD', ...air },
    { sourceId: 1, stableId: 's1', id: '101', name: 'Stan Sport 1', ...air }
];

async function harness({ phone = false } = {}) {
    const f = answer();
    f.games.find(g => g.id === 'ars').channels = SKY.map(c => ({ ...c }));
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings/scheduled' ? [] : {}),
        recordings: { schedule: async () => ({}) } });
    b.context.matchMedia = (q) => ({ matches: phone && /max-width/.test(q), addEventListener() {} });
    b.context.window.matchMedia = b.context.matchMedia;
    const played = [];
    const app = { currentUser: { role: 'admin' }, navigateTo: () => {}, setLocation() {},
        channelList: { channels: SKY.map(c => ({ sourceId: c.sourceId, stableId: c.stableId, id: `p${c.id}` })),
            loadSources: async () => {}, loadChannels: async () => {}, selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    p.labels = { EPL: 'Premier League' };
    const dialog = () => b.document.body.querySelector('dialog');
    const body = () => dialog()?.querySelector('.ui-dialog-body')?.innerHTML || '';
    const press = (attrs) => {
        const el = b.document.createElement('button');
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        dialog().querySelector('.ui-dialog-body').appendChild(el);
        el.click();
        return el;
    };
    return { b, p, played, dialog, body, press, settle: () => new Promise(setImmediate) };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
/** Each quality badge or chip in `html` as "label fps [accent] [dashed] [→ its channel or #index]". */
const chipsOf = (html) => [...html.matchAll(/<(button|span) (class="qb[^"]*"[^>]*)>([^<]*)(?:<i class="pig-amount">(\d+)<\/i>)?<\/\1>/g)].map(m => {
    const attr = (k) => (m[2].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
    const cls = attr('class'), ch = attr('data-channel'), ix = attr('data-index');
    return `${m[3]}${m[4] ? ` ${m[4]}` : ''}${/\btop\b/.test(cls) ? ' accent' : ''}${/\bguess\b/.test(cls) ? ' dashed' : ''}${ch ? ` → ${ch}` : ix ? ` → #${ix}` : ''}`;
});

test('grouping: one row per name (quality words aside), chips best first, same quality and fps folded in server order', () => {
    const { V } = browser();
    const rows = V.channelGroups(SKY);
    assert.deepEqual(plain(rows.map(r => r.name)), ['UK| SKY SPORTS F1', 'Stan Sport 1']);
    assert.deepEqual(plain(rows[0].chips.map(c => [c.q.label, c.q.fps, c.q.measured, c.channels.map(x => x.stableId)])
        ), [['4K', 50, true, ['u2']], ['1080', 50, true, ['u1', 'u3']], ['1080', 25, true, ['u4']], ['SD', null, false, ['u5']]]);
    assert.deepEqual(plain(rows[1].chips.map(c => [c.q.label, c.q.measured])), [[null, false]], 'one copy, nothing measured: no label');
    assert.equal(V.baseName('Sky Sports Main Event 1080p50'), 'Sky Sports Main Event');
    assert.equal(V.baseName('ESPN (720p)'), 'ESPN');
    assert.equal(V.baseName('HDTV Classics'), 'HDTV Classics', 'a word that only starts with HD stays');
    // the badge: 4K the accent, the others subtle, then fps; a name's label dashed
    assert.match(V.qualityBadge({ label: '4K', fps: 50, measured: true }), /^<span class="qb top" title="Measured 4K at 50 fps">4K<i class="pig-amount">50<\/i><\/span>$/);
    assert.match(V.qualityBadge({ label: 'HD', fps: null, measured: false }), /^<span class="qb guess" title="HD from the channel’s name \(not measured yet\)">HD<\/span>$/);
});

test('the details window (wide): one row for the copies with its chips; a chip plays its best copy', async () => {
    const h = await harness();
    h.p.openDetails('ars');
    const html = h.body();
    assert.equal((html.match(/<li class="dch/g) || []).length, 2, 'two rows: the Sky copies and Stan Sport 1');
    assert.match(html, /<li class="dch dq"><span class="dct"><b>UK\| SKY SPORTS F1<\/b><span class="dsub">Recommended<\/span><span class="qchips" role="group"/);
    const sky = html.slice(html.indexOf('dch dq'), html.indexOf('</li>'));
    assert.deepEqual(chipsOf(sky), ['4K 50 accent → 1:u2', '1080 50 → 1:u1', '1080 25 → 1:u4', 'SD dashed → 1:u5']);
    assert.match(sky, /data-act="d-watch-on" data-channel="1:u2" data-key="d:q:1:u2" aria-label="Watch UK\| SKY SPORTS F1 in 4K at 50 fps"/);
    assert.match(html, /<b>Stan Sport 1<\/b><\/span>/, 'one copy, nothing measured: no badge, no chips');
    h.press({ 'data-act': 'd-watch-on', 'data-channel': '1:u1' });
    await h.settle();
    assert.deepEqual(h.played, ['p201'], 'the 1080 50 chip plays the first of its copies');
});

test('the record page (wide): one Record on row per name, its chips choose the copy, the chosen chip pressed', async () => {
    const h = await harness();
    h.p.openRecord('ars');
    let html = h.body();
    assert.match(html, /<div class="rchg"><button type="button" class="rchoice rch on" role="radio" aria-checked="true" data-act="r-on" data-index="0"[^>]*>[\s\S]*?<b>UK\| SKY SPORTS F1<\/b>/);
    const chips = () => chipsOf(h.body().slice(h.body().indexOf('class="rchg"'), h.body().indexOf('</div>', h.body().indexOf('class="qchips"'))));
    assert.deepEqual(chips(), ['4K 50 accent → #1', '1080 50 → #0', '1080 25 → #3', 'SD dashed → #4']);
    assert.match(html, /class="qb qchip on" type="button" data-act="r-on" data-index="0" data-key="r:q:0"[^>]*aria-pressed="true"/, 'the server\'s first copy is chosen: its chip (1080 50)');
    h.press({ 'data-act': 'r-on', 'data-index': '1' });
    html = h.body();
    assert.match(html, /class="qb top qchip on" type="button" data-act="r-on" data-index="1"[^>]*aria-pressed="true"/, '4K chosen');
    assert.match(html, /<span class="rmeta pig-amount">[^<]* · UK\| SKY SPORTS F1 FHD<\/span>/, 'the copy it records on');
    assert.match(html, /role="radio" aria-checked="false" data-act="r-on" data-index="5"[^>]*>[\s\S]*?<b>Stan Sport 1<\/b>/);
});

test('the menu: one name in several qualities still opens "Watch on…", with its chips', async () => {
    const h = await harness();
    const items = h.p.menuItems(h.p.game('ars'));
    assert.deepEqual(plain(items.filter(i => i.act === 'watch-on').map(i => [i.title, i.detail])), [['Watch on… (2 channels)', 'UK| SKY SPORTS F1, Stan Sport 1']]);
    const html = h.p.menuMarkup(h.p.game('ars'));
    assert.match(html, /<div class="mgrp"><button type="button" class="mi" role="menuitem" tabindex="-1" data-act="watch-channel" data-id="ars" data-channel="1:u2">[\s\S]*?<b>UK\| SKY SPORTS F1<\/b>/);
    assert.deepEqual(chipsOf(html.slice(html.indexOf('class="qchips"'))).slice(0, 4), ['4K 50 accent → 1:u2', '1080 50 → 1:u1', '1080 25 → 1:u4', 'SD dashed → 1:u5']);
});

test('narrow window (iPhone layout): the row shows its best chip; touch and hold opens its chips', async () => {
    const h = await harness({ phone: true });
    h.p.openDetails('ars');
    let html = h.body();
    assert.match(html, /<li class="dch dq" data-hold="uk\| sky sports f1"><span class="dct"><b>UK\| SKY SPORTS F1<\/b> <span class="qb top" title="Measured 4K at 50 fps">4K<i class="pig-amount">50<\/i><\/span>/);
    assert.match(html, /<span class="qchips" role="group" aria-label="UK\| SKY SPORTS F1: qualities" hidden>/, 'chips closed');
    assert.match(html, /data-act="d-watch-on" data-channel="1:u2" data-key="d:w:1:u2"/, 'Watch plays the best copy: the best chip\'s first');
    // a long press (the phone browser's contextmenu) on the row opens it
    const row = h.b.document.createElement('li');
    row.setAttribute('data-hold', 'uk| sky sports f1');
    h.dialog().querySelector('.ui-dialog-body').appendChild(row);
    const ev = new FakeEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, 'no browser menu');
    h.p.window.redraw();
    html = h.body();
    assert.match(html, /<span class="qchips" role="group" aria-label="UK\| SKY SPORTS F1: qualities">/, 'chips open after the hold');
    // a wide window has no hold
    const wide = await harness();
    wide.p.openDetails('ars');
    assert.doesNotMatch(wide.body(), /data-hold=/);
});

test('the server\'s nameKey decides the rows when it is sent (both clients group alike)', () => {
    const { V } = browser();
    const rows = V.channelGroups([
        { sourceId: 1, id: '1', name: 'Fox Sports 505', nameKey: 'fox sports' },
        { sourceId: 1, id: '2', name: 'Fox Sports', nameKey: 'fox sports', measured: { label: '720', fps: 60 } },
        { sourceId: 1, id: '3', name: 'Kayo 1 HD', nameKey: 'kayo one' }, { sourceId: 1, id: '4', name: 'Kayo 1', nameKey: 'kayo 1' }
    ]);
    assert.deepEqual(plain(rows.map(r => [r.key, r.chips.flatMap(c => c.channels.map(x => x.id))])), [['fox sports', ['2', '1']], ['kayo one', ['3']], ['kayo 1', ['4']]]);
});
