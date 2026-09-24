/**
 * Sport events (contract C-I).
 *
 * 0147: the EPG categories the provider's guide actually uses, counted, so the
 * admin can see what there is to recognise sport by (epg_programs.categories,
 * filled at ingest from XMLTV <category>).
 */
const { getDb } = require('../db/sqlite');

const CATEGORY_LIMIT = 200;
const CATEGORY_TTL_MS = 10 * 60 * 1000;
let categoryCache = null; // { key, builtAt, rows }

/** The live EPG generations, which change exactly when a sync lands a new guide. */
function epgGenerations(db = getDb()) {
    return db.prepare('SELECT source_id, active_gen FROM epg_state ORDER BY source_id').all()
        .map(r => `${r.source_id}:${r.active_gen}`).join(',');
}

/**
 * [{category, programmes}] over the live generation(s), most used first (then by
 * name), at most 200. Counting walks every programme, so the answer is kept until
 * a sync changes the guide (or 10 minutes pass).
 */
function categoryCounts({ now = Date.now() } = {}) {
    const db = getDb();
    const key = epgGenerations(db);
    if (categoryCache && categoryCache.key === key && now - categoryCache.builtAt < CATEGORY_TTL_MS
        && now >= categoryCache.builtAt) return categoryCache.rows;
    const rows = db.prepare(`
        SELECT j.value AS category, COUNT(*) AS programmes
        FROM epg_live e, json_each(e.categories) j
        WHERE e.categories IS NOT NULL
        GROUP BY j.value
        ORDER BY programmes DESC, category ASC
        LIMIT ?
    `).all(CATEGORY_LIMIT);
    categoryCache = { key, builtAt: now, rows };
    return rows;
}

function reset() { categoryCache = null; }

module.exports = { categoryCounts, epgGenerations, reset, CATEGORY_LIMIT };
