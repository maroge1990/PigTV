const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0209: the web app's three navigation/refresh races from the 15 Oct review (F1-F3), run on the
// real page scripts. On 0208 each test fails: an older guide response replaced the newer window,
// a quick Home revisit stayed on "Loading favourites…" for good, and Back pushed a new entry.

const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function load(files, globals = {}) {
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        window: {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
        document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
        ...globals
    });
    for (const f of files) vm.runInContext(js(f), context);
    return context;
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

test('F1: an older guide response arriving last does not replace the newer window', async () => {
    const c = load(['components/EpgGuide.js']);
    const slow = deferred();
    const requested = [];
    c.API = { library: {
        categories: async () => [], favourites: async () => [],
        guide: ({ start }) => { requested.push(start); return start === 1000 ? slow.promise : Promise.resolve({ channels: [{ id: 'b', sourceId: 1, name: 'B' }], nextCursor: null }); }
    } };
    const epg = Object.create(c.window.EpgGuide.prototype);
    let start = 1000;
    epg.renderWindow = () => ({ start, end: start + 86400000 });

    const first = epg.fetchEpgData();
    await tick();
    start = 2000;
    assert.equal(await epg.fetchEpgData(), true);
    assert.equal(epg.window.start, 2000);

    slow.resolve({ channels: [{ id: 'a', sourceId: 1, name: 'A' }], nextCursor: null });
    assert.equal(await first, false, 'the superseded load says so');
    assert.equal(epg.window.start, 2000);
    assert.deepEqual([...epg.rows.map(r => r.id)], ['b']);
    assert.deepEqual(requested, [1000, 2000]);
});

test('F1: a refresh for the window already loading shares that request', async () => {
    const c = load(['components/EpgGuide.js']);
    const gate = deferred();
    let calls = 0;
    c.API = { library: { categories: async () => [], favourites: async () => [],
        guide: () => { calls++; return gate.promise; } } };
    const epg = Object.create(c.window.EpgGuide.prototype);
    epg.renderWindow = () => ({ start: 5000, end: 5000 + 86400000 });

    const a = epg.fetchEpgData();
    const b = epg.fetchEpgData();
    gate.resolve({ channels: [], nextCursor: null });
    assert.deepEqual([await a, await b], [true, true]);
    assert.equal(calls, 1);
});

test('F1: a failed load keeps the guide that was already showing', async () => {
    const c = load(['components/EpgGuide.js']);
    let fail = false;
    c.API = { library: { categories: async () => [], favourites: async () => [],
        guide: async () => { if (fail) throw new Error('offline'); return { channels: [{ id: 'kept', sourceId: 1, name: 'K' }], nextCursor: null }; } } };
    const epg = Object.create(c.window.EpgGuide.prototype);
    let start = 1000;
    epg.renderWindow = () => ({ start, end: start + 86400000 });
    await epg.fetchEpgData();
    fail = true; start = 2000;
    await assert.rejects(epg.fetchEpgData(), /offline/);
    assert.equal(epg.window.start, 1000);
    assert.deepEqual([...epg.rows.map(r => r.id)], ['kept']);
});

test('F2: Home -> elsewhere -> Home while favourites load: the Home on screen settles', async () => {
    const lists = { current: null };
    const c = load(['pages/HomePage.js'], {
        document: { addEventListener() {}, querySelectorAll: () => [], getElementById: (id) => (id === 'favorite-channels-list' ? lists.current : null) }
    });
    const pending = deferred();
    let requests = 0;
    c.window.API = { library: { favourites: () => { requests++; return pending.promise; } } };
    const home = new c.window.HomePage({});
    home.updateScrollArrows = () => {};

    const old = { innerHTML: 'loading', querySelectorAll: () => [] };
    const fresh = { innerHTML: 'loading', querySelectorAll: () => [] };
    lists.current = old;
    const first = home.loadDashboardData();
    lists.current = fresh; // show() replaced the page
    const second = home.loadDashboardData();
    pending.resolve([]);
    await Promise.all([first, second]);

    assert.equal(requests, 1, 'one request, shared');
    assert.match(fresh.innerHTML, /Add channels to your favourites/);
    assert.equal(old.innerHTML, 'loading', 'nothing written into the detached list');
});

