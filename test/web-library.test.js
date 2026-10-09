const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0121 (W2.1): the web app reads /api/library - the API the Apple client uses -
// instead of the Xtream-emulation routes (/api/proxy/xtream/...) and the whole-EPG
// dump (/api/proxy/epg/:id). These run the real browser scripts (with the real
// api.js) against a recorded fetch, so what is checked is the requests the page
// actually makes. On the old code every one of them asked /api/proxy/... instead.

// Values made inside the vm are from another realm; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

const CATEGORIES = [
    { id: 'Sport', sourceId: 1, name: 'Sport', channelCount: 1 },
    { id: 'News', sourceId: 1, name: 'News', channelCount: 2 }
];
const row = (n, id, name, category, extra = {}) => ({
    id, sourceId: 1, name, logo: `/api/logo/${'a'.repeat(31)}${n}`, category, tvgId: `${name}.tv`,
    order: n, stableId: `s${n}`, number: n, now: null, next: null, favourite: false, ...extra
});
// 250 channels, so the list takes two pages of 200.
const CHANNELS = Array.from({ length: 250 }, (_, i) =>
    row(i + 1, `pos_${i + 1}`, `Channel ${i + 1}`, i === 0 ? 'Sport' : 'News'));

function browser(files, routes, extra = {}) {
    const requests = [];
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
        Icons: { favorite: '*', favoriteOutline: 'o', chevronDown: 'v' },
        CSS: { escape: (s) => s },
        fetch: async (url, opts = {}) => {
            requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
            const pathOnly = url.split('?')[0];
            const handler = routes[`${opts.method || 'GET'} ${pathOnly}`];
            const body = handler ? handler(url) : { error: 'No such API endpoint' };
            return {
                ok: !!handler, status: handler ? 200 : 404,
                headers: { get: () => 'application/json' },
                json: async () => body, text: async () => JSON.stringify(body)
            };
        },
        ...extra
    });
    context.window = context;
    for (const f of files) vm.runInContext(js(f), context);
    return { context, requests };
}

const libraryRoutes = {
    'GET /api/library/categories': () => CATEGORIES,
    'GET /api/library/channels': (url) => {
        const q = new URL(url, 'http://x').searchParams;
        const limit = Number(q.get('limit')), offset = Number(q.get('offset'));
        return { total: CHANNELS.length, limit, offset, channels: CHANNELS.slice(offset, offset + limit) };
    },
    'GET /api/library/favourites': () => [CHANNELS[2]],
    'POST /api/favorites': () => ({ success: true }),
    'DELETE /api/favorites': () => ({ success: true })
};

function channelList(routes = libraryRoutes, extra = {}) {
    const env = browser(['api.js', 'components/ChannelList.js'], routes, extra);
    const list = Object.create(env.context.ChannelList.prototype);
    Object.assign(list, {
        container: { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
        sourceSelect: { value: '' }, searchInput: { value: '' },
        sources: [{ id: 1, type: 'm3u', name: 'Household', enabled: true }],
        channels: [], categories: [], favoriteKeys: new Set(), favoriteRows: [], renderedChannels: [],
        collapsedGroups: new Set(), _userExpandedGroups: new Set(), isLoading: false,
        render() { this.rendered = (this.rendered || 0) + 1; }
    });
    return { list, ...env };
}

const proxied = (requests) => requests.filter(r => r.url.includes('/proxy/')).map(r => r.url);

test('the live sidebar loads categories, every page of channels and the favourites from /api/library', async () => {
    const { list, requests } = channelList();
    await list.loadChannels();

    const urls = requests.map(r => r.url);
    assert.deepEqual(proxied(requests), [], 'nothing through the Xtream-emulation routes');
    assert.ok(urls.includes('/api/library/categories'));
    assert.ok(urls.includes('/api/library/channels?limit=200&offset=0'));
    assert.ok(urls.includes('/api/library/channels?limit=200&offset=200'), 'the second page too');
    assert.ok(urls.includes('/api/library/favourites'));

    assert.equal(list.channels.length, 250);
    const first = list.channels[0];
    assert.equal(first.id, 'pos_1', 'the bare library id, not m3u_1_pos_1');
    assert.equal(first.number, 1, 'with its channel number');
    assert.equal(first.tvgLogo, CHANNELS[0].logo, 'and the /api/logo/ path from the row');
    assert.equal(first.groupTitle, 'Sport', 'the category name from /api/library/categories');
    assert.equal(first.url, undefined, 'the web never holds a stream URL');
    assert.equal(list.rendered, 1);
});

test('favourites come from /api/library/favourites, one per channel identity', async () => {
    const { list } = channelList();
    await list.loadChannels();
    assert.ok(list.favoriteKeys.has('1:s3'), 'keyed on the channel identity');
    assert.equal(list.isFavorite(1, 'pos_3'), true);
    assert.equal(list.isFavorite(1, 'pos_4'), false);
    const favs = list.getFavoriteChannels();
    assert.deepEqual(plain(favs.map(c => c.id)), ['pos_3']);
});

test('a star is saved with the bare id through POST and DELETE /api/favorites', async () => {
    const { list, requests } = channelList();
    await list.loadChannels();
    requests.length = 0;

    await list.toggleFavorite(1, 'pos_5');
    await list.toggleFavorite(1, 'pos_3');

    const writes = requests.filter(r => r.url === '/api/favorites');
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
        { url: '/api/favorites', method: 'POST', body: { sourceId: 1, itemId: 'pos_5', itemType: 'channel' } },
        { url: '/api/favorites', method: 'DELETE', body: { sourceId: 1, itemId: 'pos_3', itemType: 'channel' } }
    ]);
    assert.equal(list.isFavorite(1, 'pos_5'), true);
    assert.equal(list.isFavorite(1, 'pos_3'), false);
});

