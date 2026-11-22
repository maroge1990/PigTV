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
        assert.ok(kept.length <= 14, `day ${d}: at most 7 + 4 + 3`);
    }
    const kept = dbBackup.list(dbPath).map(k => (k.at - day0) / HOUR);
    // Review of 0898: pre-migration snapshots have their own retention (the newest 3); the daily and weekly picks are
    // made among the other copies, so day 39's nightly is a daily one beside day 39's pre-migration copy.
    const expected = [
        39 * 24 + 15, // pre-migration
        ...[39, 38, 37, 36, 35, 34, 33].map(d => d * 24 + 3), // seven daily (days 39 and 34: also their weeks' newest)
        27 * 24 + 3, // week of days 21-27
        20 * 24 + 15, 20 * 24 + 3, // pre-migration; and the week of days 14-20's newest nightly
        10 * 24 + 15 // pre-migration
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

test('a backup due during a play or recording waits, runs when it ends, and runs anyway 6 h after it fell due; Status says so', async () => {
    const { dbPath } = fixture();
    const t0 = Date.UTC(2026, 10, 5, 3);
    let playing = true;
    const active = () => playing;
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: t0, active }), 'no backup at all: overdue, it runs even during a play');
    const due = t0 + DAY;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due + 60000, active }), null, 'due, but something plays: waits');
    assert.equal(dbBackup.status().deferredSince, due, 'Status: waiting since it fell due');
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due + HOUR, active }), null);
    playing = false;
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: due + 2 * HOUR, active }), 'idle again: copies');
    let s = dbBackup.status();
    assert.equal(s.deferredSince, null);
    assert.deepEqual({ late: s.lastRun.late, waitedMin: s.lastRun.waitedMin, forced: s.lastRun.forced }, { late: true, waitedMin: 120, forced: false });

    playing = true;
    const due2 = due + 2 * HOUR + DAY;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due2 + 60000, active }), null);
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due2 + 5 * HOUR, active }), null);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: due2 + 6 * HOUR, active }), 'at the cap: runs while it plays');
    s = dbBackup.status();
    assert.equal(s.lastRun.forced, true);
    assert.equal(s.lastRun.waitedMin, 360);
    assert.equal(dbBackup.list(dbPath).length, 3);
    const due3 = due2 + 6 * HOUR + DAY;
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: due3 + 60000, active: () => { throw new Error('x'); } }), 'a failing active() never stops backups');
});

test('review of 0898: the 6 h deadline survives a restart, and a failed forced run keeps it and retries after 5, then 10 min', async () => {
    const { dir, dbPath } = fixture();
    const t0 = Date.UTC(2026, 10, 9, 3);
    await dbBackup.backup(dbPath, { reason: 'nightly', now: t0 });
    const due = t0 + DAY;
    const active = () => true;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due + 3 * HOUR, active }), null);
    dbBackup._resetState(); // a restart: nothing in memory
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: due + 5 * HOUR, active }), null, 'still inside the 6 h');
    // The database cannot be read: the forced run fails.
    fs.renameSync(dbPath, path.join(dir, 'away.db'));
    const t = due + 6 * HOUR;
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t, active }), null);
    assert.equal(dbBackup.status().lastRun.ok, false);
    assert.equal(dbBackup.status().lastRun.forced, true);
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t + 60000, active }), null);
    assert.equal(dbBackup.status().lastRun.at, t, 'inside the back-off: not tried again');
    await dbBackup.nightlyCheck(dbPath, { now: t + 5 * 60000, active });
    assert.equal(dbBackup.status().lastRun.at, t + 5 * 60000, 'tried again after 5 min, the deadline still expired');
    assert.equal(dbBackup.status().lastRun.ok, false);
    await dbBackup.nightlyCheck(dbPath, { now: t + 14 * 60000, active });
    assert.equal(dbBackup.status().lastRun.at, t + 5 * 60000, 'then 10 min');
    fs.renameSync(path.join(dir, 'away.db'), dbPath);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: t + 15 * 60000, active }));
    assert.equal(dbBackup.status().lastRun.ok, true);
    assert.equal(dbBackup.status().retryAt, null);
});

