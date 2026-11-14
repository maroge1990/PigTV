const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument } = require('./helpers/fakeDom');

// #62: a programme that is scheduled to record (or recording now) carries a record mark on its guide cell, with a text
// alternative, from GET /api/recordings/scheduled. The marks follow the schedules without redrawing the grid.
const js = (f) => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8');

function browser(scheduledRows) {
    const document = createDocument();
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, setInterval: () => 7, clearInterval() {},
        API: { recordings: { getScheduledWithRecent: async () => { if (scheduledRows instanceof Error) throw scheduledRows; return scheduledRows; } } },
        localStorage: { getItem: () => 'tok' }, CSS: { escape: (s) => s }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('components/EpgGuide.js'), context);
    const guide = Object.create(context.EpgGuide.prototype);
    Object.assign(guide, { schedules: [], pixelsPerMinute: 1 });
    return { context, document, guide };
}
const HOUR = 3600000;
const at = Date.now() + 2 * HOUR;
const prog = (title, startMs) => ({ title, description: '', start: new Date(startMs).toISOString(), stop: new Date(startMs + HOUR).toISOString(), startMs, stopMs: startMs + HOUR });
const channel = { id: 'pos_4', sourceId: 1, name: 'ABC' };
const row = (over) => ({ id: 9, status: 'scheduled', source_id: 1, channel_item_id: 'pos_4', program_start: at, program_end: at + HOUR, ...over });
const cells = (html) => html.split('<div class="epg-program ').slice(1);

test('a scheduled programme gets a record mark with a text alternative; others get none', async () => {
    const { guide } = browser([row(), row({ id: 10, status: 'cancelled', program_start: at + 5 * HOUR }), row({ id: 11, status: 'completed', program_start: at + 9 * HOUR })]);
    assert.equal(await guide.loadSchedules(), true);
    assert.equal(guide.schedules.length, 1, 'only schedules that are waiting or recording count');
    const html = guide.renderProgrammes([prog('Derby', at), prog('News', at + HOUR)], new Date(at - HOUR), new Date(at + 4 * HOUR), channel);
    const [derby, news] = cells(html);
    assert.match(derby, /class="epg-rec-mark"[^>]*role="img"[^>]*aria-label="Recording scheduled"/);
    assert.match(derby, /aria-label="Derby, [^"]*, recording scheduled: details"/, 'the cell says it too');
    assert.doesNotMatch(news, /epg-rec-mark/);
    assert.doesNotMatch(news, /recording scheduled/);
});

test('a recording in progress says Recording now', async () => {
    const { guide } = browser([row({ status: 'recording', program_start: at - 600000 })]);
    await guide.loadSchedules();
    const html = guide.renderProgrammes([prog('Derby', at - 600000)], new Date(at - HOUR), new Date(at + HOUR), channel);
    assert.match(html, /epg-rec-mark recording-now"[^>]*aria-label="Recording now"/);
});

test('a programme is told apart by channel and start, not by title', () => {
    const { guide } = browser([]);
    guide.schedules = [row({ source_id: 2 }), row({ id: 12, channel_item_id: 'pos_9' })];
    assert.doesNotMatch(guide.renderProgrammes([prog('Derby', at)], new Date(at - HOUR), new Date(at + HOUR), channel), /epg-rec-mark/, 'another source or channel');
    guide.schedules = [row({ id: 13, program_start: at + 5 * 60000 })];
    assert.doesNotMatch(guide.renderProgrammes([prog('Derby', at)], new Date(at - HOUR), new Date(at + HOUR), channel), /epg-rec-mark/, 'another start');
});

test('a failed read keeps what was known and draws no mark by mistake', async () => {
    const { guide } = browser(new Error('offline'));
    guide.schedules = [row()];
    assert.equal(await guide.loadSchedules(), false);
    assert.equal(guide.schedules.length, 1);
});

test('syncRecordingMarks puts the mark on, and takes it off, a cell already on screen', () => {
    const { guide, document } = browser([]);
    const container = document.createElement('div');
    const cell = document.createElement('div');
    cell.className = 'epg-program'; cell.setAttribute('data-start', new Date(at).toISOString());
    cell.dataset = { sourceId: '1', channelId: 'pos_4', title: 'Der<by', start: new Date(at).toISOString() };
    const title = document.createElement('div'); title.className = 'epg-program-title';
    cell.appendChild(title); container.appendChild(cell);
    guide.container = container;

    guide.schedules = [row()];
    guide.syncRecordingMarks();
    assert.match(title.innerHTML, /^<span class="epg-rec-mark"[^>]*aria-label="Recording scheduled"[^>]*><\/span>Der&lt;by$/);
    assert.match(cell.getAttribute('aria-label'), /recording scheduled: details$/);

    guide.schedules = [];
    guide.syncRecordingMarks();
    assert.equal(title.innerHTML, 'Der&lt;by');
    assert.doesNotMatch(cell.getAttribute('aria-label'), /recording/);
});
