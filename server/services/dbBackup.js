/**
 * Database backups (R12, Plan B1): the same copies scripts/backup-db.js has made by hand since
 * 0199, now also taken by the server itself.
 *
 *   - before migrations, when the build changed since the database was last opened (and on the
 *     first start with this code): getDb() calls beforeMigrations() before initSchema(), so a
 *     deploy whose migration goes wrong still has the database exactly as the old build left it.
 *     Synchronous (`VACUUM INTO` on a read-only connection), because nothing may touch the file
 *     before it.
 *   - nightly: startNightly() checks every hour and takes one when the newest backup of any kind
 *     is more than a day old. Asynchronous (better-sqlite3's online backup), safe while serving.
 *
 * Every copy is written to a partial of its own (`<name>.db.<pid>-<random>.partial`, S3), checked (`PRAGMA quick_check` on the copy: a backup
 * that can't be opened is not a backup) and only then renamed into place, so a crash or a full
 * disk never leaves a file that looks complete. The newest KEEP complete copies are kept; stale
 * `.partial` files are removed. Names sort by time: content-<UTC stamp>-<reason>.db.
 *
 * This copies content.db only. It is not a whole-installation backup (data/auth-secret and the
 * container's settings are separate, docs/OPERATIONS.md), and a copy on the same disk does not
 * survive that disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const NAME = /^content-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-([a-z]+(?:-[a-z]+)*)(?:-\d+)?)?\.db$/;

const backupsDir = (dbPath) => path.join(path.dirname(dbPath), 'backups');
// S3 (0241): a partial older than this belongs to nobody (a backup that crashed or was killed);
// a younger one may be another process's copy in progress (scripts/backup-db.js beside the server).
const STALE_PARTIAL_MS = 6 * 60 * 60 * 1000;
const ours = new Set(); // partials this process is writing now
const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

/** Complete backups, newest first: [{ file, path, reason, at, bytes }]. */
function list(dbPath) {
    const dir = backupsDir(dbPath);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(n => NAME.test(n)).sort().reverse().map(file => {
        const [, when, reason] = file.match(NAME);
        const at = Date.parse(when.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'));
        let bytes = null;
        try { bytes = fs.statSync(path.join(dir, file)).size; } catch { /* removed meanwhile */ }
        return { file, path: path.join(dir, file), reason: reason || 'manual', at, bytes };
    });
}

/**
 * S3 (0241): every copy writes to a partial of its own, created exclusively ('wx') under a unique
 * name, so two copies at once - in this process or another - never share or delete each other's
 * file. Its final name is chosen when it is published (publish()), not here.
 */
function prepare(dbPath, reason, now) {
    const dir = backupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const base = `content-${stamp(now)}-${reason}`;
    const partial = path.join(dir, `${base}.db.${process.pid}-${crypto.randomBytes(4).toString('hex')}.partial`);
    fs.closeSync(fs.openSync(partial, 'wx')); // empty: VACUUM INTO and backup() both accept it
    ours.add(partial);
    return { dir, base, partial };
}

/** Publish the partial under the first free name (link() never replaces a file). Returns the path. */
function publish({ dir, base, partial }) {
    for (let n = 1; ; n++) {
        // Two in the same second (a manual run beside a nightly one): the second gets -2, -3...
        const dest = path.join(dir, n === 1 ? `${base}.db` : `${base}-${n}.db`);
        try { fs.linkSync(partial, dest); } catch (err) { if (err.code === 'EEXIST') continue; throw err; }
        try { fs.unlinkSync(partial); } catch { /* removed already */ }
        return dest;
    }
}

/** The copy opens and passes quick_check, then is published; else throws (and the partial is removed). */
function verifyAndCommit(target) {
    const { partial } = target;
    try {
        const copy = new Database(partial, { readonly: true, fileMustExist: true });
        try {
            const result = copy.pragma('quick_check', { simple: true });
            if (result !== 'ok') throw new Error(`the copy failed its integrity check (${result})`);
        } finally { copy.close(); }
        return publish(target);
    } catch (err) {
        try { fs.unlinkSync(partial); } catch { /* already gone */ }
        throw err;
    } finally {
        ours.delete(partial);
    }
}

function prune(dir, keep = KEEP, now = Date.now()) {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    // S3: only partials nobody is writing: never this process's own, never a recent one (another
    // process's copy in progress), only those left behind long enough ago.
    for (const n of names.filter(f => f.endsWith('.partial'))) {
        const file = path.join(dir, n);
        if (ours.has(file)) continue;
        try {
            if (now - fs.statSync(file).mtimeMs < STALE_PARTIAL_MS) continue;
            fs.unlinkSync(file); removed.push(n);
        } catch { /* in use or gone */ }
    }
    for (const n of names.filter(f => NAME.test(f)).sort().slice(0, -keep)) {
        try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch { /* gone */ }
    }
    return removed;
}

/** Synchronous copy (VACUUM INTO on a read-only connection). Returns the backup's path. */
function backupSync(dbPath, { reason = 'manual', now = Date.now(), keep = KEEP } = {}) {
    const target = prepare(dbPath, reason, now);
    try {
        const src = new Database(dbPath, { readonly: true, fileMustExist: true });
        try { src.prepare('VACUUM INTO ?').run(target.partial); } finally { src.close(); }
    } catch (err) {
        ours.delete(target.partial);
        try { fs.unlinkSync(target.partial); } catch { /* none */ }
        throw err;
    }
    const dest = verifyAndCommit(target);
    prune(target.dir, keep);
    return dest;
}

/** Asynchronous online backup (safe while the server writes). Resolves the backup's path. */
async function backup(dbPath, { reason = 'manual', now = Date.now(), keep = KEEP } = {}) {
    const target = prepare(dbPath, reason, now);
    try {
        const src = new Database(dbPath, { readonly: true, fileMustExist: true });
        try { await src.backup(target.partial); } finally { src.close(); }
    } catch (err) {
        ours.delete(target.partial);
        try { fs.unlinkSync(target.partial); } catch { /* none */ }
        throw err;
    }
    const dest = verifyAndCommit(target);
    prune(target.dir, keep);
    return dest;
}

/**
 * Before getDb() runs the schema: back up when the database exists and was last opened by a
 * different build (or by one from before this check). Never throws: a failed backup is logged
 * loudly and the start continues, as it did before R12.
 */
function beforeMigrations(dbPath, build, { now = Date.now() } = {}) {
    if (!fs.existsSync(dbPath)) return { taken: false, why: 'new database' };
    let last = null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
            if (hasMeta) last = db.prepare(`SELECT value FROM meta WHERE key = 'schema_build'`).get()?.value ?? null;
        } finally { db.close(); }
    } catch (err) {
        console.error('[Backup] Could not read the database before migrations:', err.message);
        return { taken: false, why: 'unreadable' };
    }
    if (last === build) return { taken: false, why: 'same build' };
    try {
        const file = backupSync(dbPath, { reason: 'pre-migration', now });
        console.log(`[Backup] Build ${last || 'unknown'} -> ${build}: copied the database before migrations to ${path.basename(file)}`);
        return { taken: true, file, from: last };
    } catch (err) {
        console.error(`[Backup] FAILED before migrations (build ${last || 'unknown'} -> ${build}): ${err.message}. Starting anyway.`);
        return { taken: false, why: 'failed', error: err.message };
    }
}

