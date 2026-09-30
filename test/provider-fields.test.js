const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0168 (multi-provider P1): a source gains provider fields (role, priority, maxConnections,
// subscription, idOverlayUrl). They are validated on POST/PUT, an old source reads as a
// primary, and nothing sensitive reaches a non-admin.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-fields-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
// A sync would go to the network; these tests only store and read.
let syncs = 0;
load('services/syncService').syncSource = async () => { syncs++; };

const OVERLAY = 'http://epgenius.invalid/list.m3u?user=SECRETUSER&pass=SECRETPASS';
let server, base, adminToken, viewerToken;

async function call(method, route, body, token = adminToken) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    const text = await response.text();
    try { json = JSON.parse(text); } catch { /* no body */ }
    return { status: response.status, body: json, text };
}

const addLive = (sourceId) => sqlite.getDb().prepare(
    `INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order)
     VALUES (?, ?, 'pos_1', 'live', 'Alpha', 'News', 0, 1)`).run(`${sourceId}:pos_1`, sourceId);

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(viewer);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
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

test('an existing source with no role reads as primary, an EPG source has none, and nothing is rewritten', async () => {
    const old = await db.sources.create({ type: 'xtream', name: 'Old', url: 'http://p.invalid', username: 'u', password: 'p' });
    const epg = await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://g.invalid/x.xml' });
    assert.equal((await db.sources.getById(old.id)).role, 'primary');
    assert.equal((await db.sources.getAll()).find(s => s.id === old.id).role, 'primary');
    assert.equal((await db.sources.getByType('xtream'))[0].role, 'primary');
    assert.equal((await db.sources.getById(epg.id)).role, undefined);
    const raw = JSON.parse(sqlite.getDb().prepare('SELECT data FROM app_sources WHERE id = ?').get(old.id).data);
    assert.equal('role' in raw, false, 'the stored row is untouched');
    // And a toggle or update still leaves it reading as primary.
    assert.equal((await db.sources.toggleEnabled(old.id)).role, 'primary');
    await db.sources.toggleEnabled(old.id);
    await db.sources.delete(old.id); await db.sources.delete(epg.id);
});

test('POST stores valid provider fields; PUT keeps what it does not mention and merges the subscription', async () => {
    const r = await call('POST', '/api/sources', {
        type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'secret-pass',
        role: 'backup', priority: 1, maxConnections: 2, idOverlayUrl: OVERLAY,
        subscription: { purchasedAt: '2026-01-31', termMonths: 3 }
    });
    assert.equal(r.status, 201, r.text);
    const id = r.body.id;
    const put = await call('PUT', `/api/sources/${id}`, { subscription: { endsAt: '2026-12-01' } });
    assert.equal(put.status, 200, put.text);
    const one = (await call('GET', `/api/sources/${id}`)).body;
    assert.deepEqual(one.subscription, { purchasedAt: '2026-01-31', termMonths: 3, endsAt: '2026-12-01' });
    assert.equal(one.role, 'backup'); assert.equal(one.priority, 1); assert.equal(one.maxConnections, 2);
    assert.equal(one.idOverlayUrl, OVERLAY, 'the admin edit form gets it');
    assert.equal(one.hasPassword, true);
    assert.ok(!('password' in one));
    const cleared = await call('PUT', `/api/sources/${id}`, { maxConnections: null, idOverlayUrl: '' });
    assert.equal(cleared.status, 200);
    const after = (await call('GET', `/api/sources/${id}`)).body;
    assert.equal(after.maxConnections, null); assert.equal(after.idOverlayUrl, null);
    await call('DELETE', `/api/sources/${id}`);
});

test('bad input is a 400 with a plain sentence', async () => {
    const good = { type: 'xtream', name: 'X', url: 'http://x.invalid', username: 'u', password: 'p' };
    const cases = [
        [{ role: 'boss' }, /role must be/],
        [{ priority: 0 }, /priority/], [{ priority: 'first' }, /priority/],
        [{ maxConnections: 0 }, /maxConnections/], [{ maxConnections: 1.5 }, /maxConnections/], [{ maxConnections: '3' }, /maxConnections/],
        [{ subscription: 'yes' }, /subscription must be an object/],
        [{ subscription: { endsAt: '2026-02-30' } }, /endsAt must be a real date/],
        [{ subscription: { purchasedAt: '30/09/2026' } }, /purchasedAt must be a real date/],
        [{ subscription: { termMonths: 0 } }, /termMonths/], [{ subscription: { termMonths: 121 } }, /termMonths/],
        [{ role: 'backup', idOverlayUrl: 'ftp://x.invalid/a.m3u' }, /idOverlayUrl must be an http/],
        [{ role: 'backup', idOverlayUrl: 'not a url' }, /idOverlayUrl must be an http/],
        [{ role: 'primary', idOverlayUrl: 'http://x.invalid/a.m3u' }, /only applies to a backup/],
        [{ idOverlayUrl: 'http://x.invalid/a.m3u' }, /only applies to a backup/]
    ];
    for (const [extra, pattern] of cases) {
        const r = await call('POST', '/api/sources', { ...good, ...extra });
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.match(r.body.error, pattern, JSON.stringify(extra));
    }
    assert.equal((await call('GET', '/api/sources')).body.length, 0, 'nothing was created');
    const epg = await call('POST', '/api/sources', { type: 'epg', name: 'G', url: 'http://g.invalid/x.xml', role: 'primary' });
    assert.equal(epg.status, 400);
    assert.match(epg.body.error, /EPG source has no provider settings/);
});

