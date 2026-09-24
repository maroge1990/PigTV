const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A copy of the server with its own data/ folder, so the real db.json is never touched
// (same approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dblegacy-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

// What a db.json written by an older version looks like: it still has the two JSON-file
// collections that nothing has read for a long time (hidden items and favourites live in SQLite).
const legacy = {
    sources: [{ id: 1, type: 'm3u', name: 'Main', enabled: true }, { id: 2, type: 'm3u', name: 'Other', enabled: true }],
    hiddenItems: [{ id: 3, source_id: 1, item_type: 'channel', item_id: 'pos_9' }],
    favorites: [{ id: 4, source_id: 1, item_id: 'pos_1', item_type: 'channel' }],
    settings: { quality: 'high' },
    users: [{ id: 5, username: 'owner', passwordHash: 'x', role: 'admin', oidcId: null }],
    nextId: 6
};
const dbFile = path.join(sandbox, 'data', 'db.json');
fs.writeFileSync(dbFile, JSON.stringify(legacy));

const db = require(path.join(sandbox, 'server', 'db'));

after(() => {
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('the JSON-file hidden items and favourites collections are gone from the module', () => {
    assert.equal(db.hiddenItems, undefined);
    assert.equal(db.favorites, undefined);
    assert.equal(typeof db.sources.getAll, 'function', 'sources, settings and users are untouched');
    assert.equal(typeof db.settings.get, 'function');
    assert.equal(typeof db.users.getByUsername, 'function');
});

test('an older db.json still loads: everything that is used comes through unchanged', async () => {
    assert.deepEqual((await db.sources.getAll()).map(s => s.name), ['Main', 'Other']);
    assert.equal((await db.settings.get()).quality, 'high');
    assert.equal((await db.users.getByUsername('owner')).role, 'admin');
});

test('0135: the migration into SQLite carries the used collections, not the two unread arrays, and keeps db.json as the backup', async () => {
    assert.ok(!fs.existsSync(dbFile), 'db.json is moved aside');
    const backup = JSON.parse(fs.readFileSync(dbFile + '.migrated', 'utf8'));
    assert.deepEqual(backup, legacy, 'the backup is the old file, untouched');

    const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite')).getDb();
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(t => t.name);
    assert.ok(!tables.some(t => /hidden|favorites_json/i.test(t) && t !== 'favorites'), 'no table for the unread arrays');
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM favorites`).get().n, 0, 'the JSON-file favourites are not copied into the real table');

    await db.sources.delete(2);
    assert.deepEqual((await db.sources.getAll()).map(s => s.name), ['Main'], 'the delete itself worked');
    assert.equal((await db.settings.get()).quality, 'high');
    assert.equal((await db.users.getAll())[0].username, 'owner');
    const created = await db.sources.create({ type: 'm3u', name: 'Third' });
    assert.equal(created.id, 6, 'ids keep counting from where they were');
});
