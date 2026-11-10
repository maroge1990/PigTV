const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 0135 (roadmap S4.3a): sources, settings and users live in SQLite (they were in
// data/db.json); the db.sources/settings/users API is unchanged; and
// settings.get() - read on every media request - hands out one frozen object
// instead of a structuredClone of the whole database per call. (The one-time
// import of a db.json went with D-57; the data here is saved through the API.)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbstore-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const dbFile = path.join(sandbox, 'data', 'db.json');
const db = require(path.join(sandbox, 'server', 'db'));
const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite'));

// Saved the way the server saves them: sources and users share one id counter (ids 1-4).
const saved = (async () => {
    const provider = await db.sources.create({ type: 'xtream', name: 'Provider', url: 'http://p.invalid', username: 'u', password: 'p' });
    const owner = await db.users.create({ username: 'owner', passwordHash: '$2a$10$hash', role: 'admin' });
    const kid = await db.users.create({ username: 'kid', passwordHash: '$2a$10$other', role: 'viewer', email: 'k@x.invalid' });
    const guide = await db.sources.toggleEnabled((await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://g.invalid/epg.xml' })).id);
    await db.settings.update({ quality: 'high', recordingsPath: '/mnt/rec', nested: { a: [1, 2] } });
    return { provider, owner, kid, guide };
})();

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// The child's own log lines (the SQLite "Opening database" line) come first.
const result = (out) => JSON.parse(out.slice(out.lastIndexOf('\nRESULT ') + 8));

/** What a freshly started server in this sandbox reads (a separate process: nothing cached). */
function readInChild(expr) {
    const code = `const db = require(${JSON.stringify(path.join(sandbox, 'server', 'db'))});
        (async () => { process.stdout.write('\\nRESULT ' + JSON.stringify(await (${expr}))); })();`;
    return result(execFileSync(process.execPath, ['-e', code], { cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

test('what was saved is read back, every field', async () => {
    const { provider, owner, kid, guide } = await saved;
    assert.deepEqual([provider.id, owner.id, kid.id, guide.id], [1, 2, 3, 4]);
    // 0168: a non-EPG source stored with no role reads as a primary (stored rows are not rewritten).
    assert.deepEqual(await db.sources.getAll(), [provider, guide], 'sources, every field');
    assert.equal(guide.enabled, false);
    assert.deepEqual((await db.users.getAll()).map(u => [u.id, u.username, u.passwordHash, u.role, u.email]),
        [[2, 'owner', '$2a$10$hash', 'admin', null], [3, 'kid', '$2a$10$other', 'viewer', 'k@x.invalid']], 'users, password hashes included');
    const settings = await db.settings.get();
    assert.equal(settings.quality, 'high');
    assert.equal(settings.recordingsPath, '/mnt/rec');
    assert.deepEqual(settings.nested, { a: [1, 2] });
    assert.equal(settings.maxProviderStreams, 1, 'defaults fill what was not saved');

    const created = await db.users.create({ username: 'guest', role: 'viewer' });
    assert.equal(created.id, 5, 'ids continue from the counter');
});

test('a db.json beside a database it was moved into before is ignored', () => {
    fs.writeFileSync(dbFile, JSON.stringify({ sources: [{ id: 99, name: 'Restored' }], settings: { quality: 'low' }, users: [], nextId: 100 }));
    try {
        assert.deepEqual(readInChild('db.sources.getAll()').map(s => s.id), [1, 4]);
        assert.equal(readInChild('db.settings.get()').quality, 'high');
    } finally { fs.unlinkSync(dbFile); }
});

test('sources round-trip: create, update, toggle, delete - and survive a restart', async () => {
    const s = await db.sources.create({ type: 'm3u', name: 'New', url: 'http://n.invalid/list.m3u' });
    assert.equal(s.id, 6);
    assert.equal(s.enabled, true);
    assert.ok(s.created_at && s.updated_at);
    assert.deepEqual(await db.sources.getById(String(s.id)), s, 'by id, number or string');

    const updated = await db.sources.update(s.id, { name: 'Renamed', epgUrl: 'http://e.invalid' });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.epgUrl, 'http://e.invalid');
    assert.equal(updated.url, 'http://n.invalid/list.m3u', 'a partial update keeps the rest');
    assert.equal(await db.sources.update(12345, { name: 'x' }), null, 'unknown id');

    assert.equal((await db.sources.toggleEnabled(s.id)).enabled, false);
    assert.equal((await db.sources.toggleEnabled(s.id)).enabled, true);

    assert.deepEqual(readInChild(`db.sources.getById(${s.id})`), await db.sources.getById(s.id), 'a new process reads the same');

    await db.sources.delete(s.id);
    assert.equal(await db.sources.getById(s.id), undefined);
});

test('users round-trip: create hides the hash, lookups, rename checks, the last admin is kept', async () => {
    const kid2 = await db.users.create({ username: 'kid2', passwordHash: 'h', role: 'viewer' });
    assert.equal(kid2.passwordHash, undefined, 'create returns no hash');
    assert.equal((await db.users.getByUsername('kid2')).passwordHash, 'h', 'but it is stored');
    await assert.rejects(db.users.create({ username: 'kid2' }), /Username already exists/);
    await assert.rejects(db.users.update(kid2.id, { username: 'owner' }), /Username already exists/);

    const renamed = await db.users.update(kid2.id, { username: 'teen', role: 'user' });
    assert.equal(renamed.username, 'teen');
    assert.equal(renamed.passwordHash, undefined);
    assert.equal(await db.users.getByUsername('kid2'), undefined);
    assert.equal((await db.users.getByUsername('teen')).id, kid2.id);
    await assert.rejects(db.users.update(9999, { role: 'admin' }), /User not found/);

    await assert.rejects(db.users.delete(2), /Cannot delete the last admin user/);
    assert.equal(await db.users.delete(kid2.id), true);
    await assert.rejects(db.users.delete(kid2.id), /User not found/);
    assert.equal(await db.users.count(), 3);
});

test('settings round-trip: update returns the stored settings, reset returns the defaults', async () => {
    const stored = await db.settings.update({ quality: 'low', minFreeSpaceGB: 25 });
    assert.equal(stored.quality, 'low');
    assert.equal(stored.minFreeSpaceGB, 25);
    assert.equal((await db.settings.get()).minFreeSpaceGB, 25);
    assert.equal(readInChild('db.settings.get()').minFreeSpaceGB, 25, 'persisted');
});

test('the hot path: settings.get() hands out one frozen object and never clones it', async () => {
    const realClone = globalThis.structuredClone;
    let clones = 0;
    globalThis.structuredClone = (v) => { clones++; return realClone(v); };
    try {
        const first = await db.settings.get();
        for (let i = 0; i < 1000; i++) assert.equal(await db.settings.get(), first, 'the same object every time');
        assert.equal(clones, 0, 'no structuredClone per read');
        assert.ok(Object.isFrozen(first), 'frozen, so no caller can change what the next one reads');
        assert.throws(() => { 'use strict'; first.quality = 'x'; }, TypeError);
    } finally { globalThis.structuredClone = realClone; }

    await db.settings.update({ quality: 'medium' });
    const before = await db.settings.get();
    await db.settings.update({ quality: 'high' });
    const after = await db.settings.get();
    assert.notEqual(after, before, 'a write replaces the object');
    assert.equal(before.quality, 'medium', 'an object already handed out does not change under its holder');
    assert.equal(after.quality, 'high');
});

test('a fresh install (no db.json) starts with the default settings and no sources or users', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbfresh-'));
    try {
        fs.cpSync(path.join(sandbox, 'server'), path.join(fresh, 'server'), { recursive: true });
        fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(fresh, 'node_modules'), 'junction');
        const code = `const db = require(${JSON.stringify(path.join(fresh, 'server', 'db'))});
            (async () => process.stdout.write('\\nRESULT ' + JSON.stringify({ s: await db.sources.getAll(), u: await db.users.count(),
                q: (await db.settings.get()).quality, id: (await db.sources.create({ name: 'x' })).id })))();`;
        const out = result(execFileSync(process.execPath, ['-e', code], { cwd: fresh, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
        assert.deepEqual(out, { s: [], u: 0, q: 'medium', id: 1 });
        assert.ok(!fs.existsSync(path.join(fresh, 'data', 'db.json')), 'no db.json is written any more');
    } finally {
        try { fs.rmdirSync(path.join(fresh, 'node_modules')); } catch { /* gone */ }
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
