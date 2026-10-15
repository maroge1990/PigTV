const express = require('express');
const router = express.Router();
const { settings, getDefaultSettings } = require('../db');
const syncService = require('../services/syncService');
const { requireAuth, requireAdmin } = require('../auth');

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/**
 * Get all settings
 * GET /api/settings
 */
router.get('/', async (req, res) => {
    try {
        const currentSettings = await settings.get();
        // R11: the webhook URL is often a secret (an ntfy topic, a Home Assistant id): admins only.
        if (req.user?.role !== 'admin') {
            const { notifyWebhookUrl, ...rest } = currentSettings;
            return res.json({ ...rest, notifyWebhookSet: Boolean(notifyWebhookUrl) });
        }
        res.json(currentSettings);
    } catch (err) {
        console.error('Error getting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Update settings (partial update)
 * PUT /api/settings
 */
/**
 * A recordingsPath the caller is trying to save is refused outright when it is
 * unusable (0157) - before this, a typo'd or unmounted path simply saved, and
 * the only symptom was the Status page quietly saying "unavailable" the next
 * time a recording was due.
 */
router.put('/', requireAdmin, async (req, res) => {
    try {
        const updates = { ...req.body };
        if ('notifyWebhookUrl' in updates) {
            const clean = require('../services/notify').cleanUrl(updates.notifyWebhookUrl);
            if (clean === null) return res.status(400).json({ error: 'The notification webhook must be an http or https address.' });
            updates.notifyWebhookUrl = clean;
        }
        if ('notifyWebhookFormat' in updates && !['json', 'text'].includes(updates.notifyWebhookFormat)) {
            return res.status(400).json({ error: 'The notification format must be json or text.' });
        }
        if (typeof updates.recordingsPath === 'string' && updates.recordingsPath.trim()) {
            const { validateRecordingsPathSetting } = require('../services/recordingsFolder');
            const check = validateRecordingsPathSetting(updates.recordingsPath.trim());
            if (!check.ok) return res.status(400).json({ error: check.reason });
        }
        const updatedSettings = await settings.update(updates);

        // If sync interval changed, restart the server-side sync timer
        if (updates.epgRefreshInterval !== undefined) {
            syncService.restartSyncTimer().catch(console.error);
        }

        res.json(updatedSettings);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Reset settings to defaults
 * DELETE /api/settings
 */
router.delete('/', requireAdmin, async (req, res) => {
    try {
        const defaultSettings = await settings.reset();
        res.json(defaultSettings);
    } catch (err) {
        console.error('Error resetting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get default settings (for reference)
 * GET /api/settings/defaults
 */
router.get('/defaults', (req, res) => {
    res.json(getDefaultSettings());
});

/**
 * Get sync status (last sync time)
 * GET /api/settings/sync-status
 */
router.get('/sync-status', (req, res) => {
    const lastSyncTime = syncService.getLastSyncTime();
    res.json({
        lastSyncTime: lastSyncTime ? lastSyncTime.toISOString() : null
    });
});

/**
 * Get hardware capabilities (GPU acceleration support)
 * GET /api/settings/hw-info
 */
router.get('/hw-info', requireAdmin, async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        let capabilities = hwDetect.getCapabilities();

        // If not yet detected, run detection now
        if (!capabilities) {
            capabilities = await hwDetect.detect();
        }

        res.json(capabilities);
    } catch (err) {
        console.error('Error getting hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Refresh hardware detection (re-probe GPUs)
 * POST /api/settings/hw-info/refresh
 */
/**
 * R11: send a test notification to the saved webhook.
 * POST /api/settings/notify-test -> { sent, status?, error?, skipped? }
 */
router.post('/notify-test', requireAdmin, async (req, res) => {
    const result = await require('../services/notify').send('test', {
        title: 'PigTV test notification', message: 'Notifications from PigTV reach this address.', force: true
    });
    res.json(result);
});

router.post('/hw-info/refresh', requireAdmin, async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        const capabilities = await hwDetect.refresh();
        res.json(capabilities);
    } catch (err) {
        console.error('Error refreshing hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

