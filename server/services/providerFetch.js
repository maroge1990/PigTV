/**
 * #106 (0349): every playlist, guide and Xtream API download goes through here, with an overall deadline and the
 * admin's configured User-Agent (Settings → Playback; the same one playback and recordings send).
 *
 * Before, ingest used a bare `fetch()`: only undici's 300 s idle timeouts applied, so a provider trickling a body kept a
 * sync (and `activeSyncs`, so "Sync now" answered "already syncing") alive indefinitely, and the requests carried
 * Node's own User-Agent while playback carried the configured one.
 */
const TIMEOUTS = { playlist: 10 * 60e3, guide: 20 * 60e3, api: 5 * 60e3 };
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

async function userAgent() {
    try {
        const db = require('../db');
        return db.getUserAgent(await db.settings.get());
    } catch {
        return FALLBACK_UA; // no database (a parser used on its own): still a browser-like agent
    }
}

/** `kind`: 'playlist' | 'guide' | 'api'. The deadline covers the whole download, body included. */
async function providerFetch(url, kind) {
    const timeoutMs = TIMEOUTS[kind] || TIMEOUTS.api;
    return fetch(url, { headers: { 'User-Agent': await userAgent() }, signal: AbortSignal.timeout(timeoutMs) });
}

module.exports = { providerFetch, TIMEOUTS, userAgent };