test('playing a channel hands the player the library channel (bare id) and asks nothing else', async () => {
    const played = [];
    const { list, requests, context } = channelList();
    await list.loadChannels();
    requests.length = 0;
    context.app = { player: { play: (channel, url) => played.push({ id: channel.id, sourceId: channel.sourceId, url }) } };

    await list.selectChannel({ channelId: 'pos_7', sourceId: '1' });

    assert.deepEqual(JSON.parse(JSON.stringify(played)), [{ id: 'pos_7', sourceId: 1, url: null }],
        'resolve identifies the channel by source + bare id; there is no stream URL to look up');
    assert.deepEqual(requests.map(r => r.url), [], 'no /proxy/xtream/.../stream lookup');
});

test('the guide pages /api/library/guide 500 rows at a time over the window on screen', async () => {
    const pages = {
        first: { channels: [{ ...row(1, 'pos_1', 'One', 'News'), programmes: [
            { title: 'Now show', description: 'd', startTime: Date.now() - 60000, endTime: Date.now() + 60000 }] }], nextCursor: 'CUR1' },
        second: { channels: [{ ...row(2, 'pos_2', 'Two', 'Sport'), programmes: [] }], nextCursor: null }
    };
    const { context, requests } = browser(['api.js', 'components/EpgGuide.js'], {
        'GET /api/library/categories': () => CATEGORIES,
        'GET /api/library/favourites': () => [row(2, 'pos_2', 'Two', 'Sport')],
        'GET /api/library/guide': (url) => (url.includes('cursor=') ? pages.second : pages.first)
    });
    const guide = Object.create(context.EpgGuide.prototype);
    Object.assign(guide, { timeOffset: 0, rows: [], favorites: new Set() });

    await guide.fetchEpgData();

    assert.deepEqual(proxied(requests), [], 'not the whole-EPG /api/proxy/epg/:id');
    const guideCalls = requests.filter(r => r.url.startsWith('/api/library/guide')).map(r => new URL(r.url, 'http://x').searchParams);
    assert.equal(guideCalls.length, 2, 'follows nextCursor until it runs out');
    assert.equal(guideCalls[0].get('limit'), '500');
    assert.equal(guideCalls[1].get('cursor'), 'CUR1');
    const start = Number(guideCalls[0].get('start')), end = Number(guideCalls[0].get('end'));
    assert.ok(Math.abs(start - Date.now()) <= 60 * 60 * 1000, 'a window starting at the current hour');
    assert.equal(end - start, 24 * 60 * 60 * 1000, 'and 24 hours long (the route caps it there)');

    assert.deepEqual(plain(guide.rows.map(r => [r.id, r.number, r.groupTitle])), [['pos_1', 1, 'News'], ['pos_2', 2, 'Sport']]);
    assert.equal(guide.getCurrentProgramFor({ sourceId: 1, id: 'pos_1' }).title, 'Now show');
    assert.equal(guide.getCurrentProgram('One.tv', 'One').title, 'Now show', 'the old lookup by tvg-id still works');
    assert.ok(guide.favorites.has('1:s2'));
});

