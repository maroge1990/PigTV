'use strict';
// #334 (D-67): a game played from Sport turns Live TV's sidebar into a list of the live games (games mode): score bugs
// in the channel list's rows, scores hidden as the Sport page hides them and while the game records, a row plays its
// game's preferred channel (channels[0]) with no picker, prev/next steps through the games, and a channel chosen
// elsewhere (the guide) ends it. The real ChannelList, SportView and SportsPage in a vm with the fake DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { browser, answer, page, js, assertNoScores, NOW } = require('./helpers/sportWeb');

function list({ front = answer(), prefs = { known: true, spoilerFree: false } } = {}) {
    const b = browser({ request: async () => front });
    const played = [];
    b.context.app = { player: { play: (ch) => played.push(ch.id) } };
    vm.runInContext(js('components/ChannelList.js'), b.context);
    const ChannelList = vm.runInContext('ChannelList', b.context);
    const cl = Object.create(ChannelList.prototype);
    cl.container = b.document.createElement('div');
    b.document.body.appendChild(cl.container);
    Object.assign(cl, { channels: [{ sourceId: 1, stableId: 's1', id: 'p1', name: 'Stan Sport 1' }, { sourceId: 1, stableId: 's9', id: 'p9', name: 'Other' }],
        favoriteKeys: new Set(), favoriteRows: [], renderedChannels: [], categories: [], collapsedGroups: new Set(), sources: [{ id: 1 }],
        searchInput: { value: '' }, observer: { observe() {} } });
    cl.startGames({ gameId: 'ars', front, prefs });
    return { b, cl, front, played, ChannelList };
}
const rows = (html) => [...html.matchAll(/data-game-id="([^"]+)"/g)].map(m => m[1]);
const stop = (cl) => cl.endGames(false);

test('games mode replaces the channel list with the live games, followed first, the game playing marked', () => {
    const { cl } = list();
    const html = cl.container.innerHTML;
    assert.match(html, /class="channel-list-content live-games"/);
    assert.match(html, />Live games</);
    assert.doesNotMatch(html, /data-channel-id=/, 'no channel rows');
    assert.deepEqual(rows(html), ['ars', 'pen', 'nfl', 'cri'], 'live games only (no result, no upcoming game), the followed one first');
    assert.match(html, /class="channel-item game-item active" data-game-id="ars"/, 'the current game has the active channel\'s style');
    assert.match(html, /class="channel-item game-item" data-game-id="pen"/);
    stop(cl);
});

test('a row: badge, code (abbreviation, else three letters) and score per team in the bug, then league and clock', () => {
    const front = answer();
    front.games.find(g => g.id === 'nfl').competitors[0].abbreviation = 'GB';
    const { cl } = list({ front });
    const html = cl.container.innerHTML;
    const nfl = html.slice(html.indexOf('data-game-id="nfl"'), html.indexOf('data-game-id="cri"'));
    assert.match(nfl, /<span class="gi-code">GB<\/span><span class="gi-score">71<\/span>/);
    assert.match(nfl, /<span class="gi-code">BEA<\/span><span class="gi-score">72<\/span>/, 'no abbreviation: the name\'s first three letters');
    assert.match(nfl, /<div class="channel-name">NFL<\/div><div class="channel-program">Q2 5:00<\/div>/, 'league, then where the game is up to (cardClock)');
    assert.equal((nfl.match(/class="gi-team"/g) || []).length, 2);
    assert.match(html, /class="gi-code">ARS<\/span><span class="gi-score">47</);
    stop(cl);
});

