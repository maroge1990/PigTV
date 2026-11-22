/**
 * Database backups (R12, Plan B1): the same copies scripts/backup-db.js has made by hand since
 * 0199, now also taken by the server itself.
 *
 *   - before migrations, when the build changed since the database was last opened (and on the
 *     first start with this code): getDb() calls beforeMigrations() before initSchema(), so a
 *     deploy whose migration goes wrong still has the database exactly as the old build left it.
 *     Synchronous (`VACUUM INTO` on a read-only connection), because nothing may touch the file
 *     before it.
 *   - nightly: startNightly() checks every 5 minutes and takes one when the newest backup of any kind
 *     is more than a day old (#43: not while a play or recording is active, for at most 6 h). Asynchronous: the same `VACUUM INTO`, run in a worker thread so the
 *     event loop that serves streams never waits for it. Until 0489 this was better-sqlite3's
 *     online backup, which copies every page, free ones included: production's nightly copies were
 *     441 MB beside 210 MB pre-migration ones of the same database.
 *
 * Every copy is written to a partial of its own (`<name>.db.<pid>-<random>.partial`, S3), checked (`PRAGMA quick_check` on the copy: a backup
 * that can't be opened is not a backup) and only then renamed into place, so a crash or a full
 * disk never leaves a file that looks complete. Stale `.partial` files are removed. Names sort by time:
 * content-<UTC stamp>-<reason>.db[.gz].
 *
 * #43 (0897):
 *   - retention (retain()): after a new copy is published, the newest copy of each of the 7 most recent UTC days that
 *     have one, plus the newest of each of the 4 most recent ISO weeks; the newest copy is never removed.
 *   - size: the online copy is gzipped (`.db.gz`, checked by reading it back against the copy's SHA-256 first); the
 *     synchronous pre-migration copy stays a plain `.db` (it delays the start) and compressPending() gzips it later,
 *     off the start path. list(), newest() and extract() read both kinds.
 *   - a second copy: PIGTV_BACKUP_COPY_DIR (unset = off) names a folder each finished `.db.gz` is copied to (a partial,
 *     size and byte-for-byte checked, then renamed), with the same retention there, every call in a helper process with
 *     a deadline (it may be a hung share). A missing, relative or unwritable folder is reported by status() and never
 *     fails or delays the primary copy. Only names matching NAME are ever pruned there.
 *   - review of 0898: pre-migration snapshots have their own retention (the newest 3), outside the daily/weekly one;
 *     only regular files count (a symbolic link is never listed, compressed, pruned, copied or sent).
 *   - every file is created owner-only (0600): a backup holds provider logins. Nothing about its contents is logged.
 *
 * This copies content.db only. It is not a whole-installation backup (data/auth-secret and the
 * container's settings are separate, docs/OPERATIONS.md), and a copy on the same disk does not
 * survive that disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');

const RETENTION = Object.freeze({ daily: 7, weekly: 4, preMigration: 3 });
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
// #43: a copy that is due while something plays or records waits at most this long, then runs anyway.
const DEFER_CAP_MS = 6 * 60 * 60 * 1000;
const NAME = /^content-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-([a-z]+(?:-[a-z]+)*)(?:-(\d+))?)?\.db(\.gz)?$/;
const OWNER_ONLY = 0o600;

const backupsDir = (dbPath) => path.join(path.dirname(dbPath), 'backups');
// S3 (0241): a partial older than this belongs to nobody (a backup that crashed or was killed);
// a younger one may be another process's copy in progress (scripts/backup-db.js beside the server).
const STALE_PARTIAL_MS = 6 * 60 * 60 * 1000;
const ours = new Set(); // partials this process is writing now
const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const random = () => `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** Backups named in `names` (any folder; nothing is read), newest first: [{ file, reason, at, compressed }]. */
function fromNames(names) {
    return names.filter(n => NAME.test(n)).map(file => {
        const [, when, reason, n, gz] = file.match(NAME);
        const at = Date.parse(when.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'));
        return { file, reason: reason || 'manual', at, compressed: !!gz, seq: Number(n || 1) };
    }).sort((a, b) => (b.at - a.at) || (b.seq - a.seq) || (a.file < b.file ? 1 : -1))
        .map(({ seq, ...entry }) => entry);
}

/**
 * Complete backups in `dir` (local), newest first: [{ file, path, reason, at, bytes, compressed }]. Review of 0898: only
 * regular files (lstat: a symbolic link, wherever it points, is never listed, so never compressed, pruned, copied or sent).
 */
function listDir(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const entry of fromNames(names)) {
        const file = path.join(dir, entry.file);
        try {
            const st = fs.lstatSync(file);
            if (!st.isFile()) continue;
            out.push({ ...entry, path: file, bytes: st.size });
        } catch { /* removed meanwhile */ }
    }
    return out;
}

