/**
 * ESPN's free public scoreboard JSON (0161+), the provider services/sportsFixtures.js uses for
 * real kickoff/session times: this is where sportsClassify.resolveLive's fixture rule gets its
 * ground truth from, instead of guessing live vs replay from the guide alone.
 *
 * Verified 28 Sept 2026, no key needed:
 *   https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard  (?dates=YYYYMMDD, one UTC day)
 *   https://site.api.espn.com/apis/site/v2/sports/{path}/teams      (a league's roster; 404 for a
 *     cricket league id - cricket's own scoreboard responses carry a `teams` array instead, which
 *     fetchScoreboard also collects, so sportsFixtures.js always has a teams fallback)
 *   https://site.api.espn.com/apis/site/v2/sports/cricket/scorepanel (today's active cricket
 *     series, with their league ids - how international Tests/ODIs/T20Is, which have no fixed
 *     league id, are found at all)
 *
 * This is an unofficial, undocumented feed: every field is read defensively (optional; the wrong
 * shape is just ignored) and nothing here ever throws - a failure comes back as { ok: false,
 * error }, so one bad day or one league's outage can never take the whole refresh down, let alone
 * a request.
 *
 * Provider-shaped (fetchScoreboard / fetchTeams / discoverCricketSeries) on purpose: a second
 * source can be added to sportsFixtures.js later without either module changing shape.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TIMEOUT_MS = 10000;

async function getJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : '?'}` };
        let json;
        try { json = await res.json(); } catch { return { ok: false, error: 'not JSON' }; }
        return { ok: true, json };
    } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || 'request failed' };
    } finally {
        clearTimeout(timer);
    }
}

const pad2 = (n) => String(n).padStart(2, '0');
/** YYYYMMDD (UTC) for every day a [fromMs, toMs] window touches, ESPN's ?dates= unit. */
function datesFor(fromMs, toMs) {
    const out = [];
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return out;
    const start = new Date(fromMs);
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const end = new Date(toMs);
    let guard = 0;
    while (cursor.getTime() <= end.getTime() && guard++ < 200) {
        out.push(`${cursor.getUTCFullYear()}${pad2(cursor.getUTCMonth() + 1)}${pad2(cursor.getUTCDate())}`);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
}

/** A team/athlete-competitor's name fields, as far as they exist. */
function teamFields(team) {
    if (!team || typeof team !== 'object') return null;
    const out = {
        displayName: typeof team.displayName === 'string' ? team.displayName : null,
        shortDisplayName: typeof team.shortDisplayName === 'string' ? team.shortDisplayName : null,
        name: typeof team.name === 'string' ? team.name : null,
        location: typeof team.location === 'string' ? team.location : null,
        abbreviation: typeof team.abbreviation === 'string' ? team.abbreviation : null
    };
    return out.displayName || out.shortDisplayName || out.name || out.abbreviation ? out : null;
}

/** One ESPN "competition" (a whole event, or one of an F1 event's sessions) -> a plain record, or null. */
function competitionRecord(event, comp) {
    if (!comp || typeof comp !== 'object') return null;
    const start = Date.parse(comp.date || (event && event.date) || '');
    if (!Number.isFinite(start)) return null;
    const end = Date.parse(comp.endDate || (event && event.endDate) || '');
    const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
    const teams = competitors.map(c => teamFields(c && c.team)).filter(Boolean).slice(0, 2);
    const id = String((comp.id != null ? comp.id : event && event.id) || '');
    if (!id) return null;
    return {
        id,
        eventName: (event && (event.name || event.shortName)) || null,
        sessionAbbr: (comp.type && typeof comp.type === 'object' && typeof comp.type.abbreviation === 'string') ? comp.type.abbreviation : null,
        start,
        end: Number.isFinite(end) ? end : null,
        state: (comp.status && comp.status.type && comp.status.type.state) || (event && event.status && event.status.type && event.status.type.state) || null,
        teams: teams.length === 2 ? teams : null
    };
}

/** Every competition in an ESPN scoreboard payload (one event = one record, or several for F1's per-session competitions). */
function recordsFromScoreboard(json) {
    const events = Array.isArray(json && json.events) ? json.events : [];
    const out = [];
    for (const event of events) {
        const comps = Array.isArray(event && event.competitions) && event.competitions.length ? event.competitions : [event];
        for (const comp of comps) {
            const rec = competitionRecord(event, comp);
            if (rec) out.push(rec);
        }
    }
    return out;
}

/** Every team named anywhere in a scoreboard payload (its own `teams` array, cricket's style, plus every competitor), deduplicated. */
function teamsFromScoreboard(json) {
    const byKey = new Map();
    const add = (raw) => {
        const t = teamFields(raw);
        if (!t) return;
        const key = (t.displayName || t.abbreviation || '').toLowerCase();
        if (key && !byKey.has(key)) byKey.set(key, t);
    };
    for (const t of Array.isArray(json && json.teams) ? json.teams : []) add(t);
    for (const event of Array.isArray(json && json.events) ? json.events : []) {
        for (const comp of Array.isArray(event && event.competitions) ? event.competitions : []) {
            for (const c of Array.isArray(comp && comp.competitors) ? comp.competitors : []) add(c && c.team);
        }
    }
    return [...byKey.values()];
}

/**
 * Every competition ESPN reports for `leaguePath` over [fromMs, toMs] (one request per UTC day
 * touched - the API's own unit). -> { ok, records, teams, error }; `error` is set only when every
 * day failed. A day that fails is just skipped, so one bad day never loses the others.
 */
async function fetchScoreboard(leaguePath, fromMs, toMs, { timeoutMs = TIMEOUT_MS } = {}) {
    const days = datesFor(fromMs, toMs);
    const records = new Map(); // id + session -> record
    const teams = new Map();
    let anyOk = false;
    let lastError = 'no dates to fetch';
    for (const day of days) {
        const { ok, json, error } = await getJson(`${BASE}/${leaguePath}/scoreboard?dates=${day}`, timeoutMs);
        if (!ok) { lastError = error; continue; }
        anyOk = true;
        for (const rec of recordsFromScoreboard(json)) records.set(`${rec.id}\u0001${rec.sessionAbbr || ''}`, rec);
        for (const t of teamsFromScoreboard(json)) teams.set((t.displayName || t.abbreviation || '').toLowerCase(), t);
    }
    if (!anyOk) return { ok: false, error: lastError };
    return { ok: true, records: [...records.values()], teams: [...teams.values()] };
}

/** A league's roster from its dedicated /teams endpoint (cricket league ids 404 here - see fetchScoreboard's own fallback). */
async function fetchTeams(leaguePath, { timeoutMs = TIMEOUT_MS } = {}) {
    const { ok, json, error } = await getJson(`${BASE}/${leaguePath}/teams`, timeoutMs);
    if (!ok) return { ok: false, error };
    const leagues = (json && json.sports && json.sports[0] && json.sports[0].leagues) || [];
    const teams = [];
    for (const lg of leagues) {
        for (const entry of Array.isArray(lg && lg.teams) ? lg.teams : []) {
            const t = teamFields(entry && entry.team);
            if (t) teams.push(t);
        }
    }
    return { ok: true, teams };
}

/**
 * Today's active cricket series (ESPN's homepage "scorepanel"), each with its own league id -
 * international cricket has no fixed one, unlike IPL (8048) and Big Bash (8044), so this is how
 * a Test/ODI/T20I series is found at all. Bounded to a sane number of series by the caller.
 */
async function discoverCricketSeries({ timeoutMs = TIMEOUT_MS } = {}) {
    const { ok, json, error } = await getJson(`${BASE}/cricket/scorepanel`, timeoutMs);
    if (!ok) return { ok: false, error };
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(json && json.scores) ? json.scores : []) {
        for (const lg of Array.isArray(s && s.leagues) ? s.leagues : []) {
            const id = lg && lg.id != null ? String(lg.id) : null;
            if (id && !seen.has(id)) { seen.add(id); out.push({ id, name: (lg && lg.name) || null }); }
        }
    }
    return { ok: true, series: out };
}

module.exports = { name: 'espn', fetchScoreboard, fetchTeams, discoverCricketSeries, datesFor, recordsFromScoreboard, teamsFromScoreboard };
