'use strict';
/**
 * #272 (D-3): the ESPN part of a sport page, kept stale-while-refreshing. The NFL, F1, league, cricket and events pages
 * each carried their own copy of this and cleared `refreshing` three different ways; this is the one.
 *
 *   get(key, now, build) -> { value, at, ttl } | null
 *
 * - An entry is fresh while `now - at < ttl` (`ttlOf(value, now)` when it was stored). A fresh entry is returned as is.
 * - A stale or missing entry starts ONE build for the key; concurrent callers share it (`build(prior)`, `prior` the
 *   stale entry or null). The caller of a stale entry gets the stale entry at once (stale-while-refreshing).
 * - With no entry at all, the caller waits for that build, at most `coldWaitMs`, then gets null (the build carries on).
 * - A build that returns a falsy value (ESPN did not answer) stores nothing; one that throws or rejects is logged and
 *   stores nothing. Either way the in-flight marker is cleared (in a `finally`, by identity, so a build that outlives
 *   a reset() cannot clear a newer build's marker), and the next call tries again.
 * - reset() forgets everything, and a build started before it does not store its result.
 * - `maxEntries` bounds a keyed cache: storing past it drops the oldest entry.
 *
 *   renew(key, now, build, { gapMs, waitMs }) -> { value, at, ttl } | null
 *
 * #297: the score collector has seen a game, session or event move on from what the entry says (its detail read is
 * older). Starts ONE build whatever the entry's age, at most once per `gapMs` (default 30 s) per key, so a feed that keeps
 * disagreeing with the collector costs one build per gap, never one per request; then waits for it at most `waitMs`
 * (default the cold wait). Returns the entry as it then stands (the old one if the build has not landed or failed).
 */
const RENEW_GAP_MS = 30000;

function createPageCache({ label, ttlOf, coldWaitMs, maxEntries = Infinity }) {
    const entries = new Map(); // key -> { value, at, ttl }
    const refreshing = new Map(); // key -> the build in flight
    let generation = 0;
    const waitMs = () => (typeof coldWaitMs === 'function' ? coldWaitMs() : coldWaitMs);

    function start(key, now, build, cached) {
        const mine = generation;
        const p = new Promise((resolve) => resolve(build(cached || null))).then((value) => {
            if (!value || mine !== generation) return;
            entries.delete(key);
            entries.set(key, { value, at: now, ttl: ttlOf(value, now) });
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        }).catch((err) => console.warn(`[Sport] ${label} page refresh failed:`, err.message))
            .finally(() => { if (refreshing.get(key) === p) refreshing.delete(key); });
        refreshing.set(key, p);
    }

    async function wait(key, ms) {
        let timer;
        await Promise.race([refreshing.get(key), new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
        clearTimeout(timer);
    }

    async function get(key, now, build) {
        const cached = entries.get(key);
        const fresh = cached && now - cached.at < cached.ttl;
        if (!fresh && !refreshing.has(key)) start(key, now, build, cached);
        if (!entries.has(key) && refreshing.has(key)) await wait(key, waitMs());
        return entries.get(key) || null;
    }

    const renewedAt = new Map(); // key -> when renew() last started a build
    async function renew(key, now, build, { gapMs = RENEW_GAP_MS, waitMs: renewWait = waitMs() } = {}) {
        if (!refreshing.has(key)) {
            const last = renewedAt.get(key);
            if (last !== undefined && now - last < gapMs && now >= last) return entries.get(key) || null;
            renewedAt.set(key, now);
            while (renewedAt.size > 64) renewedAt.delete(renewedAt.keys().next().value);
            start(key, now, build, entries.get(key) || null);
        }
        if (refreshing.has(key)) await wait(key, renewWait);
        return entries.get(key) || null;
    }

    function reset() { entries.clear(); refreshing.clear(); renewedAt.clear(); generation++; }

    return { get, renew, reset, inFlight: () => refreshing.size, size: () => entries.size };
}

module.exports = { createPageCache, RENEW_GAP_MS };
