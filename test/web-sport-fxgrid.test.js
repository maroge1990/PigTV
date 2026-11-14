'use strict';
// #326 (rig): a league with no standings drew its fixture cards two across the whole window (one EPL card ~920 px wide
// at 1920 px). Without standings the grid is iOS's adaptive one (minimum 300), so a card stays card-sized; beside the
// standings it stays two across; stacked (below 1100 px) adaptive too; one column on a phone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rulesFor } = require('./helpers/sportCss');
const { browser, answer, NOW, ctx } = require('./helpers/sportWeb');

test('no standings: the fixture grid is adaptive, cards at least 300 wide and as many across as fit', () => {
    assert.match(rulesFor('.sp .league.solo .fxgrid'), /grid-template-columns:\s*repeat\(auto-fill, minmax\(300px, 1fr\)\)/);
    assert.match(rulesFor('.sp .fxgrid'), /repeat\(2, minmax\(0, 1fr\)\)/, 'beside the standings: two across');
});

test('a league page without standings is drawn solo', () => {
    const { V } = browser();
    const t = (id, name) => ({ id, abbr: id, name, full: name, color: null, logo: null });
    const page = { available: true, teams: { A: t('A', 'Arsenal'), C: t('C', 'Chelsea') },
        rounds: [{ key: '1', label: 'Today', current: true, games: [{ id: 'g', start: NOW + 3600000, status: 'scheduled', detail: null,
            home: { id: 'A', abbr: 'A' }, away: { id: 'C', abbr: 'C' }, channels: [] }] }], standings: null };
    assert.match(V.leaguePage('Football', 'EPL', 'league', { answer: page }, ctx(V, answer())), /^<div class="league solo"><div><div class="rounds"[^]*?<div class="fxgrid">/);
});
