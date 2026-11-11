/**
 * #272 (D-4a, 0548): ESPN's game status, read once. Before 0548 six copies (the score collector, the individual sports,
 * the League, NFL, F1 and Cricket pages) each mapped `status.type` into their own words, and disagreed about the rare
 * ones (a postponed or suspended game, a forfeit, an unknown state). Every one now asks espnState() and translates its
 * one internal answer to its contract's words at its own edge, with a small table there:
 *   C-O/C-R/C-V `finished`… (sportsScoresEspn, sportIndividual); C-P, C-Q, C-S, C-T `done`… (the four pages).
 *
 * Internal vocabulary: scheduled | live | break | suspended | postponed | cancelled | finished | unknown. A break has a
 * label from BREAKS and only while ESPN says the game is on (`state: 'in'`); each edge decides which labels its contract
 * knows (the others are play, `live`, as before 0548).
 * Honest states: an unknown state is `unknown` (never guessed live or finished); a postponed game is `postponed`, never
 * `scheduled` at its old time; `completed` is ESPN's own word for a result (a forfeit or walkover is finished).
 *
 * Reads `status.type` { name, description, state, completed, shortDetail, detail } and, for cricket, `status.summary`.
 * Options: `cricket` (ESPN keeps a match that has not started "in" play, summarised "Starts at …"), `baseball` (the end of
 * an inning is not a break).
 */
// ESPN's status words (`name` and `description`), in order: the first that fits names the break.
const BREAKS = [
    [/stumps/i, 'Stumps'], [/half.?time/i, 'Half-time'], [/rain/i, 'Rain delay'], [/lunch/i, 'Lunch'], [/\btea\b/i, 'Tea'],
    [/dinner/i, 'Dinner'], [/innings.?break/i, 'Innings break'], [/intermission/i, 'Intermission'],
    [/three.?quarter|quarter.?time/i, 'Quarter-time'], [/delay/i, 'Delayed']
];
// The free text beside them (`shortDetail`, `detail`: "HT", "End of 1st") is read only for these pause words (the League
// page's, before 0548): a detail can name a place ("Bahrain"), so the whole list is not run over it. A detail saying
// "suspended" is a pause ('Suspended'), not ESPN's suspended state, which only its status words set.
const DETAIL_BREAKS = [[/suspend/i, 'Suspended'], [/half.?time|\bHT\b/i, 'Half-time'], [/three.?quarter|quarter.?time/i, 'Quarter-time'], [/intermission/i, 'Intermission'], [/delay/i, 'Delayed']];
const END_OF_PERIOD = /end.?period|end of (?:the )?(?:\d|first|second|third|fourth)/i;
const STATES = Object.freeze(['scheduled', 'live', 'break', 'suspended', 'postponed', 'cancelled', 'finished', 'unknown']);

/** -> { state, breakLabel } (breakLabel null unless state is 'break'). Never throws. */
function espnState(status, { cricket = false, baseball = false } = {}) {
    const s = status && typeof status === 'object' ? status : {};
    const t = s.type && typeof s.type === 'object' ? s.type : {};
    const said = `${t.name || ''} ${t.description || ''}`;
    const detail = `${t.shortDetail || ''} ${t.detail || ''}`;
    const out = (state, breakLabel = null) => ({ state, breakLabel });
    if (/cancel|abandon/i.test(said)) return out('cancelled');
    if (/postpon/i.test(said)) return out('postponed');
    if (/suspend/i.test(said)) return out('suspended');
    if (t.completed === true || t.state === 'post') return out('finished');
    if (t.state === 'pre' || (cricket && /^Starts (?:at|in)/i.test(typeof s.summary === 'string' ? s.summary : ''))) return out('scheduled');
    if (t.state !== 'in') return out('unknown'); // a pause word without ESPN saying the game is on is not a break
    for (const [re, label] of BREAKS) if (re.test(said)) return out('break', label);
    for (const [re, label] of DETAIL_BREAKS) if (re.test(detail)) return out('break', label);
    if (!baseball && END_OF_PERIOD.test(`${said} ${detail}`)) return out('break', 'End of period');
    return out('live');
}

module.exports = { espnState, STATES, BREAK_LABELS: Object.freeze([...new Set([...BREAKS.map(([, l]) => l), 'End of period'])]) };
