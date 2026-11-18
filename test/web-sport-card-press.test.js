'use strict';
// #345 (owner, 18 Nov): what a sport game card does when pressed, and what its menu holds. Live: play. Not started (or not
// listed yet): the record options (its menu). Finished: play PigTV's recording of that game (recordings[].gameId = the
// card's id, completed), else nothing. Next round: nothing. The menu: Remind me lives only there; no Details; a phone's
// menu is anchored on its card, not a sheet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;
const plain = (o) => JSON.parse(JSON.stringify(o));
async function harness({ recordings = [] } = {}) {
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording; nxt.followed = true; nxt.followedSides = [1];
    f.follows.push({ league: 'EPL', sport: 'Football', name: 'Tottenham', logo: null, state: 'next', gameId: 'nxt', start: nxt.start });
    const ars = f.games.find(g => g.id === 'ars');
    ars.channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 3 HD', quality: 'HD', start: NOW - H, end: NOW + H });
    f.games.push({ ...nxt, id: 'far', title: 'Everton v Fulham', competitors: [{ id: 'e', name: 'Everton' }, { id: 'f', name: 'Fulham' }], channels: [], start: NOW + 9 * 24 * H, followed: false, nextRound: false });
    f.games.push({ ...nxt, id: 'rnd', title: 'Leeds v Wolves', competitors: [{ id: 'l', name: 'Leeds' }, { id: 'w', name: 'Wolves' }], channels: [], start: NOW + 9 * 24 * H, followed: false, nextRound: true });
    f.rails[0].gameIds.push('far', 'rnd');
    const calls = [], played = [], recPlayed = [];
    const b = browser({ request: async (m, url) => { calls.push([m, url]); return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings' ? recordings : {}; } });
    const app = { currentUser: { role: 'admin' }, navigateTo() {}, setLocation() {},
        pages: { recordings: { play: async (id) => { recPlayed.push(id); } } },
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'p1' }, { sourceId: 1, stableId: 's9', id: 'p9' }], loadSources: async () => {}, loadChannels: async () => {}, selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    const card = () => { const el = b.document.createElement('button'); b.document.body.appendChild(el); return el; };
    const menu = () => b.document.body.querySelector('.sp-menu');
    return { b, p, f, calls, played, recPlayed, card, menu };
}
const acts = (m) => [...m.innerHTML.matchAll(/data-act="([\w-]+)" data-id="/g)].map(x => x[1]);

test('live: a press plays; upcoming and not listed yet: a press opens the record options; next round: nothing', async () => {
    const h = await harness();
    await h.p.select('ars', h.card());
    assert.deepEqual(h.played, ['p1']);
    assert.equal(h.menu(), null);
    h.p.select('nxt', h.card());
    assert.match(acts(h.menu()).join(), /record,record-every,record-options/);
    h.p.closeMenu();
    h.p.select('far', h.card());
    assert.match(h.menu().innerHTML, /data-act="record-listed"[\s\S]*?Record when it’s listed/, 'a game not listed yet offers Record when it\'s listed');
    h.p.closeMenu();
    h.p.select('rnd', h.card());
    assert.equal(h.menu(), null, 'a next round: nothing');
    assert.equal(h.b.document.body.querySelector('dialog'), null, 'and never a details window');
});

test('finished: a press plays the completed recording whose gameId is the card\'s id; none: nothing', async () => {
    const rows = [
        { id: 7, gameId: 'avl', status: 'failed', started_at: 5 },
        { id: 8, gameId: 'avl', status: 'completed', started_at: 10 },
        { id: 9, gameId: 'avl', status: 'completed', started_at: 20 },
        { id: 10, gameId: 'pen', status: 'recording', started_at: 30 },
        { id: 11, gameId: null, status: 'completed', started_at: 40, title: 'Aston Villa v Brentford' }
    ];
    const h = await harness({ recordings: rows });
    await h.p.select('avl', h.card());
    assert.deepEqual(h.recPlayed, [9], 'the newest completed one');
    await h.p.select('pen', h.card());
    assert.deepEqual(h.recPlayed, [9], 'still recording: not playable here');
    await h.p.select('nfl', h.card());
    assert.deepEqual(h.recPlayed, [9], 'no recording: nothing');
    assert.equal(h.menu(), null);
    // the list unreadable: nothing, no error
    const bad = await harness();
    bad.b.context.API.request = async () => { throw new Error('down'); };
    await bad.p.select('avl', bad.card());
    assert.deepEqual(bad.recPlayed, []);
});

test('the menu: live has Watch another channel and Record only; upcoming Record and Remind me; finished only Make hero; never Details', async () => {
    const h = await harness();
    const items = (id, front = false) => [...h.p.menuItems(h.p.game(id), { front }).map(i => i.act)];
    assert.deepEqual(plain(items('ars')), ['watch-on', 'record', 'record-every', 'record-options']);
    assert.deepEqual(plain(items('nxt')), ['record', 'record-every', 'record-options', 'remind']);
    assert.deepEqual(plain(items('far')), ['record-listed']);
    assert.deepEqual(plain(items('avl')), []);
    assert.deepEqual(plain(items('avl', true)), ['pin']);
    assert.ok(items('nxt', true).includes('pin'), 'Make this the hero stays on the front page');
    for (const id of ['ars', 'nxt', 'far', 'avl']) assert.ok(!items(id, true).includes('details'));
    // one channel only: nothing to switch to
    h.p.game('ars').channels.pop();
    assert.ok(!items('ars').includes('watch-on'));
});

test('Remind me is not a pill on the carousel, the hero or the cricket lead', async () => {
    const h = await harness();
    h.p.pin('nxt');
    assert.doesNotMatch(h.p.root.innerHTML, /data-act="remind"/);
    assert.match(h.p.root.innerHTML, /data-act="record-menu"[^>]*data-key="hero:record"/, 'Record stays');
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/pages/SportView.js'), 'utf8');
    assert.doesNotMatch(src, /data-act="remind"/, 'no Remind me button anywhere in the markup');
});

test('SportsPage.recordingFor ignores rows of other games, unfinished rows and bad input', () => {
    const { vm } = { vm: require('node:vm') };
    const b = browser({ request: async () => ({}) });
    const P = vm.runInContext('SportsPage', b.context);
    assert.equal(P.recordingFor(null, { id: 'a' }), null);
    assert.equal(P.recordingFor([{ id: 1, gameId: 'b', status: 'completed' }], { id: 'a' }), null);
    assert.equal(P.recordingFor([{ id: 1, gameId: 'a', status: 'completed' }], { id: 'a' }).id, 1);
});
