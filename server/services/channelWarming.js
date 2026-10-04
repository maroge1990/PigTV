/**
 * Channel warming (R12). Off unless the `warmNextChannel` setting is on.
 *
 * Changing channel costs seconds: probe the stream, start ffmpeg, wait for the first
 * segment. A client that can guess the channel its viewer will play next (the next one
 * in the list, the previous one) asks for it to be warmed, and when the viewer does play
 * it, resolve hands over the session that is already running.
 *
 * It is a guess, so it is cheap and polite:
 *
 *   - It only ever uses a provider connection nobody wants (coordinator.tryReserveFree):
 *     it never reclaims a stream, never prompts anybody, never takes a recording's
 *     connection. With one connection per account it therefore almost never runs - and
 *     that is the design, not a limitation.
 *   - The session it starts is marked `warm`: abandoned from the start, and the first thing
 *     the coordinator reclaims when anything else needs the connection (silently, before
 *     even a relay's standby).
 *   - It lives 90 s from the last request that asked for it, then ends. One per owner: warming
 *     something else ends the previous one.
 *   - Never for the channel the owner is already watching.
 *
 * Counted in memory only (the Status page shows them): hits (a resolve adopted a warm
 * session), misses (a resolve with warming on that found none it could use), expired and
 * reclaimed.
 */

const transcodeSession = require('./transcodeSession');

const WARM_TTL_MS = 90 * 1000;
let ttlMs = WARM_TTL_MS; // test seam: _setTtl

// owner -> { owner, key, sourceId, channelId, sessionId, candidate, decision, leaseId, timer }
const entries = new Map();
// owners with a warm start in progress: a second request for the same owner meanwhile is ignored
const starting = new Set();
// owner -> { key, sessionId }: the channel each owner is watching, so it is never warmed
const watching = new Map();

const stats = { hits: 0, misses: 0, expired: 0, reclaimed: 0 };

const coordinator = () => require('./streamCoordinator');
const strategy = () => require('./playbackStrategy');

/** Is warming switched on? The setting, nothing else. */
const enabled = (settings) => !!settings && settings.warmNextChannel === true;

/** A warm session is reusable by a resolve with the same channel and the same needs. */
function keyFor({ sourceId, channelId, capabilities, upscale, audioEncode }) {
    const caps = Object.keys(capabilities || {}).filter(k => capabilities[k] === true).sort().join(',');
    return `${parseInt(sourceId)}|${String(channelId)}|${caps}|${upscale === true ? 'u' : ''}|${audioEncode === true ? 'a' : ''}`;
}

const sessionAlive = (id) => {
    const s = transcodeSession.peekSession(id);
    return !!s && !s.stopRequested;
};

/** Forget entries whose session ended by itself (ffmpeg died, an admin stopped it). */
function pruneDead() {
    for (const [owner, e] of entries) {
        if (!sessionAlive(e.sessionId)) drop(owner);
    }
}

/** Take the entry out without touching its session. */
function drop(owner) {
    const e = entries.get(owner);
    if (!e) return null;
    entries.delete(owner);
    if (e.timer) clearTimeout(e.timer);
    return e;
}

/** End the owner's warm session (its ffmpeg, its connection). */
async function end(owner, why) {
    const e = drop(owner);
    if (!e) return false;
    console.log(`[Warm] ending ${e.sessionId}: ${why}`);
    try { await transcodeSession.removeSession(e.sessionId); } catch (err) { console.warn('[Warm] could not stop a warm session:', err.message); }
    coordinator().releaseLease(e.leaseId);
    return true;
}

function armTimer(e) {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
        if (entries.get(e.owner) !== e) return;
        stats.expired++;
        end(e.owner, `not used within ${Math.round(ttlMs / 1000)}s`).catch(() => {});
    }, ttlMs);
    if (typeof e.timer.unref === 'function') e.timer.unref();
}

/** The coordinator reclaimed this session for somebody who needed the connection. */
function noteReclaimed(sessionId) {
    for (const [owner, e] of entries) {
        if (e.sessionId !== sessionId) continue;
        drop(owner);
        stats.reclaimed++;
        console.log(`[Warm] ${sessionId} was reclaimed: its connection was needed`);
        return true;
    }
    return false;
}

/** The owner is playing this channel now (from a resolve), so it is not warmed. */
function noteWatching(owner, key, sessionId) {
    if (owner) watching.set(owner, { key, sessionId });
}

function isWatching(owner, key) {
    const w = watching.get(owner);
    if (!w) return false;
    if (!sessionAlive(w.sessionId)) { watching.delete(owner); return false; }
    return w.key === key;
}

/**
 * POST /warm: warm `ctx.sourceId`/`ctx.channelId` for `ctx.owner`. Returns { ttlSec, refreshed }
 * when a warm session exists afterwards, else null (nothing done, or nothing could be).
 * Never throws: a guess must not be able to hurt anything.
 */
