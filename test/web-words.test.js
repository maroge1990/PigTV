const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #276 (findings B4-B6, C2, C9, C12-C14 of the 10 Nov audit): the words, the figures, Undo in place of questions, where am
// I (title and address), no waits on the input path, inline validation, and the guide's column resize by pointer. The
// rules about strings themselves (glossary, sentence case, one primary per screen) are in web-static-strings.test.js.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

function sandbox(extra = {}) {
    const logged = [];
    const context = vm.createContext({ console: { ...console, log() {}, warn() {}, error: (...a) => logged.push(a) }, window: {}, setTimeout, clearTimeout, ...extra });
    loadUi(context);
    context.logged = logged;
    return context;
}

// ---- UI.errorText ----------------------------------------------------------------------------------------------------

test('errorText: what could not be done; the server\'s sentence only when it worded one for people (4xx)', () => {
    const c = sandbox();
    const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});
    const text = (e, fallback) => vm.runInContext('UI.errorText', c)(e, fallback);
    assert.equal(text(err('Username is already taken', 400), 'Could not add the user.'), 'Could not add the user. Username is already taken.');
    assert.equal(text(err('Duplicate number 5.', 409), 'The numbers were not saved'), 'The numbers were not saved. Duplicate number 5.', 'a missing full stop is added, none doubled');
    assert.equal(c.logged.length, 0, 'a server sentence is not an error to log');
    // Never to a person: a network failure, a 5xx, a thrown error, a status code, markup, a stack.
    for (const bad of [err('Failed to fetch'), new TypeError("Cannot read properties of undefined (reading 'x')"), err('SQLITE_BUSY: database is locked', 500),
        err('Server responded with 404', 404), err('<html><body>Not Found</body></html>', 404), err('Authentication required', 401), err('x'.repeat(300), 400), null, undefined, 'plain string']) {
        const out = text(bad, 'Could not delete the user.');
        assert.equal(out, 'Could not delete the user.', `fallback alone for ${String(bad && bad.message || bad)}`);
        assert.doesNotMatch(out, /TypeError|Failed to fetch|40\d|50\d|SQLITE|at /);
    }
    assert.equal(c.logged.length, 10, 'and the detail went to the console each time');
    assert.equal(text(err('boom'), 'Could not save'), 'Could not save.', 'a fallback gets its full stop');
    assert.equal(text(err('boom'), ''), 'Something went wrong.');
});