test('review of 0898: the newest 3 pre-migration snapshots outlast a same-day manual copy and 40 days of nightlies, in both folders', async () => {
    const { dbPath } = fixture();
    const second = tmp('pigtv-copy-');
    process.env.PIGTV_BACKUP_COPY_DIR = second;
    const day0 = Date.UTC(2026, 10, 2);
    const pre = [];
    for (const d of [0, 1, 2, 3]) {
        dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + d * DAY + 15 * HOUR });
        const [gz] = await dbBackup.compressPending(dbPath);
        await dbBackup.whenCopied();
        pre.push(path.basename(gz));
    }
    await dbBackup.backup(dbPath, { reason: 'manual', now: day0 + 3 * DAY + 16 * HOUR });
    await dbBackup.whenCopied();
    for (let d = 4; d < 44; d++) { await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 + d * DAY + 3 * HOUR }); await dbBackup.whenCopied(); }
    const premig = (names) => names.filter(n => /-pre-migration\.db\.gz$/.test(n)).sort();
    assert.deepEqual(premig(dbBackup.list(dbPath).map(b => b.file)), pre.slice(1).sort(), 'appdata: the newest 3');
    assert.deepEqual(premig(fs.readdirSync(second)), pre.slice(1).sort(), 'second folder: the newest 3');
});

test('review of 0898: a symbolic link in the backups folder is ignored by the listing, compression, retention, copy and download', async () => {
    const { dir, dbPath } = fixture();
    const second = tmp('pigtv-copy-');
    process.env.PIGTV_BACKUP_COPY_DIR = second;
    const real = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 1) });
    await dbBackup.whenCopied();
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'not a backup, and not to be touched');
    const old = path.join(path.dirname(real), 'content-2020-01-01T00-00-00Z-pre-migration.db');
    const newer = path.join(path.dirname(real), 'content-2099-01-01T00-00-00Z-nightly.db');
    fs.symlinkSync(outside, old);
    fs.symlinkSync(outside, newer);
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), [path.basename(real)], 'listed: only the regular file');
    assert.deepEqual(await dbBackup.compressPending(dbPath), [], 'nothing compressed through a link');
    const opened = dbBackup.openNewest(dbPath);
    assert.equal(opened.file, path.basename(real), 'the download takes the regular file');
    fs.closeSync(opened.fd);
    for (let d = 2; d < 12; d++) { await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, d) }); await dbBackup.whenCopied(); }
    assert.ok(fs.lstatSync(old).isSymbolicLink() && fs.lstatSync(newer).isSymbolicLink(), 'retention left the links alone');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'not a backup, and not to be touched');
    assert.ok(!fs.readdirSync(second).some(n => n.includes('2099') || n.includes('2020')), 'never copied');
});

test('review of 0898: a second folder that hangs does not block the event loop; the copy is stopped and Status answers from memory', async () => {
    const { dbPath } = fixture();
    const second = tmp('pigtv-hang-');
    process.env.PIGTV_BACKUP_COPY_DIR = second;
    process.env.PIGTV_TEST_SHARE_HANG = second; // the helper process blocks on any call there (shareFsWorker.js)
    const saved = { ...dbBackup.copyTuning };
    Object.assign(dbBackup.copyTuning, { callMs: 1500, stallMs: 1500, hardMs: 3000 });
    try {
        let worst = 0, last = Date.now();
        const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 20);
        const file = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 7) });
        assert.ok(fs.existsSync(file), 'the primary backup is whole');
        const t = Date.now();
        const st = dbBackup.status();
        assert.ok(Date.now() - t < 50, 'Status answers at once');
        assert.equal(st.copy.running, true);
        await dbBackup.whenCopied();
        clearInterval(tick);
        assert.ok(worst < 500, `the event loop was never held (worst gap ${worst} ms)`);
        const s = dbBackup.status().copy;
        assert.equal(s.ok, false);
        assert.match(s.problem, /not answering/);
        assert.equal(s.running, false);
        // The killed helper goes away (SIGKILL ends even a wait on the mount in this test).
        const until = Date.now() + 5000;
        while (require('../server/services/shareFs')._ownHelpers.size && Date.now() < until) await new Promise(r => setTimeout(r, 50));
        assert.equal(require('../server/services/shareFs')._ownHelpers.size, 0, 'the helper was killed');
    } finally {
        delete process.env.PIGTV_TEST_SHARE_HANG;
        Object.assign(dbBackup.copyTuning, saved);
    }
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
    assert.equal(dbBackup.status().copy.running, undefined);
});