/** Open a listed backup without following links; its descriptor only if it is a regular file there. Else null. */
function openRegular(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd);
        if (st.isFile()) return { fd, size: st.size };
    } catch { /* a link, or gone */ }
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    return null;
}

/** Complete backups of this database, newest first. */
const list = (dbPath) => listDir(backupsDir(dbPath));
/** The newest complete backup (plain or gzipped), or null. */
const newest = (dbPath) => list(dbPath)[0] || null;

/**
 * #45: the newest backup that is a regular file inside the backups folder itself (never a symbolic link or anything
 * resolving elsewhere), opened read-only without following links: { file, compressed, fd, size } or null. The
 * caller owns `fd`. For the admin download.
 */
function openNewest(dbPath) {
    for (const entry of list(dbPath)) {
        const opened = openRegular(entry.path);
        if (opened) return { file: entry.file, compressed: entry.compressed, ...opened };
    }
    return null;
}

const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
/** The Thursday of `at`'s ISO week names that week (and its ISO year). */
function weekKey(at) {
    const d = new Date(at);
    const dow = (d.getUTCDay() + 6) % 7; // Monday 0
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 3)).toISOString().slice(0, 10);
}

/**
 * #43: which of `entries` (newest first) to keep: the newest; the newest 3 pre-migration snapshots (review of 0898: their
 * own policy, so a same-day manual or nightly copy never displaces the copy taken before a migration); and among the
 * others, the newest per UTC day for 7 days and per ISO week for 4 weeks.
 */
function retain(entries, { daily = RETENTION.daily, weekly = RETENTION.weekly, preMigration = RETENTION.preMigration } = {}) {
    const keep = new Set();
    if (entries[0]) keep.add(entries[0].file);
    for (const e of entries.filter(x => x.reason === 'pre-migration').slice(0, preMigration)) keep.add(e.file);
    const others = entries.filter(x => x.reason !== 'pre-migration');
    const pick = (keyOf, limit) => {
        const seen = new Set();
        for (const e of others) {
            const k = keyOf(e.at);
            if (seen.has(k)) continue;
            if (seen.size >= limit) break;
            seen.add(k);
            keep.add(e.file);
        }
    };
    pick(dayKey, daily);
    pick(weekKey, weekly);
    return keep;
}

/**
 * S3 (0241): every copy writes to a partial of its own, created exclusively ('wx') under a unique
 * name, so two copies at once - in this process or another - never share or delete each other's
 * file. Its final name is chosen when it is published (publish()), not here.
 */
function prepare(dbPath, reason, now) {
    const dir = backupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = `content-${stamp(now)}-${reason}`;
    const partial = path.join(dir, `${base}.db.${random()}.partial`);
    fs.closeSync(fs.openSync(partial, 'wx', OWNER_ONLY)); // empty: VACUUM INTO and backup() both accept it
    ours.add(partial);
    return { dir, base, partial };
}

/** Publish `from` under the first free name (link() never replaces a file; a name is taken in either kind). Returns the path. */
function publish({ dir, base }, from, ext = '.db') {
    for (let n = 1; ; n++) {
        // Two in the same second (a manual run beside a nightly one): the second gets -2, -3...
        const name = n === 1 ? base : `${base}-${n}`;
        if (fs.existsSync(path.join(dir, `${name}${ext === '.db' ? '.db.gz' : '.db'}`))) continue;
        const dest = path.join(dir, `${name}${ext}`);
        try { fs.linkSync(from, dest); } catch (err) { if (err.code === 'EEXIST') continue; throw err; }
        try { fs.unlinkSync(from); } catch { /* removed already */ }
        try { fs.chmodSync(dest, OWNER_ONLY); } catch { /* a filesystem without modes */ }
        return dest;
    }
}

/** The copy opens and passes quick_check; else throws (and the partial is removed). */
function check(partial) {
    try {
        const copy = new Database(partial, { readonly: true, fileMustExist: true });
        try {
            const result = copy.pragma('quick_check', { simple: true });
            if (result !== 'ok') throw new Error(`the copy failed its integrity check (${result})`);
        } finally { copy.close(); }
    } catch (err) {
        try { fs.unlinkSync(partial); } catch { /* already gone */ }
        ours.delete(partial);
        throw err;
    }
}

