const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #275: the notice (UI.toast) replaces alert(): one pill at a time, info leaves by itself, error stays until closed.
const PUBLIC_JS = path.join(__dirname, '../public/js');
const js = (f) => fs.readFileSync(path.join(PUBLIC_JS, f), 'utf8');

afterEach(() => mock.timers.reset());

function browser(files = [], extra = {}) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const document = createDocument();
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, Date, setInterval: () => 0, clearInterval() {},
        localStorage: { getItem: () => 'tok' }, ...extra
    });
    context.window = context;
    loadUi(context, { realToast: true });
    for (const f of files) vm.runInContext(js(f), context);
    const pills = () => document.body.querySelectorAll('.ui-toast');
    const open = () => pills().filter(p => p.classList.contains('is-open'));
    return { context, document, UI: vm.runInContext('UI', context), pills, open,
        text: () => open().map(p => p.querySelector('.ui-toast-text').textContent) };
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? (d.name === 'vendor' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
}

test('no alert() call remains under public/js (comments excluded)', () => {
    const hits = [];
    for (const f of walk(PUBLIC_JS)) {
        const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w'"`])\/\/.*$/gm, '$1');
        if (/(^|[^.\w])alert\s*\(/.test(code)) hits.push(path.relative(PUBLIC_JS, f));
    }
    assert.deepEqual(hits, []);
});

test('the two live regions are in the page from load, empty, and not taking focus', () => {
    const { pills } = browser();
    const [status, alert] = pills();
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(alert.getAttribute('role'), 'alert');
    assert.equal(status.querySelector('.ui-toast-text').textContent, '');
    assert.equal(alert.querySelector('.ui-toast-text').textContent, '');
});

test('info leaves by itself after 5 s; with an action after 10 s; an error stays until it is closed', () => {
    const { UI, open } = browser();
    UI.toast('Saved');
    assert.equal(open().length, 1);
    mock.timers.tick(4900);
    assert.equal(open().length, 1);
    mock.timers.tick(200);
    assert.equal(open().length, 0, 'gone after 5 s');

    UI.toast('Channel hidden', { action: { label: 'Undo', run() {} } });
    mock.timers.tick(9000);
    assert.equal(open().length, 1);
    mock.timers.tick(1500);
    assert.equal(open().length, 0, 'gone after 10 s');

    UI.toast('Could not save', { kind: 'error' });
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(open().length, 1, 'an error stays');
    open()[0].querySelector('.ui-toast-close').click();
    assert.equal(open().length, 0);
});

test('an error has a close button with a name; Escape closes a notice only when focus is inside it', () => {
    const { UI, open, document, pills } = browser();
    UI.toast('Could not save', { kind: 'error' });
    const close = open()[0].querySelector('.ui-toast-close');
    assert.equal(close.getAttribute('aria-label'), 'Close notice');
    assert.equal(close.hidden, false);
    assert.equal(pills()[0].querySelector('.ui-toast-close').hidden, true, 'an info notice has no close button');
    assert.equal(document.activeElement, document.body, 'it does not take focus');
    document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(open().length, 1, 'Escape elsewhere leaves it');
    open()[0].dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(open().length, 0, 'Escape inside it closes it');
});

test('the timer pauses while the pointer is over the notice or focus is inside it', () => {
    const { UI, open } = browser();
    UI.toast('Saved');
    const pill = open()[0];
    mock.timers.tick(3000);
    pill.dispatchEvent(new FakeEvent('mouseenter', { bubbles: false }));
    mock.timers.tick(20000);
    assert.equal(open().length, 1, 'held open while hovered');
    pill.dispatchEvent(new FakeEvent('mouseleave', { bubbles: false }));
    mock.timers.tick(1500);
    assert.equal(open().length, 1, 'it resumes with the time it had left (at least 1 s)');
    mock.timers.tick(1500);
    assert.equal(open().length, 0);
    UI.toast('Again');
    const p2 = open()[0];
    p2.dispatchEvent(new FakeEvent('focusin'));
    mock.timers.tick(20000);
    assert.equal(open().length, 1, 'held open while focus is inside');
});

test('one at a time: a new notice replaces the current one, of either kind', () => {
    const { UI, open, text } = browser();
    UI.toast('First');
    UI.toast('Second');
    assert.deepEqual(text(), ['Second']);
    UI.toast('Broken', { kind: 'error' });
    assert.deepEqual(text(), ['Broken']);
    assert.equal(open().length, 1);
    UI.toast('Third');
    assert.deepEqual(text(), ['Third']);
    mock.timers.tick(5100);
    assert.equal(open().length, 0, 'the replaced notices left no timer that closes the new one early or late');
});

test('the action runs and closes the notice; a rejected action shows an error notice', async () => {
    const { UI, open, text } = browser();
    let ran = 0;
    UI.toast('Channel hidden', { action: { label: 'Undo', run: () => { ran++; } } });
    open()[0].querySelector('.ui-toast-action').click();
    assert.equal(ran, 1);
    assert.equal(open().length, 0);

    UI.toast('Channel hidden', { action: { label: 'Undo', run: async () => { throw new Error('offline'); } } });
    open()[0].querySelector('.ui-toast-action').click();
    await new Promise(setImmediate);
    assert.deepEqual(text(), ['Could not undo.'], 'what failed, never the raw error');
    assert.equal(open()[0].getAttribute('role'), 'alert');
});

test('the message is set as text: markup in it creates no element', () => {
    const { UI, open, document } = browser();
    UI.toast('<img src=x onerror="window.pwned=1">', { kind: 'error' });
    assert.equal(open()[0].querySelector('.ui-toast-text').textContent, '<img src=x onerror="window.pwned=1">');
    assert.equal(document.body.querySelectorAll('img').length, 0);
    assert.equal(open()[0].querySelector('.ui-toast-text').children.length, 0);
});

function hidingBrowser() {
    const calls = [];
    const b = browser(['components/ChannelList.js']);
    const gate = {};
    b.context.API = { channels: {
        hide: async (...a) => { calls.push(['hide', ...a]); if (b.context.failHide) throw new Error('not allowed'); },
        show: async (...a) => { calls.push(['show', ...a]); if (gate.hold) await gate.hold; }
    } };
    const list = Object.create(b.context.window.ChannelList.prototype);
    list.sourceSelect = { value: 'x:1' };
    list.channels = [{ id: 'a', sourceId: 1 }, { id: 'b', sourceId: 1 }, { id: 'c', sourceId: 1 }];
    let renders = 0; list.render = () => { renders++; };
    // What the selector change does: replace the list with the chosen provider's rows.
    const reloads = [];
    list.loadChannels = async () => { reloads.push(list.sourceSelect.value); list.channels = list.sourceSelect.value === 'x:2' ? [{ id: 'z', sourceId: 2 }] : [{ id: 'a', sourceId: 1 }, { id: 'b', sourceId: 1 }, { id: 'c', sourceId: 1 }]; };
    return { b, calls, gate, list, reloads, renders: () => renders };
}
const undoButton = (b) => b.open()[0].querySelector('.ui-toast-action');

test('hiding a channel says so with Undo, and Undo (same provider, list unchanged) puts the row back in its place', async () => {
    const { b, calls, list, reloads, renders } = hidingBrowser();
    await list.hideChannel('1', 'b');
    assert.deepEqual(list.channels.map(c => c.id), ['a', 'c']);
    assert.deepEqual(b.text(), ['Channel hidden']);
    assert.equal(undoButton(b).textContent, 'Undo');
    undoButton(b).click();
    await new Promise(setImmediate);
    assert.deepEqual(calls, [['hide', 1, 'channel', 'b'], ['show', 1, 'channel', 'b']]);
    assert.deepEqual(list.channels.map(c => c.id), ['a', 'b', 'c'], 'the row is back where it was');
    assert.deepEqual(reloads, [], 'no reload was needed');
    assert.ok(renders() >= 2);
});

test('a failed hide is an error notice and leaves the list alone', async () => {
    const { b, list } = hidingBrowser();
    b.context.failHide = true;
    await list.hideChannel('1', 'a');
    assert.deepEqual(list.channels.map(c => c.id), ['a', 'b', 'c']);
    assert.deepEqual(b.text(), ['Could not hide the channel.']);
    assert.equal(b.open()[0].getAttribute('role'), 'alert');
});

test('Undo after the provider was switched reloads the list for the chosen provider: the old row is not spliced in', async () => {
    const { b, list, reloads } = hidingBrowser();
    await list.hideChannel('1', 'b');
    list.sourceSelect.value = 'x:2';
    await list.loadChannels(); // the selector change
    undoButton(b).click();
    await new Promise(setImmediate);
    assert.deepEqual(list.channels.map(c => c.id), ['z'], 'only the selected provider\'s channels');
    assert.deepEqual(reloads, ['x:2', 'x:2']);
});

test('Undo whose show request is still pending when the provider is switched ends with the chosen provider\'s list only', async () => {
    const { b, gate, list } = hidingBrowser();
    await list.hideChannel('1', 'b');
    let release; gate.hold = new Promise(r => { release = r; });
    undoButton(b).click();
    await new Promise(setImmediate);
    list.sourceSelect.value = 'x:2';
    await list.loadChannels(); // the selector change while the show request is pending
    release();
    await new Promise(setImmediate);
    assert.deepEqual(list.channels.map(c => c.id), ['z']);
});

test('Sport: a scheduled watch cancelled by closing the page is told once, when Sport is next shown, and only then', async () => {
    const b = browser(['pages/SportsPage.js'], { API: { request: async () => ({ features: { sportsDashboard: true } }), sports: {} } });
    const page = Object.create(b.context.window.SportsPage.prototype);
    Object.assign(page, {
        cards: new Map(), shelves: new Map(), orders: new Map(), recordings: [], recordingsVisit: 0, root: null,
        state: { active: false, serial: 1, identity: () => 'me', valid: () => true, clear() {}, load: async () => true },
        setup() {}, watchRecordings() {}, poll() {}, closeDialog() {}
    });
    await page.show();
    assert.deepEqual(b.text(), [], 'nothing to tell when no watch was scheduled');
    page.hide(); await page.show();
    assert.deepEqual(b.text(), [], 'closing and reopening with no pending watch says nothing');

    page.waiting = setTimeout(() => {}, 60000); // a scheduled "watch when it starts"
    page.hide();
    assert.equal(page.waiting, null, 'the cancelling itself is unchanged');
    assert.deepEqual(b.text(), [], 'nothing while Sport is closed');
    await page.show();
    assert.deepEqual(b.text(), ['Scheduled watch cancelled because Sport was closed']);
    b.UI.toast('later');
    page.hide(); await page.show();
    assert.deepEqual(b.text(), ['later'], 'told once');
});

// #276: the Recordings page sends a delete only when its Undo notice ends without Undo, so the notice says how it ended.
test('onEnd says how a notice ended: timeout, action, replaced or closed, once each', () => {
    const { UI, open } = browser();
    const ends = [];
    UI.toast('Recording deleted', { action: { label: 'Undo', run() {} }, onEnd: (why) => ends.push(['a', why]) });
    mock.timers.tick(10100);
    assert.deepEqual(ends, [['a', 'timeout']]);

    UI.toast('Recording deleted', { action: { label: 'Undo', run() { ends.push(['b', 'ran']); } }, onEnd: (why) => ends.push(['b', why]) });
    open()[0].querySelector('.ui-toast-action').click();
    assert.deepEqual(ends.slice(1), [['b', 'action'], ['b', 'ran']], 'the end is reported before the action runs');

    UI.toast('First', { action: { label: 'Undo', run() {} }, onEnd: (why) => ends.push(['c', why]) });
    const handle = UI.toast('Second', { action: { label: 'Undo', run() {} }, onEnd: (why) => ends.push(['d', why]) });
    assert.deepEqual(ends.slice(3), [['c', 'replaced']]);
    handle.close();
    handle.close();
    assert.deepEqual(ends.slice(4), [['d', 'closed']], 'a second close reports nothing');
    mock.timers.tick(20000);
    assert.equal(ends.length, 5, 'no timer reports an ended notice again');
});
