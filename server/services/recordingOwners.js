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

/** A file this job just made, for a recording that is no longer its: removed. */
function withdraw(file, id, what) {
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
    console.log(`[Recordings] #${id} was deleted while its ${what} was published; that copy is removed too`);
}

const writers = new Map(); // recording id -> Set of { controller, ended, paths, abandoned }

const cleanupDb = () => { initSchema(); return getDb(); };
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
    const made = (p) => {
        entry.paths.add(p);
        try { cleanupDb().prepare('INSERT OR IGNORE INTO recording_cleanup (path, recording_id, created_at) VALUES (?, ?, ?)').run(p, id, Date.now()); } catch (e) { /* database closed */ }
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
            for (const p of entry.paths) fs.promises.access(p).then(() => {}, () => forget(p));
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

/** At start: every file still listed was left by an abandoned writer or a crash. One that cannot be removed now stays listed. */
async function sweepCleanup() {
    let rows = [];
    try { rows = cleanupDb().prepare('SELECT path FROM recording_cleanup').all(); } catch (e) { return 0; }
    let removed = 0;
    for (const { path: p } of rows) if (await removeListed(p)) removed++;
    if (removed) console.log(`[Recordings] Cleared ${removed} file(s) left by writers that did not finish`);
    return removed;
}

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdraw, write, stopWriters, sweepCleanup, partialFor, DELETED, STOP_WAIT_MS, _setStopWaitMs };
