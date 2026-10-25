/**
 * R4-D2 (0257), R5-D1 (0261): recordings being deleted. deleteRecording retires one before its
 * first await. Every job that publishes a file for a recording - segment delivery and its move
 * (recordingSegments), the native remux and preparation (recordingMedia), compression
 * (recordingPost) - asks owned() after its awaits and before it publishes or records anything; one
 * that finds its recording retired removes only what it made itself and publishes nothing.
 * Ids are never reused (AUTOINCREMENT), so the set only grows (one number per deletion).
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

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdraw, DELETED };
