const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #276 (option C, 11 Nov 2026): the web app has no Home page. It opens on Live TV, where the favourites are the first
// group of the channel list; an old #home link lands on Live TV.

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/index.html');
const css = read('public/css/main.css');

function appContext(extra = {}) {
    const c = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} }, window: {}, setTimeout, clearTimeout,
        document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null }, ...extra
    });
    loadUi(c);
    vm.runInContext(read('public/js/app.js'), c);
    return c;
}

test('navigation has six items, no Home, and Live TV is the one marked current', () => {
    const links = [...html.matchAll(/<a [^>]*class="nav-link[^"]*"[^>]*>/g)].map(m => m[0]);
    assert.deepEqual(links.map(l => /data-page="([^"]+)"/.exec(l)[1]), ['live', 'guide', 'sports', 'recordings', 'status', 'settings']);
    assert.match(links[0], /class="nav-link active"/);
    assert.match(links[0], /aria-current="page"/);
    assert.equal(links.filter(l => l.includes('aria-current="page"')).length, 1);
});

test('the Home page, its script and its styles are gone', () => {
    assert.ok(!html.includes('id="page-home"'));
    assert.ok(!html.includes('HomePage.js'));
    assert.ok(!fs.existsSync(path.join(__dirname, '../public/js/pages/HomePage.js')));
    assert.doesNotMatch(read('public/js/app.js'), /HomePage|pages\.home/);
    for (const sel of ['#page-home', '.dashboard-content', '.dashboard-section', '.scroll-arrow', '.scroll-wrapper', '.horizontal-scroll', '.channel-tile', '.tile-logo', '.tile-name'])
        assert.ok(!css.includes(sel), `${sel} is still in main.css`);
});

test('the default route, an unknown hash and an old #home all open Live TV', () => {
    const c = appContext();
    const app = vm.runInContext('Object.create(App.prototype)', c);
    app.pages = { live: {}, guide: {}, sports: {}, recordings: {}, settings: {}, status: {} };
    assert.equal(app.initialPage(''), 'live');
    assert.equal(app.initialPage('home'), 'live');
    assert.equal(app.initialPage('nonsense'), 'live');
    assert.equal(app.initialPage('guide'), 'guide');
    assert.equal(app.initialPage('constructor'), 'live', 'a prototype name is not a page');
    assert.match(read('public/js/app.js'), /this\.currentPage = 'live'/);
});

test('the start-up route replaces the entry, so Back from Live TV does not loop through #home', () => {
    const calls = [];
    const c = appContext({ history: { pushState: (s) => calls.push(['push', s.page]), replaceState: (s, _, u) => calls.push(['replace', s.page, u]) } });
    const app = vm.runInContext('Object.create(App.prototype)', c);
    Object.assign(app, { currentPage: 'live', currentUser: { role: 'admin' }, pages: {} });
    app.navigateTo(app.initialPage('home'), 'replace');
    assert.deepEqual(calls, [['replace', 'live', '#live']]);
    // A viewer sent away from Settings lands on Live TV.
    calls.length = 0;
    Object.assign(app, { currentPage: 'guide', currentUser: { role: 'viewer' } });
    app.navigateTo('settings', 'none');
    assert.deepEqual(calls, [['replace', 'live', '#live']]);
});

test('the brand splash is an app-level element, not inside a page, and says Loading PigTV…', () => {
    const splash = html.match(/<div id="app-splash"[^>]*class="[^"]*pig-splash[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(splash, '#app-splash with .pig-splash');
    assert.match(splash[0], /Loading PigTV…/);
    assert.ok(!html.includes('Loading Dashboard'));
    const at = html.lastIndexOf('<div', html.indexOf('id="app-splash"'));
    const lastPage = html.lastIndexOf('<div id="page-', at);
    const between = html.slice(lastPage, at);
    assert.ok((between.match(/<div/g) || []).length <= (between.match(/<\/div>/g) || []).length, 'not nested inside a #page-*');
});

test('the splash is removed once the first page is shown, never on a timer', () => {
    let removed = 0;
    const c = appContext({ document: { addEventListener() {}, querySelectorAll: () => [], getElementById: (id) => (id === 'app-splash' ? { remove: () => removed++ } : null) } });
    const app = vm.runInContext('Object.create(App.prototype)', c);
    app.hideSplash();
    assert.equal(removed, 1);
    app.hideSplash(); // a second call (no element left) is harmless
    const src = read('public/js/app.js');
    assert.match(src.slice(src.indexOf('navigateTo(initialPage')), /hideSplash\(\)/);
    assert.doesNotMatch(src.slice(src.indexOf('hideSplash()'), src.indexOf('hideSplash()') + 300), /setTimeout/);
});

test('with no favourites the list shows one hint and no Favourites group; the hint goes with the first favourite', () => {
    const c = vm.createContext({ console, window: {}, document: { addEventListener() {}, getElementById: () => null }, Icons: { favoriteOutline: '<svg></svg>', favorite: '<svg></svg>', chevronDown: 'v' } });
    loadUi(c);
    vm.runInContext(read('public/js/components/ChannelList.js'), c);
    const list = Object.create(c.window.ChannelList.prototype);
    Object.assign(list, { channels: [{ id: 'pos_1', sourceId: 1, name: 'One' }], favoriteRows: [] });
    const hint = list.favouritesHintHtml();
    assert.match(hint, /class="state-block state-empty"/);
    assert.match(hint, /Open a group and select the heart beside a channel\. It is added to Favourites at the top of this list\./);
    list.favoriteRows = [{ sourceId: 1, id: 'pos_1' }];
    assert.equal(list.favouritesHintHtml(), '');
    // render() draws it above the groups, and only when nothing is being searched
    const src = read('public/js/components/ChannelList.js');
    assert.match(src, /listContainer\.innerHTML = searchTerm \? '' : this\.favouritesHintHtml\(\)/);
    // the last favourite removed redraws, so the hint comes back
    assert.match(src.slice(src.indexOf('updateFavoritesGroup(')), /favArray\.length === 0\)\s*\{\s*(\/\/[^\n]*\s*)?this\.render\(\)/);
});

test('the Favourites group title is the normal text colour, not the error colour', () => {
    const rule = css.match(/\.group-header\.favorites-group \.group-name\s*\{([^}]*)\}/);
    assert.ok(rule);
    assert.doesNotMatch(rule[1], /color-error/);
    assert.match(rule[1], /color:\s*var\(--color-text-primary\)/);
    const header = (css.match(/\.group-header\.favorites-group\s*\{([^}]*)\}/) || [, ''])[1];
    assert.doesNotMatch(header, /color-error/, 'no error-red edge or wash either');
});

test('the guide already has a Favourites filter (its group menu), shown only when favourites exist', () => {
    const src = read('public/js/components/EpgGuide.js');
    assert.match(src, /hasFavorites/);
    assert.match(src, /value="Favorites"[^>]*>Favourites<\/option>/);
});
