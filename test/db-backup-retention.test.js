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
// gzipped (old .db files still read), and deferred while something plays or records (at most 6 h). On 0895 none of
// these exist.

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

test('0901: a completed snapshot is never rewritten or removed except by retention (a pre-migration copy stays plain)', async () => {
    const { dbPath } = fixture(20);
    assert.equal(dbBackup.compressPending, undefined, 'no background conversion');
    const t0 = Date.UTC(2026, 10, 1, 15);
    const plain = dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: t0 });
    const before = { ino: fs.statSync(plain).ino, mtimeMs: fs.statSync(plain).mtimeMs, sha: sha(plain) };
    for (let i = 1; i <= 6; i++) assert.equal(await dbBackup.nightlyCheck(dbPath, { now: t0 + i * HOUR }), null, 'not due');
    await dbBackup.backup(dbPath, { reason: 'nightly', now: t0 + DAY + HOUR });
    await dbBackup.nightlyCheck(dbPath, { now: t0 + DAY + 2 * HOUR });
    assert.ok(fs.existsSync(plain), 'still there');
    const after = fs.statSync(plain);
    assert.deepEqual({ ino: after.ino, mtimeMs: after.mtimeMs, sha: sha(plain) }, before, 'the same file, untouched');
    assert.ok(!fs.existsSync(`${plain}.gz`), 'and never gzipped later');
});

test('0901: a plain file and a gzip of the same snapshot count as one, so leftovers cannot crowd out a real rollback point', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2);
    const real = dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + 15 * HOUR });
    // Two later pre-migration copies, each left as a plain file AND its gzip (0897-0900's later compression, interrupted).
    const pairs = [];
    for (const d of [1, 2]) {
        const p = dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + d * DAY + 15 * HOUR });
        fs.writeFileSync(`${p}.gz`, require('node:zlib').gzipSync(fs.readFileSync(p)));
        pairs.push(p);
    }
    const listed = dbBackup.list(dbPath);
    assert.deepEqual(listed.map(b => b.file), pairs.slice().reverse().map(p => path.basename(p)).concat(path.basename(real)), 'one entry per snapshot, the plain file read');
    await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 + 3 * DAY + 3 * HOUR });
    assert.ok(fs.existsSync(real), 'the older real pre-migration copy is still one of the newest 3');
    for (const p of pairs) assert.ok(fs.existsSync(p) && fs.existsSync(`${p}.gz`), 'a kept snapshot keeps both its files');
    // A fourth pre-migration copy pushes the oldest pair-free one out, and an older pair goes as a whole.
    dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + 4 * DAY + 15 * HOUR });
    dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + 5 * DAY + 15 * HOUR });
    assert.ok(!fs.existsSync(real));
    assert.ok(!fs.existsSync(pairs[0]) && !fs.existsSync(`${pairs[0]}.gz`), 'a removed snapshot goes with both its files');
    const opened = dbBackup.openNewest(dbPath);
    assert.equal(opened.compressed, false);
    fs.closeSync(opened.fd);
});

test('0901: a new backup\'s file is synced, published, and its folder synced before anything is pruned', async () => {
    const { dbPath } = fixture();
    const calls = [];
    const saved = { ...dbBackup.steps };
    for (const k of ['syncFile', 'publish', 'syncDir', 'prune']) {
        dbBackup.steps[k] = (...a) => { calls.push(k === 'syncFile' ? `syncFile:${path.basename(a[0]).includes('.gz.') ? 'gz' : 'db'}` : k); return saved[k](...a); };
    }
    try {
        const gz = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 3) });
        assert.match(gz, /\.db\.gz$/);
        assert.deepEqual(calls, ['syncFile:gz', 'publish', 'syncDir', 'prune']);
        calls.length = 0;
        dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: Date.UTC(2026, 10, 4) });
        assert.deepEqual(calls, ['syncFile:db', 'publish', 'syncDir', 'prune']);
    } finally {
        Object.assign(dbBackup.steps, saved);
    }
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

