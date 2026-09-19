const express = require('express');
const router = express.Router();
const { favorites } = require('../db/sqlite');
const { requireAuth } = require('../auth');
const db = require('../db');
const { compositeChannelId } = require('../services/channelIds');

// All favorites routes require authentication
router.use(requireAuth);

// Get all favorites for current user
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType, format } = req.query;
        const items = favorites.getAll(req.user.id, sourceId || null, itemType || null);

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

