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
 */
const fs = require('fs');
const { recordings: recordingsDb } = require('../db/recordingsDb');

const retired = new Set();
function retire(id) { retired.add(id); }
const owned = (id) => !retired.has(id) && Boolean(recordingsDb.getById(id));

/** A file this job just made, for a recording that is no longer its: removed. */
function withdraw(file, id, what) {
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
    console.log(`[Recordings] #${id} was deleted while its ${what} was published; that copy is removed too`);
}

const writers = new Map(); // recording id -> Set of { controller, ended }

/** Run `work(signal)` as a writer of recording `id`; resolves or rejects as it does. */
function write(id, work) {
    const controller = new AbortController();
    if (!owned(id)) controller.abort();
    const run = Promise.resolve().then(() => work(controller.signal));
    const entry = { controller, ended: run.then(() => {}, () => {}) };
    if (!writers.has(id)) writers.set(id, new Set());
    writers.get(id).add(entry);
    entry.ended.then(() => {
        const set = writers.get(id);
        if (set) { set.delete(entry); if (set.size === 0) writers.delete(id); }
    });
    return run;
}

/** Stop recording `id`'s writers and wait until every one has ended (deleteRecording, after retire()). */
async function stopWriters(id) {
    const set = writers.get(id);
    if (!set) return;
    const running = [...set];
    for (const w of running) w.controller.abort();
    await Promise.all(running.map(w => w.ended));
}

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdraw, write, stopWriters, DELETED };
