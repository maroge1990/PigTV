/**
 * R4-D2 (0257), R5-D1 (0261): recordings being deleted. deleteRecording retires one before its
 * first await. Every job that publishes a file for a recording - segment delivery and its move
 * (recordingSegments), the native remux and preparation (recordingMedia), compression
 * (recordingPost) - asks owned() after its awaits and before it publishes or records anything; one
 * that finds its recording retired removes only what it made itself and publishes nothing.
 * Ids are never reused (AUTOINCREMENT), so the set only grows (one number per deletion).
 *
 * 0264 (Codex review of 0261): and every step that writes a file for a recording runs as one of
 * its writers (write()). The deletion stops them (an abort signal: ffmpeg is killed, a stream
 * destroyed) and waits until each has ended and removed what it made, before it removes the
 * recording's files and its row - so once a deletion has completed nothing of it is still being
 * written, and a restart cannot leave a late file. A writer started after the retirement is
 * aborted from the start.
 *
 * 0270 (Codex reviews of 0266, 0269): a stop cannot interrupt a filesystem call already stuck on a
 * share that stopped answering (a copy from appdata to the share, while the recording's own files
 * are local). So the deletion waits up to STOP_WAIT_MS, then goes on; a writer still running is
 * abandoned, and what it made is removed when it ends.
 *
 * 0273 (Codex review of 0271): every file a writer makes has a name of its own (partialFor: no other
 * file, of this recording or a later one, can ever have it), and is journalled in recording_cleanup
 * when the writer names it (made(path)), before it exists. A row goes only once that file is gone
 * (published under its final name, or removed); a removal that fails keeps it. sweepCleanup() at
 * start removes whatever is still listed - left by an abandoned writer or a crash, since no writer
 * outlives a restart.
 *
 * 0276 (Mark, 26 Oct; Codex review of 0274): a finished file published under its final name
 * (recordingSegments.publishNoReplace: a hard link from its partial) is journalled as 'published'
 * before its partial name goes, and released (committed) once the database points at it. At start,
 * a 'published' file no recording points at is removed; and a partial still there with another name
 * (a stop between the link and that journalling) has that other name checked the same way. The sweep
 * only ever removes a file this code made.
 *
 * 0277 (Codex review of 0276): a 'published' or withdrawn row also holds the file's identity (device
 * and inode); the sweep removes it only while that name is still that very file - one put there since
 * is kept, and unlisted. A partial whose second name cannot be removed stays listed, so the next start
 * finds that name again through it.
 */
const fs = require('fs');
const crypto = require('crypto');
const { recordings: recordingsDb, initSchema } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');

const STOP_WAIT_MS = 30 * 1000;
let stopWaitMs = STOP_WAIT_MS;
function _setStopWaitMs(ms) { stopWaitMs = ms ?? STOP_WAIT_MS; } // test seam

const retired = new Set();
function retire(id) { retired.add(id); }
const owned = (id) => !retired.has(id) && Boolean(recordingsDb.getById(id));

/**
 * A file this job just made, for a recording that is no longer its: removed. One that cannot be
 * removed now (not "already gone") is journalled, so the start-up sweep removes it (Codex review of 0274).
 */
function withdraw(file, id, what) {
    const identity = identityOf(file);
    try { fs.unlinkSync(file); forget(file); } catch (e) {
        if (e.code !== 'ENOENT') {
            try {
                cleanupDb().prepare(`INSERT INTO recording_cleanup (path, recording_id, created_at, kind, identity) VALUES (?, ?, ?, 'published', ?)
                    ON CONFLICT (path) DO UPDATE SET kind = 'published', identity = excluded.identity`).run(file, id, Date.now(), identity);
            } catch (err) { /* database closed */ }
            console.warn(`[Recordings] #${id} was deleted while its ${what} was published; that copy could not be removed yet (${e.code}) and is removed at the next start`);
            return;
        }
    }
    console.log(`[Recordings] #${id} was deleted while its ${what} was published; that copy is removed too`);
}

const writers = new Map(); // recording id -> Set of { controller, ended, paths, abandoned }

const cleanupDb = () => { initSchema(); return getDb(); };
const path = require('path');
/** Does a recording point at `p` (its file, or its kept original)? Then it is the recording's, not debris. */
const recorded = (p) => Boolean(cleanupDb().prepare('SELECT 1 FROM recordings WHERE file_path = ? OR segment_original = ? LIMIT 1').get(p, p));
/** "<dev>:<ino>" of the file at `p` now (bigint, as an inode may not fit a double), or null. */
function identityOf(p) {
    try { const st = fs.statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; } catch (e) { return null; }
}
async function identityNow(p) {
    try { const st = await fs.promises.stat(p, { bigint: true }); return `${st.dev}:${st.ino}`; } catch (e) { return e.code === 'ENOENT' ? 'gone' : null; }
}
/** A finished file now under its final name, not yet recorded: journalled, as that very file, until committed(). Throws if it cannot be. */
function published(p, id) {
    cleanupDb().prepare(`INSERT INTO recording_cleanup (path, recording_id, created_at, kind, identity) VALUES (?, ?, ?, 'published', ?)
        ON CONFLICT (path) DO UPDATE SET kind = 'published', recording_id = excluded.recording_id, identity = excluded.identity`).run(p, id, Date.now(), identityOf(p));
}
/** The database points at `p` now: it is no longer debris. */
function committed(p) { if (p) forget(p); }
function forget(p) {
    try { cleanupDb().prepare('DELETE FROM recording_cleanup WHERE path = ?').run(p); } catch (e) { /* database closed */ }
}
/** Remove `p` and its row; a removal that fails (not "already gone") keeps the row for the next start. */
async function removeListed(p) {
    try { await fs.promises.unlink(p); } catch (e) {
        if (e.code !== 'ENOENT') { console.warn(`[Recordings] Could not remove ${p} yet (${e.code || e.message}); it stays listed`); return false; }
    }
    forget(p);
    return true;
}

