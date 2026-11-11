const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../public/js/ui.js');
const { FakeEvent, createDocument } = require('./helpers/fakeDom');

// #276 (B3): loading, empty and load-error are one set, drawn by UI.stateBlock / UI.setState (public/js/ui.js).
const ROOT = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('UI.stateBlock: loading is a status with a spinner and "Loading…" (one ellipsis character)', () => {
    const html = UI.stateBlock('loading');
    assert.match(html, /^<div class="state-block state-loading" role="status">/);
    assert.match(html, /<span class="state-block-spinner" aria-hidden="true"><\/span>/);
    assert.match(html, /<p class="state-block-title">Loading…<\/p>/);
    assert.doesNotMatch(html, /\.\.\./);
    assert.match(UI.stateBlock('loading', 'Loading channels…'), />Loading channels…</);
});

test('UI.stateBlock: empty has a title, an optional detail and an optional action, and no live role', () => {
    const html = UI.stateBlock('empty', { title: 'No devices yet', detail: 'Pair one above.' });
    assert.match(html, /^<div class="state-block state-empty">/);
    assert.match(html, /<p class="state-block-title">No devices yet<\/p><p class="state-block-detail">Pair one above\.<\/p>/);
    assert.doesNotMatch(html, /role=|state-block-spinner|<button|<a /);
    const link = UI.stateBlock('empty', 'No providers yet', { label: 'Add a provider', href: '#settings?x="y"' });
    assert.match(link, /<a class="btn btn-secondary state-block-action" href="#settings\?x=&quot;y&quot;">Add a provider<\/a>/);
});

test('UI.stateBlock: error is an alert, its action defaults to "Try again", and it is never a primary button', () => {
    const html = UI.stateBlock('error', { title: 'The channel list could not be loaded.', detail: 'The guide still works.' }, { run() {} });
    assert.match(html, /^<div class="state-block state-error" role="alert">/);
    assert.match(html, /<button type="button" class="btn btn-secondary state-block-action" data-state-action>Try again<\/button>/);
    assert.match(html, /The guide still works\./);
    assert.doesNotMatch(html, /btn-primary/);
    assert.match(UI.stateBlock('error', 'x', { label: 'Re-detect', run() {} }), />Re-detect<\/button>/);
    assert.doesNotMatch(UI.stateBlock('error', 'x'), /<button/, 'no action without a run or href');
});

