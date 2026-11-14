const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument } = require('./helpers/fakeDom');

// #320 (5): the player remembers the last channel per signed-in user in this browser, Live TV opens on it with a
// one-click Resume (never auto-play), the tab says what is playing, and Media Session carries the channel and programme.
// The real VideoPlayer and ChannelList scripts over a fake DOM.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const SEVEN = { id: '7', sourceId: 's1', name: 'Seven News', tvgLogo: 'https://logos.example/seven.png' };
const NINE = { id: '9', sourceId: 's1', name: 'Nine', tvgLogo: '' };

function harness({ user = { id: 5, username: 'mark' }, storage = new Map(), blocked = false, mediaSession = true } = {}) {
    const document = createDocument();
    document.title = 'Live TV · PigTV';
    const overlay = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'overlay-content';
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    const selected = [];
    const played = [];
    const channelList = {
        findChannel: (sourceId, id) => [SEVEN, NINE].find(c => c.id === String(id) && c.sourceId === sourceId),
        selectChannel: (dataset, opts) => { selected.push([dataset, opts]); }
    };
    const handlers = {};
    const navigator = mediaSession ? { mediaSession: { metadata: null, setActionHandler: (a, fn) => { handlers[a] = fn; } } } : {};
    const context = vm.createContext({
        document, navigator, console: { ...console, log() {}, warn() {}, error() {} },
        MediaMetadata: class { constructor(init) { Object.assign(this, init); } },
        localStorage: {
            getItem: (k) => { if (blocked) throw new Error('blocked'); return storage.has(k) ? storage.get(k) : null; },
            setItem: (k, v) => { if (blocked) throw new Error('blocked'); storage.set(k, String(v)); },
            removeItem() {}
        }
    });
    context.window = context;
    context.app = { currentUser: user, currentPage: 'live', channelList, pages: {}, titleFor: (page) => `${page === 'live' ? 'Live TV' : page} · PigTV` };
    loadUi(context);
    vm.runInContext(read('js/components/VideoPlayer.js'), context);
    const player = Object.create(vm.runInContext('VideoPlayer', context).prototype);
    Object.assign(player, {
        overlay, container: null, settings: {}, currentChannel: null,
        video: { paused: true, pause() {}, play: () => Promise.resolve(), load() {}, src: '' },
        nowPlaying: { classList: { add() {}, remove() {} } },
        play: (c) => { played.push(c); },
        reportPlayEnd() {}, clearStartWatch() {}, stopTranscodeSession() {}, stopConflictWatch() {},
        channelUp: () => played.push('up'), channelDown: () => played.push('down')
    });
    return { context, document, player, storage, selected, played, handlers, overlay, content, navigator };
}

test('the last channel is kept per signed-in user, in this browser', () => {
    const storage = new Map();
    const a = harness({ user: { id: 5 }, storage });
    a.player.rememberChannel(SEVEN);
    assert.deepEqual(JSON.parse(storage.get('pigtv_last_channel:5')), { sourceId: 's1', id: '7' });
    assert.deepEqual({ ...a.player.recallChannel() }, { sourceId: 's1', id: '7' });
    const b = harness({ user: { id: 6 }, storage });
    assert.equal(b.player.recallChannel(), null, 'another user on the same browser sees nothing');
});

test('blocked storage: nothing is remembered and nothing throws', () => {
    const { player } = harness({ blocked: true });
    assert.doesNotThrow(() => player.rememberChannel(SEVEN));
    assert.equal(player.recallChannel(), null);
    assert.doesNotThrow(() => player.offerResume());
});

test('Live TV opens on the last channel, selected but not playing, with a Resume button', () => {
    const { player, storage, selected, played, content } = harness();
    storage.set('pigtv_last_channel:5', JSON.stringify({ sourceId: 's1', id: '7' }));
    player.offerResume();
    assert.deepEqual(played, [], 'nothing plays unasked');
    assert.equal(selected.length, 1);
    assert.equal(selected[0][0].channelId, '7');
    assert.deepEqual({ ...selected[0][1] }, { play: false });
    const button = content.querySelector('.player-resume-btn');
    assert.ok(button, 'Resume is in the player area');
    assert.equal(button.textContent, 'Resume');
    assert.match(content.textContent, /Seven News/);
    button.click();
    assert.equal(selected.length, 2);
    assert.equal(selected[1][0].channelId, '7');
    assert.equal(selected[1][1], undefined, 'the click plays it (selectChannel with its default)');
    assert.equal(player._resumeChannel, null);
});

