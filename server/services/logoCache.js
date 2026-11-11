/**
 * Logo cache lookup (0112, roadmap S1.4).
 *
 * A channel logo is a provider URL - often slow, sometimes gone, and never
 * something a client should have to fetch cross-origin. `registerLogo(url)`
 * is called wherever a library response builds a `logo` field
 * (routes/library.js): it records the URL under a hash of itself in
 * `logo_cache` (idempotent - a URL seen before keeps its key) and returns the
 * relative path a client can fetch, `/api/logo/<key>`, in its place.
 *
 * That lookup row is also what makes routes/logo.js's GET /api/logo/:key
 * anything other than an open proxy: only a key that was registered here -
 * because it actually appeared as a channel or EPG logo - resolves to a URL
 * the route will fetch. An unregistered key is a 404.
 */
const crypto = require('crypto');
const { getDb } = require('../db/sqlite');

/**
 * The stored logos' format version. 0112's downscale turned palette PNGs with
 * transparency into opaque ones (0141); version 2 is the fixed conversion.
 * Bump it whenever the stored bytes change meaning: routes/logo.js then drops
 * every stored file once at startup, and because the version is part of the
 * key, clients get new `/api/logo/<key>` paths too. That matters because the
 * Apple client keeps artwork on disk keyed by URL, forever, and browsers keep
 * it for the week-long max-age: the same path would keep the bad copy.
 */
const LOGO_CACHE_VERSION = 2;

/** sha256 of the cache version and the URL, hex, truncated to 32 chars -
 *  short enough for a path segment, long enough that a collision is not a
 *  practical concern here. (Version 1 hashed the URL alone.) */
function keyForUrl(url) {
    return crypto.createHash('sha256').update(`v${LOGO_CACHE_VERSION}|${url}`).digest('hex').slice(0, 32);
}

/**
 * Register `url` as a known logo and return the path a client should use
 * instead. Anything that is not an http(s) URL (already-relative paths, a
 * missing logo) is returned unchanged - there is nothing to cache.
 */
function registerLogo(url) {
    if (!isCacheable(url)) return url || null;
    const known = memory().get(url);
    if (known) return `/api/logo/${known}`;
    const key = keyForUrl(url);
    insertStatement().run(key, url);
    // Inside someone else's open transaction a rollback could still remove the
    // row, so only remember what is already committed.
    if (!getDb().inTransaction) remember(url, key);
    return `/api/logo/${key}`;
}

function isCacheable(url) {
    return !!url && typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Prepared once per database handle; a guide page registers up to 500 logos.
let insertStmt = null;
let insertDb = null;
function insertStatement() {
    const db = getDb();
    if (insertDb !== db) {
        insertDb = db;
        insertStmt = db.prepare('INSERT OR IGNORE INTO logo_cache (key, url) VALUES (?, ?)');
    }
    return insertStmt;
}

// URL -> key for every URL whose row is known to be committed, so a repeat
// read costs a Map lookup: no hash, no statement, no write transaction.
// Tied to the db handle like the statement; nothing deletes logo_cache rows
// and the version is fixed at load, so nothing else invalidates it.
const MEMORY_LIMIT = 20000;
let memoryMap = new Map();
let memoryDb = null;
function memory() {
    const db = getDb();
    if (memoryDb !== db) { memoryDb = db; memoryMap = new Map(); }
    return memoryMap;
}
function remember(url, key) {
    const m = memory();
    if (m.size >= MEMORY_LIMIT) m.clear();
    m.set(url, key);
}
/** For tests: forget everything remembered. */
function _resetMemory() { memoryMap = new Map(); memoryDb = null; }

/** Replace the `logo` field of each item in place, for a whole page at once. */
function applyLogoCache(items) {
    const m = memory();
    const misses = [];
    for (const item of items) {
        if (!item.logo) continue;
        const known = isCacheable(item.logo) && m.get(item.logo);
        if (known) item.logo = `/api/logo/${known}`;
        else misses.push(item);
    }
    if (!misses.length) return;
    // One transaction per page (misses only): otherwise the first load of a
    // 500-channel page commits 500 separate inserts.
    const db = getDb();
    const fresh = [];
    db.transaction(() => {
        for (const item of misses) {
            const url = item.logo;
            if (!isCacheable(url)) continue; // unchanged, as registerLogo returns it
            const key = keyForUrl(url);
            insertStatement().run(key, url);
            fresh.push([url, key]);
            item.logo = `/api/logo/${key}`;
        }
    })();
    if (db.inTransaction) return; // an outer transaction could still roll back
    for (const [url, key] of fresh) remember(url, key); // committed
}

module.exports = { LOGO_CACHE_VERSION, keyForUrl, registerLogo, applyLogoCache, _resetMemory };
