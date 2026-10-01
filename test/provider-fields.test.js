const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0168 (multi-provider P1): a source gains provider fields (role, priority, and since 0182
// epgUrl and idOverlayUrl on any role; the hand-typed limit and dates are gone). They are validated on POST/PUT, an old source reads as a
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

const GUIDE = 'http://epgenius.invalid/guide.xml?user=SECRETUSER&pass=SECRETPASS';
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

test('POST stores valid provider fields; PUT keeps what it does not mention; the old limit and dates are ignored', async () => {
    const r = await call('POST', '/api/sources', {
        type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'secret-pass',
        role: 'backup', priority: 1, epgUrl: GUIDE, idOverlayUrl: OVERLAY,
        maxConnections: 2, subscription: { purchasedAt: '2026-01-31', termMonths: 3 }
    });
    assert.equal(r.status, 201, r.text);
    const id = r.body.id;
    const raw = () => JSON.parse(sqlite.getDb().prepare('SELECT data FROM app_sources WHERE id = ?').get(id).data);
    assert.equal('maxConnections' in raw() || 'subscription' in raw(), false, '0182: not stored');
    const put = await call('PUT', `/api/sources/${id}`, { priority: 2 });
    assert.equal(put.status, 200, put.text);
    const one = (await call('GET', `/api/sources/${id}`)).body;
    assert.equal(one.role, 'backup'); assert.equal(one.priority, 2);
    assert.equal(one.epgUrl, GUIDE, 'the admin edit form gets the guide address');
    assert.equal(one.idOverlayUrl, OVERLAY, 'and the overlay address');
    assert.ok(!('maxConnections' in one) && !('subscription' in one));
    assert.equal(one.hasPassword, true);
    assert.ok(!('password' in one));
    const cleared = await call('PUT', `/api/sources/${id}`, { epgUrl: '', idOverlayUrl: '' });
    assert.equal(cleared.status, 200);
    const after = (await call('GET', `/api/sources/${id}`)).body;
    assert.equal(after.epgUrl, null); assert.equal(after.idOverlayUrl, null);
    await call('DELETE', `/api/sources/${id}`);
});

test('bad input is a 400 with a plain sentence', async () => {
    const good = { type: 'xtream', name: 'X', url: 'http://x.invalid', username: 'u', password: 'p' };
    const cases = [
        [{ role: 'boss' }, /role must be/],
        [{ priority: 0 }, /priority/], [{ priority: 'first' }, /priority/],
        [{ idOverlayUrl: 'ftp://x.invalid/a.m3u' }, /idOverlayUrl must be an http/],
        [{ idOverlayUrl: 'not a url' }, /idOverlayUrl must be an http/],
        [{ epgUrl: 'ftp://x.invalid/a.xml' }, /epgUrl must be an http/],
        [{ epgUrl: 42 }, /epgUrl must be an http/]
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
    // 0182: every card is the same, so the primary may keep an overlay address too.
    const primary = await call('POST', '/api/sources', { ...good, role: 'primary', idOverlayUrl: OVERLAY });
    assert.equal(primary.status, 201, primary.text);
    await call('DELETE', `/api/sources/${primary.body.id}`);
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

test('0182: the first provider added is the primary; later ones are backups at the end of the order', async () => {
    const a = await call('POST', '/api/sources', { type: 'm3u', name: 'One', url: 'http://one.invalid/a.m3u' });
    assert.equal(a.status, 201);
    const b = await call('POST', '/api/sources', { type: 'm3u', name: 'Two', url: 'http://two.invalid/a.m3u' });
    const c = await call('POST', '/api/sources', { type: 'xtream', name: 'Three', url: 'http://three.invalid', username: 'u', password: 'p' });
    const list = (await call('GET', '/api/sources/providers')).body;
    const of = (id) => list.find(p => p.id === id);
    assert.equal(of(a.body.id).role, 'primary');
    assert.deepEqual([of(b.body.id).role, of(b.body.id).priority], ['backup', 1]);
    assert.deepEqual([of(c.body.id).role, of(c.body.id).priority], ['backup', 2]);
    // An EPG source is not a provider and does not make the next one a backup.
    for (const s of list) await call('DELETE', `/api/sources/${s.id}`);
    await call('POST', '/api/sources', { type: 'epg', name: 'G', url: 'http://g.invalid/x.xml' });
    const first = await call('POST', '/api/sources', { type: 'm3u', name: 'First', url: 'http://one.invalid/a.m3u' });
    assert.equal((await db.sources.getById(first.body.id)).role, 'primary');
    for (const s of (await call('GET', '/api/sources')).body) await call('DELETE', `/api/sources/${s.id}`);
});

test('0182: PUT /api/sources/order makes the first the primary and numbers the backups; only changed roles sync', async () => {
    const ids = [];
    for (const name of ['A', 'B', 'C']) ids.push((await call('POST', '/api/sources', { type: 'xtream', name, url: `http://${name}.invalid`, username: 'u', password: 'p' })).body.id);
    const [a, b, c] = ids;
    addLive(a);
    await new Promise(r => setImmediate(r));
    const roles = async () => Object.fromEntries((await call('GET', '/api/sources/providers')).body.map(p => [p.id, [p.role, p.priority]]));
    const order = (list, token) => call('PUT', '/api/sources/order', { ids: list }, token);

    for (const bad of [[a, b], [a, b, b], [a, b, 9999], 'abc']) {
        const r = await order(bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.match(r.body.error, /every provider exactly once/);
    }
    assert.equal((await order([a, b, c], viewerToken)).status, 403);

    syncs = 0;
    let r = await order([a, c, b]);
    assert.deepEqual(r.body, { success: true, primaryChanged: false });
    assert.deepEqual(await roles(), { [a]: ['primary', null], [c]: ['backup', 1], [b]: ['backup', 2] });
    await new Promise(r2 => setTimeout(r2, 20));
    assert.equal(syncs, 0, 'reordering backups syncs nothing');

    r = await order([c, a, b]);
    assert.deepEqual(r.body, { success: true, primaryChanged: true });
    assert.deepEqual(await roles(), { [c]: ['primary', null], [a]: ['backup', 1], [b]: ['backup', 2] });
    await new Promise(r2 => setTimeout(r2, 20));
    assert.equal(syncs, 2, 'the old and the new primary are synced');

    // Deleting the primary closes the cards up: the first backup takes its place.
    syncs = 0;
    assert.equal((await call('DELETE', `/api/sources/${c}`)).status, 200);
    assert.deepEqual(await roles(), { [a]: ['primary', null], [b]: ['backup', 1] });
    await new Promise(r2 => setTimeout(r2, 20));
    assert.equal(syncs, 1, 'the promoted provider is synced');
    assert.equal((await call('DELETE', `/api/sources/${b}`)).status, 200);
    assert.deepEqual(await roles(), { [a]: ['primary', null] });
    await call('DELETE', `/api/sources/${a}`);
});

test('a non-admin sees only id, type, name and enabled; no provider field, login, overlay address or password', async () => {
    const r = await call('POST', '/api/sources', {
        type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'loginname', password: 'secret-pass',
        role: 'backup', priority: 2, epgUrl: GUIDE, idOverlayUrl: OVERLAY
    });
    const id = r.body.id;
    for (const route of ['/api/sources', '/api/sources/type/xtream']) {
        const v = await call('GET', route, null, viewerToken);
        assert.equal(v.status, 200, route);
        assert.deepEqual(Object.keys(v.body[0]).sort(), ['enabled', 'id', 'name', 'type'], route);
        for (const secret of ['SECRETUSER', 'SECRETPASS', 'secret-pass', 'loginname', 'epgenius', 'trex.invalid', 'guide.xml']) {
            assert.ok(!v.text.includes(secret), `${route} leaks ${secret}`);
        }
    }
    // Everything else is admin only.
    for (const [method, route] of [['GET', `/api/sources/${id}`], ['GET', `/api/sources/${id}/account`], ['POST', `/api/sources/${id}/account/check`]]) {
        assert.equal((await call(method, route, null, viewerToken)).status, 403, route);
    }
    // An admin's provider list carries the settings but not the guide or overlay address, and never a password.
    assert.equal((await call('GET', '/api/sources/providers', null, viewerToken)).status, 403);
    const list = await call('GET', '/api/sources/providers');
    assert.equal(list.body[0].role, 'backup');
    assert.equal(list.body[0].hasEpg, true);
    assert.equal(list.body[0].hasIdOverlay, true);
    assert.ok(!('subscription' in list.body[0]) && !('maxConnections' in list.body[0]));
    for (const secret of ['SECRETUSER', 'SECRETPASS', 'secret-pass']) assert.ok(!list.text.includes(secret), `admin list leaks ${secret}`);
    const created = await call('PUT', `/api/sources/${id}`, { name: 'Trex 2' });
    assert.ok(!created.text.includes('SECRETPASS') && !created.text.includes('secret-pass'));
    await call('DELETE', `/api/sources/${id}`);
});

test('0172: changing only the order does not start a sync; any other change still does', async () => {
    const created = await call('POST', '/api/sources', { type: 'xtream', name: 'Backup', url: 'http://b.invalid', username: 'u', password: 'p', role: 'backup' });
    const id = created.body.id;
    await new Promise(r => setImmediate(r));
    syncs = 0;
    assert.equal((await call('PUT', `/api/sources/${id}`, { priority: 2 })).status, 200);
    assert.equal(syncs, 0, 'no sync for an order-only update');
    assert.equal((await call('PUT', `/api/sources/${id}`, { role: 'primary' })).status, 200);
    assert.equal(syncs, 1, 'a role change syncs (the backup and primary paths differ)');
    assert.equal((await call('PUT', `/api/sources/${id}`, { name: 'Renamed' })).status, 200);
    assert.equal(syncs, 2);
    await db.sources.delete(id);
});

test('0181: GET /api/sources/providers names the other providers that are the same account (ids only, admin only)', async () => {
    const a = await db.sources.create({ type: 'xtream', name: 'Dream4K', url: 'http://Dream.invalid:80', username: 'sameuser', password: 'PW-ONE' });
    const b = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://dream.invalid/', username: 'sameuser', password: 'PW-TWO', role: 'backup' });
    const c = await db.sources.create({ type: 'xtream', name: 'Other login', url: 'http://dream.invalid', username: 'differentuser', password: 'p', role: 'backup' });
    const d = await db.sources.create({ type: 'xtream', name: 'Other server', url: 'http://other.invalid', username: 'sameuser', password: 'p', role: 'backup' });
    const list = await call('GET', '/api/sources/providers');
    const of = (id) => list.body.find(p => p.id === id);
    assert.deepEqual(of(a.id).sharesAccountWith, [b.id]);
    assert.deepEqual(of(b.id).sharesAccountWith, [a.id]);
    assert.deepEqual(of(c.id).sharesAccountWith, [], 'same server, different username: separate');
    assert.deepEqual(of(d.id).sharesAccountWith, [], 'same username, different server: separate');
    for (const secret of ['sameuser', 'differentuser', 'PW-ONE', 'PW-TWO']) assert.ok(!list.text.includes(secret), `the list leaks ${secret}`);
    assert.ok(!/"[0-9a-f]{16}"/.test(list.text), 'no account key is returned');
    assert.equal((await call('GET', '/api/sources/providers', null, viewerToken)).status, 403);
    for (const s of [a, b, c, d]) await db.sources.delete(s.id);
});
