/**
 * #203 (D-42 point 5): coverage before play. A game or session whose coverage is on air while play starts within
 * ON_AIR_LEAD reads "On air · starts 3:10" with the live dot, Watch and a place among live (the wording is the
 * client's). The server only marks it: `onAir: true` on the card (C-O, C-R) or session (C-P); its `status` stays
 * `scheduled` and its start is unchanged, so it is never read as a result.
 *
 * "Coverage on" is a matched airing on a channel whose own airing (C-I channel `start`/`end`, 0337) has begun and not
 * ended. Every sport, not only F1. Pure.
 */
const ON_AIR_LEAD = 30 * 60 * 1000;

/** True when `status` is scheduled, play starts in (0, ON_AIR_LEAD] from `now`, and one of `airings` ({ start, end }) is on. */
function onAir({ status, start, now, airings }) {
    if (status !== 'scheduled' || !Number.isFinite(start) || !Number.isFinite(now)) return false;
    if (!(start > now && start - now <= ON_AIR_LEAD)) return false;
    return (airings || []).some(a => Number.isFinite(a?.start) && Number.isFinite(a?.end) && a.start <= now && now < a.end);
}

/** Each channel's own airing of C-I `events` ({ start, end, channels: [{ start, end }] }), a channel's missing time its event's. */
function channelAirings(events) {
    return (events || []).flatMap(e => (e?.channels || []).map(c => ({ start: c?.start ?? e.start, end: c?.end ?? e.end })));
}

module.exports = { ON_AIR_LEAD, onAir, channelAirings };
