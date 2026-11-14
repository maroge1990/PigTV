// The real VideoPlayer (public/js/components/VideoPlayer.js), built by its own constructor over the fake DOM, with its
// real event wiring, hls.js faked, fetch answered by the test and a clock the test moves (timers run in order).
// What it does NOT prove: real media timing, hls.js's own retries, layout. Those need a browser (T3).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, FakeEvent } = require('./fakeDom');
const { loadUi } = require('./webUi');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/components/VideoPlayer.js'), 'utf8');

function makeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    const setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, ms), id }); return id; };
    const clearTimeout = (id) => { timers.delete(id); };
    const setInterval = (fn, ms) => { const id = ++seq; const run = () => { timers.set(id, { fn: () => { run(); fn(); }, at: now + ms, id }); }; run(); return id; };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
    /** Move the clock on by `ms`, running every timer that falls due, in order, with the promises they start. */
    const advance = async (ms) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!due) break;
            timers.delete(due.id);
            now = due.at;
            due.fn();
            await flush();
        }
        now = end;
        await flush();
    };
    return { setTimeout, clearTimeout, setInterval, clearInterval: clearTimeout, now: () => now, advance, flush };
}

function el(document, tag, { id, className, parent } = {}) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    (parent || document.body).appendChild(node);
    return node;
}

/**
 * `terminal`: what GET /api/playback/:id/terminal-status answers ('none' | 'taken-over'), or a promise of it.
 * `resolve(n, body)`: the n-th resolve's answer ({status, body}); by default a new session each time (s1, s2, …).
 */
function makeLivePlayer({ terminal = () => 'none', resolve, page = 'live', extraDom } = {}) {
    const clock = makeClock();
    const document = createDocument();
    document.documentElement.style.setProperty = () => {};
    const app = el(document, 'div', { id: 'app' });
    const container = el(document, 'div', { className: 'video-container', parent: app });
    const video = el(document, 'video', { id: 'video-player', parent: container });
    Object.assign(video, {
        paused: true, seeking: false, currentTime: 0, volume: 1, muted: false, readyState: 0, networkState: 0, error: null,
        currentSrc: '', seekable: { length: 0 }, buffered: { length: 0 }, textTracks: [],
        canPlayType: () => '', load() {}, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }
    });
    const controls = el(document, 'div', { id: 'player-controls-overlay', className: 'watch-overlay hidden', parent: container });
    el(document, 'div', { id: 'player-loading', parent: controls });
    el(document, 'h2', { id: 'player-channel-name', parent: controls });
    const overlay = el(document, 'div', { id: 'player-overlay', className: 'player-overlay', parent: container });
    el(document, 'div', { className: 'overlay-content', parent: overlay });
    const nowPlaying = el(document, 'div', { id: 'now-playing', className: 'now-playing-overlay hidden', parent: container });
    el(document, 'h3', { className: 'channel-name', parent: nowPlaying });
    el(document, 'p', { className: 'program-title', parent: nowPlaying });
    el(document, 'p', { className: 'program-time', parent: nowPlaying });
    el(document, 'ul', { id: 'up-next-list', parent: nowPlaying });
    if (extraDom) extraDom(document, { app, container, controls, el: (tag, opts) => el(document, tag, opts) });

    const requests = [];   // every fetch: { url, method, body }
    let resolves = 0;
    const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, method, body });
        if (url === '/api/playback/resolve') {
            resolves++;
            if (resolve) { const r = resolve(resolves, body); return answer(r.status, r.body); }
            const sid = `s${resolves}`;
            return answer(200, { strategy: 'transcode', container: 'hls', videoMode: 'copy', url: `/api/transcode/${sid}/master.m3u8`, sessionId: sid });
        }
        const term = url.match(/^\/api\/playback\/([^/]+)\/terminal-status$/);
        if (term) return answer(200, { status: await terminal(decodeURIComponent(term[1])) }); // may be a promise the test settles
        return answer(200, null);
    };

    class FakeHls {
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error', SUBTITLE_TRACKS_UPDATED: 'subtitles', AUDIO_TRACKS_UPDATED: 'audioTracks', AUDIO_TRACK_SWITCHED: 'audioSwitched' };
        static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
        static isSupported() { return true; }
        constructor() { this.handlers = {}; this.audioTracks = []; this.audioTrack = -1; FakeHls.instances.push(this); }
        on(name, fn) { this.handlers[name] = fn; }
        loadSource(url) { this.url = url; }
        attachMedia() {}
        destroy() { this.destroyed = true; }
        recoverMediaError() {}
        emit(name, data = {}) { if (this.handlers[name]) this.handlers[name](name, data); }
    }
    FakeHls.instances = [];

    const storage = new Map([['authToken', 'tok']]);
    const windowListeners = {};
    const context = vm.createContext({
        document, navigator: { userAgent: 'test' }, URL, AbortController, Promise, JSON, Symbol,
        console: { ...console, log() {}, warn() {}, error() {} },
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
        performance: { now: clock.now },
        Hls: FakeHls, fetch, confirm: () => false,
        CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
        localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
        API: { settings: { get: async () => ({}) }, withStreamToken: (u) => u, streamFetch: async () => ({}) },
        addEventListener: (t, fn) => { (windowListeners[t] ||= []).push(fn); },
        dispatchEvent: (ev) => { (windowListeners[ev.type] || []).forEach(fn => fn(ev)); return true; }
    });
    context.window = context;
    context.app = { currentUser: { id: 5 }, currentPage: page, pages: {}, titleFor: (p) => `${p} · PigTV` };
    loadUi(context);
    vm.runInContext(SOURCE, context);
    const VideoPlayer = vm.runInContext('VideoPlayer', context);
    const player = new VideoPlayer();

    const fire = (type) => video.dispatchEvent(new FakeEvent(type, { bubbles: false }));
    /** The element shows pictures: playing, with its time moving on by `sec`. */
    const plays = async (sec = 1) => {
        video.paused = false;
        fire('playing');
        for (let i = 0; i < sec; i++) { video.currentTime += 1; fire('timeupdate'); await clock.advance(1000); }
    };
    const resolvesMade = () => requests.filter(r => r.url === '/api/playback/resolve');
    const deletes = () => requests.filter(r => r.method === 'DELETE').map(r => r.url);
    const ready = async () => { await clock.flush(); };
    return { player, VideoPlayer, context, document, container, video, overlay, controls, clock, requests, resolvesMade, deletes,
        FakeHls, fire, plays, ready, storage, windowListeners };
}

module.exports = { makeLivePlayer, makeClock };
