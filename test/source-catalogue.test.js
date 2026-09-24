const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0120: the Sources screen's category/channel picker reads a source's whole live
// catalogue - hidden items included - through the Xtream-emulation routes, which
// W2.1 removes. GET /api/sources/:id/catalogue gives it the same thing straight
// from SQLite. The old code has no such route (the router answers 404).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-catalogue-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, adminToken, viewerToken, source, other;

const get = async (route, token = adminToken) => {
    const r = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
};

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    const viewer = await db.users.create({ username: 'viewer', role: 'user' });
    viewerToken = auth.generateToken(viewer);
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    other = await db.sources.create({ type: 'm3u', name: 'Other', url: 'http://other.invalid/list.m3u' });

    const d = sqlite.getDb();
    const cat = d.prepare(`INSERT INTO categories (id, source_id, category_id, type, name, is_hidden, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    cat.run(`${source.id}:Sport`, source.id, 'Sport', 'live', 'Sport', 1, 2);   // hidden, second
    cat.run(`${source.id}:News`, source.id, 'News', 'live', 'News', 0, 1);      // visible, first
    cat.run(`${source.id}:Films`, source.id, 'Films', 'movie', 'Films', 0, 3);  // not live: left out
    cat.run(`${other.id}:Else`, other.id, 'Else', 'live', 'Else', 0, 1);        // other source: left out
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    item.run(`${source.id}:pos_3`, source.id, 'pos_3', 'live', 'Sky Sport', 'Sport', 0, 3, 's3');
    item.run(`${source.id}:pos_1`, source.id, 'pos_1', 'live', 'BBC News', 'News', 0, 1, 's1');
    item.run(`${source.id}:pos_2`, source.id, 'pos_2', 'live', 'Hidden News', 'News', 1, 2, 's2');
    item.run(`${source.id}:m_1`, source.id, 'm_1', 'movie', 'A Film', 'Films', 0, 4, null);
    item.run(`${other.id}:pos_1`, other.id, 'pos_1', 'live', 'Elsewhere', 'Else', 0, 1, 'o1');
    d.prepare(`INSERT INTO channel_numbers (source_id, channel_key, item_id, number, last_seen) VALUES (?, 's1', 'pos_1', 7, ?)`)
        .run(source.id, Date.now());

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
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

test('the live catalogue lists every category and channel of the source, hidden ones included, in provider order', async () => {
    const r = await get(`/api/sources/${source.id}/catalogue?type=live`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
        categories: [
            { id: 'News', name: 'News', hidden: false, channelCount: 2, sport: false },
            { id: 'Sport', name: 'Sport', hidden: true, channelCount: 1, sport: false }
        ],
        channels: [
            { id: 'pos_1', name: 'BBC News', categoryId: 'News', hidden: false, number: 7 },
            { id: 'pos_2', name: 'Hidden News', categoryId: 'News', hidden: true, number: null },
            { id: 'pos_3', name: 'Sky Sport', categoryId: 'Sport', hidden: false, number: null }
        ]
    });
});

test('type defaults to live', async () => {
    const r = await get(`/api/sources/${source.id}/catalogue`);
    assert.equal(r.status, 200);
    assert.equal(r.body.channels.length, 3);
});

test('movie and series are refused as not supported; anything else is a 400 too', async () => {
    for (const type of ['movie', 'series']) {
        const r = await get(`/api/sources/${source.id}/catalogue?type=${type}`);
        assert.equal(r.status, 400, type);
        assert.match(r.body.error, /not supported/);
    }
    assert.equal((await get(`/api/sources/${source.id}/catalogue?type=radio`)).status, 400);
});

test('admin only, and an unknown source is a 404', async () => {
    assert.equal((await get(`/api/sources/${source.id}/catalogue?type=live`, viewerToken)).status, 403);
    assert.equal((await get('/api/sources/9999/catalogue?type=live')).status, 404);
});
