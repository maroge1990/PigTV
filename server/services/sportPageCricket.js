/**
 * #21 (0383, C-S): the Cricket sport page's data, from ESPN's free cricket feeds, on demand.
 *
 * What the page shows (the "Cricket · Apple TV" mock-up): the lead match (the household's followed team's current or
 * next match, else the first live match, else the next one) with its innings, the summary line, who is at the crease,
 * its days as chips and the channels for the day's airing; the series it belongs to, every match in order with its
 * result; and the other competitions' matches today and tomorrow. Following a team is the household's
 * (sportPagePrefs, `teams.Cricket` = team names such as "Australia"). Spoilers are the client's: everything is sent.
 *
 * Sources (verified 31 Oct 2026, no key):
 *   site …/cricket/scorepanel?dates=YYYYMMDD               a day's series (each with its calendar) and their matches
 *   site …/cricket/<seriesId>/scoreboard?dates=YYYYMMDD    one series' matches on a day (the rest of the tour)
 *   site …/cricket/<seriesId>/summary?event=<id>           the lead's notes (match days, intervals) and batting card
 * A series' calendar lists the days it has play; one request per run of consecutive days finds its matches (a Test's
 * days are one match). Days already played are kept between refreshes (their results do not change).
 *
 * Feed rules (as sportsScoresEspn): an innings is a `linescores` row with `isBatting` (the other rows mirror the
 * opponent's), never summed; a team that has not batted has no innings, never a 0; overs are ESPN's balls notation,
 * sent as text ("134.4"). Nothing is fetched until the page is asked for; an answer is kept 2 min while the lead is
 * in play, 10 min on a match day, 1 h otherwise, and a stale one is served while a single refresh runs. Unofficial
 * feed: every field is read defensively, a missing one is null, and nothing here throws.
 */
const espn = require('./sportsFixturesEspn');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/cricket';
const TIMEOUT_MS = 10000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIVE_TTL_MS = 2 * 60 * 1000;
const MATCH_DAY_TTL_MS = 10 * 60 * 1000;
const QUIET_TTL_MS = HOUR_MS;
const COLD_WAIT_MS = 8000;
const MAX_SERIES_DAYS = 12;   // series-day requests per refresh (a tour needs ~6; a league shows the days around the lead)
const MAX_OTHERS = 20;
// A day's play when the guide has nothing better: T20 4.5 h, one-day 9 h, a first-class or Test day 6.5 h.
const DAY_HOURS = { t20: 4.5, odi: 9, 'list-a': 9, test: 6.5, 'first-class': 6.5 };
const DAYS = { test: 5, 'first-class': 4 };
const LIMITED = new Set(['t20', 'odi', 'list-a']);
// The C-I leagues a cricket programme can be filed under (sportsClassify).
const LEAGUES = ['Cricket', 'BBL', 'IPL'];

// Test seams: `fetcher.get(url) -> { ok, json } | { ok: false, error }` (as sportsFixturesEspn.getJson); `prefs.get()`
// as sportPagePrefs.get (required lazily: it opens the database).
const fetcher = { get: (url) => espn.getJson(url, TIMEOUT_MS) };
const prefs = { get: () => require('./sportPagePrefs').get() };

let cache = null;        // { value, at, ttl, key }
let refreshing = null;
let generation = 0;
const pastDays = new Map(); // series-day URL -> json, for days before yesterday (UTC)
const AIRINGS = new WeakMap(); // page value -> [{ id, start, end, teams }]: each match's airing window, for channels

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const decode = (s) => s && s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const text = (v) => decode(str(v));
const validId = (v) => (/^\d{1,12}$/.test(String(v ?? '')) ? String(v) : null);
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
const utcDay = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isTrue = (v) => v === true || v === 'true' || v === 1;

