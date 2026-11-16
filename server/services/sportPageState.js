'use strict';
/**
 * #272 (batch D, owner's call of 11 Nov 2026): a sport page's games take their STATE (status, detail, score) from the
 * score collector's store, as the front page does, so for the same account at the same moment a game reads the same on
 * both. The page's own ESPN answer (its cache) keeps everything else, and is account-independent: this account's view
 * is laid over it per request, after the cache.
 *
 * - The account's score delay (C-O `scoreDelaySeconds`, the front page's) picks the snapshot: the newest at or before
 *   now − delay (sportsDashboardStore.delayed), as the front's card.
 * - A snapshot is used only while it is fresh by the front's rule (confirmed within delay + 2 min), or once final; else,
 *   and whenever the collector holds nothing for the game (collector off, a league or game it does not hold, the first
 *   minutes after start, a 429 cooldown aging it), the page keeps its own answer, exactly as before.
 * - Hiding scores is not applied here: the front leaves scores out when the household's spoiler-free switch is on, and
 *   the pages always send them and the client hides them by that same switch (C-P, C-Q, C-T), unchanged.
 *
 * deps(userId, now) -> { state(cardId) -> { snapshot } | null, event(cardId) -> { snapshot } | null, covered(league) -> boolean,
 * delay } or {} with the collector off. `delay`: the account's score delay in seconds (#328: the Events page shows its own
 * read from at least that long ago while the event is on). `event`: a tennis, golf, UFC or racing card (#297), whose snapshot has no page facts (its
 * state is already the Events page's word, C-V), fresh by the front's rule for those leagues (a break, polled every
 * BREAK_POLL, stays fresh that much longer).
 * `covered`: the collector has wholly answered the league's window within the last 30 minutes, so a page need not
 * re-read ESPN's scoreboard every 2 minutes while a game is on (its state comes from here).
 */
const FRESH_ALLOWANCE_MS = 120000; // sportsDashboard.buildDashboard's
const COVERED_MS = 30 * 60000;

function deps(userId, now = Date.now()) {
    const dashboard = require('./sportsDashboard');
    if (!dashboard.collectorEnabled()) return {};
    let store;
    try { store = dashboard.store(); } catch { return {}; }
    let delay = 90;
    try { delay = store.preferences(userId).scoreDelaySeconds; } catch { /* the default */ }
    const state = (cardId) => {
        if (!cardId) return null;
        let seen;
        try { seen = store.delayed(cardId, now, delay); } catch { return null; }
        if (!seen?.data?.espn) return null; // nothing yet, or a snapshot stored before the page facts were kept
        const fresh = now - seen.observedAt <= delay * 1000 + FRESH_ALLOWANCE_MS;
        return fresh || seen.data.state === 'finished' ? { snapshot: seen.data, observedAt: seen.observedAt } : null;
    };
    // #297: the Events page's cards (sportIndividual), fresh as the front reads them (sportsDashboard.buildDashboard)
    const event = (cardId) => {
        if (!cardId) return null;
        let seen;
        try { seen = store.delayed(cardId, now, delay); } catch { return null; }
        const s = seen?.data?.state;
        if (typeof s !== 'string' || s === 'unknown') return null;
        const allowance = s === 'break' ? dashboard.BREAK_POLL + FRESH_ALLOWANCE_MS : FRESH_ALLOWANCE_MS;
        const fresh = now - seen.observedAt <= delay * 1000 + allowance;
        return fresh || s === 'finished' ? { snapshot: seen.data, observedAt: seen.observedAt } : null;
    };
    const covered = (league) => {
        try {
            const row = require('../db/sqlite').getDb().prepare('SELECT observed_at FROM sports_dashboard_coverage WHERE league = ?').get(league);
            return Boolean(row) && now - row.observed_at <= COVERED_MS;
        } catch { return false; }
    };
    return { state, event, covered, delay };
}

/** The score of `side` ('home' | 'away') in a snapshot, as a page's string, or null. */
function scoreOf(snapshot, side) {
    const i = (snapshot.espn?.sides || []).indexOf(side);
    const v = i >= 0 && Array.isArray(snapshot.scores) ? snapshot.scores[i] : null;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** ESPN's status as a page's detail function reads it (`c.status`), rebuilt from the snapshot's page facts. */
function competitionOf(snapshot) {
    const e = snapshot.espn || {};
    return { status: { type: { shortDetail: e.detail || undefined }, displayClock: e.clock ?? undefined, period: e.period ?? undefined } };
}

/**
 * #297: how far on a status word is: 0 before (scheduled), 1 on (live, a break, suspended in play), 2 over (done,
 * finished, postponed, cancelled); null for a word with no place (unknown). The F1, Cricket and Events pages compare the
 * collector's word for the account with their own read's: further on means their read is older than the collector's,
 * so they renew it (sportPageCache.renew) before showing the collector's word; behind means their read is newer than
 * the account's delayed view, so they show the collector's word without what belongs to the later state (a result).
 */
const RANK = { scheduled: 0, live: 1, break: 1, suspended: 1, done: 2, finished: 2, postponed: 2, cancelled: 2 };
const rank = (word) => (Object.hasOwn(RANK, word) ? RANK[word] : null);

module.exports = { deps, scoreOf, competitionOf, rank, FRESH_ALLOWANCE_MS, COVERED_MS };