test('F2: a failed favourites load offers Retry, and Retry loads again', async () => {
    let listener;
    const retry = { addEventListener: (_, fn) => { listener = fn; } };
    const list = { innerHTML: '', querySelectorAll: () => [], querySelector: (sel) => (sel === '.home-retry' ? retry : null) };
    const c = load(['pages/HomePage.js'], {
        document: { addEventListener() {}, querySelectorAll: () => [], getElementById: (id) => (id === 'favorite-channels-list' ? list : null) }
    });
    let fail = true;
    c.window.API = { library: { favourites: async () => { if (fail) throw new Error('down'); return []; } } };
    const home = new c.window.HomePage({});
    home.updateScrollArrows = () => {};

    await home.loadDashboardData();
    assert.match(list.innerHTML, /Error loading favourites/);
    assert.match(list.innerHTML, /Retry/);
    fail = false;
    listener();
    await tick(); await tick();
    assert.match(list.innerHTML, /Add channels to your favourites/);
});

test('F3: Back/Forward (popstate) changes page without writing history; clicks push; start-up replaces', () => {
    const calls = [];
    const c = load(['app.js'], {
        history: { pushState: (s) => calls.push(['push', s.page]), replaceState: (s) => calls.push(['replace', s.page]) }
    });
    const app = vm.runInContext('Object.create(App.prototype)', c);
    Object.assign(app, { currentPage: 'home', currentUser: { role: 'admin' }, pages: {} });

    app.navigateTo('guide');
    app.navigateTo('settings');
    app.navigateTo('guide', 'none'); // Back
    app.navigateTo('home', 'none');  // Back
    app.navigateTo('guide', 'none'); // Forward
    app.navigateTo('home', 'replace');
    assert.deepEqual(calls, [['push', 'guide'], ['push', 'settings'], ['replace', 'home']]);
    assert.equal(app.currentPage, 'home');

    // A non-admin sent to Settings is redirected by replacing, never by adding an entry.
    calls.length = 0;
    Object.assign(app, { currentPage: 'guide', currentUser: { role: 'viewer' } });
    app.navigateTo('settings', 'none');
    assert.deepEqual(calls, [['replace', 'home']]);
});

// F4: the main viewing actions are reachable and usable from the keyboard.
test('F4: live rows, group headers, guide names and programmes, and Home tiles are keyboard buttons', () => {
    const c = load(['components/ChannelList.js', 'components/EpgGuide.js', 'pages/HomePage.js'], {
        Icons: { favorite: '*', favoriteOutline: 'o', chevronDown: 'v' }
    });
    const tag = (html, cls) => (html.match(new RegExp(`<[a-z]+ class="${cls}[^"]*"[^>]*>`, 's')) || [''])[0];
    const isButton = (t) => /role="button"/.test(t) && /tabindex="0"/.test(t) && /data-key-activate/.test(t);

    const list = Object.create(c.window.ChannelList.prototype);
    Object.assign(list, { favoriteKeys: new Set(['1:s1']), getProgramInfo: () => '' });
    const item = list.channelItemHtml({ id: 'pos_1', sourceId: 1, stableId: 's1', name: 'One', number: 1 });
    assert.ok(isButton(tag(item, 'channel-info')), 'the row plays from the keyboard');
    assert.match(tag(item, 'channel-info'), /aria-label="Play One"/);
    assert.match(item, /class="favorite-btn active"[^>]*aria-pressed="true"/s, 'favourite state is announced');
    assert.ok(!/<div class="channel-item[^>]*role="button"/s.test(item), 'no button wrapped around the favourite button');

    const guide = Object.create(c.window.EpgGuide.prototype);
    Object.assign(guide, { pixelsPerMinute: 2 });
    const now = Date.now();
    const cells = guide.renderProgrammes([{ title: 'News', description: '', start: new Date(now).toISOString(), stop: new Date(now + 3600000).toISOString(), startMs: now, stopMs: now + 3600000 }],
        new Date(now - 60000), new Date(now + 7200000), { id: 'pos_1', sourceId: 1, name: 'One' });
    assert.ok(isButton(tag(cells, 'epg-program current')), 'a programme opens its details from the keyboard');
    assert.match(cells, /aria-label="News, [^"]+: details"/);

    const home = Object.create(c.window.HomePage.prototype);
    const tile = home.createChannelTile({ id: 'pos_1', sourceId: 1, name: 'One' });
    assert.ok(isButton(tag(tile, 'channel-tile')));
});

test('F4: Enter and Space click a keyboard button; other keys and other targets are left alone', () => {
    const c = load(['app.js'], { history: { pushState() {}, replaceState() {} } });
    const app = vm.runInContext('Object.create(App.prototype)', c);
    let clicks = 0, prevented = 0;
    const el = { hasAttribute: (a) => a === 'data-key-activate', click: () => clicks++ };
    const press = (key, target = el) => app.activateFromKeyboard({ key, target, preventDefault: () => prevented++ });
    assert.equal(press('Enter'), true);
    assert.equal(press(' '), true);
    assert.equal(press('a'), false);
    assert.equal(press('Enter', { hasAttribute: () => false, click: () => clicks++ }), false);
    assert.deepEqual([clicks, prevented], [2, 2]);
});

// F7: guide data is refreshed only while it is on screen, and only downloaded again when it changed.
function guideWithServer({ page = 'guide', visibility = 'visible', version = 'v1' } = {}) {
    const calls = [];
    const c = load(['components/EpgGuide.js'], {
        document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], getElementById: () => null, visibilityState: visibility }
    });
    const server = { version };
    c.API = { library: {
        categories: async () => [], favourites: async () => [],
        guideVersion: async () => { calls.push('version'); return { version: server.version }; },
        guide: async () => { calls.push('guide'); return { channels: [], nextCursor: null }; }
    } };
    c.window.app = { currentPage: page };
    const epg = Object.create(c.window.EpgGuide.prototype);
    epg.renderWindow = () => ({ start: 1000, end: 1000 + 86400000 });
    epg.render = () => calls.push('render');
    return { epg, calls, server, c };
}

