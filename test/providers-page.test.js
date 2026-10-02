const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0172 (multi-provider P4): the API client's provider and link calls, the pure helpers behind Settings ->
// Providers and Settings -> Backup links, and the two panels' rendering and error handling, with a stub DOM.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function harness(replies = {}) {
    const requests = [];
    const el = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
        classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    const elements = new Proxy({}, { get: (t, id) => (t[id] ||= el(id)) });
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        document: { getElementById: (id) => elements[id], querySelectorAll: () => [] },
        setTimeout: () => 0, clearTimeout() {}, confirm: () => true,
        fetch: async (url, opts = {}) => {
            const key = `${opts.method || 'GET'} ${url}`;
            requests.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
            const reply = typeof replies[key] === 'function' ? replies[key]() : replies[key];
            const status = reply === undefined ? 404 : (reply && reply.__status) || 200;
            const body = reply && reply.__status ? { error: reply.error } : reply;
            return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
        }
    });
    context.window = context;
    for (const f of ['api.js', 'pages/ProvidersSettings.js', 'pages/BackupLinksSettings.js']) vm.runInContext(js(f), context);
    return { context, elements, requests, F: context.ProviderFormat, L: context.LinkFormat };
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('0182: Providers is the one tab for content input; Sources and the Backup links tab are gone', () => {
    assert.match(html, /data-tab="providers"[^>]*>Providers<\/button>/);
    assert.doesNotMatch(html, /data-tab="sources"/);
    assert.doesNotMatch(html, /data-tab="backuplinks"/, 'Backup links opens from a backup card');
    assert.doesNotMatch(html, /id="(add-xtream|add-m3u|add-epg|xtream-list|m3u-list|epg-list)"/);
    assert.match(html, /id="tab-providers"[\s\S]*id="epg-refresh-interval"[\s\S]*id="tab-backuplinks"/, 'the sync interval sits with the providers');
    assert.match(html, /id="tab-backuplinks"[\s\S]*id="links-back"/);
    const tabs = [...html.matchAll(/<button class="tab[^"]*" data-tab="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(tabs, ['providers', 'channels', 'playback', 'recording', 'sports', 'system'], 'six tabs');
    assert.deepEqual([...html.matchAll(/class="subtab[^"]*" data-subtab="(\w+)"/g)].map(m => m[1]), ['content', 'lineup', 'epg']);
    assert.doesNotMatch(html, /id="tab-debug"|id="kill-all-streams"|setting-stream-format|Stream Processing/, 'Debug moved to Status; the dead stream format setting is gone');
    assert.match(js('pages/Settings.js'), /GROUPS = \{ channels: \['content', 'lineup', 'epg'\], playback: \['player', 'transcode'\], system: \['ui', 'devices', 'users'\] \}/);
    assert.match(html, /pages\/ProvidersSettings\.js/);
    assert.match(html, /pages\/BackupLinksSettings\.js[^>]*>[\s\S]*pages\/Settings\.js/, 'loaded before Settings.js, which builds them');
});

test('API client: the provider and link calls use the admin routes with the right bodies', async () => {
    const { context, requests } = harness({
        'GET /api/sources/providers': [], 'PUT /api/sources/order': {}, 'GET /api/sources/4/account': {}, 'POST /api/sources/4/account/check': {},
        'GET /api/sources/4/backup-channels?search=fox%20501&limit=50': [],
        'GET /api/links/summary': {}, 'PUT /api/links/9': {}, 'POST /api/links': {}, 'POST /api/links/approve-pending': {}, 'POST /api/links/relink': {},
        'GET /api/links?offset=100&limit=100&status=pending&backupSourceId=4&categoryId=c%201&search=fox&unlinked=1': { channels: [] },
        'GET /api/links?offset=0&limit=100': { channels: [] }
    });
    const API = context.API;
    await API.sources.providers(); await API.sources.setOrder([4, 1]); await API.sources.account(4); await API.sources.checkAccount(4);
    await API.sources.backupChannels(4, 'fox 501');
    await API.links.summary(); await API.links.setStatus(9, 'approved');
    await API.links.addManual(1, 'k', 4, 's7');
    await API.links.approvePending('12', 4); await API.links.approvePending('12'); await API.links.relink();
    await API.links.list({ status: 'pending', backupSourceId: 4, categoryId: 'c 1', search: 'fox', unlinked: true }, 100, 100);
    await API.links.list({ search: '', status: '' });
    const keys = requests.map(r => r.key);
    assert.deepEqual(keys, [
        'GET /api/sources/providers', 'PUT /api/sources/order', 'GET /api/sources/4/account', 'POST /api/sources/4/account/check',
        'GET /api/sources/4/backup-channels?search=fox%20501&limit=50',
        'GET /api/links/summary', 'PUT /api/links/9', 'POST /api/links', 'POST /api/links/approve-pending',
        'POST /api/links/approve-pending', 'POST /api/links/relink',
        'GET /api/links?offset=100&limit=100&status=pending&backupSourceId=4&categoryId=c%201&search=fox&unlinked=1',
        'GET /api/links?offset=0&limit=100']);
    assert.deepEqual(plain(requests[1].body), { ids: [4, 1] });
    assert.deepEqual(plain(requests[6].body), { status: 'approved' });
    assert.deepEqual(plain(requests[7].body), { primarySourceId: 1, primaryKey: 'k', backupSourceId: 4, streamId: 's7' });
    assert.deepEqual(plain(requests[8].body), { categoryId: '12', backupSourceId: 4 });
    assert.deepEqual(plain(requests[9].body), { categoryId: '12' });
});

test('expiry reads "Tue 30 Mar 2027" as the account reports it, with how soon', () => {
    const { F } = harness();
    const at = new Date(2027, 2, 30, 12).getTime(); // local noon: the same date in any zone
    const now = new Date(2027, 0, 1).getTime();
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, now)), { text: 'Tue 30 Mar 2027', level: 'ok' });
    assert.match(F.formatExpiry({ expiresAt: at }, at - 3 * 86400000).text, /· 3 days left$/);
    assert.equal(F.formatExpiry({ expiresAt: at }, at - 86400000).text.endsWith('· 1 day left'), true);
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: at }, at + 86400000)).level, 'expired');
    assert.match(F.formatExpiry({ expiresAt: at }, at + 86400000).text, /· expired$/);
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: null, expirySource: null })), { text: 'Not reported by the provider', level: 'none' });
    assert.deepEqual(plain(F.formatExpiry(undefined)), { text: 'Not reported by the provider', level: 'none' });
});

