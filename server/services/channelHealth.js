/**
 * Channel health (0133, roadmap S4.1, docs/ROADMAP-CONTRACTS.md C-G).
 *
 * One row per start attempt in `channel_health`, keyed by the channel's
 * identity (source + stable_id, else item_id - the favourites' and channel
 * numbers' key), so a provider reorder does not scatter a channel's history.
 *
 * Where attempts come from:
 *   - the resolve route (routes/playback.js): a resolve that answered is an
 *     ok attempt; one that failed is a failed attempt with its reason category
 *     (a 409 "someone else is watching" is not an attempt at all);
 *   - the client's events, mapped to the attempt through the owner that made
 *     it (the same owner -> last resolve mapping the status page uses, 0124:
 *     client events carry no session id or channel). A `play-start` fills in
 *     the attempt's first-picture time; a `media-error` or `start-timeout`
 *     BEFORE any play-start turns the attempt into a failed start (`player`).
 *     A media error after the picture started is a stall, not a failed start.
 *     A `play-end` (0142) stores the attempt's watched time and stall count.
 *
 * `health` for a channel, over the last 7 days:
 *   flaky  failed starts >= 2, or failures > 30% with at least 3 attempts,
 *          or (0142) >= 3 stalls per hour watched over at least 20 minutes
 *   ok     any attempt, and not flaky
 *   null   no attempts
 * Rows are kept 30 days and pruned daily (startPruneTimer, from index.js).
 * library_rev is bumped only when a channel's health *changes*, so a cached
 * guide learns about a new warning dot without every play invalidating it.
 */
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('./libraryRev');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;
const KEEP_MS = 30 * DAY_MS;
const FLAKY_FAILURES = 2;
const FLAKY_RATE = 0.3;
const FLAKY_MIN_ATTEMPTS = 3;
// 0142: stalls make a channel flaky only over enough watching to mean something.
const FLAKY_STALLS_PER_HOUR = 3;
const FLAKY_MIN_WATCH_SEC = 20 * 60;
// Ranking: stalls per hour with the hours floored at 30 minutes, so one stall
// in a 10-second play counts as 2/hour, not 360/hour.
const RANK_MIN_WATCH_SEC = 30 * 60;
// A client event older than this after its resolve is not about that start.
const PENDING_MS = 5 * 60 * 1000;
const MAX_PENDING = 200;
// A play-end longer after its resolve than this is not matched to it.
const ENDED_MS = 24 * 60 * 60 * 1000;

// Aggregates over the window, reused for a short while: a guide load asks for
// many pages in a row. Dropped whenever an attempt is written.
const CACHE_MS = 60 * 1000;
let cache = null;

// owner -> { rowId, at, started }
const pending = new Map();

/** The reason category stored with a failure, from the client-safe resolve error (C-B wording). */
function reasonCategory(message) {
    const m = String(message || '');
    if (m.startsWith('The provider refused this channel')) return 'refused';
    if (m.startsWith('The provider did not respond')) return 'no-response';
    if (m.startsWith('This channel is not available')) return 'unavailable';
    return 'error';
}

/** Health from counts; exported for the tests' threshold table. */
function classify(attempts, failures, stalls = 0, watchedSec = 0) {
    if (!attempts) return null;
    if (failures >= FLAKY_FAILURES) return 'flaky';
    if (attempts >= FLAKY_MIN_ATTEMPTS && failures / attempts > FLAKY_RATE) return 'flaky';
    if (watchedSec >= FLAKY_MIN_WATCH_SEC && stalls / (watchedSec / 3600) >= FLAKY_STALLS_PER_HOUR) return 'flaky';
    return 'ok';
}
const classifyCounts = (c) => classify(c.attempts, c.failures, c.stalls, c.watched);

/** The identity (and current name) of a channel a client named by source + (bare or composite) id. */
function channelFor(sourceId, channelId) {
    if (sourceId === undefined || sourceId === null || channelId === undefined || channelId === null) return null;
    const stripped = String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
    const row = getDb().prepare(`
        SELECT source_id, name, COALESCE(stable_id, item_id) AS channel_key FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
    `).get(parseInt(sourceId, 10), stripped);
    return row ? { sourceId: row.source_id, key: row.channel_key, name: row.name } : null;
}

function countsFor(sourceId, key, now) {
    return getDb().prepare(`
        SELECT COUNT(*) AS attempts, COALESCE(SUM(ok = 0), 0) AS failures,
               COALESCE(SUM(stalls), 0) AS stalls, COALESCE(SUM(watched_sec), 0) AS watched
        FROM channel_health WHERE source_id = ? AND channel_key = ? AND at >= ?
    `).get(sourceId, key, now - WINDOW_MS);
}

