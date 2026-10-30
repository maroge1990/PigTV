/**
 * Who may end a playback session (DELETE /api/transcode/:id, DELETE /api/playback/:id).
 *
 * The account that started it, any device paired to that account, or an admin. The
 * owner is the coordinator's owner key (`user:<id>` or `device:<id>`) recorded when the
 * session or its relay was made. An id that names nothing running is allowed through:
 * ending it changes nothing, and the routes have always answered it with success.
 */

const { getDb } = require('../db/sqlite');

/** The owner key of what this id names, null when it has none, undefined when nothing runs under it. */
function ownerOf(sessionId) {
    const relay = require('./streamRelay').get(sessionId);
    if (relay) return relay.ctx?.owner ?? null;
    const session = require('./transcodeSession').peekSession(String(sessionId));
    if (session) return session.options?.owner ?? null;
    return undefined;
}

/** The account id behind an owner key, or null. */
function accountOf(owner) {
    if (typeof owner !== 'string') return null;
    if (owner.startsWith('user:')) return owner.slice(5);
    if (owner.startsWith('device:')) {
        const row = getDb().prepare('SELECT user_id FROM devices WHERE id = ?').get(owner.slice(7));
        return row ? String(row.user_id) : null;
    }
    return null;
}

function mayEnd(user, sessionId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const owner = ownerOf(sessionId);
    if (owner === undefined) return true;
    if (!owner) return false;
    if (owner === require('./streamCoordinator').ownerKey(user)) return true;
    const account = accountOf(owner);
    return account !== null && account === String(user.id);
}

module.exports = { mayEnd, ownerOf };
