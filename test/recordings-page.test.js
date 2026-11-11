const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// 0156: the web Recordings page gets a "Recent problems" section (missed/failed
// schedules from the last 7 days), shown only when there is something to show -
// otherwise a schedule like #3's "0.0 GB free" failure simply vanished.
// #276 (option B, 11 Nov 2026): picture cards, Recorded first, one rose primary, the reasons written in the card,
// a "⋯" menu, deleting and cancelling at once with a 10-second Undo (only Stop still confirms), page-shaped states.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const recordingsHtml = indexHtml.match(/<div id="page-recordings"[\s\S]*?<!-- Status Page/)[0];

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

function stub() {
    const classes = new Set();
    return {
        innerHTML: '', hidden: false, querySelectorAll: () => [], classes,
        classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) }
    };
}

const IDS = ['recordings-page-state', 'recorded-section', 'recorded-count', 'recordings-list', 'recorded-foot',
    'scheduled-section', 'scheduled-count', 'scheduled-recordings-list', 'rules-section', 'rules-count', 'rules-sub',
    'recording-rules-list', 'recent-problems-section', 'recent-problems-list'];

function makeElements() {
    const elements = Object.fromEntries(IDS.map(id => [id, stub()]));
    elements['recent-problems-section'].hidden = true;
    return elements;
}

/** Everything the page shows: its static markup plus what it drew into each element. */
const allHtml = (elements) => recordingsHtml + Object.values(elements).filter(e => !e.hidden).map(e => e.innerHTML || '').join('\n');

function makeContext(elements, respond, { confirmAnswer = true } = {}) {
    const requests = [];
    const calls = [];
    const winListeners = {};
    const docListeners = {};
    const document = {
        getElementById: (id) => elements[id] || null, createElement: fakeElement, hidden: false,
        addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); }
    };
    const context = vm.createContext({
        console: { ...console, error() {} }, localStorage: { getItem: () => 'tok' },
        document,
        addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
        confirm: (q) => { calls.push(['confirm', q]); return confirmAnswer; },
        fetch: async (url, opts = {}) => {
            const method = opts.method || 'GET';
            requests.push(String(url));
            calls.push([method, String(url), opts.keepalive === true]);
            return respond(String(url), method);
        }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('api.js'), context);
    loadUi(context);
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    const fire = (where, type) => (where === 'window' ? winListeners : docListeners)[type]?.forEach(fn => fn());
    return { context, requests, calls, fire, document };
}

const jsonResponse = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
const failResponse = (message, status = 500) => ({ ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ error: message }) });
const deletes = (calls) => calls.filter(c => c[0] === 'DELETE').map(c => c[1]);
const lastToast = (context) => context.toasts[context.toasts.length - 1];

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

// #12 (D-28, D-42): a clash is written on each schedule involved; the one scheduled first records, the other waits.
test('#12: the clash wording on the winner and on the one that waits, and "Record this one instead" only on the latter', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderScheduled([
        { id: 1, title: 'Derby', channel_name: 'Fox', status: 'scheduled', program_start: 1, program_end: 2, conflictsWith: [2] },
        { id: 2, title: 'Final', channel_name: 'ESPN', status: 'scheduled', program_start: 1, program_end: 2, conflictsWith: [1], beatenBy: [1] },
        { id: 3, title: 'Live <Game>', channel_name: 'Sky', status: 'recording', program_start: 1, program_end: 2, conflictsWith: [4] },
        { id: 4, title: 'Other', channel_name: null, status: 'scheduled', program_start: 1, program_end: 2, conflictsWith: [3], beatenBy: [3, 99] }
    ]);
    const chips = elements['scheduled-recordings-list'].innerHTML.split('class="rec-chip"').slice(1);
    assert.match(chips[0], /data-clash>Clashes with Final \(ESPN\): this one records \(scheduled first\); the other waits\.</);
    assert.match(chips[1], /data-clash>Clashes with Derby \(Fox\), which records instead: this one waits and is not recorded unless you choose it\.</);
    assert.match(chips[2], /data-clash>Clashes with Other \(unknown channel\): this one records; the other waits\.</, 'no "(scheduled first)" while recording');
    assert.match(chips[3], /Clashes with Live &lt;Game&gt; \(Sky\), schedule #99, which records instead/, 'escaped, an unknown id named');
    assert.ok(!chips[0].includes('data-action="choose"'));
    assert.match(chips[1], /data-action="choose" data-id="2"[^>]*>Record this one instead</);
    assert.match(chips[1], /Clash: will not record/);
    assert.match(chips[2], /data-action="cancel" data-id="3"[^>]*>\s*Stop\s*</);
    assert.match(chips[1], /data-action="cancel" data-id="2"[^>]*>\s*Cancel\s*</);
    assert.match(chips[2], /Now, until /, 'while recording: until when');
});

