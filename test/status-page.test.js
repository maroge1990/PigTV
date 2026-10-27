const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0124: the web Status page reads GET /api/status and refreshes every 5 s while shown.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

test('the Status page renders /api/status and refreshes every 5 seconds only while shown', async () => {
    const handlers = [];
    const elements = { 'status-content': { innerHTML: '', querySelector: () => null, addEventListener: (type, fn) => handlers.push(fn) }, 'status-updated': { textContent: '' } };
    const intervals = [];
    const cleared = [];
    const requests = [];
    const status = {
        generatedAt: Date.now(), build: { display: 'v3.7.0 · build 0124' },
        sessions: [{ id: 'a', channel: 'Fox <Sports>', owner: 'user:1', video: 'copy', audio: 'auto', segmentType: 'fmp4', uptimeSec: 75, idleSec: 2, ffmpeg: 'running' }],
        recordings: { active: [], upcoming: [{ id: 1, title: 'News', channel: 'BBC', status: 'scheduled', programStart: Date.now(), programEnd: Date.now() + 1 }] },
        events: [{ at: Date.now(), type: 'play-start', channel: 'BBC', owner: 'user:1', start: 'cold', firstPictureSec: 8.1 },
                 { at: Date.now(), type: 'failure', channel: 'Seven', reason: 'The provider refused this channel' }],
        // 0156: missed/failed schedules from the last 7 days.
        recentProblems: [{ id: 9, title: 'The Big Game', channel: 'Fox Sports 505', status: 'failed',
            programStart: Date.now(), programEnd: Date.now() + 1,
            error: 'Only 0.0 GB free at /app/recordings, below the 10 GB minimum' }],
        sync: [{ sourceId: 1, name: 'Household', type: 'm3u', enabled: true, feeds: [{ type: 'live', status: 'success', lastSync: Date.now() }] }],
        disk: { transcodeCache: { available: true, freeBytes: 2 * 1024 ** 3, totalBytes: 2 * 1024 ** 3 }, recordings: { available: false } }
    };
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null },
        setInterval: (fn, ms) => { intervals.push(ms); return 42; }, clearInterval: (t) => cleared.push(t),
        fetch: async (url, opts = {}) => { requests.push(opts.method && opts.method !== 'GET' ? `${opts.method} ${url}` : url); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => status }; }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/StatusPage.js'), context);
    const page = new context.StatusPage({});
    page.showDetails = true; // 0288: plays, disk and the rest are details

    page.show();
    await new Promise(r => setImmediate(r));
    assert.ok(requests.includes('/api/status'));
    assert.deepEqual(intervals, [5000]);
    const html = elements['status-content'].innerHTML;
    assert.ok(html.includes('Fox &lt;Sports&gt;'), 'escaped');
    assert.ok(html.includes('8.1s') && html.includes('cold'), 'first-picture time and start kind');
    assert.ok(html.includes('The provider refused this channel'));
    assert.ok(html.includes('2.0 GB') && html.includes('unavailable'));
    assert.ok(html.includes('build 0124'));
    assert.ok(html.includes('Recent problems') && html.includes('The Big Game') && html.includes('Only 0.0 GB free'),
        '0156: a recent missed/failed schedule is shown');
    // 0182: a stuck stream is stopped here (it was Settings -> Debug).
    assert.ok(html.includes('data-kill-session="a"'), 'a Stop button on the session');
    assert.ok(!html.includes('data-kill-all'), 'Stop all only with more than one stream');
    const button = { dataset: { killSession: 'a' }, disabled: false };
    handlers[0]({ target: { closest: () => button } });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.ok(requests.some(r => /^DELETE \/api\/transcode\/a(\?|$)/.test(r)), requests.join());
    assert.equal(button.disabled, true);
    page.hide();
    assert.deepEqual(cleared.slice(-1), [42], 'the timer stops when the page is left');
});

test('the Status nav entry and page are admin only', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /class="nav-link admin-only" data-page="status"[^>]*style="display:none;"/);
    assert.match(js('app.js'), /\(pageName === 'settings' \|\| pageName === 'status'\) && this\.currentUser\?\.role !== 'admin'/);
});

// ---- R16 ----
function pageHarness(opts = {}) {
    const state = { hidden: !!opts.hidden, listeners: [], intervals: [], cleared: [], fetches: 0 };
    const sections = new Map();
    const content = {
        _html: '', writes: 0, querySelector: (sel) => { const m = /data-status-section="([^"]+)"/.exec(sel); return m ? sections.get(m[1]) || null : null; },
        addEventListener() {}, querySelectorAll: () => [],
        set innerHTML(v) { this._html = v; this.writes++; sections.clear(); for (const m of v.matchAll(/data-status-section="([^"]+)">([\s\S]*?)<\/div>(?=<div class="status-part"|$)/g)) sections.set(m[1], { _h: m[2], writes: 0, set innerHTML(x) { this._h = x; this.writes++; }, get innerHTML() { return this._h; } }); },
        get innerHTML() { return this._html; }
    };
    const elements = { 'status-content': content, 'status-updated': { textContent: '' } };
    const status = opts.status || { generatedAt: 1, build: { display: 'v' }, providers: [], sessions: [], recordings: { active: [], upcoming: [] } };
    const document = { get hidden() { return state.hidden; }, getElementById: (id) => elements[id] || null, addEventListener: (t, fn) => state.listeners.push([t, fn]) };
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' }, document,
        setInterval: (fn, ms) => { state.intervals.push(ms); return state.intervals.length; }, clearInterval: (t) => state.cleared.push(t),
        fetch: async () => { state.fetches++; return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => status }; }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/StatusPage.js'), context);
    return { page: new context.StatusPage({}), state, content, sections, status };
}
const tick = () => new Promise(r => setImmediate(r));

