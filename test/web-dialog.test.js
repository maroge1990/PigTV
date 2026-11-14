const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #275: one dialog. UI.dialog is a native <dialog> opened with showModal: Escape (the `cancel` event) and a click on the
// backdrop close it, focus goes back to what opened it, and it is labelled. The pages' dialogs all open through it.
// The fake <dialog> (test/helpers/fakeDom.js) proves the wiring, not the browser: not the real Escape key, the backdrop's
// geometry, focus trapping, inertness of the page behind, scrolling, or fullscreen in the player.
const root = path.join(__dirname, '..');
const js = (f) => fs.readFileSync(path.join(root, 'public/js', f), 'utf8');

function browser(files, extra = {}) {
    const document = createDocument();
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, setInterval: () => 7, clearInterval() {},
        localStorage: { getItem: () => 'tok' }, CSS: { escape: (s) => s }, ...extra
    });
    context.window = context;
    loadUi(context);
    for (const f of files) vm.runInContext(js(f), context);
    return { context, document };
}
const opener = (document, label = 'opener') => {
    const b = document.createElement('button'); b.textContent = label; document.body.appendChild(b); b.focus(); return b;
};
const dialogs = (document) => document.body.querySelectorAll('dialog');

test('UI.dialog.create: labelled by its title, a visible close button, opens modal, Escape and backdrop close, focus returns', () => {
    const { context, document } = browser([]);
    const from = opener(document);
    let closed = 0;
    const d = vm.runInContext('UI', context).dialog.create({ title: 'Hello', onClose: () => { closed++; } });
    d.body.textContent = 'body';
    d.open();
    const el = dialogs(document)[0];
    assert.equal(el.open, true);
    assert.equal(el.getAttribute('aria-labelledby'), el.querySelector('.ui-dialog-title').id);
    assert.equal(el.querySelector('.ui-dialog-title').textContent, 'Hello');
    assert.equal(el.querySelector('.ui-dialog-close').getAttribute('aria-label'), 'Close');
    assert.ok(document.body.classList.contains('ui-dialog-open'), 'the page behind is locked');
    el.escape();
    assert.equal(el.open, false);
    assert.equal(closed, 1);
    assert.equal(document.activeElement, from, 'focus is back on the opener');
    assert.equal(dialogs(document).length, 0, 'the element is gone');
    assert.ok(!document.body.classList.contains('ui-dialog-open'));

    const d2 = vm.runInContext('UI', context).dialog.create({ title: 'Again' });
    d2.open();
    const el2 = dialogs(document)[0];
    el2.click(); // a click inside the box (the dialog's own padding) does not close it
    assert.equal(el2.open, true);
    el2.backdropClick();
    assert.equal(el2.open, false);
    assert.equal(document.activeElement, from);
    const d3 = vm.runInContext('UI', context).dialog.create({ title: 'Third' });
    d3.open();
    dialogs(document)[0].querySelector('.ui-dialog-close').click();
    assert.equal(dialogs(document).length, 0, 'the close button closes it');
});

test('the notice moves into the open dialog (everything outside a modal is inert) and back out', () => {
    const { context, document } = browser([]);
    const UI = vm.runInContext('UI', context);
    const host = document.body.querySelector('.ui-toast-host');
    const d = UI.dialog.create({ title: 'T' });
    d.open();
    assert.equal(host.parentNode, dialogs(document)[0]);
    d.close();
    assert.equal(host.parentNode, document.body);
});

test('Programme details open through UI.dialog; closing returns focus to the programme and runs the guide\'s own focus restore', async () => {
    const { context, document } = browser(['components/EpgGuide.js'], { API: { settings: { get: async () => ({}) } } });
    const epg = Object.create(context.window.EpgGuide.prototype);
    const restored = [];
    epg.focusIdentity = () => ({ id: 'prog-1' });
    epg.restoreFocus = (id) => restored.push(id);
    const from = opener(document, 'programme');
    await epg.showProgramDetails({ title: 'News at Six', start: '2026-11-10T08:00:00Z', stop: '2026-11-10T09:00:00Z', description: 'Headlines', recordable: 'false' });
    const el = dialogs(document)[0];
    assert.equal(el.open, true);
    assert.equal(el.querySelector('.ui-dialog-title').textContent, 'News at Six');
    assert.match(el.querySelector('.ui-dialog-footer').innerHTML, /data-dialog-close/);
    el.escape();
    assert.deepEqual(restored, [{ id: 'prog-1' }]);
    assert.equal(dialogs(document).length, 0);
    assert.equal(document.activeElement, from);
    await epg.showProgramDetails({ title: 'Second', start: '2026-11-10T08:00:00Z', stop: '2026-11-10T09:00:00Z', recordable: 'false' });
    dialogs(document)[0].backdropClick();
    assert.equal(dialogs(document).length, 0, 'a backdrop click closes it too');
});

