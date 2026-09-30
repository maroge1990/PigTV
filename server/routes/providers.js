/**
 * Providers (0168, contract C-K).
 *
 * GET /api/providers/reminders - any signed-in user or paired device. Nothing but
 * what a reminder needs: id, name, when it ends, days left. No role, login or URL.
 */

const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { requireAuth } = require('../auth');
const providerAccounts = require('../services/providerAccounts');

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/reminders', async (req, res) => {
    try {
        res.json(providerAccounts.reminders(await sources.getAll()));
    } catch (err) {
        console.error('Error getting provider reminders:', err);
        res.status(500).json({ error: 'Failed to get provider reminders' });
    }
});

module.exports = router;
