/**
 * #197 (D-41 points 5 and 6): the sports followed by individuals, from ESPN, as the score collector's games (the shape
 * sportsScoresEspn.normalize gives). One card per event, never per match: ESPN lists a tennis tournament as its draws
 * (hundreds of matches), a golf tournament as one leaderboard, a UFC night as its bouts, and an IndyCar or NASCAR Cup
 * weekend as its race only (no practice or qualifying times). Shapes checked on 1 Nov 2026.
 *
 *   Grand Slams      ATP's feed, the events it marks `major` (every draw, men's and women's, is in it)
 *   ATP Tour, WTA Tour  their feeds without the majors (WTA's feed repeats each major: never taken from it)
 *   Majors           PGA Tour's feed, the four men's majors by name; PGA Tour the rest of it
 *   DP World Tour, LIV, LPGA  their feeds (the women's majors stay under LPGA)
 *   UFC              by date, one card per night from the first bout to the last bout's start plus FIGHT_TAIL
 *   IndyCar, NASCAR  by date, one card per race, RACE_LENGTH long
 *
 * A card's `players` are the names in its draw, field, card or entry list, what a followed player, fighter or driver is
 * found by (sportsDashboard.followMatchesFor); they never reach a client. Tennis and golf ask for this week's events
 * (no date): a tournament spans days, and its feed is large (a Grand Slam's is ~1.9 MB), so MAX_BYTES is its own.
 */
const LEAGUES = {
    'Grand Slams': { path: 'tennis/atp', kind: 'tennis', major: true },
    'ATP Tour': { path: 'tennis/atp', kind: 'tennis', major: false },
    'WTA Tour': { path: 'tennis/wta', kind: 'tennis', major: false },
    Majors: { path: 'golf/pga', kind: 'golf', major: true },
    'PGA Tour': { path: 'golf/pga', kind: 'golf', major: false },
    'DP World Tour': { path: 'golf/eur', kind: 'golf' },
    LIV: { path: 'golf/liv', kind: 'golf' },
    LPGA: { path: 'golf/lpga', kind: 'golf' },
    UFC: { path: 'mma/ufc', kind: 'fight', dated: true },
    IndyCar: { path: 'racing/irl', kind: 'race', dated: true },
    NASCAR: { path: 'racing/nascar-premier', kind: 'race', dated: true }
};
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_PLAYERS = 800;
const H = 3600000;
const FIGHT_TAIL = 4 * H;
const RACE_LENGTH = 4 * H;
// ESPN's golf endDate is the start (US Eastern midnight) of the last round's day.
const LAST_ROUND_DAY = 24 * H;
const GOLF_MAJOR = /^(?:Masters Tournament|PGA Championship|U\.S\. Open|The Open(?: Championship)?)$/i;

const has = (league) => Object.hasOwn(LEAGUES, league);
const text = (v, max = 160) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const id = (v) => /^[A-Za-z0-9_-]{1,80}$/.test(String(v ?? '')) ? String(v) : null;
const time = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

const { personKey } = require('./textFold'); // accents, case, punctuation and the Nordic letters ignored

const { espnState } = require('./espnState');
/** #272 (0548): a match, bout, round or event in C-O/C-V's words: espnState's own, a pause in a match is play (no break of its own). */
function stateOf(status) {
    const { state } = espnState(status);
    return state === 'break' ? 'live' : state;
}

