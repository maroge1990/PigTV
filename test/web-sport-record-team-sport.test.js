'use strict';
// Codex review of #327 (medium): "Every <team> game" on the record page is always a C-M `team` rule (the team's games from
// the fixture), never a `sport` keyword rule matched against guide titles, also for a team nobody follows in a league
// the front page does not list (a league page's fixture). Its sport comes from the catalogue; when it cannot be told the
// choice is off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness({ catalog = true } = {}) {
    const calls = [];
    const f = answer();
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/sports/catalog') { if (!catalog) throw new Error('offline'); return { sports: [{ sport: 'Rugby league', leagues: [{ league: 'NRL', label: 'NRL' }] }] }; }
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings/scheduled' ? [] : {};
    }, recordings: { addRule: async (r) => { calls.push(['rule', r]); return {}; }, schedule: async (d) => { calls.push(['schedule', d]); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    await new Promise(setImmediate);
    // a league page's fixture: NRL is in no front-page `sports[]` entry, and nobody follows either side
    const g = { id: 'fx:NRL:77', synthetic: true, league: 'NRL', title: 'Broncos v Storm', status: 'scheduled', start: NOW + 2 * H,
        competitors: [{ name: 'Broncos' }, { name: 'Storm' }], followed: false,
        channels: [{ sourceId: 1, stableId: 'f9', id: '909', name: 'Fox League', start: NOW + 2 * H, end: NOW + 4 * H }] };
    p.game = (id) => (id === g.id ? g : null);
    p.openRecord(g.id);
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body').innerHTML;
    const pick = (i) => { const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-what'); el.setAttribute('data-index', String(i)); b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); };
    const save = async () => { b.document.body.querySelector('dialog [data-act="r-save"]').click(); await new Promise(setImmediate); };
    return { b, p, calls, body, pick, save };
}

test('every Broncos game, a team in a league the front page does not list: a team rule with the catalogue\'s sport', async () => {
    const h = await harness();
    assert.match(h.body(), /data-index="1" data-key="r:what:1"><b>Every Broncos game<\/b><span class="pig-amount">Never replays<\/span>/);
    h.pick(1);
    await h.save();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'rule'))), ['rule', { kind: 'team', match: 'Broncos', sport: 'Rugby league' }]);
});

test('its sport unknown (no catalogue, not the page shown): the team choice is off, and never a keyword rule', async () => {
    const h = await harness({ catalog: false });
    assert.match(h.body(), /data-index="1" data-key="r:what:1" disabled><b>Every Broncos game<\/b><span class="pig-amount">Not available: PigTV doesn’t know this league’s sport<\/span>/);
    h.pick(1); // a click that reaches it anyway
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'rule').length, 0);
    assert.match(h.body(), /<p class="rerr" role="alert">PigTV doesn’t know this league’s sport, so every game of the team can’t be recorded\.<\/p>/);
});

test('the Sport page the league is shown on names its sport when the catalogue does not', async () => {
    const h = await harness({ catalog: false });
    h.p.path = 'Rugby league/NRL';
    h.p.closeWindow();
    h.p.openRecord('fx:NRL:77');
    h.pick(2);
    await h.save();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'rule'))), ['rule', { kind: 'team', match: 'Storm', sport: 'Rugby league' }]);
});