test('The backup-link picker opens through UI.dialog; Cancel, Escape and a chosen link close it and clear the pick', async () => {
    const calls = [];
    const { context, document } = browser(['pages/ProvidersSettings.js', 'pages/BackupLinksSettings.js'], { API: {
        sources: { backupChannels: async () => [] }, links: { addManual: async (...a) => { calls.push(a); } } } });
    const page = Object.create(context.window.BackupLinksSettings.prototype);
    page.summary = { providers: [{ role: 'backup', backupSourceId: 9, name: 'Backup One', counts: {} }] };
    page.refreshAfterChange = async () => {}; page.setStatus = () => {};
    const channel = { name: 'Fox 505', sourceId: 1, key: 'k' };
    const from = opener(document, 'Link');
    page.openPick(channel, 9);
    assert.equal(dialogs(document).length, 1);
    assert.equal(dialogs(document)[0].querySelector('.ui-dialog-title').textContent, 'Link Fox 505 to a Backup One channel');
    assert.ok(page.pick);
    dialogs(document)[0].querySelector('#modal-cancel').click();
    assert.equal(page.pick, null, 'Cancel clears the pick');
    assert.equal(document.activeElement, from);
    page.openPick(channel, 9);
    dialogs(document)[0].escape();
    assert.equal(page.pick, null, 'Escape clears the pick');
    page.openPick(channel, 9);
    await page.choose('55');
    assert.equal(dialogs(document).length, 0, 'choosing closes it');
    assert.deepEqual(calls, [[1, 'k', 9, '55']]);
});

function editUserPage(extraApi = {}) {
    const updates = [];
    const { context, document } = browser(['pages/Settings.js'], { API: { users: { update: async (...a) => { updates.push(a); if (extraApi.fail) throw new Error('nope'); }, getAll: async () => [] } } });
    // The markup of index.html's Edit user dialog, as the elements the page looks up.
    const make = (tag, id, parent, props = {}) => { const e = document.createElement(tag); if (id) e.id = id; Object.assign(e, props); parent.appendChild(e); return e; };
    const dlg = make('dialog', 'edit-user-modal', document.body);
    dlg.className = 'ui-dialog';
    make('button', null, dlg, { className: 'ui-dialog-close' });
    make('input', 'edit-user-id', dlg, { value: '' }); make('input', 'edit-username', dlg, { value: '' });
    make('select', 'edit-role', dlg, { value: '' }); make('input', 'edit-password', dlg, { value: '' });
    make('p', 'edit-password-hint', dlg);
    const cancel = make('button', 'edit-user-cancel', dlg); cancel.setAttribute('data-dialog-close', '');
    make('button', 'edit-user-save', dlg);
    const page = Object.create(context.window.SettingsPage.prototype);
    page.users = [{ id: 7, username: 'sam', role: 'viewer' }];
    page.loadUsers = () => { page.reloaded = (page.reloaded || 0) + 1; };
    return { page, document, dlg, updates, context };
}

test('Edit user opens through UI.dialog and Escape, the backdrop, the close button and Cancel close it; focus returns to Edit', () => {
    const { page, document, dlg } = editUserPage();
    const edit = opener(document, 'Edit');
    for (const how of ['escape', 'backdrop', 'x', 'cancel']) {
        page.openEditUserModal(7);
        assert.equal(dlg.open, true, how);
        assert.equal(document.getElementById('edit-username').value, 'sam');
        if (how === 'escape') dlg.escape();
        if (how === 'backdrop') dlg.backdropClick();
        if (how === 'x') dlg.querySelector('.ui-dialog-close').click();
        if (how === 'cancel') document.getElementById('edit-user-cancel').click();
        assert.equal(dlg.open, false, how);
        assert.equal(document.activeElement, edit, `${how}: focus is back on Edit`);
    }
    assert.ok(dlg.isConnected, 'the page\'s own dialog element stays');
});

test('Edit user still saves the same payload, closes, and reloads the list; a failure keeps it open and says why', async () => {
    const ok = editUserPage();
    ok.page.openEditUserModal(7);
    ok.document.getElementById('edit-username').value = 'sam2';
    ok.document.getElementById('edit-role').value = 'admin';
    ok.document.getElementById('edit-user-save').onclick();
    await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(JSON.stringify(ok.updates)), [['7', { username: 'sam2', role: 'admin' }]]);
    assert.equal(ok.dlg.open, false);
    assert.equal(ok.page.reloaded, 1);

    const withPassword = editUserPage();
    withPassword.page.openEditUserModal(7);
    withPassword.document.getElementById('edit-password').value = 'secret';
    withPassword.document.getElementById('edit-user-save').onclick();
    await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(JSON.stringify(withPassword.updates)), [['7', { username: 'sam', role: 'viewer', password: 'secret' }]]);

    const bad = editUserPage({ fail: true });
    bad.page.openEditUserModal(7);
    bad.document.getElementById('edit-user-save').onclick();
    await new Promise(setImmediate);
    assert.equal(bad.dlg.open, true);
    assert.deepEqual(bad.context.toasts.map(t => t[0]), ['Could not save the user.'], 'a server fault is not printed to the person (its detail is in the console)');
});