test('connections say what is in use of the account\'s limit, or that the limit is assumed', () => {
    const { F } = harness();
    assert.equal(F.formatConnections({ maxConnections: 2, activeCons: 1 }, { limit: 2 }), '1 of 2 in use');
    assert.equal(F.formatConnections({ maxConnections: null, activeCons: 0 }, { limit: 1 }), '0 of 1 in use (limit assumed)');
    assert.equal(F.formatConnections({ maxConnections: 3 }, { limit: 3 }), 'limit 3');
    assert.equal(F.formatConnections(null, { limit: 1 }), 'limit 1 (assumed)');
    assert.equal(F.formatConnections(null, undefined), 'limit 1 (assumed)');
});

test('sync status and ages are plain words, and no address ever survives', () => {
    const { F } = harness();
    const now = 1_000_000_000_000;
    assert.equal(F.ago(now - 30_000, now), 'just now');
    assert.equal(F.ago(now - 60_000, now), '1 minute ago');
    assert.equal(F.ago(now - 3 * 3600_000, now), '3 hours ago');
    assert.equal(F.ago(now - 49 * 3600_000, now), '2 days ago');
    assert.equal(F.ago(null, now), 'never');
    assert.equal(F.formatSync(null, now).text, 'Not synced yet');
    assert.equal(F.formatSync({ status: 'syncing', last_sync: now }, now).level, 'busy');
    assert.deepEqual(plain(F.formatSync({ status: 'success', last_sync: now - 120_000 }, now)), { text: 'Synced 2 minutes ago', level: 'ok' });
    const failed = F.formatSync({ status: 'error', last_sync: now, error: 'Could not reach http://user:pw@host.invalid:8080/get.php?username=u&password=p today' }, now);
    assert.equal(failed.level, 'error');
    assert.ok(!/host\.invalid|password|user:pw/.test(failed.text), failed.text);
    assert.ok(failed.text.includes('[address]'));
});

