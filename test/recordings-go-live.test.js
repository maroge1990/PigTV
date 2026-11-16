const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #335 (D-67): Go to live on a recording still recording. The Recordings player (the real RecordingsPage and api.js in a
// vm, a small fake DOM, timers the test runs) offers it only for a /watch of a recording in progress, as the modal's
// last control, never by itself: only while playback is more than 30 s behind the newest point; the jump offers
// "Back to h:mm:ss" for 8 s, which returns to the exact place.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function el(extra = {}) {
    const listeners = {};
    const attrs = {};
    const node = {
        innerHTML: '', hidden: false, className: '', textContent: '', listeners, attrs,
        addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
        setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
        removeAttribute: (k) => { delete attrs[k]; },
        pause() {}, play() { return Promise.resolve(); }, load() {}, focus() {}, remove() {},
        fire(type) { (listeners[type] || []).slice().forEach(fn => fn({ target: node })); },
        ...extra
    };
    Object.defineProperty(node, 'src', { get: () => attrs.src || '', set: (v) => { attrs.src = v; } });
    return node;
}

function make(respond) {
    const timers = [];
    let overlay;
    const document = {
        hidden: false, activeElement: null, body: { appendChild: () => {} }, getElementById: () => null,
        addEventListener: () => {}, removeEventListener: () => {},
        makeOverlay() {
            overlay = el({ querySelector: (sel) => overlay.parts[sel] || null });
            const state = el();
            state.querySelector = () => null;
            const end = { value: 600 };
            overlay.end = end;
            overlay.parts = {
                // seekable: what has been recorded so far (0 to end.value seconds)
                video: el({ canPlayType: () => 'maybe', currentTime: 0, seekable: { get length() { return 1; }, end: () => end.value } }),
                '.recording-player-status': state, '.recording-player-close': el(), '.ad-markers': el(), '.skip-ad-btn': el({ hidden: true }),
                '.go-live-btn': el({ hidden: true }), '.go-live-note': el({ hidden: true }), '.go-live-back': el()
            };
            return overlay;
        }
    };
    const context = vm.createContext({
        console: { ...console, error() {}, warn() {} }, localStorage: { getItem: () => 'tok' }, document,
        setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); if (ms < 1000) Promise.resolve().then(() => { t.done = true; fn(); }); return t; },
        clearTimeout: (t) => { if (t) t.done = true; },
        setInterval: () => 0, clearInterval: () => {},
        fetch: async (url, opts = {}) => respond(String(url), opts.method || 'GET')
    });
    context.window = context;
    loadUi(context); // before createElement exists: ui.js builds no toast, and UI.toast is a recorder anyway
    vm.runInContext(js('api.js'), context);
    document.createElement = document.makeOverlay;
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    const page = new context.RecordingsPage({});
    return { page, timers, get overlay() { return overlay; }, part: (s) => overlay.parts[s], video: () => overlay.parts.video };
}

const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const watching = (url) => (url.includes('/watch') ? json({ url: '/api/recordings/2/live/master.m3u8', container: 'hls', recording: true, durationSec: 600 })
    : url.includes('/position') ? json({ position_sec: 0 }) : json({ url: '/api/recordings/2/media.mp4', container: 'mp4', durationSec: 600 }));

test('#335: the player draws Go to live as the last control of the modal, red, with its own icon, hidden at first', () => {
    const src = js('pages/RecordingsPage.js');
    const box = src.slice(src.indexOf('<div class="recording-player-box">'), src.indexOf('`;', src.indexOf('<div class="recording-player-box">')));
    const controls = [...box.matchAll(/<(?:button|div)[^>]*class="([^"]+)"/g)].map(m => m[1]);
    assert.match(controls.at(-1), /\bgo-live-btn\b/, `Go to live is the last control (${controls.join(' | ')})`);
    assert.match(controls.at(-1), /\bbtn-danger\b/, 'the web\'s red (danger) button');
    assert.ok(controls.indexOf(controls.find(c => c.includes('skip-ad-btn'))) < controls.length - 1, 'after Skip ad');
    assert.match(box, /class="btn btn-danger go-live-btn" hidden>\$\{RecordingsPage\.GO_LIVE_ICON\}<span>Go to live<\/span>/);
    assert.match(src, /static GO_LIVE_ICON = '<svg[^']*<circle/, 'its own icon: an arrow to a dot');
});

