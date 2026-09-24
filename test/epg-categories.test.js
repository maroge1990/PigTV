const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');

// 0147 (contract C-I): EPG programme categories are stored at ingest. The parser always
// collected XMLTV <category> into `category: []`, but the sync's INSERT dropped it. Now
// epg_programs.categories holds them (a JSON array), the epg_live view exposes the column
// (an older database's view is dropped and made again), both the XMLTV-source and the
// Xtream (xmltv.php) paths fill it, and GET /api/sports/categories (admin) counts them for
// the Status page's "EPG categories" panel. The old code has no column and no route.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-epgcat-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

// A database as 0146 left it: epg_programs with `gen` but no `categories`, and the
// epg_live view without the column.
fs.mkdirSync(path.join(sandbox, 'data'));
{
    const legacy = new Database(path.join(sandbox, 'data/content.db'));
    legacy.exec(`
        CREATE TABLE epg_programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, title TEXT, description TEXT, data JSON, gen INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE epg_state (source_id INTEGER PRIMARY KEY, active_gen INTEGER NOT NULL DEFAULT 0);
        CREATE VIEW epg_live AS
            SELECT p.id, p.channel_id, p.source_id, p.start_time, p.end_time, p.title, p.description, p.data
            FROM epg_programs p LEFT JOIN epg_state s ON s.source_id = p.source_id
            WHERE p.gen = COALESCE(s.active_gen, 0);`);
    legacy.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)')
        .run('old.1', 99, 1000, 2000, 'Old programme');
    legacy.close();
}

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

let server, base, adminToken, viewerToken, epgSource, xtreamSource;

const T = (h) => {
    const d = new Date(Date.UTC(2026, 8, 25, h, 0, 0));
    return d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
};
function xmltv(prefix) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="${prefix}.fox"><display-name>Fox Sports</display-name></channel>
  <programme start="${T(10)}" stop="${T(13)}" channel="${prefix}.fox">
    <title>NFL: Chiefs v Bills</title><category>Sport</category><category>American Football</category><category>sport</category>
  </programme>
  <programme start="${T(13)}" stop="${T(14)}" channel="${prefix}.fox">
    <title>Sports Tonight</title><category>Sport</category><category>News</category>
  </programme>
  <programme start="${T(14)}" stop="${T(15)}" channel="${prefix}.fox">
    <title>Movie</title>
  </programme>
</tv>`;
}

async function withFetch(handler, fn) {
    const originalFetch = global.fetch;
    global.fetch = async (url) => handler(String(url));
    try { return await fn(); } finally { global.fetch = originalFetch; }
}

async function call(route, token = adminToken) {
    const r = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    let body = null;
    try { body = await r.json(); } catch { /* none */ }
    return { status: r.status, body };
}

before(async () => {
    adminToken = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    viewerToken = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    epgSource = await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://guide.invalid/epg.xml' });
    xtreamSource = await db.sources.create({ type: 'xtream', name: 'Provider', url: 'http://xtream.invalid', username: 'u', password: 'p' });

    const app = express();
    app.use(express.json());
    app.use('/api/sports', load('routes/sports'));
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

test('an older database gains the column, and its epg_live view is made again with it', () => {
    const d = sqlite.getDb();
    assert.ok(d.prepare('PRAGMA table_info(epg_programs)').all().some(c => c.name === 'categories'));
    assert.ok(d.prepare('PRAGMA table_info(epg_live)').all().some(c => c.name === 'categories'));
    const old = d.prepare(`SELECT title, categories FROM epg_live WHERE source_id = 99`).get();
    assert.deepEqual({ ...old }, { title: 'Old programme', categories: null }, 'rows from before are still live');
    // Opening again leaves the (now current) view alone.
    sqlite.initSchema();
    assert.ok(d.prepare('PRAGMA table_info(epg_live)').all().some(c => c.name === 'categories'));
});

test('an XMLTV source sync stores each programme\'s categories, de-duplicated; epg_live exposes them', async () => {
    await withFetch(() => new Response(xmltv('g')), () => sync.syncSource(epgSource.id));
    const rows = sqlite.getDb().prepare(`SELECT title, categories FROM epg_live WHERE source_id = ? ORDER BY start_time`).all(epgSource.id);
    assert.deepEqual(rows.map(r => [r.title, r.categories === null ? null : JSON.parse(r.categories)]), [
        ['NFL: Chiefs v Bills', ['Sport', 'American Football']],
        ['Sports Tonight', ['Sport', 'News']],
        ['Movie', null]
    ]);
});

test('the Xtream path (xmltv.php) stores them too', async () => {
    await withFetch((url) => new Response(url.includes('xmltv.php') ? xmltv('x') : '[]'), () => sync.syncSource(xtreamSource.id));
    const rows = sqlite.getDb().prepare(`SELECT categories FROM epg_live WHERE source_id = ? AND categories IS NOT NULL`).all(xtreamSource.id);
    assert.deepEqual(rows.map(r => JSON.parse(r.categories)), [['Sport', 'American Football'], ['Sport', 'News']]);
});

test('GET /api/sports/categories counts programmes per category over the live guide, most used first', async () => {
    const { status, body } = await call('/api/sports/categories');
    assert.equal(status, 200);
    assert.deepEqual(body, [
        { category: 'Sport', programmes: 4 },
        { category: 'American Football', programmes: 2 },
        { category: 'News', programmes: 2 }
    ]);
});

test('a sync that replaces the guide is reflected (the count is cached per EPG generation)', async () => {
    await withFetch(() => new Response(xmltv('g').replace('<category>News</category>', '<category>Magazine</category>')),
        () => sync.syncSource(epgSource.id));
    const { body } = await call('/api/sports/categories');
    assert.deepEqual(body.map(r => [r.category, r.programmes]), [['Sport', 4], ['American Football', 2], ['Magazine', 1], ['News', 1]]);
});

test('only an admin may list the categories', async () => {
    assert.equal((await call('/api/sports/categories', viewerToken)).status, 403);
    assert.equal((await fetch(`${base}/api/sports/categories`)).status, 401);
});

test('the Status page shows an "EPG categories" panel', async () => {
    const elements = { 'status-epg-categories': { innerHTML: '' } };
    const context = vm.createContext({
        window: {}, console, setInterval: () => 0, clearInterval() {},
        document: { getElementById: (id) => elements[id] || null },
        API: { status: { get: async () => ({}) }, sports: { categories: async () => [{ category: 'Sport', programmes: 4 }, { category: 'A <b>', programmes: 1 }] } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/StatusPage.js'), 'utf8'), context);
    const page = new context.window.StatusPage({});
    await page.loadEpgCategories();
    const html = elements['status-epg-categories'].innerHTML;
    assert.match(html, /<h3>EPG categories<\/h3>/);
    assert.match(html, /<td>Sport<\/td><td>4<\/td>/);
    assert.match(html, /A &lt;b&gt;/, 'provider text is escaped');
    assert.match(html, /2 categories/);
});