test('order: the primary first, backups by priority (empty last); moving a card gives the new id order', () => {
    const { F } = harness();
    const list = [
        { id: 3, role: 'backup', priority: null }, { id: 2, role: 'backup', priority: 2 },
        { id: 1, role: 'primary', priority: null }, { id: 4, role: 'backup', priority: 1 }
    ];
    assert.deepEqual(plain(F.order(list).map(p => p.id)), [1, 4, 2, 3]);
    assert.deepEqual(plain(F.moved(list, 2, -1)), [1, 2, 4, 3]);
    assert.deepEqual(plain(F.moved(list, 4, -1)), [4, 1, 2, 3], 'the first backup moves above the primary');
    assert.deepEqual(plain(F.moved(list, 1, 1)), [4, 1, 2, 3], 'and the primary can move down');
    assert.equal(F.moved(list, 1, -1), null, 'the first cannot move up');
    assert.equal(F.moved(list, 3, 1), null, 'the last cannot move down');
    assert.equal(F.moved(list, 99, 1), null);
    assert.equal(F.roleLabel({ role: 'backup' }, 2), 'Backup 2');
    assert.equal(F.roleLabel({ role: 'primary' }, 0), 'Primary');
});

test('the save body: everything for a new provider, only what changed for a saved one; an empty password is kept', () => {
    const { F } = harness();
    const typed = { name: ' Dream4K ', type: 'xtream', url: ' http://d.invalid ', username: 'u', password: 'p', epgUrl: '', idOverlayUrl: ' http://e.invalid/list.m3u ' };
    assert.deepEqual(plain(F.buildSave(null, typed).body),
        { type: 'xtream', name: 'Dream4K', url: 'http://d.invalid', username: 'u', password: 'p', idOverlayUrl: 'http://e.invalid/list.m3u' });
    assert.deepEqual(plain(F.buildSave(null, { name: 'S', type: 'm3u', url: 'http://s.invalid/a.m3u', username: 'ignored', password: 'ignored', epgUrl: 'http://s.invalid/g.xml' }).body),
        { type: 'm3u', name: 'S', url: 'http://s.invalid/a.m3u', epgUrl: 'http://s.invalid/g.xml' });
    assert.equal('idOverlayUrl' in F.buildSave(null, { name: 'S', type: 'm3u', url: 'http://s.invalid/a.m3u', idOverlayUrl: 'http://e.invalid/x.m3u' }).body, false, '0184: an M3U playlist is its own id list');
    assert.equal(F.buildSave(null, { ...typed, name: ' ' }).error, 'Give the provider a name');
    assert.equal(F.buildSave(null, { ...typed, url: '' }).error, 'Enter the server address');
    assert.equal(F.buildSave(null, { ...typed, type: 'm3u', url: '' }).error, 'Enter the playlist address');
    assert.equal(F.buildSave(null, { ...typed, password: '' }).error, 'Enter the username and password');

    const saved = { id: 4, type: 'xtream', name: 'Dream4K', url: 'http://d.invalid', username: 'u', hasPassword: true, epgUrl: null, idOverlayUrl: 'http://e.invalid/list.m3u' };
    const same = { name: 'Dream4K', type: 'xtream', url: 'http://d.invalid', username: 'u', password: '', epgUrl: '', idOverlayUrl: 'http://e.invalid/list.m3u' };
    assert.deepEqual(plain(F.buildSave(saved, same).body), {}, 'nothing changed');
    assert.deepEqual(plain(F.buildSave(saved, { ...same, password: 'new' }).body), { password: 'new' });
    assert.deepEqual(plain(F.buildSave(saved, { ...same, epgUrl: 'http://g.invalid/x.xml', idOverlayUrl: '' }).body),
        { epgUrl: 'http://g.invalid/x.xml', idOverlayUrl: '' }, 'an emptied address is removed');
    assert.deepEqual(plain(F.buildSave(saved, { ...same, name: 'D4K', type: 'm3u' }).body), { name: 'D4K' }, 'the type of a saved provider does not change');
});

