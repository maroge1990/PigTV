/**
 * #57: programme search. An FTS5 index (`epg_search`: title, subtitle; rowid = epg_programs.id) over the active
 * guide generations' programmes that have not ended, rebuilt whole when a guide swap lands (syncService calls
 * scheduleRebuild) and built on the first search when it is missing or behind.
 *
 * A build writes `epg_search_next` in slices, yielding to the loop between them, then swaps it in with one rename,
 * so a search sees the old index or the new one, never half of one. What the index was built from is kept in
 * meta `epg_search_sig`: each source's active generation and its newest programme id (an index seek each), so a guide
 * written straight into the active generation (a test, an older database) is noticed too, while a sync's next
 * generation, still being written, is not.
 *
 * A query is its words, each a prefix ("doc wh" finds "Doctor Who"), all of them required. A query with no word in it
 * ("%%", "++") falls back to a LIKE on the title with % and _ escaped.
 */
const { getDb } = require('../db/sqlite');

const SLICE = 5000;
const SIG_KEY = 'epg_search_sig';
const AHEAD_MS = 8 * 24 * 3600 * 1000; // the LIKE fallback looks this far ahead
let building = null; // the running build's promise
const stats = { builds: 0, lastBuildMs: 0, lastRows: 0 };

const FTS_SQL = (name) => `CREATE VIRTUAL TABLE ${name} USING fts5(title, subtitle, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`;

/** What the index must have been built from to be current. */
function signature(db = getDb()) {
    const sources = [];
    let last = Number.MIN_SAFE_INTEGER;
    // Every source with programmes, by index seeks on idx_epg_source_gen (no scan of the guide).
    const next = db.prepare('SELECT source_id FROM epg_programs WHERE source_id > ? ORDER BY source_id LIMIT 1');
    for (;;) {
        const row = next.get(last);
        if (!row) break;
        sources.push(row.source_id);
        last = row.source_id;
    }
    const gen = db.prepare('SELECT active_gen FROM epg_state WHERE source_id = ?');
    const top = db.prepare('SELECT MAX(id) AS id FROM epg_programs WHERE source_id = ? AND gen = ?');
    return sources.map(s => {
        const g = gen.get(s)?.active_gen ?? 0;
        return `${s}:${g}:${top.get(s, g)?.id ?? 0}`;
    }).join(',');
}

function hasTable(db, name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'`).get(name);
}

function builtSig(db) {
    if (!hasTable(db, 'epg_search')) return null;
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(SIG_KEY)?.value ?? null;
}

function isCurrent(db = getDb()) {
    const built = builtSig(db);
    return built !== null && built === signature(db);
}

async function build() {
    const db = getDb();
    const t0 = Date.now();
    const sig = signature(db);
    const now = Date.now();
    db.exec('DROP TABLE IF EXISTS epg_search_next');
    db.exec(FTS_SQL('epg_search_next'));
    const read = db.prepare(`SELECT id, title, data FROM epg_live WHERE id > ? AND end_time > ? ORDER BY id LIMIT ?`);
    const insert = db.prepare('INSERT INTO epg_search_next (rowid, title, subtitle) VALUES (?, ?, ?)');
    let after = -1;
    let rows = 0;
    for (;;) {
        const slice = read.all(after, now, SLICE);
        if (!slice.length) break;
        db.transaction(() => {
            for (const r of slice) {
                let sub = null;
                if (r.data) { try { sub = JSON.parse(r.data).sub || null; } catch (e) { sub = null; } }
                insert.run(r.id, r.title || '', typeof sub === 'string' ? sub : null);
            }
        })();
        rows += slice.length;
        after = slice[slice.length - 1].id;
        if (slice.length < SLICE) break;
        await new Promise(resolve => setImmediate(resolve));
    }
    db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS epg_search');
        db.exec('ALTER TABLE epg_search_next RENAME TO epg_search');
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SIG_KEY, sig);
    })();
    stats.builds++;
    stats.lastBuildMs = Date.now() - t0;
    stats.lastRows = rows;
}

/** Rebuild now in the background (a guide swap landed). One build at a time; a build behind it runs once it ends. */
function scheduleRebuild() {
    const start = () => {
        building = build().catch(err => { console.warn('[Search] Building the programme index failed:', err.message); })
            .finally(() => { building = null; });
        return building;
    };
    return building ? building.then(() => (isCurrent() ? undefined : (building || start()))) : start();
}

/** Resolves once the index is current, building it when it is missing or behind (the first search after a start). */
async function ensureIndex() {
    for (let i = 0; i < 3; i++) {
        if (building) await building;
        if (isCurrent()) return true;
        if (!building) await scheduleRebuild();
    }
    return hasTable(getDb(), 'epg_search');
}

/** The query's words (letters and digits), at most 8. */
function words(q) {
    return (String(q).normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
}

/** `"word"*` for each word, all required. */
function ftsQuery(list) {
    return list.map(w => `"${w.replace(/"/g, '""')}"*`).join(' ');
}

/** A LIKE pattern for `text` anywhere, with % _ and \ taken literally (ESCAPE '\'). */
function likeAnywhere(text) {
    return `%${String(text).replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

/**
 * The epg_live rows ({ id, channel_id, source_id, title, start_time, end_time, flags, data }) matching `q` that have not
 * ended at `now`, soonest first, at most `max`. Builds the index first if it has to.
 */
async function search(q, { now = Date.now(), max = 200 } = {}) {
    const db = getDb();
    const list = words(q);
    if (!list.length) {
        return db.prepare(`SELECT id, channel_id, source_id, title, start_time, end_time, flags, data FROM epg_live
            WHERE end_time > ? AND start_time < ? AND title LIKE ? ESCAPE '\\'
            ORDER BY start_time ASC, id ASC LIMIT ?`).all(now, now + AHEAD_MS, likeAnywhere(String(q).trim()), max);
    }
    await ensureIndex();
    return db.prepare(`SELECT p.id, p.channel_id, p.source_id, p.title, p.start_time, p.end_time, p.flags, p.data
        FROM epg_search s JOIN epg_live p ON p.id = s.rowid
        WHERE epg_search MATCH ? AND p.end_time > ?
        ORDER BY p.start_time ASC, p.id ASC LIMIT ?`).all(ftsQuery(list), now, max);
}

module.exports = { search, scheduleRebuild, ensureIndex, isCurrent, signature, words, likeAnywhere, stats, _building: () => building };
