/**
 * #191 (0386): a live game that overruns its guide slot keeps its channels. Guide (C-I) airing ends are the guide's, so a
 * game running past its slot would lose Watch on every sport surface (clients require a channel's `end > now`). While the
 * score feed says the game is ongoing (as the surface already reports it to this user), a channel whose airing of that
 * game ended no more than OVERRUN_MAX ago is projected as still airing until now + OVERRUN_STEP: rolling, so each refresh
 * pushes it on, and it lapses within OVERRUN_STEP of the feed saying anything else (or of the client not refreshing).
 * The one rule every surface uses (C-O, C-P, C-Q, C-R, C-S). Pure.
 */
const { ON_AIR_LEAD } = require('./sportOnAir');

const OVERRUN_MAX = 4 * 60 * 60 * 1000;
const OVERRUN_STEP = 10 * 60 * 1000;
// A sport page's status counts as ongoing for the rule only while its ESPN answer is at most this old (F1's 10 min
// live cache plus margin): a page serving an old answer after failed refreshes must not keep renewing Watch.
const PAGE_FRESH_MS = 15 * 60 * 1000;

/** The projected end of an airing that ended at `end`, or null when it is not extended (not ongoing, not ended, too old). */
function overrunEnd(end, ongoing, now) {
    if (!ongoing || !Number.isFinite(end) || !Number.isFinite(now) || end > now || now - end > OVERRUN_MAX) return null;
    return now + OVERRUN_STEP;
}

/**
 * A sport page's C-I channel `ch` of a matched airing `event`, as the page lists it at `now`: extended (`end` rolled on,
 * `overrun: true`) by the rule above while the page says ongoing from an ESPN answer fetched at `observedAt` no more
 * than PAGE_FRESH_MS ago; null for an airing that has ended and is not extended (leagueEvents `ended` hands those over
 * for this rule alone); else unchanged. Without a `now`, unchanged (callers before 0386).
 */
function keep(ch, event, ongoing, now, observedAt) {
    if (!Number.isFinite(now)) return ch;
    const fresh = Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= PAGE_FRESH_MS;
    const extended = overrunEnd(Number.isFinite(ch.end) ? ch.end : event.end, ongoing && fresh, now);
    if (extended !== null) return { ...ch, end: extended, overrun: true };
    return event.end <= now ? null : ch;
}

/**
 * #217: the same rule for a recording of a sport event (recordingGuideEnd.eventStop links the schedule to its game and
 * reads the score collector's stored answer, `latest` = sportsDashboardStore.latest(): { observedAt, finishedAt, data }).
 * `floor` is the guide end + post-padding: a recording never stops before it, and never more than OVERRUN_MAX after it.
 *   - The feed says finished: stop at max(floor, the moment it first said so + `postMs`). A final whose moment was never
 *     seen (the game was already over when first read) gives the floor.
 *   - A fresh answer (at most PAGE_FRESH_MS old) says the game is being played (live, suspended, a break within play;
 *     never stumps, nor a tournament between matches, as the collector's inPlay), or still `scheduled` with play due
 *     within ON_AIR_LEAD (coverage on air, 0423): stop at now + OVERRUN_STEP (from the floor), rolled on at each check.
 *   - Anything else (stale, unknown, cancelled...): no change. Before any extension that is the floor, as before #217;
 *     an extension lapses within OVERRUN_STEP.
 * -> the event stop (ms), null for none (stop at the floor), or undefined for no change. Pure.
 */
function recordingEnd({ floor, postMs = 0, now, latest, gameStart = null, individual = false }) {
    if (!Number.isFinite(floor) || !Number.isFinite(now) || !latest || !latest.data) return undefined;
    const cap = floor + OVERRUN_MAX;
    const { state, breakLabel } = latest.data;
    if (state === 'finished') {
        if (!Number.isFinite(latest.finishedAt)) return null;
        const end = Math.min(cap, latest.finishedAt + (Number.isFinite(postMs) ? postMs : 0));
        return end > floor ? end : null;
    }
    const at = latest.observedAt;
    if (!(Number.isFinite(at) && at <= now && now - at <= PAGE_FRESH_MS)) return undefined;
    const playing = individual ? state === 'live'
        : state === 'live' || state === 'suspended' || (state === 'break' && breakLabel !== 'Stumps');
    const coverage = state === 'scheduled' && Number.isFinite(gameStart) && gameStart > now && gameStart - now <= ON_AIR_LEAD;
    if (!playing && !coverage) return undefined;
    const rolled = overrunEnd(floor, true, Math.max(now, floor));
    return rolled === null ? undefined : Math.min(cap, rolled);
}

module.exports = { OVERRUN_MAX, OVERRUN_STEP, PAGE_FRESH_MS, overrunEnd, keep, recordingEnd };
