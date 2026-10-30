const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Names that come from the server (paired device names, usernames and emails,
// provider names, detected hardware names, recording artwork and status) are
// escaped when the web app renders them, and the users table wires its buttons
// with listeners instead of inline handlers built from data. The real scripts,
// with a recorded fetch and a minimal DOM stand-in.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const MARKUP = '<img src=x>';

const unescapeAttr = (v) => v.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** An element whose querySelectorAll('[data-x]') finds the elements in its innerHTML carrying that attribute. */
function container() {
    const el = { innerHTML: '', found: [] };
    el.querySelectorAll = (selector) => {
        const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (!attr) return [];
        const out = [];
        const re = /<(button|a|input)\b([^>]*)>([^<]*)/g;
        let m;
        while ((m = re.exec(el.innerHTML))) {
            const attrs = {};
            for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeAttr(a[2]);
            if (!(attr[1] in attrs) || (attr[2] !== undefined && attrs[attr[1]] !== attr[2])) continue;
            const dataset = {};
            for (const [k, v] of Object.entries(attrs)) {
                if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
            }
            const node = { dataset, text: m[3].trim(), listeners: {}, disabled: false,
                addEventListener(type, fn) { this.listeners[type] = fn; } };
            out.push(node);
        }
        el.found = out;
        return out;
    };
    return el;
}

function context(elements, routes) {
    const ctx = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        confirm: () => true, alert() {},
        document: {
            getElementById: (id) => elements[id] || null, querySelectorAll: () => [], querySelector: () => null,
            createElement: () => {
                const el = {};
                let html = '';
                Object.defineProperty(el, 'textContent', { set(v) { html = String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }, get() { return html; } });
                Object.defineProperty(el, 'innerHTML', { get() { return html; }, set(v) { html = v; } });
                return el;
            }
        },
        fetch: async (url, opts = {}) => {
            const key = `${opts.method || 'GET'} ${String(url).split('?')[0]}`;
            const body = routes[key];
            const status = body === undefined ? 404 : 200;
            return { ok: status < 400, status, headers: { get: () => 'application/json' },
                json: async () => body ?? { error: 'No such API endpoint' }, text: async () => JSON.stringify(body) };
        }
    });
    ctx.window = ctx;
    vm.runInContext(js('api.js'), ctx);
    return ctx;
}

function settingsPage(elements, routes) {
    const ctx = context(elements, routes);
    vm.runInContext(js('pages/Settings.js'), ctx);
    return Object.create(ctx.SettingsPage.prototype);
}

test('paired device names and platforms are escaped in the Devices list', async () => {
    const list = container();
    const page = settingsPage({ 'devices-list': list }, {
        'GET /api/devices': [{ id: 'dev-1"x', name: `Lounge ${MARKUP}`, platform: '<b>tvOS</b>', created_at: 1, last_seen_at: null, revoked_at: null }]
    });
    await page.loadDevices();
    assert.ok(!list.innerHTML.includes(MARKUP), list.innerHTML);
    assert.ok(!list.innerHTML.includes('<b>'), list.innerHTML);
    assert.ok(list.innerHTML.includes('Lounge &lt;img src=x&gt;'));
    const remove = list.querySelectorAll('[data-revoke]');
    assert.equal(remove.length, 1);
    assert.equal(remove[0].dataset.revoke, 'dev-1"x', 'the id survives the round trip through the attribute');
});

test('usernames and emails are escaped in the users table, and its buttons are wired without inline handlers', async () => {
    const list = container();
    const page = settingsPage({ 'user-list': list }, {
        'GET /api/auth/users': [
            { id: 7, username: "O'Brien <b>", email: `x${MARKUP}@example.invalid`, role: 'viewer', createdAt: 1 },
            { id: 8, username: 'plain', email: null, role: 'admin', createdAt: 1 }
        ]
    });
    const calls = [];
    page.deleteUser = (id, name) => calls.push(['delete', id, name]);
    page.openEditUserModal = (id) => calls.push(['edit', id]);
    await page.loadUsers();
    const html = list.innerHTML;
    assert.ok(!/\bon[a-z]+=/i.test(html), `no inline handlers: ${html}`);
    assert.ok(!html.includes('<b>') && !html.includes(MARKUP), html);
    assert.ok(html.includes('O&#39;Brien &lt;b&gt;') || html.includes('O&#039;Brien &lt;b&gt;'), html);

    const all = list.found;
    assert.ok(all.length >= 4, `the Edit and Delete buttons were wired (${all.length})`);
    const del = all.filter(b => b.text === 'Delete');
    const edit = all.filter(b => b.text === 'Edit');
    assert.equal(del.length, 2);
    assert.equal(edit.length, 2);
    del[0].listeners.click();
    edit[1].listeners.click();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['delete', 7, "O'Brien <b>"], ['edit', 8]]);
});

