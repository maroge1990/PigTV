/**
 * Sport (contract C-I).
 *
 *   GET /api/sports/categories   (admin; 0147)
 *       -> [{category, programmes}] the EPG categories in the live guide with how
 *          many programmes carry each, most used first, at most 200 (web Status page)
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const sportsEvents = require('../services/sportsEvents');

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/categories', requireAdmin, (req, res) => {
    try {
        res.json(sportsEvents.categoryCounts());
    } catch (err) {
        console.error('[Sports] categories failed:', err.message);
        res.status(500).json({ error: 'Could not count the EPG categories' });
    }
});

module.exports = router;
