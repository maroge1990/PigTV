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
 * Every copy is written to `<name>.partial`, checked (`PRAGMA quick_check` on the copy: a backup
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
const Database = require('better-sqlite3');

const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const NAME = /^content-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-([a-z]+(?:-[a-z]+)*)(?:-\d+)?)?\.db$/;

const backupsDir = (dbPath) => path.join(path.dirname(dbPath), 'backups');
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

function prepare(dbPath, reason, now) {
    const dir = backupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, `content-${stamp(now)}-${reason}.db`);
    // Two in the same second (a manual run beside a nightly one): the second gets -2, -3...
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `content-${stamp(now)}-${reason}-${n}.db`);
    const partial = `${dest}.partial`;
    try { fs.unlinkSync(partial); } catch { /* none */ }
    return { dir, dest, partial };
}

/** The copy opens and passes quick_check, else throws (and the partial is removed). */
function verifyAndCommit({ dest, partial }) {
    try {
        const copy = new Database(partial, { readonly: true, fileMustExist: true });
        try {
            const result = copy.pragma('quick_check', { simple: true });
            if (result !== 'ok') throw new Error(`the copy failed its integrity check (${result})`);
        } finally { copy.close(); }
        fs.renameSync(partial, dest);
    } catch (err) {
        try { fs.unlinkSync(partial); } catch { /* already gone */ }
        throw err;
    }
}

function prune(dir, keep = KEEP) {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    for (const n of names.filter(f => f.endsWith('.db.partial'))) {
        try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch { /* in use or gone */ }
    }
    for (const n of names.filter(f => NAME.test(f)).sort().slice(0, -keep)) {
        try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch { /* gone */ }
    }
    return removed;
}

/** Synchronous copy (VACUUM INTO on a read-only connection). Returns the backup's path. */
function backupSync(dbPath, { reason = 'manual', now = Date.now(), keep = KEEP } = {}) {
    const target = prepare(dbPath, reason, now);
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { src.prepare('VACUUM INTO ?').run(target.partial); } finally { src.close(); }
    verifyAndCommit(target);
    prune(target.dir, keep);
    return target.dest;
}

/** Asynchronous online backup (safe while the server writes). Resolves the backup's path. */
async function backup(dbPath, { reason = 'manual', now = Date.now(), keep = KEEP } = {}) {
    const target = prepare(dbPath, reason, now);
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await src.backup(target.partial); } finally { src.close(); }
    verifyAndCommit(target);
    prune(target.dir, keep);
    return target.dest;
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