test('waiting: the reason is written out in the item', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderScheduled([{ id: 1, title: 'Insight', channel_name: 'SBS', status: 'waiting', error: "another stream is using the provider's only connection", program_start: 1, program_end: 2 }]);
    const html = elements['scheduled-recordings-list'].innerHTML.replace(/ title="[^"]*"/g, '');
    assert.match(html, /Waiting:<\/b> another stream is using the provider&#39;s only connection/);
});

// 0207, #276: a failed/missed schedule can be deleted from "Recent problems", at once with an Undo; the server is asked
// only when the notice ends without Undo, then the page is refreshed.
test('0207/#276: Delete in Recent problems: gone at once, the request only when the notice ends, then a refresh', async () => {
    const elements = makeElements();
    const { context, requests, calls } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecentProblems([{ id: 7, title: 'Derby', channel_name: 'Fox', status: 'failed', program_start: 1, program_end: 2 }]);
    assert.match(elements['recent-problems-list'].innerHTML, /data-action="delete-scheduled" data-id="7"/);

    page.deleteProblem('7');
    assert.ok(!calls.some(c => c[0] === 'confirm'), 'no confirm');
    assert.deepEqual(deletes(calls), [], 'nothing sent yet');
    assert.equal(elements['recent-problems-section'].hidden, true, 'its only row left at once');
    const [message, options] = lastToast(context);
    assert.equal(message, 'Failed recording deleted');
    assert.equal(options.action.label, 'Undo');

    await options.onEnd('timeout');
    assert.deepEqual(deletes(calls), ['/api/recordings/scheduled/7'], 'DELETE recordings/scheduled/7');
    assert.ok(requests.some(u => u.includes('/recordings/scheduled?include=recent')), 'refreshed after');
});

test('#276: Undo on a recent problem sends nothing and puts the row back', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecentProblems([{ id: 7, title: 'Derby', channel_name: 'Fox', status: 'failed', program_start: 1, program_end: 2 }]);
    page.deleteProblem('7');
    const [, options] = lastToast(context);
    options.onEnd('action');
    await options.action.run();
    assert.equal(calls.length, 0, 'no request at all');
    assert.equal(elements['recent-problems-section'].hidden, false);
    assert.match(elements['recent-problems-list'].innerHTML, /Derby/);
});

const REC = (extra) => ({ channel_name: 'ABC', status: 'completed', duration_sec: 1000, file_size_bytes: 2 * 1024 ** 3, ...extra });
const LIBRARY = [
    REC({ id: 1, title: 'Newest but watched', started_at: Date.UTC(2026, 10, 9), watched: true, position_sec: 990, compress_status: 'done' }),
    REC({ id: 2, title: 'Half watched', started_at: Date.UTC(2026, 10, 8), position_sec: 500 }),
    REC({ id: 3, title: 'Older, not watched', started_at: Date.UTC(2026, 10, 7) }),
    REC({ id: 4, title: 'Hard Quiz', status: 'failed', started_at: Date.UTC(2026, 10, 10), error: 'The provider stopped sending the programme', file_size_bytes: 0 }),
    REC({ id: 5, title: 'AFLW', started_at: Date.UTC(2026, 10, 1), is_partial: true, missed_start_ms: 12 * 60000,
        compress_status: 'failed', compress_error: 'ffmpeg exited with code 1', ad_detect_status: 'failed', ad_detect_error: 'comskip crashed' }),
    REC({ id: 6, title: 'Cut short', started_at: Date.UTC(2026, 10, 2), is_partial: true, missed_start_ms: 0 })
];
const cardOf = (html, id) => html.split('<article').find(c => c.includes(`data-id="${id}"`)) || '';

