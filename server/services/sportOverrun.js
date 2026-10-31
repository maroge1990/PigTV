/**
 * #191 (0386): a live game that overruns its guide slot keeps its channels. Guide (C-I) airing ends are the guide's, so a
 * game running past its slot would lose Watch on every sport surface (clients require a channel's `end > now`). While the
 * score feed says the game is ongoing (as the surface already reports it to this user), a channel whose airing of that
 * game ended no more than OVERRUN_MAX ago is projected as still airing until now + OVERRUN_STEP: rolling, so each refresh
 * pushes it on, and it lapses within OVERRUN_STEP of the feed saying anything else (or of the client not refreshing).
 * The one rule every surface uses (C-O, C-P, C-Q, C-R, C-S). Pure.
 */
const OVERRUN_MAX = 4 * 60 * 60 * 1000;
const OVERRUN_STEP = 10 * 60 * 1000;

/** The projected end of an airing that ended at `end`, or null when it is not extended (not ongoing, not ended, too old). */
function overrunEnd(end, ongoing, now) {
    if (!ongoing || !Number.isFinite(end) || !Number.isFinite(now) || end > now || now - end > OVERRUN_MAX) return null;
    return now + OVERRUN_STEP;
}

/**
 * A sport page's C-I channel `ch` of a matched airing `event`, as the page lists it at `now`: extended (`end` rolled on,
 * `overrun: true`) by the rule above; null for an airing that has ended and is not extended (leagueEvents `ended` hands
 * those over for this rule alone); else unchanged. Without a `now`, unchanged (callers before 0386).
 */
function keep(ch, event, ongoing, now) {
    if (!Number.isFinite(now)) return ch;
    const extended = overrunEnd(Number.isFinite(ch.end) ? ch.end : event.end, ongoing, now);
    if (extended !== null) return { ...ch, end: extended, overrun: true };
    return event.end <= now ? null : ch;
}

module.exports = { OVERRUN_MAX, OVERRUN_STEP, overrunEnd, keep };
