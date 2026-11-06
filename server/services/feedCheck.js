/**
 * #237: has a provider's playlist or guide changed since the last good sync?
 *
 * A scheduled sync used to re-parse and rewrite the whole guide (495,000 programmes on production) every run, though
 * the feed rarely changes between runs. Here the feed is downloaded once, to a temporary file, and fingerprinted on
 * the way: the host's ETag / Last-Modified when it sends them (asked back with If-None-Match / If-Modified-Since, so
 * an unchanged feed is a 304 and no download at all), and a SHA-256 of the bytes always. The caller parses the file,
 * and only after its write succeeded calls `commit()`, so a failed, held or empty sync never becomes "the last good".
 *
 * The fingerprint is stored in `meta` under `feed:<sourceId>:<kind>`, with a hash of whatever else decides the result
 * (the address; for a playlist, the groups never imported): change either and the next sync is a full one.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { getDb } = require('../db/sqlite');
const { providerFetch } = require('./providerFetch');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const metaKey = (sourceId, kind) => `feed:${sourceId}:${kind}`;

function stored(sourceId, kind) {
    try {
        const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(metaKey(sourceId, kind));
        return row ? JSON.parse(row.value) : null;
    } catch { return null; }
}

/** Forget a feed's fingerprint (its rows were removed): the next sync is a full one. */
function forget(sourceId, kind) {
    const keys = kind ? [metaKey(sourceId, kind)] : [metaKey(sourceId, 'playlist'), metaKey(sourceId, 'guide')];
    for (const key of keys) getDb().prepare('DELETE FROM meta WHERE key = ?').run(key);
}

/**
 * Download `url` (`kind`: 'playlist' | 'guide') for source `sourceId`.
 * `scope`: whatever besides the bytes decides what the sync writes (hashed with the address).
 * `compare`: true for a scheduled or start-up sync, which may skip; false for "Sync now", which never does.
 * `hasRows`: whether the rows this feed wrote are still there (a fingerprint without them must not skip).
 * Resolves to { unchanged: true, how } or { unchanged: false, file, contentType, commit(), discard() }.
 */
async function fetchFeed({ sourceId, kind, url, scope = '', compare = false, hasRows = true }) {
    const scopeHash = sha(`${url}\n${scope}`);
    const last = compare && hasRows ? stored(sourceId, kind) : null;
    const usable = last && last.scope === scopeHash ? last : null;
    const headers = {};
    if (usable && usable.etag) headers['If-None-Match'] = usable.etag;
    if (usable && usable.lastModified) headers['If-Modified-Since'] = usable.lastModified;

    const response = await providerFetch(url, kind, headers);
    if (usable && response.status === 304) {
        try { await response.body?.cancel?.(); } catch { /* nothing to drain */ }
        return { unchanged: true, how: 'the host answered "not modified"' };
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch ${kind === 'guide' ? 'EPG' : 'M3U'}: ${response.status} ${response.statusText}`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-feed-'));
    const file = path.join(dir, kind);
    const discard = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    const hash = crypto.createHash('sha256');
    try {
        const body = response.body
            ? (typeof response.body.pipe === 'function' ? response.body : Readable.fromWeb(response.body))
            : Readable.from([]);
        body.on('data', (chunk) => hash.update(chunk));
        await pipeline(body, fs.createWriteStream(file));
    } catch (e) {
        discard();
        throw e;
    }
    const fingerprint = {
        scope: scopeHash,
        sha256: hash.digest('hex'),
        etag: response.headers.get('etag') || null,
        lastModified: response.headers.get('last-modified') || null
    };
    if (usable && usable.sha256 === fingerprint.sha256) {
        discard();
        return { unchanged: true, how: 'the same bytes as the last good sync' };
    }
    // The caller is about to write this feed: whatever it had is no longer known to be what the rows hold, so a write
    // that fails part-way can never be mistaken for the last good one when its bytes come back (0477 Codex round 2).
    forget(sourceId, kind);
    return {
        unchanged: false,
        file,
        contentType: response.headers.get('content-type') || '',
        discard,
        commit() {
            getDb().prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
                .run(metaKey(sourceId, kind), JSON.stringify(fingerprint));
        }
    };
}

module.exports = { fetchFeed, forget, metaKey };