test('no raw err.message is appended to a notice or a status line anywhere in the pages', () => {
    const files = ['app.js', 'pages/Settings.js', 'pages/ProvidersSettings.js', 'pages/BackupLinksSettings.js', 'pages/RecordingsPage.js', 'pages/SportSettings.js',
        'pages/StatusPage.js', 'components/SourceManager.js', 'components/ChannelList.js', 'components/EpgGuide.js'];
    const raw = [];
    for (const f of files) {
        read(`public/js/${f}`).split('\n').forEach((line, i) => {
            if (/console\./.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
            if (/(?:\+|\$\{)\s*(?:err|error|e)\.message|(?:err|error)\.message\s*\|\|/.test(line)) raw.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
        });
    }
    assert.deepEqual(raw, []);
});

// ---- one date and time format ----------------------------------------------------------------------------------------

test('UI.date, UI.dateParts and the year option: the same words as UI.dateTime, in any time zone', () => {
    const UI = sandbox().UI || vm.runInContext('UI', sandbox());
    const at = Date.UTC(2026, 10, 6, 16, 50); // Sat 7 Nov 2026, 3:50 am in Melbourne
    const o = { locale: 'en-AU', timeZone: 'Australia/Melbourne', now: Date.UTC(2026, 5, 1) };
    assert.equal(UI.date(at, o), 'Sat 7 Nov');
    assert.equal(UI.date(at, { ...o, now: Date.UTC(2027, 5, 1) }), 'Sat 7 Nov 2026', 'the year when it is not this year');
    assert.equal(UI.date(at, { ...o, year: true }), 'Sat 7 Nov 2026', 'an expiry date always carries its year');
    assert.deepEqual(plain(UI.dateParts(at, o)), { day: 'Sat 7 Nov', clock: UI.clock(at, o) });
    assert.equal(`${UI.dateParts(at, o).day}, ${UI.dateParts(at, o).clock}`, UI.dateTime(at, o));
    assert.equal(UI.date(null), '');
    assert.equal(UI.date('not a date'), '');
    assert.equal(UI.dateParts(undefined), null);
    assert.doesNotMatch(UI.dateTime(at, o), /:\d\d:\d\d/, 'never seconds');
});

test('the Sport pages\' times are the app\'s one format: "5:30 pm" today, "Sat 5:30 pm" another day, never a made-up one', () => {
    // #323 (SportFrontText.when): the viewer's zone, through UI.clock and UI.date.
    const c = sandbox({ document: { hidden: false, addEventListener() {} }, API: {} });
    vm.runInContext(read('public/js/pages/SportView.js'), c);
    const V = c.window.SportView;
    const UI = vm.runInContext('UI', c);
    const at = Date.UTC(2026, 10, 6, 16, 50);
    assert.equal(V.when(at, at), UI.clock(at), 'today: the time alone');
    assert.equal(V.when(at, at + 3 * 86400000), `${UI.date(at).split(' ')[0]} ${UI.clock(at)}`, 'another day: its weekday and the time');
    assert.equal(V.when(NaN, at), '', 'no time, never a wrong one');
    assert.equal(V.when(undefined, at), '');
    for (const f of ['SportsPage.js', 'SportView.js']) assert.doesNotMatch(read(`public/js/pages/${f}`), /toLocale(Date|Time)?String/);
});

test('Status shows no seconds in a time; providers and reminders use the one date', () => {
    const c = sandbox({ document: { getElementById: () => null, addEventListener() {} }, API: {} });
    vm.runInContext(read('public/js/pages/StatusPage.js'), c);
    const page = Object.create(c.window.StatusPage.prototype);
    const at = new Date(2026, 10, 7, 15, 50, 42).getTime();
    assert.doesNotMatch(page.timeText(at), /:\d\d:\d\d/);
    assert.match(page.timeText(at), /3:50|15:50/);
    assert.match(page.when(at - 3 * 86400000), /pig-amount/, 'a figure carries pig-amount');
    const d = sandbox();
    vm.runInContext(read('public/js/providerReminders.js'), d);
    const noon = new Date(2027, 2, 30, 12).getTime(); // local noon: the same date in any zone
    assert.match(d.window.ProviderReminders.lines([{ name: 'Trex', daysLeft: 5, expiresAt: noon }])[0], /^Trex expires Tue 30 Mar 2027 \(in 5 days\)\./);
    assert.doesNotMatch(read('public/js/providerReminders.js'), /toLocale/);
    assert.doesNotMatch(read('public/js/pages/ProvidersSettings.js'), /MONTHS|DAYS/);
});

// ---- Undo in place of a question -------------------------------------------------------------------------------------

test('UI.undoable: the change is already made; Undo puts it back and nothing is sent; any other end commits once', async () => {
    const c = sandbox();
    const calls = [];
    const run = (opts) => vm.runInContext('(o) => UI.undoable("Stopped following AFL.", o)', c)(opts);
    run({ undo: () => calls.push('undo'), commit: () => calls.push('commit') });
    let [message, options] = c.toasts.at(-1);
    assert.equal(message, 'Stopped following AFL.');
    assert.equal(options.action.label, 'Undo');
    await options.action.run(); options.onEnd('action');
    await settle();
    assert.deepEqual(calls, ['undo'], 'Undo: no commit');
    for (const why of ['timeout', 'replaced', 'closed']) {
        calls.length = 0;
        run({ undo: () => calls.push('undo'), commit: () => calls.push('commit') });
        c.toasts.at(-1)[1].onEnd(why); c.toasts.at(-1)[1].onEnd(why);
        await settle();
        assert.deepEqual(calls, ['commit'], `${why}: committed once`);
    }
    // A failed commit is a plain notice.
    run({ commit: async () => { throw Object.assign(new Error('Not allowed'), { status: 403 }); }, failText: 'Could not finish.' });
    c.toasts.at(-1)[1].onEnd('timeout');
    await settle();
    assert.deepEqual(plain(c.toasts.at(-1)), ['Could not finish. Not allowed.', { kind: 'error' }]);
});

test('the Settings confirm that sat on an Undo is gone: undoing automatic mappings happens at once', async () => {
    const c = sandbox({ document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
        confirm: () => { throw new Error('asked'); }, API: { epg: { autoMapUndo: async (b) => { c.undone = b; return { removed: 3 }; } } } });
    vm.runInContext(read('public/js/pages/Settings.js'), c);
    const page = Object.create(c.window.SettingsPage.prototype);
    const statuses = [];
    Object.assign(page, { loadEpgMatching: async () => {}, previewAutoMap: async () => {}, setEpgStatus: (t) => statuses.push(t) });
    await page.undoAutoMap('b1');
    assert.equal(c.undone, 'b1');
    assert.match(statuses[0], /^3 automatic mappings undone\./);
    assert.doesNotMatch(read('public/js/pages/Settings.js'), /confirm\('Undo these automatic mappings/);
});

test('no question is left for an action that can be put back; the ones that cannot name the action and what goes with it', () => {
    const asks = {};
    for (const f of ['pages/Settings.js', 'pages/ProvidersSettings.js', 'pages/BackupLinksSettings.js', 'pages/SportSettings.js', 'pages/StatusPage.js', 'pages/RecordingsPage.js']) {
        const src = read(`public/js/${f}`);
        asks[f] = [...src.matchAll(/(?:window\.)?confirm\(\s*([`'"])([\s\S]*?)\1/g)].map((m) => m[2]);
    }
    assert.deepEqual(asks['pages/SportSettings.js'], [], 'sport, league, team and recording-rule changes are Undo');
    assert.deepEqual(asks['pages/BackupLinksSettings.js'], [], 'approving a category\'s links is Undo');
    for (const [file, questions] of Object.entries(asks)) {
        for (const q of questions) {
            assert.doesNotMatch(q, /^Are you sure/i, `${file}: "${q.slice(0, 60)}"`);
            assert.ok(/\?/.test(q), `${file}: a question: ${q.slice(0, 60)}`);
        }
    }
    const all = Object.values(asks).flat().join('\n');
    assert.match(all, /Delete the user .*The account is removed and cannot be brought back/);
    assert.match(all, /Sign this device out\? It will need to sign in again/);
    assert.match(all, /Stop every live stream\? Anyone watching is cut off/);
});

// ---- where am I ------------------------------------------------------------------------------------------------------

function appWithSettings() {
    const calls = [];
    const doc = { title: 'PigTV', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] };
    const c = sandbox({ document: doc, API: {}, history: { pushState: (s, _, u) => { calls.push(['push', plain(s), u]); c.window.location.hash = u; }, replaceState: (s, _, u) => { calls.push(['replace', plain(s), u]); c.window.location.hash = u; } } });
    c.window.location = { hash: '' };
    vm.runInContext(read('public/js/app.js'), c);
    vm.runInContext(read('public/js/pages/Settings.js'), c);
    const app = vm.runInContext('Object.create(App.prototype)', c);
    const settings = Object.create(c.window.SettingsPage.prototype);
    const panels = [];
    const active = [];
    const el = (extra) => ({ classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, ...extra });
    Object.assign(settings, {
        app, tabs: ['providers', 'channels', 'playback', 'recording', 'sports', 'system'].map((t) => el({ dataset: { tab: t } })),
        tabContents: [], loadPanel: (p) => panels.push(p), isAdmin: () => true, providers: { load() {} }, openedOnce: false
    });
    const pages = { live: {}, guide: {}, sports: {}, recordings: {}, status: {}, settings };
    Object.assign(app, { pages, currentPage: 'live', currentUser: { role: 'admin' } });
    return { c, app, settings, calls, doc, panels, active };
}

test('Settings tabs, sub-tabs and Backup links are in the address; the title follows', () => {
    const { app, settings, calls, doc } = appWithSettings();
    app.currentPage = 'settings';
    settings.switchTab('recording');
    assert.deepEqual(calls.at(-1), ['push', { page: 'settings', sub: 'recording' }, '#settings/recording']);
    assert.equal(doc.title, 'Settings · Recording · PigTV');
    settings.switchTab('lineup');
    assert.equal(calls.at(-1)[2], '#settings/channels/lineup');
    assert.equal(doc.title, 'Settings · Channels · Channel numbers · PigTV');
    settings.switchTab('epg');
    assert.equal(calls.at(-1)[2], '#settings/channels/epg');
    settings.switchTab('channels');
    assert.equal(calls.at(-1)[2], '#settings/channels/epg', 'Channels opens on the sub-tab it was left on');
    settings.switchTab('sports');
    assert.equal(calls.at(-1)[2], '#settings/sport', 'the tab is Sport, the address too');
    assert.equal(doc.title, 'Settings · Sport · PigTV');
    settings.showBackupLinks = settings.showBackupLinks.bind(settings);
    settings.backupLinks = { filters: {} };
    settings.showBackupLinks(4);
    assert.equal(calls.at(-1)[2], '#settings/providers/backup-links');
    assert.equal(doc.title, 'Settings · Providers · Backup links · PigTV');
    const before = calls.length;
    settings.switchTab('system'); settings.switchTab('system');
    assert.equal(calls.length, before + 1, 'the same place twice writes one entry');
});

test('a reload and Back/Forward return to the same Settings tab', () => {
    const { c, app, settings, calls, panels } = appWithSettings();
    // Reload on #settings/channels/lineup: the start-up route replaces the entry and opens that tab.
    const route = app.parseHash('settings/channels/lineup');
    assert.deepEqual(plain(route), { page: 'settings', sub: 'channels/lineup' });
    app.navigateTo(route.page, 'replace', route.sub);
    assert.deepEqual(calls.at(-1), ['replace', { page: 'settings', sub: 'channels/lineup' }, '#settings/channels/lineup']);
    assert.equal(settings.path, 'channels/lineup');
    assert.deepEqual(panels, ['lineup']);
    // An unknown tab lands on the default; the page itself is still Settings.
    const odd = appWithSettings();
    odd.app.navigateTo('settings', 'replace', odd.app.parseHash('settings/nonsense').sub);
    assert.equal(odd.settings.path, 'providers');
    // Back to a tab: popstate carries {page, sub}; nothing is pushed or replaced.
    settings.switchTab('recording');
    calls.length = 0;
    app.navigateTo('settings', 'none', 'playback');
    assert.equal(settings.path, 'playback');
    app.navigateTo('settings', 'none', 'channels/epg');
    assert.equal(settings.path, 'channels/epg');
    assert.deepEqual(calls, [], 'Back and Forward write no history');
    // Leaving and coming back lands on the tab left, in the address too.
    app.navigateTo('guide', 'push');
    assert.equal(calls.at(-1)[2], '#guide');
    app.navigateTo('settings', 'push');
    assert.equal(calls.at(-1)[2], '#settings/channels/epg');
    // The retired #home and a hash with nothing behind it are Live TV.
    assert.equal(app.parseHash('home').page, 'live');
    assert.deepEqual(plain(app.parseHash('settings/')), { page: 'settings' });
    assert.equal(c.window.location.hash, '#settings/channels/epg');
});

test('document.title names the page: "Live TV · PigTV", "TV Guide · PigTV", "Sport · PigTV"', () => {
    const { app, doc } = appWithSettings();
    const titles = {};
    for (const [page, title] of [['guide', 'TV Guide · PigTV'], ['sports', 'Sport · PigTV'], ['recordings', 'Recordings · PigTV'], ['status', 'Status · PigTV'], ['live', 'Live TV · PigTV']]) {
        app.navigateTo(page, 'push');
        titles[page] = doc.title;
        assert.equal(doc.title, title);
    }
    app.navigateTo('settings', 'push');
    assert.equal(doc.title, 'Settings · Providers · PigTV');
});

test('Live TV has a page heading for assistive technology that the layout does not draw', () => {
    const html = read('public/index.html');
    const live = html.slice(html.indexOf('id="page-live"'), html.indexOf('id="page-guide"'));
    assert.match(live, /<h2 class="visually-hidden">Live TV<\/h2>/);
    assert.match(read('public/css/main.css'), /\.visually-hidden\s*\{[^}]*position:\s*absolute[^}]*clip:/);
    // The Sport page's "Choose your sport" goes by the address.
    assert.match(read('public/js/pages/SportsPage.js'), /navigateTo\('settings', 'push', 'sport'\)/);
});

// ---- no waits on the input path --------------------------------------------------------------------------------------

test('C2: the drawer closes in the tap, the guide does not sleep, the details open before the settings arrive, local filters do not debounce', () => {
    const app = read('public/js/app.js');
    const drawer = app.slice(app.indexOf("channelSidebar.addEventListener('click'"), app.indexOf('// Desktop sidebar collapse'));
    assert.match(drawer, /classList\.remove\('active'\)/);
    assert.doesNotMatch(drawer, /setTimeout/);
    const guide = read('public/js/components/EpgGuide.js');
    assert.doesNotMatch(guide, /setTimeout\(\s*r\s*,\s*100\s*\)/);
    assert.match(guide, /await window\.app\.navigateTo\('live'\)/, 'it waits for the page, not for a number of milliseconds');
    const details = guide.slice(guide.indexOf('async showProgramDetails'), guide.indexOf('async scheduleRecording') > 0 ? guide.indexOf('scheduleRecording(data) {') : undefined);
    assert.ok(details.indexOf('dialog.open(opener)') > 0 && details.indexOf('dialog.open(opener)') < details.indexOf('API.settings.get()'), 'the dialog opens first');
    assert.doesNotMatch(details, /await API\.settings\.get\(\)/);
    assert.doesNotMatch(guide.slice(guide.indexOf('this.searchInput.addEventListener')), /^[^;]*debounce/, 'guide search');
    assert.doesNotMatch(read('public/js/components/ChannelList.js'), /searchInput\.addEventListener\('input', UI\.debounce/);
    const settings = read('public/js/pages/Settings.js');
    assert.doesNotMatch(settings, /lineup-search'\);\s*search\?\.addEventListener\('input', UI\.debounce/);
    assert.doesNotMatch(settings, /filter\?\.addEventListener\('input', UI\.debounce/);
    assert.match(settings, /search\?\.addEventListener\('input', UI\.debounce\(\(\) => this\.searchEpgChannels/, 'the network search keeps its pause');
});

// ---- inline validation -----------------------------------------------------------------------------------------------

function fakeInput(props = {}) {
    const attrs = new Map();
    return Object.assign({ attrs, after: null, setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); },
        insertAdjacentElement(_, el) { this.after = el; el.remove = () => { this.after = null; }; return el; } }, props);
}
const fakeDocument = () => ({ createElement: () => ({ setAttribute(k, v) { this[`attr_${k}`] = v; } }), getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] });

test('UI.fieldError and UI.readWholeNumber: the reason sits under the field; nothing is rounded, replaced or clamped', () => {
    const c = sandbox({ document: fakeDocument() });
    const UI = vm.runInContext('UI', c);
    const field = (value) => fakeInput({ value, min: '0', max: '60' });
    assert.equal(UI.readWholeNumber(field('15')), 15);
    for (const bad of ['', 'abc', '2.5', '-1', '61', '1e3']) {
        const input = field(bad);
        assert.equal(UI.readWholeNumber(input), null, bad);
        assert.equal(input.after.textContent, 'Enter a whole number from 0 to 60.');
        assert.equal(input.attrs.get('aria-invalid'), 'true');
        assert.equal(input.attrs.get('aria-describedby'), input.after.id);
    }
    const again = field('x');
    UI.readWholeNumber(again);
    again.value = '30';
    assert.equal(UI.readWholeNumber(again), 30);
    assert.equal(again.after, null, 'the line goes when the value is good');
    assert.equal(again.attrs.has('aria-invalid'), false);
});

test('Recording settings: a bad number is refused with a message beside it and nothing is saved (it used to save a default)', async () => {
    const saved = [];
    const inputs = {};
    const doc = { ...fakeDocument(), getElementById: (id) => (inputs[id] ||= fakeInput({ id, value: '', min: '0', max: '60', checked: false })),
        querySelector: () => null };
    const c = sandbox({ document: doc, API: { settings: { update: async (b) => { saved.push(b); } } } });
    vm.runInContext(read('public/js/pages/Settings.js'), c);
    const page = Object.create(c.window.SettingsPage.prototype);
    const set = (id, value, min, max) => Object.assign(doc.getElementById(id), { value, min: String(min), max: String(max) });
    const fill = (over = {}) => {
        const v = { 'dvr-setting-pre': ['1', 0, 60], 'dvr-setting-post': ['5', 0, 120], 'dvr-setting-max': ['1', 1, 10], 'dvr-setting-prompt-timeout': ['3', 1, 60],
            'dvr-setting-minfree': ['10', 0, 10000], 'dvr-setting-bitrate': ['3000', 500, 20000], ...over };
        for (const [id, [value, min, max]] of Object.entries(v)) set(id, value, min, max);
        Object.assign(doc.getElementById('dvr-setting-path'), { value: '/rec' });
        Object.assign(doc.getElementById('dvr-setting-codec'), { value: 'h264' });
    };
    const status = doc.getElementById('dvr-settings-status');
    fill({ 'dvr-setting-pre': ['abc', 0, 60], 'dvr-setting-bitrate': ['100', 500, 20000] });
    await page.saveRecordingSettings();
    assert.deepEqual(saved, [], 'nothing was sent');
    assert.equal(doc.getElementById('dvr-setting-pre').after.textContent, 'Enter a whole number from 0 to 60.');
    assert.equal(doc.getElementById('dvr-setting-bitrate').after.textContent, 'Enter a whole number from 500 to 20,000.');
    assert.match(status.textContent, /Nothing was saved/);
    fill({ 'dvr-setting-pre': ['0', 0, 60] });
    await page.saveRecordingSettings();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].defaultPreBufferMin, 0, 'a typed 0 is 0');
    assert.equal(saved[0].postRecordBitrateKbps, 3000);
    assert.equal(doc.getElementById('dvr-setting-pre').after, null);
});

test('Channel numbers: a duplicate is flagged as it is typed, and Save stays off while one exists', () => {
    const c = sandbox({ document: { ...fakeDocument(), getElementById: (id) => (id === 'lineup-save' ? save : id === 'lineup-status' ? status : null) } });
    const save = { disabled: true }, status = { textContent: '', classList: { toggle() {} } };
    vm.runInContext(read('public/js/pages/Settings.js'), c);
    const page = Object.create(c.window.SettingsPage.prototype);
    Object.assign(page, { lineup: [{ sourceId: 1, id: 'a', name: 'BBC One', number: 1 }, { sourceId: 1, id: 'b', name: 'Sky News', number: 2 }, { sourceId: 1, id: 'c', name: 'Fox', number: 505 }],
        lineupEdits: new Map(), lineupQuery: '' });
    page.editLineupNumber('1:c', '2');
    assert.deepEqual(plain([...page.lineupDuplicates()]), [['1:b', 'Fox'], ['1:c', 'Sky News']], 'both sides name the other');
    page.updateLineupSaveState();
    assert.equal(save.disabled, true, 'Save stays off');
    page.editLineupNumber('1:c', ' 02 ');
    assert.equal(page.lineupDuplicates().size, 2, 'leading zeros are the same number');
    page.editLineupNumber('1:c', '7');
    assert.equal(page.lineupDuplicates().size, 0);
    page.updateLineupSaveState();
    assert.equal(save.disabled, false);
    page.editLineupNumber('1:a', '');
    page.editLineupNumber('1:c', '');
    assert.equal(page.lineupDuplicates().size, 0, 'two empty numbers are not a clash');
    // Moving a number onto another channel's that is itself being changed away is fine.
    page.editLineupNumber('1:b', '9'); page.editLineupNumber('1:c', '2');
    assert.equal(page.lineupDuplicates().size, 0);
});

test('a failed switch save in Settings says so when it flips back', async () => {
    const toggles = {};
    const el = (id) => (toggles[id] ||= { id, checked: false, listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, disabled: false });
    const c = sandbox({ document: { getElementById: el, addEventListener() {}, querySelectorAll: () => [] }, API: { settings: { update: async () => { throw new Error('offline'); } } } });
    vm.runInContext(read('public/js/pages/Settings.js'), c);
    const page = Object.create(c.window.SettingsPage.prototype);
    page.initHwDecodeSettings();
    const sw = el('setting-vaapi-hw-decode');
    sw.checked = true;
    await sw.listeners.change();
    assert.equal(sw.checked, false, 'flipped back');
    assert.equal(c.toasts.length, 1);
    assert.deepEqual(plain(c.toasts[0]), ['That setting was not saved. It is back to how it was.', { kind: 'error' }]);
});

// ---- the guide's column resize ---------------------------------------------------------------------------------------

test('C9: the guide\'s column resize uses pointer events with capture (touch and pen work, it cannot stick)', () => {
    const src = read('public/js/components/EpgGuide.js');
    assert.doesNotMatch(src.slice(src.indexOf('initResizer()'), src.indexOf('Navigate time')), /mousedown|mousemove|mouseup/);
    const docListeners = {};
    const vars = {};
    const handle = { listeners: {}, captured: null, cls: new Set(['resize-handle']),
        classList: { contains: (n) => handle.cls.has(n), add: (n) => handle.cls.add(n), remove: (n) => handle.cls.delete(n) },
        setPointerCapture(id) { handle.captured = id; }, addEventListener(t, fn) { handle.listeners[t] = fn; }, removeEventListener(t) { delete handle.listeners[t]; } };
    const document = { addEventListener: (t, fn) => { docListeners[t] = fn; }, querySelector: () => ({ getBoundingClientRect: () => ({ width: 200 }) }),
        documentElement: { style: { setProperty: (k, v) => { vars[k] = v; } } }, body: { style: {} }, querySelectorAll: () => [] };
    const c = sandbox({ document, API: {}, Icons: {} });
    vm.runInContext(read('public/js/components/EpgGuide.js'), c);
    const guide = Object.create(c.window.EpgGuide.prototype);
    guide.updateNowIndicator = () => { guide.moved = (guide.moved || 0) + 1; };
    guide.initResizer();
    assert.ok(docListeners.pointerdown && !docListeners.mousedown && !docListeners.mousemove && !docListeners.mouseup);
    const down = (extra = {}) => docListeners.pointerdown({ target: handle, clientX: 100, pointerId: 7, pointerType: 'touch', button: 0, preventDefault() {}, ...extra });
    down({ button: 2, pointerType: 'mouse' });
    assert.equal(handle.captured, null, 'a right click does not start it');
    down();
    assert.equal(handle.captured, 7, 'the handle captures the pointer');
    assert.ok(handle.cls.has('active'));
    handle.listeners.pointermove({ clientX: 160 });
    assert.equal(vars['--epg-sidebar-width'], '260px');
    handle.listeners.pointermove({ clientX: 900 });
    assert.equal(vars['--epg-sidebar-width'], '500px', 'at most 500');
    handle.listeners.pointermove({ clientX: -900 });
    assert.equal(vars['--epg-sidebar-width'], '150px', 'at least 150');
    handle.listeners.pointerup();
    assert.ok(!handle.cls.has('active'));
    assert.equal(document.body.style.cursor, '');
    assert.deepEqual(Object.keys(handle.listeners), [], 'its listeners are gone');
    // A drag the browser takes away (a scroll, a lost capture) ends too: it cannot stick.
    down();
    handle.listeners.lostpointercapture();
    assert.ok(!handle.cls.has('active'));
    down();
    handle.listeners.pointercancel();
    assert.equal(document.body.style.cursor, '');
    assert.match(read('public/css/main.css'), /\.resize-handle\s*\{[^}]*touch-action:\s*none/);
});

test('the guide toolbar keeps Earlier, the date and Later together, and wraps as a group', () => {
    const html = read('public/index.html');
    assert.match(html, /<div class="guide-pager">\s*<button id="guide-prev"[^>]*>[^<]*<\/button>\s*<span id="guide-date"[^>]*>[^<]*<\/span>\s*<button id="guide-next"/);
    const css = read('public/css/main.css');
    assert.match(css, /\.guide-pager\s*\{[^}]*display:\s*flex/);
    assert.match(css, /@media[^{]*\{[\s\S]*?\.guide-pager\s*\{[^}]*flex:\s*1 1 100%/, 'at phone width the group takes its own row');
});
