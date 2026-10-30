/**
 * #21 (0340, C-P): the Formula 1 sport page's data, from ESPN's free F1 feeds, on demand.
 *
 * What the page shows (PRODUCT.md › Sport, the F1 mock-up reviewed 30 Oct): the current race weekend (else the next
 * one) with its circuit and every session, the last race's top ten (a starting grid during a weekend once qualifying
 * is done), and the top ten of both championships. Sessions carry PigTV's own C-I channels for their airing.
 *
 * Sources (verified 30 Oct 2026, no key):
 *   site …/racing/f1/scoreboard                 the season calendar (round order, event ids) and the next event
 *   site …/racing/f1/scoreboard?dates=A-B       one weekend's sessions: times, status, finishing order
 *   site (apis/v2) …/racing/f1/standings        drivers' and constructors' championships
 *   core …/f1/events/{id} -> circuits/{id}      length, laps, turns, lap record, circuit map images
 *   core …/competitions/{c}/competitors/{a}     a driver's car: manufacturer and team colour (one request each)
 * The calendar's own dates are not the sessions' (they disagree by hours); they only order the season.
 *
 * Nothing is fetched until the page is asked for; an answer is kept 10 min on a race weekend, 1 h otherwise, and a
 * stale one is served while a single refresh runs. Unofficial feed: every field is read defensively, a missing one
 * is null, and nothing here throws.
 */
const espn = require('./sportsFixturesEspn');
const { f1Session } = require('./sportsFixtures');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/racing/f1/standings';
const CORE = 'https://sports.core.api.espn.com/v2/sports/racing/leagues/f1';
const TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKEND_TTL_MS = 10 * 60 * 1000;
const QUIET_TTL_MS = 60 * 60 * 1000;
// A session's length when ESPN gives no end: practice and qualifying an hour, a sprint 45 min, a race two hours.
const SESSION_MS = { 'practice 1': 3600e3, 'practice 2': 3600e3, 'practice 3': 3600e3, practice: 3600e3,
    'sprint qualifying': 2700e3, sprint: 2700e3, qualifying: 3600e3, race: 7200e3 };
const TOP_KIND = { qualifying: 'pole', 'sprint qualifying': 'pole', race: 'winner', sprint: 'winner' };

// #156: team lookups are optional (a few at a time, under a deadline: what answered is used, a partial map is not
// kept), and a cold request waits only so long for the first build before answering { available: false }.
const TUNING = Object.freeze({ teamConcurrency: 6, teamDeadlineMs: 6000, coldWaitMs: 8000 });
const tuning = { ...TUNING };

// Test seam: `get(url) -> { ok, json } | { ok: false, error }`, as sportsFixturesEspn.getJson.
const fetcher = { get: (url) => espn.getJson(url, TIMEOUT_MS) };