/** The names of one competitor: a player, or a doubles pair's two. */
function namesOf(competitor) {
    const pair = competitor?.roster?.athletes;
    return (Array.isArray(pair) ? pair : [competitor?.athlete]).map(a => text(a?.displayName, 80)).filter(n => n && n !== 'TBD');
}
// A tournament's own status can't be trusted (the Paris Masters said "Final" on its second day): its matches say. Play
// on: live; matches still to come after some were played: a break between them; none to come: finished.
function tennisState(matches) {
    const states = matches.map(c => stateOf(c?.status));
    if (states.includes('live')) return ['live'];
    if (states.includes('scheduled')) return states.includes('finished') ? ['break', 'Between matches'] : ['scheduled'];
    return states.length && states.every(s => ['finished', 'cancelled'].includes(s)) ? ['finished'] : ['unknown'];
}
// A golf round's status says "Play Complete" each evening: the event's says whether the tournament goes on.
function golfState(event, round) {
    const state = stateOf(event?.status || round?.status), played = stateOf(round?.status);
    if (state === 'live' && played === 'finished') {
        const n = round?.status?.period;
        return ['break', Number.isInteger(n) && n > 0 ? `Round ${n} complete` : 'Between rounds'];
    }
    return [state];
}
const snapshot = ([state, breakLabel], progress = {}) => ({ state, ...(breakLabel ? { breakLabel } : {}), progress, scores: null, situation: null });
function playersOf(competitions) {
    const out = new Set();
    for (const c of competitions) for (const x of Array.isArray(c?.competitors) ? c.competitors : []) {
        for (const n of namesOf(x)) if (out.size < MAX_PLAYERS) out.add(n);
    }
    return [...out].sort((a, b) => a.localeCompare(b)); // by name: a leaderboard's or a result's order is never kept
}
function place(venue) {
    const name = text(venue?.fullName || venue?.displayName);
    if (!name) return null;
    const [city, country] = name.includes(',') && !venue?.address ? name.split(',').map(s => s.trim()) : [text(venue?.address?.city), text(venue?.address?.country)];
    return { name, city: city || '', country: country || '' };
}
const card = (fields) => ({ end: null, format: null, session: null, circuit: null, competitors: [], ...fields });

/** The collector's games for `league` from one answer of its ESPN feed (`source` its path). */
function normalize(json, league, source) {
    const spec = LEAGUES[league];
    if (!spec || source !== spec.path || !Array.isArray(json?.events)) return [];
    const out = [];
    for (const e of json.events.slice(0, 200)) {
        const eventId = id(e?.id), title = text(e?.name);
        if (!eventId || !title) continue;
        const base = { id: `espn:${source}:${eventId}`, league, title };
        if (spec.kind === 'tennis') {
            if ((e.major === true) !== spec.major) continue;
            const start = time(e.date), end = time(e.endDate);
            if (start === null) continue;
            const matches = (Array.isArray(e.groupings) ? e.groupings : []).flatMap(g => Array.isArray(g?.competitions) ? g.competitions : []);
            out.push(card({ ...base, start, end, circuit: place(e.venue), players: playersOf(matches), snapshot: snapshot(tennisState(matches)) }));
        } else if (spec.kind === 'golf') {
            if (spec.major !== undefined && GOLF_MAJOR.test(title) !== spec.major) continue;
            const c = Array.isArray(e.competitions) ? e.competitions[0] : null;
            const start = time(c?.date || e.date), last = time(c?.endDate || e.endDate);
            if (start === null) continue;
            const round = Number.isInteger(c?.status?.period) && c.status.period > 0 ? c.status.period : undefined;
            out.push(card({ ...base, start, end: last === null ? null : last + LAST_ROUND_DAY, circuit: place(c?.venue), players: playersOf([c]),
                snapshot: snapshot(golfState(e, c), round ? { period: round } : {}) }));
        } else if (spec.kind === 'fight') {
            const bouts = (Array.isArray(e.competitions) ? e.competitions : []).filter(c => time(c?.date) !== null);
            const starts = bouts.map(c => time(c.date));
            const start = starts.length ? Math.min(...starts) : time(e.date);
            if (start === null) continue;
            const venue = Array.isArray(e.venues) ? e.venues[0] : bouts[0]?.venue;
            out.push(card({ ...base, start, end: (starts.length ? Math.max(...starts) : start) + FIGHT_TAIL, circuit: place(venue),
                players: playersOf(bouts), snapshot: snapshot([stateOf(e.status)]) }));
        } else {
            const c = Array.isArray(e.competitions) ? e.competitions[0] : null;
            const start = time(c?.date || e.date);
            if (start === null) continue;
            out.push(card({ ...base, start, end: start + RACE_LENGTH, session: 'Race', circuit: place(e.circuit || c?.venue), players: playersOf([c]),
                snapshot: snapshot([stateOf(c?.status || e.status)]) }));
        }
    }
    return out;
}

// 0428 (C-V): the events page (sportPageEvents.js) reads the same events with the same helpers, so its ids, dates and
// states are the cards'.
module.exports = { LEAGUES, MAX_BYTES, has, normalize, personKey, stateOf, place, text, time };
