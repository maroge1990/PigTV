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

        res.json({ total, limit, offset, channels: decorate(rows) });
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
            FROM watch_history h
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
