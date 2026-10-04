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
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db/sqlite');
const { currentGuideVersion } = require('../services/libraryRev');
const { applyLogoCache } = require('../services/logoCache');
const channelNumbers = require('../services/channelNumbers');
const { NUMBER_JOIN, NUMBER_SENTINEL } = channelNumbers;
const channelHealth = require('../services/channelHealth');
const epgMapping = require('../services/epgMapping');
const sportCategories = require('../services/sportCategories');

// The longest programme the guide will still show when it began before the
// window. Every EPG query bounds start_time from below by this, because the
// index is (channel_id, start_time, end_time): with only "end_time > from" to go
// on, SQLite walks every programme a channel has ever had before the window
// (the whole feed - days of it) just to discard them. A programme that began
// more than a day earlier and is still running is not something a guide row
// can usefully show.
const MAX_PROGRAMME_MS = 24 * 60 * 60 * 1000;

router.use(requireAuth);

// 0117: an upgraded server whose sources are fresh does not sync on startup, so
// the first library request numbers the channels if nothing has been numbered.
router.use((req, res, next) => { channelNumbers.ensureChannelNumbers(); next(); });

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
        FROM epg_live
        WHERE channel_id IN (${placeholders})
          AND start_time > ? AND end_time > ? AND start_time < ?
        ORDER BY channel_id ASC, start_time ASC
    `).all(...tvgIds, now - MAX_PROGRAMME_MS, now, now + 6 * 60 * 60 * 1000);

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

// A playlist often has no logo for a channel that the EPG feed does have one for.
// The Apple client used to make up for that itself: download the whole EPG channel
// list, then match on tvg-id and name. Doing it here means it downloads nothing.
// The index is built once and reused for a few minutes rather than queried per
// page, because matching by name has to look at every EPG channel.
const EPG_ICON_TTL_MS = 5 * 60 * 1000;
let epgIconIndex = null;
const normaliseName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function getEpgIconIndex() {
    if (epgIconIndex && Date.now() - epgIconIndex.builtAt < EPG_ICON_TTL_MS) return epgIconIndex;
    const byId = new Map();
    const byName = new Map();
    const rows = getDb().prepare(`
        SELECT item_id, name, stream_icon FROM playlist_items
        WHERE type = 'epg_channel' AND stream_icon IS NOT NULL AND stream_icon <> ''
        ORDER BY source_id, rowid
    `).all();
    for (const r of rows) { // first source to supply an icon wins
        if (!byId.has(r.item_id)) byId.set(r.item_id, r.stream_icon);
        const name = normaliseName(r.name);
        if (name && !byName.has(name)) byName.set(name, r.stream_icon);
    }
    epgIconIndex = { builtAt: Date.now(), byId, byName };
    return epgIconIndex;
}

/**
 * Fill in a logo for channels the playlist gave none: the EPG's icon for the same
 * tvg-id, else for a channel of the same name (case and spacing aside). A logo the
 * playlist supplied is never replaced. Purely decoration, so it can never be the
 * reason a listing fails.
 */
function fillMissingLogos(channels) {
    if (!channels.some(c => !c.logo)) return;
    let index;
    try { index = getEpgIconIndex(); } catch (e) { return; }
    for (const ch of channels) {
        if (ch.logo) continue;
        ch.logo = (ch.tvgId && index.byId.get(ch.tvgId)) || index.byName.get(normaliseName(ch.name)) || null;
    }
}

function decorate(items) {
    const tvgIds = [];
    const parsed = items.map(row => {
        let data = {};
        try { data = JSON.parse(row.data || '{}'); } catch (e) { /* ignore */ }
        // 0134: the admin's EPG mapping wins over the playlist's tvg-id, for
        // now/next and the logo fallback alike.
        const tvgId = epgMapping.effectiveTvgId(row.source_id, row.stable_id, row.item_id,
            data.tvgId || data.epg_channel_id || null);
        if (tvgId) tvgIds.push(tvgId);
        return {
            id: row.item_id,
            sourceId: row.source_id,
            name: row.name,
            logo: row.stream_icon || null,
            category: row.category_id,
            tvgId,
            order: row.sort_order,
            // What the channel IS, so a favourite still matches after the provider
            // reorders the playlist. Additive to the response: a client that does not
            // know the field ignores it, and nothing existing changes shape.
            stableId: row.stable_id || null,
            // 0117 (C-A): the channel's number, or null if it has none.
            number: row.channel_number ?? null
        };
    });

    const guide = nowNextFor([...new Set(tvgIds)]);
    for (const ch of parsed) {
        const g = ch.tvgId ? guide[ch.tvgId] : null;
        ch.now = g?.now || null;
        ch.next = g?.next || null;
    }
    fillMissingLogos(parsed);
    // 0112: hand out our own cached path instead of the provider URL, for
    // /channels, /favourites and /recent (all three go through decorate()).
    applyLogoCache(parsed);
    return parsed;
}

/**
 * GET /api/library/categories
 * Visible categories in the provider's own order, with channel counts and
 * (0146, C-H) `sport`: whether an admin marked the category as sport.
 */
router.get('/categories', (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(`
            SELECT c.source_id, c.category_id, c.name,
                   (SELECT COUNT(*) FROM playlist_items p
                     WHERE p.source_id = c.source_id AND p.type = 'live'
                       AND p.category_id = c.category_id AND p.is_hidden = 0
                       AND NOT ${channelNumbers.LINKED_SIBLING_SQL}) AS channel_count
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
                channelCount: r.channel_count,
                sport: sportCategories.isSport(r.source_id, r.category_id)
            })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/library/categories/sport  {sourceId, categoryId, sport}   (admin; 0146, C-H)
 * Marks or unmarks a live category as sport -> {success, sport}. Stored per
 * category, apart from anything a sync writes; bumps library_rev on a change.
 */