let cache = null;        // { value, at, ttl }
let refreshing = null;   // the single refresh in flight
let generation = 0;      // reset() discards a refresh started before it
const teamsByCompetition = new Map(); // finished session's competition id -> Map(driver id -> { team, teamColor })

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
/** The numeric id after `/events/` or `/circuits/` in a core `$ref`, or null. */
const idFromRef = (ref, kind) => (new RegExp(`/${kind === 'circuit' ? 'circuits' : 'events'}/(\\d+)`).exec(String(ref || '')) || [])[1] || null;
const colour = (v) => (/^[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toUpperCase() : null);
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
// ESPN's names carry the title sponsor ("MSC Cruises United States Grand Prix"); the page shows the race's own name.
// The 2026 season's sponsors; a new one shows until it is added here.
const SPONSOR_RE = /^(?:Qatar Airways|Heineken|Aramco|Gulf Air|STC|Crypto\.com|Lenovo|MSC Cruises|Pirelli|Moët & Chandon|AWS|Tag Heuer|Singapore Airlines|Etihad Airways)\s+/i;
const raceName = (name) => { const n = str(name); return n ? n.replace(SPONSOR_RE, '') : null; };

/** The season's race weekends in order: [{ label, eventId, start, end }]. */
function calendarOf(json) {
    const cal = json?.leagues?.[0]?.calendar;
    if (!Array.isArray(cal)) return [];
    return cal.map(c => ({ label: str(c?.label), eventId: idFromRef(c?.event?.$ref, 'event'), start: ms(c?.startDate), end: ms(c?.endDate) }))
        .filter(c => c.eventId && Number.isFinite(c.start) && Number.isFinite(c.end));
}

/** The weekend the page leads with: one not yet a day past its end (the current one, else the next), else the last. */
function weekendIndex(calendar, now) {
    const i = calendar.findIndex(c => c.end + DAY_MS > now);
    return i >= 0 ? i : calendar.length - 1;
}

async function weekendEvent(entry) {
    // The calendar's dates are hours out: ask a day either side, and pick the event by id.
    const url = `${SITE}/scoreboard?dates=${ymd(entry.start - DAY_MS)}-${ymd(entry.end + DAY_MS)}`;
    const r = await fetcher.get(url);
    if (!r.ok) return null;
    return (r.json?.events || []).find(e => String(e?.id) === entry.eventId) || null;
}

function sessionsOf(event) {
    const out = [];
    for (const c of event?.competitions || []) {
        const session = f1Session(c?.type?.abbreviation);
        const start = ms(c?.date);
        if (!session || !Number.isFinite(start)) continue;
        const state = c?.status?.type?.state;
        const status = state === 'post' || c?.status?.type?.completed ? 'done' : state === 'in' ? 'live' : 'scheduled';
        const order = (c?.competitors || []).filter(x => Number.isFinite(num(x?.order))).sort((a, b) => a.order - b.order);
        out.push({ competitionId: str(String(c?.id ?? '')), id: session.id, name: session.label, start,
            end: ms(c?.endDate) ?? start + (SESSION_MS[session.id] || 3600e3), status, order });
    }
    return out.sort((a, b) => a.start - b.start);
}

/** Driver id -> { team, teamColor } for a finished session (a request per driver, once per session, at most 22). */
async function teamsFor(eventId, session) {
    if (!session?.competitionId || session.status !== 'done') return new Map();
    const known = teamsByCompetition.get(session.competitionId);
    if (known) return known;
    const map = new Map();
    let failed = false;
    const queue = session.order.slice(0, 22);
    let next = 0;
    const worker = async () => {
        while (next < queue.length) {
            const x = queue[next++];
            const r = await fetcher.get(`${CORE}/events/${eventId}/competitions/${session.competitionId}/competitors/${x.id}?lang=en&region=us`);
            if (!r.ok) { failed = true; continue; }
            const team = str(r.json?.vehicle?.manufacturer);
            if (team) map.set(String(x.id), { team, teamColor: colour(r.json?.vehicle?.teamColor) });
        }
    };
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { failed = true; resolve(); }, tuning.teamDeadlineMs); });
    await Promise.race([Promise.all(Array.from({ length: Math.min(tuning.teamConcurrency, queue.length) }, worker)), deadline]);
    clearTimeout(timer);
    if (!failed) {
        if (teamsByCompetition.size >= 8) teamsByCompetition.delete(teamsByCompetition.keys().next().value);
        teamsByCompetition.set(session.competitionId, map);
    }
    return new Map(map); // what had answered by now; a late answer changes nothing returned
}

async function circuitInfo(eventId, registerImage) {
    const ev = await fetcher.get(`${CORE}/events/${eventId}?lang=en&region=us`);
    const circuitId = ev.ok ? idFromRef(ev.json?.circuit?.$ref, 'circuit') : null;
    if (!circuitId) return null;
    const r = await fetcher.get(`${CORE}/circuits/${circuitId}?lang=en&region=us`);
    if (!r.ok) return null;
    const c = r.json || {};
    // A raster map the Apple TV can draw (it cannot draw SVG): the plain circuit diagram, not the circuit-info one.
    const diagram = (Array.isArray(c.diagrams) ? c.diagrams : []).find(d => /\.(?:jpe?g|png)(?:$|\?)/i.test(String(d?.href || ''))
        && Array.isArray(d?.rel) && d.rel.includes('circuit') && !/circuit-info/.test(d.href));
    return {
        length: str(c.length), laps: num(c.laps), turns: num(c.turns),
        lapRecord: str(c.fastestLapTime), lapRecordYear: num(c.fastestLapYear),
        map: diagram ? registerImage(diagram.href) : null
    };
}

