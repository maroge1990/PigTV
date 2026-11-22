const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const dbBackup = require('../server/services/dbBackup');

// #43 (0897): backups kept a shared newest-7 (a run of deploys left a day or two of history), were plain .db files on
// the same disk, and the nightly copy waited only for a sync, never for a play or recording. Now: 7 daily + 4 weekly,
// gzipped (old .db files still read), deferred while something plays or records (at most 6 h), and an optional second
// copy in PIGTV_BACKUP_COPY_DIR, verified and pruned the same way. On 0895 none of these exist.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const tmp = (p = 'pigtv-retain-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fixture(rows = 3) {
    const dir = tmp();
    const dbPath = path.join(dir, 'content.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE t (n INTEGER, s TEXT)`);
    for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?, ?)').run(i, `row ${i}`);
    db.close();
    return { dir, dbPath };
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dump = (file) => { const d = new Database(file, { readonly: true }); try { return d.prepare('SELECT n, s FROM t ORDER BY n').all(); } finally { d.close(); } };

beforeEach(() => {
    delete process.env.PIGTV_BACKUP_COPY_DIR;
    dbBackup._resetState();
});

test('retention keeps exactly 7 daily + 4 weekly (newest per UTC day / ISO week) across 40 simulated days', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2); // a Monday: ISO weeks are days 0-6, 7-13, ...
    const at = (d, h) => day0 + d * DAY + h * HOUR;
    const premigration = new Set([10, 20, 39]);
    for (let d = 0; d < 40; d++) {
        await dbBackup.backup(dbPath, { reason: 'nightly', now: at(d, 3) });
        if (premigration.has(d)) dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: at(d, 15) });
        const kept = dbBackup.list(dbPath);
        assert.equal(kept[0].at, premigration.has(d) ? at(d, 15) : at(d, 3), `day ${d}: the newest is always kept`);
        assert.ok(kept.length <= 11, `day ${d}: at most 7 + 4`);
    }
    const kept = dbBackup.list(dbPath).map(k => (k.at - day0) / HOUR);
    const expected = [
        39 * 24 + 15, // day 39's newest (a pre-migration copy): daily, and its week's newest
        ...[38, 37, 36, 35, 34, 33].map(d => d * 24 + 3), // the other six daily
        27 * 24 + 3, // week of days 21-27
        20 * 24 + 15 // week of days 14-20: its newest is day 20's pre-migration copy
    ];
    assert.deepEqual(kept, expected);
});

test('a gzipped copy restores to the same database as an uncompressed one, and both are listed and read', async () => {
    const { dbPath } = fixture(50);
    const plain = dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: Date.UTC(2026, 10, 1) });
    const packed = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 2) });
    assert.match(plain, /\.db$/);
    assert.match(packed, /\.db\.gz$/, 'a new copy is gzipped');
    assert.ok(fs.statSync(packed).size < fs.statSync(plain).size, 'and smaller');
    assert.deepEqual(dbBackup.list(dbPath).map(b => [b.reason, b.compressed]), [['nightly', true], ['pre-migration', false]]);
    assert.equal(dbBackup.newest(dbPath).file, path.basename(packed));
    const out = tmp();
    await dbBackup.extract(plain, path.join(out, 'a.db'));
    await dbBackup.extract(packed, path.join(out, 'b.db'));
    assert.deepEqual(dump(path.join(out, 'b.db')), dump(path.join(out, 'a.db')));
    assert.equal(dump(path.join(out, 'b.db')).length, 50);
    assert.equal(sha(path.join(out, 'b.db')), sha(path.join(out, 'a.db')), 'byte for byte the same database');
    if (process.platform !== 'win32') assert.equal(fs.statSync(packed).mode & 0o077, 0, 'owner-only: it holds provider logins');
});

test('the uncompressed pre-migration copy is gzipped later (verified first), off the start path', async () => {
    const { dbPath } = fixture(20);
    const plain = dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: Date.UTC(2026, 10, 1) });
    const before = dump(plain);
    const done = await dbBackup.compressPending(dbPath);
    assert.deepEqual(done.map(f => path.basename(f)), [`${path.basename(plain)}.gz`]);
    assert.ok(!fs.existsSync(plain));
    const out = path.join(tmp(), 'r.db');
    await dbBackup.extract(done[0], out);
    assert.deepEqual(dump(out), before);
});

