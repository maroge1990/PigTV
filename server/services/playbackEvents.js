/**
 * The last few plays, for the admin status page (0124, roadmap W2.2).
 *
 * A small in-memory ring buffer - the last MAX_EVENTS play-start, play-end and
 * failure events - fed from three places:
 *   - POST /api/playback/client-event (play-start with its first-picture time,
 *     play-end, and the player's media-error / start-timeout reports),
 *   - playbackStrategy.resolve(), which notes how each start was served (cold:
 *     probed now; warm: probe cached in memory; profile: stored channel profile),
 *   - the resolve route, which knows the channel and records a failed start with
 *     the client-safe reason (never a URL; see playbackErrors.js).
 * A client's play-start carries no channel, so it inherits what that owner last
 * resolved. Nothing here is persisted: a restart starts an empty list, which is
 * fine for "what just happened".
 */

const MAX_EVENTS = 50;
const MAX_OWNERS = 200;

const events = [];
const lastResolve = new Map(); // owner -> { channel, start, strategy, videoMode, at }

// Anything URL-shaped is removed from what is stored, whatever the caller passed.
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const clean = (v, max = 200) => (v === null || v === undefined ? null
    : String(v).replace(URLISH, '[url removed]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function record(event) {
    events.push({
        at: Date.now(),
        type: event.type,
        owner: clean(event.owner, 60),
        channel: clean(event.channel, 120),
        start: clean(event.start, 12),
        strategy: clean(event.strategy, 20),
        videoMode: clean(event.videoMode, 10),
        firstPictureSec: num(event.firstPictureSec),
        resolveSec: num(event.resolveSec),
        watchedSec: num(event.watchedSec),
        stalls: num(event.stalls),
        reason: clean(event.reason, 200)
    });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** What `owner` last resolved; merged, so the strategy and the route can each add their part. */
function noteResolve(owner, info) {
    const key = owner || 'unknown';
    const prior = lastResolve.get(key) || {};
    lastResolve.delete(key); // re-inserted last: the Map's order is the eviction order
    lastResolve.set(key, { ...prior, ...info, at: Date.now() });
    while (lastResolve.size > MAX_OWNERS) lastResolve.delete(lastResolve.keys().next().value);
}

function lastResolveFor(owner) {
    return lastResolve.get(owner || 'unknown') || null;
}

/** Newest first. */
function recent() {
    return events.slice().reverse();
}

function reset() {
    events.length = 0;
    lastResolve.clear();
}

module.exports = { record, noteResolve, lastResolveFor, recent, reset, MAX_EVENTS };
