/**
 * Channel numbers (0117, roadmap X2.1, docs/ROADMAP-CONTRACTS.md C-A).
 *
 * Every visible live channel has a number: a positive integer, unique across
 * the server, persisted in `channel_numbers` and keyed by the channel's
 * identity (source + stable_id, else item_id), never by its position, so the
 * provider reordering its playlist does not renumber anything.
 *
 *   - The first assignment follows the current guide order (1, 2, 3...).
 *   - A channel that appears later gets the next free number: one past the
 *     highest number held (reserved numbers included), so a new channel never
 *     takes a number a viewer may still remember for another channel.
 *   - A channel that stops being visible (gone from the playlist, or hidden)
 *     keeps its number for RESERVE_MS; if it comes back in that time it gets
 *     the same number, and after it the number is released.
 *   - The admin can renumber (PUT /api/lineup/numbers, routes/lineup.js).
 *
 * Assignment runs when a sync completes, after a hide/show, and lazily on the
 * first library request when the table is still empty (an upgraded server
 * whose sources are fresh does not sync on startup).

 */
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('./libraryRev');

const RESERVE_MS = 30 * 24 * 60 * 60 * 1000;

// Sorts a channel with no number after every numbered one.
const NUMBER_SENTINEL = 999999999;

// The identity a number is keyed on - the favourites' identity rule.
const CHANNEL_KEY_SQL = 'COALESCE(p.stable_id, p.item_id)';

// LEFT JOIN that gives a playlist_items row `p` its number as `n.number`.
const NUMBER_JOIN = `LEFT JOIN channel_numbers n
    ON n.source_id = p.source_id AND n.channel_key = ${CHANNEL_KEY_SQL}`;

// A provider's own "(Backup)" feed that is linked to the channel it backs up (a *sibling*,
// channelLinks.js): failover plays it when the main one fails, so listing it as well only
// doubles the channel - and channel warming would warm the backup instead of the next
// channel. One without a usable link stays visible (it is the only way to reach it).
const LINKED_SIBLING_SQL = `EXISTS (
    SELECT 1 FROM channel_links l
    WHERE l.backup_source_id = p.source_id AND l.primary_source_id = p.source_id
      AND l.backup_stream_id = ${CHANNEL_KEY_SQL} AND l.method = 'sibling'
      AND l.status IN ('auto', 'approved', 'manual')
)`;

// A visible live channel: not hidden itself, nor in a hidden category, nor a linked sibling.
const VISIBLE_SQL = `p.type = 'live' AND p.is_hidden = 0 AND NOT EXISTS (
    SELECT 1 FROM categories c
    WHERE c.source_id = p.source_id AND c.type = p.type
      AND c.category_id = p.category_id AND c.is_hidden = 1
) AND NOT ${LINKED_SIBLING_SQL}`;

// The guide's order before numbers (library.js GUIDE_ORDER_BY).
const GUIDE_ORDER_SQL = 'ORDER BY COALESCE(p.sort_order, 999999999) ASC, p.name ASC, p.id ASC';

/**
 * Bring the table up to date with what is visible now. Returns counts; bumps
 * library_rev when a number was given out or released.
 */
function assignChannelNumbers({ now = Date.now() } = {}) {
    const db = getDb();
    const run = db.transaction(() => {
        const visible = db.prepare(`
            SELECT p.source_id, p.item_id, ${CHANNEL_KEY_SQL} AS channel_key
            FROM playlist_items p
            WHERE ${VISIBLE_SQL}
            ${GUIDE_ORDER_SQL}
        `).all();
        const existing = new Set(db.prepare('SELECT source_id, channel_key FROM channel_numbers').all()
            .map(r => `${r.source_id}\u0000${r.channel_key}`));
        let max = db.prepare('SELECT MAX(number) AS m FROM channel_numbers').get().m || 0;

        const touch = db.prepare('UPDATE channel_numbers SET last_seen = ? WHERE source_id = ? AND channel_key = ?');
        const insert = db.prepare(`
            INSERT INTO channel_numbers (source_id, channel_key, item_id, number, last_seen) VALUES (?, ?, ?, ?, ?)
        `);

        const seen = new Set();
        let assigned = 0;
        for (const r of visible) {
            const k = `${r.source_id}\u0000${r.channel_key}`;
            if (seen.has(k)) continue; // cross-listed: one channel, one number
            seen.add(k);
            if (existing.has(k)) {
                touch.run(now, r.source_id, r.channel_key);
            } else {
                insert.run(r.source_id, r.channel_key, r.item_id, ++max, now);
                assigned++;
            }
        }
        const released = db.prepare('DELETE FROM channel_numbers WHERE last_seen < ?').run(now - RESERVE_MS).changes;
        return { visible: seen.size, assigned, released };
    });
    const result = run();
    if (result.assigned || result.released) bumpLibraryRev();
    return result;
}

/** Assign once if nothing has been numbered yet (the lazy path). Never throws. */
function ensureChannelNumbers() {
    try {
        const db = getDb();
        if (db.prepare('SELECT 1 FROM channel_numbers LIMIT 1').get()) return;
        assignChannelNumbers();
    } catch (err) {
        console.error('[ChannelNumbers] Lazy assignment failed:', err.message);
    }
}

/** For call sites where numbering is a side effect that must not fail the request. */
function refreshChannelNumbers() {
    try {
        return assignChannelNumbers();
    } catch (err) {
        console.error('[ChannelNumbers] Assignment failed:', err.message);
        return null;
    }
}

module.exports = {
    RESERVE_MS,
    NUMBER_SENTINEL,
    CHANNEL_KEY_SQL,
    NUMBER_JOIN,
    VISIBLE_SQL,
    LINKED_SIBLING_SQL,
    assignChannelNumbers,
    ensureChannelNumbers,
    refreshChannelNumbers
};
