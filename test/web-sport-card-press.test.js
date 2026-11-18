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
    const calls = [], played = [], recPlayed = [], recOpts = [];
    const b = browser({ request: async (m, url) => { calls.push([m, url]); return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/recordings' ? recordings : {}; } });
    const app = { currentUser: { role: 'admin' }, navigateTo() {}, setLocation() {},
        pages: { recordings: { play: async (id, o) => { recPlayed.push(id); recOpts.push(o); } } },
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'p1' }, { sourceId: 1, stableId: 's9', id: 'p9' }], loadSources: async () => {}, loadChannels: async () => {}, selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    const card = () => { const el = b.document.createElement('button'); b.document.body.appendChild(el); return el; };
    const menu = () => b.document.body.querySelector('.sp-menu');
    return { b, p, f, calls, played, recPlayed, recOpts, card, menu };
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

test('finished: a press plays the whole completed recording of the game (not partial, longest, earliest); none: nothing', async () => {
    const rows = [
        { id: 7, gameId: 'avl', status: 'failed', started_at: 5, duration_sec: 9000 },
        { id: 8, gameId: 'avl', status: 'completed', started_at: 10, duration_sec: 3000, is_partial: 1 },
        { id: 9, gameId: 'avl', status: 'completed', started_at: 20, duration_sec: 7000, is_partial: 0 },
        { id: 12, gameId: 'avl', status: 'completed', started_at: 30, duration_sec: 7000, is_partial: 0 },
        { id: 13, gameId: 'avl', status: 'completed', started_at: 40, duration_sec: 6000, is_partial: 0 },
        { id: 10, gameId: 'pen', status: 'recording', started_at: 30, watch_live: false },
        { id: 11, gameId: null, status: 'completed', started_at: 40, title: 'Aston Villa v Brentford' }
    ];
    const h = await harness({ recordings: rows });
    await h.p.select('avl', h.card());
    assert.deepEqual(h.recPlayed, [9], 'not partial, longest, then the earliest start');
    await h.p.select('pen', h.card());
    assert.deepEqual(h.recPlayed, [9], 'still recording but not watchable: nothing');
    await h.p.select('nfl', h.card());
    assert.deepEqual(h.recPlayed, [9], 'no recording: nothing');
    assert.equal(h.menu(), null);
    const bad = await harness();
    bad.b.context.API.request = async () => { throw new Error('down'); };
    await bad.p.select('avl', bad.card());
    assert.deepEqual(bad.recPlayed, []);
});

test('finished game with no completed recording but one still recording that can be watched live: plays it from its start', async () => {
    const h = await harness({ recordings: [{ id: 21, gameId: 'avl', status: 'recording', watch_live: true, started_at: 1 }] });
    await h.p.select('avl', h.card());
    assert.deepEqual(h.recPlayed, [21]);
    assert.deepEqual(plain(h.recOpts), [{ watch: true, noLive: true }], 'from its start, with no way to the live edge');
    const partialFirst = await harness({ recordings: [{ id: 5, gameId: 'avl', status: 'completed', is_partial: 1, duration_sec: 99999 }, { id: 6, gameId: 'avl', status: 'completed', is_partial: 0, duration_sec: 10 }] });
    await partialFirst.p.select('avl', partialFirst.card());
    assert.deepEqual(partialFirst.recPlayed, [6], 'a whole recording beats a longer partial one');
    // a partial completed copy ranks below a whole one still finishing; with nothing else it is played (longest first)
    const P = require('node:vm').runInContext('SportsPage', browser({ request: async () => ({}) }).context);
    const rows = [{ id: 1, gameId: 'avl', status: 'completed', is_partial: 1, duration_sec: 5000 }, { id: 2, gameId: 'avl', status: 'recording', watch_live: true },
        { id: 3, gameId: 'avl', status: 'completed', is_partial: 1, duration_sec: 6000 }];
    assert.equal(P.recordingFor(rows, { id: 'avl' }).id, 2, 'a watchable copy still recording beats a partial completed one');
    assert.equal(P.recordingFor(rows.filter(r => r.id !== 2), { id: 'avl' }).id, 3, 'only partial copies: the longest');
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

test('#345: a recording lookup is invalidated by a newer press or leaving Sport: answers in reverse order play only the newest', async () => {
    const h = await harness();
    const pending = [];
    h.b.context.API.request = (m, url) => (url === '/recordings' ? new Promise(res => pending.push(res)) : Promise.resolve({}));
    h.p.front.games.push({ ...h.p.game('avl'), id: 'avl2', title: 'Second final' });
    const a = h.p.select('avl', h.card());          // first press
    const b = h.p.select('avl2', h.card());         // a newer press
    pending[1]([{ id: 2, gameId: 'avl2', status: 'completed' }]); await b;
    pending[0]([{ id: 1, gameId: 'avl', status: 'completed' }]); await a;
    assert.deepEqual(h.recPlayed, [2], 'the older answer arriving last plays nothing');
    const c = h.p.select('avl', h.card());
    h.p.hide();
    pending[2]([{ id: 1, gameId: 'avl', status: 'completed' }]); await c;
    assert.deepEqual(h.recPlayed, [2], 'left Sport meanwhile: nothing');
});

test('#345: choosing a channel to watch ends an older finished-card lookup still on its way', async () => {
    const h = await harness();
    let answer;
    const real = h.b.context.API.request;
    h.b.context.API.request = (m, url) => (url === '/recordings' ? new Promise(res => { answer = res; }) : real(m, url));
    const lookup = h.p.select('avl', h.card());
    const watching = h.p.watch('ars', '1:s1'); // "Watch another channel": watch() directly, before the lookup answers
    answer([{ id: 5, gameId: 'avl', status: 'completed' }]);
    await lookup; await watching;
    assert.deepEqual(h.recPlayed, [], 'no recording opens over the channel the person chose');
});
