const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0124: the web Status page reads GET /api/status and refreshes every 5 s while shown.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

test('the Status page renders /api/status and refreshes every 5 seconds only while shown', async () => {
    const elements = { 'status-content': { innerHTML: '', querySelector: () => null }, 'status-updated': { textContent: '' } };
    const intervals = [];
    const cleared = [];
    const requests = [];
    const status = {
        generatedAt: Date.now(), build: { display: 'v3.7.0 · build 0124' },
        sessions: [{ id: 'a', channel: 'Fox <Sports>', owner: 'user:1', video: 'copy', audio: 'auto', segmentType: 'fmp4', uptimeSec: 75, idleSec: 2, ffmpeg: 'running' }],
        recordings: { active: [], upcoming: [{ id: 1, title: 'News', channel: 'BBC', status: 'scheduled', programStart: Date.now(), programEnd: Date.now() + 1 }] },
        events: [{ at: Date.now(), type: 'play-start', channel: 'BBC', owner: 'user:1', start: 'cold', firstPictureSec: 8.1 },
                 { at: Date.now(), type: 'failure', channel: 'Seven', reason: 'The provider refused this channel' }],
        sync: [{ sourceId: 1, name: 'Household', type: 'm3u', enabled: true, feeds: [{ type: 'live', status: 'success', lastSync: Date.now() }] }],
        disk: { transcodeCache: { available: true, freeBytes: 2 * 1024 ** 3, totalBytes: 2 * 1024 ** 3 }, recordings: { available: false } }
    };
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null },
        setInterval: (fn, ms) => { intervals.push(ms); return 42; }, clearInterval: (t) => cleared.push(t),
        fetch: async (url) => { requests.push(url); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => status }; }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/StatusPage.js'), context);
    const page = new context.StatusPage({});

    page.show();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(requests, ['/api/status']);
    assert.deepEqual(intervals, [5000]);
    const html = elements['status-content'].innerHTML;
    assert.ok(html.includes('Fox &lt;Sports&gt;'), 'escaped');
    assert.ok(html.includes('8.1s') && html.includes('cold'), 'first-picture time and start kind');
    assert.ok(html.includes('The provider refused this channel'));
    assert.ok(html.includes('2.0 GB') && html.includes('unavailable'));
    assert.ok(html.includes('build 0124'));
    page.hide();
    assert.deepEqual(cleared.slice(-1), [42], 'the timer stops when the page is left');
});

test('the Status nav entry and page are admin only', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /class="nav-link admin-only" data-page="status" style="display:none;"/);
    assert.match(js('app.js'), /\(pageName === 'settings' \|\| pageName === 'status'\) && this\.currentUser\?\.role !== 'admin'/);
});
