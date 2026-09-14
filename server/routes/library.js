/**
 * Library API
 *
 * One shape for browsing channels, whatever the client. The existing
 * /api/proxy/xtream/* endpoints exist to emulate an Xtream provider, which is
 * a sensible internal detail and a poor thing to ask a TV app to speak. These
 * return what a client actually needs to draw a screen: a channel, where it
 * sits, and what is on it now.
 *
 * Paginated throughout, because 18,000 channels cannot be handed over in one
 * response to a device with a fraction of a desktop's memory.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getDb } = require('../db/sqlite');

router.use(requireAuth);

const clamp = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

/**
 * Current and next programme for a set of tvg-ids, in one query rather than
 * one per channel.
 */
function nowNextFor(tvgIds) {
    if (!tvgIds.length) return {};
    const db = getDb();
    const now = Date.now();
    const placeholders = tvgIds.map(() => '?').join(',');

    const rows = db.prepare(`
        SELECT channel_id, title, start_time, end_time
        FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND end_time > ? AND start_time < ?
        ORDER BY channel_id ASC, start_time ASC
    `).all(...tvgIds, now, now + 6 * 60 * 60 * 1000);

    const out = {};
    for (const r of rows) {
        const bucket = out[r.channel_id] || (out[r.channel_id] = { now: null, next: null });
        if (r.start_time <= now && r.end_time > now) {
            if (!bucket.now) {
                const span = r.end_time - r.start_time;
                bucket.now = {
                    title: r.title,
                    startTime: r.start_time,
                    endTime: r.end_time,
                    progress: span > 0 ? Math.min(1, Math.max(0, (now - r.start_time) / span)) : 0
                };
            }
        } else if (r.start_time > now && !bucket.next) {
            bucket.next = { title: r.title, startTime: r.start_time, endTime: r.end_time };
        }
    }
    return out;
}

function decorate(items) {
    const tvgIds = [];
    const parsed = items.map(row => {
        let data = {};
        try { data = JSON.parse(row.data || '{}'); } catch (e) { /* ignore */ }
        const tvgId = data.tvgId || data.epg_channel_id || null;
        if (tvgId) tvgIds.push(tvgId);
        return {
            id: row.item_id,
            sourceId: row.source_id,
            name: row.name,
            logo: row.stream_icon || null,
            category: row.category_id,
            tvgId,
            order: row.sort_order
        };
    });

    const guide = nowNextFor([...new Set(tvgIds)]);
    for (const ch of parsed) {
        const g = ch.tvgId ? guide[ch.tvgId] : null;
        ch.now = g?.now || null;
        ch.next = g?.next || null;
    }
    return parsed;
}

/**
 * GET /api/library/categories
 * Visible categories in the provider's own order, with channel counts.
 */
