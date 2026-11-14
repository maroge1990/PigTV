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

// #62 (C-L): a recording in progress plays from its start through /watch.
function tileOf(page, item) { return page.tileHtml(item, null); }

test('#62: a recording in progress that can be watched offers "Watch from start"; one that cannot, or a finished one, does not', () => {
    const t = make(() => json({}));
    const live = tileOf(t.page, { id: 5, title: 'Match', status: 'recording', watch_live: true });
    assert.match(live, /data-action="watch" data-id="5"[^>]*>[\s\S]*Watch from start/);
    assert.ok(!live.includes('data-action="play"'), 'no plain Play while it records');
    assert.ok(!tileOf(t.page, { id: 5, title: 'Match', status: 'recording', watch_live: false }).includes('data-action="watch"'));
    assert.ok(!tileOf(t.page, { id: 5, title: 'Match', status: 'completed', watch_live: false }).includes('data-action="watch"'));
    assert.ok(tileOf(t.page, { id: 5, title: 'Match', status: 'completed' }).includes('data-action="play"'));
});

test('#62: clicking "Watch from start" opens the player on /watch, not /playback or /stream', async () => {
    const t = make((url) => json({ url: '/api/recordings/5/live/master.m3u8', container: 'hls', recording: true, durationSec: 60 }), { nativeHls: true });
    const button = el({ dataset: { id: '5' } });
    const list = el({ querySelectorAll: (sel) => (sel === '[data-action="watch"]' ? [button] : []) });
    t.page.recordingsList = list;
    t.page.data.recordings = [{ id: 5, title: 'Match', status: 'recording', watch_live: true }];
    t.page.failed = { recordings: false, scheduled: false, rules: false };
    t.page.drawRecorded();
    button.fire('click');
    await settle();
    assert.deepEqual(t.requests, ['/api/recordings/5/watch'], 'no resume question, no playback, no stream');
    assert.equal(t.video().src, '/api/recordings/5/live/master.m3u8?token=tok', 'Safari plays the playlist natively');
});

test('#62: asking to watch keeps asking while the first piece is made, and plays the finished recording if it finished meanwhile', async () => {
    let n = 0;
    const t = make((url) => {
        if (url.endsWith('/watch')) return n++ === 0 ? json({ status: 'preparing', retryAfterSec: 2 }, 202) : json({ error: 'Recording is finished: play it instead', finished: true }, 409);
        return json(playbackAnswer);
    });
    await t.page.play(7, { watch: true });
    assert.deepEqual(t.requests, ['/api/recordings/7/watch', '/api/recordings/7/watch', '/api/recordings/7/playback?async=1']);
    assert.deepEqual(t.delays, [2000]);
    assert.equal(t.video().src, '/api/recordings/7/media.mp4?token=tok');
});

// #62: Find breaks, as the Apple app's per-recording action.
const labels = (page, item) => { page.data.recordings = [item]; return page.menuItems(item.id).map(i => i.label); };

test('#62: the menu offers Find breaks (or Retry / again) unless a search is running or no detector exists, and never on one still recording', () => {
    const t = make(() => json({}));
    const base = { id: 3, title: 'News', status: 'completed' };
    assert.ok(labels(t.page, base).includes('Find breaks'));
    assert.ok(labels(t.page, { ...base, ad_detect_status: 'done' }).includes('Find breaks again'));
    assert.ok(labels(t.page, { ...base, ad_detect_status: 'failed' }).includes('Retry finding breaks'));
    for (const status of ['running', 'pending', 'unavailable']) {
        assert.ok(!labels(t.page, { ...base, ad_detect_status: status }).some(l => /breaks/.test(l)), status);
    }
    assert.ok(!labels(t.page, { ...base, status: 'recording' }).some(l => /breaks/.test(l)));
});

test('#62: choosing Find breaks posts detect-ads, says so, and refreshes so the card shows it running', async () => {
    const t = make((url, method) => json(method === 'POST' ? { success: true, queued: true } : []));
    t.page.refresh = async () => { t.refreshed = true; };
    t.page.startCompressionWatch = () => { t.watching = true; };
    t.page.data.recordings = [{ id: 3, title: 'News', status: 'completed' }];
    t.page.menuItems(3).find(i => i.label === 'Find breaks').run();
    await settle();
    assert.deepEqual(t.requests, ['/api/recordings/3/detect-ads']);
    assert.match(t.context.toasts[0][0], /Looking for commercial breaks/);
    assert.ok(t.refreshed && t.watching, 'the progress is followed until the search ends');
});

test('#62: a refused Find breaks (already analysing) is told, not lost', async () => {
    const t = make(() => json({ error: 'Already analysing' }, 409));
    t.page.refresh = async () => {};
    t.page.data.recordings = [{ id: 3, title: 'News', status: 'completed' }];
    t.page.menuItems(3).find(i => i.label === 'Find breaks').run();
    await settle();
    assert.match(t.context.toasts[0][0], /Already analysing/);
    assert.equal(t.context.toasts[0][1].kind, 'error');
});

test('#62: the card says when a search is waiting, and when this image has no detector', () => {
    const t = make(() => json({}));
    const pending = t.page.tileHtml({ id: 3, title: 'News', status: 'completed', ad_detect_status: 'pending' }, null);
    assert.match(pending, /Waiting to find breaks/);
    const none = t.page.tileHtml({ id: 3, title: 'News', status: 'completed', ad_detect_status: 'unavailable', ad_detect_error: 'Comskip is not installed in this image' }, null);
    assert.match(none, /Break detection unavailable/);
    assert.match(none, /Comskip is not installed/);
});