test('the Home favourites row draws /api/library/favourites rows with their numbers and logos', async () => {
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const { context, requests } = browser(['api.js', 'pages/HomePage.js'], {
        'GET /api/library/favourites': () => [row(12, 'pos_12', 'Twelve', 'News'), row(3, 'pos_3', 'Three <b>', 'News')]
    }, { document: { getElementById: (id) => (id === 'favorite-channels-list' ? list : id === 'favorite-channels-section' ? {} : null) } });
    const home = Object.create(context.HomePage.prototype);
    Object.assign(home, { app: {}, container: null });

    await home.renderFavoriteChannels();

    assert.deepEqual(requests.map(r => r.url), ['/api/library/favourites']);
    assert.ok(list.innerHTML.indexOf('data-channel-id="pos_3"') < list.innerHTML.indexOf('data-channel-id="pos_12"'), 'in number order');
    assert.match(list.innerHTML, /<span class="tile-number pig-amount">12<\/span>/);
    assert.ok(list.innerHTML.includes(`src="${CHANNELS[11].logo}"`), 'the /api/logo/ path, not /api/proxy/image');
    assert.ok(list.innerHTML.includes('Three &lt;b&gt;'), 'names are escaped');
});

test('the Sources picker reads GET /api/sources/:id/catalogue, hidden items included', async () => {
    const { context, requests } = browser(['api.js', 'components/SourceManager.js'], {
        'GET /api/sources/7/catalogue': () => ({
            categories: [{ id: 'News', name: 'News', hidden: false, channelCount: 2 }, { id: 'Sport', name: 'Sport', hidden: true, channelCount: 1 }],
            channels: [
                { id: 'pos_1', name: 'BBC', categoryId: 'News', hidden: false, number: 4 },
                { id: 'pos_2', name: 'Hidden', categoryId: 'News', hidden: true, number: null },
                { id: 'pos_3', name: 'Sky', categoryId: 'Sport', hidden: false, number: 9 }
            ]
        })
    });
    const manager = Object.create(context.SourceManager.prototype);
    Object.assign(manager, { contentTree: { innerHTML: '' }, expandedGroups: new Set(), searchQuery: '', renderTree() { this.rendered = true; } });

    await manager.loadContentTree(7);

    assert.deepEqual(requests.map(r => r.url), ['/api/sources/7/catalogue?type=live']);
    assert.deepEqual(plain(manager.treeData.groups.map(g => [g.name, g.categoryId, g.items.map(i => i.id)])),
        [['News', 'News', ['pos_1', 'pos_2']], ['Sport', 'Sport', ['pos_3']]]);
    assert.deepEqual(plain([...manager.hiddenSet].sort()), ['channel:pos_2', 'group:Sport']);
    assert.deepEqual(plain([...manager.originalHiddenSet].sort()), ['channel:pos_2', 'group:Sport']);
    assert.equal(manager.rendered, true);
    assert.equal(manager.loadMovieCategoriesTree, undefined, 'the movie/series tabs are gone');
});

test('the player recovers a channel by its identity; it no longer needs a stream URL to replay', () => {
    const { context } = browser(['components/VideoPlayer.js'], {});
    const replays = [];
    const player = Object.create(context.VideoPlayer.prototype);
    Object.assign(player, {
        currentChannel: { sourceId: 1, id: 'pos_7' }, currentStreamUrl: null, _recoveredKey: null, _audioEncodeActive: false,
        play: (channel, url, opts) => replays.push({ id: channel.id, url, retry: opts.isRetry })
    });
    assert.equal(player.recoverPlayback('test'), true, 'one fresh resolve');
    assert.equal(player.recoverPlayback('test'), false, 'and only one');
    assert.deepEqual(JSON.parse(JSON.stringify(replays)), [{ id: 'pos_7', url: null, retry: true }]);
});

test('no live-TV script still calls the Xtream-emulation or whole-EPG proxy routes', () => {
    for (const file of ['components/ChannelList.js', 'components/EpgGuide.js', 'components/SourceManager.js',
        'components/VideoPlayer.js', 'pages/LivePage.js', 'pages/Guide.js']) {
        const src = js(file);
        for (const needle of ['/proxy/xtream', '/proxy/epg', 'API.proxy', '/proxy/cache', '/proxy/image']) {
            assert.ok(!src.includes(needle), `${file} still references ${needle}`);
        }
    }
});
