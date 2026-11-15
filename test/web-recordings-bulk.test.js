const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #62: bulk delete on the web Recordings page: select several, one confirmation, one 10 s Undo.
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
const SET = [rec(1, 'Gardening Australia', 300), rec(2, 'The News', 100), rec(3, 'Australian Story', 200), rec(4, 'news at ten', 400, { status: 'failed' }),
    rec(5, 'Live Match', 50, { status: 'recording' })];

function bulk(confirmAnswer = true) {
    const h = setup({ confirmAnswer });
    const notices = [];
    h.context.UI.undoable = (message, opts) => { notices.push({ message, ...opts }); return null; };
    h.page.data.recordings = SET.map(r => ({ ...r }));
    return { ...h, notices };
}
const deleted = (calls) => calls.filter(c => c[0] === 'DELETE').map(c => c.slice(1));

test('#62: select mode ticks completed and failed recordings, never one still being recorded', () => {
    const { page, elements } = bulk();
    page.view.selecting = true;
    page.draw();
    const html = elements['recordings-list'].innerHTML;
    assert.equal((html.match(/data-action="pick"/g) || []).length, 4, 'a checkbox on each recording but the one in progress');
    assert.match(html, /rec-pick is-off[^>]*>Recording</);
    page.view.selected = new Set(['1', '5']);
    assert.deepEqual([...page.selectedIds()], ['1'], 'the one in progress is not selected');
});

test('#62: Delete selected asks once, hides them at once, sends nothing until the Undo ends, then one DELETE each', async () => {
    const { page, calls, asked, notices } = bulk();
    calls.length = 0;
    page.view.selecting = true;
    page.view.selected = new Set(['1', '3', '5']);
    page.deleteSelected();
    assert.equal(asked.length, 1, 'one confirmation');
    assert.match(asked[0], /these 2 recordings/);
    assert.equal(notices.length, 1, 'one Undo notice');
    assert.equal(notices[0].message, '2 recordings deleted');
    assert.deepEqual([...page.visible(page.data.recordings, 'recording')].map(r => r.id), [2, 4, 5]);
    assert.deepEqual(deleted(calls), [], 'nothing sent yet');
    notices[0].undo();
    assert.equal(page.visible(page.data.recordings, 'recording').length, 5, 'Undo puts them all back');
    assert.deepEqual(deleted(calls), []);
    page.view.selected = new Set(['1', '3']);
    page.view.selecting = true;
    page.deleteSelected();
    await notices[1].commit({ keepalive: false });
    assert.deepEqual(deleted(calls), [['/api/recordings/1', true], ['/api/recordings/3', true]]);
});

test('#62: declining the confirmation deletes nothing; a recording that started meanwhile is not sent', async () => {
    const no = bulk(false);
    no.page.view.selected = new Set(['1']);
    no.page.deleteSelected();
    assert.equal(no.notices.length, 0);
    assert.equal(no.page.visible(no.page.data.recordings, 'recording').length, 5);

    const { page, calls, notices } = bulk();
    calls.length = 0;
    page.view.selected = new Set(['1', '2']);
    page.data.recordings.find(r => r.id === 2).status = 'recording';
    page.deleteSelected();
    await notices[0].commit({ keepalive: false });
    assert.deepEqual(deleted(calls), [['/api/recordings/1', true]], 'only the one that is not in progress');
});
