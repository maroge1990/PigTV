const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, NOW, ctx, page, assertNoScores } = require('./helpers/sportWeb');

// #323 step 5: Apple's record menu (SportRecordMenu / ProgrammeMenu) in place of the old ⋯ dialog: a "⋯" on each card
// (and right-click) on a computer, a sheet from the bottom on a phone. Items: Remind me; "Watch on… (n channels)";
// RECORD: Record this game (or Change recording), Record every <team> game, More options…; for a game not in the TV
// Guide yet, Record when it's listed (or Don't record it); on the front page, Make this the hero.
const H = 3600000;
function front() {
    const a = answer();
    const ars = a.games.find(g => g.id === 'ars');
    ars.channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 1 HD', quality: 'HD', start: NOW - H, end: NOW + H });
    const nxt = a.games.find(g => g.id === 'nxt');
    delete nxt.recording; nxt.followed = true; nxt.followedSides = [1];
    a.follows.push({ league: 'EPL', sport: 'Football', name: 'Tottenham', logo: null, state: 'next', gameId: 'nxt', start: nxt.start });
    a.games.push({ ...nxt, id: 'far', title: 'Everton v Fulham', competitors: [{ id: 'e', name: 'Everton' }, { id: 'f', name: 'Fulham' }], channels: [], start: NOW + 9 * 24 * H, followed: false, nextRound: false });
    a.games.push({ ...nxt, id: 'wait', title: 'Leeds v Wolves', competitors: [{ id: 'l', name: 'Leeds' }, { id: 'w', name: 'Wolves' }], channels: [], start: NOW + 9 * 24 * H, recordWhenListed: { ruleId: 42 }, followed: false });
    a.rails[0].gameIds.push('far', 'wait');
    return a;
}
async function harness({ phone = false, api = {} } = {}) {
    const calls = [];
    const f = front();
    const b = browser({ request: async (m, url, body) => { calls.push([m, url, body]); return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {}; },
        recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; }, addRule: async (r) => { calls.push(['rule', r]); return { id: 7 }; },
            deleteRule: async (id) => { calls.push(['delete-rule', id]); return {}; } }, ...api });
    b.context.matchMedia = () => ({ matches: phone, addEventListener() {} });
    b.context.window.matchMedia = b.context.matchMedia;
    const played = [];
    const app = { currentUser: { role: 'admin' }, navigateTo: () => {}, setLocation() {},
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'p1' }, { sourceId: 1, stableId: 's9', id: 'p9' }], loadSources: async () => {}, loadChannels: async () => {},
            selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    const anchor = () => { const el = b.document.createElement('button'); b.document.body.appendChild(el); return el; };
    const menu = () => b.document.body.querySelector('.sp-menu');
    return { b, p, f, calls, played, anchor, menu };
}
const items = (html) => [...html.matchAll(/data-act="([\w-]+)" data-id="[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span><b>([^<]+)<\/b>/g)].map(m => [m[1], m[2]]);

test('every card still to come has its "⋯" beside it (after it in keyboard order); a finished game has none', () => {
    const { V } = browser();
    const html = V.front(ctx(V, front(), { links: true }));
    assert.match(html, /<div class="gitem has-more" data-game="nxt"><button type="button" class="gcard[^"]*" data-act="game"[\s\S]*?<\/button><button type="button" class="more-btn" data-act="more" data-id="nxt" data-key="more:nxt" aria-haspopup="menu" aria-expanded="false" aria-label="More options for Newcastle v Tottenham"><span aria-hidden="true">⋯<\/span><\/button><\/div>/);
    assert.match(html, /<div class="gitem" data-game="avl">/, 'a result: no menu');
    assert.match(html, /data-act="record-menu" aria-haspopup="menu" data-id="ars" data-key="hero:record">/, 'the hero\'s Record opens the menu');
});

test('a game to come: Remind me, then RECORD (this game, every Tottenham game, More options…), then Make this the hero', async () => {
    const h = await harness();
    h.p.act('more', Object.assign(h.anchor(), { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null }));
    const m = h.menu();
    assert.equal(m.getAttribute('role'), 'menu');
    assert.deepEqual(items(m.innerHTML), [['remind', 'Remind me'], ['record', 'Record this game'], ['record-every', 'Record every Tottenham game'],
        ['record-options', 'More options…'], ['pin', 'Make this the hero']]);
    assert.match(m.innerHTML, /<div class="ms" aria-hidden="true">Record<\/div>/);
    assert.match(m.innerHTML, /<span>[^<]+, with the usual padding<\/span>/);
    assert.match(m.innerHTML, /Every game of the team, never replays/);
    h.p.act('record-every', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null });
    await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'rule'))), ['rule', { kind: 'team', match: 'Tottenham', sport: 'Football' }]);
    assert.equal(h.menu(), null);
});

