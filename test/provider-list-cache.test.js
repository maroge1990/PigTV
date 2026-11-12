const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { sqlCount } = require('./helpers/sqlCount');

// I-4 (#273): the provider list was read and JSON-parsed from SQLite on every admission question (the
// coordinator's directory, the failover plan's provider map, the Status page's per-provider read): about a
// dozen times for one resolve. It is now one parsed, frozen list in db.js (sources.listParsed), dropped on
// every source write, and the coordinator's directory and the routing map are built once per list. Same
// pools, limits, merged accounts and order as before: the directory is compared with the old code's.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-list-cache-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const coordinator = load('services/streamCoordinator');
const routing = load('services/providerRouting');
const recordingEngine = load('services/recordingEngine');
const auth = load('auth');
const statusRoute = load('routes/status');

const S = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60 };
const LEGACY = { multi: false, primary: null, backups: new Map() };
const APP_SOURCES = /app_sources/;
const BY_ID = /FROM app_sources WHERE id/; // the Status page's old per-provider read
// The Status poll's sync section still lists the sources with db.sources.getAll() (fresh objects, out of
// I-4's scope): one whole-table read per poll, which these counts allow for and nothing else.
const SYNC_SECTION_READS_PER_POLL = 1;
let A, B, C, E, server, base, token, counter;

// The directory exactly as the old code (before I-4) built it, read straight from the table: the oracle.
function oldDirectory() {
    const PRIMARY_POOL = 'primary';
    const LEGACY_DIRECTORY = Object.freeze({ multi: false, primary: null, backups: new Map() });
    try {
        if (typeof sqlite.isOpen !== 'function' || !sqlite.isOpen()) return LEGACY_DIRECTORY;
        const { withDefaults } = load('services/providerFields');
        const all = sqlite.getDb().prepare('SELECT data FROM app_sources ORDER BY id').all()
            .map(r => { try { return withDefaults(JSON.parse(r.data)); } catch (e) { return null; } })
            .filter(src => src && src.type !== 'epg');
        const backups = new Map(all.filter(src => src.role === 'backup').map(src => [Number(src.id), src]));
        const multi = [...backups.values()].some(src => src.enabled !== false);
        if (!multi) return LEGACY_DIRECTORY;
        const primaries = all.filter(src => src.role !== 'backup');
        const primary = primaries.find(src => src.enabled !== false) || primaries[0] || null;
        const { accountKeyFor } = load('services/accountKey');
        const poolOf = new Map();
        const merged = new Map();
        const firstOfKey = new Map();
        const primaryKey = primary ? accountKeyFor(primary) : null;
        if (primaryKey) firstOfKey.set(primaryKey, PRIMARY_POOL);
        for (const b of [...backups.values()].sort((x, y) => Number(x.id) - Number(y.id))) {
            const key = accountKeyFor(b);
            const owner = key && firstOfKey.has(key) ? firstOfKey.get(key) : Number(b.id);
            if (key && !firstOfKey.has(key)) firstOfKey.set(key, owner);
            poolOf.set(Number(b.id), owner);
            if (owner !== Number(b.id)) {
                if (!merged.has(owner)) merged.set(owner, []);
                merged.get(owner).push(b);
            }
        }
        return { multi, primary, backups, poolOf, merged };
    } catch (err) {
        return LEGACY_DIRECTORY;
    }
}

// Plain data (Maps by entries) so frozenness does not enter the comparison.
const plain = (v) => {
    if (v instanceof Map) return [...v.entries()].map(([k, x]) => [k, plain(x)]);
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
};

/** The cached directory equals the old one, and building the oracle is not counted. */
function assertSameDirectory(why) {
    const now = coordinator._providerDirectory?.();
    const old = oldDirectory();
    counter.reset();
    assert.deepEqual(plain(now), plain(old), `${why}: the directory is the one the old code builds`);
}

/** Every reader the hot paths use, once. */
function readEverything() {
    coordinator.providerLimit(A.id, S);
    coordinator.providerLimit(B.id, S);
    coordinator.poolOf(C.id);
    coordinator.samePool(B.id, C.id);
    coordinator.hasFreeConnection(B.id, S);
    coordinator.canAdmitWithoutDisturbing({ providerId: B.id, owner: 'device:tv', settings: S });
    coordinator.canRecordFreely(C.id, S);
    routing.snapshot();
    recordingEngine.listRecordings();
}

