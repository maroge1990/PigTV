'use strict';
// #326 review (medium): on a wide window a sport page embeds its league's own page; when that page fails, is not
// available, lists no rounds, or holds fewer of the league's upcoming games than the front page has, the front page's
// games of the league still show as cards (the page before the embed always showed them).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, ctx, assertNoScores } = require('./helpers/sportWeb');

const features = { sportPageLeagues: ['EPL'] };
const pages = ['league', 'nfl', 'f1', 'cricket', 'events'];
const draw = (V, leaguePage, o = {}) => V.sportPage('Football', ctx(V, answer(), { features, pages, leaguePage, ...o }));
const CARDS = /<section class="lgames" aria-label="Premier League">[^]*?<div class="cardgrid">[^]*?data-game="ars"[^]*?data-game="nxt"/;

test('a failed, unavailable or empty embedded league page falls back to the league\'s cards', () => {
    const { V } = browser();
    for (const [why, lp] of [['failed', { failed: true }], ['unavailable', { answer: { available: false } }], ['no rounds', { answer: { available: true, rounds: [] } }]]) {
        const html = draw(V, lp);
        assert.match(html, CARDS, why);
        assert.doesNotMatch(html, /league-error|No Premier League games listed/, why);
    }
});

test('a thin league page: the front page\'s upcoming games it does not hold follow it as cards', () => {
    const { V } = browser();
    const t = (id, name) => ({ id, abbr: id, name, full: name, color: null, logo: null });
    const page = { available: true, teams: { ARS: t('ARS', 'Arsenal'), CHE: t('CHE', 'Chelsea') },
        rounds: [{ key: '1', label: 'Today', current: true, games: [{ id: 'g', start: NOW - 3600000, status: 'live', detail: null,
            home: { id: 'ARS', abbr: 'ARS' }, away: { id: 'CHE', abbr: 'CHE' }, channels: [] }] }], standings: null };
    const html = draw(V, { answer: page });
    const more = html.slice(html.indexOf('<section class="lgames more"'));
    assert.ok(html.includes('<section class="lgames more" aria-label="More Premier League">'), 'the rest of the league follows');
    assert.match(more, /data-game="nxt"/);
    assert.match(more, /data-game="pen"/);
    assert.doesNotMatch(more, /data-game="ars"/, 'a game the round holds is not drawn twice');
    assert.doesNotMatch(more, /data-game="avl"/, 'nor a result');
    assertNoScores(draw(V, { answer: page }, { hide: true }), 'hidden');
});

test('the phone\'s league page keeps its own states', () => {
    const { V } = browser();
    assert.match(V.leaguePage('Football', 'EPL', 'league', { failed: true }, ctx(V, answer())), /league-error/);
});
