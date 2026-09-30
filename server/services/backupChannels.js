/**
 * The channel store of a backup provider (0170, multi-provider brief 2.3).
 *
 * A backup is list-only: its channels live in `backup_channels`, never in
 * `playlist_items` or `categories`, so the library, guide, channel numbers,
 * sport and EPG matching cannot see them. `url_data` (an M3U backup's stream URL,
 * which contains the login) is read only by the resolver, through streamUrlData():
 * nothing here returns it to a route.
 */
const { getDb } = require('../db/sqlite');

/** The M3U entry's tvg-id, or null when the parser made one up from the name (parseExtinf). */
function realTvgId(entry) {
    const id = entry && entry.tvgId;
    if (!id) return null;
    const made = entry.name ? String(entry.name).toLowerCase().replace(/\s+/g, '_') : null;
    return id === made ? null : id;
}

/** The rows a source has, keyed by stream id -> overlay_tvg_id (for keeping the last overlay). */
function overlayOf(sourceId) {
    const map = new Map();
    const rows = getDb().prepare('SELECT stream_id, overlay_tvg_id FROM backup_channels WHERE source_id = ? AND overlay_tvg_id IS NOT NULL').all(sourceId);
    for (const r of rows) map.set(r.stream_id, r.overlay_tvg_id);
    return map;
}

/** Replace all of a source's rows in one transaction (a throw leaves the old rows). */
function replaceAll(sourceId, rows, overlay) {
    const db = getDb();
    const now = Date.now();
    const insert = db.prepare(`
        INSERT OR IGNORE INTO backup_channels
            (source_id, stream_id, name, category_id, category_name, tvg_id, overlay_tvg_id, logo, url_data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
        db.prepare('DELETE FROM backup_channels WHERE source_id = ?').run(sourceId);
        for (const r of rows) {
            insert.run(sourceId, r.streamId, r.name, r.categoryId, r.categoryName, r.tvgId,
                (overlay && overlay.get(r.streamId)) || null, r.logo, r.urlData, now);
        }
    })();
}

function removeFor(sourceId) {
    return getDb().prepare('DELETE FROM backup_channels WHERE source_id = ?').run(sourceId).changes;
}

function count(sourceId) {
    return getDb().prepare('SELECT COUNT(*) AS c FROM backup_channels WHERE source_id = ?').get(sourceId).c;
}

/** For the admin manual pick: never url_data. */
function search(sourceId, term, limit) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const q = String(term || '').trim();
    const cols = 'stream_id, name, category_name, tvg_id, overlay_tvg_id';
    if (!q) {
        return getDb().prepare(`SELECT ${cols} FROM backup_channels WHERE source_id = ? ORDER BY name COLLATE NOCASE, stream_id LIMIT ?`).all(sourceId, n);
    }
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    return getDb().prepare(`
        SELECT ${cols} FROM backup_channels
        WHERE source_id = @s AND (name LIKE @l ESCAPE '\\' OR category_name LIKE @l ESCAPE '\\'
            OR tvg_id LIKE @l ESCAPE '\\' OR overlay_tvg_id LIKE @l ESCAPE '\\' OR stream_id = @q)
        ORDER BY name COLLATE NOCASE, stream_id LIMIT @n
    `).all({ s: sourceId, l: like, q, n });
}

module.exports = { realTvgId, overlayOf, replaceAll, removeFor, count, search };
