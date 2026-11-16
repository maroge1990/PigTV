const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #57 (D-66): Search from the magnifier in the top bar of every page: one window, the query left and the results right
// (stacked when narrow), grouped Teams, Games, Programmes (LIVE / NEW, the episode), Channels, Recordings, with Follow,
// Watch, Record and Play; recent searches (8, this browser) before typing and "Nothing found for …" after.
const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const H = 3600000;

function browser({ store = {}, storageThrows = false } = {}) {
    const document = createDocument();
    const calls = [];
    const answers = [];
    const API = {
        library: { search: (q) => { calls.push(['search', q]); return new Promise((resolve) => answers.push({ q, resolve })); } },
        request: async (method, route, body) => {
            calls.push([method, route, body]);
            if (route === '/sports/catalog') return { sports: [{ sport: 'Basketball', leagues: [{ league: 'NBA' }, { league: 'NBL' }] }] };
            if (route === '/sports/follows' && method === 'GET') return { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] };
            return {};
        }
    };
    const localStorage = {
        getItem: (k) => { if (storageThrows) throw new Error('blocked'); return k in store ? store[k] : null; },
        setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, setInterval: () => 7, clearInterval() {}, API, localStorage, Date, Promise
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(read('js/components/SearchPanel.js'), context);
    const played = [], menus = [], recordings = [];
    const app = {
        epgGuide: {
            playChannel: async (...a) => { played.push(a); },
            loadSchedules: async () => true,
            showProgramDetails: async (data) => { menus.push(data); }
        },
        pages: { recordings: { play: async (...a) => { recordings.push(a); } } }
    };
    const panel = new context.SearchPanel(app);
    return { context, document, panel, calls, answers, played, menus, recordings, store };
}

const NOW = Date.now();
const channel = { id: '11', sourceId: 1, name: 'BBC <One>', logo: '/api/logo/abc', number: 1, quality: 'HD', tvgId: 'bbc1', stableId: 's11' };
const ANSWER = {
    q: 'who',
    channels: [channel],
    programmes: [
        { channel, title: 'Doctor Who', subtitle: 'The <Star> Beast', episode: 'S2 E5', start: NOW - 600000, end: NOW + 1200000, live: true, new: true, image: '/api/logo/img' },
        { channel, title: 'Who Do You Think', start: NOW + 2 * H, end: NOW + 3 * H, new: false }
    ],
    events: [{ id: 'e1', kind: 'event', title: 'Who v What', league: 'NBA', start: NOW + H, end: NOW + 3 * H, live: false, aliases: [],
        channels: [{ ...channel, start: NOW + H, end: NOW + 3 * H }] }],
    teams: [{ id: '13', name: 'Whoville Wolves', league: 'NBA', followed: false }, { id: '14', name: 'Who Hawks', league: 'NBA', followed: true, logo: '/api/logo/t' }],
    recordings: [{ id: 7, title: 'Doctor Who', status: 'completed', started_at: NOW - 30 * H, channel_name: 'BBC One', image: null, watch_live: false },
        { id: 8, title: 'Doctor Who', status: 'recording', started_at: NOW - 600000, channel_name: 'BBC One', image: null, watch_live: true }]
};