/** A name of its own beside `file`, for a file being written: "<file>.<pid>-<random>.partial". */
const partialFor = (file) => `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.partial`;

/**
 * Run `work(signal, made)` as a writer of recording `id`; resolves or rejects as it does. `made(path)`
 * journals a file it is about to create (a partialFor name).
 */
function write(id, work) {
    const controller = new AbortController();
    if (!owned(id)) controller.abort();
    const entry = { controller, paths: new Set(), abandoned: false };
    // Codex review of 0273: a file that cannot be journalled is not made - the INSERT's error stops the
    // writer before it creates anything (a full appdata disk must not leave an untracked file).
    const made = (p) => {
        cleanupDb().prepare('INSERT OR IGNORE INTO recording_cleanup (path, recording_id, created_at) VALUES (?, ?, ?)').run(p, id, Date.now());
        entry.paths.add(p);
    };
    const run = Promise.resolve().then(() => work(controller.signal, made));
    entry.ended = run.then(() => {}, () => {});
    if (!writers.has(id)) writers.set(id, new Set());
    writers.get(id).add(entry);
    entry.ended.then(() => {
        const set = writers.get(id);
        if (set) { set.delete(entry); if (set.size === 0) writers.delete(id); }
        if (entry.abandoned) {
            // A deletion stopped waiting for it: what it made goes now.
            for (const p of entry.paths) removeListed(p);
            console.log(`[Recordings] #${id}: a stopped writer ended; what it made is removed`);
            return;
        }
        // Its files are published or removed by now, or soon after (the caller's next step): their rows
        // go once they are gone; one still there stays listed for the sweep.
        setImmediate(() => {
            // Only "not there" lets a row go; any other error (EIO, EACCES) keeps it for the sweep.
            for (const p of entry.paths) fs.promises.access(p).then(() => {}, (e) => { if (e.code === 'ENOENT') forget(p); });
        });
    });
    return run;
}

/**
 * Stop recording `id`'s writers and wait until every one has ended (deleteRecording, after retire()),
 * at most STOP_WAIT_MS: one still running then (a call stuck on the share) is abandoned, its files
 * recorded for removal. Returns the number abandoned.
 */
async function stopWriters(id) {
    const set = writers.get(id);
    if (!set) return 0;
    const running = [...set];
    for (const w of running) w.controller.abort();
    let timer;
    const late = new Promise(r => { timer = setTimeout(r, stopWaitMs); });
    await Promise.race([Promise.all(running.map(w => w.ended)), late]);
    clearTimeout(timer);
    const stuck = running.filter(w => set.has(w));
    if (stuck.length === 0) return 0;
    for (const w of stuck) w.abandoned = true; // its files are journalled already (made)
    console.warn(`[Recordings] #${id}: ${stuck.length} writer(s) did not stop within ${Math.round(stopWaitMs / 1000)} s (the share may not be answering); the deletion goes on and their files are removed when they end or at the next start`);
    return stuck.length;
}

/**
 * At start: every file still listed was left by an abandoned writer or a crash. A 'published' one a
 * recording points at was committed (kept, unlisted); a partial with a second name (its publication
 * stopped right after the link) has that name - the same file, so this code's - treated as published.
 * One that cannot be removed now stays listed.
 */
async function sweepCleanup() {
    let rows = [];
    try { rows = cleanupDb().prepare('SELECT path, kind, identity FROM recording_cleanup').all(); } catch (e) { return 0; }
    let removed = 0;
    for (const { path: p, kind, identity } of rows) {
        if (kind === 'published') {
            if (recorded(p)) { forget(p); continue; }
            const now = await identityNow(p);
            if (now === 'gone') { forget(p); continue; }
            if (now === null || identity === null) continue; // cannot tell which file it is: kept, still listed
            if (now !== identity) { forget(p); continue; } // another file at that name now: never ours to remove
        } else {
            let st = null;
            try { st = await fs.promises.stat(p); } catch (e) { /* gone, or unreadable: removeListed decides */ }
            if (st && st.nlink > 1) {
                // A publication stopped right after its link: its other name is this very file.
                let cleared = true;
                const names = await fs.promises.readdir(path.dirname(p)).catch(() => null);
                if (names === null) cleared = false;
                for (const name of names || []) {
                    const other = path.join(path.dirname(p), name);
                    if (other === p) continue;
                    const o = await fs.promises.stat(other).catch(() => null);
                    if (!o || o.ino !== st.ino || o.dev !== st.dev || recorded(other)) continue;
                    try { await fs.promises.unlink(other); removed++; } catch (e) { cleared = false; }
                }
                if (!cleared) continue; // the partial stays listed: the way back to that name next time
            }
        }
        if (await removeListed(p)) removed++;
    }
    if (removed) console.log(`[Recordings] Cleared ${removed} file(s) left by writers that did not finish`);
    return removed;
}

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdraw, write, stopWriters, sweepCleanup, partialFor, published, committed, DELETED, STOP_WAIT_MS, _setStopWaitMs };