test('0207: the library shows a progress bar part-way through with the time left, and "Watched" once watched', () => {
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
    const rows = html.split('class="rec-tile"').slice(1);
    assert.match(rows[0], /rec-tile-bar[^>]*role="progressbar"[^>]*aria-valuenow="50"[^>]*><span style="width:50%"/);
    assert.match(rows[0], /8 min left/);
    assert.ok(!/>Watched</.test(rows[0]), 'no Watched tag');
    assert.match(rows[1], />Watched</);
    assert.ok(!rows[1].includes('rec-tile-bar'));
    assert.ok(!rows[2].includes('rec-tile-bar') && !/>Watched</.test(rows[2]));
});

test('#276: the reasons are written in the card, not only in a hover title', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecordings(LIBRARY);
    const html = elements['recordings-list'].innerHTML.replace(/ title="[^"]*"/g, '');
    assert.match(cardOf(html, 5), /Partial:<\/b> missing the first 12 minutes/);
    assert.match(cardOf(html, 6), /Partial:<\/b> stopped before the programme ended/);
    assert.match(cardOf(html, 4), /The provider stopped sending the programme/);
    assert.match(cardOf(html, 5), /Compression failed:<\/b> ffmpeg exited with code 1/);
    assert.match(cardOf(html, 5), /Break detection failed:<\/b> comskip crashed/);
    for (const word of ['Completed', 'Failed', 'Partial', 'Compression failed', 'Break detection failed', 'Compressed', 'Watched']) {
        assert.match(html, new RegExp(`class="rec-tag[^"]*">[^<]*${word}<`), `${word} is a tag`);
    }
});

test('#276: exactly one rose primary on the page: Play on the newest completed recording not watched', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, (url) => jsonResponse(url.endsWith('/recordings') ? LIBRARY
        : url.includes('/scheduled') ? [{ id: 9, title: 'X', status: 'scheduled', program_start: 1, program_end: 2, conflictsWith: [10], beatenBy: [10] },
            { id: 10, title: 'Y', status: 'scheduled', program_start: 1, program_end: 2, conflictsWith: [9] }]
            : [{ id: 1, kind: 'sport', match: 'AFL', enabled: true, upcoming: 2 }]));
    const page = new context.RecordingsPage({});
    await page.refresh();
    const html = allHtml(elements);
    assert.equal((html.match(/btn-primary/g) || []).length, 1, 'one btn-primary');
    assert.match(html, /class="[^"]*btn-primary[^"]*" data-action="play" data-id="2"/);
    assert.match(elements['scheduled-recordings-list'].innerHTML, /btn-secondary[^"]*" data-action="choose"/, 'Record this one instead is secondary');
});

test('#276: when nothing is recorded the rose button is "Open the TV Guide", and it opens the guide', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const went = [];
    const page = new context.RecordingsPage({ navigateTo: (p) => went.push(p) });
    await page.refresh();
    const html = allHtml(elements);
    assert.equal((html.match(/btn-primary/g) || []).length, 1);
    assert.match(elements['recordings-list'].innerHTML, /No recordings yet/);
    assert.match(elements['recordings-list'].innerHTML, /btn-primary[^>]*>Open the TV Guide</);
    assert.equal(elements['scheduled-section'].hidden, true, 'no empty Coming up box');
    assert.equal(elements['rules-sub'].hidden, false, 'the rules card says what a rule is');
    assert.equal(elements['recent-problems-section'].hidden, true);
    page.openGuide();
    assert.deepEqual(went, ['guide']);
});

test('#276: recordings but nothing scheduled: no Coming up box, one quiet line', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, (url) => jsonResponse(url.endsWith('/recordings') ? LIBRARY.slice(0, 2) : []));
    const page = new context.RecordingsPage({});
    await page.refresh();
    assert.equal(elements['scheduled-section'].hidden, true);
    assert.equal(elements['recorded-foot'].hidden, false);
    assert.match(elements['recorded-foot'].innerHTML, /Nothing is scheduled/);
    assert.match(elements['recorded-count'].innerHTML, /<span class="pig-amount">2<\/span> programmes/);
});

