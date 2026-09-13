/**
 * Device pairing.
 *
 * Typing a password on a TV remote is miserable, so clients that cannot offer
 * a keyboard pair instead:
 *
 *   1. the device asks for a code and displays it
 *   2. the user, already signed in on a phone or browser, approves that code
 *   3. the device collects a long-lived token and stores it
 *
 * The token is an ordinary JWT carrying a deviceId, so nothing in the auth
 * path needs to know pairing exists. The device row is what makes revocation
 * possible: without it a leaked token would be valid until it expired.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/sqlite');

const JWT_SECRET = process.env.JWT_SECRET || 'pigtv-secret-key-change-in-production';
const DEVICE_TOKEN_EXPIRY = '365d';
const CODE_TTL_MS = 10 * 60 * 1000;

// No vowels, and no characters that look like each other on a TV at distance.
const CODE_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';

function generateCode(length = 6) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}

function pruneExpired() {
    getDb().prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now());
}

/**
 * Called by the device. Returns a code for the user to type elsewhere.
 */
function startPairing({ name, platform } = {}) {
    const db = getDb();
    pruneExpired();

    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
        code = generateCode();
        const clash = db.prepare('SELECT 1 FROM pairing_codes WHERE code = ?').get(code);
        if (!clash) break;
        code = null;
    }
    if (!code) throw new Error('Could not allocate a pairing code');

    const now = Date.now();
    db.prepare(`
        INSERT INTO pairing_codes (code, created_at, expires_at, name, platform)
        VALUES (?, ?, ?, ?, ?)
    `).run(code, now, now + CODE_TTL_MS, name || null, platform || null);

    return { code, expiresAt: now + CODE_TTL_MS, expiresInSec: Math.round(CODE_TTL_MS / 1000) };
}

/**
 * Polled by the device. The token is handed over exactly once and then cleared,
 * so a code that is observed later cannot be replayed for the same token.
 */
function pollPairing(code) {
    const db = getDb();
    pruneExpired();

    const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(String(code || '').toUpperCase());
    if (!row) return { status: 'expired' };
    if (!row.approved_at) return { status: 'pending' };
    if (!row.token) return { status: 'claimed' };

    const token = row.token;
    db.prepare('UPDATE pairing_codes SET token = NULL WHERE code = ?').run(row.code);

    return { status: 'approved', token, deviceId: row.device_id };
}

/**
 * Called by a signed-in user to approve a code the device is displaying.
 */
function approvePairing(code, user, { name, platform } = {}) {
    const db = getDb();
    pruneExpired();

    const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(normalised);
    if (!row) throw Object.assign(new Error('That code has expired or was never issued'), { status: 404 });
    if (row.approved_at) throw Object.assign(new Error('That code has already been used'), { status: 409 });

    const deviceId = crypto.randomUUID();
    const now = Date.now();
    const deviceName = name || row.name || 'Unnamed device';
    const devicePlatform = platform || row.platform || 'unknown';

    db.prepare(`
        INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(deviceId, String(user.id), deviceName, devicePlatform, now, now);

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, deviceId },
        JWT_SECRET,
        { expiresIn: DEVICE_TOKEN_EXPIRY }
    );

    db.prepare(`
        UPDATE pairing_codes SET device_id = ?, token = ?, approved_at = ? WHERE code = ?
    `).run(deviceId, token, now, row.code);

    return { deviceId, name: deviceName, platform: devicePlatform };
}

function listDevices(userId) {
    return getDb().prepare(`
        SELECT id, name, platform, created_at, last_seen_at, revoked_at
        FROM devices WHERE user_id = ? ORDER BY created_at DESC
    `).all(String(userId));
}

function revokeDevice(userId, deviceId) {
    const result = getDb().prepare(`
        UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(Date.now(), deviceId, String(userId));
    return result.changes > 0;
}

/**
 * True when a token's device is still allowed in. Checked on every request
 * carrying a deviceId, which is what makes revocation take effect immediately
 * rather than whenever the token happens to expire.
 */
function isDeviceValid(deviceId) {
    if (!deviceId) return true; // an ordinary user token, not a device
    const row = getDb().prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId);
    return !!row && !row.revoked_at;
}

function touchDevice(deviceId) {
    if (!deviceId) return;
    try {
        getDb().prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), deviceId);
    } catch (e) { /* last seen is a nicety, never worth failing a request over */ }
}

module.exports = {
    startPairing,
    pollPairing,
    approvePairing,
    listDevices,
    revokeDevice,
    isDeviceValid,
    touchDevice
};