test('a backup due during a play or recording waits, runs when it ends, and runs anyway after 6 h; Status says so', async () => {
    const { dbPath } = fixture();
    const t0 = Date.UTC(2026, 10, 5, 3);
    let playing = true;
    const active = () => playing;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t0, active }), null, 'none yet but something plays: waits');
    assert.equal(dbBackup.list(dbPath).length, 0);
    assert.equal(dbBackup.status().deferredSince, t0);
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t0 + HOUR, active }), null);
    playing = false;
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: t0 + 2 * HOUR, active }), 'idle again: copies');
    let s = dbBackup.status();
    assert.equal(s.deferredSince, null);
    assert.deepEqual({ late: s.lastRun.late, waitedMin: s.lastRun.waitedMin, forced: s.lastRun.forced }, { late: true, waitedMin: 120, forced: false });

    playing = true;
    const t1 = t0 + 2 * HOUR + DAY + 60000;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t1, active }), null);
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t1 + 5 * HOUR, active }), null);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: t1 + 6 * HOUR, active }), 'at the cap: runs while it plays');
    s = dbBackup.status();
    assert.equal(s.lastRun.forced, true);
    assert.equal(s.lastRun.waitedMin, 360);
    assert.equal(dbBackup.list(dbPath).length, 2);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: t1 + 6 * HOUR + DAY + 60000, active: () => { throw new Error('x'); } }), 'a failing active() never stops backups');
});

test('PIGTV_BACKUP_COPY_DIR: each copy appears there verified (size and checksum) and is pruned the same way', async () => {
    const { dbPath } = fixture();
    const second = tmp('pigtv-copy-');
    fs.writeFileSync(path.join(second, 'notes.txt'), 'not ours');
    process.env.PIGTV_BACKUP_COPY_DIR = second;
    const day0 = Date.UTC(2026, 10, 2);
    for (let d = 0; d < 12; d++) {
        const file = await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 + d * DAY });
        await dbBackup.whenCopied();
        const copy = path.join(second, path.basename(file));
        assert.ok(fs.existsSync(copy), `day ${d}: copied`);
        assert.equal(sha(copy), sha(file));
    }
    const names = (dir) => fs.readdirSync(dir).filter(n => /^content-/.test(n)).sort();
    assert.deepEqual(names(second), names(path.dirname(dbBackup.list(dbPath)[0].path)), 'the same retention in both folders');
    assert.ok(fs.existsSync(path.join(second, 'notes.txt')), 'a file that is not a backup is never touched');
    assert.ok(fs.readdirSync(second).every(n => !n.includes('.partial')));
    const s = dbBackup.status().copy;
    assert.equal(s.enabled, true);
    assert.equal(s.ok, true);
    assert.equal(s.problem, null);
    assert.ok(s.lastCopiedAt);
    assert.ok(!JSON.stringify(dbBackup.status()).includes(second), 'Status never names the folder\'s path');
});

test('a missing, relative or unwritable second folder leaves the primary backup whole and shows on Status', async () => {
    const { dbPath } = fixture(7);
    process.env.PIGTV_BACKUP_COPY_DIR = path.join(tmp(), 'not-mapped');
    const file = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 3) });
    await dbBackup.whenCopied();
    assert.ok(fs.existsSync(file));
    assert.equal(dbBackup.status().copy.ok, false);
    assert.equal(dbBackup.status().copy.problem, 'missing');

    process.env.PIGTV_BACKUP_COPY_DIR = 'relative/../dir';
    await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 4) });
    await dbBackup.whenCopied();
    assert.equal(dbBackup.status().copy.problem, 'not an absolute path');
    assert.ok(!fs.existsSync(path.resolve('relative')), 'nothing written relative to the working folder');

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const locked = tmp('pigtv-locked-');
        fs.chmodSync(locked, 0o500);
        process.env.PIGTV_BACKUP_COPY_DIR = locked;
        const f = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 5) });
        await dbBackup.whenCopied();
        assert.ok(fs.existsSync(f));
        assert.equal(dbBackup.status().copy.problem, 'not writable');
        assert.deepEqual(fs.readdirSync(locked), []);
        fs.chmodSync(locked, 0o700);
    }
    assert.equal(dbBackup.list(dbPath).length, 3, 'every primary copy kept');
});

test('with PIGTV_BACKUP_COPY_DIR unset nothing is written anywhere new', async () => {
    const { dir, dbPath } = fixture();
    await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 3) });
    await dbBackup.whenCopied();
    assert.deepEqual(fs.readdirSync(dir).filter(n => !/^content\.db/.test(n)), ['backups']);
    assert.deepEqual(dbBackup.status().copy, { enabled: false, ok: null, problem: null, lastCopiedAt: null });
});
