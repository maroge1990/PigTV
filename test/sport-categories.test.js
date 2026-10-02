const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const express = require('express');

// 0146 (contract C-H): Mark picks which categories count as sport, for the Apple Home screen's
// "Sport on now" row. /api/info advertises `sportCategories`; library/categories rows carry
// `sport`; an admin marks a category with PUT /api/library/categories/sport, stored apart from
// anything a sync writes and bumping library_rev; the web Sources picker has a Sport toggle.
// The old code has none of it: no flag, no field, and the PUT is a 404.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

let server, base, adminToken, viewerToken, source;

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
const get = async route => (await call('GET', route)).body;

const PLAYLIST = [
    [201, 'Fox Sports 505', 'Sport'],
    [202, 'Kayo 1', 'Sport'],
    [203, 'ABC News', 'News'],
    [204, 'Seven', 'Australia']
];
function playlist(channels) {
    return '#EXTM3U\n' + channels.map(([id, name, group]) =>
        `#EXTINF:-1 group-title="${group}",${name}\nhttp://provider.invalid/live/user/pass/${id}.ts`
    ).join('\n') + '\n';
}
async function syncWith(channels) {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(playlist(channels));
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }
}
const libraryRev = () => sqlite.getDb().prepare(`SELECT value FROM meta WHERE key = 'library_rev'`).get()?.value || '0';
const categoryId = async (name) => (await get('/api/library/categories')).find(c => c.name === name).id;
const sportNames = async () => (await get('/api/library/categories')).filter(c => c.sport).map(c => c.name);

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    await syncWith(PLAYLIST);

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/info', load('routes/info'));
    app.use('/api/library', load('routes/library'));
    app.use('/api/sources', load('routes/sources'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('/api/info advertises sportCategories', async () => {
    assert.equal((await get('/api/info')).features.sportCategories, true);
});

test('every library/categories row has sport, false until an admin marks it', async () => {
    const rows = await get('/api/library/categories');
    assert.ok(rows.length >= 3);
    for (const r of rows) assert.equal(r.sport, false, r.name);
});

test('an admin marks a category as sport; it shows on the categories and in the Sources catalogue; library_rev moves', async () => {
    const id = await categoryId('Sport');
    const r0 = libraryRev();
    const res = await call('PUT', '/api/library/categories/sport', { body: { sourceId: source.id, categoryId: id, sport: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, sport: true });
    assert.deepEqual(await sportNames(), ['Sport']);
    const r1 = libraryRev();
    assert.notEqual(r1, r0, 'a cached guide learns about it');

    // Marking it again changes nothing, and does not move the version.
    await call('PUT', '/api/library/categories/sport', { body: { sourceId: source.id, categoryId: id, sport: true } });
    assert.equal(libraryRev(), r1);

    const catalogue = await get(`/api/sources/${source.id}/catalogue?type=live`);
    assert.equal(catalogue.categories.find(c => c.name === 'Sport').sport, true);
    assert.equal(catalogue.categories.find(c => c.name === 'News').sport, false);
});

test('a playlist sync keeps the marks', async () => {
    await syncWith([...PLAYLIST, [205, 'Kayo 2', 'Sport']]);
    assert.deepEqual(await sportNames(), ['Sport']);
});

test('unmarking works; bad bodies are 400s and an unknown category a 404', async () => {
    const id = await categoryId('Sport');
    assert.equal((await call('PUT', '/api/library/categories/sport', { body: { sourceId: source.id, categoryId: id, sport: false } })).status, 200);
    assert.deepEqual(await sportNames(), []);
    assert.equal((await call('PUT', '/api/library/categories/sport', { body: { sourceId: source.id, categoryId: id } })).status, 400);
    assert.equal((await call('PUT', '/api/library/categories/sport', { body: { categoryId: id, sport: true } })).status, 400);
    assert.equal((await call('PUT', '/api/library/categories/sport', { body: { sourceId: source.id, categoryId: 'No such', sport: true } })).status, 404);
});

test('only an admin may mark a category', async () => {
    const id = await categoryId('News');
    const res = await call('PUT', '/api/library/categories/sport', { token: viewerToken, body: { sourceId: source.id, categoryId: id, sport: true } });
    assert.equal(res.status, 403);
    const anon = await fetch(`${base}/api/library/categories/sport`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: source.id, categoryId: id, sport: true }) });
    assert.equal(anon.status, 401);
    assert.deepEqual(await sportNames(), []);
});

test('the web Sources picker shows a Sport toggle per category and saves it', async () => {
    const calls = [];
    const context = vm.createContext({
        window: { app: {} },
        console: { ...console, warn() {}, error() {} },
        alert() {}, setTimeout: () => 0,
        document: { getElementById: () => null, querySelector: () => null },
        Icons: { chevronDown: '' },
        API: { library: { setCategorySport: async (...a) => { calls.push(a); return { success: true, sport: a[2] }; } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/SourceManager.js'), 'utf8'), context);
    const manager = Object.create(context.window.SourceManager.prototype);
    const group = { id: '10', name: 'Sport', categoryId: '10', sport: false, type: 'group', items: [{ type: 'channel', id: 'a', name: 'A' }] };
    Object.assign(manager, { treeData: { sourceId: 7, groups: [group] }, hiddenSet: new Set(), expandedGroups: new Set(), searchQuery: '' });

    assert.match(manager.getGroupHtml(group), /class="[^"]*sport-toggle[^"]*"[^>]*data-category-id="10"[^>]*aria-pressed="false"/);
    const button = { dataset: { categoryId: '10' }, disabled: false, classList: { toggle() {} }, setAttribute() {}, textContent: '' };
    await manager.toggleSport(button);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[7, '10', true]]);
    assert.equal(group.sport, true);
    assert.equal(button.textContent, 'Sport'); // Selection is graphical; the accessible pressed state persists.
    assert.match(manager.getGroupHtml(group), /aria-pressed="true"/);
    assert.doesNotMatch(manager.getGroupHtml({ ...group, categoryId: null }), /sport-toggle/, 'no toggle for a group with no category');
});