test('#276: the "⋯" menu holds Download, Compress (when offered) and Delete; a failed recording has only Delete', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecordings(LIBRARY);
    const html = elements['recordings-list'].innerHTML;
    assert.match(cardOf(html, 2), /data-action="more" data-id="2" aria-haspopup="menu" aria-expanded="false" aria-label="More for Half watched"/);
    assert.ok(!cardOf(html, 2).includes('data-action="delete"'), 'Delete is in the menu, not on the card');
    assert.ok(!cardOf(html, 2).includes('>Download<'), 'Download is in the menu');
    const labels = (id) => page.menuItems(id).map(i => `${i.label}${i.danger ? '!' : ''}${i.href ? '@' : ''}`).join(' ');
    assert.equal(labels(2), 'Download@ Compress Delete!');
    assert.equal(labels(1), 'Download@ Delete!', 'already compressed: no Compress');
    assert.equal(labels(5), 'Download@ Compress Delete!', 'compression failed: offered again');
    assert.match(page.menuItems(2)[0].href, /^\/api\/recordings\/2\/download/);
    assert.ok(!cardOf(html, 4).includes('data-action="play"'), 'a failed recording has no Play');
    assert.ok(!cardOf(html, 4).includes('data-action="more"'));
    assert.match(cardOf(html, 4), /btn-secondary" data-action="delete" data-id="4">Delete</);
});

test('#276: Delete a recording: gone at once, nothing sent until the notice ends, the refresh does not bring it back', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, (url) => jsonResponse(url.endsWith('/recordings') ? LIBRARY : []));
    const page = new context.RecordingsPage({});
    await page.refresh();
    page.deleteRecording('2');
    assert.ok(!calls.some(c => c[0] === 'confirm'), 'no confirm');
    assert.ok(!cardOf(elements['recordings-list'].innerHTML, 2), 'the card left at once');
    const [message, options] = lastToast(context);
    assert.equal(message, 'Recording deleted');
    assert.equal(options.action.label, 'Undo');

    await page.refresh();
    assert.ok(!cardOf(elements['recordings-list'].innerHTML, 2), 'the 30 s refresh does not draw a pending item');
    assert.deepEqual(deletes(calls), []);

    await options.onEnd('timeout');
    assert.deepEqual(deletes(calls), ['/api/recordings/2']);
});

test('#276: Undo puts the recording back without a request', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecordings(LIBRARY);
    page.deleteRecording('3');
    const [, options] = lastToast(context);
    options.onEnd('action');
    await options.action.run();
    assert.ok(cardOf(elements['recordings-list'].innerHTML, 3));
    assert.deepEqual(deletes(calls), []);
});

test('#276: a refused delete brings the recording back and says it could not be deleted', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, (url, method) => method === 'DELETE' ? failResponse('busy') : jsonResponse(url.endsWith('/recordings') ? LIBRARY : []));
    const page = new context.RecordingsPage({});
    await page.refresh();
    page.deleteRecording('3');
    await lastToast(context)[1].onEnd('timeout');
    assert.deepEqual(deletes(calls), ['/api/recordings/3']);
    assert.ok(cardOf(elements['recordings-list'].innerHTML, 3), 'back on the page');
    const [message, options] = lastToast(context);
    assert.equal(message, 'Could not delete it.', 'a server fault is never printed; the detail goes to the console');
    assert.equal(options.kind, 'error');
});

test('#276: a second delete commits the first (its notice is replaced); the second keeps its own Undo', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, (url) => jsonResponse(url.endsWith('/recordings') ? LIBRARY : []));
    const page = new context.RecordingsPage({});
    page.renderRecordings(LIBRARY);
    page.deleteRecording('2');
    const first = lastToast(context)[1];
    page.deleteRecording('3');
    const second = lastToast(context)[1];
    await first.onEnd('replaced');
    assert.deepEqual(deletes(calls), ['/api/recordings/2']);
    assert.ok(!cardOf(elements['recordings-list'].innerHTML, 3), 'the second is still pending');
    second.onEnd('action');
    await second.action.run();
    assert.deepEqual(deletes(calls), ['/api/recordings/2']);
    assert.ok(cardOf(elements['recordings-list'].innerHTML, 3));
});

