/**
 * #10 (0347): a hidden channel stays hidden when the provider reshuffles its playlist.
 *
 * `playlist_items.is_hidden` is what every reader filters on (the library, numbers, sport, Manage content), but an M3U
 * row's key is its line number (`pos_N`, stableIds.js), so a provider inserting a line moved every later flag onto
 * its neighbour: a shown channel bordering a hidden group disappeared, a channel hidden on its own "moved". The flag
 * now has a record that follows the channel: `hidden_channels` keeps each hidden channel by its identity within its
 * group, and a sync re-applies it to wherever the channel now sits. Every write that hides or shows refreshes the
 * record (`capture`); a source synced for the first time since this build is captured before its rows move.
 *
 * A channel's identity: its stable id (the provider's stream id or URL hash), else its own item id for a playlist
 * that keys rows on the provider's id (Xtream), else its name (M3U placeholder lines, which have no URL). It is
 * paired with the group, because a channel cross-listed in two groups is one identity with two rows, and hiding it
 * in one group must not hide it in the other. A record whose group has no channels left (renamed: an M3U group is its
 * name, and old group rows are never deleted) matches the channel anywhere.
 *
 * New groups: after a source's first sync, a group the provider adds arrives hidden and is listed for review
 * (`new_channel_groups`, "New on the provider", D-37), unless one of its channels was shown before the sync (a
 * renamed group keeps its channels on screen).
 */
const { getDb } = require('../db/sqlite');

const IDENTITY = `CASE WHEN p.stable_id IS NOT NULL AND p.stable_id <> '' THEN 's:' || p.stable_id
    WHEN p.item_id LIKE 'pos\\_%' ESCAPE '\\' THEN 'n:' || p.name ELSE 'i:' || p.item_id END`;

function ensure(db = getDb()) {
    db.exec(`CREATE TABLE IF NOT EXISTS hidden_channels (
        source_id INTEGER NOT NULL, category_id TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY (source_id, category_id, identity));
    CREATE INDEX IF NOT EXISTS idx_hidden_channels_identity ON hidden_channels(source_id, identity);
    CREATE TABLE IF NOT EXISTS new_channel_groups (
        source_id INTEGER NOT NULL, category_id TEXT NOT NULL, name TEXT, channels INTEGER NOT NULL DEFAULT 0,
        found_at INTEGER NOT NULL, PRIMARY KEY (source_id, category_id))`);
}

const markerKey = (sourceId) => `hidden_channels_captured:${sourceId}`;

/**
 * A source's live rows with the key the record uses: the identity, and for the second and later copy of one channel
 * listed again in the same group its place among those copies ("#1", "#2"), so hiding one copy keeps the other shown
 * (production lists some NBA League Pass channels twice; rehearsal, 30 Oct).
 */
function keyedRows(db, sourceId) {
    const rows = db.prepare(`SELECT p.id, p.category_id, p.is_hidden, ${IDENTITY} AS identity FROM playlist_items p
        WHERE p.source_id = ? AND p.type = 'live' ORDER BY p.sort_order, p.id`).all(sourceId);
    const seen = new Map();
    for (const r of rows) {
        const k = `${r.category_id}\u0000${r.identity}`;
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        r.key = n ? `${r.identity}#${n}` : r.identity;
    }
    return rows;
}

/** Record a source's hidden live channels as they sit now. Run after every write that hides or shows. */
function capture(db, sourceId) {
    ensure(db);
    db.transaction(() => {
        db.prepare('DELETE FROM hidden_channels WHERE source_id = ?').run(sourceId);
        const insert = db.prepare('INSERT OR IGNORE INTO hidden_channels (source_id, category_id, identity) VALUES (?, ?, ?)');
        for (const r of keyedRows(db, sourceId)) if (r.is_hidden) insert.run(sourceId, r.category_id, r.key);
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(markerKey(sourceId), String(Date.now()));
    })();
}

/** `capture` for every source named in `sourceIds` (strings or numbers), ignoring anything that is not an id. */
function captureAll(db, sourceIds) {
    for (const id of new Set([...sourceIds].map(Number).filter(Number.isInteger))) capture(db, id);
}

/**
 * Before a playlist sync writes rows: capture once if this source never was (the migration from positional flags),
 * and note the groups that exist and the channels that are shown, for `after`.
 */
