const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #320 (3): fullscreen is one cross-browser function (it was defined twice; the plain one, later in the class, replaced
// the Safari-aware one). The real VideoPlayer script, no browser.
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

test('fullscreen is defined once, and it is the Safari-aware one', () => {
    const count = (SOURCE.match(/^    toggleFullscreen\(\) \{/gm) || []).length;
    assert.equal(count, 1);
    // iPhone Safari: no element fullscreen, so the video's own
    const entered = [];
    const { player } = harness({});
    player.container = {};
    player.video = { webkitEnterFullscreen: () => entered.push('video') };
    VideoPlayerProto(player).toggleFullscreen.call(player);
    assert.deepEqual(entered, ['video']);
});

test('fullscreen leaves through the webkit prefix when that is all the browser has', () => {
    const exited = [];
    const { player } = harness({ documentExtra: { webkitFullscreenElement: {}, webkitExitFullscreen: () => exited.push('webkit') } });
    VideoPlayerProto(player).toggleFullscreen.call(player);
    assert.deepEqual(exited, ['webkit']);
});

function VideoPlayerProto(player) { return Object.getPrototypeOf(player); }
