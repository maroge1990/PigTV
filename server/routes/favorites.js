const express = require('express');
const router = express.Router();
const { favorites } = require('../db/sqlite');
const { requireAuth } = require('../auth');

// All favorites routes require authentication
router.use(requireAuth);

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
        const { sourceId, itemId, itemType = 'channel', stableId } = req.body;
        // A favourite whose channel has vanished has no current id (the library lists it with
        // no current id): it is removed by the identity it was starred with.
        if (sourceId && !itemId && stableId) {
            favorites.removeByIdentity(req.user.id, sourceId, String(stableId), itemType);
            return res.json({ success: true });
        }
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.remove(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

