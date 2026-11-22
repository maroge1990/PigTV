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
    // 0890: a key already stored costs a read, never a write.
    if (!storedStatement().get(key)) insertStatement().run(key, url);
    // Inside someone else's open transaction a rollback could still remove the
    // row, so only remember what is already committed.
    if (!getDb().inTransaction) remember(url, key);
    return `/api/logo/${key}`;
}

function isCacheable(url) {
    return !!url && typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Prepared once per database handle; a guide page registers up to 500 logos.
let stmts = null;
function statements() {
    const db = getDb();
    if (!stmts || stmts.db !== db) {
        stmts = {
            db,
            insert: db.prepare('INSERT OR IGNORE INTO logo_cache (key, url) VALUES (?, ?)'),
            stored: db.prepare('SELECT 1 FROM logo_cache WHERE key = ?'),
            storedMany: new Map() // placeholders count -> statement
        };
    }
    return stmts;
}
const insertStatement = () => statements().insert;
const storedStatement = () => statements().stored;
const STORED_CHUNK = 500;
/** The keys among `keys` that already have their row: one read per 500, no write. */
function storedKeys(keys) {
    const s = statements();
    const found = new Set();
    for (let i = 0; i < keys.length; i += STORED_CHUNK) {
        const chunk = keys.slice(i, i + STORED_CHUNK);
        let stmt = s.storedMany.get(chunk.length);
        if (!stmt) {
            stmt = s.db.prepare(`SELECT key FROM logo_cache WHERE key IN (${chunk.map(() => '?').join(',')})`).pluck();
            s.storedMany.set(chunk.length, stmt);
        }
        for (const k of stmt.all(...chunk)) found.add(k);
    }
    return found;
}

// URL -> key for every URL whose row is known to be committed, so a repeat
// read costs a Map lookup: no hash, no statement, no write transaction.
// Tied to the db handle like the statements; nothing deletes logo_cache rows
// and the version is fixed at load, so nothing else invalidates it.
// 0890 (#361): programme artwork alone passes 20,000 URLs a day, and a full
// map used to be cleared whole, so every page after it wrote again. Now it
// holds 60,000 and a full map drops its oldest tenth. About 260 bytes an entry
// (an 83-character URL and its key, measured): at most ~16 MB. A URL that was
// dropped costs one read on its next page, never a write.
const MEMORY_LIMIT = 60000;
let memoryMap = new Map();
let memoryDb = null;
function memory() {
    const db = getDb();
    if (memoryDb !== db) { memoryDb = db; memoryMap = new Map(); }
    return memoryMap;
}
function remember(url, key) {
    const m = memory();
    if (m.size >= MEMORY_LIMIT) {
        let drop = MEMORY_LIMIT / 10;
        for (const old of m.keys()) { if (drop-- <= 0) break; m.delete(old); }
    }
    m.set(url, key);
}
/** For tests: forget everything remembered. */
function _resetMemory() { memoryMap = new Map(); memoryDb = null; }
/** For tests: how many URLs are remembered. */
function _memorySize() { return memory().size; }

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
    const db = getDb();
    const fresh = [];
    const pending = [];
    for (const item of misses) {
        const url = item.logo;
        if (!isCacheable(url)) continue; // unchanged, as registerLogo returns it
        const key = keyForUrl(url);
        pending.push({ item, url, key });
    }
    if (!pending.length) return;
    // 0890: what the table already has is only read; the rest is written in
    // one transaction per page (otherwise the first load of a 500-channel page
    // commits 500 separate inserts).
    const stored = storedKeys([...new Set(pending.map(p => p.key))]);
    const toInsert = pending.filter(p => !stored.has(p.key));
    if (toInsert.length) {
        db.transaction(() => {
            for (const { key, url } of toInsert) insertStatement().run(key, url);
        })();
    }
    for (const { item, url, key } of pending) {
        item.logo = `/api/logo/${key}`;
        fresh.push([url, key]);
    }
    if (db.inTransaction) return; // an outer transaction could still roll back
    for (const [url, key] of fresh) remember(url, key); // committed
}

module.exports = { LOGO_CACHE_VERSION, MEMORY_LIMIT, keyForUrl, registerLogo, applyLogoCache, _resetMemory, _memorySize };