test('detected hardware names are escaped in the Transcoding panel', async () => {
    const box = container();
    const page = settingsPage({ 'hw-info-container': box }, {
        'GET /api/settings/hw-info': {
            nvidia: { available: true, name: `GPU ${MARKUP}` }, amf: { available: true, name: '<i>amd</i>' },
            vaapi: { available: true, device: '<u>/dev/dri</u>' }, qsv: { available: false }, recommended: '<s>nvenc</s>'
        }
    });
    await page.loadHardwareInfo();
    for (const raw of [MARKUP, '<i>', '<u>', '<s>']) assert.ok(!box.innerHTML.includes(raw), `${raw} in ${box.innerHTML}`);
    assert.ok(box.innerHTML.includes('GPU &lt;img src=x&gt;'));
});

test('provider names are escaped in the Manage content picker', async () => {
    const select = { innerHTML: '' };
    const ctx = context({ 'content-source-select': select }, {
        'GET /api/sources': [{ id: 3, type: 'xtream', name: `Main ${MARKUP}` }, { id: 4, type: 'm3u', name: 'Backup & co' }]
    });
    ctx.Icons = { chevronDown: '' };
    vm.runInContext(js('components/SourceManager.js'), ctx);
    const manager = Object.create(ctx.window.SourceManager.prototype);
    await manager.loadContentSources();
    assert.ok(!select.innerHTML.includes(MARKUP), select.innerHTML);
    assert.ok(select.innerHTML.includes('Main &lt;img src=x&gt; (xtream)'), select.innerHTML);
    assert.ok(select.innerHTML.includes('Backup &amp; co (m3u)'), select.innerHTML);
});

test('recording artwork, status and error text are escaped in the Recordings lists', () => {
    const elements = { 'scheduled-recordings-list': container(), 'recordings-list': container() };
    const ctx = context(elements, {});
    vm.runInContext(js('pages/RecordingsPage.js'), ctx);
    const page = new ctx.RecordingsPage({});
    const art = 'http://x.invalid/a.png" data-injected="1';
    page.renderScheduled([{ id: 1, title: 'News', channel_name: 'BBC', status: `odd${MARKUP}`, image: art, program_start: 0, program_end: 1 }]);
    page.renderRecordings([{ id: 2, title: 'Film', channel_name: 'BBC', status: 'completed', image: art, program_start: 0, program_end: 1,
        ad_detect_status: 'failed', ad_detect_error: `bad ${MARKUP}`, compress_status: 'failed', compress_error: `worse ${MARKUP}` }]);
    for (const id of Object.keys(elements)) {
        const html = elements[id].innerHTML;
        assert.ok(!html.includes('data-injected="1"'), `${id}: ${html}`);
        assert.ok(!html.includes(MARKUP), `${id}: ${html}`);
    }
});

test('the channel menu offers Hide only to an admin', () => {
    const hideItem = { style: { display: '' } };
    const menu = { dataset: {}, style: {}, classList: { add() {} }, querySelector: (s) => (s === '[data-action="hide"]' ? hideItem : null) };
    const ctx = context({}, {});
    ctx.Icons = { favorite: '', favoriteOutline: '' };
    vm.runInContext(js('components/ChannelList.js'), ctx);
    const list = Object.create((ctx.window.ChannelList || ctx.ChannelList).prototype);
    list.contextMenu = menu;
    const event = { preventDefault() {}, clientX: 1, clientY: 1 };
    ctx.window.app = { currentUser: { role: 'viewer' } };
    list.showContextMenu(event, 'channel', { sourceId: 1, channelId: 'pos_1' });
    assert.equal(hideItem.style.display, 'none');
    ctx.window.app = { currentUser: { role: 'admin' } };
    list.showContextMenu(event, 'channel', { sourceId: 1, channelId: 'pos_1' });
    assert.equal(hideItem.style.display, '');
});
