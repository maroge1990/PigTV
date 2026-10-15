/**
 * R8 (Plan B, pilot, 0217): live groups a provider's sync never imports. Mark selects about
 * 1,000 of the playlist's ~18,000 channels; hiding keeps the rest in the database, the linker's
 * search space and every sync's writes. A group listed here is skipped at the next sync instead:
 * its channels are not written, and the ones already there are purged as stale, exactly as if
 * the provider had dropped them.
 *
 * Reversible: the group itself (its `categories` row) is still saved, so it stays in the
 * catalogue and can be taken off the list; the next sync imports it again with the same
 * identities (stable ids come from the provider's own ids, and M3U positions are counted over
 * every line, skipped ones included, so nothing else moves).
 *
 * Guarded: a group holding a favourite, or the channel of a scheduled or running recording,
 * can't be excluded (it would lose its row). Setting `importExclusions`:
 * { "<sourceId>": ["<categoryId>", ...] }. Each sync records how many rows each excluded group
 * skipped (import_exclusion_stats), so the effect can be measured before anything is promised.
 */
const { getDb } = require('../db/sqlite');

function ensureTable(db = getDb()) {
    db.exec(`CREATE TABLE IF NOT EXISTS import_exclusion_stats (
        source_id INTEGER NOT NULL, category_id TEXT NOT NULL, skipped INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (source_id, category_id))`);
}

async function settingsNow() {
    try { return await require('../db').settings.get(); } catch { return {}; }
}

/** The excluded live category ids of a source, as a Set (empty when none). */
async function excludedFor(sourceId) {
    const all = (await settingsNow()).importExclusions || {};
    const list = all[String(sourceId)];
    return new Set(Array.isArray(list) ? list.map(String) : []);
}

/**
 * Filter one batch of live items ({ category_id, ... }); `tally` (Map category -> count) is
 * added to. Returns the items to import. Positions and ids are the caller's, untouched.
 */
function filterItems(items, excluded, tally) {
    if (!excluded || excluded.size === 0) return items;
    const kept = [];
    for (const it of items) {
        const cat = it && it.category_id != null ? String(it.category_id) : null;
        if (cat !== null && excluded.has(cat)) {
            if (tally) tally.set(cat, (tally.get(cat) || 0) + 1);
        } else {
            kept.push(it);
        }
    }
    return kept;
}

/** After a sync: what each excluded group skipped (0 for a listed group the playlist no longer has). */
function recordSkipped(sourceId, excluded, tally, now = Date.now()) {
    if (!excluded || excluded.size === 0) return;
    const db = getDb();
    ensureTable(db);
    const put = db.prepare(`INSERT OR REPLACE INTO import_exclusion_stats (source_id, category_id, skipped, at) VALUES (?, ?, ?, ?)`);
    db.transaction(() => {
        db.prepare('DELETE FROM import_exclusion_stats WHERE source_id = ?').run(sourceId);
        for (const cat of excluded) put.run(sourceId, cat, tally.get(cat) || 0, now);
    })();
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    console.log(`[Sync] Source ${sourceId}: ${total} live channels in ${excluded.size} excluded group(s) not imported`);
}

/**
 * Categories of `categoryIds` that may not be excluded, with why: [{ id, reason }]. A favourite
 * (by stable identity or id) or a scheduled/waiting/recording schedule's channel in the group.
 */
function blockers(sourceId, categoryIds) {
    const db = getDb();
    const out = [];
    for (const id of categoryIds.map(String)) {
        const fav = db.prepare(`
            SELECT 1 FROM playlist_items p JOIN favorites f ON f.source_id = p.source_id AND f.item_type = 'channel'
              AND (f.item_id = p.item_id OR (p.stable_id IS NOT NULL AND f.stable_id = p.stable_id))
            WHERE p.source_id = ? AND p.type = 'live' AND p.category_id = ? LIMIT 1
        `).get(sourceId, id);
        if (fav) { out.push({ id, reason: 'it has a favourite channel' }); continue; }
        let sched = null;
        try {
            sched = db.prepare(`
                SELECT 1 FROM scheduled_recordings s JOIN playlist_items p ON p.source_id = s.source_id
                  AND (p.item_id = s.channel_item_id OR (s.channel_stable_id IS NOT NULL AND p.stable_id = s.channel_stable_id))
                WHERE s.source_id = ? AND s.status IN ('scheduled', 'waiting', 'recording') AND p.category_id = ? LIMIT 1
            `).get(sourceId, id);
        } catch { sched = null; } // no recordings table yet
        if (sched) out.push({ id, reason: 'a recording is scheduled on one of its channels' });
    }
    return out;
}

/** For the settings UI: every live group of a source with its size and exclusion state. */
async function overview(sourceId) {
    const db = getDb();
    ensureTable(db);
    const excluded = await excludedFor(sourceId);
    const stats = new Map(db.prepare('SELECT category_id, skipped, at FROM import_exclusion_stats WHERE source_id = ?')
        .all(sourceId).map(r => [String(r.category_id), r]));
    return db.prepare(`
        SELECT c.category_id AS id, c.name,
               (SELECT COUNT(*) FROM playlist_items p WHERE p.source_id = c.source_id AND p.type = 'live' AND p.category_id = c.category_id) AS imported
        FROM categories c WHERE c.source_id = ? AND c.type = 'live'
        ORDER BY CASE WHEN c.sort_order IS NULL THEN 1 ELSE 0 END, c.sort_order ASC, c.name ASC
    `).all(sourceId).map(c => ({
        id: String(c.id), name: c.name, imported: c.imported,
        excluded: excluded.has(String(c.id)),
        skippedAtLastSync: stats.get(String(c.id))?.skipped ?? null
    }));
}

/** Save a source's list after the guard. Resolves { ok, blocked? }. Takes effect at the next sync. */
async function setExcluded(sourceId, categoryIds) {
    const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map(String))].slice(0, 5000);
    const current = await excludedFor(sourceId);
    const added = ids.filter(id => !current.has(id));
    const blocked = blockers(sourceId, added);
    if (blocked.length) return { ok: false, blocked };
    const { settings } = require('../db');
    const all = { ...((await settingsNow()).importExclusions || {}) };
    if (ids.length) all[String(sourceId)] = ids; else delete all[String(sourceId)];
    await settings.update({ importExclusions: all });
    return { ok: true };
}

module.exports = { excludedFor, filterItems, recordSkipped, blockers, overview, setExcluded, ensureTable };
