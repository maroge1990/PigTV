'use strict';
// #326: what is around the cards, as iOS draws it. Standings: the column names as the list card's note and no header
// row on show (kept for screen readers), 15 px rank and name, 12 px values, points not bold. F1 hidden: "Results
// hidden" with iOS's words; the iPhone's F1 league page has no kicker or hero buttons (its sport page has them). The
// banner's Record and "Open …" are iOS's secondary buttons (15/600, secondary text); Watch / Remind me the accent with
// a light top edge; the stale notice has the warning border; "Also in your sports" on a wide window plain accent
// buttons; scores in SF Rounded where the browser has it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, ctx } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

const golden = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', f), 'utf8'));

test('standings: the columns as the card\'s note, the header row only for screen readers', () => {
    const { V } = browser();
    const html = V.leaguePage('American football', 'NFL', 'nfl', { answer: golden('sports-page-nfl.json') }, ctx(V, answer()));
    assert.match(html, /<div class="lh"><b>[^<]+<\/b><span>W-L · Streak<\/span><\/div><table class="st"><thead class="visually-hidden">/);
    assert.match(rulesFor('.sp table.st td'), /font-size:\s*12px/);
    assert.match(rulesFor('.sp table.st td.pts'), /font-weight:\s*400/);
});

test('F1: "Results hidden" with iOS\'s words; the iPhone\'s F1 league page has no kicker or hero buttons', () => {
    const { V } = browser();
    const p = golden('sports-page-f1.json');
    const hidden = V.leaguePage('Motorsport', 'F1', 'f1', { answer: p }, ctx(V, answer(), { hide: true }));
    assert.match(hidden, /<b>Results hidden<\/b><span>Hide scores is on\. Grids, finishing orders and points stay hidden until it is turned off in Settings\.<\/span>/);
    const phone = V.leaguePage('Motorsport', 'F1', 'f1', { answer: p }, ctx(V, answer(), { phone: true }));
    assert.match(phone, /^<div class="tiles">/);
    assert.doesNotMatch(phone, /hero-actions|class="kicker/);
});

test('the banner\'s buttons, the stale notice, "Also in your sports", rounded figures', () => {
    const pill = rulesFor('.sp .pill');
    assert.match(pill, /color:\s*var\(--color-text-secondary\)/);
    assert.match(pill, /font-size:\s*15px/);
    assert.match(rulesFor('.sp .pill.primary'), /inset 0 1px 0 rgba\(255, 255, 255, \.25\)/);
    assert.match(rulesFor('.sp .sp-stale'), /inset 0 0 0 1px var\(--color-warning\)/);
    assert.match(rulesFor('.sp:not(.is-phone) .also button.b'), /background:\s*none[^]*color:\s*var\(--color-accent-text\)/);
    assert.match(rulesFor('.sp .sc'), /font-family:\s*ui-rounded/);
    assert.match(rulesFor('.sp .hero .htitle'), /font-size:\s*28px/);
});
