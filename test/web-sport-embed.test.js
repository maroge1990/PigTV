'use strict';
// #326 (Mark, 15 Nov 2026): on a wide window a sport's page is iPad's SportPageView: the banner, then the shown league's
// own page EMBEDDED under it (iPad's SportLeagueContent): a fixture league's rounds, game cards and standings, the F1
// weekend's tiles and lists, cricket, an events league; a league without a page shows its name and its game cards.
// Before, it drew Live / Later today on the left and Coming up / Earlier on the right (half the page empty on a day
// with nothing today) and sent the rounds and standings to another page. The phone layout keeps its own (iPhone).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, assertNoScores, ctx, page } = require('./helpers/sportWeb');

const golden = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', f), 'utf8'));

function afl() {
    const t = (id, abbr, name) => ({ id, abbr, name, full: name, color: null, logo: null });
    return { available: true, league: 'AFL', season: { year: 2026 }, following: null,
        teams: { 1: t('1', 'COLL', 'Collingwood'), 2: t('2', 'RICH', 'Richmond') },
        rounds: [{ key: '21', label: 'Round 21', current: true, games: [{ id: 'g1', start: NOW - 3600000, status: 'live', detail: 'Q3 12:04',
            home: { id: '1', abbr: 'COLL', score: '9.6 (60)' }, away: { id: '2', abbr: 'RICH', score: '8.4 (52)' }, channels: [] }] }],
        standings: { groups: [{ name: 'AFL', columns: [{ key: 'played', label: 'P' }, { key: 'points', label: 'Pts' }],
            rows: [{ id: '1', rank: 1, abbr: 'COLL', values: { played: 23, points: 9191 } }] }] } };
}
const features = { sportPageLeagues: ['AFL'], sportPages: true, sportPageNfl: true };
const pages = ['league', 'nfl', 'f1', 'cricket', 'events'];

test('a fixture league is embedded under the sport\'s banner: rounds, game cards, standings; no two columns of rows', () => {
    const { V } = browser();
    const html = V.sportPage('Australian football', ctx(V, answer(), { features, pages, leaguePage: { answer: afl(), loaded: true }, labels: { AFL: 'AFL' } }));
    assert.match(html, /^<section class="banner full"[^>]*>[\s\S]*?<\/section><div class="sp-embed" data-league="AFL"><div class="league"><div><div class="rounds" role="group" aria-label="Rounds"><button type="button" class="fchip on" data-act="round" data-round="21"/);
    assert.match(html, /<div class="fxgrid">[\s\S]*?Collingwood[\s\S]*?<section class="standings" aria-label="Standings">/);
    assert.doesNotMatch(html, /groups2|class="grp"|class="more-row"/);
});

test('while the league page loads, its place is held; a league without a page shows its name and its cards', () => {
    const { V } = browser();
    assert.match(V.sportPage('Australian football', ctx(V, answer(), { features, pages, leaguePage: null })), /<div class="sp-embed" data-league="AFL"><div class="sp-state" id="sp-state" data-state="loading"><\/div><\/div>$/);
    assert.match(V.sportPage('Australian football', ctx(V, answer(), { features, pages, featuresLoaded: false })), /data-league="AFL"><div class="sp-state" id="sp-state" data-state="loading">/, 'the server\'s flags not read yet');
    const games = V.sportPage('Football', ctx(V, answer(), { features: {}, pages }));
    assert.match(games, /<div class="sp-embed" data-league="EPL"><section class="lgames" aria-label="Premier League"><h3 class="sec-title"><span class="sec-h"><span class="s">Premier League<\/span><\/span><\/h3><div class="cardgrid">/);
});

test('Formula 1 and events embedded: the sport\'s banner only (no second banner), then the weekend or the event', () => {
    const { V } = browser();
    const f1 = golden('sports-page-f1.json');
    const html = V.sportPage('Motorsport', ctx(V, answer(), { features, pages, leaguePage: { answer: f1, loaded: true } }));
    assert.equal((html.match(/<section class="banner/g) || []).length, 1, 'one banner');
    assert.match(html, /<div class="sp-embed" data-league="F1">(<div class="sp-note[^"]*"[\s\S]*?<\/div>)?<div class="tiles">/);
    const ev = V.leaguePage('Golf', 'PGA Tour', 'events', { answer: golden('sports-page-events-pga-tour.json'), loaded: true }, ctx(V, answer(), { embedded: true }));
    assert.doesNotMatch(ev, /<section class="banner/);
    assert.match(ev, /<div class="evhead">/);
});

test('with scores hidden the embedded page shows no score, record or standing', () => {
    const { V } = browser();
    const html = V.sportPage('Australian football', ctx(V, answer(), { hide: true, features, pages, leaguePage: { answer: afl(), loaded: true } }));
    assertNoScores(html, 'embedded AFL');
    assert.doesNotMatch(html, /9\.6|8\.4|\(60\)|9191|Q3 12:04/);
    assert.match(html, /Standings hidden/);
    assertNoScores(V.sportPage('Football', ctx(V, answer(), { hide: true, features: {}, pages })), 'embedded EPL cards');
});

test('the controller asks for the shown league\'s page on a sport page, and again for a league chosen in the banner', async () => {
    const asked = [];
    const front = answer({ sports: [...answer().sports, { league: 'A-League', sport: 'Football', live: 0, next: null, line: 'quiet' }] });
    const b = browser({ request: async (m, url) => {
        asked.push(url);
        if (url === '/sports/front') return front;
        if (url === '/sports/pages/preferences') return { spoilerFree: false };
        if (url === '/info') return { features: { sportPageLeagues: ['EPL', 'A-League'] } };
        if (url.startsWith('/sports/pages/league/')) return afl();
        return { sports: [] };
    } });
    const p = page(b, { setLocation() {} });
    await p.show('Football');
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
    assert.ok(asked.includes('/sports/pages/league/EPL'), 'the opening league\'s page');
    assert.match(p.root.innerHTML, /<div class="sp-embed" data-league="EPL"><div class="league">/);
    p.act('league', { getAttribute: (k) => ({ 'data-index': '1' })[k] });
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
    assert.ok(asked.includes('/sports/pages/league/A-League'), 'the chosen league\'s page');
    assert.match(p.root.innerHTML, /data-league="A-League"><div class="league">/);
    // a round chosen on the embedded page switches it
    p.act('round', { getAttribute: (k) => ({ 'data-round': '21' })[k] });
    assert.match(p.root.innerHTML, /data-round="21" aria-pressed="true"/);
});