test('the groups in order (Teams, Games, Programmes, Channels, Recordings), badges, episode, escaped', () => {
    const { panel } = browser();
    panel.query = 'who';
    panel.answer = ANSWER;
    const html = panel.resultsHtml();
    const order = ['Teams', 'Games', 'Programmes', 'Channels', 'Recordings'].map((t) => html.indexOf(`<h3 class="search-group-title">${t}</h3>`));
    assert.ok(order.every((i) => i >= 0), 'every group');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
    assert.match(html, /search-badge-live">LIVE<\/span> <span class="search-badge search-badge-new">NEW<\/span> Doctor Who/);
    assert.equal((html.match(/search-badge-new/g) || []).length, 1, 'new: false is no badge');
    assert.match(html, /S2 E5 · The &lt;Star&gt; Beast/);
    assert.match(html, /BBC &lt;One&gt;/);
    assert.doesNotMatch(html, /<Star>|BBC <One>/);
    // actions: Watch only for what is on now; Record for programmes and games; Follow unless followed; Play
    assert.match(html, /data-action="watch" data-kind="programme" data-index="0"/);
    assert.doesNotMatch(html, /data-action="watch" data-kind="programme" data-index="1"/);
    assert.doesNotMatch(html, /data-action="watch" data-kind="event"/, 'a game later: no Watch');
    assert.match(html, /data-action="record" data-kind="event" data-index="0"/);
    assert.match(html, /data-action="follow" data-kind="team" data-index="0"/);
    assert.doesNotMatch(html, /data-action="follow" data-kind="team" data-index="1"/);
    assert.match(html, /Following/);
    assert.match(html, /data-action="watch" data-kind="channel" data-index="0"/);
    assert.match(html, /data-action="play" data-kind="recording" data-index="1"/);
    assert.match(html, /search-badge-rec">REC/);
});

test('empty states: a hint before typing, recent searches beside it, and "Nothing found for …"', () => {
    const { panel } = browser({ store: { pigtvRecentSearches: JSON.stringify(['doctor', 'lakers']) } });
    panel.query = '';
    assert.match(panel.resultsHtml(), /Search for a team, a game, a programme, a channel or a recording\./);
    const recent = panel.recentHtml(panel.constructor.recent());
    assert.match(recent, /Recent searches/);
    assert.match(recent, /data-recent="0">doctor</);
    assert.match(recent, /data-recent="1">lakers</);
    assert.equal(panel.recentHtml([]), '', 'none kept: no list');
    panel.query = 'zzz <b>';
    panel.answer = { q: 'zzz', channels: [], programmes: [], events: [], teams: [], recordings: [] };
    assert.match(panel.resultsHtml(), /Nothing found for “zzz &lt;b&gt;”/);
    panel.answer = null;
    panel.error = 'Search did not answer. Try again.';
    assert.match(panel.resultsHtml(), /state-error/);
});

test('recent searches: newest first, no repeats (case aside), at most 8, and a blocked store is no failure', () => {
    const { context, store } = browser();
    const S = context.SearchPanel;
    for (let i = 1; i <= 10; i++) S.remember(`query ${i}`);
    S.remember('QUERY 9');
    S.remember('x');
    const list = JSON.parse(store.pigtvRecentSearches);
    assert.deepEqual(list, ['QUERY 9', 'query 10', 'query 8', 'query 7', 'query 6', 'query 5', 'query 4', 'query 3']);
    const blocked = browser({ storageThrows: true }).context.SearchPanel;
    assert.equal(blocked.recent().length, 0);
    assert.doesNotThrow(() => blocked.remember('doctor'));
});

test('an answer to an older query is dropped; one character asks nothing', async () => {
    const { panel, calls, answers } = browser();
    const first = panel.run('doc');
    const second = panel.run('doctor');
    answers[1].resolve({ ...ANSWER, q: 'doctor' });
    await second;
    answers[0].resolve({ ...ANSWER, q: 'doc' });
    await first;
    assert.equal(panel.answer.q, 'doctor');
    await panel.run('d');
    assert.equal(calls.filter((c) => c[0] === 'search').length, 2);
    assert.equal(panel.answer, null);
});

test('Watch plays the channel; Record opens the guide\'s programme menu for that airing; Play opens the recording', async () => {
    const { panel, played, menus, recordings, store } = browser();
    panel.query = 'who';
    panel.answer = ANSWER;
    await panel.act('watch', 'programme', 0);
    assert.deepEqual(played[0], ['BBC <One>', '11', 1]);
    await panel.act('watch', 'channel', 0);
    assert.equal(played.length, 2);
    await panel.act('record', 'programme', 1);
    assert.equal(menus[0].title, 'Who Do You Think');
    assert.equal(menus[0].start, new Date(NOW + 2 * H).toISOString());
    assert.equal(menus[0].stop, new Date(NOW + 3 * H).toISOString());
    assert.equal(menus[0].recordable, 'true');
    assert.deepEqual([menus[0].sourceId, menus[0].channelId, menus[0].channelName], ['1', '11', 'BBC <One>']);
    await panel.act('record', 'event', 0);
    assert.equal(menus[1].title, 'Who v What');
    assert.equal(menus[1].start, new Date(NOW + H).toISOString(), 'the channel\'s own airing');
    await panel.act('play', 'recording', 0);
    await panel.act('play', 'recording', 1);
    assert.deepEqual(recordings.map((r) => [r[0], r[1].watch]), [[7, false], [8, true]]);
    assert.deepEqual(JSON.parse(store.pigtvRecentSearches), ['who'], 'an action keeps the search');
});

test('Follow adds the team to its sport through C-U (the league too), keeping what else is followed', async () => {
    const { panel, calls } = browser();
    panel.query = 'who';
    panel.answer = JSON.parse(JSON.stringify(ANSWER));
    await panel.act('follow', 'team', 0);
    const put = calls.find((c) => c[0] === 'PUT');
    assert.equal(put[1], '/sports/follows');
    assert.deepEqual(JSON.parse(JSON.stringify(put[2])), { sports: [
        { sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] },
        { sport: 'Basketball', leagues: ['NBA'], teams: ['Whoville Wolves'] }
    ] });
    assert.equal(panel.answer.teams[0].followed, true);
    assert.match(panel.resultsHtml(), /Following/);
});

test('the magnifier is in the top bar of every page and opens the window; the page loads the script before app.js', () => {
    const html = read('index.html');
    const nav = html.slice(html.indexOf('<nav class="navbar'), html.indexOf('</nav>'));
    assert.match(nav, /<button type="button" class="nav-search-btn" id="nav-search" aria-label="Search"/);
    const scripts = [...html.matchAll(/<script src="\/js\/([^"?]+)/g)].map((m) => m[1]);
    assert.ok(scripts.indexOf('components/SearchPanel.js') >= 0 && scripts.indexOf('components/SearchPanel.js') < scripts.indexOf('app.js'));
    const app = read('js/app.js');
    assert.match(app, /this\.search = new SearchPanel\(this\)/);
    assert.match(app, /getElementById\('nav-search'\)[\s\S]{0,120}this\.search\.open\(searchBtn\)/);
    assert.match(read('js/api.js'), /search: \(q, limit = 20\) => API\.request\('GET', `\/library\/search\?q=\$\{encodeURIComponent\(q\)\}&limit=\$\{limit\}`\)/);
    const css = read('css/main.css');
    assert.match(css, /\.search-layout \{[^}]*grid-template-columns: minmax\(14rem, 18rem\) minmax\(0, 1fr\)/, 'side by side when wide');
    assert.match(css, /@media \(max-width: 768px\) \{\s*\.search-layout \{ grid-template-columns: minmax\(0, 1fr\)/, 'stacked when narrow');
});

test('opening the window draws the query box and the hint; typing waits for a pause; Enter searches and remembers', async () => {
    const { panel, document, calls, answers, store } = browser();
    panel.open(null);
    const input = document.getElementById('global-search-input');
    assert.ok(input, 'the query box');
    assert.ok(document.getElementById('global-search-results'));
    input.value = 'do';
    input.dispatchEvent(new FakeEvent('input'));
    assert.equal(calls.filter((c) => c[0] === 'search').length, 0, 'not on every key');
    input.value = 'doctor';
    const enter = new FakeEvent('keydown', { key: 'Enter' });
    input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(calls.filter((c) => c[0] === 'search').map((c) => c[1]), ['doctor']);
    answers[0].resolve({ ...ANSWER, q: 'doctor' });
    await new Promise((r) => setTimeout(r, 0));
    assert.match(document.getElementById('global-search-results').innerHTML, /Doctor Who/);
    assert.deepEqual(JSON.parse(store.pigtvRecentSearches), ['doctor']);
    panel.close();
    assert.equal(document.modals.length, 0);
});
