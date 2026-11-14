'use strict';
// #326 (Mark, 15 Nov 2026): the web Sport cards look like iOS's. iOS fills every game card, fixture card and F1 session
// tile with pigRaised (`--raised`) and draws no border (PigSurfaceButtonStyle); the banner has no border either. A
// followed card keeps its 3 pt accent outline, a live one its 2 pt danger outline; a live F1 tile has the outline too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rulesFor } = require('./helpers/sportCss');
const { browser } = require('./helpers/sportWeb');

for (const sel of ['.sp .gcard', '.sp .fx', '.sp .tile']) {
    test(`${sel}: the raised fill and no border`, () => {
        const r = rulesFor(sel);
        assert.match(r, /background:\s*var\(--raised\)/, `${sel} is filled with --raised`);
        assert.doesNotMatch(r, /border:\s*1px/, `${sel} has no 1 px border`);
    });
}

test('the banner has no border; the back button is raised, radius 16, no border', () => {
    assert.doesNotMatch(rulesFor('.sp .banner'), /border:\s*1px/);
    const back = rulesFor('.sp .banner .backbtn');
    assert.match(back, /border-radius:\s*16px/);
    assert.doesNotMatch(back, /border:\s*1px/);
});

test('the outlines: followed 3 px accent, live 2 px danger (cards, fixtures, live F1 tiles)', () => {
    for (const sel of ['.sp .gcard.fol', '.sp .fx.fol']) assert.match(rulesFor(sel), /inset 0 0 0 3px var\(--color-accent\)/, sel);
    for (const sel of ['.sp .gcard.live', '.sp .fx.live', '.sp .tile.live']) assert.match(rulesFor(sel), /inset 0 0 0 2px color-mix\(in srgb, var\(--live\) 80%/, sel);
    assert.match(rulesFor('.sp .tile.live .ln'), /color:\s*var\(--live\)/, 'a live tile\'s line is red');
});

test('the game card is iOS\'s 260 wide with 40 px team rows', () => {
    assert.match(rulesFor('.sp .gitem'), /flex:\s*0 0 260px/);
    assert.match(rulesFor('.sp .trow'), /min-height:\s*40px/);
});

test('a live F1 session tile carries the live class', () => {
    const { V } = browser();
    const now = Date.UTC(2026, 10, 14, 9, 0);
    const weekend = { name: 'Las Vegas Grand Prix', round: 22, sessions: [
        { id: 'r', name: 'Race', start: now - 600000, end: now + 3600000, status: 'live', channels: [] },
        { id: 'q', name: 'Qualifying', start: now - 86400000, end: now - 80000000, status: 'done', channels: [] }] };
    const html = V.f1Page({ weekend }, { now, hide: true, phone: false, following: [] });
    assert.match(html, /class="tile live" data-act="game" data-id="f1s:r"/);
    assert.match(html, /class="tile done" data-act="game" data-id="f1s:q"/);
});