async function warm(ctx) {
    const { owner, sourceId, channelId, capabilities, upscale, audioEncode, settings, ffprobePath } = ctx;
    if (!owner || !enabled(settings)) return null;
    const key = keyFor(ctx);
    try {
        if (isWatching(owner, key)) return null;

        pruneDead();
        const existing = entries.get(owner);
        if (existing && existing.key === key) {
            armTimer(existing);
            return { ttlSec: ttlMs / 1000, refreshed: true };
        }
        if (existing) await end(owner, 'the owner is warming another channel');
        if (starting.has(owner)) return null;

        const providerRouting = require('./providerRouting');
        const plan = await providerRouting.plan(parseInt(sourceId), channelId);
        let recordings = [];
        try { recordings = require('./recordingEngine').listActive(); } catch (e) { /* none counted */ }

        // The first provider with a connection nobody is using. No second choice by reclaiming.
        let candidate = null;
        let lease = null;
        let reclaimedDuringStart = false;
        for (const c of plan.candidates) {
            lease = coordinator().tryReserveFree(c.providerId, 'warm', settings, recordings, {
                owner,
                onReclaim: (why) => { if (why === 'reclaimed') { reclaimedDuringStart = true; stats.reclaimed++; } }
            });
            if (lease) { candidate = c; break; }
        }
        if (!lease) return null;

        starting.add(owner);
        let decision;
        try {
            decision = await strategy().resolve({
                url: candidate.url,
                capabilities: capabilities || {},
                settings,
                ffprobePath,
                upscale: upscale === true,
                audioEncode: audioEncode === true,
                owner,
                live: true,
                providerId: candidate.providerId,
                refusedRetryDelaysMs: [1000],
                lease,
                sessionOptions: { warm: true, channelName: plan.channelName || null }
            });
        } catch (err) {
            if (!err.superseded) console.log(`[Warm] could not warm: ${String(err && err.message).split('. ')[0]}`);
            return null;
        } finally {
            starting.delete(owner);
            // Unbound = no session came of it (a direct play, a failed start): the connection goes back.
            coordinator().releaseUnbound(lease);
        }
        if (!decision || !decision.sessionId) return null; // a direct play holds no connection to keep
        if (reclaimedDuringStart) return null;
        if (!sessionAlive(decision.sessionId)) { stats.reclaimed++; return null; } // taken between its start and here

        const e = { owner, key, sourceId: parseInt(sourceId), channelId, sessionId: decision.sessionId, candidate, decision, leaseId: lease.id, timer: null };
        entries.set(owner, e);
        armTimer(e);
        console.log(`[Warm] ${decision.sessionId} is warm on ${candidate.providerName || 'the provider'} for ${Math.round(ttlMs / 1000)}s`);
        return { ttlSec: ttlMs / 1000, refreshed: false };
    } catch (err) {
        console.warn('[Warm] failed:', err && err.message);
        return null;
    }
}

/**
 * A resolve is about to start `key` for `owner`. If the owner has a warm session for something
 * else it ends now (a miss); one for the same channel and needs is returned for the caller to
 * adopt. Null when there is none.
 */
async function forResolve(owner, key, settings) {
    if (!owner) return null;
    pruneDead();
    const e = entries.get(owner);
    if (!e) {
        if (enabled(settings)) stats.misses++;
        return null;
    }
    if (e.key !== key) {
        stats.misses++;
        await end(owner, 'the owner is playing something else');
        return null;
    }
    return e;
}

/**
 * Turn the owner's warm session into an ordinary viewer session and return the resolve decision.
 * Synchronous, so nothing can reclaim it between the caller's check and the conversion.
 */
function adopt(owner) {
    const e = drop(owner);
    if (!e) return null;
    const session = transcodeSession.peekSession(e.sessionId);
    if (!session || session.stopRequested) return null;
    session.options.warm = false;
    session.touch();
    coordinator().convertLease(e.leaseId, 'viewer');
    stats.hits++;
    console.log(`[Warm] ${e.sessionId} adopted by its owner`);
    return { ...e.decision, warm: true, info: { ...e.decision.info, warm: true }, candidate: e.candidate };
}

/** Make the session ordinary at once, before the caller awaits (so nobody reclaims it as warm meanwhile). */
function claim(owner) {
    const e = entries.get(owner);
    if (!e) return null;
    const session = transcodeSession.peekSession(e.sessionId);
    if (!session || session.stopRequested) { drop(owner); return null; }
    session.options.warm = false;
    return e;
}

/** Give a claimed entry back to the warm state (the admission that followed said no). */
function unclaim(owner) {
    const e = entries.get(owner);
    if (!e) return;
    const session = transcodeSession.peekSession(e.sessionId);
    if (session) session.options.warm = true;
}

function status(settings) {
    pruneDead();
    return { enabled: enabled(settings), active: entries.size, hits: stats.hits, misses: stats.misses, expired: stats.expired, reclaimed: stats.reclaimed };
}

/** End every warm session (shutdown, tests). */
async function endAll(why = 'stopped') {
    for (const owner of [...entries.keys()]) await end(owner, why);
}

function _setTtl(ms) { ttlMs = ms === null ? WARM_TTL_MS : ms; }

function _reset() {
    for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
    entries.clear();
    starting.clear();
    watching.clear();
    stats.hits = stats.misses = stats.expired = stats.reclaimed = 0;
}

module.exports = {
    WARM_TTL_MS, enabled, keyFor, warm, forResolve, claim, unclaim, adopt, end, endAll, noteReclaimed, noteWatching, isWatching, status,
    _entries: entries, _reset, _setTtl
};
