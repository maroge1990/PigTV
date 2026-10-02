/**
 * Mid-play interruptions (0188): the baseline for any change to how a stream recovers.
 *
 * channelHealth counts starts that failed and the stalls a client reports; nothing counted
 * the thing a viewer notices most: a stream that was playing and was lost (ffmpeg exited,
 * or the stall watchdog released it), and how long it took to come back. One row per loss
 * in `playback_interruptions`:
 *
 *   noteLost      a session that had played ended unasked (transcodeSession 'lost')
 *   noteResolved  the same viewer's next successful resolve of the same channel within
 *                 RECOVER_WINDOW_MS closes the row: `recovered_at`, and which provider it
 *                 came back on. A loss nobody came back from stays open ("not recovered":
 *                 the viewer gave up, or switched channel).
 *
 * `summary()` is the last 7 days: losses, how many recovered, the median and worst time to
 * recover, and losses per hour watched (the hours from channelHealth's play-end rows).
 * Rows are kept 30 days. Names only: never a URL or a login.
 */
const { getDb } = require('../db/sqlite');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;
const KEEP_MS = 30 * DAY_MS;
const RECOVER_WINDOW_MS = 3 * 60 * 1000;

let ready = false;
function table() {
    const db = getDb();
    if (!ready) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS playback_interruptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at INTEGER NOT NULL,
                owner TEXT,
                channel TEXT,
                provider TEXT,
                how TEXT NOT NULL,            -- 'stall' | 'exit'
                provider_reason INTEGER NOT NULL DEFAULT 0,
                played_sec REAL,              -- how long the session had been up
                recovered_at INTEGER,
                recovered_provider TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_playback_interruptions_at ON playback_interruptions(at);
        `);
        ready = true;
    }
    return db;
}

const text = (v, max) => (v === null || v === undefined ? null : String(v).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url removed]').slice(0, max));

/** A playing session was lost. Never throws: this is observation only. */
function noteLost({ owner = null, channel = null, provider = null, how = 'exit', providerReason = false, playedSec = null } = {}, now = Date.now()) {
    try {
        const db = table();
        db.prepare('DELETE FROM playback_interruptions WHERE at < ?').run(now - KEEP_MS);
        db.prepare(`INSERT INTO playback_interruptions (at, owner, channel, provider, how, provider_reason, played_sec)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(now, text(owner, 60), text(channel, 120), text(provider, 60), how === 'stall' ? 'stall' : 'exit',
                providerReason ? 1 : 0, Number.isFinite(playedSec) ? playedSec : null);
    } catch (err) {
        console.warn('[Interruptions] could not record a lost stream:', err.message);
    }
}

/** A resolve succeeded: it closes this viewer's open loss of the same channel, if it is recent. */
function noteResolved({ owner = null, channel = null, provider = null } = {}, now = Date.now()) {
    if (!owner || !channel) return;
    try {
        const db = table();
        const row = db.prepare(`SELECT id FROM playback_interruptions
                                WHERE owner = ? AND channel = ? AND recovered_at IS NULL AND at >= ?
                                ORDER BY at DESC LIMIT 1`).get(text(owner, 60), text(channel, 120), now - RECOVER_WINDOW_MS);
        if (row) db.prepare('UPDATE playback_interruptions SET recovered_at = ?, recovered_provider = ? WHERE id = ?').run(now, text(provider, 60), row.id);
    } catch (err) {
        console.warn('[Interruptions] could not record a recovery:', err.message);
    }
}

const median = (list) => {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The last 7 days, for the Status page. */
function summary(now = Date.now()) {
    const db = table();
    const rows = db.prepare(`SELECT at, channel, provider, how, provider_reason, played_sec, recovered_at, recovered_provider
                             FROM playback_interruptions WHERE at >= ? ORDER BY at DESC`).all(now - WINDOW_MS);
    const recoverSecs = rows.filter(r => r.recovered_at).map(r => (r.recovered_at - r.at) / 1000);
    let watchedSec = 0;
    try {
        watchedSec = db.prepare('SELECT COALESCE(SUM(watched_sec), 0) AS s FROM channel_health WHERE at >= ?').get(now - WINDOW_MS).s || 0;
    } catch (err) { /* no health rows yet */ }
    const hours = watchedSec / 3600;
    return {
        days: 7,
        count: rows.length,
        recovered: recoverSecs.length,
        medianRecoverSec: median(recoverSecs),
        worstRecoverSec: recoverSecs.length ? Math.max(...recoverSecs) : null,
        watchedHours: Math.round(hours * 10) / 10,
        // With under an hour watched a rate means nothing.
        perHour: hours >= 1 ? Math.round((rows.length / hours) * 100) / 100 : null,
        recent: rows.slice(0, 15).map(r => ({
            at: r.at, channel: r.channel, provider: r.provider, how: r.how, providerReason: r.provider_reason === 1,
            playedSec: r.played_sec,
            recoverSec: r.recovered_at ? Math.round((r.recovered_at - r.at) / 100) / 10 : null,
            recoveredProvider: r.recovered_provider
        }))
    };
}

function reset() {
    try { table().prepare('DELETE FROM playback_interruptions').run(); } catch (err) { /* nothing to clear */ }
}

module.exports = { noteLost, noteResolved, summary, reset, RECOVER_WINDOW_MS };
