const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./helpers/fakeDom');

// #320 (rig, real Chromium): on the idle player, moving the mouse over it showed the controls overlay on top of the
// Resume button, so a click on Resume did nothing. The controls overlay stays hidden while the idle overlay shows.
const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');

function harness() {
    const document = createDocument();
    const byId = {};
    document.getElementById = (id) => (byId[id] ||= (() => { const e = document.createElement('div'); e.id = id; document.body.appendChild(e); return e; })());
    document.documentElement.style = { setProperty() {} };
    const context = vm.createContext({
        document, console: { ...console, log() {}, warn() {}, error() {} }, navigator: { userAgent: '' },
        localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, clearTimeout() {},
        addEventListener() {}, innerWidth: 1000, innerHeight: 800
    });
    context.window = context;
    vm.runInContext(SOURCE, context);
    const player = Object.create(vm.runInContext('VideoPlayer', context).prototype);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const video = document.createElement('video');
    video.paused = true; video.play = () => Promise.resolve(); video.pause = () => {};
    Object.assign(player, { container, video, settings: {}, overlay: document.getElementById('player-overlay'), nowPlaying: document.createElement('div') });
    return { player, container, document };
}

test('moving the mouse or touching the idle player does not put the controls over the Resume button', () => {
    const { player, container, document } = harness();
    player.initCustomControls();
    const controls = document.getElementById('player-controls-overlay');
    assert.ok(controls.classList.contains('hidden'), 'hidden at the start');
    for (const type of ['mousemove', 'touchstart']) {
        container.dispatchEvent({ type, target: container, bubbles: false });
        assert.ok(controls.classList.contains('hidden'), `${type} leaves them hidden while idle`);
    }
});

test('with a channel playing (the idle overlay hidden) the controls still appear on mouse move', () => {
    const { player, container, document } = harness();
    player.initCustomControls();
    player.overlay.classList.add('hidden');
    container.dispatchEvent({ type: 'mousemove', target: container, bubbles: false });
    assert.ok(!document.getElementById('player-controls-overlay').classList.contains('hidden'));
});
