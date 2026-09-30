/**
 * Which provider account a stream source logs in to (0181).
 *
 * Two sources configured with the same server and the same login are one account at the
 * provider, however they are named: they share its connection limit, and the provider cuts
 * both when a second connection opens on a one-connection account (the "Input/output error"
 * floods of 1 Oct, where Trex had been given Dream4K's server and login). The key is the
 * normalised server origin plus the login's username, hashed: it is only ever compared
 * with another key, never shown, logged or returned, so no login can leak through it.
 *
 * `accountKeyFor(source)` -> a short hex string, or null when no login can be derived
 * (an EPG source, an M3U with no Xtream address): such a source never shares a pool.
 */

const crypto = require('crypto');

// deriveLogin reads the database for an M3U; a short cache keeps the pools' per-call
// directory (rebuilt on every admission) from repeating that. Keyed on what the login
// is derived from, so an edit to the source is seen at once.
const TTL_MS = 30000;
const cache = new Map();

function compute(source) {
    const login = require('./providerAccounts').deriveLogin(source);
    if (!login || !login.url || !login.username) return null;
    let origin;
    try { origin = new URL(String(login.url)).origin.toLowerCase(); } catch (e) { return null; }
    if (!origin || origin === 'null') return null;
    return crypto.createHash('sha256').update(`${origin}\n${login.username}`).digest('hex').slice(0, 16);
}

function accountKeyFor(source) {
    if (!source || source.type === 'epg') return null;
    const sig = [source.type, source.url, source.username, source.password].join('\u0000');
    const hit = cache.get(source.id);
    const now = Date.now();
    if (hit && hit.sig === sig && now - hit.at < TTL_MS) return hit.key;
    let key = null;
    try { key = compute(source); } catch (e) { key = null; }
    cache.set(source.id, { sig, key, at: now });
    return key;
}

/** Test seam: forget the cached keys. */
function reset() { cache.clear(); }

module.exports = { accountKeyFor, reset };
