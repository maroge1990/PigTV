const express = require('express');
const router = express.Router();
const { favorites, getDb } = require('../db/sqlite');
const { requireAuth } = require('../auth');
const db = require('../db');
const { compositeChannelId } = require('../services/channelIds');

// All favorites routes require authentication
router.use(requireAuth);

/**
 * Expand stored favourite rows into their CURRENT item_id(s).
 *
 * A channel favourite with a stable_id was stored at whatever playlist
 * position (pos_N) it sat on when it was starred. The provider reorders its
 * playlist, so that position can now name a different channel entirely
 * (0110: the Apple TV showed "Fox Footy 504" while the web app - which reads
 * /api/library/favourites and joins on stable_id - showed "Fox Footy 502").
 *
 * For each favourite that has an identity, look up every CURRENT
 * playlist_items row sharing that (source_id, stable_id) and emit one
 * favourite entry per listing - a channel cross-listed in two categories
 * shows a star in both, same as /api/library/favourites. A favourite with no
 * stable_id has no identity to resolve against, so it keeps its stored
 * item_id (the documented rule: a row that HAS an identity must never fall
 * back to its stored pos_N; a row that never had one has nothing else to go
 * on).
 */
function expandToCurrentItemIds(items) {
    const sqlite = getDb();
    const out = [];
    for (const f of items) {
        if (f.item_type !== 'channel' || !f.stable_id) {
            out.push(f);
            continue;
        }
        const current = sqlite.prepare(
            'SELECT item_id FROM playlist_items WHERE source_id = ? AND stable_id = ? AND type = \'live\''
        ).all(f.source_id, f.stable_id);
        if (!current.length) {
            // The channel has vanished from the playlist entirely (dropped by
            // the provider). Nothing current to point at - keep the stored
            // value rather than silently dropping the favourite.
            out.push(f);
            continue;
        }
        for (const row of current) out.push({ ...f, item_id: row.item_id });
    }
    return out;
}

// Get all favorites for current user
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType, format } = req.query;
        const items = expandToCurrentItemIds(favorites.getAll(req.user.id, sourceId || null, itemType || null));

        // Channel favourites are stored under the bare id (what the native
        // client and /api/library use). The web app identifies a channel by
        // its composite id, so present them that way unless the caller asks
        // for the stored form with ?format=bare.
        if (format === 'bare') return res.json(items);
        const types = new Map((await db.sources.getAll()).map(s => [Number(s.id), s.type]));
        res.json(items.map(f => f.item_type === 'channel'
            ? { ...f, item_id: compositeChannelId(types.get(Number(f.source_id)), f.source_id, f.item_id) }
            : f));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite for current user
router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.add(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite for current user
router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.remove(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited by current user
router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        const isFav = favorites.isFavorite(req.user.id, sourceId, itemId, itemType);
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