/** "Test", "Women's T20", "First-class" -> test | t20 | first-class | odi | list-a | null (as sportsScoresEspn). */
function formatOf(c) {
    const key = String(c?.class?.generalClassCard || c?.class?.eventType || '').trim().toLowerCase().replace(/^(?:women'?s|men'?s)\s+/, '');
    return { test: 'test', odi: 'odi', t20: 't20', t20i: 't20', 'first-class': 'first-class', fc: 'first-class', 'list a': 'list-a', lista: 'list-a' }[key] || null;
}

const BREAKS = [[/stumps/i, 'Stumps'], [/lunch/i, 'Lunch'], [/\btea\b/i, 'Tea'], [/dinner/i, 'Dinner'], [/innings.?break/i, 'Innings break'],
    [/rain/i, 'Rain delay'], [/delay/i, 'Delayed']];
/** { status: scheduled | live | break | done, breakLabel }. ESPN keeps a Test at stumps "in" play, described "Stumps". */
function statusOf(c) {
    const s = c?.status || {}, t = s.type || {};
    const description = `${t.name || ''} ${t.description || ''}`;
    if (/cancel|abandon|no result/i.test(description) || t.completed === true || t.state === 'post') return { status: 'done', breakLabel: null };
    if (t.state === 'pre' || /postpon/i.test(description) || /^Starts (?:at|in)/i.test(s.summary || '')) return { status: 'scheduled', breakLabel: null };
    for (const [re, label] of BREAKS) if (re.test(t.description || '')) return { status: 'break', breakLabel: label };
    return { status: t.state === 'in' ? 'live' : 'scheduled', breakLabel: null };
}

/** A competitor's innings in the order played: [{ runs, wickets, overs, declared, current }]. */
function inningsOf(competitor) {
    return (Array.isArray(competitor?.linescores) ? competitor.linescores : [])
        .filter(r => r?.isBatting === true)
        .sort((a, b) => (num(a.period) ?? 0) - (num(b.period) ?? 0))
        .slice(0, 4)
        .map(r => ({ runs: num(r.runs), wickets: num(r.wickets), overs: num(r.overs) === null ? null : String(r.overs),
            declared: /declared/i.test(r.description || ''), current: isTrue(r.isCurrent) }));
}

/** A competition's name for a heading: the full name when short ("Sheffield Shield"), else ESPN's short form ("WBBL"). */
const SEASON_RE = /\s+(\d{4}(?:[/-]\d{2,4})?)$/;
function competitionOf(league) {
    const name = (str(league?.name) || '').replace(SEASON_RE, '');
    const abbr = (str(league?.abbreviation) || '').replace(SEASON_RE, '');
    return (name && name.length <= 20 ? name : abbr || name) || null;
}

/** One scoreboard/scorepanel event as a match (internal: the page picks its public fields). Null when unreadable. */
function matchOf(event, league, registerImage) {
    const c = event?.competitions?.[0];
    const id = validId(event?.id ?? c?.id);
    const start = ms(c?.date || event?.date);
    if (!c || !id || start === null) return null;
    const raw = (Array.isArray(c.competitors) ? c.competitors : []).filter(x => x?.team).slice(0, 2)
        .sort((a, b) => (num(a.order) ?? 9) - (num(b.order) ?? 9));
    if (raw.length !== 2) return null;
    const teams = raw.map(x => {
        const logo = str(x.team.logo) || str(x.team.logos?.[0]?.href);
        return { abbr: str(x.team.abbreviation), name: str(x.team.displayName) || str(x.team.name), logo: logo ? registerImage(logo) : null };
    });
    if (teams.some(t => !t.name)) return null;
    // A team's names for following ("Australia", "AUS"); never its `location`, which is a country ("Australia" for every
    // Sheffield Shield and WBBL side).
    const keys = raw.map(x => ['displayName', 'name', 'shortDisplayName', 'abbreviation'].map(k => str(x.team[k])).filter(Boolean).map(s => s.toLowerCase()));
    const format = formatOf(c);
    const { status, breakLabel } = statusOf(c);
    const dayNumber = num(/^Day (\d{1,2})$/i.exec(str(c.status?.session) || '')?.[1]);
    const seriesId = validId(league?.id) || validId(event?.leagueId);
    return {
        id, seriesId, competition: competitionOf(league), label: text(c.description), format,
        venue: text(c.venue?.fullName), city: text(c.venue?.address?.city),
        start, envelopeEnd: ms(c.endDate || event?.endDate), status, breakLabel,
        day: dayNumber ? `Day ${dayNumber}` : null, dayNumber,
        teams, keys, innings: raw.map(inningsOf),
        scores: raw.map(x => text(x.score)),
        summary: text(c.status?.summary),
        winner: raw.findIndex(x => isTrue(x.winner)),
        international: String(c.class?.internationalClassId ?? '0') !== '0'
    };
}

