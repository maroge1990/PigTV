const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #320 (2): the player's keys act only while Live TV is the page showing. The real VideoPlayer script, no browser.
const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');

function harness({ page = 'live', documentExtra = {} } = {}) {
    const context = vm.createContext({
        window: {}, console: { ...console, log() {}, warn() {}, error() {} },
        document: { getElementById: () => null, addEventListener() {}, activeElement: { tagName: 'BODY' }, ...documentExtra },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
    });
    context.window.app = { currentPage: page };
    vm.runInContext(SOURCE, context);
    const player = Object.create(context.window.VideoPlayer.prototype);
    const calls = [];
    player.video = { paused: true, muted: false, volume: 0.5, play() { calls.push('play'); }, pause() { calls.push('pause'); } };
    player.settings = { arrowKeysChangeChannel: true };
    player.toggleFullscreen = () => calls.push('fullscreen');
    player.channelUp = () => calls.push('channelUp');
    player.channelDown = () => calls.push('channelDown');
    return { context, player, calls };
}

const key = (k) => { const e = { key: k, target: { closest: () => null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; return e; };

for (const page of ['guide', 'recordings', 'settings', 'sports', 'status']) {
    test(`on ${page} the player keys do nothing to the hidden player`, () => {
        const { player, calls } = harness({ page });
        for (const k of [' ', 'k', 'f', 'm', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'PageUp', 'PageDown']) {
            const e = key(k);
            player.handleKeyboard(e);
            assert.equal(e.defaultPrevented, false, `${k} is left to the page`);
        }
        assert.deepEqual(calls, []);
        assert.equal(player.video.volume, 0.5);
        assert.equal(player.video.muted, false);
    });
}

test('on Live TV the same keys still work', () => {
    const { player, calls } = harness({ page: 'live' });
    player.handleKeyboard(key(' '));
    player.handleKeyboard(key('f'));
    player.handleKeyboard(key('m'));
    player.handleKeyboard(key('ArrowRight'));
    player.handleKeyboard(key('PageUp'));
    assert.deepEqual(calls, ['play', 'fullscreen', 'channelUp']);
    assert.equal(player.video.muted, true);
    assert.ok(Math.abs(player.video.volume - 0.6) < 1e-9);
});

test('a text field still keeps its own keys on Live TV', () => {
    const { player, calls } = harness({ page: 'live', documentExtra: { activeElement: { tagName: 'INPUT' } } });
    player.handleKeyboard(key('k'));
    assert.deepEqual(calls, []);
});

