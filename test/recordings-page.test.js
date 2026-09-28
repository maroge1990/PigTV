const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0156: the web Recordings page gets a "Recent problems" section (missed/failed
// schedules from the last 7 days), shown only when there is something to show -
// otherwise a schedule like #3's "0.0 GB free" failure simply vanished.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

/** A DOM-free stand-in for document.createElement('div') that makes escape() work
 *  (RecordingsPage.escape() round-trips through .textContent -> .innerHTML). */
function fakeElement() {
    const el = { className: '', addEventListener: () => {}, querySelector: () => null, remove: () => {} };
    let html = '';
    Object.defineProperty(el, 'textContent', {
        set(v) {
            html = String(v ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[ch]);
        },
        get() { return html; }
    });
    Object.defineProperty(el, 'innerHTML', { get() { return html; }, set(v) { html = v; } });
    return el;
}

function makeElements() {
    return {
        'scheduled-recordings-list': { innerHTML: '', querySelectorAll: () => [] },
        'recordings-list': { innerHTML: '', querySelectorAll: () => [] },
        'recent-problems-section': { hidden: true },
        'recent-problems-list': { innerHTML: '' }
    };
}

function makeContext(elements, respond) {
    const requests = [];
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null, createElement: fakeElement },
        fetch: async (url) => { requests.push(String(url)); return respond(String(url)); }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    return { context, requests };
}

const jsonResponse = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

test('0156: a recent failure is listed under "Recent problems", not among the upcoming schedule', async () => {
    const elements = makeElements();
    const scheduledWithRecent = [
        { id: 1, title: 'News', channel_name: 'BBC', status: 'scheduled', program_start: Date.now(), program_end: Date.now() + 1000 },
        {
            id: 2, title: 'The Big Game', channel_name: 'Fox Sports 505', status: 'failed',
            program_start: Date.now() - 1000, program_end: Date.now(),
            error: 'Only 0.0 GB free at /app/recordings, below the 10 GB minimum'
        }
    ];
    const { context, requests } = makeContext(elements, (url) =>
        jsonResponse(url.includes('/recordings/scheduled') ? scheduledWithRecent : []));

    const page = new context.RecordingsPage({});
    await page.loadScheduled();

    assert.ok(requests.some(u => u.includes('/recordings/scheduled') && u.includes('include=recent')),
        'the scheduled list is fetched with include=recent');
    assert.equal(elements['recent-problems-section'].hidden, false, 'shown because there is a recent failure');
    assert.ok(elements['recent-problems-list'].innerHTML.includes('The Big Game'));
    assert.ok(elements['recent-problems-list'].innerHTML.includes('Fox Sports 505'));
    assert.ok(elements['recent-problems-list'].innerHTML.includes('Only 0.0 GB free'));
    assert.ok(elements['scheduled-recordings-list'].innerHTML.includes('News'), 'the upcoming schedule still renders as before');
    assert.ok(!elements['recent-problems-list'].innerHTML.includes('News'), 'and never in Recent problems');
    assert.ok(!elements['scheduled-recordings-list'].innerHTML.includes('The Big Game'), 'nor the failure among the upcoming ones');
});

test('0156: the "Recent problems" section stays hidden when there is nothing to show', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([
        { id: 1, title: 'News', channel_name: 'BBC', status: 'scheduled', program_start: Date.now(), program_end: Date.now() + 1000 }
    ]));

    const page = new context.RecordingsPage({});
    await page.loadScheduled();

    assert.equal(elements['recent-problems-section'].hidden, true);
    assert.equal(elements['recent-problems-list'].innerHTML, '');
});
