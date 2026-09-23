/**
 * Opaque playback handles (0119, roadmap S2.1 / review P1-4, contract C-D).
 *
 * A `direct` resolve used to hand the client `/api/proxy/stream?url=<provider
 * URL>`: the provider's address, credentials included, in a response, in the
 * client's logs and in anything that records request URLs. Now it hands out
 * `/api/proxy/stream?h=<handle>`, and the handle maps to the URL here, in
 * memory only:
 *
 *   - 32 lowercase hex characters (128 random bits), so it cannot be guessed;
 *   - valid for TTL_MS (12 h) from when it was last handed out;
 *   - at most MAX_HANDLES live at once; the least recently used goes first.
 *
 * The same URL gets the same handle while it is live, so a player re-fetching
 * an HLS manifest (whose segments are handed out as handles too) does not grow
 * the map by a whole playlist on every refresh.
 *
 * A server restart forgets every handle: the client re-resolves, as it does
 * after any failed start. `PIGTV_PLAYBACK_HANDLES=0` is the rollback (resolve
 * goes back to `?url=`); `?url=` itself keeps working for the web's legacy
 * callers until W2.1 removes them.
 */
const crypto = require('crypto');

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_HANDLES = 10000;
const HANDLE_RE = /^[0-9a-f]{32}$/;

// handle -> { url, expiresAt }, in least-recently-used order (a Map keeps insertion order).
const byHandle = new Map();
// url -> handle, to hand out the same handle for the same URL.
const byUrl = new Map();

function handlesEnabled() {
    return process.env.PIGTV_PLAYBACK_HANDLES !== '0';
}

function drop(handle) {
    const entry = byHandle.get(handle);
    if (!entry) return;
    byHandle.delete(handle);
    if (byUrl.get(entry.url) === handle) byUrl.delete(entry.url);
}

function touch(handle, entry, now) {
    entry.expiresAt = now + TTL_MS;
    byHandle.delete(handle);
    byHandle.set(handle, entry);
}

/** A handle for `url`: the existing one if still live, else a new one. */
function createHandle(url, now = Date.now()) {
    const existing = byUrl.get(url);
    if (existing) {
        const entry = byHandle.get(existing);
        if (entry && entry.expiresAt > now) {
            touch(existing, entry, now);
            return existing;
        }
        drop(existing);
    }
    while (byHandle.size >= MAX_HANDLES) drop(byHandle.keys().next().value);
    const handle = crypto.randomBytes(16).toString('hex');
    byHandle.set(handle, { url, expiresAt: now + TTL_MS });
    byUrl.set(url, handle);
    return handle;
}

/** The URL behind a handle, or null if it is malformed, unknown or expired. */
function resolveHandle(handle, now = Date.now()) {
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return null;
    const entry = byHandle.get(handle);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        drop(handle);
        return null;
    }
    touch(handle, entry, now);
    return entry.url;
}

function handleCount() {
    return byHandle.size;
}

function clearHandles() {
    byHandle.clear();
    byUrl.clear();
}

module.exports = {
    TTL_MS,
    MAX_HANDLES,
    handlesEnabled,
    createHandle,
    resolveHandle,
    handleCount,
    clearHandles
};