test('#335: watching a recording in progress, Go to live shows only while more than 30 s behind the newest point', async () => {
    const t = make(watching);
    await t.page.play(2, { watch: true });
    await settle();
    const button = t.part('.go-live-btn'), video = t.video();
    assert.equal(button.hidden, false, 'at the start, 600 s behind: shown');
    video.currentTime = 580; video.fire('timeupdate');
    assert.equal(button.hidden, true, 'within 30 s of the newest point (597): hidden');
    video.currentTime = 100; video.fire('timeupdate');
    assert.equal(button.hidden, false);
    video.fire('ended');
    assert.equal(button.hidden, true, 'the recording finished: no live point');
});

test('#335: a finished recording (or one that finished while asking) never shows Go to live', async () => {
    const t = make(watching);
    await t.page.play(2, { watch: false });
    await settle();
    t.video().fire('timeupdate');
    assert.equal(t.part('.go-live-btn').hidden, true);
    const u = make((url) => (url.includes('/watch') ? json({ error: 'finished' }, 409) : watching(url)));
    await u.page.play(2, { watch: true });
    await settle();
    u.video().fire('timeupdate');
    assert.equal(u.part('.go-live-btn').hidden, true, 'a 409 played the finished recording instead');
});

test('#335: Go to live jumps to the newest point, says so with Back to h:mm:ss for 8 s, and Back restores the exact place', async () => {
    const t = make(watching);
    await t.page.play(2, { watch: true });
    await settle();
    const video = t.video(), button = t.part('.go-live-btn'), note = t.part('.go-live-note'), back = t.part('.go-live-back');
    video.currentTime = 3725.4; t.overlay.end.value = 7200; video.fire('timeupdate');
    button.fire('click');
    assert.equal(video.currentTime, 7197, 'the newest point, a few seconds back from the end');
    assert.equal(button.hidden, true);
    assert.equal(note.hidden, false, '"Jumped to live" shown');
    assert.equal(back.textContent, 'Back to 1:02:05');
    const undo = t.timers.find(x => x.ms === 8000);
    assert.ok(undo, 'the notice lasts 8 s');
    back.fire('click');
    assert.equal(video.currentTime, 3725.4, 'back to the exact place');
    assert.equal(note.hidden, true);
    assert.equal(button.hidden, false, 'behind again: Go to live is back');
    // a second jump, then the 8 s pass: the notice goes, and Back is no longer offered
    button.fire('click');
    t.timers.filter(x => x.ms === 8000 && !x.done).forEach(x => { x.done = true; x.fn(); });
    assert.equal(note.hidden, true);
});

test('#335 (Codex medium): the recording finishing is learned from the active list every 30 s, with no \'ended\' and playback still behind', async () => {
    let finished = false, watches = 0;
    // /recordings/active lists schedules; `recording_id` is the recording played (2), another one records too
    const t = make((url) => {
        if (url.includes('/recordings/active')) return json([{ id: 40, recording_id: 9, status: 'recording' },
            ...(finished ? [] : [{ id: 41, recording_id: 2, status: 'recording' }])]);
        if (url.includes('/watch')) watches++;
        return watching(url);
    });
    await t.page.play(2, { watch: true });
    await settle();
    const button = t.part('.go-live-btn');
    assert.equal(button.hidden, false);
    const due = () => t.timers.filter(x => x.ms === 30000 && !x.done);
    assert.equal(due().length, 1, 'a check every 30 s');
    const first = due()[0]; first.done = true; await first.fn(); await settle();
    assert.equal(button.hidden, false, 'still recording: still offered');
    finished = true;
    const next = due();
    assert.equal(next.length, 1, 'checked again');
    next[0].done = true; await next[0].fn(); await settle();
    t.video().fire('timeupdate');
    assert.equal(button.hidden, true, 'the server says it has finished: Go to live goes at once');
    assert.equal(due().length, 0, 'no more checks');
    assert.equal(watches, 1, '/watch (a view and a probe on the server) is asked only to open the player');
    // closing the player stops the checks of a recording still recording
    finished = false;
    const u = make(watching);
    await u.page.play(2, { watch: true });
    await settle();
    const poll = u.timers.find(x => x.ms === 30000);
    u.page.closePlayer();
    assert.equal(poll.done, true, 'the check is cleared on close');
});
