/**
 * Kept guide answers (#361, 0893): GET /api/library/guide's serialised body, kept per minute, the way /api/sports/events
 * keeps its own (sportsEvents.eventsResponse): a repeat in the same minute is a buffer send, gzip is done once per
 * answer, and the weak ETag lets a client that sends If-None-Match have a 304.
 *
 * The key is everything that can change the body:
 *   - the guide version (services/libraryRev.js: syncs, EPG generations, hide/show, links, mappings, numbers, health
 *     class flips, the build) and the database handle; the lineup revision (0894: every committed sync batch);
 *   - measured quality: channelMeasurements.revision() (a write through that module, another process's commit; a write
 *     by hand on the server's own connection, which nothing does, would show within the minute);
 *   - the sport live index (programmeFields.liveIndex(): one Map per built event list, so its identity is its revision);
 *   - the request: start, end, limit, offset, cursor, category;
 *   - the minute. `now` and every `isNow` are computed at the minute's start, so a kept answer is the answer for that
 *     minute. What has no revision of its own (a channel's health ageing out of its 7-day window without a class flip
 *     being recorded, the EPG icon index's 5-minute refresh) is at most a minute stale.
 * Only a request with its own `start` is kept: without one the window starts at the request's own millisecond.
 * At most MAX_ENTRIES answers and MAX_BYTES (body + gzip), the oldest dropped first; an older minute's go at once.
 */
const crypto = require('crypto');
const zlib = require('zlib');
const { getDb } = require('../db/sqlite');
const { currentGuideVersion, currentLineupRev } = require('./libraryRev');
const channelMeasurements = require('./channelMeasurements');
const programmeFields = require('./programmeFields');

const MINUTE_MS = 60 * 1000;
const MAX_ENTRIES = 8;
const MAX_BYTES = 40 * 1024 * 1024; // a 500-channel, 24 h page is ~4.1 MB raw + ~0.8 MB gzip: 8 of them fit

const entries = new Map(); // key -> entry, oldest first
let bytes = 0;

const ids = new WeakMap();
let nextId = 1;
const idOf = (obj) => { if (!obj) return 0; let id = ids.get(obj); if (!id) { id = nextId++; ids.set(obj, id); } return id; };

/** The clock (tests set it). */
const clock = { now: () => Date.now() };
const minuteOf = (t) => Math.floor(t / MINUTE_MS) * MINUTE_MS;

/**
 * The key for one guide request in `minute`, or null when it cannot be kept (no guide version or measurement revision:
 * a sandbox without package.json, a read-only handle).
 */
function keyFor({ minute, start, end, limit, offset, cursor, category }) {
    let version, measured;
    try { version = currentGuideVersion(); } catch { return null; }
    const db = getDb();
    measured = channelMeasurements.revision(db);
    if (measured === null) return null;
    const live = idOf(programmeFields.liveIndex());
    return JSON.stringify([idOf(db), version, currentLineupRev(), measured, live, minute, start, end, limit, offset, cursor || '', category || '']);
}

function drop(key) {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    bytes -= e.bytes;
}
function trim(minute) {
    for (const [k, e] of entries) if (e.minute < minute) drop(k);
    while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) drop(entries.keys().next().value);
}

/** A kept answer { body, etag, gzip() } for `key`, or null. */
function get(key) {
    const e = entries.get(key);
    if (!e) return null;
    entries.delete(key); // most recently used goes last
    entries.set(key, e);
    return e.out;
}

/** Keep `body` (a Buffer) under `key` for `minute`; returns { body, etag, gzip() }. */
function put(key, body, minute) {
    // 0894: the ETag names the body, not the key: health ageing or the EPG logo refresh can change a body under the
    // same key, and an evicted answer rebuilt differently must not validate the old one. Shared by both encodings.
    const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 24)}"`;
    const entry = { minute, bytes: body.length };
    let gz = null;
    entry.out = {
        body, etag,
        // compressed once, off the loop (zlib's threadpool), for every client that takes gzip
        gzip: () => gz || (gz = new Promise((resolve, reject) => zlib.gzip(body, (err, buf) => {
            if (err) return reject(err);
            if (entries.get(key) === entry) { entry.bytes += buf.length; bytes += buf.length; trim(minute); }
            resolve(buf);
        })))
    };
    drop(key);
    if (body.length <= MAX_BYTES) {
        entries.set(key, entry);
        bytes += entry.bytes;
        trim(minute);
    }
    return entry.out;
}

/** For tests: how much is kept, and forget it all. */
function _stats() { return { entries: entries.size, bytes }; }
function _reset() { entries.clear(); bytes = 0; }

module.exports = { MINUTE_MS, MAX_ENTRIES, MAX_BYTES, clock, minuteOf, keyFor, get, put, _stats, _reset };
