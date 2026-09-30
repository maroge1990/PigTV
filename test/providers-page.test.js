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

test('the new tabs and scripts are in the page', () => {
    assert.match(html, /data-tab="providers"[^>]*>Providers<\/button>/);
    assert.match(html, /data-tab="backuplinks"[^>]*>Backup links<\/button>/);
    assert.match(html, /id="tab-providers"/);
    assert.match(html, /id="tab-backuplinks"/);
    assert.match(html, /pages\/ProvidersSettings\.js/);
    assert.match(html, /pages\/BackupLinksSettings\.js[^>]*>[\s\S]*pages\/Settings\.js/, 'loaded before Settings.js, which builds them');
});

test('API client: the provider and link calls use the admin routes with the right bodies', async () => {
    const { context, requests } = harness({
        'GET /api/sources/providers': [], 'GET /api/sources/4/account': {}, 'POST /api/sources/4/account/check': {},
        'GET /api/sources/4/backup-channels?search=fox%20501&limit=50': [],
        'GET /api/links/summary': {}, 'PUT /api/links/9': {}, 'POST /api/links': {}, 'POST /api/links/approve-pending': {}, 'POST /api/links/relink': {},
        'GET /api/links?offset=100&limit=100&status=pending&backupSourceId=4&categoryId=c%201&search=fox&unlinked=1': { channels: [] },
        'GET /api/links?offset=0&limit=100': { channels: [] }
    });
    const API = context.API;
    await API.sources.providers(); await API.sources.account(4); await API.sources.checkAccount(4);
    await API.sources.backupChannels(4, 'fox 501');
    await API.links.summary(); await API.links.setStatus(9, 'approved');
    await API.links.addManual(1, 'k', 4, 's7');
    await API.links.approvePending('12', 4); await API.links.approvePending('12'); await API.links.relink();
    await API.links.list({ status: 'pending', backupSourceId: 4, categoryId: 'c 1', search: 'fox', unlinked: true }, 100, 100);
    await API.links.list({ search: '', status: '' });
    const keys = requests.map(r => r.key);
    assert.deepEqual(keys, [
        'GET /api/sources/providers', 'GET /api/sources/4/account', 'POST /api/sources/4/account/check',
        'GET /api/sources/4/backup-channels?search=fox%20501&limit=50',
        'GET /api/links/summary', 'PUT /api/links/9', 'POST /api/links', 'POST /api/links/approve-pending',
        'POST /api/links/approve-pending', 'POST /api/links/relink',
        'GET /api/links?offset=100&limit=100&status=pending&backupSourceId=4&categoryId=c%201&search=fox&unlinked=1',
        'GET /api/links?offset=0&limit=100']);
    assert.deepEqual(plain(requests[5].body), { status: 'approved' });
    assert.deepEqual(plain(requests[6].body), { primarySourceId: 1, primaryKey: 'k', backupSourceId: 4, streamId: 's7' });
    assert.deepEqual(plain(requests[7].body), { categoryId: '12', backupSourceId: 4 });
    assert.deepEqual(plain(requests[8].body), { categoryId: '12' });
});

test('expiry reads "Tue 30 Mar 2027 · from the account", with where it came from and how soon', () => {
    const { F } = harness();
    const at = new Date(2027, 2, 30, 12).getTime(); // local noon: the same date in any zone
    const now = new Date(2027, 0, 1).getTime();
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, now)), { text: 'Tue 30 Mar 2027 · from the account', level: 'ok' });
    // A manual or term end is a calendar date ending 23:59 UTC: shown as that date whatever the zone.
    const manual = Date.UTC(2027, 2, 30, 23, 59, 59, 999);
    assert.equal(F.formatExpiry({ expiresAt: manual, expirySource: 'manual' }, now).text, 'Tue 30 Mar 2027 · set by hand');
    assert.equal(F.formatExpiry({ expiresAt: manual, expirySource: 'term' }, now).text, 'Tue 30 Mar 2027 · from the purchase date and term');
    assert.match(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, at - 3 * 86400000).text, /· 3 days left$/);
    assert.equal(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, at - 86400000).text.endsWith('· 1 day left'), true);
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, at + 86400000)).level, 'expired');
    assert.match(F.formatExpiry({ expiresAt: at, expirySource: 'account' }, at + 86400000).text, /· expired$/);
    assert.deepEqual(plain(F.formatExpiry({ expiresAt: null, expirySource: null })), { text: 'Unknown', level: 'none' });
    assert.deepEqual(plain(F.formatExpiry(undefined)), { text: 'Unknown', level: 'none' });
});