test('F7: an unchanged guide is not downloaded again; a changed one is, and the Guide redraws', async () => {
    const { epg, calls, server, c } = guideWithServer();
    await epg.refreshIfChanged({ force: true });
    assert.deepEqual(calls, ['version', 'guide']);

    calls.length = 0;
    assert.equal(await epg.refreshTick({ now: Date.now() + c.window.EpgGuide.REFRESH_MS }), false);
    assert.deepEqual(calls, ['version'], 'only the cheap version check');

    calls.length = 0;
    server.version = 'v2';
    assert.equal(await epg.refreshTick({ now: Date.now() + 2 * c.window.EpgGuide.REFRESH_MS }), true);
    assert.deepEqual(calls, ['version', 'guide', 'render']);
});

test('F7: nothing runs while another page is showing or the browser tab is hidden', async () => {
    for (const setup of [{ page: 'home' }, { page: 'settings' }, { page: 'guide', visibility: 'hidden' }]) {
        const { epg, calls, c } = guideWithServer(setup);
        epg.loaded = true;
        assert.equal(await epg.refreshTick({ now: Date.now() + c.window.EpgGuide.REFRESH_MS }), false);
        assert.deepEqual(calls, [], JSON.stringify(setup));
    }
});

test('F7: start-up does not download the whole guide; Live TV and the Guide load it when shown', () => {
    const app = js('app.js'), live = js('pages/LivePage.js');
    const init = app.slice(app.indexOf('async init()'), app.indexOf('navigateTo(initialPage'));
    assert.ok(!/epgGuide\.(loadEpg|fetchEpgData|ensureLoaded)\(/.test(init), 'no guide download in App.init');
    assert.match(live.slice(live.indexOf('async show()')), /epgGuide\.ensureLoaded\(\)/);
    const guide = js('components/EpgGuide.js');
    assert.equal((guide.match(/setInterval\(\(\) => this\.updateNowIndicator\(\)/g) || []).length, 1, 'one minute timer');
});

// F8: one meaning for a favourite on every client: the accent, never the error red; Australian-English copy.
test('F8: an active favourite uses the accent text colour, and the visible copy says favourites and programme', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/css/main.css'), 'utf8');
    const colours = [...css.matchAll(/([^{}]*\.favorite-btn(?::hover|\.active)[^{}]*)\{([^}]*)\}/g)]
        .map(m => (m[2].match(/(?:^|;|\s)color:\s*([^;]+);/) || [])[1]).filter(Boolean);
    assert.ok(colours.length >= 1);
    for (const c of colours) assert.equal(c.trim(), 'var(--color-accent-text)');

    const shown = ['pages/HomePage.js', 'components/EpgGuide.js', 'components/ChannelList.js', 'pages/RecordingsPage.js']
        .map(js).join('\n');
    for (const us of ["'Add to Favorites'", "'Remove from Favorites'", 'Favorite Channels', 'Loading favorites', '>Favorites</option>', "'Program Details'", 'Click a program '])
        assert.ok(!shown.includes(us), `still shows ${us}`);
});
