const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #62: the Recordings page player. Play resolves the address through /playback?async=1 (or /watch for a recording
// still in progress), says "Preparing…" while the server prepares, plays what it returns (hls.js for HLS, natively
// otherwise) and writes every failure in the player with Try again. The real RecordingsPage and api.js run in a vm
// with a small fake DOM and a fake clock.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function el(extra = {}) {
    const listeners = {};
    const attrs = {};
    const node = {
        innerHTML: '', hidden: false, className: '', disabled: false, listeners, attrs,
        addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
        setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
        removeAttribute: (k) => { delete attrs[k]; },
        pause() { this.paused = true; }, play() { return Promise.resolve(); }, load() {}, focus() {}, remove() { this.removed = true; },
        fire(type) { (listeners[type] || []).slice().forEach(fn => fn({ target: node })); },
        ...extra
    };
    Object.defineProperty(node, 'src', { get: () => attrs.src || '', set: (v) => { attrs.src = v; } });
    return node;
}

function make(respond, { hls = null, nativeHls = false, holdClock = false } = {}) {
    const requests = [];
    const delays = [];
    let overlay;
    const document = {
        hidden: false, activeElement: null, body: { appendChild: () => {} },
        getElementById: () => null,
        addEventListener: () => {}, removeEventListener: () => {},
        makeOverlay() {
            overlay = el({ querySelector: (sel) => overlay.parts[sel] || null });
            const state = el({});
            const retry = el();
            Object.defineProperty(state, 'innerHTML', { get: () => state._html || '', set: (v) => { state._html = v; state._retry = v.includes('data-state-action') ? retry : null; } });
            state.querySelector = () => state._retry;
            state.retry = retry;
            overlay.parts = {
                video: el({ canPlayType: () => (nativeHls ? 'maybe' : ''), currentTime: 0, paused: true }),
                '.recording-player-status': state,
                '.recording-player-close': el(), '.ad-markers': el(), '.skip-ad-btn': el()
            };
            return overlay;
        }
    };
    const context = vm.createContext({
        console: { ...console, error() {}, warn() {} }, localStorage: { getItem: () => 'tok' }, document,
        // The fake clock: a wait is recorded and ends at once (nothing in the page is timed in real seconds).
        setTimeout: (fn, ms) => { delays.push(ms); if (!holdClock) Promise.resolve().then(fn); return 0; },
        setInterval: () => 0, clearInterval: () => {},
        fetch: async (url, opts = {}) => { requests.push(String(url)); return respond(String(url), opts.method || 'GET'); }
    });
    context.window = context;
    if (hls) context.Hls = hls;
    loadUi(context); // before createElement exists: ui.js builds no toast, and UI.toast is a recorder anyway
    vm.runInContext(js('api.js'), context);
    document.createElement = document.makeOverlay;
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    const page = new context.RecordingsPage({});
    return { context, page, requests, delays, get overlay() { return overlay; }, status: () => overlay.parts['.recording-player-status'], video: () => overlay.parts.video };
}

const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const playbackAnswer = { url: '/api/recordings/7/media.mp4', container: 'mp4', durationSec: 1800 };

test('#62: Play resolves through /playback?async=1, says Preparing while the server prepares, then plays the returned address', async () => {
    let asked = 0;
    const t = make((url) => {
        if (url.includes('/position')) return json({ position_sec: 0 });
        asked++;
        return asked < 3 ? json({ status: 'preparing', retryAfterSec: 3 }, 202) : json(playbackAnswer);
    });
    const playing = t.page.play(7);
    await settle();
    assert.equal(t.requests.filter(u => u.includes('/playback')).length, 3, 'asked again while the server said preparing');
    assert.ok(t.requests.every(u => !u.includes('/stream')), 'never the raw stream');
    assert.ok(t.requests.filter(u => u.includes('/playback')).every(u => u.includes('async=1')));
    assert.deepEqual(t.delays, [3000, 3000], 'waited as the server asked');
    await playing;
    assert.equal(t.video().src, '/api/recordings/7/media.mp4?token=tok');
    assert.equal(t.status().hidden, true, 'the status is gone once it plays');
});

test('#62: while the server prepares, the player says "Preparing…"', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const t = make((url) => (url.includes('/position') ? json({}) : gate.then(() => json(playbackAnswer))));
    const playing = t.page.play(7);
    await settle();
    assert.equal(t.status().hidden, false);
    assert.match(t.status().innerHTML, /Preparing…/);
    release();
    await playing;
    assert.equal(t.status().hidden, true);
});

test('#62: a failed preparation is written in the player with Try again, which asks again', async () => {
    let failing = true;
    const t = make((url) => {
        if (url.includes('/position')) return json({});
        return failing ? json({ status: 'failed', error: 'The server could not prepare this recording for playback' }, 500) : json(playbackAnswer);
    });
    await t.page.play(7);
    assert.equal(t.status().hidden, false);
    assert.match(t.status().innerHTML, /could not be prepared for playback/);
    assert.match(t.status().innerHTML, /Try again/);
    assert.ok(!/<video[^>]*src/.test(t.status().innerHTML));
    failing = false;
    t.status().retry.fire('click');
    await settle();
    assert.equal(t.video().src, '/api/recordings/7/media.mp4?token=tok');
    assert.equal(t.status().hidden, true);
});

test('#62: a media error on the element shows the message and Try again instead of a black box', async () => {
    const t = make((url) => (url.includes('/position') ? json({}) : json(playbackAnswer)));
    await t.page.play(7);
    t.video().fire('error');
    assert.equal(t.status().hidden, false);
    assert.match(t.status().innerHTML, /stopped playing/);
    assert.match(t.status().innerHTML, /Try again/);
    assert.equal(t.video().src, '', 'the broken source is dropped');
});

test('#62: an HLS answer plays through hls.js with the token, and a fatal hls.js error is shown', async () => {
    const made = [];
    class FakeHls {
        static isSupported() { return true; }
        constructor(config) { this.config = config; this.handlers = {}; made.push(this); }
        on(event, fn) { this.handlers[event] = fn; }
        loadSource(url) { this.url = url; }
        attachMedia(video) { this.video = video; }
        destroy() { this.destroyed = true; }
    }
    FakeHls.Events = { ERROR: 'error' };
    FakeHls.ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    const t = make((url) => (url.includes('/position') ? json({}) : json({ url: '/api/recordings/7/live/master.m3u8', container: 'hls' })), { hls: FakeHls });
    await t.page.play(7, { watch: true });
    assert.equal(made.length, 1);
    assert.equal(made[0].url, '/api/recordings/7/live/master.m3u8?token=tok');
    assert.equal(made[0].config.startPosition, 0, 'a recording in progress plays from its start');
    assert.equal(t.video().src, '', 'not set as a plain source');
    made[0].handlers.error('error', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    assert.equal(made[0].destroyed, true);
    assert.match(t.status().innerHTML, /Try again/);
});

test('#62: closing the player while it is still preparing stops asking', async () => {
    const t = make((url) => (url.includes('/position') ? json({}) : json({ status: 'preparing', retryAfterSec: 3 }, 202)), { holdClock: true });
    const playing = t.page.play(7);
    await settle();
    assert.deepEqual(t.delays, [3000], 'waiting for the next ask');
    const before = t.requests.length;
    t.page.closePlayer();
    await settle();
    assert.equal(t.requests.length, before, 'no further ask once closed');
    assert.equal(t.overlay.removed, true);
    void playing;
});
