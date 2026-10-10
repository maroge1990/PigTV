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
        'recent-problems-list': { innerHTML: '', querySelectorAll: () => [] }
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

// 0207: a failed/missed schedule can be deleted from "Recent problems"; the library shows this
// login's progress; the player asks before resuming.
function makeContextWithConfirm(elements, respond, confirmAnswer = true) {
    const made = makeContext(elements, respond);
    made.context.confirm = () => confirmAnswer;
    made.context.alert = () => {};
    return made;
}
const withQuery = (el) => Object.assign(el, { querySelectorAll: () => [] });

test('0207: each Recent problems row has a Delete button, and deleting calls the schedule route then refreshes', async () => {
    const elements = makeElements();
    withQuery(elements['recent-problems-list']);
    const { context, requests } = makeContextWithConfirm(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecentProblems([{ id: 7, title: 'Derby', channel_name: 'Fox', status: 'failed', program_start: 1, program_end: 2 }]);
    assert.match(elements['recent-problems-list'].innerHTML, /data-action="delete-scheduled" data-id="7"/);

    await page.deleteProblem('7');
    assert.ok(requests.some(u => u.endsWith('/recordings/scheduled/7')), 'DELETE recordings/scheduled/7');
    assert.ok(requests.some(u => u.includes('/recordings/scheduled?include=recent')), 'refreshed after');
});

test('0207: declining the confirm deletes nothing', async () => {
    const elements = makeElements();
    const { context, requests } = makeContextWithConfirm(elements, () => jsonResponse([]), false);
    const page = new context.RecordingsPage({});
    await page.deleteProblem('7');
    assert.equal(requests.length, 0);
});

test('0207: the library shows a progress bar part-way through and "Watched" once watched', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    const base = { channel_name: 'ABC', status: 'completed', duration_sec: 1000, file_size_bytes: 1 };
    page.renderRecordings([
        { ...base, id: 1, title: 'Half', position_sec: 500, watched: false },
        { ...base, id: 2, title: 'Done', position_sec: 990, watched: true },
        { ...base, id: 3, title: 'Fresh', position_sec: 0, watched: false }
    ]);
    const html = elements['recordings-list'].innerHTML;
    const rows = html.split('class="recording-item"').slice(1);
    assert.match(rows[0], /recording-progress[^>]*><span style="width:50%"/);
    assert.ok(!rows[0].includes('Watched'));
    assert.match(rows[1], /Watched/);
    assert.ok(!rows[1].includes('recording-progress'));
    assert.ok(!rows[2].includes('recording-progress') && !rows[2].includes('Watched'));
});

test('0207: resume time is shown as H:MM:SS', () => {
    const { context } = makeContext(makeElements(), () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    assert.equal(page.formatClock(3725), '1:02:05');
    assert.equal(page.formatClock(59.9), '0:00:59');
    assert.equal(page.formatClock(-5), '0:00:00');
});

test('0207: the Recordings page scrolls like Home (the .page clip would hide the rest)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/css/main.css'), 'utf8');
    assert.match(css, /#page-home,\s*#page-recordings\s*\{[^}]*overflow-y:\s*auto/);
});