function standingsOf(json, teams) {
    const children = json?.children;
    if (!Array.isArray(children)) return null;
    const list = (name) => children.find(c => new RegExp(name, 'i').test(String(c?.name || '')))?.standings?.entries || [];
    const stat = (e, ...names) => { for (const n of names) { const s = (e?.stats || []).find(x => x?.name === n); if (s) return num(s.value ?? s.displayValue); } return null; };
    const byName = new Map([...teams.values()].map(t => [t.team.toLowerCase(), t.teamColor]));
    const drivers = list('driver').slice(0, 10).map((e, i) => {
        const t = teams.get(String(e?.athlete?.id)) || null;
        return { pos: stat(e, 'rank') ?? i + 1, name: str(e?.athlete?.displayName), team: t?.team ?? null, teamColor: t?.teamColor ?? null,
            points: stat(e, 'championshipPts', 'points') };
    });
    const constructors = list('constructor').slice(0, 10).map((e, i) => {
        const name = str(e?.team?.displayName);
        return { pos: stat(e, 'rank') ?? i + 1, name, team: null, teamColor: name ? byName.get(name.toLowerCase()) ?? null : null,
            points: stat(e, 'championshipPts', 'points') };
    });
    if (!drivers.length && !constructors.length) return null;
    return { drivers, constructors };
}

function rowsOf(session, teams, withPoints) {
    const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
    return session.order.slice(0, 10).map((x, i) => {
        const t = teams.get(String(x.id)) || null;
        return { pos: i + 1, driver: str(x?.athlete?.displayName), team: t?.team ?? null, teamColor: t?.teamColor ?? null,
            points: withPoints ? POINTS[i] : null };
    });
}

const SESSION_GRACE_MS = 30 * 60 * 1000;
/**
 * C-I's channels for each session (Map session id -> [channel]): an F1 event (C-I `league` "F1", kind event) naming the
 * session ("Practice 1", "Qualifying"; the race also as "Grand Prix"/"GP" without another session's name), on a channel
 * whose own airing (C-I channel start/end, 0337) covers the session's start within 30 min either way. Best first,
 * once each.
 */