test('R16: Status does not redraw a section whose data is unchanged', async () => {
    const h = pageHarness();
    await h.page.refresh();
    const writes = h.content.writes;
    assert.ok(writes >= 1);
    const disk = h.sections.get('build');
    h.status.build = { display: 'v2' };
    await h.page.refresh();
    assert.equal(h.content.writes, writes, 'no full redraw');
    assert.equal(disk.writes, 1, 'only the changed section was rewritten');
    await h.page.refresh();
    assert.equal(disk.writes, 1, 'unchanged: nothing written');
});

test('R16: Status pauses while the tab is hidden and refreshes at once when visible again', async () => {
    const h = pageHarness({ hidden: true });
    h.page.show(); await tick();
    assert.equal(h.state.fetches, 0, 'a hidden tab is not polled');
    assert.deepEqual(h.state.intervals, []);
    h.state.hidden = false;
    h.state.listeners.find(l => l[0] === 'visibilitychange')[1](); await tick();
    assert.equal(h.state.fetches, 1, 'refreshed at once');
    assert.deepEqual(h.state.intervals, [5000]);
    h.state.hidden = true;
    h.state.listeners.find(l => l[0] === 'visibilitychange')[1]();
    assert.equal(h.state.cleared.length >= 2, true, 'the timer stops');
    h.page.hide();
});

test('R16: the new status fields render, and an unknown connection purpose just shows up', () => {
    const h = pageHarness();
    h.page.showDetails = true; // 0288: server load is a detail
    const html = h.page.render({
        providers: [{ name: 'Main', role: 'primary', state: 'up', connections: { used: 2, limit: 2 }, uses: [
            { purpose: 'viewer', channel: 'BBC <One>' }, { purpose: 'warm', channel: null }] }],
        preparation: { enabled: true, counts: { pending: 3, preparing: 1, ready: 9, failed: 1 }, current: { id: 4, title: 'Match' },
            lastError: { title: 'Old show', error: 'remux failed' } },
        sportEvents: { builds: 5, lastBuildMs: 120.4, lastMaxLoopDelayMs: 33, staleSinceMs: 90000, building: false },
        loopDelay: { sinceStart: { p50: 1, p99: 12, max: 80 }, lastMinute: { p50: 0.5, p99: 4, max: 9 } }
    });
    assert.ok(html.includes('status-use-warm') && html.includes('>warm<'), 'a new purpose appears as sent');
    assert.ok(html.includes('viewer · BBC &lt;One&gt;'));
    assert.ok(html.includes('Preparing now: Match') && html.includes('remux failed') && html.includes('<b class="pig-amount">3</b>'));
    assert.ok(html.includes('120.4 ms') && html.includes('33 ms') && html.includes('1m 30s'));
    assert.ok(html.includes('p99 12 ms') && html.includes('max 80 ms'));
});

test('bug 9: a shared use reads "· shared"; the recording banner drops its one-stream warning on a shared connection', async () => {
    const h = pageHarness();
    const html = h.page.render({ providers: [{ name: 'Strong8K', role: 'primary', state: 'up', connections: { used: 1, limit: 1 }, uses: [
        { purpose: 'viewer', channel: 'Sky Sports', shared: true }, { purpose: 'recording', channel: 'Sky Sports', shared: true }] }] });
    assert.ok(html.includes('viewer · Sky Sports · shared') && html.includes('recording · Sky Sports · shared'));
    assert.ok(html.includes('1/1'), 'one connection');

    const banner = (active) => {
        const el = { banner: { style: {} }, text: { textContent: '' } };
        const context = vm.createContext({ console, document: { getElementById: (id) => id === 'recording-conflict-banner' ? el.banner
            : id === 'recording-banner-text' ? el.text : null, addEventListener: () => {} }, API: { recordings: { getActive: async () => active } } });
        context.window = context;
        vm.runInContext(js('app.js') + '\nglobalThis.App = App;', context);
        return context.App.prototype.updateRecordingBanner.call({}).then(() => el);
    };
    const row = { title: 'The Game', channel_name: 'Sky Sports', program_end: Date.now() + 3600000 };
    const shared = await banner([{ ...row, ingestKey: 'pool|abc' }]);
    assert.equal(shared.banner.style.display, 'flex');
    assert.ok(shared.text.textContent.startsWith('Recording "The Game" on Sky Sports'));
    assert.ok(!shared.text.textContent.includes('may fail'), shared.text.textContent);
    const own = await banner([row]);
    assert.ok(own.text.textContent.includes('Live playback may fail'), 'a recording on its own connection still warns');
});

