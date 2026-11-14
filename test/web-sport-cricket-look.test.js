'use strict';
// #326: the cricket page as iOS draws it (CricketPageView): the batting side's name heavy while play is on (scores
// shown only: it says who is batting), a followed team's star and tint, "Scores hidden" under the names when hidden;
// the state pill red when live, raised grey when done, else an outlined accent capsule; the series' season "2026–27"
// and the current match's state in a pill; the other matches without team badges, their state red (no dot) when live,
// accent before, grey after, a live card's outline at 35 %.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, ctx } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

const golden = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'sports-page-cricket.json'), 'utf8'));
const live = () => { const p = golden(); p.lead.status = 'live'; return p; };
const draw = (V, p, o = {}) => V.leaguePage('Cricket', 'Cricket', 'cricket', { answer: p, loaded: true }, ctx(V, answer(), { leagues: ['Cricket'], following: ['Australia'], ...o }));

test('the batting side is heavy while live, only with scores shown', () => {
    const { V } = browser();
    const rows = draw(V, live()).split('<div class="tm').slice(1);
    assert.ok(rows.find(r => r.includes('South Africa')).includes('class="nm bat"'), 'South Africa\'s innings is the open one');
    assert.ok(!rows.find(r => r.includes('Australia')).includes('class="nm bat"'));
    assert.doesNotMatch(draw(V, live(), { hide: true }), /\bbat\b/, 'hidden: nobody is shown batting');
    assert.match(rulesFor('.sp .board .tm .nm.bat'), /font-weight:\s*800/);
});

test('a followed team has its star and the tint; hidden, "Scores hidden" is said under the names', () => {
    const { V } = browser();
    assert.match(draw(V, golden()), /<div class="tm me"[^>]*><span class="nm">[^]*?<span class="star" aria-hidden="true">★<\/span><span class="visually-hidden">Your team, <\/span>Australia<\/span>/);
    assert.match(draw(V, golden(), { hide: true }), /<div class="bhidden"><svg[^]*?<\/svg><span>Scores hidden<\/span><\/div>/);
});

test('the pill: live red, done grey, else outlined accent; the series season and current-match pill', () => {
    const { V } = browser();
    assert.match(draw(V, live()), /<span class="lpill live">Live<\/span>/);
    const done = golden(); done.lead.status = 'done';
    assert.match(draw(V, done), /<span class="lpill done">Finished<\/span>/);
    assert.match(draw(V, golden()), /<span class="lpill">[^<]+<\/span>/);
    assert.match(rulesFor('.sp .lpill'), /box-shadow:\s*inset 0 0 0 2px var\(--color-accent\)/);
    const html = draw(V, golden());
    assert.match(html, /<span>2026–27<\/span>/);
    assert.match(html, /<div class="sm cur">[^]*?<span class="res lpill">Stumps · day 4<\/span>/);
});

test('the other matches: no badges, iOS\'s state colours, no live dot', () => {
    const { V } = browser();
    const p = golden();
    p.others[0].status = 'live';
    const html = draw(V, p);
    const other = html.match(/<section class="others"[^]*<\/section>/)[0];
    assert.doesNotMatch(other, /class="(badge|disc)/);
    assert.doesNotMatch(other, /class="dot"/);
    assert.match(other, /<button type="button" class="gcard ocard live"[^]*?<span class="clk pig-amount">Live<\/span>/);
    assert.match(rulesFor('.sp .ocard.live'), /35%/);
    assert.match(rulesFor('.sp .ocard .cbot .soon'), /color:\s*var\(--color-accent-text\)/);
});