test('scores hidden: the account\'s choice unknown or hidden, the answer spoiler-free, a game recording, scores dropped', () => {
    for (const prefs of [{ known: false, spoilerFree: false }, { known: true, spoilerFree: true }]) {
        const { cl } = list({ prefs });
        assertNoScores(cl.container.innerHTML, JSON.stringify(prefs));
        stop(cl);
    }
    const { cl: free } = list({ front: answer({ spoilerFree: true }) });
    assertNoScores(free.container.innerHTML, 'spoilerFree answer');
    stop(free);

    const front = answer();
    front.games.find(g => g.id === 'ars').recording = { scheduleId: 9, status: 'recording', ruleId: null };
    delete front.games.find(g => g.id === 'pen').scores; // the server dropped them
    const { cl } = list({ front });
    const html = cl.container.innerHTML;
    const ars = html.slice(html.indexOf('data-game-id="ars"'), html.indexOf('data-game-id="pen"'));
    assert.doesNotMatch(ars, />47<|>31</, 'a recording game shows no score');
    assert.match(ars, /<div class="channel-name">EPL<span class="gi-rec"> · Recording<\/span><\/div>/, 'Recording on the league line');
    const pen = html.slice(html.indexOf('data-game-id="pen"'), html.indexOf('data-game-id="nfl"'));
    assert.match(pen, /<span class="gi-score"><\/span>/, 'no score from the server: an empty score column');
    assert.doesNotMatch(pen, /gi-rec/);
    stop(cl);
});

test('a game without two competitors (F1) shows its title and clock, no score', () => {
    const front = answer();
    Object.assign(front.games.find(g => g.id === 'f1'), { status: 'live', start: Date.now() - 600000 });
    const { cl } = list({ front });
    const html = cl.container.innerHTML;
    const at = html.indexOf('data-game-id="f1"'), f1 = html.slice(at, html.indexOf('data-game-id=', at + 1));
    assert.deepEqual(rows(html).slice(0, 2), ['ars', 'f1'], 'both followed: first, in the feed\'s order');
    assert.match(f1, /<span class="gi-title">Las Vegas Grand Prix · Race<\/span>/);
    assert.doesNotMatch(f1, /gi-score/);
    assert.match(f1, /<div class="channel-program">LIVE<\/div>/);
    stop(cl);
});

test('a row clicked plays its game\'s channels[0] with no picker; the list stays in games mode, that game marked', async () => {
    const front = answer();
    front.games.find(g => g.id === 'nfl').channels = [{ sourceId: 1, stableId: 's9', id: '109', name: 'Other' }, { sourceId: 1, stableId: 's1', id: '101', name: 'Stan Sport 1' }];
    const { cl, played } = list({ front });
    const row = { getAttribute: () => 'nfl' };
    cl.container.listeners.click.forEach(fn => fn({ target: { closest: (sel) => (sel === '[data-game-id]' ? row : null) } }));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(played, ['p9'], 'the game\'s first (preferred) channel, found again by its identity');
    assert.ok(cl.games, 'still in games mode');
    assert.equal(cl.games.gameId, 'nfl');
    assert.match(cl.container.innerHTML, /class="channel-item game-item active" data-game-id="nfl"/);
    assert.doesNotMatch(cl.container.innerHTML, /game-item active" data-game-id="ars"/);
    stop(cl);
});

test('previous/next step through the games; a channel chosen elsewhere (the guide) ends games mode', async () => {
    const { cl, played } = list();
    cl.selectNextChannel();
    await new Promise(r => setImmediate(r));
    assert.equal(cl.games.gameId, 'pen');
    cl.selectPrevChannel(); cl.selectPrevChannel();
    await new Promise(r => setImmediate(r));
    assert.equal(cl.games.gameId, 'cri', 'round the start to the last game');
    assert.deepEqual(played, ['p1', 'p1', 'p1']);
    let drawn = 0;
    cl.render = () => { drawn++; };
    await cl.selectChannel({ sourceId: 1, channelId: 'p9' }, { play: false }); // the Resume offer: no change
    assert.ok(cl.games);
    await cl.selectChannel({ sourceId: 1, channelId: 'p9' }).catch(() => {});
    assert.equal(cl.games, null, 'the guide\'s choice is a channel: back to the channel list');
    assert.ok(drawn >= 1, 'the channels drawn again');
});

test('Sport\'s Watch starts games mode on that game and selects its channel as the game\'s', async () => {
    const f = answer();
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {}) });
    const calls = [];
    const app = { navigateTo() {}, setLocation() {},
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'p1' }], loadSources: async () => {}, loadChannels: async () => {},
            startGames: (o) => calls.push(['start', o.gameId, o.front === f, o.prefs.known, o.prefs.spoilerFree]),
            selectChannel: async (d, o) => calls.push(['select', d.channelId, o && o.game]) } };
    const p = page(b, app);
    await p.show('');
    p.received = Date.now(); p.front.now = NOW;
    await p.watch('nfl');
    assert.deepEqual(calls, [['start', 'nfl', true, true, false], ['select', 'p1', 'nfl']]);
});