test('review of 0898: the newest 3 pre-migration snapshots outlast a same-day manual copy and 40 days of nightlies', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2);
    const pre = [];
    for (const d of [0, 1, 2, 3]) {
        pre.push(path.basename(dbBackup.backupSync(dbPath, { reason: 'pre-migration', now: day0 + d * DAY + 15 * HOUR })));
    }
    await dbBackup.backup(dbPath, { reason: 'manual', now: day0 + 3 * DAY + 16 * HOUR });
    for (let d = 4; d < 44; d++) { await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 + d * DAY + 3 * HOUR });}
    const premig = (names) => names.filter(n => /-pre-migration\.db$/.test(n)).sort();
    assert.deepEqual(premig(dbBackup.list(dbPath).map(b => b.file)), pre.slice(1).sort(), 'appdata: the newest 3');
});

test('review of 0898: a symbolic link in the backups folder is ignored by the listing, retention and download', async () => {
    const { dir, dbPath } = fixture();
    const real = await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, 1) });
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'not a backup, and not to be touched');
    const old = path.join(path.dirname(real), 'content-2020-01-01T00-00-00Z-pre-migration.db');
    const newer = path.join(path.dirname(real), 'content-2099-01-01T00-00-00Z-nightly.db');
    fs.symlinkSync(outside, old);
    fs.symlinkSync(outside, newer);
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), [path.basename(real)], 'listed: only the regular file');
    const opened = dbBackup.openNewest(dbPath);
    assert.equal(opened.file, path.basename(real), 'the download takes the regular file');
    fs.closeSync(opened.fd);
    for (let d = 2; d < 12; d++) { await dbBackup.backup(dbPath, { reason: 'nightly', now: Date.UTC(2026, 10, d) });}
    assert.ok(fs.lstatSync(old).isSymbolicLink() && fs.lstatSync(newer).isSymbolicLink(), 'retention left the links alone');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'not a backup, and not to be touched');
});

// 0902: a failed fsync (file or folder) must not let retention run: the new copy may not be on disk.
function injectFsync(kind, code) {
    const real = fs.fsyncSync;
    fs.fsyncSync = (fd) => {
        const isDir = fs.fstatSync(fd).isDirectory();
        if ((kind === 'dir') === isDir) throw Object.assign(new Error(`${code}: injected`), { code });
        return real(fd);
    };
    return () => { fs.fsyncSync = real; };
}
async function eightOldNightlies(dbPath, day0) {
    for (let d = 0; d < 8; d++) await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 + d * DAY });
    return dbBackup.list(dbPath).map(b => b.file);
}

const quietErrors = async (fn) => {
    const lines = [];
    const real = { error: console.error, warn: console.warn };
    console.error = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try { return { result: await fn(), lines }; } finally { Object.assign(console, real); }
};
const traces = (dir) => fs.readdirSync(dir).filter(n => /partial|unconfirmed/.test(n));

test('0903: EIO on the file sync of a same-day manual backup leaves no trace; the confirmed copy stays and the next day runs', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2, 3); // a Monday
    const confirmed = await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 });
    const dir = path.dirname(confirmed);
    const restore = injectFsync('file', 'EIO');
    try {
        const { lines } = await quietErrors(() => assert.rejects(dbBackup.backup(dbPath, { reason: 'manual', now: day0 + 2 * HOUR }), { code: 'BACKUP_UNCONFIRMED' }));
        assert.ok(lines.every(l => !l.includes(dir)), 'no path logged');
    } finally { restore(); }
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), [path.basename(confirmed)], 'only the confirmed copy');
    assert.deepEqual(traces(dir), [], 'no trace of the failed one');
    assert.equal(dbBackup.status().lastFailure.code, 'EIO');
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: day0 + 20 * HOUR }), null, 'not due: the schedule counts from the confirmed copy');
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: day0 + DAY + 60000 }), 'due a day after the confirmed copy, not delayed by the failure');
    assert.ok(fs.existsSync(confirmed));
});

