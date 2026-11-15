const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #62: the web Recordings page searches the recordings by title and sorts them (Newest first, Oldest first, Title A-Z),
// and deletes several at once behind one confirmation and one Undo.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const stub = () => ({ innerHTML: '', hidden: false, querySelectorAll: () => [], classList: { toggle() {}, contains: () => false } });
const IDS = ['recordings-page-state', 'recorded-section', 'recorded-count', 'recordings-list', 'recorded-foot',
    'scheduled-section', 'scheduled-count', 'scheduled-recordings-list', 'rules-section', 'rules-count', 'rules-sub',
    'recording-rules-list', 'recent-problems-section', 'recent-problems-list'];

function setup({ confirmAnswer = true } = {}) {
    const elements = Object.fromEntries(IDS.map(id => [id, stub()]));
    const calls = [];
    const asked = [];
    const document = { getElementById: (id) => elements[id] || null, hidden: false, addEventListener() {},
        createElement: () => { let h = ''; return { set textContent(v) { h = String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }, get innerHTML() { return h; } }; } };
    const context = vm.createContext({ console: { ...console, error() {} }, localStorage: { getItem: () => 'tok' }, document, addEventListener() {},
        confirm: (q) => { asked.push(q); return confirmAnswer; },
        fetch: async (url, opts = {}) => {
            calls.push([opts.method || 'GET', String(url), opts.keepalive === true]);
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] };
        } });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('api.js'), context);
    loadUi(context);
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    const page = new context.RecordingsPage({});
    return { elements, calls, asked, context, page };
}
const rec = (id, title, started, over = {}) => ({ id, title, started_at: started, status: 'completed', watched: false, channel_name: 'ABC', ...over });
const SET = [rec(1, 'Gardening Australia', 300), rec(2, 'The News', 100), rec(3, 'Australian Story', 200), rec(4, 'news at ten', 400),
    rec(5, 'Live Match', 50, { status: 'recording' })];
const titles = (rows) => [...rows.map(r => r.title)];

test('#62: the default order is newest first with a recording in progress first, as the Apple tab; Oldest first reverses', () => {
    const { page } = setup();
    assert.deepEqual(titles(page.arrange(SET)), ['Live Match', 'news at ten', 'Gardening Australia', 'Australian Story', 'The News']);
    page.view.sort = 'oldest';
    assert.deepEqual(titles(page.arrange(SET)), ['Live Match', 'The News', 'Australian Story', 'Gardening Australia', 'news at ten']);
});

test('#62: Title A-Z ignores case', () => {
    const { page } = setup();
    page.view.sort = 'title';
    assert.deepEqual(titles(page.arrange(SET)), ['Australian Story', 'Gardening Australia', 'Live Match', 'news at ten', 'The News']);
});

test('#62: search matches any part of a title in any case, and says so when nothing matches', () => {
    const { page, elements } = setup();
    page.data.recordings = SET;
    page.view.query = ' NEWS ';
    assert.deepEqual(titles(page.arrange(SET)), ['news at ten', 'The News']);
    page.draw();
    const html = elements['recordings-list'].innerHTML;
    assert.match(html, /type="search"[^>]*data-action="search"/);
    assert.match(html, /<option value="newest" selected>Newest first<\/option><option value="oldest">Oldest first<\/option><option value="title">Title A–Z<\/option>/);
    assert.doesNotMatch(html, /Gardening Australia/);
    assert.match(elements['recorded-count'].innerHTML, /2<\/span> of <span class="pig-amount">5/);
    page.view.query = 'zzz <b>';
    page.draw();
    assert.match(elements['recordings-list'].innerHTML, /No recording matches “zzz &lt;b&gt;”/);
    assert.match(elements['recordings-list'].innerHTML, /data-action="clear-search"/);
});