test('connections say what is in use, the limit and where the limit came from', () => {
    const { F } = harness();
    assert.equal(F.formatConnections({}, { maxConnections: 2, activeCons: 1 }, { limit: 2 }), '1 of 2 in use · limit 2 (from the account)');
    assert.equal(F.formatConnections({ maxConnections: 3 }, { maxConnections: 2, activeCons: 0 }, { limit: 3 }), '0 of 3 in use · limit 3 (set by hand)');
    assert.equal(F.formatConnections({}, null, { limit: 1 }), 'limit 1 (assumed)');
    assert.equal(F.formatConnections({}, null, undefined), 'limit 1 (assumed)');
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

test('order: the primary first, backups by priority (empty last); up/down renumber 1..n', () => {
    const { F } = harness();
    const list = [
        { id: 3, role: 'backup', priority: null }, { id: 2, role: 'backup', priority: 2 },
        { id: 1, role: 'primary', priority: null }, { id: 4, role: 'backup', priority: 1 }
    ];
    assert.deepEqual(plain(F.order(list).map(p => p.id)), [1, 4, 2, 3]);
    assert.deepEqual(plain(F.reorder(list, 2, -1)), [{ id: 2, priority: 1 }, { id: 4, priority: 2 }, { id: 3, priority: 3 }],
        'swapping renumbers everything that is out of place (id 3 had none)');
    assert.deepEqual(plain(F.reorder(list, 4, -1)), [], 'the first backup cannot move up');
    assert.deepEqual(plain(F.reorder(list, 3, 1)), [], 'the last cannot move down');
    assert.deepEqual(plain(F.reorder(list, 1, 1)), [], 'the primary is not in the order');
    assert.equal(F.roleLabel({ role: 'backup' }, 2), 'Backup 2');
    assert.equal(F.roleLabel({ role: 'primary' }, 0), 'Primary');
});

test('the save body has only what changed; the overlay address is kept when empty, set when typed, cleared on request', () => {
    const { F } = harness();
    const p = { id: 4, role: 'backup', maxConnections: null, subscription: { purchasedAt: '2026-04-01', termMonths: 12, endsAt: null }, hasIdOverlay: true };
    const same = { role: 'backup', maxConnections: '', purchasedAt: '2026-04-01', termMonths: '12', endsAt: '', overlay: '', clearOverlay: false };
    assert.deepEqual(plain(F.buildUpdate(p, same)), {}, 'nothing changed: an empty overlay box keeps the stored address');
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, role: 'primary' })), { role: 'primary' });
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, maxConnections: ' 2 ' })), { maxConnections: 2 });
    assert.deepEqual(plain(F.buildUpdate({ ...p, maxConnections: 3 }, { ...same, maxConnections: '' })), { maxConnections: null }, 'blank goes back to the account');
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, maxConnections: 'two' })), { maxConnections: 'two' }, 'typed nonsense goes to the server to be refused in words');
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, termMonths: '24', endsAt: '2027-03-30' })),
        { subscription: { purchasedAt: '2026-04-01', termMonths: 24, endsAt: '2027-03-30' } });
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, purchasedAt: '', termMonths: '' })),
        { subscription: { purchasedAt: '', termMonths: '', endsAt: '' } }, 'emptied fields are cleared');
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, overlay: ' http://x.invalid/list.m3u ' })), { idOverlayUrl: 'http://x.invalid/list.m3u' });
    assert.deepEqual(plain(F.buildUpdate(p, { ...same, clearOverlay: true, overlay: 'http://ignored.invalid/' })), { idOverlayUrl: '' });
});