/** The copy passes quick_check, then is published as a plain .db; else throws (and the partial is removed). */
function verifyAndCommit(target) {
    check(target.partial);
    try { return publish(target, target.partial); } finally { ours.delete(target.partial); }
}

const hasher = () => {
    const hash = crypto.createHash('sha256');
    const t = new Transform({ transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); } });
    t.digest = () => hash.digest('hex');
    return t;
};
async function sha256(file, { gunzip = false } = {}) {
    const h = hasher();
    const sink = new (require('stream').Writable)({ write(c, e, cb) { cb(); } });
    await pipeline(...[fs.createReadStream(file), gunzip ? zlib.createGunzip() : null, h, sink].filter(Boolean));
    return h.digest();
}

/**
 * #43: gzip `src` (a path, or { fd } from openRegular(), read from its start and left open) into `dest` (created
 * owner-only), then read it back: it must give `src`'s SHA-256, or this throws.
 */
async function gzipVerified(src, dest) {
    const h = hasher();
    const input = typeof src === 'object' ? fs.createReadStream(null, { fd: src.fd, start: 0, autoClose: false }) : fs.createReadStream(src);
    await pipeline(input, h, zlib.createGzip({ level: 6 }), fs.createWriteStream(dest, { flags: 'wx', mode: OWNER_ONLY }));
    const want = h.digest();
    if (await sha256(dest, { gunzip: true }) !== want) throw new Error('the compressed copy did not read back the same');
}

/** #43: what a restore does: the database a backup holds, plain or gzipped, written to `dest` (which must not exist). */
async function extract(file, dest) {
    const steps = [fs.createReadStream(file), String(file).endsWith('.gz') ? zlib.createGunzip() : null,
        fs.createWriteStream(dest, { flags: 'wx', mode: OWNER_ONLY })].filter(Boolean);
    await pipeline(...steps);
    return dest;
}

/** Remove stale partials (ours by name only) and, by retain(), complete copies. Returns the names removed. */
function prune(dir, { now = Date.now(), keepAlso = null } = {}) {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    // S3: only partials nobody is writing: never this process's own, never a recent one (another
    // process's copy in progress), only those left behind long enough ago.
    // 0489: and what SQLite left beside one (-shm, -wal, -journal from opening it to check it).
    // #43: only a backup's own partials (content-...), as the second folder may hold other files.
    for (const n of names.filter(f => /^content-.*\.partial(?:-shm|-wal|-journal)?$/.test(f))) {
        const file = path.join(dir, n);
        if (ours.has(file.replace(/-(?:shm|wal|journal)$/, ''))) continue;
        try {
            if (now - fs.statSync(file).mtimeMs < STALE_PARTIAL_MS) continue;
            fs.unlinkSync(file); removed.push(n);
        } catch { /* in use or gone */ }
    }
    const entries = listDir(dir);
    const keep = retain(entries);
    if (keepAlso) keep.add(path.basename(keepAlso));
    for (const e of entries) {
        if (keep.has(e.file)) continue;
        try { fs.unlinkSync(e.path); removed.push(e.file); } catch { /* gone */ }
    }
    return removed;
}

/** Synchronous copy (VACUUM INTO on a read-only connection), kept a plain .db: it runs before the server listens. */
function backupSync(dbPath, { reason = 'manual', now = Date.now() } = {}) {
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
    prune(target.dir, { keepAlso: dest });
    return dest;
}

