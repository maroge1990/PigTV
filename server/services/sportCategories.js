/**
 * Sport categories (0146, contract C-H).
 *
 * Mark picks which live categories count as sport; the Apple Home screen's
 * "Sport on now" row shows only channels from those. One row per marked
 * category in `sport_categories` (source_id + category_id), in a table of its
 * own that no sync writes to, so a playlist sync can't unmark anything (the
 * provider keeps its category ids across syncs; a category that disappears
 * just stops matching, and matches again if it comes back).
 */
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('./libraryRev');

let cache = null; // Set of "sourceId:categoryId"

function sportSet() {
    if (cache) return cache;
    cache = new Set(getDb().prepare('SELECT source_id, category_id FROM sport_categories').all()
        .map(r => `${r.source_id}:${r.category_id}`));
    return cache;
}

/** Is this category marked as sport? Never throws. */
function isSport(sourceId, categoryId) {
    try {
        return sportSet().has(`${sourceId}:${categoryId}`);
    } catch (e) {
        return false;
    }
}

/**
 * Mark or unmark a live category. Returns null when the source has no such
 * live category, else { sport, changed }. library_rev moves only on a change.
 */
function setSport(sourceId, categoryId, sport) {
    const db = getDb();
    const exists = db.prepare(`SELECT 1 FROM categories WHERE source_id = ? AND category_id = ? AND type = 'live'`)
        .get(sourceId, String(categoryId));
    if (!exists) return null;
    const info = sport
        ? db.prepare('INSERT OR IGNORE INTO sport_categories (source_id, category_id, updated_at) VALUES (?, ?, ?)')
            .run(sourceId, String(categoryId), Date.now())
        : db.prepare('DELETE FROM sport_categories WHERE source_id = ? AND category_id = ?').run(sourceId, String(categoryId));
    cache = null;
    const changed = info.changes > 0;
    if (changed) bumpLibraryRev();
    return { sport: !!sport, changed };
}

function reset() { cache = null; }

module.exports = { isSport, setSport, reset };