/** Write an attempt, and bump library_rev if it changed the channel's health. */
function writeAttempt(channel, { ok, reason = null, firstPictureSec = null, providerId = null, now = Date.now() }) {
    const db = getDb();
    const before = countsFor(channel.sourceId, channel.key, now);
    const info = db.prepare(`
        INSERT INTO channel_health (source_id, channel_key, name, at, ok, first_picture_sec, reason, provider_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(channel.sourceId, channel.key, channel.name || null, now, ok ? 1 : 0, firstPictureSec, ok ? null : reason,
        Number.isInteger(Number(providerId)) && providerId !== null ? Number(providerId) : null);
    afterChange(channel.sourceId, channel.key, before, now);
    return Number(info.lastInsertRowid);
}

function afterChange(sourceId, key, before, now) {
    cache = null;
    const after = countsFor(sourceId, key, now);
    if (classifyCounts(before) !== classifyCounts(after)) {
        try { bumpLibraryRev(); } catch { /* the dot shows on the next guide change instead */ }
    }
}

/**
 * The resolve route's outcome for a channel. Returns the row id, or null when
 * the channel is not in the playlist (nothing to key it on). Never throws:
 * health is a diagnostic and must not be the reason a play fails.
 */
function recordResolve({ sourceId, channelId, ok, reason, owner, providerId = null, now = Date.now() }) {
    try {
        const channel = channelFor(sourceId, channelId);
        if (!channel) return null;
        // 0174: always the primary channel's row; provider_id says which provider served
        // (or last failed) it - a play that failed over to a backup is an ok start.
        const rowId = writeAttempt(channel, { ok, reason: ok ? null : reasonCategory(reason), providerId, now });
        if (owner) {
            pending.delete(owner);
            if (ok) pending.set(owner, { rowId, at: now, started: false });
            while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
        }
        return rowId;
    } catch (e) {
        console.warn('[Health] Could not record a start:', e.message);
        return null;
    }
}

function pendingFor(owner, now) {
    const p = owner ? pending.get(owner) : null;
    if (!p || now - p.at > PENDING_MS) return null;
    return p;
}

/** A client's play-start: the attempt got a picture after `firstPictureSec`. */
function clientStarted(owner, firstPictureSec, now = Date.now()) {
    try {
        const p = pendingFor(owner, now);
        if (!p || p.started) return false;
        p.started = true;
        const sec = typeof firstPictureSec === 'number' && Number.isFinite(firstPictureSec) && firstPictureSec >= 0 ? firstPictureSec : null;
        if (sec !== null) getDb().prepare('UPDATE channel_health SET first_picture_sec = ? WHERE id = ?').run(sec, p.rowId);
        cache = null;
        return true;
    } catch (e) {
        return false;
    }
}

/** A client's media-error / start-timeout: a failed start only if nothing had played yet. */
function clientFailed(owner, now = Date.now()) {
    try {
        const p = pendingFor(owner, now);
        if (!p || p.started) return false;
        pending.delete(owner);
        const db = getDb();
        const row = db.prepare('SELECT source_id, channel_key, ok FROM channel_health WHERE id = ?').get(p.rowId);
        if (!row || !row.ok) return false;
        const before = countsFor(row.source_id, row.channel_key, now);
        db.prepare(`UPDATE channel_health SET ok = 0, reason = 'player' WHERE id = ?`).run(p.rowId);
        afterChange(row.source_id, row.channel_key, before, now);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 0191: the server found the owner's last started play blank (transcodeSession.checkPicture):
 * a black or still placeholder, not the channel. The attempt becomes a failure with reason
 * 'blank' even though it "played". The pending entry stays, so play-end still lands on it.
 */
function sessionBlank(owner, now = Date.now()) {
    try {
        const p = owner ? pending.get(owner) : null;
        if (!p || now - p.at > ENDED_MS) return false;
        const db = getDb();
        const row = db.prepare('SELECT source_id, channel_key FROM channel_health WHERE id = ?').get(p.rowId);
        if (!row) return false;
        const before = countsFor(row.source_id, row.channel_key, now);
        db.prepare(`UPDATE channel_health SET ok = 0, reason = 'blank' WHERE id = ?`).run(p.rowId);
        afterChange(row.source_id, row.channel_key, before, now);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * A client's play-end (0142): how long the owner's last started attempt was
 * watched and how often it stalled. Matched like the other client events
 * (owner -> last resolve), once per attempt.
 */
function clientEnded(owner, watchedSec, stalls, now = Date.now()) {
    try {
        const p = owner ? pending.get(owner) : null;
        if (!p || now - p.at > ENDED_MS) return false;
        pending.delete(owner);
        const watched = typeof watchedSec === 'number' && Number.isFinite(watchedSec) && watchedSec >= 0 ? Math.min(watchedSec, 86400) : null;
        const count = typeof stalls === 'number' && Number.isFinite(stalls) && stalls >= 0 ? Math.min(Math.round(stalls), 10000) : null;
        if (watched === null && count === null) return false;
        const db = getDb();
        const row = db.prepare('SELECT source_id, channel_key FROM channel_health WHERE id = ?').get(p.rowId);
        if (!row) return false;
        const before = countsFor(row.source_id, row.channel_key, now);
        db.prepare('UPDATE channel_health SET watched_sec = ?, stalls = ? WHERE id = ?').run(watched, count, p.rowId);
        afterChange(row.source_id, row.channel_key, before, now);
        return true;
    } catch (e) {
        return false;
    }
}

/** Map "sourceId:channelKey" -> { attempts, failures, stalls, watched } over the window. */
function windowCounts(now = Date.now()) {
    if (cache && now - cache.builtAt < CACHE_MS && now >= cache.builtAt) return cache.counts;
    const counts = new Map();
    const rows = getDb().prepare(`
        SELECT source_id, channel_key, COUNT(*) AS attempts, COALESCE(SUM(ok = 0), 0) AS failures,
               COALESCE(SUM(stalls), 0) AS stalls, COALESCE(SUM(watched_sec), 0) AS watched
        FROM channel_health WHERE at >= ? GROUP BY source_id, channel_key
    `).all(now - WINDOW_MS);
    for (const r of rows) counts.set(`${r.source_id}:${r.channel_key}`, { attempts: r.attempts, failures: r.failures, stalls: r.stalls, watched: r.watched });
    cache = { builtAt: now, counts };
    return counts;
}

/**
 * Give each library row its `health`. A row needs `sourceId` and the identity
 * the SQL key uses (`stableId`, else `id`).
 */
function applyHealth(rows, now = Date.now()) {
    let counts;
    try { counts = windowCounts(now); } catch (e) { counts = new Map(); }
    for (const r of rows) {
        const c = counts.get(`${r.sourceId}:${r.stableId || r.id}`);
        r.health = c ? classifyCounts(c) : null;
    }
    return rows;
}

/**
 * The status page's "Least reliable channels" (0133; stalls since 0142): every
 * channel with a failed start or a stall in the window, ranked by
 * failed starts + stalls per hour watched (hours floored at 30 minutes).
 */
function leastReliable({ limit = 10, now = Date.now() } = {}) {
    const rows = getDb().prepare(`
        SELECT source_id, channel_key, name, ok, reason, first_picture_sec, stalls, watched_sec, at FROM channel_health
        WHERE at >= ? ORDER BY at ASC
    `).all(now - WINDOW_MS);
    const byKey = new Map();
    for (const r of rows) {
        const k = `${r.source_id}:${r.channel_key}`;
        const e = byKey.get(k) || { name: null, attempts: 0, failures: 0, stalls: 0, watched: 0, pictures: [], blank: false };
        e.name = r.name || e.name; // the latest name wins
        e.blank = r.reason === 'blank'; // 0191: whether the latest attempt was a blank picture
        e.attempts++;
        if (!r.ok) e.failures++;
        e.stalls += r.stalls || 0;
        e.watched += r.watched_sec || 0;
        if (r.first_picture_sec !== null) e.pictures.push(r.first_picture_sec);
        byKey.set(k, e);
    }
    const median = (xs) => {
        if (!xs.length) return null;
        const s = xs.slice().sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10;
    };
    const round1 = (x) => Math.round(x * 10) / 10;
    return [...byKey.values()]
        .filter(e => e.failures > 0 || e.stalls > 0)
        .map(e => ({
            name: e.name || 'unknown',
            attempts: e.attempts,
            failures: e.failures,
            stalls: e.stalls,
            watchedMin: round1(e.watched / 60),
            stallsPerHour: e.watched > 0 ? round1(e.stalls / (e.watched / 3600)) : null,
            medianFirstPictureSec: median(e.pictures),
            health: classify(e.attempts, e.failures, e.stalls, e.watched),
            blank: e.blank,
            score: round1(e.failures + e.stalls / (Math.max(e.watched, RANK_MIN_WATCH_SEC) / 3600))
        }))
        .sort((a, b) => b.score - a.score
            || b.failures - a.failures
            || a.name.localeCompare(b.name))
        .slice(0, limit);
}

/** Delete attempts older than 30 days. Returns how many went. */
function prune(now = Date.now()) {
    const n = getDb().prepare('DELETE FROM channel_health WHERE at < ?').run(now - KEEP_MS).changes;
    if (n) cache = null;
    return n;
}

let pruneTimer = null;
/** Prune now and then once a day (index.js, at startup). */
function startPruneTimer() {
    const run = () => {
        try {
            const n = prune();
            if (n) console.log(`[Health] Pruned ${n} start record(s) older than 30 days`);
        } catch (e) {
            console.warn('[Health] Prune failed:', e.message);
        }
    };
    run();
    clearInterval(pruneTimer);
    pruneTimer = setInterval(run, DAY_MS);
    pruneTimer.unref?.();
}

function reset() {
    pending.clear();
    cache = null;
}

module.exports = {
    recordResolve, clientStarted, clientFailed, clientEnded, sessionBlank, applyHealth, leastReliable, prune, startPruneTimer,
    classify, reasonCategory, reset,
    WINDOW_MS, KEEP_MS
};