test('R16: every nav link has a name and a tooltip, aria-current moves with the active page, the menu button reports expanded', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const links = [...html.matchAll(/<a [^>]*class="nav-link[^"]*"[^>]*>/g)].map(m => m[0]);
    assert.equal(links.length, 6);
    for (const l of links) assert.match(l, /aria-label="[^"]+"/), assert.match(l, /title="[^"]+"/);
    assert.equal(links.filter(l => l.includes('aria-current="page"')).length, 1);
    assert.match(html, /id="mobile-menu-toggle" aria-label="Menu" aria-expanded="false"/);
    const app = js('app.js');
    assert.match(app, /setAttribute\('aria-current', 'page'\)/);
    assert.match(app, /removeAttribute\('aria-current'\)/);
    assert.match(app, /setAttribute\('aria-expanded'/);
    assert.match(app, /logoutLink\.setAttribute\('aria-label', 'Logout'\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '../public/css/main.css'), 'utf8'), /\.nav-link:focus-visible/);
});

// ---- 0288 ----
test('0288: Status opens on what an admin acts on; the troubleshooting sections are behind "Show details", remembered', async () => {
    const status = {
        generatedAt: 1, build: { display: 'v · build 0288' },
        providers: [{ name: 'Strong8K', role: 'primary', state: 'up', connections: { used: 1, limit: 1 }, uses: [] }],
        sessions: [{ id: 's1', channel: 'NBC Sports Boston', owner: 'Apple TV', video: 'copy', audio: 'aac', segmentType: 'fmp4', uptimeSec: 600, idleSec: 1, ffmpeg: 'running' }],
        recordings: { active: [], upcoming: [] },
        interruptions: { days: 7, count: 0, watchedHours: 3, recent: [] },
        events: [{ at: 1, type: 'play-start', channel: 'BBC', start: 'cold', firstPictureSec: 8.1 }],
        sync: [{ name: 'Strong8K', type: 'xtream', enabled: true, feeds: [{ type: 'epg', status: 'error', lastSync: 1, error: 'timed out' }] }],
        feedLag: { limitSec: 24, channels: [{ channel: 'Chicago <Sports>', provider: 'Strong8K', reads: 2, hours: 1.1, worstBehindSec: 24.1, reconnects: 1, lagReconnects: 1, lastAt: 1 }] },
        disk: { transcodeCache: { available: true, freeBytes: 2 * 1024 ** 3, totalBytes: 4 * 1024 ** 3 } }
    };
    const h = pageHarness({ status });
    // The harness's localStorage answers 'tok' for every key: details start hidden.
    await h.page.refresh();
    let html = h.content.innerHTML;
    assert.ok(html.includes('Playing now') && html.includes('NBC Sports Boston') && html.includes('data-kill-session="s1"'));
    assert.ok(html.includes('Providers') && html.includes('Last 7 days') && html.includes('No stream was lost mid-play'));
    assert.ok(html.includes('Needs attention') && html.includes('timed out'), 'a failed sync is raised without opening the details');
    assert.ok(html.includes('build 0288'));
    for (const hidden of ['Recent plays', 'Streams in detail', 'Feed lag', 'Database backups', 'Disk', '8.1s']) {
        assert.ok(!html.includes(hidden), `${hidden}: a detail`);
    }
    assert.ok(html.includes('data-status-details') && html.includes('Show details'));

    // The button shows them, and the choice is kept in this browser.
    h.page.toggleDetails();
    html = h.content.innerHTML;
    assert.ok(html.includes('Hide details'));
    for (const shown of ['Recent plays', 'Streams in detail', 'Feed lag (30 days)', 'Chicago &lt;Sports&gt;', '24.1 s', '1 (1)', 'reconnected when it is 24 s behind', 'Disk', '8.1s']) {
        assert.ok(html.includes(shown), shown);
    }
    h.page.toggleDetails();
    assert.ok(!h.content.innerHTML.includes('Recent plays'), 'and hides them again');
});

test('0288: the details choice is read from and written to localStorage, and a blocked storage just leaves them hidden', () => {
    const load = (storage) => {
        const context = vm.createContext({ console, localStorage: storage, document: { getElementById: () => null, addEventListener() {} } });
        context.window = context;
        vm.runInContext(js('pages/StatusPage.js'), context);
        return new context.StatusPage({});
    };
    const store = new Map([['pigtv.statusDetails', '1']]);
    const page = load({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
    assert.equal(page.showDetails, true);
    page.toggleDetails();
    assert.equal(store.get('pigtv.statusDetails'), '0');
    const blocked = load({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    assert.equal(blocked.showDetails, false);
    blocked.toggleDetails();
    assert.equal(blocked.showDetails, true, 'still works for this visit');
});
