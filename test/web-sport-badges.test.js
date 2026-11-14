'use strict';
// #326: iOS fills a monogram disc with its league's colour (SportFrontText.leagueColorName: EPL purple, NFL navy, AFL
// blue, F1 red, cricket green…; others LeagueOther) and a session row's square badge likewise; a league page's fixture
// card and standings row draw the team's abbreviation in the team's own colour. The web drew one grey for all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, ctx } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

test('a monogram disc and a league badge take the league\'s colour', () => {
    const { V } = browser();
    assert.match(V.badge('Collingwood', null, 26, 'AFL'), /^<span class="disc lg-afl" aria-hidden="true" style="width:26px;height:26px;font-size:10px">C<\/span>$/);
    assert.match(V.badge('Kansas City Chiefs', null, 22, 'NFL'), /class="disc lg-nfl"/);
    assert.match(V.badge('Somebody', null, 22, 'A-League'), /class="disc lg-other"/);
    assert.match(V.leagueBadge('F1'), /^<span class="lbadge lg-f1" aria-hidden="true">F1<\/span>$/);
    assert.match(V.leagueBadge('NASCAR'), /class="lbadge lg-other"[^>]*>NAS</);
    assert.match(V.badge('Arsenal', '/api/logo/ars', 26, 'EPL'), /<img class="badge" [^>]*data-tone="lg-epl"/, 'a logo that fails keeps the colour');
    for (const [k, hex] of [['nfl', '#013369'], ['f1', '#E10600'], ['afl', '#0B3D91'], ['cricket', '#1F7A3A'], ['epl', '#3D195B']]) {
        assert.match(rulesFor('.sp'), new RegExp(`--lg-${k}:\\s*${hex}`), k);
        assert.match(rulesFor(`.sp .lg-${k}`), new RegExp(`background:\\s*var\\(--lg-${k}\\)`), k);
    }
});

test('the cards and rows pass their league: front cards, iPhone rows, the carousel', () => {
    const { V } = browser();
    const front = answer(), c = ctx(V, front);
    assert.match(V.card(front.games.find(g => g.id === 'nfl'), c), /class="disc lg-nfl"[^>]*>P</);
    assert.match(V.rowHtml(front.games.find(g => g.id === 'pen'), c), /class="disc lg-epl"[^>]*>L</);
    assert.match(V.rowHtml(front.games.find(g => g.id === 'f1'), c), /class="lbadge lg-f1"/);
});

test('a fixture card and a standings row: the team\'s abbreviation in its own colour', () => {
    const { V } = browser();
    const t = (abbr, name, color) => ({ id: abbr, abbr, name, full: name, color, logo: null });
    const page = { available: true, teams: { GEEL: t('GEEL', 'Geelong Cats', '1C3C6E'), ESS: t('ESS', 'Essendon', null) },
        rounds: [{ key: '1', label: 'Round 1', current: true, games: [{ id: 'g', start: NOW + 3600000, status: 'scheduled', detail: null,
            home: { id: 'GEEL', abbr: 'GEEL' }, away: { id: 'ESS', abbr: 'ESS' }, channels: [] }] }],
        standings: { groups: [{ name: 'AFL', columns: [{ key: 'points', label: 'Pts' }], rows: [{ id: 'GEEL', rank: 1, abbr: 'GEEL', values: { points: 4 } }] }] } };
    const html = V.leaguePage('Australian football', 'AFL', 'league', { answer: page }, ctx(V, answer()));
    assert.match(html, /<span class="disc" aria-hidden="true" style="width:22px;height:22px;font-size:7px;background:#1C3C6E">GEEL<\/span><span class="n">Geelong Cats/);
    assert.match(html, /<span class="disc lg-other" aria-hidden="true" style="width:22px;height:22px;font-size:7px">ESS<\/span>/, 'no colour: LeagueOther');
    assert.match(html, /<td class="nm"><div><span class="disc" aria-hidden="true" style="width:24px;height:24px;font-size:8px;background:#1C3C6E">GEEL</);
    // a colour that is not a hex never reaches a style
    page.teams.GEEL.color = 'red;background:url(x)';
    assert.doesNotMatch(V.leaguePage('Australian football', 'AFL', 'league', { answer: page }, ctx(V, answer())), /url\(x\)/);
});
