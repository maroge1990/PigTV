const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument } = require('./helpers/fakeDom');

// #321 (4): the guide's programme menu follows Apple's: Watch now when the programme is on air, Record or Cancel
// recording as it already is or not, Record every episode, and the buffers under an Options disclosure. One rose
// (primary) button. #321 (5) and #62 are in web-guide-search.test.js and web-guide-recording-marks.test.js.
const js = (f) => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8');

function browser() {
    const document = createDocument();
    const calls = [];
    const API = {
        recordings: {
            schedule: async (body) => { calls.push(['schedule', body]); return {}; },
            addRule: async (body) => { calls.push(['addRule', body]); return { scheduled: 3 }; },
            cancelScheduled: async (id) => { calls.push(['cancel', id]); return {}; },
            getScheduledWithRecent: async () => []
        },
        settings: { get: async () => ({}) }
    };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, setInterval: () => 7, clearInterval() {}, API,
        localStorage: { getItem: () => 'tok' }, CSS: { escape: (s) => s }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('components/EpgGuide.js'), context);
    const guide = Object.create(context.EpgGuide.prototype);
    Object.assign(guide, { schedules: [] });
    const played = [];
    guide.playChannel = async (...args) => { played.push(args); };
    return { context, document, guide, calls, played };
}
const programme = (over = {}) => ({
    title: 'Evening News', description: 'The day <b>in</b> review', channelName: 'ABC', channelId: 'pos_4', sourceId: '1',
    start: new Date(Date.now() - 600000).toISOString(), stop: new Date(Date.now() + 1800000).toISOString(),
    recordable: 'true', ...over
});
const dialogEl = (document) => document.body.querySelectorAll('dialog')[0];
const button = (document, id) => dialogEl(document).querySelector(`#${id}`);

test('a programme on air offers Watch now as the one rose button, and plays it on Live TV', async () => {
    const { document, guide, played } = browser();
    await guide.showProgramDetails(programme());
    const watch = button(document, 'modal-watch');
    assert.ok(watch, 'Watch now');
    assert.ok(watch.classList.contains('btn-primary'));
    assert.equal(dialogEl(document).querySelectorAll('.btn-primary').length, 1, 'only one rose button');
    assert.ok(!button(document, 'modal-record').classList.contains('btn-primary'), 'Record steps back');
    watch.onclick({});
    assert.deepEqual(played, [['ABC', 'pos_4', '1']]);
    assert.equal(dialogEl(document), undefined, 'the menu closes');
});

test('a programme that has not started has no Watch now; Record is the rose button', async () => {
    const { document, guide } = browser();
    await guide.showProgramDetails(programme({ start: new Date(Date.now() + 3600000).toISOString(), stop: new Date(Date.now() + 7200000).toISOString() }));
    assert.equal(button(document, 'modal-watch'), null);
    assert.ok(button(document, 'modal-record').classList.contains('btn-primary'));
});

test('an already scheduled programme says so and offers Cancel recording, not Record', async () => {
    const { document, guide, calls } = browser();
    const p = programme();
    guide.schedules = [{ id: 41, status: 'scheduled', source_id: 1, channel_item_id: 'pos_4', program_start: Date.parse(p.start) }];
    await guide.showProgramDetails(p);
    assert.equal(button(document, 'modal-record'), null);
    assert.match(dialogEl(document).querySelector('.ui-dialog-body').innerHTML, /id="programme-menu-status"[^>]*>\s*Recording scheduled/);
    button(document, 'modal-cancel-recording').onclick({});
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [['cancel', 41]]);
});

test('Record every episode adds a series rule; the buffers sit under an Options disclosure that holds them', async () => {
    const { document, guide, calls } = browser();
    await guide.showProgramDetails(programme());
    const options = button(document, 'record-options');
    assert.equal(options.tagName.toLowerCase(), 'details');
    assert.match(dialogEl(document).querySelector('.ui-dialog-body').innerHTML, /<summary>Options<\/summary>/);
    assert.match(dialogEl(document).querySelector('.ui-dialog-body').innerHTML.replace(/\s+/g, ' '), /<summary>Options<\/summary>.*record-pre-buffer.*record-post-buffer/);
    button(document, 'record-pre-buffer').value = '2'; button(document, 'record-post-buffer').value = '10';
    button(document, 'modal-record-series').onclick({});
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[0][0], 'addRule');
    assert.deepEqual({ kind: calls[0][1].kind, match: calls[0][1].match, sourceId: calls[0][1].sourceId, channelId: calls[0][1].channelId,
        pre: calls[0][1].preBufferMin, post: calls[0][1].postBufferMin }, { kind: 'series', match: 'Evening News', sourceId: 1, channelId: 'pos_4', pre: 2, post: 10 });
});

test('a bad buffer opens Options and sends nothing; the description is escaped', async () => {
    const { document, guide, calls } = browser();
    await guide.showProgramDetails(programme({ start: new Date(Date.now() + 3600000).toISOString(), stop: new Date(Date.now() + 7200000).toISOString() }));
    assert.doesNotMatch(dialogEl(document).querySelector('.ui-dialog-body').innerHTML, /<b>in<\/b>/);
    button(document, 'record-post-buffer').value = '5';
    button(document, 'record-pre-buffer').value = 'abc'; button(document, 'record-pre-buffer').insertAdjacentElement = () => {}; // the fake has no field-error host
    button(document, 'modal-record').onclick({});
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
    assert.equal(button(document, 'record-options').open, true);
});

test('a recording in progress says Stop recording and waits 10 s behind an Undo before it stops anything', async () => {
    const { document, guide, calls, context } = browser();
    const requests = [];
    context.API.request = async (...a) => { requests.push(a.slice(0, 2)); return {}; };
    const undoables = [];
    context.UI.undoable = (message, opts) => { undoables.push({ message, ...opts }); };
    const p = programme();
    const row = { id: 41, status: 'recording', source_id: 1, channel_item_id: 'pos_4', program_start: Date.parse(p.start) };
    guide.schedules = [row];
    await guide.showProgramDetails(p);
    const stop = button(document, 'modal-cancel-recording');
    assert.match(dialogEl(document).querySelector('.ui-dialog-footer').innerHTML, />Stop recording</);
    stop.onclick({});
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(requests, [], 'nothing is sent at once');
    assert.deepEqual(calls, []);
    assert.equal(undoables.length, 1);
    assert.equal(guide.schedules.length, 0);
    undoables[0].undo();
    assert.ok(guide.schedules.length === 1 && guide.schedules[0] === row, 'Undo puts it back');
    await undoables[0].commit();
    assert.deepEqual(requests, [['DELETE', '/recordings/scheduled/41']]);
});