test('#276: leaving the page (pagehide) or hiding the tab sends what is pending at once, with keepalive', async () => {
    const elements = makeElements();
    const { context, calls, fire, document } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRecordings(LIBRARY);
    page.renderRules([{ id: 8, kind: 'sport', match: 'AFL', enabled: true, upcoming: 0 }]);
    page.deleteRecording('2');
    fire('window', 'pagehide');
    await new Promise(setImmediate);
    assert.deepEqual(calls.filter(c => c[0] === 'DELETE'), [['DELETE', '/api/recordings/2', true]]);
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 1, 'sent once');

    page.deleteRule('8');
    document.hidden = true;
    fire('window', 'visibilitychange'); // fired at the document, it bubbles to the window, where UI.undoable listens
    await new Promise(setImmediate);
    assert.deepEqual(calls.filter(c => c[0] === 'DELETE')[1], ['DELETE', '/api/recordings/rules/8', true]);
});

test('#276: Cancel a scheduled recording: Undo, no confirm; Stop on one recording still confirms', async () => {
    const elements = makeElements();
    const NOW = { id: 6, title: 'Now', status: 'recording', program_start: 1, program_end: 2 };
    const { context, calls } = makeContext(elements, (url) => jsonResponse(url.includes('/scheduled') ? [NOW] : []));
    const page = new context.RecordingsPage({});
    page.renderScheduled([{ id: 5, title: 'Later', status: 'scheduled', program_start: 1, program_end: 2 }, NOW]);
    page.cancelScheduled('5');
    assert.ok(!calls.some(c => c[0] === 'confirm'));
    assert.deepEqual(deletes(calls), []);
    assert.ok(!elements['scheduled-recordings-list'].innerHTML.includes('data-id="5"'));
    const [message, options] = lastToast(context);
    assert.equal(message, 'Recording cancelled');
    await options.onEnd('timeout');
    assert.deepEqual(deletes(calls), ['/api/recordings/scheduled/5']);

    await page.cancelScheduled('6');
    assert.equal(calls.filter(c => c[0] === 'confirm').length, 1, 'Stop asks first');
    assert.deepEqual(deletes(calls), ['/api/recordings/scheduled/5', '/api/recordings/scheduled/6'], 'and stops at once');
});

// #276 review (Opus low 3): a schedule that starts recording inside the 10 s was stopped by the delayed cancel, without
// the confirmation Stop asks for. The cancel is not sent then: the item comes back with a notice saying why.
test('#276 review: a cancel whose recording has started in the 10 s is not sent; the item comes back and the notice says why', async () => {
    const elements = makeElements();
    const later = Date.now() + 3600e3;
    let status = 'scheduled';
    const { context, calls } = makeContext(elements, (url) => jsonResponse(url.includes('/scheduled')
        ? [{ id: 5, title: 'Later', status, program_start: later, program_end: later + 1 }] : []));
    const page = new context.RecordingsPage({});
    await page.refresh();
    page.cancelScheduled('5');
    const [, notice] = lastToast(context);
    status = 'recording'; // the server starts it while the notice is up
    await notice.onEnd('timeout');
    assert.deepEqual(deletes(calls), [], 'nothing stopped');
    assert.ok(elements['scheduled-recordings-list'].innerHTML.includes('data-id="5"'), 'back on the page');
    assert.match(elements['scheduled-recordings-list'].innerHTML, />Stop</);
    assert.equal(lastToast(context)[0], 'Later has started recording, so it was not cancelled. Use Stop to end it.');
});

