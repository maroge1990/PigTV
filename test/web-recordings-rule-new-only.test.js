const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #62: Recordings > Rules lets a series rule be switched between new episodes only and repeats too (PUT newOnly, C-M).
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const stub = () => ({ innerHTML: '', hidden: false, querySelectorAll: () => [], classList: { toggle() {}, contains: () => false } });
const IDS = ['recordings-page-state', 'recorded-section', 'recorded-count', 'recordings-list', 'recorded-foot',
    'scheduled-section', 'scheduled-count', 'scheduled-recordings-list', 'rules-section', 'rules-count', 'rules-sub',
    'recording-rules-list', 'recent-problems-section', 'recent-problems-list'];

function setup() {
    const elements = Object.fromEntries(IDS.map(id => [id, stub()]));
    const calls = [];
    const document = { getElementById: (id) => elements[id] || null, createElement: () => ({ set textContent(v) { this.innerHTML = String(v); } }),
        hidden: false, addEventListener() {} };
    const context = vm.createContext({ console: { ...console, error() {} }, localStorage: { getItem: () => 'tok' }, document, addEventListener() {},
        fetch: async (url, opts = {}) => {
            calls.push([opts.method || 'GET', String(url), opts.body]);
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] };
        } });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('api.js'), context);
    loadUi(context);
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    return { elements, calls, page: new context.RecordingsPage({}) };
}

test('#62: a series rule shows a New episodes only / Record repeats too button; a game rule does not', () => {
    const { elements, page } = setup();
    page.renderRules([
        { id: 1, kind: 'series', match: 'News', channelName: 'ABC', newOnly: false, enabled: true, upcoming: 0 },
        { id: 2, kind: 'series', match: 'Gruen', channelName: 'ABC', newOnly: true, enabled: true, upcoming: 0 },
        { id: 3, kind: 'team', match: 'Collingwood', enabled: true, upcoming: 0 }
    ]);
    const html = elements['recording-rules-list'].innerHTML;
    assert.equal((html.match(/data-action="toggle-new-only"/g) || []).length, 2);
    assert.match(html, /data-id="1" data-new-only="false"[^>]*aria-pressed="false">New episodes only</);
    assert.match(html, /data-id="2" data-new-only="true"[^>]*aria-pressed="true">Record repeats too</);
});

test('#62: choosing it sends PUT newOnly and nothing else', async () => {
    const { calls, page } = setup();
    calls.length = 0;
    await page.setNewOnly(1, true);
    const put = calls.find(c => c[0] === 'PUT');
    assert.equal(put[1], '/api/recordings/rules/1');
    assert.deepEqual(JSON.parse(put[2]), { newOnly: true });
});
