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

const JWT_SECRET = require('../authSecret');
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

// A device's name and platform are shown in the device list, so they are kept as a
// short single-line label: control and bidirectional-formatting characters removed,
// whitespace collapsed, trimmed and capped. Anything that is not a string is ignored.
const NAME_MAX = 64;
const PLATFORM_MAX = 32;

function cleanLabel(value, max) {
    if (typeof value !== 'string') return null;
    const text = value
        .replace(/\s+/g, ' ')
        .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
        .replace(/ {2,}/g, ' ')
        .trim();
    return text ? Array.from(text).slice(0, max).join('').trim() : null;
}

/**
 * #19 (0363): the Apple app names itself on every request, `X-PigTV-Client: PigTV/<build> (<OS> <version>; <model>)`,
 * e.g. `PigTV/84 (tvOS 26.1; AppleTV14,1)`. Kept as a label like the name; read back into its parts for display.
 * Anything else is kept as sent and shown whole.
 */
const CLIENT_MAX = 80;

function clientHeader(req) {
    const value = req?.headers?.['x-pigtv-client'];
    return cleanLabel(Array.isArray(value) ? value[0] : value, CLIENT_MAX);
}

function describeClient(text) {
    if (!text) return null;
    const m = /^PigTV\/(\S+) \(([^;()]+); ([^;()]+)\)$/.exec(text);
    if (!m) return { text };
    const model = m[3].trim();
    const kind = /^AppleTV/i.test(model) ? 'Apple TV' : /^iPad/i.test(model) ? 'iPad' : /^iPhone/i.test(model) ? 'iPhone' : null;
    return { text, build: m[1], os: m[2].trim(), model, kind };
}

function pruneExpired() {
    getDb().prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now());
}

/**
 * Called by the device. Returns a code for the user to type elsewhere.
 */
function startPairing({ name, platform, client } = {}) {
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
        INSERT INTO pairing_codes (code, created_at, expires_at, name, platform, app_client)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, now, now + CODE_TTL_MS, cleanLabel(name, NAME_MAX), cleanLabel(platform, PLATFORM_MAX), cleanLabel(client, CLIENT_MAX));

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
    const deviceName = cleanLabel(name, NAME_MAX) || cleanLabel(row.name, NAME_MAX) || 'Unnamed device';
    const devicePlatform = cleanLabel(platform, PLATFORM_MAX) || cleanLabel(row.platform, PLATFORM_MAX) || 'unknown';

    db.prepare(`
        INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at, app_client)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, String(user.id), deviceName, devicePlatform, now, now, row.app_client || null);

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

/**
 * #19 (0365): the device behind a code still waiting for approval, so the person approving sees what they let in.
 * Null when the code is unknown, expired or already used.
 */
function pendingPairing(code) {
    pruneExpired();
    const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = getDb().prepare('SELECT name, platform, app_client, created_at FROM pairing_codes WHERE code = ? AND approved_at IS NULL')
        .get(normalised);
    if (!row) return null;
    return { name: row.name || 'Unnamed device', platform: row.platform || 'unknown', app: describeClient(row.app_client), askedAt: row.created_at };
}

function listDevices(userId) {
    flushPending(); // last_seen_at as of the latest request, not the latest write
    return getDb().prepare(`
        SELECT id, name, platform, created_at, last_seen_at, revoked_at, app_client
        FROM devices WHERE user_id = ? ORDER BY created_at DESC
    `).all(String(userId)).map(({ app_client, ...d }) => ({ ...d, app: describeClient(app_client) }));
}

function revokeDevice(userId, deviceId) {
    flushPending(); // the row keeps the device's true last request
    const result = getDb().prepare(`
        UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(Date.now(), deviceId, String(userId));
    touches.delete(deviceId);
    return result.changes > 0;
}

/**
 * #300: a deleted user's devices go with them. Deletes every device row of the user (so isDeviceValid refuses
 * their tokens) and drops their pending last-seen entries. Runs inside db.users.delete's transaction.
 */
function removeUserDevices(userId) {
    const db = getDb();
    const ids = db.prepare('SELECT id FROM devices WHERE user_id = ?').all(String(userId)).map(r => r.id);
    db.prepare('DELETE FROM devices WHERE user_id = ?').run(String(userId));
    for (const id of ids) touches.delete(id);
    return ids.length;
}