test('Providers cards show the settings but never the overlay address, and escape names', () => {
    const { context, F } = harness();
    const panel = new context.ProvidersSettings();
    const OVERLAY = 'http://epgenius.invalid/list.m3u?user=SECRETUSER&pass=SECRETPASS';
    const backup = { id: 4, type: 'xtream', name: 'Trex <b>', enabled: true, role: 'backup', priority: 1, maxConnections: 2,
        subscription: { purchasedAt: null, termMonths: null, endsAt: '2027-03-30' }, hasIdOverlay: true, idOverlayUrl: OVERLAY,
        url: 'http://host.invalid', password: 'hunter2', backupChannels: 55123 };
    panel.providers = [{ id: 1, type: 'xtream', name: 'Strong8K', enabled: true, role: 'primary', priority: null, maxConnections: null,
        subscription: {}, hasIdOverlay: false }, backup];
    panel.accounts = new Map([[4, { account: { status: 'Active', checkedAt: Date.now() - 60000, activeCons: 0, maxConnections: 1, ok: false,
        error: 'The provider did not answer (http://host.invalid/player_api.php?username=u&password=p)' },
        effective: { expiresAt: Date.UTC(2027, 2, 30, 23, 59, 59), expirySource: 'manual', limit: 2, expired: false } }]]);
    panel.syncRows = new Map([[4, { status: 'success', last_sync: Date.now() - 5000 }]]);
    panel.render();
    const out = context.document.getElementById('providers-list').innerHTML;
    assert.ok(!out.includes('SECRETUSER') && !out.includes('SECRETPASS') && !out.includes('epgenius') && !out.includes('hunter2') && !out.includes('host.invalid'), 'no address, login or password');
    assert.ok(out.includes('<strong>set</strong>') && out.includes('Remove the saved address'));
    assert.ok(!/value="[^"]*http/.test(out), 'the overlay box is empty');
    assert.ok(out.includes('Trex &lt;b&gt;') && !out.includes('Trex <b>'));
    assert.ok(out.includes('Backup 1') && out.includes('Primary'));
    assert.ok(out.includes('Tue 30 Mar 2027 · set by hand'));
    assert.ok(out.includes('1 of') === false && out.includes('0 of 2 in use · limit 2 (set by hand)'));
    assert.ok(out.includes('55,123'), 'backup channel count');
    assert.ok(out.includes('The last good values are kept'));
    // Only a backup has the order arrows; the first backup cannot go up.
    assert.equal((out.match(/data-provider-action="up"/g) || []).length, 1);
    assert.match(out, /data-provider-action="up"[^>]*disabled/);
    assert.equal((out.match(/data-provider-action="check"/g) || []).length, 2);
    void F;
});

test('Providers: a refused save shows the server\'s sentence on that card', async () => {
    const { context, elements } = harness({
        'PUT /api/sources/1': { __status: 400, error: 'There is already a primary provider (Strong8K). Make it a backup first, or disable it.' }
    });
    const panel = new context.ProvidersSettings();
    panel.providers = [{ id: 1, role: 'backup', subscription: {}, maxConnections: null }];
    const card = { querySelector: (sel) => ({ '[data-field="role"]': { value: 'primary' } })[sel] || null };
    const button = { closest: () => card, disabled: false };
    await panel.save(panel.providers[0], button);
    assert.equal(elements['provider-status-1'].textContent, 'There is already a primary provider (Strong8K). Make it a backup first, or disable it.');
    assert.equal(button.disabled, false, 'can be tried again');
});

test('Providers: up/down sends one PUT per changed priority', async () => {
    const puts = [];
    const { context, requests } = harness({
        'PUT /api/sources/4': {}, 'PUT /api/sources/2': {}, 'GET /api/sources/providers': [], 'GET /api/sources/status': []
    });
    const panel = new context.ProvidersSettings();
    panel.providers = [{ id: 1, role: 'primary' }, { id: 4, role: 'backup', priority: 1 }, { id: 2, role: 'backup', priority: 2 }];
    await panel.move(panel.providers[2], -1);
    for (const r of requests.filter(r => r.key.startsWith('PUT'))) puts.push([r.key, plain(r.body)]);
    assert.deepEqual(puts, [['PUT /api/sources/2', { priority: 1 }], ['PUT /api/sources/4', { priority: 2 }]]);
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

test('the add-source form asks for a role: primary for the first source, backup after that; the edit form and EPG do not', () => {
    const context = vm.createContext({ window: {}, console, document: { getElementById: () => null, querySelector: () => null }, Icons: {}, API: {} });
    vm.runInContext(js('components/SourceManager.js'), context);
    const manager = Object.create(context.window.SourceManager.prototype);
    manager.providerCount = 0;
    assert.match(manager.getSourceForm('xtream'), /id="source-role"[\s\S]*value="primary" selected/);
    manager.providerCount = 1;
    assert.match(manager.getSourceForm('m3u'), /id="source-role"[\s\S]*value="backup" selected/);
    assert.ok(!manager.getSourceForm('epg').includes('source-role'));
    assert.ok(!manager.getSourceForm('xtream', { id: 3, name: 'x' }).includes('source-role'), 'role is changed on the Providers tab');
});