test('Providers cards are all the same: facts, the same buttons, no address or login until Edit; names escaped', () => {
    const { context } = harness();
    const panel = new context.ProvidersSettings();
    const backup = { id: 4, type: 'm3u', hasLogin: false, name: 'Trex <b>', enabled: true, role: 'backup', priority: 1, hasEpg: true, hasIdOverlay: true,
        url: 'http://host.invalid', password: 'hunter2', backupChannels: 55123 };
    panel.setCoverage({ linkable: 2100, providers: [{ backupSourceId: 4, role: 'backup', linked: 1840 }, { backupSourceId: 1, role: 'sibling', linked: 5 }] });
    panel.providers = [backup, { id: 1, type: 'm3u', hasLogin: true, name: 'Strong8K', enabled: true, role: 'primary', priority: null, hasEpg: true, hasIdOverlay: false }];
    panel.accounts = new Map([[4, { account: { status: 'Active', checkedAt: Date.now() - 60000, activeCons: 0, maxConnections: 2, ok: false,
        error: 'The provider did not answer (http://host.invalid/player_api.php?username=u&password=p)' },
        effective: { expiresAt: new Date(2027, 2, 30, 12).getTime(), expirySource: 'account', limit: 2, expired: false } }]]);
    panel.setSyncRows([{ source_id: 4, type: 'all', status: 'success', last_sync: Date.now() - 5000 },
        { source_id: 1, type: 'epg', status: 'error', last_sync: Date.now() - 5000, error: 'HTTP 502' },
        { source_id: 1, type: 'live', status: 'success', last_sync: 1 }]);
    panel.render();
    const out = context.document.getElementById('providers-list').innerHTML;
    assert.ok(!out.includes('hunter2') && !out.includes('host.invalid'), 'no address, login or password');
    assert.ok(!out.includes('data-field='), 'no form until Edit');
    assert.ok(out.includes('Trex &lt;b&gt;') && !out.includes('Trex <b>'));
    assert.ok(out.indexOf('Strong8K') < out.indexOf('Trex'), 'the primary is the first card');
    assert.ok(out.includes('Backup 1') && out.includes('Primary'));
    assert.ok(out.includes('Tue 30 Mar 2027'));
    assert.ok(out.includes('0 of 2 in use'));
    assert.ok(out.includes('55,123') && out.includes('data-provider-action="links" data-id="4"'), 'backup channel count and the way to its links');
    assert.ok(out.includes('1,840 of 2,100 primary channels'), '0184: how much of the primary this backup covers');
    assert.ok(out.includes('Found in the playlist') && out.includes('Not found in the playlist'), '0184: whether a login could be read from an M3U');
    assert.ok(out.includes('The last good values are kept'));
    assert.ok(out.includes('Failed just now: HTTP 502'), 'the primary shows its guide sync');
    assert.ok(out.includes('Saved; used when this provider is first'), 'a backup keeps its guide address');
    for (const action of ['up', 'down', 'check', 'sync', 'edit']) {
        assert.equal((out.match(new RegExp(`data-provider-action="${action}"`, 'g')) || []).length, 2, `${action} on every card`);
    }
    assert.match(out, /data-provider-action="up" data-id="1"[^>]*disabled/, 'the first cannot go up');
    assert.match(out, /data-provider-action="down" data-id="4"[^>]*disabled/, 'the last cannot go down');
    assert.ok(out.includes('+ Add a backup provider'));
    assert.ok(!out.includes('Purchased') && !out.includes('Connection limit') && !out.includes('Term (months)'), '0182: nothing typed by hand that the account reports');
});

