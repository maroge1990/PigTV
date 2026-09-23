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

/** sha256 of the URL, hex, truncated to 32 chars - short enough for a path
 *  segment, long enough that a collision is not a practical concern here. */
function keyForUrl(url) {
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/**
 * Register `url` as a known logo and return the path a client should use
 * instead. Anything that is not an http(s) URL (already-relative paths, a
 * missing logo) is returned unchanged - there is nothing to cache.
 */
function registerLogo(url) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url || null;
    const key = keyForUrl(url);
    insertStatement().run(key, url);
    return `/api/logo/${key}`;
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

/** Replace the `logo` field of each item in place, for a whole page at once. */
function applyLogoCache(items) {
    // One transaction per page: otherwise the first load of a 500-channel
    // page commits 500 separate inserts.
    getDb().transaction(() => {
        for (const item of items) {
            if (item.logo) item.logo = registerLogo(item.logo);
        }
    })();
}

module.exports = { keyForUrl, registerLogo, applyLogoCache };