test('a second enabled primary that has streams is refused; a backup, or a primary without streams, is not', async () => {
    const a = (await call('POST', '/api/sources', { type: 'xtream', name: 'Strong8K', url: 'http://s.invalid', username: 'u', password: 'p', role: 'primary' })).body;
    // The first primary has no streams yet, so a second is allowed (nothing to conflict with).
    const b = await call('POST', '/api/sources', { type: 'xtream', name: 'Other', url: 'http://o.invalid', username: 'u', password: 'p', role: 'primary' });
    assert.equal(b.status, 201);
    await call('DELETE', `/api/sources/${b.body.id}`);
    addLive(a.id);
    const refused = await call('POST', '/api/sources', { type: 'xtream', name: 'Other', url: 'http://o.invalid', username: 'u', password: 'p', role: 'primary' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /already a primary provider \(Strong8K\)/);
    const backup = await call('POST', '/api/sources', { type: 'xtream', name: 'Trex', url: 'http://t.invalid', username: 'u', password: 'p', role: 'backup' });
    assert.equal(backup.status, 201);
    const promote = await call('PUT', `/api/sources/${backup.body.id}`, { role: 'primary' });
    assert.equal(promote.status, 400);
    // Making the first a backup frees the slot.
    assert.equal((await call('PUT', `/api/sources/${a.id}`, { role: 'backup' })).status, 200);
    assert.equal((await call('PUT', `/api/sources/${backup.body.id}`, { role: 'primary' })).status, 200);
    for (const s of (await call('GET', '/api/sources')).body) await call('DELETE', `/api/sources/${s.id}`);
});

test('no provider fields at all behaves as today: the same summary, and a plain second source is accepted', async () => {
    const a = await call('POST', '/api/sources', { type: 'm3u', name: 'One', url: 'http://one.invalid/a.m3u' });
    assert.equal(a.status, 201);
    addLive(a.body.id);
    const b = await call('POST', '/api/sources', { type: 'm3u', name: 'Two', url: 'http://two.invalid/a.m3u' });
    assert.equal(b.status, 201);
    const raw = JSON.parse(sqlite.getDb().prepare('SELECT data FROM app_sources WHERE id = ?').get(b.body.id).data);
    for (const k of ['role', 'priority', 'maxConnections', 'subscription', 'idOverlayUrl']) assert.equal(k in raw, false, k);
    for (const s of (await call('GET', '/api/sources')).body) await call('DELETE', `/api/sources/${s.id}`);
});

test('a non-admin sees only id, type, name and enabled; no provider field, login, overlay address or password', async () => {
    const r = await call('POST', '/api/sources', {
        type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'loginname', password: 'secret-pass',
        role: 'backup', priority: 2, maxConnections: 3, idOverlayUrl: OVERLAY, subscription: { endsAt: '2026-12-01' }
    });
    const id = r.body.id;
    for (const route of ['/api/sources', '/api/sources/type/xtream']) {
        const v = await call('GET', route, null, viewerToken);
        assert.equal(v.status, 200, route);
        assert.deepEqual(Object.keys(v.body[0]).sort(), ['enabled', 'id', 'name', 'type'], route);
        for (const secret of ['SECRETUSER', 'SECRETPASS', 'secret-pass', 'loginname', 'epgenius', 'trex.invalid']) {
            assert.ok(!v.text.includes(secret), `${route} leaks ${secret}`);
        }
    }
    // Everything else is admin only.
    for (const [method, route] of [['GET', `/api/sources/${id}`], ['GET', `/api/sources/${id}/account`], ['POST', `/api/sources/${id}/account/check`]]) {
        assert.equal((await call(method, route, null, viewerToken)).status, 403, route);
    }
    // An admin's provider list carries the settings but not the overlay address, and never a password.
    assert.equal((await call('GET', '/api/sources/providers', null, viewerToken)).status, 403);
    const list = await call('GET', '/api/sources/providers');
    assert.equal(list.body[0].role, 'backup');
    assert.deepEqual(list.body[0].subscription, { purchasedAt: null, termMonths: null, endsAt: '2026-12-01' });
    assert.equal(list.body[0].hasIdOverlay, true);
    for (const secret of ['SECRETUSER', 'SECRETPASS', 'secret-pass']) assert.ok(!list.text.includes(secret), `admin list leaks ${secret}`);
    const created = await call('PUT', `/api/sources/${id}`, { name: 'Trex 2' });
    assert.ok(!created.text.includes('SECRETPASS') && !created.text.includes('secret-pass'));
    await call('DELETE', `/api/sources/${id}`);
});

test('0172: changing only the order, limit or dates does not start a sync; any other change still does', async () => {
    const created = await call('POST', '/api/sources', { type: 'xtream', name: 'Backup', url: 'http://b.invalid', username: 'u', password: 'p', role: 'backup' });
    const id = created.body.id;
    await new Promise(r => setImmediate(r));
    syncs = 0;
    assert.equal((await call('PUT', `/api/sources/${id}`, { priority: 2 })).status, 200);
    assert.equal((await call('PUT', `/api/sources/${id}`, { maxConnections: 3, subscription: { endsAt: '2027-03-30' } })).status, 200);
    assert.equal(syncs, 0, 'no sync for settings-only updates');
    assert.equal((await call('PUT', `/api/sources/${id}`, { role: 'primary' })).status, 200);
    assert.equal(syncs, 1, 'a role change syncs (the backup and primary paths differ)');
    assert.equal((await call('PUT', `/api/sources/${id}`, { name: 'Renamed' })).status, 200);
    assert.equal(syncs, 2);
    await db.sources.delete(id);
});