function before(db, sourceId) {
    ensure(db);
    if (!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(markerKey(sourceId))) capture(db, sourceId);
    const groups = new Set(db.prepare(`SELECT category_id FROM categories WHERE source_id = ? AND type = 'live'`)
        .all(sourceId).map(r => r.category_id));
    const shown = new Set(db.prepare(`SELECT ${IDENTITY} AS identity FROM playlist_items p
        JOIN categories c ON c.source_id = p.source_id AND c.type = p.type AND c.category_id = p.category_id
        WHERE p.source_id = ? AND p.type = 'live' AND p.is_hidden = 0 AND c.is_hidden = 0`).all(sourceId).map(r => r.identity));
    return { groups, shown };
}

/**
 * After the rows and groups are written: every row's flag from the record, then new groups hidden and listed.
 * Returns the new groups listed for review.
 */
function after(db, sourceId, state) {
    ensure(db);
    const now = Date.now();
    return db.transaction(() => {
        // Worked out here, not in one correlated UPDATE: on a 19,000-row playlist that took 22 s (rehearsal on a
        // copy of production, 30 Oct). Only rows whose flag changes are written.
        const record = new Map();
        for (const h of db.prepare('SELECT category_id, identity FROM hidden_channels WHERE source_id = ?').all(sourceId)) {
            if (!record.has(h.identity)) record.set(h.identity, new Set());
            record.get(h.identity).add(h.category_id);
        }
        const rows = keyedRows(db, sourceId);
        const occupied = new Set(rows.map(r => r.category_id));
        const setFlag = db.prepare('UPDATE playlist_items SET is_hidden = ? WHERE id = ?');
        for (const r of rows) {
            const groups = record.get(r.key);
            const hidden = groups ? (groups.has(r.category_id) || [...groups].some(g => !occupied.has(g))) : false;
            if (Number(hidden) !== r.is_hidden) setFlag.run(hidden ? 1 : 0, r.id);
        }
        const listed = [];
        // The first sync of a source shows everything, as before: there is nothing yet to keep tidy.
        if (!state || state.groups.size === 0) return listed;
        const groups = db.prepare(`SELECT category_id, name FROM categories WHERE source_id = ? AND type = 'live'`).all(sourceId);
        const members = db.prepare(`SELECT ${IDENTITY} AS identity FROM playlist_items p
            WHERE p.source_id = ? AND p.type = 'live' AND p.category_id = ?`);
        const hideGroup = db.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = 'live' AND category_id = ?`);
        const hideRows = db.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = 'live' AND category_id = ?`);
        const list = db.prepare(`INSERT INTO new_channel_groups (source_id, category_id, name, channels, found_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, category_id) DO UPDATE SET name = excluded.name, channels = excluded.channels`);
        for (const g of groups) {
            if (state.groups.has(g.category_id)) continue;
            const ids = members.all(sourceId, g.category_id).map(r => r.identity);
            if (ids.some(id => state.shown.has(id))) continue; // a renamed group: its channels stay on screen
            hideGroup.run(sourceId, g.category_id);
            hideRows.run(sourceId, g.category_id);
            list.run(sourceId, g.category_id, g.name, ids.length, now);
            listed.push({ categoryId: g.category_id, name: g.name, channels: ids.length });
        }
        if (listed.length) capture(db, sourceId);
        return listed;
    })();
}

/** The groups waiting for review, newest first, with how many channels each has now. */
function newGroups(db, sourceId) {
    ensure(db);
    const where = sourceId === undefined ? '' : 'WHERE n.source_id = ?';
    return db.prepare(`SELECT n.source_id AS sourceId, n.category_id AS categoryId, n.name, n.found_at AS foundAt,
            (SELECT COUNT(*) FROM playlist_items p WHERE p.source_id = n.source_id AND p.type = 'live'
               AND p.category_id = n.category_id) AS channels
        FROM new_channel_groups n
        JOIN categories c ON c.source_id = n.source_id AND c.type = 'live' AND c.category_id = n.category_id
        ${where} ORDER BY n.found_at DESC, n.name`).all(...(sourceId === undefined ? [] : [sourceId]));
}

/** Take groups off the review list (shown, or kept hidden on purpose). No ids: the source's whole list. */
function dismiss(db, sourceId, categoryIds) {
    ensure(db);
    if (!categoryIds) return db.prepare('DELETE FROM new_channel_groups WHERE source_id = ?').run(sourceId).changes;
    const stmt = db.prepare('DELETE FROM new_channel_groups WHERE source_id = ? AND category_id = ?');
    return db.transaction(() => categoryIds.reduce((n, id) => n + stmt.run(sourceId, String(id)).changes, 0))();
}

module.exports = { ensure, capture, captureAll, before, after, newGroups, dismiss };
