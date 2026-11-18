'use strict';
// #326: the events pages as iOS draws them (SportEventsViews, SportMotorViews). Tennis: a match card 300 wide, a button
// when its event has a card, its state beside the kicker (red "LIVE", no live outline, no dot), a followed match the
// pink outline; Live now, Tonight and Results today always there with their empty words. Golf: "Leaderboard hidden",
// your player "In the field · round N in play" when hidden, "TO THE LEAD" before the gap. UFC: the line bold, red when
// live, a followed bout tinted. Racing: the entry list's note, a followed driver tinted, "Winner hidden".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, ctx } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

const golden = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', f), 'utf8'));
const H = 3600000;

function tennis(status = 'live') {
    const p = golden('sports-page-events-atp-tour.json');
    p.events[0].matches = p.events[0].matches.slice(0, 1);
    Object.assign(p.events[0].matches[0], { start: NOW - H, status, sets: [[6, 4], [3, 2]] });
    p.events[0].matches[0].players[0].winner = status === 'finished';
    p.events[0].followed = [p.events[0].matches[0].players[0].name];
    return p;
}

test('tennis: iOS\'s match card, the state beside the kicker, the followed outline, no live dot or outline', () => {
    const { V } = browser();
    const p = tennis();
    const front = answer();
    front.games.push({ ...front.games[0], id: p.events[0].id, followed: false });
    const html = V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: p }, ctx(V, front));
    assert.match(html, new RegExp(`<div class="gitem titem"><button type="button" class="gcard tcard fol" data-act="game" data-id="${p.events[0].id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
    assert.match(html, /<span class="tk"><span class="sk">[^<]*<\/span><span class="tst live pig-amount">LIVE<\/span><\/span>/);
    const rails = html.slice(html.indexOf('aria-label="Your players"'));
    assert.doesNotMatch(rails, /class="dot"|gcard tcard[^"]*live/);
    assert.match(rulesFor('.sp .titem'), /flex:\s*0 0 300px/);
    // without a card of its own the match is not a button
    assert.match(V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: tennis() }, ctx(V, answer())), /<div class="gitem titem"><div class="gcard tcard fol">/);
});

test('tennis: Live now, Tonight and Results today are always there, with their empty words; hidden, the results note', () => {
    const { V } = browser();
    const html = V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: tennis('finished') }, ctx(V, answer()));
    assert.match(html, /aria-label="Live now">[^]*?<p class="sp-muted rail-empty">No match in play right now\.<\/p>/);
    assert.match(html, /aria-label="Tonight">[^]*?<p class="sp-muted rail-empty">Nothing more today\.<\/p>/);
    const hidden = V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: tennis('finished') }, ctx(V, answer(), { hide: true }));
    assert.match(hidden, /<span class="s">Results today<\/span><\/span>/);
    assert.doesNotMatch(hidden, /class="sets|trow won|>Final</, 'no set, winner or result word');
});

test('golf: your player hidden says the round only; shown, "To the lead" before the gap', () => {
    const { V } = browser();
    const p = golden('sports-page-events-pga-tour.json');
    const lb = p.events[0].leaderboard, me = lb[lb.length - 1];
    lb[0].toPar = '-23'; lb[0].pos = lb[0].pos || 1; me.toPar = '-17';
    p.events[0].followed = [me.name];
    const shown = V.leaguePage('Golf', 'PGA Tour', 'events', { answer: p }, ctx(V, answer()));
    assert.match(shown, /<span class="gk">To the lead<\/span><span class="gap">/);
    const hidden = V.leaguePage('Golf', 'PGA Tour', 'events', { answer: p }, ctx(V, answer(), { hide: true }));
    assert.match(hidden, /<div class="rd">In the field( · round \d+ in play)?<\/div>/);
    assert.match(hidden, /<b>Leaderboard<\/b><\/div><p class="hidden-note">[^]*?<span>Scores hidden<\/span>/);
});

test('UFC: a followed bout tinted, a live bout\'s line red', () => {
    const { V } = browser();
    const p = golden('sports-page-events-ufc.json');
    p.events = p.events.slice(0, 1);
    const b = p.events[0].bouts[0];
    b.status = 'live';
    p.events[0].followed = [b.fighters[0].name];
    const html = V.leaguePage('Combat', 'UFC', 'events', { answer: p }, ctx(V, answer()));
    assert.match(html, /<div class="bout[^"]* me live">/);
    assert.match(rulesFor('.sp .bout.live .bl'), /color:\s*var\(--live\)/);
    assert.match(rulesFor('.sp .bout.me'), /16%/);
});

test('racing: the entry list\'s note, a followed driver tinted, the winner hidden said', () => {
    const { V } = browser();
    const p = golden('sports-page-events-nascar.json');
    const focus = V.evFocus(p.events);
    const first = (focus.entryList || [])[0];
    if (first) focus.followed = [first.name];
    const html = V.leaguePage('Motorsport', 'NASCAR', 'events', { answer: p }, ctx(V, answer()));
    assert.match(html, /drivers · alphabetical, not a running order<\/span>/);
    if (first) assert.match(html, /<li class="me">/);
    const hidden = V.leaguePage('Motorsport', 'NASCAR', 'events', { answer: p }, ctx(V, answer(), { hide: true }));
    if (p.lastWinner) {
        assert.match(hidden, /<b>Last winner<\/b><span class="w"><svg[^]*?<\/svg>Winner hidden<\/span>/);
        assert.ok(!hidden.includes(p.lastWinner.name), 'the winner is not named');
    }
});
