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
 */
function createPageCache({ label, ttlOf, coldWaitMs, maxEntries = Infinity }) {
    const entries = new Map(); // key -> { value, at, ttl }
    const refreshing = new Map(); // key -> the build in flight
    let generation = 0;
    const waitMs = () => (typeof coldWaitMs === 'function' ? coldWaitMs() : coldWaitMs);

    async function get(key, now, build) {
        const cached = entries.get(key);
        const fresh = cached && now - cached.at < cached.ttl;
        if (!fresh && !refreshing.has(key)) {
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
        if (!entries.has(key) && refreshing.has(key)) {
            let timer;
            await Promise.race([refreshing.get(key), new Promise(resolve => { timer = setTimeout(resolve, waitMs()); })]);
            clearTimeout(timer);
        }
        return entries.get(key) || null;
    }

    function reset() { entries.clear(); refreshing.clear(); generation++; }

    return { get, reset, inFlight: () => refreshing.size, size: () => entries.size };
}

module.exports = { createPageCache };
