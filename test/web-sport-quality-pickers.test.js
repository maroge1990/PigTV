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

async function harness({ phone = false, channels = SKY } = {}) {
    const f = answer();
    f.games.find(g => g.id === 'ars').channels = channels.map(c => ({ ...c }));
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
const chipsOf = (html) => [...html.matchAll(/<(button|span) (class="qb[^"]*"[^>]*)>([^<]*)(?:<i class="pig-amount">(\d+)<\/i>)?(?:<small class="pig-amount">[^<]*<\/small>)?<\/\1>/g)].map(m => {
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
    // two quality words joined by a slash (the fake provider's "UHD/4K"): neither, nor the slash, stays in the row's name
    assert.equal(V.baseName('UK| SKY SPORTS F1 UHD/4K'), 'UK| SKY SPORTS F1');
    assert.equal(V.baseName('Sky Sports F1 4K/HDR'), 'Sky Sports F1');
    assert.equal(V.baseName('BBC One/Two'), 'BBC One/Two', 'a slash between other words stays');
    assert.deepEqual(plain(V.channelGroups([{ name: 'UK| SKY SPORTS F1 UHD/4K' }, { name: 'UK| SKY SPORTS F1 FHD' }]).map(r => r.name)), ['UK| SKY SPORTS F1'],
        'without the server\'s nameKey the copies still share one row');
    // the badge: 4K the accent, the others subtle, then fps; a name's label dashed
    assert.match(V.qualityBadge({ label: '4K', fps: 50, measured: true }), /^<span class="qb top" title="Measured 4K at 50 fps">4K<i class="pig-amount">50<\/i><\/span>$/);
    assert.match(V.qualityBadge({ label: 'HD', fps: null, measured: false }), /^<span class="qb guess" title="HD from the channel’s name \(not measured yet\)">HD<\/span>$/);
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

test('the menu: one name in several qualities still opens "Watch another channel", with its chips', async () => {
    const h = await harness();
    const items = h.p.menuItems(h.p.game('ars'));
    assert.deepEqual(plain(items.filter(i => i.act === 'watch-on').map(i => [i.title, i.detail])), [['Watch another channel', 'UK| SKY SPORTS F1, Stan Sport 1']]);
    const html = h.p.menuMarkup(h.p.game('ars'));
    assert.match(html, /<div class="mgrp"><button type="button" class="mi" role="menuitem" tabindex="-1" data-act="watch-channel" data-id="ars" data-channel="1:u2">[\s\S]*?<b>UK\| SKY SPORTS F1<\/b>/);
    assert.deepEqual(chipsOf(html.slice(html.indexOf('class="qchips"'))).slice(0, 4), ['4K 50 accent → 1:u2', '1080 50 → 1:u1', '1080 25 → 1:u4', 'SD dashed → 1:u5']);
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

// Codex (medium): copies of one name in the same quality but on different airings (C-I's own start/end per channel)
// were folded into one chip, so only the first could be recorded. They fold only when the airing is the same too;
// a different airing is its own chip, with its start time when that differs from the row's.
test('same name and quality on different airings: two chips, both can be recorded or watched', async () => {
    const h = await harness({ channels: [
        { sourceId: 1, stableId: 'u1', id: '201', name: 'Sky Sports F1 HD', measured: { label: '1080', fps: 50 }, start: NOW - H, end: NOW + 2 * H },
        { sourceId: 1, stableId: 'u2', id: '202', name: 'Sky Sports F1', measured: { label: '1080', fps: 50 }, start: NOW - H / 2, end: NOW + 3 * H }
    ] });
    const ars = h.p.game('ars');
    h.p.openRecord('ars');
    const html = h.body();
    const chips = chipsOf(html.slice(html.indexOf('class="qchips"')));
    assert.equal(chips.length, 2, 'not folded');
    assert.deepEqual(chips.map(c => c.split(' → ')[1]), ['#0', '#1'], 'each airing schedulable');
    assert.match(html, /data-index="1"[^>]*aria-label="Record Sky Sports F1 in 1080 at 50 fps, starting [^"]+"[^>]*>1080<i class="pig-amount">50<\/i><small class="pig-amount">[^<]+<\/small>/, 'the later airing says when it starts');
    h.press({ 'data-act': 'r-on', 'data-index': '1' });
    assert.match(h.body(), /<span class="rmeta pig-amount">[^<]* · Sky Sports F1<\/span>/, 'the second airing chosen');
    // the watch pickers keep them apart too
    h.dialog().close();
    assert.deepEqual(chipsOf(h.p.menuMarkup(ars).slice(h.p.menuMarkup(ars).indexOf('class="qchips"'))).map(c => c.split(' → ')[1]), ['1:u1', '1:u2']);
    assert.match(h.p.menuMarkup(ars), /data-channel="1:u2" aria-label="Watch Sky Sports F1 in 1080 at 50 fps, starting /);
});

test('the badge keeps its own shape in the watch menu (T3)', () => {
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/css/sport.css'), 'utf8');
    const rule = (sel) => { const at = css.indexOf(`${sel} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
    // the menu's sub-line rule (.sp-menu .mi span span: display block) made the row's badge a full-width bar with no
    // gap between "4K" and "50": a more specific rule puts it back to the badge's inline-flex
    assert.match(css, /\.sp-menu \.mi span span \{ display: block;/);
    assert.match(rule('.sp-menu .mi span .qb'), /display: inline-flex/);
});

test('a row showing its chips has no best badge of its own (the first chip is it); a closed row keeps it (Mark, T3)', async () => {
    const wide = await harness();
    const menu = wide.p.menuMarkup(wide.p.game('ars'));
    const mainBtn = menu.slice(menu.indexOf('<div class="mgrp">'), menu.indexOf('class="qchips"', menu.indexOf('<div class="mgrp">')));
    assert.doesNotMatch(mainBtn, /class="qb/, 'the menu row with chips shown: no row badge');
    wide.p.openRecord('ars');
    const rec = wide.body(), button = rec.slice(rec.indexOf('class="rchg"'), rec.indexOf('class="qchips"', rec.indexOf('class="rchg"')));
    assert.doesNotMatch(button, /class="qb/, 'the Record on row with chips shown: no row badge');

    const phone = await harness({ phone: true });
    let html = phone.p.menuMarkup(phone.p.game('ars'));
    assert.match(html, /<span class="qb top qbest" title="Measured 4K at 50 fps">4K/, 'a closed row: its best badge');
    assert.doesNotMatch(html, /class="qb[^"]*qbest"[^>]* hidden/);
    phone.p.held = 'uk| sky sports f1';
    const pm = phone.p.menuMarkup(phone.p.game('ars'));
    assert.match(pm, /class="qb top qbest" hidden title=/, 'the menu row held open: no row badge');
});

test('a chip row wider than its box fades at the edge it overflows (the scroll cue), never when it fits', () => {
    const b = browser({ request: async () => ({}) });
    const vm = require('node:vm');
    const P = vm.runInContext('SportsPage', b.context);
    const el = (scrollWidth, clientWidth, scrollLeft) => { const n = b.document.createElement('span'); Object.assign(n, { scrollWidth, clientWidth, scrollLeft }); P.fadeEdges(n); return n.className; };
    assert.equal(el(300, 300, 0), '', 'fits: no fade');
    assert.equal(el(500, 300, 0), 'fade-r');
    assert.equal(el(500, 300, 100), 'fade-l fade-r');
    assert.equal(el(500, 300, 200), 'fade-l');
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/css/sport.css'), 'utf8');
    assert.match(css, /\.qchips\.fade-r[^{]*\{[^}]*mask-image: linear-gradient/);
    assert.match(css, /\.qchips\.fade-l[^{]*\{[^}]*mask-image: linear-gradient/);
});