test('UI.stateBlock: every text is escaped; an unknown kind throws', () => {
    const html = UI.stateBlock('error', { title: '<img src=x onerror=y()>', detail: '"&\'' }, { label: '<b>go</b>', run() {} });
    assert.doesNotMatch(html, /<img|<b>/);
    assert.match(html, /&lt;img src=x onerror=y\(\)&gt;/);
    assert.match(html, /&quot;&amp;&#39;/);
    assert.match(html, /&lt;b&gt;go&lt;\/b&gt;/);
    assert.throws(() => UI.stateBlock('oops', 'x'), TypeError);
});

test('UI.setState: replaces the content, binds the action, and runs it once on a click', () => {
    const document = createDocument();
    const button = document.createElement('button');
    let runs = 0;
    const container = {
        innerHTML: '<p>old</p>',
        querySelector: (sel) => (sel === '[data-state-action]' ? button : null)
    };
    const got = UI.setState(container, 'error', 'The users could not be loaded.', { run: () => { runs++; } });
    assert.equal(got, button);
    assert.match(container.innerHTML, /^<div class="state-block state-error" role="alert"><p class="state-block-title">The users could not be loaded\.<\/p><button/);
    button.dispatchEvent(new FakeEvent('click'));
    assert.equal(runs, 1);
    assert.equal(button.disabled, true, 'disabled while it runs again');
});

test('UI.setState: { colspan } puts the block in one table row; a container without a DOM still gets the markup', () => {
    const tbody = { innerHTML: '' };
    assert.equal(UI.setState(tbody, 'loading', null, null, { colspan: 4 }), null);
    assert.match(tbody.innerHTML, /^<tr class="state-row"><td colspan="4"><div class="state-block state-loading" role="status">/);
    assert.equal(UI.setState(null, 'loading'), null);
});

// ---- The pages in scope use it, and nothing else ----

const IN_SCOPE = [
    'js/components/ChannelList.js', 'js/components/EpgGuide.js', 'js/components/SourceManager.js',
    'js/pages/StatusPage.js', 'js/pages/Settings.js', 'js/pages/ProvidersSettings.js',
    'js/pages/BackupLinksSettings.js', 'js/pages/SportSettings.js', 'index.html'
];
/** index.html without the Recordings page (being rebuilt elsewhere). */
function source(file) {
    let text = read(file);
    if (file === 'index.html') {
        text = text.replace(/<div id="page-recordings"[\s\S]*?<!-- Status Page/, '<!-- Status Page');
    }
    return text;
}

test('no in-scope page says "Loading..." with three dots, or uses the old state classes', () => {
    const hits = [];
    for (const f of IN_SCOPE) {
        const text = source(f);
        for (const m of text.matchAll(/Loading[\w ]*\.\.\.|\b(empty-state|loading-state)\b|class="loading"/g)) hits.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(hits, []);
    assert.doesNotMatch(read('js/components/ChannelList.js'), /loading-spinner/, 'the list-bottom loader has a styled spinner');
});

test('no in-scope load error shows the raw err.message', () => {
    const hits = [];
    for (const f of IN_SCOPE) {
        const text = source(f).split('\n').filter(l => !/^\s*console\.\w+\(/.test(l)).join('\n');
        for (const m of text.matchAll(/(Could not (load|refresh)|Error loading|Failed to load)[^\n]*(\n[^\n]*)?err\.message/g)) hits.push(`${f}: ${m[0].slice(0, 60)}`);
    }
    assert.deepEqual(hits, []);
});

// Every load error in scope: a fixed plain sentence, drawn by UI.setState with a way to try again.
const LOAD_ERRORS = [
    ['js/components/ChannelList.js', 'The channel list could not be loaded.'],
    ['js/components/EpgGuide.js', 'The TV Guide could not be loaded.'],
    ['js/components/SourceManager.js', 'The providers could not be loaded.'],
    ['js/components/SourceManager.js', 'The groups and channels could not be loaded.'],
    ['js/pages/StatusPage.js', 'The server status could not be loaded.'],
    ['js/pages/StatusPage.js', 'The guide categories could not be loaded.'],
    ['js/pages/Settings.js', 'The channel numbers could not be loaded.'],
    ['js/pages/Settings.js', 'The guide matching list could not be loaded.'],
    ['js/pages/Settings.js', 'The followed leagues could not be loaded.'],
    ['js/pages/Settings.js', 'The sport preview could not be loaded.'],
    ['js/pages/Settings.js', 'The groups could not be loaded.'],
    ['js/pages/Settings.js', 'The providers could not be loaded.'],
    ['js/pages/Settings.js', 'The signed-in devices could not be loaded.'],
    ['js/pages/Settings.js', 'The users could not be loaded.'],
    ['js/pages/Settings.js', 'The hardware information could not be loaded.'],
    ['js/pages/Settings.js', 'The recording settings could not be loaded.'],
    ['js/pages/Settings.js', 'The playback settings could not be loaded.'],
    ['js/pages/Settings.js', 'The last sync time could not be loaded.'],
    ['js/pages/Settings.js', 'The auto-map preview could not be loaded.'],
    ['js/pages/ProvidersSettings.js', 'The providers could not be loaded.'],
    ['js/pages/BackupLinksSettings.js', 'The backup links could not be loaded.'],
    ['js/pages/BackupLinksSettings.js', 'The channels could not be loaded.'],
    ['js/pages/BackupLinksSettings.js', 'The search could not be finished.'],
    ['js/pages/SportSettings.js', 'What you follow could not be loaded.']
];

test('every in-scope load error is a fixed sentence drawn by UI.setState with a retry', () => {
    const bad = [];
    for (const [f, sentence] of LOAD_ERRORS) {
        const text = read(f);
        const at = text.indexOf(sentence);
        if (at < 0) { bad.push(`${f}: missing "${sentence}"`); continue; }
        const before = text.slice(Math.max(0, at - 160), at);
        const after = text.slice(at, at + 300);
        if (!/UI\.setState\([^;]*'error',\s*(\{\s*title:\s*)?'?$/.test(before)) bad.push(`${f}: "${sentence}" is not a UI.setState error`);
        if (!/run:/.test(after.split(/\n\s*\n|;\n/)[0])) bad.push(`${f}: "${sentence}" has no run`);
    }
    assert.deepEqual(bad, []);
});

test('the Settings panels whose controls are filled by a GET start busy and disabled, with a place for the state', () => {
    const html = source('index.html');
    for (const id of ['tab-transcode', 'tab-recording']) {
        const panel = html.match(new RegExp(`<div id="${id}"[^>]*>`))[0];
        assert.match(panel, /aria-busy="true"/, `${id} starts busy`);
        assert.match(html, new RegExp(`id="${id}-state"`), `${id} has a state slot`);
    }
});

test('Settings → transcoding: controls stay disabled until GET /api/settings answers, and after a failed load', async () => {
    const vm = require('node:vm');
    const { loadUi } = require('./helpers/webUi');
    const control = (id, disabled = false) => ({ id, disabled, checked: false, value: '', dataset: {}, style: {} });
    const controls = [control('setting-vaapi-hw-decode'), control('setting-relay-enabled'), control('setting-ingest-renewal', true),
        control('setting-shared-ingest'), control('setting-hw-encoder')];
    const attrs = {};
    const panel = { setAttribute: (k, v) => { attrs[k] = v; }, querySelectorAll: (sel) => (/data-settings-values/.test(sel) ? controls : []) };
    const state = { innerHTML: '', querySelector: () => null };
    const byId = { 'tab-transcode': panel, 'tab-transcode-state': state, ...Object.fromEntries(controls.map(c => [c.id, c])) };
    let answer = Promise.reject(new Error('secret upstream detail'));
    answer.catch(() => {});
    const ctx = vm.createContext({ console: { ...console, error() {} },
        document: { getElementById: (id) => byId[id] || null, querySelectorAll: () => [], querySelector: () => null },
        API: { settings: { get: () => answer } } });
    ctx.window = ctx;
    loadUi(ctx);
    vm.runInContext(read('js/pages/Settings.js'), ctx);
    const page = Object.create(ctx.SettingsPage.prototype);
    ctx.SettingsPage.lockPanel(panel, 'loading');
    assert.equal(attrs['aria-busy'], 'true');
    assert.ok(controls.every(c => c.disabled), 'disabled while loading');
    await page.loadTranscodeSettings();
    assert.ok(controls.every(c => c.disabled), 'still disabled after a failed load');
    assert.equal(attrs['aria-busy'], 'false');
    assert.match(state.innerHTML, /state-error[\s\S]*The playback settings could not be loaded\.[\s\S]*Try again/);
    assert.doesNotMatch(state.innerHTML, /secret upstream detail/);
    answer = Promise.resolve({ vaapiHwDecode: false, relayEnabled: true, sharedIngestEnabled: true, hwEncoder: 'qsv' });
    await page.loadTranscodeSettings();
    assert.equal(state.innerHTML, '');
    assert.deepEqual(controls.map(c => c.disabled), [false, false, false, false, false], 'renewal is available: relay and shared ingest are on');
    assert.equal(byId['setting-hw-encoder'].value, 'qsv');
    assert.equal(byId['setting-relay-enabled'].checked, true);
});

test('Your sport: a loading block first, and under a load error Try again and no form (nothing can be saved over it)', async () => {
    const vm = require('node:vm');
    const { loadUi } = require('./helpers/webUi');
    let fail = true, release;
    const calls = [];
    const root = { innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => null };
    const ctx = vm.createContext({ console: { ...console, error() {} }, CSS: { escape: (v) => v }, confirm: () => true,
        API: { request: async (method, url) => {
            calls.push(`${method} ${url}`);
            if (url === '/sports/follows' && method === 'GET') await new Promise(r => { release = r; });
            if (fail) throw new Error('Server unavailable');
            return url === '/sports/catalog' ? { sports: [] } : url === '/sports/follows' ? { spoilerFree: false, sports: [] } : { suggestions: [], names: [] };
        } } });
    loadUi(ctx);
    vm.runInContext(`${read('js/pages/SportSettings.js')}\nthis.SportFollowSettings = SportFollowSettings;`, ctx);
    const panel = new ctx.SportFollowSettings(root);
    const loading = panel.load();
    while (!release) await new Promise(r => setImmediate(r));
    assert.match(root.innerHTML, /state-loading/, 'loading first');
    release();
    await loading;
    assert.match(root.innerHTML, /^<div class="state-block state-error" role="alert"><p class="state-block-title">What you follow could not be loaded\.<\/p><button[^>]*>Try again</);
    assert.doesNotMatch(root.innerHTML, /sport-follow-spoilers|You follow no sport|Server unavailable/);
    await root.listeners.change({ target: { id: 'sport-follow-spoilers', checked: true, dataset: {} } });
    assert.ok(!calls.some(c => c.startsWith('PUT')), 'nothing saved while what is followed is unknown');
    fail = false; release = null;
    const again = panel.load();
    while (!release) await new Promise(r => setImmediate(r));
    release();
    await again;
    assert.match(root.innerHTML, /id="sport-follow-spoilers"/, 'the form once it loads');
    assert.match(root.innerHTML, /You follow no sport yet/);
});

test('the CSS: one .state-block, tokens only, a spinner that stops for reduced motion, a 44 px action on touch', () => {
    const css = read('css/main.css');
    const rules = [...css.matchAll(/([^{}]*\.state-block[^{}]*|[^{}]*\.batch-loader[^{}]*)\{([^}]*)\}/g)];
    assert.ok(rules.length >= 4, 'state-block rules exist');
    for (const [, sel, body] of rules) {
        assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${sel.trim()} uses tokens only`);
        assert.doesNotMatch(body, /dashed/, `${sel.trim()} has no dashed border`);
        assert.doesNotMatch(body, /height:\s*100%/, `${sel.trim()} does not fill its parent`);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.state-block-spinner[^}]*\{[^}]*animation:\s*none/);
    assert.match(css, /@media \(pointer: coarse\)\s*\{[^}]*\.state-block-action[^}]*\{[^}]*min-height:\s*44px/);
    assert.match(css, /\.state-block\s*\{[^}]*font-size:\s*var\(--text-md\)/);
});

test('UI.stateBlock: an action can be the primary (rose) button, and options.className adds a modifier class (#276 Sport)', () => {
    const plain = UI.stateBlock('empty', 'Nothing yet', { label: 'Start', run() {} });
    assert.match(plain, /class="btn btn-secondary state-block-action"/);
    assert.doesNotMatch(plain, /btn-primary/);
    const primary = UI.stateBlock('empty', 'Nothing yet', { label: 'Start', run() {}, primary: true }, { className: 'my-empty' });
    assert.match(primary, /^<div class="state-block state-empty my-empty">/);
    assert.match(primary, /class="btn btn-primary state-block-action"[^>]*>Start</);
    assert.equal(primary.match(/btn-/g).length, 1);
    const doc = createDocument(), box = doc.createElement('div');
    UI.setState(box, 'empty', 'x', { label: 'Go', href: '#a', primary: true }, { className: 'q"<' });
    assert.match(box.innerHTML, /class="state-block state-empty q&quot;&lt;"/, 'the class is escaped');
    assert.match(box.innerHTML, /<a class="btn btn-primary state-block-action" href="#a">Go<\/a>/);
});
