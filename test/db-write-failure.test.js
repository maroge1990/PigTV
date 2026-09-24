const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A copy of the server with its own data/ folder, so the real database is never touched
// (same approach as access.test.js; a junction so it works on Windows without admin).
//
// 0080 made a failed db.json write reach the caller instead of being passed off as saved.
// 0135 moved sources, settings and users into SQLite; the promise is the same: a write that
// fails is reported in a plain sentence, leaves nothing half-done (on disk or in memory), and
// does not stop the next write. A failure is simulated with a trigger that aborts the write,
// the way a full disk or a read-only volume aborts SQLite's.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbfail-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'data', 'db.json'),
    JSON.stringify({ sources: [], settings: { quality: 'medium' }, users: [], nextId: 1 }));

const db = require(path.join(sandbox, 'server', 'db'));
const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite'));

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const TABLES = ['app_settings', 'app_sources', 'app_users', 'meta'];
function breakDisk() {
    const d = sqlite.getDb();
    for (const t of TABLES) {
        for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
            d.exec(`CREATE TRIGGER fail_${op}_${t} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'disk I/O error at /app/data/content.db (simulated)'); END;`);
        }
    }
}
function fixDisk() {
    const d = sqlite.getDb();
    for (const t of TABLES) for (const op of ['INSERT', 'UPDATE', 'DELETE']) d.exec(`DROP TRIGGER IF EXISTS fail_${op}_${t}`);
}
const quietly = async (fn) => {
    const realError = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = realError; }
};
const onDisk = (key) => {
    const row = sqlite.getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
};

test('a write that fails is reported to the caller, not passed off as saved', async () => {
    assert.equal((await db.settings.get()).quality, 'medium', 'migrated from db.json');
    breakDisk();
    try {
        await quietly(async () => {
            await assert.rejects(db.settings.update({ quality: 'high' }), (err) => {
                assert.match(err.message, /could not save its data/);
                assert.ok(!/content\.db|db\.json|\/app\//.test(err.message), 'no file path in what a client may be shown');
                assert.ok(err.cause, 'the underlying error is kept for the log');
                return true;
            });
        });
    } finally { fixDisk(); }
    assert.equal(onDisk('quality'), 'medium', 'and the stored value was left as it was');
});

test('the change does not stay live in memory after it failed to save', async () => {
    assert.equal((await db.settings.get()).quality, 'medium', 'the rejected update is not what the server now uses');
});

test('one failed write does not jam anything: the next save goes through', async () => {
    breakDisk();
    try { await quietly(() => assert.rejects(db.settings.update({ quality: 'high' }))); } finally { fixDisk(); }

    await db.settings.update({ quality: 'low' });
    assert.equal(onDisk('quality'), 'low');
    assert.equal((await db.settings.get()).quality, 'low');
});

test('a source created while the disk is failing is not left half-created, and uses up no id', async () => {
    breakDisk();
    try { await quietly(() => assert.rejects(db.sources.create({ type: 'm3u', name: 'Ghost', url: 'http://x.invalid/list.m3u' }))); } finally { fixDisk(); }
    assert.deepEqual((await db.sources.getAll()).map(s => s.name), [], 'nothing to see');

    const real = await db.sources.create({ type: 'm3u', name: 'Real', url: 'http://x.invalid/list.m3u' });
    assert.equal(real.name, 'Real');
    assert.equal(real.id, 1, 'the failed create did not take the id');
    assert.deepEqual((await db.sources.getAll()).map(s => s.name), ['Real']);
});

test('a refusal that is the caller\'s own (a duplicate username) keeps its message and changes nothing', async () => {
    await db.users.create({ username: 'owner', role: 'admin' });
    await assert.rejects(db.users.create({ username: 'owner' }), /Username already exists/);
    assert.equal(await db.users.count(), 1);
});

test('two updates in flight together both land (no read-modify-write of the whole store)', async () => {
    await Promise.all([db.settings.update({ quality: 'high' }), db.settings.update({ minFreeSpaceGB: 42 })]);
    const s = await db.settings.get();
    assert.equal(s.quality, 'high');
    assert.equal(s.minFreeSpaceGB, 42);
});
