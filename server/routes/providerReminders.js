/**
 * GET /api/providers/reminders (C-K, 0175)
 *
 * Licence reminders: enabled providers whose effective expiry is ≤ 7 days away (or past).
 * Token required (device or user). Nothing else (no role, login or URL).
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getDb } = require('../db/sqlite');
const providerAccounts = require('../services/providerAccounts');

const REMINDER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

router.use(requireAuth);

router.get('/', (req, res) => {
    try {
        const now = Date.now();
        const cutoff = now + REMINDER_DAYS * DAY_MS;
        const reminders = [];

        const rows = getDb().prepare('SELECT id, data FROM app_sources WHERE type != ? ORDER BY id').all('epg');
        for (const row of rows) {
            let source;
            try { source = JSON.parse(row.data); } catch (e) { continue; }
            if (source.enabled === false) continue;

            const account = providerAccounts.getAccount(source.id);
            const expiry = providerAccounts.expiryInfo(source, account);
            if (!expiry.at) continue;

            if (expiry.at >= now && expiry.at <= cutoff) {
                const daysLeft = Math.ceil((expiry.at - now) / DAY_MS);
                reminders.push({
                    id: source.id,
                    name: source.name || `Provider ${source.id}`,
                    expiresAt: expiry.at,
                    daysLeft
                });
            } else if (expiry.at < now) {
                reminders.push({
                    id: source.id,
                    name: source.name || `Provider ${source.id}`,
                    expiresAt: expiry.at,
                    daysLeft: 0
                });
            }
        }

        res.json(reminders);
    } catch (err) {
        console.error('[Reminders] failed:', err.message);
        res.status(500).json({ error: 'Could not read provider reminders' });
    }
});

module.exports = router;
