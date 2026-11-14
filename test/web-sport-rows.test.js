'use strict';
// #326: the iPhone layout's fixture rows as iOS draws them (SportPhoneLayout.row, SportFrontPhonePage): a session's
// row is titled by its session ("Race", the event read after it), a row has no record mark, and the front page shows
// three rows per sport (rowsPerSport), its header opening the rest.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, ctx } = require('./helpers/sportWeb');

test('a session row is titled by its session, its event for screen readers', () => {
    const { V } = browser();
    const front = answer();
    const html = V.rowHtml(front.games.find(g => g.id === 'f1'), ctx(V, front));
    assert.match(html, /<span class="t"><span class="star" aria-hidden="true">★<\/span><span class="visually-hidden">Your team, <\/span>Race<span class="visually-hidden">, Las Vegas Grand Prix<\/span><\/span>/);
});

test('no record mark on a row (the card keeps it)', () => {
    const { V } = browser();
    const front = answer(), nxt = front.games.find(g => g.id === 'nxt');
    assert.doesNotMatch(V.rowHtml(nxt, ctx(V, front)), /rmark/);
    assert.match(V.card(nxt, ctx(V, front)), /class="rmark"/);
});

test('three rows per sport on the phone front page', () => {
    const { V } = browser();
    const front = answer();
    const extra = (id, h) => ({ ...front.games.find(g => g.id === 'nxt'), id, start: NOW + h * 3600000, recording: null });
    front.games.push(extra('x1', 3), extra('x2', 4));
    front.rails[0].gameIds.push('x1', 'x2');
    const html = V.front(ctx(V, front, { phone: true }));
    const football = html.match(/<section class="grp" aria-label="Football">[\s\S]*?<\/section>/)[0];
    assert.equal((football.match(/class="row"/g) || []).length, 3);
});
