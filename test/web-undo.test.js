const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #276 review (Codex high, Opus M2/M3, rig keyboard pass): UI.undoable is the one place a change waits for its Undo
// notice. Each waiting change is sent exactly once: when the notice ends without Undo, or at once, with keepalive, when
// the page goes (pagehide), the tab is hidden, or before sign-out; never after Undo. Focus never falls to the page.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

afterEach(() => mock.timers.reset());

function browser(extra = {}) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const document = createDocument();
    const winListeners = {};
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, Date, setInterval: () => 0, clearInterval() {},
        localStorage: { getItem: () => 'tok', removeItem() {} },
        addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, ...extra
    });
    context.window = context;
    loadUi(context, { realToast: true });
    const UI = vm.runInContext('UI', context);
    const fire = (type, ev = {}) => (winListeners[type] || []).forEach(fn => fn({ type, ...ev }));
    const pill = () => document.body.querySelectorAll('.ui-toast').find(p => p.classList.contains('is-open'));
    const undoButton = () => document.body.querySelector('.ui-toast-info').querySelector('.ui-toast-action');
    const button = (id) => { const b = document.createElement('button'); b.id = id; document.body.appendChild(b); return b; };
    return { context, document, UI, fire, pill, undoButton, button };
}

test('the page going (pagehide) sends every waiting change at once with keepalive, once, and takes its Undo away', async () => {
    const { UI, fire, pill, undoButton } = browser();
    const sent = [];
    UI.undoable('Recording deleted', { commit: (o) => { sent.push(['a', o.keepalive]); } });
    fire('pagehide');
    assert.deepEqual(sent, [['a', true]]);
    assert.equal(pill(), undefined, 'the notice is closed: its Undo is gone');
    fire('pagehide');
    mock.timers.tick(20000);
    await UI.flushPending();
    assert.deepEqual(sent, [['a', true]], 'sent once');
    undoButton().click();
    assert.deepEqual(sent, [['a', true]]);
});

test('the tab becoming hidden sends it too; a visible tab sends nothing', () => {
    const { UI, document, fire } = browser();
    const sent = [];
    UI.undoable('Rule deleted', { commit: (o) => { sent.push(o.keepalive); } });
    fire('visibilitychange'); // it bubbles from the document to the window
    assert.deepEqual(sent, [], 'still visible: it waits for its notice');
    document.hidden = true;
    fire('visibilitychange');
    assert.deepEqual(sent, [true]);
});

test('Undo: never sent, by the notice, a page that goes, or sign-out', async () => {
    const { UI, fire, undoButton } = browser();
    let sent = 0, undone = 0;
    UI.undoable('Unfollowed Arsenal.', { commit: () => { sent++; }, undo: () => { undone++; } });
    undoButton().click();
    fire('pagehide');
    await UI.flushPending();
    mock.timers.tick(20000);
    assert.deepEqual([sent, undone], [0, 1]);
});

test('the notice ending without Undo sends it once, without keepalive; a refused one says so', async () => {
    const { UI, pill } = browser();
    const sent = [];
    UI.undoable('Recording cancelled', { failText: 'Could not cancel it', commit: (o) => { sent.push(o.keepalive); return Promise.reject(Object.assign(new Error('x'), { status: 500 })); } });
    mock.timers.tick(10100);
    await new Promise(setImmediate);
    assert.deepEqual(sent, [false]);
    assert.equal(pill().querySelector('.ui-toast-text').textContent, 'Could not cancel it.');
    await UI.flushPending();
    assert.deepEqual(sent, [false]);
});

test('sign-out sends what waits first, while the sign-in still works, and waits for the answer', async () => {
    const { context, UI } = browser();
    let token = 'tok';
    const log = [];
    context.localStorage = { getItem: () => token, removeItem: () => { token = null; log.push('token removed'); } };
    context.location = { replace: (u) => log.push(`to ${u}`) };
    context.fetch = async (url) => { log.push(`fetch ${url}`); return { ok: true }; };
    vm.runInContext(read('public/js/app.js'), context);
    let finish;
    UI.undoable('Recording deleted', { commit: (o) => { log.push(`commit keepalive=${o.keepalive} token=${context.localStorage.getItem()}`); return new Promise(r => { finish = r; }); } });
    const app = vm.runInContext('Object.create(App.prototype)', context);
    const out = app.signOut();
    await new Promise(setImmediate);
    assert.deepEqual(log, ['commit keepalive=true token=tok'], 'nothing else until the delete has its answer');
    finish();
    await out;
    assert.deepEqual(log, ['commit keepalive=true token=tok', 'fetch /api/auth/logout', 'token removed', 'to /login.html']);
});

test('keyboard: focus goes to Undo; after Undo to the restored item; never to the page', async () => {
    const { UI, document, undoButton, button, fire } = browser();
    const restored = button('restored');
    fire('keydown', { key: 'Enter' });
    document.activeElement = document.body; // the deleted card has gone, focus with it
    UI.undoable('Recording deleted', { undo: () => {}, focus: { undo: () => restored, end: () => null } });
    assert.equal(document.activeElement, undoButton(), 'a keyboard user reaches Undo at once');
    undoButton().click();
    await new Promise(setImmediate);
    assert.equal(document.activeElement, restored);
});

test('keyboard: Escape on the notice ends it, and focus goes to the next item; with none, the page heading', () => {
    const { UI, document, undoButton, button, pill, fire } = browser();
    const next = button('next');
    fire('keydown', { key: 'Enter' });
    UI.undoable('Recording deleted', { commit: () => {}, focus: { end: () => next } });
    pill().dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(document.activeElement, next);

    const page = document.createElement('div'); page.className = 'page active';
    const h = document.createElement('h2'); page.appendChild(h); document.body.appendChild(page);
    fire('keydown', { key: 'Enter' });
    UI.undoable('Rule deleted', { commit: () => {}, focus: { end: () => null } });
    assert.equal(document.activeElement, undoButton());
    pill().dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(document.activeElement, h, 'the heading, made focusable by script');
    assert.equal(h.getAttribute('tabindex'), '-1');
});

test('pointer: focus fallen with the deleted item goes to the next item; a pointer user who moved on keeps focus', () => {
    const { UI, document, button, fire } = browser();
    const next = button('next'), elsewhere = button('elsewhere');
    fire('pointerdown');
    document.activeElement = document.body;
    UI.undoable('Recording deleted', { commit: () => {}, focus: { end: () => next } });
    assert.equal(document.activeElement, next, 'never left on the page');
    elsewhere.focus();
    mock.timers.tick(10100);
    assert.equal(document.activeElement, elsewhere, 'not taken from where the person went');
});

// #276 review (Opus low 8): ui.js and the stylesheets were linked without ?v=, so a deploy could leave a browser on an
// old ui.js under new pages (which call UI.undoable, UI.flushPending...). Every local script and stylesheet has one.
test('every script and stylesheet the two pages load carries a ?v= (a file named by its version excepted)', () => {
    for (const page of ['public/index.html', 'public/login.html']) {
        const html = read(page);
        const refs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"|<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m => m[1] || m[2]);
        assert.ok(refs.length > 2, page);
        for (const ref of refs.filter(r => !r.includes('/vendor/') && !/^https?:/.test(r))) assert.match(ref, /\?v=\d+$/, `${page}: ${ref}`);
    }
});
