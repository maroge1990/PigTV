// 0292: reconnect headroom learned per provider source + stable channel key. No URLs or names
// are identities. Only measured reading time counts; callers exclude disconnected/no-PCR time.
const { getDb } = require('../db/sqlite');
const tuning = { downMs: 3 * 60 * 60 * 1000, stepMs: 2000, marginSec: 4, saveMs: 60000 };
const CEILING_MS = 28000; // Apple live hold is 30 s
const baseOf = ms => Math.min(CEILING_MS, ms);

// One state per actively read provider/channel, even when different URLs open different ingests.
// Status reads do not retain it; the last reader releases it, keeping memory bounded by readers.
const active = new Map();
const pairKey = (channelKey, providerId) => JSON.stringify([String(channelKey), String(providerId)]);
function read(channelKey, providerId, defaultMs) {
    if (!channelKey || providerId == null) return null;
    const baseMs = baseOf(defaultMs);
    let row;
    try {
        row = getDb().prepare('SELECT limit_ms, clean_ms FROM feed_lag_limits WHERE channel_key = ? AND provider_id = ?')
            .get(String(channelKey), providerId);
    } catch { console.warn('[Feed lag] Reconnect limit could not be read; using the default'); }
    const limitMs = Math.max(baseMs, Math.min(CEILING_MS, row?.limit_ms ?? baseMs));
    return { channelKey: String(channelKey), providerId, baseMs, limitMs,
        cleanMs: row && row.limit_ms === limitMs ? row.clean_ms : 0, unsavedMs: 0 };
}

function open(channelKey, providerId, defaultMs) {
    if (!channelKey || providerId == null) return null;
    const key = pairKey(channelKey, providerId);
    let held = active.get(key);
    if (!held) {
        held = { state: read(channelKey, providerId, defaultMs), readers: 0 };
        active.set(key, held);
    }
    held.readers++;
    return held.state;
}

function current(channelKey, providerId, defaultMs) {
    if (!channelKey || providerId == null) return null;
    return active.get(pairKey(channelKey, providerId))?.state ?? read(channelKey, providerId, defaultMs);
}

function release(s) {
    if (!s) return;
    const key = pairKey(s.channelKey, s.providerId);
    const held = active.get(key);
    if (held?.state === s && --held.readers === 0) active.delete(key);
}

function flush(s) {
    if (!s) return;
    try {
        getDb().prepare(`INSERT INTO feed_lag_limits (channel_key, provider_id, limit_ms, clean_ms)
            VALUES (?, ?, ?, ?) ON CONFLICT(channel_key, provider_id) DO UPDATE SET
            limit_ms = excluded.limit_ms, clean_ms = excluded.clean_ms`)
            .run(s.channelKey, s.providerId, s.limitMs, s.cleanMs);
        s.unsavedMs = 0;
    } catch { console.warn('[Feed lag] Reconnect limit could not be saved'); }
}

function lag(s) {
    if (!s) return;
    s.limitMs = Math.min(CEILING_MS, s.limitMs + tuning.stepMs);
    s.cleanMs = 0;
    flush(s); // a reconnect/redeploy must not lose the new level
}

function observe(s, readingMs, worstBehindSec, now = null) {
    if (!s || !(readingMs >= 0) || !Number.isFinite(worstBehindSec)) return;
    if (now !== null) {
        // Two URLs of one stable identity may be read simultaneously. Count their interval union,
        // not reader-hours; still inspect every reader's worst lag even if its time overlaps.
        const from = now - readingMs;
        readingMs = Math.max(0, now - Math.max(from, s.observedAt ?? from));
        s.observedAt = Math.max(now, s.observedAt ?? now);
    }
    if (s.limitMs <= s.baseMs) return; // nothing to lower at the default
    s.unsavedMs += readingMs;
    if (worstBehindSec > s.limitMs / 1000 - tuning.marginSec) {
        // Persist a broken clean window immediately, even if a restart follows it.
        const hadClean = s.cleanMs > 0;
        s.cleanMs = 0;
        if (hadClean) flush(s);
    } else {
        s.cleanMs += readingMs;
        if (s.cleanMs >= tuning.downMs) {
            s.limitMs = Math.max(s.baseMs, s.limitMs - tuning.stepMs);
            s.cleanMs = 0; // each lower level must earn its own full window
            flush(s);
        }
    }
    if (s.unsavedMs >= tuning.saveMs) flush(s);
}

module.exports = { open, current, release, observe, lag, flush, tuning, baseOf };