router.get('/categories', (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT c.source_id, c.category_id, c.name,
                   (SELECT COUNT(*) FROM playlist_items p
                     WHERE p.source_id = c.source_id AND p.type = 'live'
                       AND p.category_id = c.category_id AND p.is_hidden = 0) AS channel_count
            FROM categories c
            WHERE c.type = 'live' AND c.is_hidden = 0
            ORDER BY CASE WHEN c.sort_order IS NULL THEN 1 ELSE 0 END, c.sort_order ASC, c.name ASC
        `).all();

        res.json(rows
            .filter(r => r.channel_count > 0)
            .map(r => ({
                id: r.category_id,
                sourceId: r.source_id,
                name: r.name,
                channelCount: r.channel_count
            })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/library/channels?category=&search=&limit=&offset=
 * Visible channels in provider order, each with what is on now and next.
 */
router.get('/channels', (req, res) => {
    try {
        const db = getDb();
        const limit = clamp(req.query.limit, 1, 200, 50);
        const offset = clamp(req.query.offset, 0, 1e7, 0);
        const { category, search } = req.query;

        const where = [`p.type = 'live'`, `p.is_hidden = 0`, `NOT EXISTS (
            SELECT 1 FROM categories c
            WHERE c.source_id = p.source_id AND c.type = p.type
              AND c.category_id = p.category_id AND c.is_hidden = 1
        )`];
        const params = [];

        if (category) { where.push('p.category_id = ?'); params.push(category); }
        if (search) { where.push('p.name LIKE ?'); params.push(`%${search}%`); }

        const clause = where.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) n FROM playlist_items p WHERE ${clause}`).get(...params).n;

        const rows = db.prepare(`
            SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data
            FROM playlist_items p
            WHERE ${clause}
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const channels = decorate(rows);

        // Mark favourites here rather than making the client ask separately.
        const favs = new Set(db.prepare(`
            SELECT source_id, item_id FROM favorites WHERE user_id = ? AND item_type = 'channel'
        `).all(String(req.user.id)).map(f => `${f.source_id}:${f.item_id}`));
        for (const ch of channels) ch.favourite = favs.has(`${ch.sourceId}:${ch.id}`);

        res.json({ total, limit, offset, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/library/favourites
 *
 * The same decorated shape as /channels. /api/favorites returns bare ids,
 * which would force a client to fetch favourites, then fetch every channel,
 * then stitch them together — exactly what these endpoints exist to avoid.
 */
router.get('/favourites', (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data
            FROM favorites f
            JOIN playlist_items p
              ON p.source_id = f.source_id AND p.item_id = f.item_id AND p.type = 'live'
            WHERE f.user_id = ? AND f.item_type = 'channel'
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
        `).all(String(req.user.id));

        res.json(decorate(rows));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/library/guide?start=&end=&category=&limit=&offset=
 *
 * The grid: channels in provider order, each with its programmes across a
 * window. /channels gives now and next, which draws a tile but not a guide.
 *
 * Paginated by channel, not by programme — a client renders rows, and a row
 * that arrives without its programmes is worse than one that has not arrived.
 * The window is capped at 24 hours because the response grows with it and a
 * TV does not have a desktop's memory.
 */
router.get('/guide', (req, res) => {
    try {
        const db = getDb();
        const limit = clamp(req.query.limit, 1, 100, 25);
        const offset = clamp(req.query.offset, 0, 1e7, 0);
        const { category } = req.query;

        const now = Date.now();
        const start = parseInt(req.query.start, 10) || now;
        const requestedEnd = parseInt(req.query.end, 10) || (start + 3 * 60 * 60 * 1000);
        const end = Math.min(requestedEnd, start + 24 * 60 * 60 * 1000);

        const where = [`p.type = 'live'`, `p.is_hidden = 0`, `NOT EXISTS (
            SELECT 1 FROM categories c
            WHERE c.source_id = p.source_id AND c.type = p.type
              AND c.category_id = p.category_id AND c.is_hidden = 1
        )`];
        const params = [];
        if (category) { where.push('p.category_id = ?'); params.push(category); }
        const clause = where.join(' AND ');

        const total = db.prepare(`SELECT COUNT(*) n FROM playlist_items p WHERE ${clause}`).get(...params).n;
        const rows = db.prepare(`
            SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data
            FROM playlist_items p
            WHERE ${clause}
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const channels = rows.map(row => {
            let data = {};
            try { data = JSON.parse(row.data || '{}'); } catch (e) { /* ignore */ }
            return {
                id: row.item_id,
                sourceId: row.source_id,
                name: row.name,
                logo: row.stream_icon || null,
                category: row.category_id,
                tvgId: data.tvgId || data.epg_channel_id || null,
                programmes: []
            };
        });

        // One query for every channel on the page rather than one per channel.
        const tvgIds = [...new Set(channels.map(c => c.tvgId).filter(Boolean))];
        if (tvgIds.length) {
            const ph = tvgIds.map(() => '?').join(',');
            const progs = db.prepare(`
                SELECT channel_id, title, description, start_time, end_time
                FROM epg_programs
                WHERE channel_id IN (${ph}) AND end_time > ? AND start_time < ?
                ORDER BY start_time ASC
            `).all(...tvgIds, start, end);

            const byChannel = new Map();
            for (const pr of progs) {
                if (!byChannel.has(pr.channel_id)) byChannel.set(pr.channel_id, []);
                byChannel.get(pr.channel_id).push({
                    title: pr.title,
                    description: pr.description || null,
                    startTime: pr.start_time,
                    endTime: pr.end_time,
                    isNow: pr.start_time <= now && pr.end_time > now
                });
            }
            for (const ch of channels) {
                if (ch.tvgId && byChannel.has(ch.tvgId)) ch.programmes = byChannel.get(ch.tvgId);
            }
        }

        res.json({ total, limit, offset, start, end, now, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/library/recent?limit=
 * What this user watched last, most recent first. Drives "jump back in".
 */
router.get('/recent', (req, res) => {
    try {
        const db = getDb();
        const limit = clamp(req.query.limit, 1, 50, 12);

        const rows = db.prepare(`
            SELECT h.source_id, h.channel_item_id, h.channel_name, h.watched_at,
                   p.stream_icon, p.category_id, p.sort_order, p.name, p.item_id, p.data
            FROM channel_history h
            LEFT JOIN playlist_items p
              ON p.source_id = h.source_id AND p.item_id = h.channel_item_id AND p.type = 'live'
            WHERE h.user_id = ?
            ORDER BY h.watched_at DESC
            LIMIT ?
        `).all(String(req.user.id), limit);

        // A channel can disappear between being watched and being asked for,
        // so fall back to the name recorded at the time.
        const usable = rows.filter(r => r.item_id);
        const decorated = decorate(usable);
        const byId = new Map(decorated.map(c => [c.id, c]));

        res.json(rows.map(r => byId.get(r.channel_item_id) || {
            id: r.channel_item_id,
            sourceId: r.source_id,
            name: r.channel_name,
            logo: null,
            unavailable: true,
            now: null,
            next: null
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
