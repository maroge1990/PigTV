/**
 * Devices API
 *
 * Pairing is deliberately split: the two endpoints a device calls before it
 * has a token are unauthenticated, and everything else requires a signed-in
 * user. A code on its own grants nothing — it only becomes a token once a
 * user who is already authenticated approves it.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const deviceAuth = require('../services/deviceAuth');

/**
 * POST /api/devices/pair/start
 * Called by a device that has no token yet. Unauthenticated by necessity.
 */
router.post('/pair/start', (req, res) => {
    try {
        const { name, platform } = req.body || {};
        res.json(deviceAuth.startPairing({ name, platform }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/devices/pair/poll?code=ABC123
 * Polled by the device until a user approves. Returns the token exactly once.
 */
router.get('/pair/poll', (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).json({ error: 'code is required' });
        res.json(deviceAuth.pollPairing(code));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Everything below requires a signed-in user.
router.use(requireAuth);

/**
 * POST /api/devices/pair/approve  { code, name?, platform? }
 */
router.post('/pair/approve', (req, res) => {
    try {
        const { code, name, platform } = req.body || {};
        if (!code) return res.status(400).json({ error: 'code is required' });
        const device = deviceAuth.approvePairing(code, req.user, { name, platform });
        console.log(`[Devices] Paired "${device.name}" (${device.platform}) for ${req.user.username}`);
        res.json({ success: true, device });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

/**
 * GET /api/devices
 */
router.get('/', (req, res) => {
    try {
        res.json(deviceAuth.listDevices(req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/devices/:id
 * Takes effect immediately: the token stays cryptographically valid but the
 * strategy rejects it on the next request.
 */
router.delete('/:id', (req, res) => {
    try {
        const ok = deviceAuth.revokeDevice(req.user.id, req.params.id);
        if (!ok) return res.status(404).json({ error: 'Device not found' });
        console.log(`[Devices] Revoked ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