const poll = async () => {
    const r = await fetch(`${base}/api/status?details=0`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    return r.json();
};

/** After a write: the first read costs one app_sources statement, every later one none. */
async function oneReadThenNone(why) {
    counter.reset();
    coordinator.poolOf(B.id);
    assert.equal(counter.executions(APP_SOURCES), 1, `${why}: the first read after the write reads the table once`);
    for (let i = 0; i < 5; i++) readEverything();
    assert.equal(counter.executions(APP_SOURCES), 1, `${why}: and nothing after it reads it again`);
    await poll();
    assert.equal(counter.executions(BY_ID), 0, `${why}: the Status page reads no provider row by row`);
    assert.equal(counter.executions(APP_SOURCES), 1 + SYNC_SECTION_READS_PER_POLL, `${why}: the Status poll adds only its sync section's read`);
}

test('with the database not open the coordinator keeps the single legacy pool, and does not keep it once open', async () => {
    assert.equal(sqlite.isOpen(), false, 'the harness has not opened the database yet');
    assert.deepEqual(plain(coordinator._providerDirectory?.()), plain(LEGACY));
    assert.equal(coordinator.poolOf(7), 'primary');
    assert.equal(coordinator.providerLimit(null, { maxProviderStreams: 2 }), 2);
});

test('setup: a primary, two backups that are one account, and an EPG source', async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    A = await db.sources.create({ type: 'xtream', name: 'Strong8K', url: 'http://strong.invalid', username: 'u', password: 'p' });
    B = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    C = await db.sources.create({ type: 'xtream', name: 'Trex again', url: 'http://TREX.invalid/', username: 'u', password: 'q', role: 'backup', priority: 2 });
    E = await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://guide.invalid/epg.xml' });
    load('db/recordingsDb').initSchema();
    const app = express();
    app.use(express.json());
    app.use('/api/status', statusRoute);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    counter = sqlCount(sqlite.getDb());
    // Open, real directory now (the legacy answer was not kept): C counts in B's pool (one account).
    assert.equal(coordinator.poolOf(B.id), B.id);
    assert.equal(coordinator.poolOf(C.id), B.id, '0181: the same server and login is one pool');
    assertSameDirectory('fixture');
});

