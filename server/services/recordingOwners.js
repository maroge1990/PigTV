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
 * are local). So the deletion waits up to STOP_WAIT_MS; a writer still running then has the files
 * it made (made(path)) recorded in recording_cleanup, durably. They are removed when it ends, or by
 * sweepCleanup() at the next start, and the deletion goes on.
 */
const fs = require('fs');
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
function forget(paths) {
    const del = cleanupDb().prepare('DELETE FROM recording_cleanup WHERE path = ?');
    for (const p of paths) del.run(p);
}

/**
 * Run `work(signal, made)` as a writer of recording `id`; resolves or rejects as it does. `made(path)`
 * names a file it creates before it creates it (0270: what an abandoned writer leaves is removed).
 */
function write(id, work) {
    const controller = new AbortController();
    if (!owned(id)) controller.abort();
    const entry = { controller, paths: new Set(), abandoned: false };
    const run = Promise.resolve().then(() => work(controller.signal, (p) => { entry.paths.add(p); }));
    entry.ended = run.then(() => {}, () => {});
    if (!writers.has(id)) writers.set(id, new Set());
    writers.get(id).add(entry);
    entry.ended.then(() => {
        const set = writers.get(id);
        if (set) { set.delete(entry); if (set.size === 0) writers.delete(id); }
        if (!entry.abandoned) return;
        // A deletion stopped waiting for it: what it made goes now, and is no longer pending.
        for (const p of entry.paths) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } }
        try { forget(entry.paths); } catch (e) { /* database closed */ }
        console.log(`[Recordings] #${id}: a stopped writer ended; what it made is removed`);
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
    const add = cleanupDb().prepare('INSERT OR IGNORE INTO recording_cleanup (path, recording_id, created_at) VALUES (?, ?, ?)');
    for (const w of stuck) {
        w.abandoned = true;
        for (const p of w.paths) add.run(p, id, Date.now());
    }
    console.warn(`[Recordings] #${id}: ${stuck.length} writer(s) did not stop within ${Math.round(stopWaitMs / 1000)} s (the share may not be answering); the deletion goes on and their files are removed when they end or at the next start`);
    return stuck.length;
}

/** At start (0270): files writers of deleted recordings left. One that cannot be removed now stays listed. */
async function sweepCleanup() {
    let rows = [];
    try { rows = cleanupDb().prepare('SELECT path FROM recording_cleanup').all(); } catch (e) { return 0; }
    let removed = 0;
    for (const { path: p } of rows) {
        try { await fs.promises.unlink(p); } catch (e) { if (e.code !== 'ENOENT') continue; }
        forget([p]);
        removed++;
    }
    if (removed) console.log(`[Recordings] Removed ${removed} file(s) left by writers of deleted recordings`);
    return removed;
}

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdraw, write, stopWriters, sweepCleanup, DELETED, STOP_WAIT_MS, _setStopWaitMs };