test('a game on two channels now: "Watch on… (2 channels)" opens their list, and the chosen one plays', async () => {
    const h = await harness();
    h.p.openMenu(h.p.game('ars'), h.anchor());
    assert.match(h.menu().innerHTML, /data-act="watch-on" data-id="ars" aria-expanded="false">[\s\S]*?<b>Watch on… \(2 channels\)<\/b><span>Stan Sport 1, Stan Sport 1 HD<\/span>/);
    assert.match(h.menu().innerHTML, /<div class="msub" hidden>[\s\S]*data-act="watch-channel" data-id="ars" data-channel="1:s9"/);
    await h.p.act('watch-channel', { getAttribute: (k) => ({ 'data-id': 'ars', 'data-channel': '1:s9' })[k] ?? null });
    assert.deepEqual(h.played, ['p9'], 'the chosen channel, by its identity');
});

test('Change recording when it is set; Record when it\'s listed, or Don\'t record it, for a game not in the TV Guide yet', async () => {
    const h = await harness();
    h.f.games.find(g => g.id === 'nxt').recording = { scheduleId: 4, status: 'recording' };
    h.p.openMenu(h.p.game('nxt'), h.anchor());
    assert.deepEqual(items(h.menu().innerHTML).slice(0, 2), [['remind', 'Remind me'], ['change-recording', 'Change recording']]);
    assert.match(h.menu().innerHTML, /<b>Change recording<\/b><span>Recording now<\/span>/);
    h.p.openMenu(h.p.game('far'), h.anchor());
    assert.deepEqual(items(h.menu().innerHTML), [['record-listed', 'Record when it’s listed'], ['pin', 'Make this the hero']]);
    await h.p.recordListed('far');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'rule'))), ['rule', { kind: 'game', gameId: 'far' }]);
    h.p.openMenu(h.p.game('wait'), h.anchor());
    assert.deepEqual(items(h.menu().innerHTML)[0], ['unlisted-cancel', 'Don’t record it']);
    await h.p.recordListed('wait', true);
    assert.deepEqual(h.calls.find(c => c[0] === 'delete-rule'), ['delete-rule', 42]);
});

test('right-click on a card opens its menu; Make this the hero puts it in the banner', async () => {
    const h = await harness();
    const card = h.b.document.createElement('button');
    card.setAttribute('data-act', 'game'); card.setAttribute('data-id', 'nxt');
    h.p.root.appendChild(card);
    const ev = new FakeEvent('contextmenu', { clientX: 0 });
    card.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, 'the browser\'s own menu does not open');
    assert.ok(h.menu(), 'the game\'s menu does');
    h.p.act('pin', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null });
    assert.equal(h.p.heroId, 'nxt');
    assert.match(h.p.root.innerHTML, /<section class="banner" aria-label="Newcastle v Tottenham">/);
});

test('on a phone the menu is a sheet from the bottom over a scrim, with Cancel; Cancel closes it and focus goes back', async () => {
    const h = await harness({ phone: true });
    const a = h.anchor();
    h.p.openMenu(h.p.game('nxt'), a);
    const sheet = h.menu();
    assert.match(sheet.className, /\bsheet\b/);
    assert.ok(h.b.document.body.querySelector('.sp-scrim'));
    assert.match(sheet.innerHTML, /<div class="grab" aria-hidden="true"><\/div>[\s\S]*<button type="button" class="pill cancel" data-act="menu-cancel">Cancel<\/button>$/);
    const cancel = h.b.document.createElement('button'); cancel.setAttribute('data-act', 'menu-cancel'); sheet.appendChild(cancel);
    cancel.click();
    assert.equal(h.menu(), null);
    assert.equal(h.b.document.body.querySelector('.sp-scrim'), null);
    assert.equal(h.b.document.activeElement, a);
});

test('More options…: Record this game with its own padding, the fields checked as whole minutes', async () => {
    const h = await harness();
    h.p.recordOptions('nxt');
    const d = h.b.document.body.querySelector('dialog');
    assert.ok(d && d.open, 'a dialog');
    const pre = h.b.document.getElementById('sp-pad-pre'), post = h.b.document.getElementById('sp-pad-post');
    Object.assign(pre, { min: '0', max: '60', value: '5' }); Object.assign(post, { min: '0', max: '180', value: '30' });
    const save = d.querySelector('.btn-primary');
    assert.equal(save.textContent, 'Record this game');
    save.click();
    await new Promise(setImmediate);
    const sent = h.calls.find(c => c[0] === 'schedule')[1];
    assert.equal(sent.preBufferMin, 5); assert.equal(sent.postBufferMin, 30); assert.equal(sent.gameId, 'nxt');
});

test('the menu shows no score with scores hidden (its title and times only)', async () => {
    const h = await harness();
    h.p.prefs = { known: true, spoilerFree: true };
    for (const id of ['ars', 'pen', 'nfl', 'cri']) {
        h.p.openMenu(h.p.game(id), h.anchor());
        assertNoScores(h.menu().innerHTML, `menu ${id}`);
    }
});
