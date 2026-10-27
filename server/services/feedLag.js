/**
 * Feed lag (R7 data, 27 Oct): how far each channel's shared feed fell behind real time, kept so
 * R7's limits can later be set from what each channel and provider really does (FR-12). Before
 * this the only record was the ingest's close line in the container log, which a redeploy wipes.
 *
 * One row in `feed_lag` per shared ingest that read live for at least a minute, written when
 * it closes: the channel's name and the provider's (never a URL), how long it read, its worst lag
 * across every connection (feedPace resets on a reconnect), its reconnects and how many of those
 * were for lag. Rows are kept 30 days, pruned on each write. `summary` groups them per channel and
 * provider for the Status page, worst first.
 */
const { getDb } = require('../db/sqlite');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;
const tuning = { minLiveSec: 60 }; // a probe or a quick zap says nothing about a feed's pauses

function record({ channel = null, providerId = null, providerName = null, startedAt, endedAt = Date.now(), worstBehindSec, reconnects = 0, lagReconnects = 0, why = null }) {
    const liveSec = Math.round((endedAt - startedAt) / 1000);
    if (!(liveSec >= tuning.minLiveSec) || !Number.isFinite(worstBehindSec)) return false;
    const db = getDb();
    db.prepare('DELETE FROM feed_lag WHERE ended_at < ?').run(endedAt - KEEP_MS);
    db.prepare(`INSERT INTO feed_lag (channel, provider_id, provider_name, started_at, ended_at, live_sec, worst_behind_sec, reconnects, lag_reconnects, why)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(channel ? String(channel).slice(0, 120) : null, providerId ?? null, providerName ? String(providerName).slice(0, 60) : null,
            startedAt, endedAt, liveSec, Math.round(worstBehindSec * 10) / 10, reconnects, lagReconnects, why ? String(why).slice(0, 60) : null);
    return true;
}

/** Per channel and provider over `days`: reads, hours, worst lag, reconnects (all, and for lag), last seen. Worst first. */
function summary({ days = 30, limit = 20, now = Date.now() } = {}) {
    return getDb().prepare(`
        SELECT channel, provider_name AS provider, COUNT(*) AS reads, ROUND(SUM(live_sec) / 3600.0, 1) AS hours,
               MAX(worst_behind_sec) AS worstBehindSec, SUM(reconnects) AS reconnects, SUM(lag_reconnects) AS lagReconnects,
               MAX(ended_at) AS lastAt
        FROM feed_lag WHERE ended_at >= ?
        GROUP BY channel, provider_id ORDER BY worstBehindSec DESC LIMIT ?
    `).all(now - days * DAY_MS, limit);
}

module.exports = { record, summary, tuning, KEEP_MS };