const dayLength = (m) => (DAY_HOURS[m.format] || 6.5) * HOUR_MS;
const dayCount = (m, summaryDays) => (LIMITED.has(m.format) ? 1 : summaryDays || DAYS[m.format] || 1);
const dayStart = (m, n) => m.start + (n - 1) * DAY_MS;
const inPlay = (m) => m.status === 'live' || (m.status === 'break' && m.breakLabel !== 'Stumps');

/** The day in play (or last played): the feed's "Day N", else counted from the start. */
function currentDay(m, n, now) {
    if (m.dayNumber) return Math.min(m.dayNumber, n);
    if (n === 1) return 1;
    return Math.max(1, Math.min(n, Math.floor((now - m.start) / DAY_MS) + 1));
}

/** The match's days as chips: [{ number, date (local midnight), state: done | live | next | later }]. */
function daysOf(m, n, now) {
    const d = currentDay(m, n, now);
    const last = m.status === 'done' && m.dayNumber ? Math.min(n, m.dayNumber) : n; // a match won early has no more days
    const out = [];
    for (let i = 1; i <= last; i++) {
        let state = 'later';
        if (m.status === 'scheduled') state = i === 1 ? 'next' : 'later';
        else if (m.status === 'done') state = 'done';
        else if (inPlay(m)) state = i < d ? 'done' : i === d ? 'live' : i === d + 1 ? 'next' : 'later';
        else state = i <= d ? 'done' : i === d + 1 ? 'next' : 'later'; // stumps
        out.push({ number: i, date: localMidnight(dayStart(m, i)), state });
    }
    return out;
}

/** When play next starts: the first ball of a scheduled match, the next day's at stumps; null while in play or done. */
function nextStartOf(m, n, now) {
    if (m.status === 'scheduled') return m.start;
    if (m.status === 'break' && m.breakLabel === 'Stumps') { const d = currentDay(m, n, now); return d < n ? dayStart(m, d + 1) : null; }
    return null;
}

/** The window of the day the page's channels are for: the day in play, the next day at stumps, day 1 before it. */
function airingOf(m, n, now) {
    if (m.status === 'done') return null;
    const begin = inPlay(m) ? dayStart(m, currentDay(m, n, now)) : nextStartOf(m, n, now);
    return begin === null ? null : { id: m.id, start: begin - HOUR_MS, end: begin + dayLength(m), teams: m.teams.map(t => t.name) };
}

/** The lead's match days from the summary's note ("27,28,29,30,31 October 2026 (5-day match)"), else null. */
function summaryDays(summary) {
    const note = (summary?.notes || []).find(n => n?.type === 'matchdays');
    const n = num(/\((\d{1,2})-day match\)/i.exec(note?.text || '')?.[1]);
    return n && n >= 1 && n <= 6 ? n : null;
}

/** The session of a live Test day, from the day's interval notes (Lunch, Tea; Dinner in a day-night Test). */
function sessionOf(m, summary, now) {
    if (m.status !== 'live' || LIMITED.has(m.format) || !summary) return null;
    const d = currentDay(m, summaryDays(summary) || dayCount(m), now);
    const intervals = (summary.notes || []).filter(n => num(n?.dayNumber) === d && /^(?:Lunch|Tea|Dinner)\b/.test(n?.text || '')).length;
    return Math.min(3, intervals + 1);
}

