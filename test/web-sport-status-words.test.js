'use strict';
// #326: the status words are iOS's (`SportsGame.statusLabel`): capitals on a card ("FINAL", "LIVE", "CANCELLED",
// "STATUS UNAVAILABLE"), never football's "FT"; an iPhone row says "LIVE 2nd half 67'" after its red dot, and a
// result "Final" (statusLabel.capitalized); the carousel's kicker "FINAL · Premier League", its line "Final".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, ctx } = require('./helpers/sportWeb');

test('statusWord is iOS\'s statusLabel, capitals, no "FT"', () => {
    const { V } = browser();
    const g = (o) => ({ league: 'EPL', sport: 'Football', status: 'finished', freshness: 'fresh', ...o });
    assert.equal(V.statusWord(g()), 'FINAL');
    assert.equal(V.statusWord(g({ league: 'NBA' })), 'FINAL');
    assert.equal(V.statusWord(g({ status: 'cancelled' })), 'CANCELLED');
    assert.equal(V.statusWord(g({ status: 'postponed' })), 'POSTPONED');
    assert.equal(V.statusWord(g({ status: 'live' })), 'LIVE');
    assert.equal(V.statusWord(g({ status: 'live', freshness: 'stale', broadcastStatus: null })), 'STATUS UNAVAILABLE');
    assert.equal(V.capitalized('STATUS UNAVAILABLE'), 'Status Unavailable');
    assert.equal(V.capitalized('FINAL'), 'Final');
});

test('a card\'s result reads FINAL; a row\'s live words LIVE and its result Final; the carousel\'s too', () => {
    const { V } = browser();
    const front = answer(), c = ctx(V, front);
    assert.match(V.card(front.games.find(x => x.id === 'avl'), c), /<span class="res">FINAL<\/span>/);
    const rows = V.front(ctx(V, front, { phone: true }));
    assert.match(rows, /<span class="lv"><span class="dot" aria-hidden="true"><\/span>LIVE 2nd half 67&#39;<\/span>/);
    assert.match(V.rowHtml(front.games.find(x => x.id === 'avl'), c), /<span class="l2 pig-amount"><span>Final<\/span><\/span>/);
    const done = V.gameCard(front.games.find(x => x.id === 'avl'), c, { key: 'k', leagueWord: 'Premier League' });
    assert.match(done, /<span>FINAL · Premier League<\/span>/);
    assert.match(done, /<span class="fline pig-amount">Final<\/span>/);
    assert.doesNotMatch(rows + done, />FT<|FT ·/);
    // a stale live game: the card's clock says what iOS says
    const stale = { ...front.games[0], freshness: 'stale', broadcastStatus: 'on-tv' };
    assert.equal(V.cardClock(stale, front, false), 'ON TV NOW');
    assert.ok(NOW);
});