test('#276 review: leaving the page decides from what the page holds: the shared feed or a start already passed keeps it', async () => {
    for (const how of ['feed', 'time']) {
        const elements = makeElements();
        const start = how === 'time' ? Date.now() + 60e3 : Date.now() + 3600e3; // a 2-minute lead-in has begun
        const { context, calls, fire } = makeContext(elements, () => jsonResponse([]));
        const app = { recordingsFeed: { latest: how === 'feed' ? [{ id: 5 }] : [] } };
        const page = new context.RecordingsPage(app);
        page.renderScheduled([{ id: 5, title: 'Later', status: 'scheduled', program_start: start, program_end: start + 1, pre_buffer_min: 2 }]);
        page.cancelScheduled('5');
        fire('window', 'pagehide');
        await new Promise(setImmediate);
        assert.deepEqual(deletes(calls), [], how);
    }
    // One not started is cancelled as before, with keepalive.
    const elements = makeElements();
    const { context, calls, fire } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({ recordingsFeed: { latest: [] } });
    const start = Date.now() + 3600e3;
    page.renderScheduled([{ id: 5, title: 'Later', status: 'scheduled', program_start: start, program_end: start + 1, pre_buffer_min: 2 }]);
    page.cancelScheduled('5');
    fire('window', 'pagehide');
    await new Promise(setImmediate);
    assert.deepEqual(calls.filter(c => c[0] === 'DELETE'), [['DELETE', '/api/recordings/scheduled/5', true]]);
});

test('#276: declining the Stop confirmation stops nothing', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, () => jsonResponse([]), { confirmAnswer: false });
    const page = new context.RecordingsPage({});
    page.renderScheduled([{ id: 6, title: 'Now', status: 'recording', program_start: 1, program_end: 2 }]);
    await page.cancelScheduled('6');
    assert.deepEqual(deletes(calls), []);
});

test('#276: Delete a rule: Undo, the request when the notice ends', async () => {
    const elements = makeElements();
    const { context, calls } = makeContext(elements, () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    page.renderRules([{ id: 1, kind: 'sport', match: 'AFL', enabled: true, upcoming: 2 }]);
    page.deleteRule('1');
    assert.ok(!calls.some(c => c[0] === 'confirm'));
    assert.ok(!elements['recording-rules-list'].innerHTML.includes('AFL'));
    const [message, options] = lastToast(context);
    assert.equal(message, 'Rule deleted. Its 2 scheduled recordings are cancelled.', 'says what else goes, from the count the row has');
    await options.onEnd('closed');
    assert.deepEqual(deletes(calls), ['/api/recordings/rules/1']);
});

test('#276: loading: placeholder cards and one status line, the rules too', () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => new Promise(() => {}));
    new context.RecordingsPage({});
    assert.match(elements['recordings-list'].innerHTML, /rec-sk-tile/);
    assert.match(elements['recordings-list'].innerHTML, /aria-hidden="true"/);
    assert.match(elements['recorded-count'].innerHTML, /role="status"[^>]*>Loading recordings…</);
    assert.match(elements['scheduled-recordings-list'].innerHTML, /rec-sk/);
    assert.match(elements['recording-rules-list'].innerHTML, /rec-sk/);
    const statuses = Object.values(elements).map(e => (e.innerHTML.match(/role="status"/g) || []).length).reduce((a, b) => a + b, 0);
    assert.equal(statuses, 1, 'one status line');
});

test('#276: one list failing: the others still draw, the failed one says so in place with Try again, never the raw error', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, (url) => url.includes('/rules') ? failResponse('SECRET-BOOM')
        : jsonResponse(url.endsWith('/recordings') ? LIBRARY : []));
    const page = new context.RecordingsPage({});
    await page.refresh();
    assert.ok(cardOf(elements['recordings-list'].innerHTML, 2), 'recordings drawn');
    assert.match(elements['recording-rules-list'].innerHTML, /state-error/);
    assert.match(elements['recording-rules-list'].innerHTML, /The recording rules could not be loaded\./);
    assert.match(elements['recording-rules-list'].innerHTML, />Try again</);
    assert.equal(elements['recordings-page-state'].hidden, true);
    assert.ok(!allHtml(elements).includes('SECRET-BOOM'));
});