// I-1 (#273): the two statements every request from a paired device runs are prepared once per
// database handle, and "last seen" is written at most once a minute per device. Nothing about the
// auth answer is cached: isDeviceValid reads the row on every request, so a revocation (through
// revokeDevice or straight in SQL) refuses the very next request.
const TOUCH_WRITE_MS = 60 * 1000;          // a device's last_seen_at is written at most this often
const TOUCH_FORGET_MS = 24 * 60 * 60 * 1000; // an entry untouched this long is dropped at a flush
const TOUCH_MAX = 10000;                    // and the map is cleared after a flush beyond this size

let clock = () => Date.now();
/** Tests: replace the clock touchDevice and flushPending read (no argument restores Date.now). */
function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

let hotDb = null;
let hotStmts = null;
// deviceId -> { lastSeenAt, client, flushedAt, written }: `written` is the last_seen_at last
// written to the row, `client` the non-empty app_client last written (null when not known).
let touches = new Map();

/** The statements, prepared once per handle; a new handle (tests re-open) drops them and the map. */
function hot() {
    const db = getDb();
    if (hotDb !== db) {
        const stmts = {
            valid: db.prepare('SELECT revoked_at FROM devices WHERE id = ?'),
            // revoked_at IS NULL: a touch never lands on a revoked row (none reaches here today,
            // since isDeviceValid runs first, but a pending flush could).
            touch: db.prepare('UPDATE devices SET last_seen_at = ?, app_client = COALESCE(?, app_client) WHERE id = ? AND revoked_at IS NULL')
        };
        hotDb = db;
        hotStmts = stmts;
        touches = new Map();
    }
    return hotStmts;
}

/**
 * True when a token's device is still allowed in. Checked on every request
 * carrying a deviceId, which is what makes revocation take effect immediately
 * rather than whenever the token happens to expire.
 */
function isDeviceValid(deviceId) {
    if (!deviceId) return true; // an ordinary user token, not a device
    const row = hot().valid.get(deviceId);
    return !!row && !row.revoked_at;
}

/**
 * Last seen now; `client` (the request's X-PigTV-Client) replaces the one kept, and a request without one keeps it.
 * Written to the row on a device's first touch in this process, when a minute has passed since its last write, or
 * when its client string changes; otherwise kept in memory until the next write or flushPending.
 */
function touchDevice(deviceId, client = null) {
    if (!deviceId) return;
    try {
        const stmts = hot();
        const now = clock();
        const label = cleanLabel(client, CLIENT_MAX);
        const entry = touches.get(deviceId);
        if (entry && now - entry.flushedAt < TOUCH_WRITE_MS && (label === null || label === entry.client)) {
            if (now > entry.lastSeenAt) entry.lastSeenAt = now;
            return;
        }
        const lastSeenAt = entry && entry.lastSeenAt > now ? entry.lastSeenAt : now;
        const result = stmts.touch.run(lastSeenAt, label, deviceId);
        if (result.changes === 0) { touches.delete(deviceId); return; } // gone or revoked
        touches.set(deviceId, { lastSeenAt, client: label ?? entry?.client ?? null, flushedAt: now, written: lastSeenAt });
        if (touches.size > TOUCH_MAX) flushPending();
    } catch (e) { /* last seen is a nicety, never worth failing a request over */ }
}

/**
 * Writes every last_seen_at kept only in memory, so a reader (listDevices) or a revocation sees the latest
 * request. Safe at any time, shutdown included: it never throws and never opens a database that is not open.
 * Returns how many rows it wrote.
 */
function flushPending() {
    if (!touches.size || !hotDb || !hotDb.open) return 0;
    let wrote = 0;
    try {
        const stmts = hot();
        const now = clock();
        for (const [deviceId, entry] of touches) {
            if (entry.lastSeenAt > entry.written) {
                const result = stmts.touch.run(entry.lastSeenAt, null, deviceId);
                if (result.changes === 0) { touches.delete(deviceId); continue; } // gone or revoked
                entry.written = entry.lastSeenAt;
                entry.flushedAt = now;
                wrote++;
            }
            if (now - entry.lastSeenAt >= TOUCH_FORGET_MS) touches.delete(deviceId);
        }
        if (touches.size > TOUCH_MAX) touches.clear();
    } catch (e) { /* as touchDevice: never worth failing over */ }
    return wrote;
}

module.exports = {
    startPairing,
    pollPairing,
    approvePairing,
    pendingPairing,
    listDevices,
    revokeDevice,
    removeUserDevices,
    isDeviceValid,
    touchDevice,
    flushPending,
    _setClock,
    clientHeader,
    describeClient
};