// 0489: VACUUM INTO on a read-only connection of its own, in a worker thread (a read transaction
// under WAL, so the server keeps writing meanwhile).
const VACUUM_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const Database = require(workerData.driver);
const src = new Database(workerData.src, { readonly: true, fileMustExist: true });
try { src.prepare('VACUUM INTO ?').run(workerData.dest); } finally { src.close(); }
parentPort.postMessage('done');
`;

function vacuumIntoInWorker(src, dest) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { src, dest, driver: require.resolve('better-sqlite3') } });
        let done = false;
        worker.once('message', () => { done = true; });
        worker.once('error', reject);
        worker.once('exit', code => (done && code === 0) ? resolve() : reject(new Error(`the copy stopped (exit ${code})`)));
    });
}

/**
 * Asynchronous compact copy (safe while the server writes), gzipped (#43). Resolves the backup's path. Should the
 * compression fail, the checked plain copy is published instead: a bigger backup beats none. The second copy (if
 * configured) is started afterwards and not waited for: whenCopied().
 */
async function backup(dbPath, { reason = 'manual', now = Date.now() } = {}) {
    const target = prepare(dbPath, reason, now);
    try {
        await vacuumIntoInWorker(dbPath, target.partial);
    } catch (err) {
        ours.delete(target.partial);
        try { fs.unlinkSync(target.partial); } catch { /* none */ }
        throw err;
    }
    check(target.partial);
    let dest;
    const gz = path.join(target.dir, `${target.base}.db.gz.${random()}.partial`);
    ours.add(gz);
    try {
        await gzipVerified(target.partial, gz);
        dest = publish(target, gz, '.db.gz');
        try { fs.unlinkSync(target.partial); } catch { /* gone */ }
    } catch (err) {
        try { fs.unlinkSync(gz); } catch { /* none */ }
        console.warn('[Backup] Could not compress the copy; keeping it uncompressed:', err.code || err.message);
        dest = publish(target, target.partial);
    } finally {
        ours.delete(gz);
        ours.delete(target.partial);
    }
    prune(target.dir, { keepAlso: dest });
    if (dest.endsWith('.gz')) scheduleCopy(dest);
    return dest;
}

/** #43: gzip the plain .db copies (the pre-migration ones), each checked before its original goes. Resolves the new paths. */
const compressFailed = new Set(); // tried once and failed: left as they are until the next start (one log line each)
async function compressPending(dbPath) {
    const done = [];
    for (const entry of list(dbPath).filter(e => !e.compressed && !compressFailed.has(e.path))) {
        const dir = path.dirname(entry.path);
        const gz = path.join(dir, `${entry.file}.gz.${random()}.partial`);
        // Review of 0898: read from a descriptor opened without following links and checked to be a regular file.
        const opened = openRegular(entry.path);
        if (!opened) continue;
        ours.add(gz);
        try {
            await gzipVerified(opened, gz);
            const dest = path.join(dir, `${entry.file}.gz`);
            fs.linkSync(gz, dest);
            try { fs.chmodSync(dest, OWNER_ONLY); } catch { /* no modes */ }
            fs.unlinkSync(gz);
            fs.unlinkSync(entry.path);
            done.push(dest);
            scheduleCopy(dest);
        } catch (err) {
            try { fs.unlinkSync(gz); } catch { /* none */ }
            compressFailed.add(entry.path);
            if (fs.existsSync(entry.path)) console.warn('[Backup] Could not compress an older copy; it is kept as it is:', err.code || err.message);
        } finally {
            ours.delete(gz);
            try { fs.closeSync(opened.fd); } catch { /* closed */ }
        }
    }
    return done;
}

// ---- #43: the second copy (PIGTV_BACKUP_COPY_DIR) ----
//
// Review of 0898 (high): the folder may be a network share, and a call on a hung mount blocks in the kernel for minutes.
// So nothing in this process touches it: every call (the probe, the copy, the byte-for-byte check, the rename, the
// listing and the pruning) runs in a helper process through shareFs.js (#8, the recordings share's isolation): short
// calls on withOwnHelper (each with a deadline), the copy and the check on helpers of their own (shareFs.copyInto and
// sameBytes, killed when they stop making progress or at the hard deadline). One run at a time; a copy asked for while
// one runs is skipped and recorded. Status shows the cached result of the last run and never touches the folder.

const shareFs = require('./shareFs');
const copyTuning = { callMs: 15000, stallMs: 60000, hardMs: 30 * 60 * 1000 };
const copyState = { ok: null, problem: null, lastCopiedAt: null, lastAttemptAt: null, skippedAt: null };
let copyRunning = null;

/** From the environment only (no file call): { enabled: false } | { enabled: true, problem } | { enabled: true, dir }. */
function copyConfig() {
    const raw = process.env.PIGTV_BACKUP_COPY_DIR;
    if (!raw || !raw.trim()) return { enabled: false };
    if (!path.isAbsolute(raw)) return { enabled: true, problem: 'not an absolute path' };
    return { enabled: true, dir: path.resolve(raw) };
}

function copyFailed(problem) {
    if (copyState.problem !== problem) console.warn(`[Backup] The second copy was not made: the folder in PIGTV_BACKUP_COPY_DIR is ${problem}. The backup in appdata is fine.`);
    copyState.ok = false;
    copyState.problem = problem;
}

const problemOf = (err) => (err && (err.code === 'SHARE_UNRESPONSIVE' || err.name === 'AbortError')
    ? 'not answering (the copy was stopped)' : 'failing (the copy could not be written or checked)');

/** Copy one finished backup to the second folder, in helpers: probe, copy, compare, rename, then retention there. */
async function copyOut(file) {
    const target = copyConfig();
    if (!target.enabled) return null;
    copyState.lastAttemptAt = Date.now();
    if (target.problem) { copyFailed(target.problem); return null; }
    const name = path.basename(file);
    if (!NAME.test(name)) return null; // only ever a backup's own name: nothing from outside can steer the path
    if (path.resolve(path.dirname(file)) === target.dir) { copyFailed('the backups folder itself'); return null; }
    const dest = path.join(target.dir, name);
    const partial = path.join(target.dir, `${name}.${random()}.partial`);
    const controller = new AbortController();
    const hard = setTimeout(() => controller.abort(), copyTuning.hardMs);
    hard.unref?.();
    const own = (work) => shareFs.withOwnHelper(work, { timeoutMs: copyTuning.callMs, path: target.dir });
    try {
        const problem = await own(async (io) => {
            if (!(await io.exists(target.dir))) return 'missing';
            if (!(await io.writeProbe(target.dir))) return 'not writable';
            return null;
        });
        if (problem) { copyFailed(problem); return null; }
        const size = fs.statSync(file).size; // the local backup
        const opts = { signal: controller.signal, stallMs: copyTuning.stallMs };
        const copied = await shareFs.copyInto(partial, [file], { ...opts, mode: OWNER_ONLY });
        if (!copied || copied.size !== size) throw new Error('size differs');
        if (!(await shareFs.sameBytes(partial, [file], opts))) throw new Error('the copy is not the same');
        await own(async (io) => {
            await io.rename(partial, dest);
            const names = (await io.readdir(target.dir)) || [];
            // Our partials only (a killed run's); then retention over the backups' names (nothing else there is touched).
            for (const n of names.filter(f => /^content-.*\.partial$/.test(f))) await io.unlink(path.join(target.dir, n));
            const entries = fromNames(names);
            const keep = retain(entries);
            keep.add(name);
            for (const e of entries) if (!keep.has(e.file)) await io.unlink(path.join(target.dir, e.file));
        });
        copyState.ok = true;
        copyState.problem = null;
        copyState.lastCopiedAt = Date.now();
        return dest;
    } catch (err) {
        copyFailed(problemOf(err));
        return null;
    } finally {
        clearTimeout(hard);
    }
}

function scheduleCopy(file) {
    if (copyRunning) {
        if (copyConfig().enabled) {
            copyState.skippedAt = Date.now();
            console.warn(`[Backup] The second copy of ${path.basename(file)} was skipped: the previous one is still running.`);
        }
        return copyRunning;
    }
    copyRunning = copyOut(file).catch(() => null).finally(() => { copyRunning = null; });
    return copyRunning;
}
/** Resolves once the second copy running now (if any) has finished (or failed). */
const whenCopied = () => copyRunning || Promise.resolve(null);

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
let nightlySkipping = false;
let compressing = null;
// #43: the last nightly run, a copy waiting for plays (for Status) and the retry back-off after a failed one.
// Review of 0898: the deadline is not kept here: a copy falls due a day after the newest backup (any kind), and the 6 h
// cap counts from then, so it survives a restart with nothing stored. With no backup at all it is overdue: it runs.
const runState = { waitingFor: null, lastRun: null, failedAt: null, retryMs: 0 };
const RETRY_FIRST_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

/**
 * One nightly check: a backup when the newest is over a day old. Resolves the path or null.
 * #273 C-3: `busy()` (a guide sync is running) skips the copy, which holds a read transaction that keeps the WAL from
 * checkpointing; the next check retries. One log line per skipped streak. A `busy` that throws counts as idle.
 * #43: `active()` (a play or recording) defers it too, until DEFER_CAP_MS after it fell due; then it runs anyway (in
 * its worker thread, as always). A failed run is retried after 5 min, then 10, 20... up to 1 h, the deadline kept.
 * An `active` that throws counts as idle. With nothing due, an idle check gzips any plain pre-migration copy.
 */
async function nightlyCheck(dbPath, { now = Date.now(), busy, active } = {}) {
    if (nightlyRunning) return nightlyRunning;
    const idle = () => { try { return !(typeof active === 'function' && active()); } catch { return true; } };
    const newest = list(dbPath)[0];
    const dueAt = newest ? newest.at + DAY_MS : null;
    if (dueAt !== null && now < dueAt) {
        runState.waitingFor = null;
        if (!compressing && list(dbPath).some(e => !e.compressed && !compressFailed.has(e.path)) && idle()) {
            compressing = compressPending(dbPath).finally(() => { compressing = null; });
            await compressing;
        }
        return null;
    }
    if (runState.failedAt !== null && now - runState.failedAt < runState.retryMs) return null;
    let syncing = false;
    try { syncing = typeof busy === 'function' && !!busy(); } catch { syncing = false; }
    if (syncing) {
        if (!nightlySkipping) console.log('[Backup] Nightly copy waits: a sync is running. Retrying at the next check.');
        nightlySkipping = true;
        return null;
    }
    nightlySkipping = false;
    const overdueMs = dueAt === null ? 0 : now - dueAt;
    let forced = false;
    if (!idle()) {
        if (dueAt !== null && overdueMs < DEFER_CAP_MS) {
            if (runState.waitingFor !== dueAt) console.log('[Backup] Nightly copy waits: something is playing or recording. It runs when they end, or 6 h after it fell due at the latest.');
            runState.waitingFor = dueAt;
            return null;
        }
        forced = dueAt !== null;
    }
    const waited = runState.waitingFor !== null || forced;
    const waitedMin = waited ? Math.round(overdueMs / 60000) : 0;
    runState.waitingFor = null;
    const run = { at: now, late: waited, waitedMin, forced };
    nightlyRunning = backup(dbPath, { reason: 'nightly', now })
        .then(file => {
            runState.lastRun = { ...run, ok: true };
            runState.failedAt = null;
            runState.retryMs = 0;
            console.log(`[Backup] Nightly copy written: ${path.basename(file)}${forced ? ' (6 h after it fell due, while plays or recordings went on)' : waited ? ` (${waitedMin} min late: waited for plays and recordings to end)` : ''}`);
            return file;
        })
        .catch(err => {
            runState.lastRun = { ...run, ok: false };
            runState.failedAt = now;
            runState.retryMs = runState.retryMs ? Math.min(runState.retryMs * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
            console.error(`[Backup] Nightly copy FAILED (retrying in ${Math.round(runState.retryMs / 60000)} min):`, err.message);
            return null;
        })
        .finally(() => { nightlyRunning = null; });
    return nightlyRunning;
}

function startNightly(dbPath, { busy, active } = {}) {
    if (nightlyTimer || process.env.PIGTV_DB_BACKUPS === '0') return;
    nightlyTimer = setInterval(() => nightlyCheck(dbPath, { busy, active }), CHECK_EVERY_MS);
    nightlyTimer.unref?.();
    // The first check a few minutes after start, not during it.
    setTimeout(() => nightlyCheck(dbPath, { busy, active }), 5 * 60 * 1000).unref?.();
}

/** #43, for Status, from memory only (never a file call, never a path): the waiting copy, the last run, the second copy. */
function status() {
    const target = copyConfig();
    const copy = { enabled: target.enabled, ok: null, problem: null, lastCopiedAt: null };
    if (target.enabled) {
        const problem = target.problem || copyState.problem;
        Object.assign(copy, { ok: problem ? false : copyState.ok, problem, lastCopiedAt: copyState.lastCopiedAt,
            lastAttemptAt: copyState.lastAttemptAt, running: !!copyRunning, skippedAt: copyState.skippedAt });
    }
    return {
        deferredSince: runState.waitingFor,
        deferCapMin: DEFER_CAP_MS / 60000,
        lastRun: runState.lastRun,
        retryAt: runState.failedAt !== null ? runState.failedAt + runState.retryMs : null,
        copy
    };
}

/** For tests (and a restart: nothing here survives one). */
function _resetState() {
    runState.waitingFor = null;
    runState.lastRun = null;
    runState.failedAt = null;
    runState.retryMs = 0;
    Object.assign(copyState, { ok: null, problem: null, lastCopiedAt: null, lastAttemptAt: null, skippedAt: null });
    nightlySkipping = false;
}

module.exports = {
    RETENTION, list, newest, openNewest, retain, backup, backupSync, compressPending, extract, beforeMigrations, recordBuild,
    nightlyCheck, startNightly, prune, status, whenCopied, _resetState, copyTuning
};
