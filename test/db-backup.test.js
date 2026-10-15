const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const dbBackup = require('../server/services/dbBackup');

// R12 (Plan B1): the server copies content.db before a new build's migrations and once a day,
// through the same service scripts/backup-db.js uses. On 0212 none of this existed: the only
// backup was the manual script.

function fixture({ build = null, rows = 3 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbbackup-'));
    const dbPath = path.join(dir, 'content.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE t (n INTEGER)`);
    for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(i);
    if (build) db.prepare(`INSERT INTO meta VALUES ('schema_build', ?)`).run(build);
    db.close();
    return { dir, dbPath };
}
const rowsIn = (file) => { const d = new Database(file, { readonly: true }); try { return d.prepare('SELECT COUNT(*) c FROM t').get().c; } finally { d.close(); } };
const DAY = 24 * 60 * 60 * 1000;

test('a copy (sync or online) holds the data, opens cleanly and leaves no .partial behind', async () => {
    const { dbPath } = fixture({ rows: 5 });
    const a = dbBackup.backupSync(dbPath, { reason: 'manual', now: Date.UTC(2026, 9, 1) });
    const b = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 9, 2) });
    assert.equal(rowsIn(a), 5);
    assert.equal(rowsIn(b), 5);
    const names = fs.readdirSync(path.dirname(a));
    assert.ok(names.every(n => !n.endsWith('.partial')));
    assert.deepEqual(dbBackup.list(dbPath).map(x => x.reason), ['nightly', 'manual'], 'newest first, with the reason');
});

test('the newest 7 are kept, and two in the same second do not overwrite each other', () => {
    const { dbPath } = fixture();
    const base = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 9; i++) dbBackup.backupSync(dbPath, { reason: 'nightly', now: base + i * DAY });
    const same = dbBackup.backupSync(dbPath, { reason: 'manual', now: base + 8 * DAY });
    const kept = dbBackup.list(dbPath);
    assert.equal(kept.length, dbBackup.KEEP);
    assert.ok(kept.some(k => k.file === path.basename(same)), 'the same-second copy kept its own name');
    assert.ok(kept.every(k => k.at >= base + 3 * DAY), 'the oldest went first');
});

test('before migrations: a copy when the build changed or was never recorded, none otherwise', () => {
    const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbbackup-')), 'content.db');
    assert.equal(dbBackup.beforeMigrations(fresh, '0213').taken, false, 'a new install has nothing to copy');

    const older = fixture();
    const first = dbBackup.beforeMigrations(older.dbPath, '0213');
    assert.equal(first.taken, true, 'first start with R12: the build is unknown');
    assert.match(path.basename(first.file), /^content-.*-pre-migration\.db$/);

    const db = new Database(older.dbPath);
    dbBackup.recordBuild(db, '0213');
    db.close();
    assert.equal(dbBackup.beforeMigrations(older.dbPath, '0213').taken, false, 'same build: no copy');
    assert.equal(dbBackup.beforeMigrations(older.dbPath, '0214').taken, true, 'a new build: a copy');
});

test('the nightly check copies only when the newest backup is over a day old', async () => {
    const { dbPath } = fixture();
    const now = Date.UTC(2026, 9, 10, 3);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now }), 'none yet: one now');
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: now + DAY / 2 }), null);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: now + DAY + 60000 }));
});

test('the server opens the database through the pre-migration copy and records its build', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/db/sqlite.js'), 'utf8');
    const open = src.slice(src.indexOf('function getDb()'), src.indexOf('function databasePath'));
    assert.ok(open.indexOf('beforeMigrations(') > -1 && open.indexOf('beforeMigrations(') < open.indexOf('initSchema()'),
        'the copy is taken before the schema runs');
    assert.ok(open.indexOf('recordBuild(') > open.indexOf('initSchema()'));
    assert.match(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8'), /dbBackup'\)\.startNightly\(/);
});