router.put('/categories/sport', requireAdmin, (req, res) => {
    const { sourceId, categoryId, sport } = req.body || {};
    const source = parseInt(sourceId, 10);
    if (!Number.isFinite(source) || categoryId === undefined || categoryId === null || categoryId === '') {
        return res.status(400).json({ error: 'sourceId and categoryId are required' });
    }
    if (typeof sport !== 'boolean') return res.status(400).json({ error: 'sport must be true or false' });
    try {
        const result = sportCategories.setSport(source, categoryId, sport);
        if (!result) return res.status(404).json({ error: 'No such live category' });
        res.json({ success: true, sport: result.sport });
    } catch (err) {
        console.error('[Library] sport category failed:', err.message);
        res.status(500).json({ error: 'Could not save the sport category' });
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

        // The one rule for a visible channel (channelNumbers.VISIBLE_SQL), linked siblings excluded.
        const where = [channelNumbers.VISIBLE_SQL];
        const params = [];

        if (category) { where.push('p.category_id = ?'); params.push(category); }
        if (search) { where.push('p.name LIKE ?'); params.push(`%${search}%`); }

        const clause = where.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) n FROM playlist_items p WHERE ${clause}`).get(...params).n;

        const rows = db.prepare(`
            SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id,
                   n.number AS channel_number
            FROM playlist_items p
            ${NUMBER_JOIN}
            WHERE ${clause}
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const channels = decorate(rows);
        // 0133 (C-G): `health` ok | flaky | null, from the last 7 days' starts.
        channelHealth.applyHealth(channels);

        // Mark favourites here rather than making the client ask separately. Matched
        // on the channel's identity so a favourite still lands after the provider
        // reorders the playlist - and so a channel cross-listed in two categories
        // shows as favourited in both, which is one channel and one star.
        const favRows = db.prepare(`
            SELECT source_id, item_id, stable_id FROM favorites WHERE user_id = ? AND item_type = 'channel'
        `).all(String(req.user.id));
        const favs = new Set();
        for (const f of favRows) {
            // Identity when the row has one. Its stored item_id is where the channel
            // sat when it was favourited, which after a reorder names something else -
            // adding that to the set would star the wrong channel.
            if (f.stable_id) favs.add(`${f.source_id}:${f.stable_id}`);
            else favs.add(`${f.source_id}:${f.item_id}`);
        }
        for (const ch of channels) {
            ch.favourite = favs.has(`${ch.sourceId}:${ch.id}`)
                || (ch.stableId ? favs.has(`${ch.sourceId}:${ch.stableId}`) : false);
        }

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
        // Joined on the channel's identity, falling back to the stored item_id for
        // rows that predate identities. GROUP BY that identity because 845 of this
        // provider's 18 000 channels are listed in more than one category: without
        // it, favouriting one of them would show the same channel several times in
        // the favourites list. The row kept is the earliest in provider order, which
        // is where the channel appears in the guide.
        const rows = db.prepare(`
            SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id,
                   n.number AS channel_number
            FROM favorites f
            JOIN playlist_items p
              ON p.source_id = f.source_id AND p.type = 'live'
             AND ((f.stable_id IS NOT NULL AND p.stable_id = f.stable_id)
                  OR (f.stable_id IS NULL AND p.item_id = f.item_id))
            ${NUMBER_JOIN}
            WHERE f.user_id = ? AND f.item_type = 'channel'
            GROUP BY COALESCE(p.stable_id, p.item_id), p.source_id
            HAVING p.sort_order = MIN(p.sort_order) OR MIN(p.sort_order) IS NULL
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
        `).all(String(req.user.id));

        res.json(decorate(rows));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The guide's total order: NULL sort_order (Xtream — unordered) sorts after
// every M3U position, then name, then id as a tiebreaker so the order is
// total even across ties — required for keyset (cursor) paging to line up
// exactly with OFFSET paging. Rather than a NULL-laden tuple compare (SQLite's
// row-value NULL semantics are awkward to keyset against), NULL sort_order is
// coalesced to a sentinel larger than any real playlist position.
const SORT_SENTINEL = 999999999;
const GUIDE_SORT_KEY = `COALESCE(p.sort_order, ${SORT_SENTINEL})`;
const GUIDE_ORDER_BY = `ORDER BY ${GUIDE_SORT_KEY} ASC, p.name ASC, p.id ASC`;

/**
 * Opaque cursor: base64 of the last row's sort key, for keyset paging.
 * A cursor with `nk` (number key) is rejected (400) since channel numbers
 * are labels only and the guide is never ordered by number (0139).
 */
function encodeGuideCursor(row) {
    return Buffer.from(JSON.stringify({ sk: row.sk, name: row.name, id: row.id })).toString('base64');
}
function decodeGuideCursor(cursor) {
    try {
        const obj = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (typeof obj.sk !== 'number' || typeof obj.name !== 'string' || typeof obj.id !== 'string') return null;
        // Reject cursors made when the guide was (incorrectly) ordered by number
        if (obj.nk !== undefined) return null;
        return obj;
    } catch {
        return null;
    }
}

/**
 * GET /api/library/guide?start=&end=&category=&limit=&offset=|cursor=
 *
 * The grid: channels in provider order, each with its programmes across a
 * window. /channels gives now and next, which draws a tile but not a guide.
 *
 * Paginated by channel, not by programme — a client renders rows, and a row
 * that arrives without its programmes is worse than one that has not arrived.
 * The window is capped at 24 hours because the response grows with it and a
 * TV does not have a desktop's memory.
 *
 * 0111 (roadmap S1.3, guide API for scale): `limit` now goes up to 500 (was
 * 100), and an opaque `cursor` does keyset paging instead of OFFSET, which
 * degrades on a large table. `offset` still works exactly as before for
 * older clients; passing both prefers `cursor`. `nextCursor` is always
 * included so a client can switch onto keyset paging from either mode.
 */
router.get('/guide', (req, res) => {
    try {
        const db = getDb();
        const limit = clamp(req.query.limit, 1, 500, 25);
        const offset = clamp(req.query.offset, 0, 1e7, 0);
        const { category, cursor } = req.query;

        const now = Date.now();
        const start = parseInt(req.query.start, 10) || now;
        const requestedEnd = parseInt(req.query.end, 10) || (start + 3 * 60 * 60 * 1000);
        const end = Math.min(requestedEnd, start + 24 * 60 * 60 * 1000);

        // The one rule for a visible channel (channelNumbers.VISIBLE_SQL), linked siblings excluded.
        const where = [channelNumbers.VISIBLE_SQL];
        const params = [];
        if (category) { where.push('p.category_id = ?'); params.push(category); }
        const clause = where.join(' AND ');

        const total = db.prepare(`SELECT COUNT(*) n FROM playlist_items p WHERE ${clause}`).get(...params).n;

        let cursorKey = null;
        const pageWhere = [...where];
        const pageParams = [...params];
        if (cursor) {
            cursorKey = decodeGuideCursor(cursor);
            if (!cursorKey) return res.status(400).json({ error: 'Invalid cursor' });
            pageWhere.push(`(${GUIDE_SORT_KEY}, p.name, p.id) > (?, ?, ?)`);
            pageParams.push(cursorKey.sk, cursorKey.name, cursorKey.id);
        }
        const pageClause = pageWhere.join(' AND ');

        // Fetch one extra row (keyset mode) to know whether a next page exists,
        // without a separate COUNT. OFFSET mode keeps its exact old query shape.
        const rows = cursor
            ? db.prepare(`
                SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id, p.tvg_id, p.id, ${GUIDE_SORT_KEY} AS sk,
                       n.number AS channel_number
                FROM playlist_items p
                ${NUMBER_JOIN}
                WHERE ${pageClause}
                ${GUIDE_ORDER_BY}
                LIMIT ?
            `).all(...pageParams, limit + 1)
            : db.prepare(`
                SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id, p.tvg_id, p.id, ${GUIDE_SORT_KEY} AS sk,
                       n.number AS channel_number
                FROM playlist_items p
                ${NUMBER_JOIN}
                WHERE ${pageClause}
                ${GUIDE_ORDER_BY}
                LIMIT ? OFFSET ?
            `).all(...pageParams, limit + 1, offset);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? encodeGuideCursor(pageRows[pageRows.length - 1]) : null;

        const channels = pageRows.map(row => {
            // The indexed column first (0111 — filled at ingest and backfilled at
            // startup); JSON.parse `data` only for the rows that predate it, so a
            // guide page no longer parses JSON for every row just to find this.
            let tvgId = row.tvg_id || null;
            if (!tvgId) {
                try {
                    const data = JSON.parse(row.data || '{}');
                    tvgId = data.tvgId || data.epg_channel_id || null;
                } catch (e) { /* ignore */ }
            }
            // 0134: the admin's EPG mapping wins over the playlist's tvg-id.
            tvgId = epgMapping.effectiveTvgId(row.source_id, row.stable_id, row.item_id, tvgId);
            return {
                id: row.item_id,
                sourceId: row.source_id,
                name: row.name,
                logo: row.stream_icon || null,
                category: row.category_id,
                tvgId,
                // Additive: the same identity /channels and /favourites carry, so a
                // client can match a guide row to a favourite or a playback handle
                // without falling back to item_id (0096-0098's trap).
                stableId: row.stable_id || null,
                // 0117 (C-A): the channel's number, or null if it has none.
                number: row.channel_number ?? null,
                programmes: []
            };
        });
        fillMissingLogos(channels);
        applyLogoCache(channels);
        // 0133 (C-G): `health` ok | flaky | null, from the last 7 days' starts.
        channelHealth.applyHealth(channels);

        // One query for every channel on the page rather than one per channel.
        const tvgIds = [...new Set(channels.map(c => c.tvgId).filter(Boolean))];
        if (tvgIds.length) {
            const ph = tvgIds.map(() => '?').join(',');
            const progs = db.prepare(`
                SELECT channel_id, title, description, start_time, end_time
                FROM epg_live
                WHERE channel_id IN (${ph}) AND start_time > ? AND end_time > ? AND start_time < ?
                ORDER BY start_time ASC
            `).all(...tvgIds, start - MAX_PROGRAMME_MS, start, end);

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

        res.json({ total, limit, offset, start, end, now, channels, nextCursor });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/library/guide/version
 *
 * 0111 (roadmap S1.3): a cheap "has anything changed?" check, so a client
 * with the whole guide cached does not have to re-fetch or diff it on every
 * screen visit. See services/libraryRev.js for what changes it and why.
 */
router.get('/guide/version', (req, res) => {
    try {
        res.json({ version: currentGuideVersion() });
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
                   p.stream_icon, p.category_id, p.sort_order, p.name, p.item_id, p.data, p.stable_id,
                   n.number AS channel_number
            FROM channel_history h
            -- Joined on the identity when the row has one, so a watched channel is
            -- still found after the provider reorders; on the recorded position only
            -- for rows that predate identities. A row WITH an identity must not fall
            -- back to its position - that position may now be a different channel.
            LEFT JOIN playlist_items p
              ON p.source_id = h.source_id AND p.type = 'live'
             AND ((h.stable_id IS NOT NULL AND p.stable_id = h.stable_id)
                  OR (h.stable_id IS NULL AND p.item_id = h.channel_item_id))
            ${NUMBER_JOIN}
            WHERE h.user_id = ?
            -- One row per watched channel even when it is listed in several
            -- categories (845 of this provider's are), keeping the earliest
            -- position - where the channel appears in the guide.
            GROUP BY h.source_id, h.channel_item_id
            HAVING p.sort_order = MIN(p.sort_order) OR MIN(p.sort_order) IS NULL
            ORDER BY h.watched_at DESC
            LIMIT ?
        `).all(String(req.user.id), limit);

        // A channel can disappear between being watched and being asked for,
        // so fall back to the name recorded at the time.
        const usable = rows.filter(r => r.item_id);
        const decorated = decorate(usable);
        // Keyed on what the history row joined to, not on the id it recorded: once
        // the playlist has moved, the channel's current item_id is not the one that
        // was written, which is the entire point of the identity.
        const byHistoryId = new Map();
        let d = 0;
        for (const r of rows) if (r.item_id) byHistoryId.set(`${r.source_id}:${r.channel_item_id}`, decorated[d++]);

        res.json(rows.map(r => byHistoryId.get(`${r.source_id}:${r.channel_item_id}`) || {
            id: r.channel_item_id,
            sourceId: r.source_id,
            name: r.channel_name,
            logo: null,
            number: null,
            unavailable: true,
            now: null,
            next: null
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Exposed so tests can force the icon index to be rebuilt.
router._resetEpgIconIndex = () => { epgIconIndex = null; };
// 0148: the sport events' channels get their logos the same way (routes/sports.js).
router.fillMissingLogos = fillMissingLogos;

module.exports = router;