function recordingPlayer() {
    const { context, document } = browser(['pages/RecordingsPage.js'], { API: { recordings: {
        getPosition: async () => ({ position_sec: 0 }), streamUrl: (id) => `/s/${id}`, setPosition: async () => {}, getMarkers: async () => ({ markers: [] })
    }, settings: { get: async () => ({}) } } });
    const real = document.createElement;
    let video;
    document.createElement = (tag) => {
        const el = real(tag);
        if (tag === 'div') {
            Object.defineProperty(el, 'innerHTML', { get() { return this._html || ''; }, set(v) {
                this._html = v;
                if (this.className !== 'recording-player-overlay') return;
                const box = real('div'); box.className = 'recording-player-box';
                const close = real('button'); close.className = 'recording-player-close';
                video = real('video'); video.pause = () => { video.paused = true; video.pauseCalls = (video.pauseCalls || 0) + 1; }; video.src = '/s/1';
                const skip = real('button'); skip.className = 'skip-ad-btn'; const marks = real('div'); marks.className = 'ad-markers';
                [close, video, marks, skip].forEach(c => box.appendChild(c));
                this.appendChild(box);
            } });
        }
        return el;
    };
    const page = Object.create(context.window.RecordingsPage.prototype);
    return { page, document, getVideo: () => video };
}

test('Recording player: Escape, the close button and the backdrop each run the same teardown, and focus returns', async () => {
    for (const how of ['escape', 'button', 'backdrop']) {
        const { page, document, getVideo } = recordingPlayer();
        const from = opener(document, 'Play');
        await page.play(1);
        const overlay = document.body.querySelector('.recording-player-overlay');
        assert.ok(overlay, how);
        assert.equal(overlay.getAttribute('role'), 'dialog');
        assert.equal(overlay.getAttribute('aria-modal'), 'true');
        assert.equal(overlay.getAttribute('aria-label'), 'Recording player');
        assert.ok(page._positionTracker, 'tracking position');
        const video = getVideo();
        if (how === 'escape') document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
        if (how === 'button') overlay.querySelector('.recording-player-close').click();
        if (how === 'backdrop') overlay.dispatchEvent(new FakeEvent('click', { clientX: 0, clientY: 0 }));
        assert.equal(video.pauseCalls, 1, `${how}: playback stopped`);
        assert.equal(video.src, '', `${how}: source released`);
        assert.equal(document.body.querySelector('.recording-player-overlay'), null, `${how}: overlay removed`);
        assert.equal(page._positionTracker, null, `${how}: position tracking stopped`);
        assert.equal(page._onPlayerKey, null, `${how}: key listener removed`);
        assert.equal((document.listeners.keydown || []).length, 0, `${how}: no Escape listener left on the document`);
        assert.equal(document.activeElement, from, `${how}: focus is back`);
    }
});

test('index.html has no .modal-overlay and no #modal; its Edit user dialog is a <dialog>', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.doesNotMatch(html, /modal-overlay/);
    assert.doesNotMatch(html, /id="modal"/);
    assert.match(html, /<dialog class="ui-dialog" id="edit-user-modal" aria-labelledby="edit-user-title">/);
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.doesNotMatch(css, /\.modal-overlay|\.modal-content|\.modal-header|\.modal-footer/);
});

// The global reset (`* { margin: 0 }`) removes a <dialog>'s native centring, so the dialog's own rule must restore it.
// A CSS-text check: the vm tests have no layout. The real proof is a browser (Chromium, 1280x800 and 390x844: the
// Edit user dialog was at [0,0] before and is centred after).
test('.ui-dialog centres itself (margin: auto, outside any media query)', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const topLevel = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    const rule = topLevel.match(/(?:^|\})\s*\.ui-dialog\s*\{([^}]*)\}/);
    assert.ok(rule, 'a top-level .ui-dialog rule');
    assert.match(rule[1], /(^|;|\s)margin:\s*auto\s*;/);
    // #323: the Sport page's dialog is gone (its menu is .sp-menu, in sport.css).
    assert.doesNotMatch(css, /\.sports-dialog/);
});