function channelsForSessions(sessions, events) {
    const f1 = (events || []).filter(e => e.league === 'F1' && e.kind === 'event');
    const out = new Map();
    for (const s of sessions) {
        const named = new RegExp(`\\b${s.name.replace(/\s+/g, '\\s+')}\\b`, 'i');
        const seen = new Set();
        const list = [];
        for (const e of f1) {
            const race = s.id === 'race' && /\b(?:grand prix|gp)\b/i.test(e.title) && !/practice|qualifying|sprint/i.test(e.title);
            if (!named.test(e.title) && !race) continue;
            for (const ch of e.channels || []) {
                const start = ch.start ?? e.start;
                const end = ch.end ?? e.end;
                if (!(start <= s.start + SESSION_GRACE_MS && end > s.start - SESSION_GRACE_MS)) continue;
                const key = `${ch.sourceId}:${ch.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                list.push(ch);
            }
        }
        if (list.length) out.set(s.id, list);
    }
    return out;
}

/** The page's ESPN part, built at `now` (sessions with `channels: []`; page() attaches them). Never rejects. */
async function build(now, { registerImage = (u) => u } = {}) {
    const sb = await fetcher.get(`${SITE}/scoreboard`);
    if (!sb.ok) return null;
    const calendar = calendarOf(sb.json);
    if (!calendar.length) return null;
    const index = weekendIndex(calendar, now);
    const entry = calendar[index];
    const [event, standingsAnswer, info] = await Promise.all([
        weekendEvent(entry), fetcher.get(STANDINGS), circuitInfo(entry.eventId, registerImage)
    ]);
    const sessions = event ? sessionsOf(event) : [];
    const race = sessions.find(s => s.id === 'race');
    const started = sessions.some(s => s.status !== 'scheduled');
    const phase = race?.status === 'done' ? 'after' : started ? 'during' : 'before';

    // Results: this weekend's grid once qualifying is done (until the race finishes), else the last finished race.
    let results = null;
    let lastRace = null; // { eventId, event, session }
    const qualifying = sessions.find(s => s.id === 'qualifying');
    if (phase === 'after') lastRace = { eventId: entry.eventId, event, session: race };
    else if (index > 0) {
        const prev = calendar[index - 1];
        const prevEvent = await weekendEvent(prev);
        const prevRace = prevEvent ? sessionsOf(prevEvent).find(s => s.id === 'race' && s.status === 'done') : null;
        if (prevRace) lastRace = { eventId: prev.eventId, event: prevEvent, session: prevRace };
    }
    // One team map for the page: the newest finished session's cars (the latest line-up).
    const teamSource = phase === 'during' && qualifying?.status === 'done' ? { eventId: entry.eventId, session: qualifying } : lastRace;
    const teams = teamSource ? await teamsFor(teamSource.eventId, teamSource.session) : new Map();
    if (phase === 'during' && qualifying?.status === 'done' && race?.status !== 'done') {
        results = { kind: 'grid', title: 'Starting grid · Qualifying', date: qualifying.start, rows: rowsOf(qualifying, teams, false) };
    } else if (lastRace) {
        const name = raceName(lastRace.event?.shortName) || raceName(lastRace.event?.name);
        results = { kind: 'race', title: `Last race · ${name}`, date: lastRace.session.start, rows: rowsOf(lastRace.session, teams, true) };
    }

    const standings = standingsAnswer.ok ? standingsOf(standingsAnswer.json, teams) : null;
    if (standings) standings.afterRound = phase === 'after' ? index + 1 : index;

    const tops = (s) => {
        if (s.status !== 'done' || !s.order.length) return null;
        return { kind: TOP_KIND[s.id] || 'fastest', driver: str(s.order[0]?.athlete?.displayName) };
    };
    return {
        available: true,
        updatedAt: now,
        weekend: {
            round: index + 1, rounds: calendar.length,
            name: raceName(event?.name) || raceName(entry.label),
            circuit: str(event?.circuit?.fullName),
            city: str(event?.circuit?.address?.city), country: str(event?.circuit?.address?.country),
            phase, info,
            sessions: sessions.map(s => ({ id: s.id, name: s.name, start: s.start, end: s.end, status: s.status, top: tops(s),
                channels: [] }))
        },
        results,
        standings
    };
}

/**
 * C-P's answer at `now`: the cached ESPN part (refreshed in the background once stale), or, the first time, the result
 * of a refresh; `{ available: false }` while nothing has been fetched. #157: the sessions' channels are this request's
 * (`deps.channelsFor`: the current guide, this user's order), never kept with the page.
 */
async function page(now = Date.now(), deps = {}) {
    const value = await espnPart(now, deps);
    if (!value.available || !deps.channelsFor) return value;
    let channels = new Map();
    try { channels = await deps.channelsFor(value.weekend.sessions); } catch (err) { console.warn('[Sport] F1 page channels:', err.message); }
    return { ...value, weekend: { ...value.weekend, sessions: value.weekend.sessions.map(s => ({ ...s, channels: channels.get(s.id) || [] })) } };
}

async function espnPart(now, deps) {
    const fresh = cache && now - cache.at < cache.ttl;
    if (!fresh && !refreshing) {
        const mine = generation;
        refreshing = build(now, deps).then((value) => {
            if (value && mine === generation) {
                const weekend = value.weekend.sessions.some(s => s.start - DAY_MS < now && s.end + DAY_MS > now);
                cache = { value, at: now, ttl: weekend ? WEEKEND_TTL_MS : QUIET_TTL_MS };
            }
        }).catch((err) => console.warn('[Sport] F1 page refresh failed:', err.message))
            .finally(() => { refreshing = null; });
    }
    if (!cache && refreshing) {
        let timer;
        await Promise.race([refreshing, new Promise(resolve => { timer = setTimeout(resolve, tuning.coldWaitMs); })]);
        clearTimeout(timer);
    }
    return cache ? cache.value : { available: false };
}

/** Tests: forget everything. */
function reset() { cache = null; refreshing = null; generation++; teamsByCompetition.clear(); }

module.exports = { page, build, reset, fetcher, tuning, TUNING, calendarOf, weekendIndex, sessionsOf, channelsForSessions };