test('0182: with no provider there is one empty card; the form is the same for new and saved, and never shows a password', () => {
    const { context } = harness();
    const panel = new context.ProvidersSettings();
    panel.render();
    const empty = context.document.getElementById('providers-list').innerHTML;
    assert.ok(empty.includes('New provider') && empty.includes('Primary') && empty.includes('data-provider-action="save" data-id="new"'));
    assert.ok(!empty.includes('provider-add'), 'the card is already open');
    const fields = (text) => (text.match(/data-field="[a-zA-Z]+"/g) || []).join();
    const saved = panel.formHtml(3, { id: 3, type: 'xtream', enabled: true, name: '<img onerror=bad()>', url: 'https://example.invalid/?x=" autofocus onfocus="bad()',
        username: '" onfocus="bad()', password: 'must-not-render', hasPassword: true, epgUrl: 'http://g.invalid/x.xml?a=1&b=2', idOverlayUrl: null });
    assert.equal(fields(saved), fields(panel.formHtml('new', null)), 'identical cards');
    assert.equal(fields(saved), 'data-field="name",data-field="type",data-field="url",data-field="username",data-field="password",data-field="epgUrl",data-field="idOverlayUrl"');
    assert.ok(!saved.includes('<img') && saved.includes('&lt;img') && saved.includes('&quot;'));
    assert.ok(!saved.includes('must-not-render'));
    assert.ok(saved.includes('Leave empty to keep the saved password'));
    assert.ok(saved.includes('value="http://g.invalid/x.xml?a=1&amp;b=2"'), 'the guide address is shown to the admin editing it');
    assert.match(saved, /data-field="type" disabled/);
    for (const action of ['test', 'toggle', 'delete', 'cancel']) assert.ok(saved.includes(`data-provider-action="${action}"`), action);
    // An old standalone EPG source is listed until it is deleted.
    panel.guides = [{ id: 9, type: 'epg', name: 'Old <guide>', enabled: true }];
    panel.providers = [{ id: 1, type: 'm3u', name: 'Strong8K', enabled: true, role: 'primary' }];
    panel.render();
    const out = context.document.getElementById('providers-list').innerHTML;
    assert.ok(out.includes('Other guide sources') && out.includes('Old &lt;guide&gt;') && out.includes('data-provider-action="delete-guide" data-id="9"'));
});

