'use strict';
// #326 (Mark, 15 Nov 2026): iOS has no visible "⋯" on a card (its menu is a long press). The web keeps the ⋯ but, with a
// mouse (a fine pointer that hovers), shows it only while the card is hovered or holds focus (keyboard) or its menu is
// open; on touch it stays visible. Right-click opens the same menu (web-sport-record-menu.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rulesFor } = require('./helpers/sportCss');
const { browser, answer, ctx } = require('./helpers/sportWeb');

const FINE = '(hover: hover) and (pointer: fine)';

test('with a mouse the ⋯ is hidden until the card is hovered or focused, or its menu is open', () => {
    assert.match(rulesFor('.sp .gitem .more-btn', { media: FINE }), /opacity:\s*0/);
    for (const sel of ['.sp .gitem:hover .more-btn', '.sp .gitem:focus-within .more-btn', '.sp .gitem .more-btn[aria-expanded="true"]']) {
        assert.match(rulesFor(sel, { media: FINE }), /opacity:\s*1/, sel);
    }
});

test('on touch (outside the fine-pointer query) nothing hides it', () => {
    assert.doesNotMatch(rulesFor('.sp .more-btn'), /opacity:\s*0|display:\s*none|visibility/);
    assert.doesNotMatch(rulesFor('.sp .gitem .more-btn'), /opacity:\s*0/);
});

test('the ⋯ is still a button in the markup, after the card, for the keyboard', () => {
    const { V } = browser();
    const html = V.card(answer().games.find(g => g.id === 'nxt'), ctx(V, answer()));
    assert.match(html, /<\/button><button type="button" class="more-btn" data-act="more" data-id="nxt"[^>]*aria-haspopup="menu"[^>]*aria-label="More options for Newcastle v Tottenham">/);
});
