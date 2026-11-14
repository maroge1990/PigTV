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
    const resolves = [];
    const context = vm.createContext({
        document, navigator: {}, AbortController, console: { ...console, log() {}, warn() {}, error() {} },
        fetch: (url, init) => {
            fetched.push([url, init]);
            if (url === '/api/playback/resolve') return new Promise((resolve) => resolves.push((json) => resolve({ ok: true, status: 200, json: async () => json })));
            return Promise.resolve({ ok: true });
        },
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
    return { player, fire, fetched, content, resolves };
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

test('pagehide while a play is still resolving: the late answer, after the page is restored, plays nothing and gives its session back; Resume is offered', async () => {
    const { player, fire, fetched, content, resolves } = harness();
    const played = [];
    Object.assign(player, {
        _playing: false, currentSessionId: null, _playGeneration: 1,
        beginPlayMeasurement() {}, updateTranscodeStatus() {}, getCodecCapabilities: () => ({}), needsAudioEncode: () => false,
        playDecision: async (d, c) => { played.push(c.id); }
    });
    player.video.canPlayType = () => '';
    player.overlay.classList = { add() {}, remove() {} };
    const pending = player.play(SEVEN, null);
    await new Promise(r => setImmediate(r));
    assert.equal(resolves.length, 1, 'the resolve is out');
    fire('pagehide');
    fire('pageshow', { persisted: true });
    resolves[0]({ strategy: 'transcode', url: '/api/transcode/late/master.m3u8', sessionId: 'late' });
    await pending;
    assert.deepEqual(played, [], 'nothing plays');
    assert.ok(fetched.some(([url, init]) => url === '/api/transcode/late' && init.method === 'DELETE'), 'the late session is given back');
    assert.ok(content.querySelector('.player-resume-btn'), 'Resume is offered');
});
