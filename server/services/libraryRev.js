/**
 * Library revision counter (0111, roadmap S1.3).
 *
 * GET /api/library/guide/version exists so a client (the Apple guide, built
 * for scale) can cheaply ask "has anything changed?" instead of re-fetching
 * or diffing the whole guide. It has to change whenever a guide row's
 * underlying data changes - a playlist or EPG sync completing, a hide/show of
 * a channel or category, a source edit, or a logo change - and must NOT
 * depend on the requested time window or the current time, or it would
 * change on every request and defeat the point.
 *
 * A persisted counter (`meta` table, key `library_rev`) is bumped at each of
 * those call sites. The version string also folds in the live EPG
 * generations (`epg_state.active_gen`) directly, rather than trusting the
 * counter alone for the EPG case: the generation flip is the one event that
 * always changes epg_state itself, so it can't be missed even if a bump call
 * site is ever forgotten.
 */
const { getDb } = require('../db/sqlite');

/**
 * 0894 (#361): the lineup revision. An in-process counter (no write) that moves with every committed change to what
 * decides the guide's visible set and order: playlist rows (visibility, category, sort order, name), categories'
 * visibility and sibling links. A sync commits its rows in batches and yields between them, and bumps library_rev only
 * once it has finished, so the guide's index (guideIndex.js) and kept answers (guideAnswers.js) key on this as well:
 * each batch, purge and hidden-channel pass bumps it straight after its transaction. Every library_rev bump moves it too.
 * Only the server process writes those tables (the sport workers open the database read-only).
 */
let lineupRev = 0;
function bumpLineupRev() { lineupRev++; }
function currentLineupRev() { return lineupRev; }

function bumpLibraryRev() {
    lineupRev++;
    const db = getDb();
    db.prepare(`
        INSERT INTO meta (key, value) VALUES ('library_rev', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    `).run();
}

function currentGuideVersion() {
    const db = getDb();
    const rev = db.prepare(`SELECT value FROM meta WHERE key = 'library_rev'`).get()?.value || '0';
    const gens = db.prepare(`SELECT source_id, active_gen FROM epg_state ORDER BY source_id`).all()
        .map(r => `${r.source_id}:${r.active_gen}`).join(',');
    // The build is part of the version (0140): a deploy can change how rows are
    // built or ordered (0139 did) without any data changing, and a client
    // holding a cached guide must reload it once rather than keep the old shape.
    const { build } = require('../version');
    return `${build}:${rev}:${gens}`;
}

module.exports = { bumpLibraryRev, currentGuideVersion, bumpLineupRev, currentLineupRev };