test('0181: a provider that is the same account as another shows a red warning naming it; one that is not shows none', () => {
    const { context } = harness();
    const panel = new context.ProvidersSettings();
    const base = { type: 'xtream', enabled: true, priority: null, hasEpg: false, hasIdOverlay: false };
    panel.providers = [{ ...base, id: 1, name: 'Dream4K', role: 'primary', sharesAccountWith: [2] },
        { ...base, id: 2, name: 'Trex <i>', role: 'backup', priority: 1, sharesAccountWith: [1] },
        { ...base, id: 3, name: 'Strong8K', role: 'backup', priority: 2, sharesAccountWith: [] }];
    panel.accounts = new Map(); panel.syncRows = new Map();
    panel.render();
    const out = context.document.getElementById('providers-list').innerHTML;
    assert.equal((out.match(/count as one connection/g) || []).length, 2, 'both twins are warned, the third is not');
    assert.ok(out.includes("Same server and login as Dream4K: these count as one connection. Check this provider's settings."));
    assert.ok(out.includes('Same server and login as Trex &lt;i&gt;: these'), 'the name is escaped');
    assert.match(out, /class="provider-warning provider-error"/, 'in the error colour');
    assert.ok(/providers[^"]*ProvidersSettings\.js\?v=4/.test(html) || /ProvidersSettings\.js\?v=4/.test(html), 'the script version was bumped');
});

const formCard = (values) => ({ querySelector: (sel) => { const m = /data-field="(\w+)"/.exec(sel); return m && m[1] in values ? { value: values[m[1]] } : null; } });

test('Providers: a refused save shows the server\'s sentence on that card', async () => {
    const { context, elements } = harness({
        'PUT /api/sources/1': { __status: 400, error: 'epgUrl must be an http or https address (up to 2000 characters), or empty' }
    });
    const panel = new context.ProvidersSettings();
    panel.providers = [{ id: 1, role: 'primary', type: 'm3u', name: 'S' }];
    panel.open.set(1, { id: 1, type: 'm3u', name: 'S', url: 'http://s.invalid/a.m3u', epgUrl: null, idOverlayUrl: null });
    const button = { closest: () => formCard({ name: 'S', url: 'http://s.invalid/a.m3u', epgUrl: 'guide', idOverlayUrl: '' }), disabled: false };
    await panel.save(panel.providers[0], button);
    assert.equal(elements['provider-status-1'].textContent, 'epgUrl must be an http or https address (up to 2000 characters), or empty');
    assert.equal(button.disabled, false, 'can be tried again');
    assert.equal(panel.open.has(1), true, 'the form stays open');
});

test('Providers: adding posts the form once and never names a role (the server places it)', async () => {
    const { context, requests } = harness({
        'POST /api/sources': { id: 7 }, 'GET /api/sources/providers': [], 'GET /api/sources/status': [], 'GET /api/sources': []
    });
    const panel = new context.ProvidersSettings();
    panel.open.set('new', null);
    const button = { closest: () => formCard({ name: 'Dream4K', type: 'xtream', url: 'http://d.invalid', username: 'u', password: 'p', epgUrl: '', idOverlayUrl: '' }), disabled: false };
    await panel.act('save', 'new', button);
    const posts = requests.filter(r => r.key === 'POST /api/sources');
    assert.equal(posts.length, 1);
    assert.deepEqual(plain(posts[0].body), { type: 'xtream', name: 'Dream4K', url: 'http://d.invalid', username: 'u', password: 'p' });
    assert.equal(panel.open.has('new'), false);
});

test('Providers: moving a backup sends the whole order once; moving a card to the top asks first', async () => {
    const asked = [];
    const { context, requests } = harness({
        'PUT /api/sources/order': () => ({ success: true, primaryChanged: false }),
        'GET /api/sources/providers': [], 'GET /api/sources/status': [], 'GET /api/sources': []
    });
    context.confirm = (m) => { asked.push(m); return false; };
    const panel = new context.ProvidersSettings();
    const list = () => [{ id: 1, role: 'primary', name: 'Strong8K' }, { id: 4, role: 'backup', priority: 1, name: 'Dream4K' }, { id: 2, role: 'backup', priority: 2, name: 'Trex' }];
    panel.providers = list();
    await panel.move(panel.providers[2], -1);
    assert.deepEqual(requests.filter(r => r.key.startsWith('PUT')).map(r => [r.key, plain(r.body)]), [['PUT /api/sources/order', { ids: [1, 2, 4] }]]);
    assert.equal(asked.length, 0, 'reordering backups needs no confirmation');

    requests.length = 0;
    panel.providers = list();
    await panel.move(panel.providers[1], -1);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Make Dream4K the primary provider\?[\s\S]*Strong8K becomes a backup/);
    assert.equal(requests.filter(r => r.key.startsWith('PUT')).length, 0, 'declined: nothing is sent');

    context.confirm = () => true;
    await panel.move(panel.providers[0], 1);
    assert.deepEqual(plain(requests.find(r => r.key === 'PUT /api/sources/order').body), { ids: [4, 1, 2] }, 'moving the primary down is the same change');
});

test('link helpers: status badges, decision buttons, paging, filters', () => {
    const { L } = harness();
    assert.deepEqual(plain(['auto', 'approved', 'manual', 'pending', 'rejected', 'broken', 'x'].map(L.badgeClass)), ['ok', 'ok', 'ok', 'warn', 'bad', 'bad', 'none']);
    assert.equal(L.statusLabel('pending'), 'Needs review');
    assert.equal(L.methodLabel('exact'), 'same guide id');
    const buttons = (status) => plain(L.actions({ status }).map(a => `${a.label}:${a.status}`));
    assert.deepEqual(buttons('pending'), ['Approve:approved', 'Reject:rejected']);
    assert.deepEqual(buttons('auto'), ['Approve:approved', 'Reject:rejected']);
    assert.deepEqual(buttons('approved'), ['Undo:pending', 'Reject:rejected']);
    assert.deepEqual(buttons('manual'), ['Undo:pending', 'Reject:rejected']);
    assert.deepEqual(buttons('rejected'), ['Undo:pending']);
    assert.deepEqual(buttons('broken'), ['Reject:rejected'], 'a broken link cannot be turned back into a candidate');
    assert.deepEqual(plain(L.actions(null)), []);
    assert.deepEqual(plain(L.pageInfo(987, 100)), { first: 101, last: 200, page: 2, pages: 10, hasPrev: true, hasNext: true });
    assert.deepEqual(plain(L.pageInfo(987, 900)), { first: 901, last: 987, page: 10, pages: 10, hasPrev: true, hasNext: false });
    assert.deepEqual(plain(L.pageInfo(0, 0)), { first: 0, last: 0, page: 1, pages: 1, hasPrev: false, hasNext: false });
    assert.deepEqual(plain(L.apiFilters({ search: ' fox ', categoryId: '', status: 'pending', unlinked: false, backupSourceId: '4' })),
        { search: 'fox', status: 'pending', backupSourceId: '4' });
    assert.deepEqual(plain(L.apiFilters({ search: '  ', unlinked: true })), { unlinked: true });
});

test('link columns: backups by priority, then the primary\'s own backup feeds only when it has some', () => {
    const { L } = harness();
    const counts = (n) => ({ auto: n, pending: 0, approved: 0, manual: 0, rejected: 0, broken: 0 });
    const summary = { providers: [
        { backupSourceId: 3, name: 'Dream4K', role: 'backup', priority: 2, counts: counts(1) },
        { backupSourceId: 2, name: 'Trex', role: 'backup', priority: 1, counts: counts(1) },
        { backupSourceId: 1, name: 'Strong8K', role: 'sibling', counts: counts(4) }
    ] };
    assert.deepEqual(plain(L.columns(summary).map(c => c.name)), ['Trex', 'Dream4K', 'Strong8K']);
    summary.providers[2].counts = counts(0);
    assert.deepEqual(plain(L.columns(summary).map(c => c.name)), ['Trex', 'Dream4K']);
    assert.deepEqual(plain(L.columns(null)), []);
    const channel = { links: [
        { id: 1, backupSourceId: 2, rank: 2, status: 'pending' }, { id: 2, backupSourceId: 2, rank: 1, status: 'auto' },
        { id: 3, backupSourceId: 2, rank: 4, status: 'rejected' }, { id: 4, backupSourceId: 3, rank: 1, status: 'broken' }
    ] };
    const at2 = L.linksAt(channel, 2);
    assert.equal(at2.top.id, 2);
    assert.deepEqual(plain(at2.more.map(l => l.id)), [1, 3]);
    const at3 = L.linksAt(channel, 3);
    assert.equal(at3.top, null, 'a broken rank 1 is not shown as the link');
    assert.deepEqual(plain(at3.more.map(l => l.id)), [4]);
});

function linksPanel(replies) {
    const h = harness(replies);
    const panel = new h.context.BackupLinksSettings();
    panel.summary = { channels: 2, linkable: 2, providers: [
        { backupSourceId: 2, name: 'Trex', role: 'backup', priority: 1, enabled: true, counts: { auto: 1, pending: 1, approved: 0, manual: 0, rejected: 0, broken: 0 }, linked: 1, unlinked: 1 }] };
    panel.categories = [{ sourceId: 1, id: 'c1', name: 'Sport <AU>' }];
    return { ...h, panel };
}
const chan = (extra = {}) => ({ sourceId: 1, key: 'k1', id: 'pos_1', name: 'Fox <Cricket> 501', number: 501, categoryName: 'Sport <AU>', tvgId: 'fox501.au', event: false,
    links: [{ id: 10, backupSourceId: 2, provider: 'Trex', streamId: 's1', name: 'AU| FOX 501 HD', category: 'AU| SPORT', method: 'number', status: 'pending', rank: 1 },
        { id: 11, backupSourceId: 2, provider: 'Trex', streamId: 's2', name: 'AU| FOX 501 SD', method: 'name', status: 'pending', rank: 2 }], ...extra });

test('Backup links table: the rank-1 link with its method, status and buttons; the others under "more"; escaped; no stream address', () => {
    const { panel, context } = linksPanel();
    panel.channels = [chan(), chan({ key: 'k2', name: 'ESPN 06 :', event: true, links: [] })];
    panel.total = 2;
    panel.renderTable();
    const out = context.document.getElementById('links-list').innerHTML;
    assert.ok(out.includes('501 Fox &lt;Cricket&gt; 501') && !out.includes('<Cricket>'));
    assert.ok(out.includes('AU| FOX 501 HD') && out.includes('Needs review') && out.includes('channel number'));
    assert.ok(out.includes('data-links-action="decide" data-id="10" data-status="approved"'));
    assert.ok(out.includes('data-id="10" data-status="rejected"'));
    assert.ok(out.includes('<summary>1 more</summary>') && out.includes('AU| FOX 501 SD'));
    assert.ok(out.includes('Event slot'), 'an event channel says why it has no link');
    assert.equal((out.match(/data-links-action="pick"/g) || []).length, 2);
    assert.ok(!/https?:\/\//.test(out));
    assert.equal(context.document.getElementById('links-head').innerHTML.includes('Trex'), true);
    assert.ok(context.document.getElementById('links-pager').innerHTML.includes('1-2 of 2 channels (page 1 of 1)'));
});

test('Backup links: approving reloads the page and counts; a refused decision shows the server\'s sentence', async () => {
    let listed = 0;
    const { panel, elements, requests } = linksPanel({
        'PUT /api/links/10': () => ({ id: 10, status: 'approved' }),
        'PUT /api/links/11': { __status: 404, error: 'No such link' },
        'GET /api/links/summary': { channels: 2, linkable: 2, providers: [] },
        'GET /api/links?offset=0&limit=100': () => { listed++; return { total: 1, offset: 0, limit: 100, channels: [chan()] }; }
    });
    await panel.decide(10, 'approved', null);
    assert.deepEqual(requests.map(r => r.key), ['PUT /api/links/10', 'GET /api/links/summary', 'GET /api/links?offset=0&limit=100']);
    assert.equal(listed, 1);
    await panel.decide(11, 'approved', null);
    assert.equal(elements['links-status-text'].textContent, 'No such link');
});

test('Backup links: "approve all pending" needs a category, confirms, and names the backup', async () => {
    const asked = [];
    const { panel, context, requests } = linksPanel({
        'POST /api/links/approve-pending': { approved: 3 },
        'GET /api/links/summary': { channels: 2, linkable: 2, providers: [] },
        'GET /api/links?offset=0&limit=100': { total: 0, offset: 0, limit: 100, channels: [] }
    });
    context.confirm = (m) => { asked.push(m); return true; };
    panel.renderBulk();
    assert.equal(context.document.getElementById('links-bulk').innerHTML, '', 'nothing until a category is chosen');
    panel.filters.categoryId = 'c1';
    panel.renderBulk();
    const bulk = context.document.getElementById('links-bulk').innerHTML;
    assert.ok(bulk.includes('Approve all pending in Sport &lt;AU&gt;') && bulk.includes('data-backup="2"'));
    await panel.approveCategory(2, null);
    assert.deepEqual(plain(requests[0].body), { categoryId: 'c1', backupSourceId: 2 });
    assert.match(asked[0], /Sport <AU>.*Trex/);
    assert.equal(context.document.getElementById('links-status-text').textContent, 'Approved 3 links');
});

test('Backup links: the manual pick searches that backup and posts the chosen stream', async () => {
    const { panel, context, requests, elements } = linksPanel({
        'GET /api/sources/2/backup-channels?search=fox&limit=50': [{ stream_id: '77', name: 'AU| FOX <501>', category_name: 'AU| SPORT', tvg_id: 'fox501.au', overlay_tvg_id: null }],
        'POST /api/links': { id: 30, status: 'manual' },
        'GET /api/links/summary': { channels: 2, linkable: 2, providers: [] },
        'GET /api/links?offset=0&limit=100': { total: 0, offset: 0, limit: 100, channels: [] }
    });
    panel.pick = { channel: chan(), provider: panel.summary.providers[0], token: 0 };
    await panel.searchPick('fox');
    const rows = elements['links-pick-results'].innerHTML;
    assert.ok(rows.includes('AU| FOX &lt;501&gt;') && rows.includes('data-stream="77"') && rows.includes('fox501.au'));
    await panel.choose('77');
    const post = requests.find(r => r.key === 'POST /api/links');
    assert.deepEqual(plain(post.body), { primarySourceId: 1, primaryKey: 'k1', backupSourceId: 2, streamId: '77' });
    assert.equal(panel.pick, null);
    void context;
});

test('Backup links: a page emptied by decisions steps back to the last real page', async () => {
    const asked = [];
    const { panel } = linksPanel({
        'GET /api/links?offset=200&limit=100': () => { asked.push(200); return { total: 150, offset: 200, limit: 100, channels: [] }; },
        'GET /api/links?offset=100&limit=100': () => { asked.push(100); return { total: 150, offset: 100, limit: 100, channels: [chan()] }; }
    });
    await panel.reload(200);
    assert.deepEqual(plain(asked), [200, 100]);
    assert.equal(panel.offset, 100);
});

test('0182: the old add/edit source forms are gone from SourceManager (it is the Manage Content browser only)', () => {
    const source = js('components/SourceManager.js');
    for (const gone of ['getSourceForm', 'showAddModal', 'saveNewSource', 'source-role', 'add-xtream']) assert.ok(!source.includes(gone), gone);
    assert.match(source, /initContentBrowser\(\)/);
});