test('0903: EIO on the folder sync removes the published file again and prunes nothing', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2, 3);
    const before = await eightOldNightlies(dbPath, day0);
    const dir = path.dirname(dbBackup.list(dbPath)[0].path);
    const restore = injectFsync('dir', 'EIO');
    try {
        await quietErrors(() => assert.rejects(dbBackup.backup(dbPath, { reason: 'manual', now: day0 + 9 * DAY }), { code: 'BACKUP_UNCONFIRMED' }));
        const { result } = await quietErrors(() => dbBackup.nightlyCheck(dbPath, { now: day0 + 10 * DAY }));
        assert.equal(result, null, 'not reported as a success');
    } finally { restore(); }
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), before, 'exactly the older snapshots, none pruned, none added');
    assert.deepEqual(traces(dir), []);
    const st = dbBackup.status();
    assert.equal(st.lastRun.ok, false);
    assert.equal(st.lastRun.error, 'EIO');
    assert.ok(st.retryAt, 'the back-off applies');
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: day0 + 10 * DAY + 5 * 60000 }), 'retried once the disk answers');
});

test('0903: a failed pre-migration copy leaves nothing, the start carries on (as before this batch), and the nightly is not delayed', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2, 3);
    const confirmed = await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 });
    const restore = injectFsync('file', 'EIO');
    let r;
    try { ({ result: r } = await quietErrors(() => dbBackup.beforeMigrations(dbPath, '9999', { now: day0 + HOUR }))); } finally { restore(); }
    assert.equal(r.taken, false);
    assert.equal(r.why, 'failed', 'reported, not thrown: getDb() goes on to migrate');
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), [path.basename(confirmed)]);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: day0 + DAY + 60000 }));
});

test('0903: after a restart the schedule counts from the newest confirmed copy; a leftover .unconfirmed file is ignored and later removed', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2, 3);
    const confirmed = await dbBackup.backup(dbPath, { reason: 'nightly', now: day0 });
    const dir = path.dirname(confirmed);
    // What a failed removal leaves: a newer copy renamed .unconfirmed, 8 days old on disk.
    const left = path.join(dir, 'content-2026-11-02T20-00-00Z-manual.db.gz.unconfirmed');
    fs.copyFileSync(confirmed, left);
    const old = (Date.now() - 8 * DAY) / 1000;
    fs.utimesSync(left, old, old);
    dbBackup._resetState(); // a restart
    assert.deepEqual(dbBackup.list(dbPath).map(b => b.file), [path.basename(confirmed)], 'not listed');
    const opened = dbBackup.openNewest(dbPath);
    assert.equal(opened.file, path.basename(confirmed), 'not downloaded');
    fs.closeSync(opened.fd);
    assert.equal(await dbBackup.nightlyCheck(dbPath, { now: day0 + DAY - 60000 }), null);
    assert.ok(await dbBackup.nightlyCheck(dbPath, { now: day0 + DAY + 60000 }), 'due from the confirmed copy');
    assert.ok(!fs.existsSync(left), 'a later successful run removed the 7-day-old leftover');
});

test('0902: a folder sync the platform does not support (allow-listed) lets the backup and pruning go ahead', async () => {
    const { dbPath } = fixture();
    const day0 = Date.UTC(2026, 10, 2, 3); // a Monday
    await eightOldNightlies(dbPath, day0);
    const restore = injectFsync('dir', process.platform === 'win32' ? 'EPERM' : 'EINVAL');
    try {
        assert.ok(await dbBackup.nightlyCheck(dbPath, { now: day0 + 9 * DAY }));
    } finally { restore(); }
    assert.equal(dbBackup.status().lastRun.ok, true);
    assert.equal(dbBackup.list(dbPath).length, 7, 'pruned as usual');
});
