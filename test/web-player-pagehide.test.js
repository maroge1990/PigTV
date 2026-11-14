const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./helpers/fakeDom');

// #320 (4): closing the tab gives the stream back at once (a DELETE with keepalive), and a page restored from the
// back/forward cache comes back to a Resume prompt, not a dead player. The real VideoPlayer script over a fake DOM.
const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');
const SEVEN = { id: '7', sourceId: 's1', name: 'Seven News' };

function harness() {
    const document = createDocument();
    const overlay = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'overlay-content';
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    const listeners = {};
    const fetched = [];
    const context = vm.createContext({
        document, navigator: {}, console: { ...console, log() {}, warn() {}, error() {} },
        fetch: (url, init) => { fetched.push([url, init]); return Promise.resolve({ ok: true }); },
        localStorage: { getItem: (k) => (k === 'authToken' ? 'tok' : null), setItem() {}, removeItem() {} },
        addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); }
    });
    context.window = context;
    context.app = { currentUser: { id: 5 }, currentPage: 'live', channelList: { findChannel: () => SEVEN, selectChannel() {} }, pages: {}, titleFor: () => 'Live TV · PigTV' };
    vm.runInContext(SOURCE, context);
    const player = Object.create(vm.runInContext('VideoPlayer', context).prototype);
    Object.assign(player, {
        overlay, settings: {}, currentChannel: SEVEN, currentSessionId: 'sess-1', _playing: true,
        video: { paused: false, pause() {}, load() {}, src: 'x' },
        nowPlaying: { classList: { add() {}, remove() {} } },
        reportPlayEnd() {}, clearStartWatch() {}, stopConflictWatch() {}
    });
    player.initPageLifecycle();
    const fire = (type, ev = {}) => (listeners[type] || []).forEach(fn => fn({ type, ...ev }));
    return { player, fire, fetched, content };
}

test('on pagehide the session is given back at once, with keepalive and the sign-in', () => {
    const { player, fire, fetched } = harness();
    fire('pagehide');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][0], '/api/transcode/sess-1');
    assert.equal(fetched[0][1].method, 'DELETE');
    assert.equal(fetched[0][1].keepalive, true);
    assert.equal(fetched[0][1].headers.Authorization, 'Bearer tok');
    assert.equal(player.currentSessionId, null);
    assert.equal(player._playing, false);
    fire('pagehide');
    assert.equal(fetched.length, 1, 'once');
});

test('a normal stop does not ask for keepalive', () => {
    const { player, fetched } = harness();
    player.stop();
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][1].keepalive, undefined);
});

test('pagehide with nothing playing sends nothing', () => {
    const { player, fire, fetched } = harness();
    player._playing = false;
    player.currentSessionId = null;
    fire('pagehide');
    assert.deepEqual(fetched, []);
});

test('restored from the back/forward cache: a Resume prompt, not a dead player and not auto-play', () => {
    const { player, fire, content } = harness();
    fire('pagehide');
    fire('pageshow', { persisted: true });
    assert.equal(player._playing, false);
    const button = content.querySelector('.player-resume-btn');
    assert.ok(button, 'Resume is showing');
    assert.match(content.textContent, /Seven News/);
});
