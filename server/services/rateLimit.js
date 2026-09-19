/**
 * A small in-memory sliding-window limiter, for the handful of endpoints that
 * can be reached without a token (login, device pairing).
 *
 * In memory on purpose: one process, one user, and a restart clearing the
 * counters is harmless. Nothing here needs a dependency or a database.
 *
 * Usage: check(key) says whether the key is over its limit right now; record(key)
 * counts one event; clear(key) forgets it (e.g. after a successful login).
 * Splitting check from record lets a caller count only the events that matter,
 * such as failed logins, rather than every request.
 */

function createLimiter({ windowMs, max, now = Date.now, maxKeys = 10000 }) {
    const events = new Map(); // key -> [timestamps within the window], oldest first

    const limiter = {
        windowMs,
        max, // mutable: tests lower it

        prune(key) {
            const list = events.get(key);
            if (!list) return null;
            const cutoff = now() - limiter.windowMs;
            while (list.length && list[0] <= cutoff) list.shift();
            if (!list.length) { events.delete(key); return null; }
            return list;
        },

        /** { blocked, retryAfterSec } - blocked once `max` events sit inside the window. */
        check(key) {
            const list = limiter.prune(key);
            if (!list || list.length < limiter.max) return { blocked: false, retryAfterSec: 0 };
            // Free again when the oldest counted event ages out of the window.
            const retryAfterMs = list[list.length - limiter.max] + limiter.windowMs - now();
            return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
        },

        record(key) {
            let list = limiter.prune(key);
            if (!list) {
                // Bound memory: a flood of distinct keys must not grow this without limit.
                if (events.size >= maxKeys) events.delete(events.keys().next().value);
                list = [];
                events.set(key, list);
            }
            list.push(now());
        },

        clear(key) { events.delete(key); },

        size() { return events.size; }
    };
    return limiter;
}

/**
 * Express middleware that counts every request from a client (its socket
 * address, not X-Forwarded-For, which anyone can set) and answers 429 once it
 * is over the limit.
 */
function limitRequests(limiter, message = 'Too many requests') {
    return (req, res, next) => {
        const key = req.socket?.remoteAddress || 'unknown';
        const { blocked, retryAfterSec } = limiter.check(key);
        if (blocked) {
            res.set('Retry-After', String(retryAfterSec));
            return res.status(429).json({ error: message, retryAfterSec });
        }
        limiter.record(key);
        next();
    };
}

module.exports = { createLimiter, limitRequests };