/** The not-out batters of the innings in progress (the batting card), when it is still open; null when unknown. */
function creaseOf(m, raw, summary) {
    if (!summary || !['live', 'break'].includes(m.status)) return null;
    const competitors = raw?.competitions?.[0]?.competitors || [];
    let current = null;
    for (const x of competitors) for (const r of x?.linescores || []) if (r?.isBatting === true && isTrue(r.isCurrent)) current = r;
    if (!current || num(current.wickets) >= 10 || /all out|declared/i.test(current.description || '')) return null;
    const card = (summary.matchcards || []).find(k => k?.headline === 'Batting' && String(k.inningsNumber) === String(current.period));
    const batters = (card?.playerDetails || []).filter(p => /^not out$/i.test(String(p?.dismissal || '').trim()))
        .map(p => ({ name: str(p.playerName), runs: num(p.runs), balls: num(p.ballsFaced) })).filter(p => p.name);
    return batters.length ? batters.slice(0, 2) : null;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
const COUNT = ['one', 'two', 'three', 'four', 'five'];
const PLURAL = { test: 'Tests', odi: 'ODIs', t20: 'T20s' };
/** "Series level 1–1 · third of three Tests": the tally of the lead's format so far, and where the lead stands. */
function seriesLineOf(lead, matches) {
    if (!lead.international || !PLURAL[lead.format]) return null; // a tour's Tests, ODIs or T20s; not a domestic league
    const same = matches.filter(m => m.format && m.format === lead.format);
    const index = same.findIndex(m => m.id === lead.id);
    if (same.length < 2 || index < 0) return null;
    const ord = ORDINAL[index] || `${index + 1}th`;
    const count = COUNT[same.length - 1] || String(same.length);
    const place = `${ord} of ${count} ${PLURAL[lead.format]}`;
    const done = same.filter(m => m.status === 'done');
    if (!done.length) return place.charAt(0).toUpperCase() + place.slice(1);
    const wins = new Map(lead.teams.map(t => [t.name, 0]));
    for (const m of done) if (m.winner >= 0 && wins.has(m.teams[m.winner].name)) wins.set(m.teams[m.winner].name, wins.get(m.teams[m.winner].name) + 1);
    const [[a, x], [b, y]] = [...wins.entries()].sort((p, q) => q[1] - p[1]);
    const over = done.length === same.length;
    const tally = x === y ? (over ? `Series drawn ${x}–${y}` : `Series level ${x}–${y}`)
        : `${a} ${over ? 'won the series' : 'lead the series'} ${x}–${y}`;
    return over ? tally : `${tally} · ${place}`;
}

/** Does a match cover a UTC day (YYYYMMDD -> ms)? A one-day match its start day; a longer one its days. */
function covers(m, day) {
    const first = utcDay(m.start);
    if (LIMITED.has(m.format)) return day === first;
    const last = m.envelopeEnd !== null ? utcDay(m.envelopeEnd) : first + (dayCount(m) - 1) * DAY_MS;
    return day >= first && day <= last;
}

async function seriesDay(seriesId, day, now) {
    const url = `${BASE}/${seriesId}/scoreboard?dates=${ymd(day)}`;
    if (pastDays.has(url)) return pastDays.get(url);
    const answer = await fetcher.get(url);
    if (!answer?.ok || !Array.isArray(answer.json?.events)) return null;
    if (day < utcDay(now) - DAY_MS) { if (pastDays.size > 200) pastDays.clear(); pastDays.set(url, answer.json); }
    return answer.json;
}

/** Every match of the lead's series: the calendar's days, one request per run of consecutive days not yet covered. */
async function seriesMatches(lead, league, known, now, registerImage) {
    const matches = new Map(known.filter(m => m.seriesId === lead.seriesId).map(m => [m.id, m]));
    const days = [...new Set((Array.isArray(league?.calendar) ? league.calendar : []).map(ms).filter(t => t !== null).map(utcDay))].sort((a, b) => a - b);
    const runs = [];
    for (const d of days) { const run = runs[runs.length - 1]; if (run && d - run[run.length - 1] === DAY_MS) run.push(d); else runs.push([d]); }
    const uncovered = (d) => ![...matches.values()].some(m => covers(m, d));
    const near = (a, b) => Math.abs(a - lead.start) - Math.abs(b - lead.start);
    let budget = MAX_SERIES_DAYS;
    const wave = async (list) => {
        const chosen = list.sort(near).slice(0, Math.max(0, budget));
        budget -= chosen.length;
        const answers = await Promise.all(chosen.map(d => seriesDay(lead.seriesId, d, now)));
        for (const json of answers) for (const e of json?.events || []) {
            const m = matchOf(e, league, registerImage);
            if (m && !matches.has(m.id)) matches.set(m.id, m);
        }
    };
    await wave(runs.map(r => r.find(uncovered)).filter(d => d !== undefined));
    await wave(runs.flat().filter(uncovered));
    return [...matches.values()].sort((a, b) => a.start - b.start);
}

/** The season from the series' name ("Australia tour of South Africa 2026/27" -> "2026/27"), else the feed's year. */
function seasonOf(league, event) {
    return SEASON_RE.exec(str(league?.name) || '')?.[1] || SEASON_RE.exec(str(league?.abbreviation) || '')?.[1]
        || (num(event?.season?.year) ? String(event.season.year) : null);
}

const RANK = { live: 0, break: 1, scheduled: 2, done: 3 };
/** Live and in-play first, then the next to start, then the most recently started. */
function byInterest(a, b) {
    const r = RANK[a.status] - RANK[b.status];
    if (r) return r;
    return a.status === 'done' ? b.start - a.start : a.status === 'scheduled' ? a.start - b.start : 0;
}

/** The lead: a followed team's current or next match; else the first live match, else the next, else the latest. */
function pickLead(matches, followed) {
    const names = (followed || []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
    const theirs = matches.filter(m => m.keys.some(ks => names.some(n => ks.includes(n))));
    const pool = theirs.length ? theirs : matches;
    // Array.sort is stable: within a rank the feed's (panel) order stands, so "first live" is ESPN's first.
    return pool.slice().sort(byInterest)[0] || null;
}

function followedTeams() {
    try { const t = prefs.get()?.teams?.Cricket; return Array.isArray(t) ? t.filter(n => typeof n === 'string') : []; }
    catch (err) { console.warn('[Sport] Cricket page prefs:', err.message); return []; }
}

/** The page's ESPN part at `now` (channels empty; page() attaches them). Never rejects; null on failure. */
async function build(now, { registerImage = (u) => u, followed = followedTeams() } = {}) {
    const today = utcDay(now);
    const panels = await Promise.all([today, today + DAY_MS].map(d => fetcher.get(`${BASE}/scorepanel?dates=${ymd(d)}`)));
    if (!panels[0]?.ok || !Array.isArray(panels[0].json?.scores)) return null;
    const leagues = new Map();
    const raws = new Map();
    const matches = [];
    for (const panel of panels) {
        for (const block of panel?.ok && Array.isArray(panel.json?.scores) ? panel.json.scores : []) {
            const league = (block?.leagues || [])[0];
            const seriesId = validId(league?.id);
            if (!seriesId) continue;
            if (!leagues.has(seriesId)) leagues.set(seriesId, league);
            for (const e of Array.isArray(block.events) ? block.events : []) {
                const m = matchOf(e, league, registerImage);
                if (!m || raws.has(m.id)) continue; // today's copy first: the fresher listing
                raws.set(m.id, e);
                matches.push(m);
            }
        }
    }
    const pick = pickLead(matches, followed);
    let lead = null, series = null, airings = [];
    if (pick) {
        const league = leagues.get(pick.seriesId);
        const [summaryAnswer, all] = await Promise.all([
            fetcher.get(`${BASE}/${pick.seriesId}/summary?event=${pick.id}`),
            seriesMatches(pick, league, matches, now, registerImage)
        ]);
        const summary = summaryAnswer?.ok && summaryAnswer.json && typeof summaryAnswer.json === 'object' ? summaryAnswer.json : null;
        const n = dayCount(pick, summaryDays(summary));
        lead = {
            id: pick.id, seriesId: pick.seriesId, competition: pick.competition, label: pick.label, format: pick.format,
            venue: pick.venue, city: pick.city, start: pick.start, end: dayStart(pick, n) + dayLength(pick),
            status: pick.status, breakLabel: pick.breakLabel, day: n > 1 ? pick.day : null, session: sessionOf(pick, summary, now),
            teams: pick.teams, innings: pick.innings, summary: pick.summary, crease: creaseOf(pick, raws.get(pick.id), summary),
            seriesLine: seriesLineOf(pick, all), days: daysOf(pick, n, now), nextStart: nextStartOf(pick, n, now), channels: []
        };
        const air = airingOf(pick, n, now);
        if (air) airings.push(air);
        series = {
            id: pick.seriesId, name: competitionOf(league) || pick.competition, season: seasonOf(league, raws.get(pick.id)),
            matches: all.map(m => ({ id: m.id, label: m.label, start: m.start, end: dayStart(m, dayCount(m)) + dayLength(m),
                status: m.status, result: m.status === 'done' ? m.summary : null, current: m.id === pick.id }))
        };
    }
    const others = matches
        .filter(m => m.seriesId !== pick?.seriesId && !m.teams.every(t => /^tbc$/i.test(t.name)))
        .sort(byInterest).slice(0, MAX_OTHERS)
        .map(m => {
            const n = dayCount(m);
            const air = airingOf(m, n, now);
            if (air) airings.push(air);
            return { id: m.id, seriesId: m.seriesId, competition: m.competition, teams: m.teams, scores: m.scores,
                line: m.summary, status: m.status, start: m.start, nextStart: nextStartOf(m, n, now), channels: [] };
        });
    const value = { available: true, updatedAt: now, lead, series, others };
    AIRINGS.set(value, airings);
    return value;
}

/** How long a page built at `now` stays fresh: 2 min while the lead is in play, 10 min on a match day, else 1 h. */
function ttlOf(value, now) {
    // In play: live, or a break play resumes from today (stumps carries the next day's start).
    const playing = (m) => m.status === 'live' || (m.status === 'break' && !Number.isFinite(m.nextStart));
    const lead = value?.lead;
    if (lead && playing(lead)) return LIVE_TTL_MS;
    const soon = (t) => Number.isFinite(t) && t - now < 12 * HOUR_MS && t + HOUR_MS > now;
    const all = [lead, ...(value?.others || [])].filter(Boolean);
    if (all.some(m => playing(m) || soon(m.nextStart))) return MATCH_DAY_TTL_MS;
    return QUIET_TTL_MS;
}

/**
 * C-I channels for each airing ({ id, start, end, teams: [names] }): the cricket events overlapping its day's window
 * that name both its teams and no other team on the page; failing that, the only event around naming exactly one of
 * them. A team is named by its full name, that name without "Women", or its last word ("Sixers") where no other team
 * on the page shares it. Longer names are read first, so "South Australia" is not also "Australia".
 */
function channelsForMatches(airings, events) {
    const cricket = (events || []).filter(e => LEAGUES.includes(e.league) && e.kind === 'event');
    const out = new Map();
    const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const teams = [...new Set(airings.flatMap(a => a.teams))];
    const keysOf = new Map(teams.map(t => [t, [...new Set([words(t).trim(), words(t.replace(/\s+women$/i, '')).trim()])]]));
    const lastWord = (t) => { const w = words(t.replace(/\s+women$/i, '')).trim().split(' '); return w.length > 1 && w[w.length - 1].length >= 4 ? w[w.length - 1] : null; };
    const lastCount = new Map();
    for (const t of teams) { const w = lastWord(t); if (w) lastCount.set(w, (lastCount.get(w) || 0) + 1); }
    const allKeys = new Set([...keysOf.values()].flat());
    for (const t of teams) { const w = lastWord(t); if (w && lastCount.get(w) === 1 && !allKeys.has(w)) keysOf.get(t).push(w); }
    const keyed = [...keysOf.entries()].flatMap(([team, keys]) => keys.map(k => ({ team, k }))).sort((a, b) => b.k.length - a.k.length);
    const mentions = (e) => {
        let s = words(`${e.title} ${(e.aliases || []).join(' ')}`);
        const found = new Set();
        for (const { team, k } of keyed) {
            if (!k || !s.includes(` ${k} `)) continue;
            found.add(team);
            s = s.split(` ${k} `).join(' | ');
        }
        return found;
    };
    const named = cricket.map(e => ({ e, teams: mentions(e) }));
    for (const a of airings) {
        const near = named.filter(({ e }) => e.start < a.end && e.end > a.start);
        const ours = (t) => a.teams.includes(t);
        let matched = near.filter(({ teams: t }) => a.teams.every(x => t.has(x)) && [...t].every(ours));
        if (!matched.length) {
            const single = near.filter(({ teams: t }) => t.size === 1 && ours([...t][0]));
            if (single.length === 1) matched = single;
        }
        const seen = new Set();
        const list = [];
        for (const { e } of matched) for (const ch of e.channels || []) {
            const key = `${ch.sourceId}:${ch.id}`;
            if (!seen.has(key)) { seen.add(key); list.push(ch); }
        }
        if (list.length) out.set(a.id, list);
    }
    return out;
}

/**
 * C-S's answer at `now`: the cached ESPN part (refreshed in the background once stale), or, the first time (or after
 * the household's followed teams change), the result of a refresh; `{ available: false }` while nothing has been
 * fetched. The channels are this request's (`deps.channelsFor(airings)`: the current guide, this user's order).
 */
async function page(now = Date.now(), deps = {}) {
    const value = await espnPart(now, deps);
    if (!value.available || !deps.channelsFor) return value;
    const airings = AIRINGS.get(value) || [];
    let channels = new Map();
    try { if (airings.length) channels = await deps.channelsFor(airings); } catch (err) { console.warn('[Sport] Cricket page channels:', err.message); }
    const withChannels = (m) => ({ ...m, channels: channels.get(m.id) || [] });
    return { ...value, lead: value.lead ? withChannels(value.lead) : null, others: value.others.map(withChannels) };
}

async function espnPart(now, deps) {
    const followed = followedTeams();
    const key = JSON.stringify(followed.map(n => n.toLowerCase()));
    const fresh = cache && cache.key === key && now - cache.at < cache.ttl;
    if (!fresh && !refreshing) {
        const mine = generation;
        refreshing = build(now, { ...deps, followed }).then((value) => {
            if (value && mine === generation) cache = { value, at: now, ttl: ttlOf(value, now), key };
        }).catch((err) => console.warn('[Sport] Cricket page refresh failed:', err.message))
            .finally(() => { refreshing = null; });
    }
    if ((!cache || cache.key !== key) && refreshing) {
        let timer;
        await Promise.race([refreshing, new Promise(resolve => { timer = setTimeout(resolve, COLD_WAIT_MS); })]);
        clearTimeout(timer);
    }
    return cache ? cache.value : { available: false };
}

/** Tests: forget everything. */
function reset() { cache = null; refreshing = null; generation++; pastDays.clear(); }

/** The span of the airings, for asking C-I for the events around them. */
const spanOf = (airings) => ({ from: Math.min(...airings.map(a => a.start)), to: Math.max(...airings.map(a => a.end)) });

module.exports = { page, build, reset, fetcher, prefs, matchOf, statusOf, formatOf, channelsForMatches, ttlOf, spanOf, airingsOf: (v) => AIRINGS.get(v) || [], LEAGUES };
