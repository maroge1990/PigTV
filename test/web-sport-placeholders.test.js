'use strict';
// #326: iOS draws a loading Sport page as neutral blocks the shape and size of the real cards, pulsing
// (SportPlaceholders, PageStateViews): the banner, rails of 260 x 112 cards, a league's chips, fixture cards and
// standings, F1 tiles. The web showed a spinner and "Loading…". Screen readers still hear "Loading…".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

test('each kind of page loads as its own shapes, with Loading… for screen readers and no spinner', () => {
    const { V } = browser();
    for (const [kind, phone, shape] of [['front', false, /ph-banner[\s\S]*ph-list[\s\S]*ph-rail[\s\S]*ph-card/], ['front', true, /ph-fcard[\s\S]*ph-rows/],
        ['sport', false, /ph-banner[\s\S]*ph-chips[\s\S]*ph-fx[\s\S]*ph-table/], ['league', false, /ph-chips[\s\S]*ph-fx[\s\S]*ph-table/],
        ['f1', false, /ph-tile[\s\S]*lists3/], ['cricket', false, /ph-board/]]) {
        const html = V.placeholder(kind, phone);
        assert.match(html, new RegExp(`^<div class="sp-ph" role="status" aria-busy="true" data-ph="${kind}"><span class="visually-hidden">Loading…</span><div class="ph-in" aria-hidden="true">`), kind);
        assert.match(html, shape, `${kind} ${phone ? 'phone' : 'computer'}`);
        assert.doesNotMatch(html, /spinner|state-loading/);
    }
});

test('the page draws them while the front page, a sport page or a league page first loads', async () => {
    const b = browser({ request: () => new Promise(() => {}) });
    const p = page(b, {});
    p.show('');
    assert.match(p.root.innerHTML, /data-ph="front"/);
    assert.doesNotMatch(p.root.innerHTML, /state-loading/);
    p.openPath('Football', 'none');
    assert.match(p.root.innerHTML, /data-ph="sport"/);
    p.openPath('Football/EPL', 'none');
    assert.match(p.root.innerHTML, /data-ph="league"/);
});

test('the placeholders pulse to 45 % (not with Reduce Motion)', () => {
    assert.match(rulesFor('.sp .sp-ph .ph-in', { media: 'prefers-reduced-motion: no-preference' }), /animation:\s*sp-pulse/);
    assert.match(rulesFor('.sp .ph-block'), /background:\s*var\(--raised\)/);
});

test('the answer replaces them', async () => {
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? answer() : url === '/sports/pages/preferences' ? { spoilerFree: false } : {}) });
    const p = page(b, {});
    await p.show('');
    assert.doesNotMatch(p.root.innerHTML, /sp-ph/);
});
