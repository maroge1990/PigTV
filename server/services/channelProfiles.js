/**
 * Channel profiles (0114, roadmap S1.1): the resolve probe's analysis of a channel,
 * kept in SQLite so a repeat play can skip ffprobe.
 *
 * The probe is the first 3.3-4.7 s of a cold channel start (Mark's log, build 0109),
 * and it opens the provider's one connection just before ffmpeg needs it. A channel's
 * codecs, frame rate, timing class (dtsUneven) and HDR range (videoRange) rarely
 * change, so once a session has actually played from an analysis, that analysis is
 * reused for up to PIGTV_PROFILE_MAX_AGE_DAYS (7) days.
 *
 * What it does NOT change: ffmpeg's own -probesize/-analyzeduration. A channel with a
 * long GOP fails its join with a smaller probe (blueprint §3), so ffmpeg still reads
 * its usual 5 MB / 5 s; only the separate ffprobe run is skipped.
 *
 * Invalidation: a profile is written only after a session produced its playlist from
 * that analysis, and deleted when a session started from it fails to produce one - so
 * a feed that changed (a codec, its timing) is re-probed on its first failure, or at
 * the latest when the profile is a week old.
 *
 * Keyed exactly like the in-memory probeCache in playbackStrategy.resolve (URL + user
 * agent + the client's capability key), because the analysis depends on what the
 * client can decode. The key is stored hashed: the URL carries the provider
 * credentials, and nothing here needs to read it back.
 *
 * PIGTV_PROBE_PROFILES=0 turns it off (every play probes, as before 0114), without a
 * rebuild. Nothing in here may fail a play: a database error is logged and treated as
 * "no profile".
 */

const crypto = require('crypto');
const { getDb } = require('../db/sqlite');

const DAY_MS = 24 * 60 * 60 * 1000;

function enabled() {
    return !/^(0|false|no|off)$/i.test(process.env.PIGTV_PROBE_PROFILES || '');
}

function maxAgeMs() {
    const days = Number.parseFloat(process.env.PIGTV_PROFILE_MAX_AGE_DAYS);
    return (Number.isFinite(days) && days > 0 ? days : 7) * DAY_MS;
}

function hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * The stored analysis for `key` and how old it is, or null when there is none, it is
 * older than the limit, or profiles are off.
 * @returns {{info: object, probedAt: number, ageDays: number}|null}
 */
function get(key, now = Date.now()) {
    if (!enabled()) return null;
    try {
        const row = getDb().prepare('SELECT info, probed_at FROM channel_profiles WHERE key = ?').get(hashKey(key));
        if (!row) return null;
        if (now - row.probed_at >= maxAgeMs()) return null;
        return { info: JSON.parse(row.info), probedAt: row.probed_at, ageDays: Math.floor((now - row.probed_at) / DAY_MS) };
    } catch (err) {
        console.warn('[Profiles] Could not read a channel profile:', err.message);
        return null;
    }
}

/** A session played from this freshly probed analysis: keep it. */
function save(key, info, probedAt, now = Date.now()) {
    if (!enabled()) return;
    try {
        getDb().prepare(`
            INSERT INTO channel_profiles (key, info, probed_at, last_ok_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET info = excluded.info, probed_at = excluded.probed_at, last_ok_at = excluded.last_ok_at
        `).run(hashKey(key), JSON.stringify(info), probedAt, now);
    } catch (err) {
        console.warn('[Profiles] Could not save a channel profile:', err.message);
    }
}

/** A session played from this profile again. */
function markOk(key, now = Date.now()) {
    if (!enabled()) return;
    try {
        getDb().prepare('UPDATE channel_profiles SET last_ok_at = ? WHERE key = ?').run(now, hashKey(key));
    } catch (err) {
        console.warn('[Profiles] Could not update a channel profile:', err.message);
    }
}

/** A session started from this profile failed: probe afresh next time. */
function remove(key) {
    try {
        getDb().prepare('DELETE FROM channel_profiles WHERE key = ?').run(hashKey(key));
    } catch (err) {
        console.warn('[Profiles] Could not delete a channel profile:', err.message);
    }
}

module.exports = { enabled, maxAgeMs, get, save, markOk, remove, hashKey };