test('a long score keeps to its column: cricket\'s overs and AFL\'s goals.behinds move out, as on the Sport cards (#326)', () => {
    const front = answer();
    front.games.find(g => g.id === 'cri').scores = ['245/6 (45.2)', '180/3 (31.4 ov)'];
    front.games.find(g => g.id === 'nfl').scores = ['9.6 (60)', '7.8 (50)'];
    const { cl } = list({ front });
    const html = cl.container.innerHTML;
    const cri = html.slice(html.indexOf('data-game-id="cri"'));
    assert.match(cri, /class="gi-score">245\/6<\/span>/);
    assert.match(cri, /class="gi-score">180\/3<\/span>/);
    assert.match(html, /class="gi-score">60<\/span>/);
    assert.match(html, /class="gi-score">50<\/span>/);
    assert.doesNotMatch(html, /class="gi-score">[^<]*\(/, 'no bracketed detail in the score column');
    assert.match(cri, /aria-label="Play Australia v South Africa, 245\/6 \(45\.2\) to 180\/3 \(31\.4 ov\)/, 'a screen reader hears the whole score');
    stop(cl);
});

test('every row is the same height: two lines on the right, a one-line title, a fixed row height (Mark, D-67)', () => {
    const front = answer();
    Object.assign(front.games.find(g => g.id === 'f1'), { status: 'live', start: Date.now() - 600000 });
    front.games.find(g => g.id === 'nfl').recording = { scheduleId: 9, status: 'recording', ruleId: null };
    const { cl } = list({ front });
    const html = cl.container.innerHTML;
    for (const id of rows(html)) {
        const at = html.indexOf(`data-game-id="${id}"`), next = html.indexOf('data-game-id=', at + 1);
        const row = html.slice(at, next < 0 ? undefined : next);
        const info = row.slice(row.indexOf('gi-info'));
        assert.equal((info.match(/<div class="channel-(name|program)">/g) || []).length, 2, `${id}: league line and clock line only`);
        assert.doesNotMatch(info, /<\/div><span class="gi-rec"/, `${id}: no third line`);
    }
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/css/sport.css'), 'utf8');
    const rule = (sel) => { const m = css.match(new RegExp(`\\.live-games \\.${sel} \\{([^}]*)\\}`)); return m ? m[1] : ''; };
    assert.match(rule('gi-title'), /white-space: nowrap/, 'the title keeps to one line');
    assert.match(rule('gi-title'), /text-overflow: ellipsis/);
    assert.doesNotMatch(rule('gi-title'), /line-clamp/);
    // the row's padding is the channel row's (it changes with the screen); its content is one fixed height for every game
    const h = rule('gi-bug').match(/(?:^|;|\s)height: (\d+px)/);
    assert.ok(h, 'the score bug has a fixed height');
    assert.match(rule('gi-info'), new RegExp(`(^|;|\\s)height: ${h[1]}`), 'the right block has the same height');
    assert.match(rule('gi-info'), /overflow: hidden/);
    stop(cl);
});

test('a row whose channel no longer airs the game: nothing switches, the notice says so, and the row goes', async () => {
    const front = answer();
    const nfl = front.games.find(g => g.id === 'nfl');
    nfl.channels = [{ sourceId: 1, stableId: 's9', id: '109', name: 'Other', start: NOW - 4 * 3600000, end: NOW - 600000 }]; // ended 10 min ago
    const { cl, played, b } = list({ front });
    assert.ok(rows(cl.container.innerHTML).includes('nfl'));
    assert.equal(await cl.playGame('nfl'), false);
    assert.deepEqual(played, [], 'nothing plays');
    assert.equal(cl.games.gameId, 'ars', 'the game playing stays the current one');
    assert.equal(b.context.toasts.at(-1)[0], 'Packers v Bears isn’t on air now.');
    assert.ok(!rows(cl.container.innerHTML).includes('nfl'), 'the row is dropped');
    assert.equal(await cl.playGame('pen'), true, 'a game still on air plays');
    stop(cl);
});
