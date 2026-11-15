'use strict';
// #326: the iPhone layout's follow carousel card as iOS draws it (SportPhonePage.followCard, SportPhoneLayout.card): the
// kicker is caption2 bold in secondary grey (red when live) and never adds "Your team"; "LIVE · AFL", "FINAL · …".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, ctx } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

test('the kicker names the state and the league, never whose team it is', () => {
    const { V } = browser();
    const html = V.front(ctx(V, answer(), { phone: true }));
    assert.match(html, /<div class="kicker k live"><span class="dot" aria-hidden="true"><\/span><span>Live · Premier League<\/span><\/div>/);
    assert.doesNotMatch(html.match(/<div class="carousel"[\s\S]*?<div class="dots"/)[0], /Your team ?<|· Your team|Your driver</);
});

test('the kicker is grey, red only when live, with an 8 px dot', () => {
    assert.match(rulesFor('.sp .fcard .kicker'), /color:\s*var\(--color-text-secondary\)/);
    assert.match(rulesFor('.sp .fcard .kicker'), /font-size:\s*11px/);
    assert.match(rulesFor('.sp .fcard .kicker.live'), /color:\s*var\(--live-text\)/);
    assert.match(rulesFor('.sp .fcard .kicker .dot'), /width:\s*8px/);
});