test('#276: everything failing: one page-level error with what still works and Try again', async () => {
    const elements = makeElements();
    const { context } = makeContext(elements, () => failResponse('SECRET-BOOM'));
    const page = new context.RecordingsPage({});
    await page.refresh();
    const state = elements['recordings-page-state'];
    assert.equal(state.hidden, false);
    assert.match(state.innerHTML, /Recordings could not be loaded/);
    assert.match(state.innerHTML, /Live TV and the TV Guide still work/);
    assert.match(state.innerHTML, /btn-primary[^>]*>Try again</);
    for (const id of ['recorded-section', 'scheduled-section', 'rules-section', 'recent-problems-section']) assert.equal(elements[id].hidden, true, id);
    assert.ok(!allHtml(elements).includes('SECRET-BOOM'));
});

test('#276: the page order is Recorded, Coming up, then Recording rules and Recent problems side by side', () => {
    const order = ['recorded-section', 'scheduled-section', 'rules-section', 'recent-problems-section'].map(id => recordingsHtml.indexOf(`id="${id}"`));
    assert.ok(order.every(i => i > 0), 'all four sections');
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(recordingsHtml, /class="rec-two"[\s\S]*id="rules-section"[\s\S]*id="recent-problems-section"/);
    assert.ok(!/btn-primary/.test(recordingsHtml), 'Add rule is secondary');
});

test('#276: every date on the page goes through UI.dateTime / UI.dateRange (no toLocaleString)', () => {
    const src = js('pages/RecordingsPage.js');
    assert.doesNotMatch(src, /toLocale(Date|Time)?String/);
    assert.match(src, /UI\.dateTime\(/);
    assert.match(src, /UI\.dateRange\(/);
});

test('0207: resume time is shown as H:MM:SS', () => {
    const { context } = makeContext(makeElements(), () => jsonResponse([]));
    const page = new context.RecordingsPage({});
    assert.equal(page.formatClock(3725), '1:02:05');
    assert.equal(page.formatClock(59.9), '0:00:59');
    assert.equal(page.formatClock(-5), '0:00:00');
});

test('0207: the Recordings page scrolls (the .page clip would hide the rest)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/css/main.css'), 'utf8');
    assert.match(css, /#page-recordings\s*\{[^}]*overflow-y:\s*auto/);
});

// R5: the Recording rules section: listed with on/off and delete, and a sport rule added from the box.
test('R5: rules are listed with their state, and the box adds a sport rule then refreshes', async () => {
    const elements = makeElements();
    elements['rule-add-match'] = { value: '  Collingwood ' };
    elements['rule-add-status'] = { textContent: '' };
    const bodies = [];
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null, createElement: fakeElement },
        fetch: async (url, opts = {}) => {
            if (opts.method === 'POST') bodies.push(JSON.parse(opts.body));
            if (String(url).endsWith('/recordings/rules') && opts.method === 'POST') return jsonResponse({ id: 3, scheduled: 2 });
            return jsonResponse([]);
        }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('api.js'), context);
    loadUi(context);
    vm.runInContext(js('pages/RecordingsPage.js'), context);
    const page = new context.RecordingsPage({});
    page.renderRules([
        { id: 1, kind: 'sport', match: 'AFL', enabled: true, upcoming: 2 },
        { id: 2, kind: 'series', match: 'Gardening <Australia>', channelName: 'ABC', newOnly: true, enabled: false, upcoming: 0 }
    ]);
    const html = elements['recording-rules-list'].innerHTML;
    assert.match(html, /Every game: AFL/);
    assert.match(html, /<span class="pig-amount">2<\/span> recordings scheduled/);
    assert.match(html, /Series: Gardening &lt;Australia&gt; on ABC \(new episodes only\)/, 'escaped');
    assert.match(html, /data-action="toggle-rule" data-id="2" data-enabled="false"[^>]*>Turn on/);
    assert.match(html, /data-action="delete-rule" data-id="1"/);
    assert.match(elements['rules-count'].innerHTML, /<span class="pig-amount">2<\/span> rules/);
    assert.equal(elements['rules-sub'].hidden, true);

    await page.addSportRule();
    assert.deepEqual(bodies[0], { kind: 'sport', match: 'Collingwood' });
    assert.equal(elements['rule-add-match'].value, '');
    assert.equal(elements['rule-add-status'].textContent, 'Added: 2 games scheduled');
});
