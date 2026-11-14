'use strict';
// #326 (iOS #254, SportScoreText): on the iPhone layout a cricket or AFL score is shown short between the names
// ("245/6–180/3", AFL's points "60–52"), the overs or goals.behinds small under it on the carousel card; a row shows
// the short score. A screen reader still hears the whole score. Hidden scores: none of it, nor the detail line.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, ctx, assertNoScores } = require('./helpers/sportWeb');

const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

test('the split follows iOS: cricket keeps runs/wickets, AFL its points; anything else whole', () => {
    const { V } = browser();
    eq(V.splitScore('245/6 (45.2)'), { main: '245/6', detail: '45.2 ov' });
    eq(V.splitScore('180/3 (31.4 ov)'), { main: '180/3', detail: '31.4 ov' });
    eq(V.splitScore('9.6 (60)'), { main: '60', detail: '9.6' });
    eq(V.splitScore('47'), { main: '47', detail: null });
    eq(V.shortScore(['245/6 (45.2)', '180/3 (31.4)']), { main: '245/6–180/3', detail: '45.2 ov – 31.4 ov' });
    eq(V.shortScore(['9.6 (60)', '7.5 (47)']), { main: '60–47', detail: '9.6 – 7.5' });
    eq(V.shortScore(['2', '1']), { main: '2–1', detail: null });
});

function front() {
    const f = answer();
    const afl = { ...f.games[0], id: 'afl', league: 'AFL', sport: 'Australian football', title: 'Collingwood v Richmond', followed: false,
        competitors: [{ name: 'Collingwood' }, { name: 'Richmond' }], scores: ['9.6 (60)', '7.5 (47)'], progress: { period: 3, clock: '12:04' } };
    const cri = { ...f.games.find(g => g.id === 'cri'), scores: ['245/6 (45.2)', '180/3 (31.4)'] };
    f.games = [...f.games.filter(g => g.id !== 'cri'), afl, cri];
    f.rails.push({ league: 'AFL', sport: 'Australian football', gameIds: ['afl'] });
    return f;
}

test('an iPhone row shows the short score; the carousel card the short score with the detail under it', () => {
    const { V } = browser();
    const f = front(), c = ctx(V, f, { phone: true });
    const row = V.rowHtml(f.games.find(g => g.id === 'afl'), c);
    assert.match(row, /<span class="sc pig-amount"><span aria-hidden="true">60–47<\/span><span class="visually-hidden">9\.6 \(60\)–7\.5 \(47\)<\/span><\/span>/);
    const card = V.gameCard(f.games.find(g => g.id === 'cri'), c, { key: 'k', leagueWord: 'Cricket' });
    assert.match(card, /<span class="fscore small pig-amount"><span aria-hidden="true">245\/6–180\/3<\/span><span class="visually-hidden">245\/6 \(45\.2\)–180\/3 \(31\.4\)<\/span><\/span><span class="fdetail pig-amount" aria-hidden="true">45\.2 ov – 31\.4 ov<\/span>/);
    const plain = V.gameCard(f.games[0], c, { key: 'k', leagueWord: 'Premier League' });
    assert.match(plain, /<span class="fscore pig-amount">47–31<\/span><\/span>/);
    assert.doesNotMatch(plain, /fdetail/);
});

test('with scores hidden: no short score, no overs or goals.behinds line', () => {
    const { V } = browser();
    const f = front(), c = ctx(V, f, { phone: true, hide: true });
    const html = V.front(c) + V.gameCard(f.games.find(g => g.id === 'cri'), c, { key: 'k', leagueWord: 'Cricket' }) + V.gameCard(f.games.find(g => g.id === 'afl'), c, { key: 'k', leagueWord: 'AFL' });
    assertNoScores(html, 'phone');
    assert.doesNotMatch(html.replace(/<svg[\s\S]*?<\/svg>/g, ""), /fdetail|45\.2|31\.4|9\.6|7\.5|\b60\b|245\/6|180\/3/);
});
