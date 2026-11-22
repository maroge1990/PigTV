/**
 * The guide's visible-channel index (#361, 0888).
 *
 * GET /api/library/guide used to filter and sort every visible playlist row twice on every page: once to COUNT them
 * for `total`, once to find the page (ORDER BY ... LIMIT, by OFFSET or a keyset cursor). The visible set and its order
 * only change when the guide version changes (services/libraryRev.js: a sync, a hide or show, a link, a mapping, numbers,
 * a health flip), so this keeps that order in memory - id, sort key, name, category - built once per guide version and
 * database handle. `total` and each page's ids come from it; the route then loads just the page's rows by id.
 *
 * The order is SQLite's own (the index is read with the guide's ORDER BY), and a cursor is placed in it with a
 * comparison that matches SQLite's row-value compare for the types the index holds (numbers for the sort key, BINARY
 * text for name and id, which is UTF-8 byte order). An index holding anything else is marked not `comparable`, and the
 * route pages by cursor in SQL as before.
 */
const { getDb } = require('../db/sqlite');
const { currentGuideVersion } = require('./libraryRev');
const { VISIBLE_SQL } = require('./channelNumbers');

// The guide's total order (library.js): NULL sort_order (Xtream, unordered) after every M3U position, then name, then
// id, so the order is total and keyset paging lines up exactly with OFFSET paging.
const SORT_SENTINEL = 999999999;
const GUIDE_SORT_KEY = `COALESCE(p.sort_order, ${SORT_SENTINEL})`;
const GUIDE_ORDER_BY = `ORDER BY ${GUIDE_SORT_KEY} ASC, p.name ASC, p.id ASC`;

// One category's slice is kept per category asked for, up to this many (a client cannot grow it without bound).
const CATEGORY_SLICES = 200;

let cache = null;

/** The index for the current guide version: { version, rows: [{ id, name, category, sk }], comparable, total(cat), slice(cat) }. */
function current() {
    const db = getDb();
    // No version, no index (a sandbox without package.json cannot name the build): the route pages in SQL.
    let version;
    try { version = currentGuideVersion(); } catch { return null; }
    if (cache && cache.db === db && cache.version === version) return cache;
    const rows = db.prepare(`
        SELECT p.id, p.name, p.category_id AS category, ${GUIDE_SORT_KEY} AS sk
        FROM playlist_items p
        WHERE ${VISIBLE_SQL}
        ${GUIDE_ORDER_BY}
    `).all();
    const comparable = rows.every(r => typeof r.sk === 'number' && typeof r.name === 'string' && typeof r.id === 'string');
    cache = { db, version, rows, comparable, byCategory: new Map() };
    return cache;
}

/** The index's rows in one category (or all of them for none), in guide order. */
function rowsFor(index, category) {
    if (!category) return index.rows;
    let rows = index.byCategory.get(category);
    if (!rows) {
        rows = index.rows.filter(r => r.category === category);
        if (index.byCategory.size < CATEGORY_SLICES) index.byCategory.set(category, rows);
    }
    return rows;
}

const utf8 = (s) => Buffer.from(s, 'utf8');
/** SQLite's BINARY collation: memcmp of the UTF-8 bytes, the shorter first on a common prefix. */
function compareBinary(a, b) {
    if (a === b) return 0;
    return Buffer.compare(utf8(a), utf8(b));
}
/** (sk, name, id) compared as SQLite compares the guide's row values. */
function compareKey(row, key) {
    if (row.sk !== key.sk) return row.sk < key.sk ? -1 : 1;
    return compareBinary(row.name, key.name) || compareBinary(row.id, key.id);
}

/** The position of the first row after a cursor's key (`(sk, name, id) > key`), by binary search. */
function firstAfter(rows, key) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareKey(rows[mid], key) > 0) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/**
 * One page of the guide's order: { total, ids } with up to `take` ids, after `cursorKey` (keyset) or from `offset`.
 * Returns null when this index cannot answer it exactly (no guide version, or a cursor against an index that is not
 * `comparable`).
 */
function page({ category, cursorKey, offset, take }) {
    const index = current();
    if (!index || (cursorKey && !index.comparable)) return null;
    const rows = rowsFor(index, category);
    const from = cursorKey ? firstAfter(rows, cursorKey) : offset;
    return { total: rows.length, ids: rows.slice(from, from + take).map(r => r.id) };
}

/** Drop the index (the route found it out of step with the table): the next page builds it again. */
function invalidate() { cache = null; }

module.exports = { SORT_SENTINEL, GUIDE_SORT_KEY, GUIDE_ORDER_BY, page, invalidate, compareKey };