/** After the schema: remember which build it belongs to. */
function recordBuild(db, build) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_build', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(build);
}

let nightlyTimer = null;
let nightlyRunning = null;

/** One nightly check: a backup when the newest is over a day old. Resolves the path or null. */
async function nightlyCheck(dbPath, { now = Date.now() } = {}) {
    if (nightlyRunning) return nightlyRunning;
    const newest = list(dbPath)[0];
    if (newest && now - newest.at < DAY_MS) return null;
    nightlyRunning = backup(dbPath, { reason: 'nightly', now })
        .then(file => { console.log(`[Backup] Nightly copy written: ${path.basename(file)}`); return file; })
        .catch(err => { console.error('[Backup] Nightly copy FAILED:', err.message); return null; })
        .finally(() => { nightlyRunning = null; });
    return nightlyRunning;
}

function startNightly(dbPath) {
    if (nightlyTimer || process.env.PIGTV_DB_BACKUPS === '0') return;
    nightlyTimer = setInterval(() => nightlyCheck(dbPath), CHECK_EVERY_MS);
    nightlyTimer.unref?.();
    // The first check a few minutes after start, not during it.
    setTimeout(() => nightlyCheck(dbPath), 5 * 60 * 1000).unref?.();
}

function stopNightly() {
    if (nightlyTimer) clearInterval(nightlyTimer);
    nightlyTimer = null;
}

module.exports = { KEEP, list, backup, backupSync, beforeMigrations, recordBuild, nightlyCheck, startNightly, stopNightly, prune };