test('no saved channel, or one that is gone from the line-up: the usual prompt, no Resume', () => {
    const h = harness();
    h.player.offerResume();
    h.player.renderIdleOverlay();
    assert.equal(h.content.querySelector('.player-resume-btn'), null);
    assert.match(h.content.textContent, /Select a channel/);
    h.storage.set('pigtv_last_channel:5', JSON.stringify({ sourceId: 's1', id: 'gone' }));
    h.player.offerResume();
    assert.deepEqual(h.selected, []);
});

test('nothing is offered over a channel that is already playing', () => {
    const { player, storage, selected } = harness();
    storage.set('pigtv_last_channel:5', JSON.stringify({ sourceId: 's1', id: '7' }));
    player._playing = true;
    player.offerResume();
    assert.deepEqual(selected, []);
});

test('the tab says what is playing on Live TV, and goes back to the page name when it stops or another page shows', () => {
    const { player, document, context } = harness();
    player.currentChannel = SEVEN;
    player._playing = true;
    player.updateTabTitle();
    assert.equal(document.title, 'Seven News · PigTV');
    context.app.currentPage = 'guide';
    player.updateTabTitle();
    assert.equal(document.title, 'guide · PigTV', 'another page names itself');
    context.app.currentPage = 'live';
    player.updateTabTitle();
    assert.equal(document.title, 'Seven News · PigTV');
    player.stop();
    assert.equal(document.title, 'Live TV · PigTV', 'stopped: the page title is back');
});

test('Media Session: programme as title, channel as artist, logo as artwork, and the keys change channel', () => {
    const { player, handlers, navigator, played } = harness();
    player.initMediaSessionHandlers();
    assert.deepEqual(Object.keys(handlers).sort(), ['nexttrack', 'pause', 'play', 'previoustrack']);
    player._playing = true;
    player.updateNowPlaying = undefined; // the real one touches the page; the session is what is under test
    player.updateMediaSession(SEVEN, null);
    assert.equal(navigator.mediaSession.metadata.title, 'Seven News', 'no programme known: the channel name');
    player.updateMediaSession(SEVEN, { current: { title: 'Evening News' } });
    assert.equal(navigator.mediaSession.metadata.title, 'Evening News');
    assert.equal(navigator.mediaSession.metadata.artist, 'Seven News');
    assert.equal(navigator.mediaSession.metadata.artwork[0].src, SEVEN.tvgLogo);
    player.updateMediaSession(NINE, null);
    assert.equal(navigator.mediaSession.metadata.artwork, undefined, 'no logo, no artwork');
    handlers.previoustrack();
    handlers.nexttrack();
    assert.deepEqual(played, ['up', 'down']);
    player.stop();
    assert.equal(navigator.mediaSession.metadata, null, 'stopped: the card goes');
});

test('a browser without Media Session is left alone', () => {
    const { player } = harness({ mediaSession: false });
    assert.doesNotThrow(() => { player.initMediaSessionHandlers(); player.updateMediaSession(SEVEN, null); });
});

test('ChannelList.selectChannel with play:false selects but does not start the player', async () => {
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} }, window: {}, document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
        Icons: {}, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0
    });
    const plays = [];
    context.window.app = { player: { play: (c) => plays.push(c) } };
    loadUi(context);
    vm.runInContext(read('js/components/ChannelList.js'), context);
    const list = Object.create(vm.runInContext('ChannelList', context).prototype);
    list.channels = [SEVEN];
    list.container = { querySelectorAll: () => [], querySelector: () => null };
    list.renderedChannels = [];
    await list.selectChannel({ channelId: '7', sourceId: 's1' }, { play: false });
    assert.deepEqual(plays, []);
    assert.equal(list.currentChannel, SEVEN);
    await list.selectChannel({ channelId: '7', sourceId: 's1' });
    assert.deepEqual(plays, [SEVEN]);
});