after(() => {
    counter?.restore();
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('50 rounds of every admission, routing and status read after a warm-up read the source table 0 times', async () => {
    readEverything();
    await poll();
    counter.reset();
    for (let i = 0; i < 50; i++) readEverything();
    assert.equal(counter.executions(APP_SOURCES), 0, 'no app_sources statement ran');
    assert.equal(counter.prepares(APP_SOURCES), 0, 'and none was prepared');
    assert.ok(coordinator._providerDirectory?.() && coordinator._providerDirectory() === coordinator._providerDirectory(), 'one directory, reused');
    for (let i = 0; i < 10; i++) await poll();
    assert.equal(counter.executions(BY_ID), 0, 'the Status page reads no provider row by row');
    assert.equal(counter.executions(APP_SOURCES), 10 * SYNC_SECTION_READS_PER_POLL, 'only the sync section\'s list, once per poll');
});

test('the list and its rows are frozen; getAll still hands out fresh objects that do not touch it', async () => {
    const list = db.sources.listParsed?.();
    assert.ok(Array.isArray(list), 'db.sources.listParsed() is the parsed list');
    assert.ok(Object.isFrozen(list));
    for (const s of list) assert.ok(Object.isFrozen(s), `source ${s.id} is frozen`);
    assert.deepEqual(list.map(s => s.id), [A.id, B.id, C.id, E.id], 'every source, EPG included, in id order');
    assert.equal(list[0].role, 'primary', 'with its role filled in');
    assert.equal(db.sources.listParsed(), list, 'the same array until a write');

    const fresh = await db.sources.getAll();
    assert.ok(!Object.isFrozen(fresh[0]));
    assert.notEqual(fresh[0], list[0]);
    fresh[0].name = 'Changed by a route';
    const one = await db.sources.getById(A.id);
    one.name = 'Changed too';
    assert.equal(db.sources.listParsed()[0].name, 'Strong8K', 'mutating getAll/getById results does not change the list');
});

test('create: the new provider is there at once, for one read of the table', async () => {
    const before = coordinator._providerDirectory?.();
    const G = await db.sources.create({ type: 'xtream', name: 'Gamma', url: 'http://gamma.invalid', username: 'g', password: 'g', role: 'backup', priority: 3 });
    await oneReadThenNone('create');
    assert.equal(coordinator.poolOf(G.id), G.id, 'a pool of its own');
    assert.ok(routing.snapshot().providers.some(p => p.id === G.id && p.name === 'Gamma'));
    assert.ok((await poll()).providers.some(p => p.id === G.id));
    assert.notEqual(coordinator._providerDirectory?.(), before, 'a new directory');
    assertSameDirectory('after create');
    // delete: gone at once.
    await db.sources.delete(G.id);
    await oneReadThenNone('delete');
    assert.equal(coordinator.poolOf(G.id), 'primary', 'no longer a backup pool');
    assert.ok(!routing.snapshot().providers.some(p => p.id === G.id));
    assert.ok(!(await poll()).providers.some(p => p.id === G.id));
    assertSameDirectory('after delete');
});

test('update: a changed login moves the backup out of the shared pool at once', async () => {
    assert.equal(coordinator.poolOf(C.id), B.id);
    await db.sources.update(C.id, { username: 'someone-else' });
    await oneReadThenNone('update');
    assert.equal(coordinator.poolOf(C.id), C.id, 'its own account now');
    assertSameDirectory('after update');
    await db.sources.update(C.id, { username: 'u' });
    assert.equal(coordinator.poolOf(C.id), B.id, 'and back');
    assertSameDirectory('after the second update');
});

test('setOrder: a new primary and order are seen at once', async () => {
    await db.sources.setOrder([{ id: A.id, role: 'backup', priority: 1 }, { id: B.id, role: 'primary', priority: null }, { id: C.id, role: 'backup', priority: 2 }]);
    await oneReadThenNone('setOrder');
    assert.equal(coordinator._providerDirectory?.()?.primary?.id, B.id, 'B is the primary');
    assert.equal(coordinator.poolOf(A.id), A.id, 'A is a backup with its own pool');
    assert.equal(coordinator.poolOf(C.id), 'primary', 'C shares the new primary\'s account');
    assert.deepEqual(routing.snapshot().providers.map(p => [p.id, p.role]), [[A.id, 'backup'], [B.id, 'primary'], [C.id, 'backup']]);
    assertSameDirectory('after setOrder');
    await db.sources.setOrder([{ id: A.id, role: 'primary', priority: null }, { id: B.id, role: 'backup', priority: 1 }, { id: C.id, role: 'backup', priority: 2 }]);
    assert.equal(coordinator.poolOf(C.id), B.id);
    assertSameDirectory('after setOrder back');
});

test('toggleEnabled: a disabled provider is seen at once (and every backup disabled is the single pool)', async () => {
    await db.sources.toggleEnabled(B.id);
    await oneReadThenNone('toggleEnabled');
    assert.equal(coordinator._providerDirectory?.()?.backups?.get(B.id)?.enabled, false);
    assert.equal((await poll()).providers.find(p => p.id === B.id)?.enabled, false, 'the Status page shows it disabled');
    assertSameDirectory('after toggleEnabled');
    await db.sources.toggleEnabled(C.id);
    assert.deepEqual(plain(coordinator._providerDirectory?.()), plain(LEGACY), 'no enabled backup: one pool, as before');
    assertSameDirectory('every backup disabled');
    await db.sources.toggleEnabled(B.id);
    await db.sources.toggleEnabled(C.id);
    assert.equal(coordinator.poolOf(C.id), B.id);
    assertSameDirectory('enabled again');
});

test('the directory follows an account key that changes without a source write (an M3U login learned by a sync)', async () => {
    const M = await db.sources.create({ type: 'm3u', name: 'Dream', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 4 });
    assert.equal(coordinator.poolOf(M.id), M.id, 'no login can be derived: its own pool');
    // A sync saw the header naming the primary's login: the same account as A.
    sqlite.getDb().prepare(`INSERT INTO provider_accounts (source_id, m3u_login) VALUES (?, ?)
        ON CONFLICT(source_id) DO UPDATE SET m3u_login = excluded.m3u_login`)
        .run(M.id, JSON.stringify({ url: 'http://strong.invalid', username: 'u', password: 'p' }));
    load('services/accountKey').reset(); // its 30 s cache, as time passing would
    assert.equal(coordinator.poolOf(M.id), 'primary', 'now the primary\'s account');
    assertSameDirectory('after the learned login');
    await db.sources.delete(M.id);
});
