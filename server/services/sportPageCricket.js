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
const { createPageCache } = require('./sportPageCache');
const espn = require('./sportsFixturesEspn');
const overrun = require('./sportOverrun');
const { espnState, edgeKey } = require('./espnState');

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
// The C-I leagues a cricket programme can be filed under (sportsClassify): every cricket league (#195).
const LEAGUES = require('./sportCatalog').sport('Cricket').leagues;
const { OTHER_CRICKET } = require('./sportCatalog'); // #230

// Test seams: `fetcher.get(url) -> { ok, json } | { ok: false, error }` (as sportsFixturesEspn.getJson); `prefs.get()`
// the followed names when a request names none (#193: the route passes the account's own, `deps.followed`).
const fetcher = { get: (url) => espn.getJson(url, TIMEOUT_MS) };
const prefs = { get: () => ({ teams: {} }) };

// #193 (D-41): one entry per followed-teams key (each account follows its own), the most recent last; at most CACHE_KEYS.
const CACHE_KEYS = 4;
const caches = createPageCache({ label: 'Cricket', coldWaitMs: COLD_WAIT_MS, maxEntries: CACHE_KEYS, ttlOf: (value, now) => ttlOf(value, now) });
const pastDays = new Map(); // series-day URL -> json, for days before yesterday (UTC)
const AIRINGS = new WeakMap(); // page value -> [{ id, start, end, teams }]: each match's airing window, for channels
// #297: page value -> { lead: { m, n } | null, all: [m], others: [m] }: the internal matches the public ones were made from
// (with the collector's card id and each side's home/away), what page() lays the collector's state over. Never sent.
const META = new WeakMap();

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

// #272 (0548): C-S's words for espnState's. A break only with a label C-S lists (another pause is play); a postponed,
// cancelled or abandoned match is over (`done`, its summary says why), never scheduled at its old time; a match suspended
// in play is still on, one ESPN has put in state post is `done` (0554); unknown is shown by its start, as before.
const WORD = { scheduled: 'scheduled', live: 'live', break: 'break', suspended: 'live', 'suspended-over': 'done', postponed: 'done', cancelled: 'done', finished: 'done',
    unknown: 'scheduled' };
const BREAKS = new Set(['Stumps', 'Lunch', 'Tea', 'Dinner', 'Innings break', 'Rain delay', 'Delayed']);
/** { status: scheduled | live | break | done, breakLabel }. ESPN keeps a Test at stumps "in" play, described "Stumps". */
function statusOf(c) {
    const r = espnState(c?.status, { cricket: true });
    if (r.state === 'break') return BREAKS.has(r.breakLabel) ? { status: 'break', breakLabel: r.breakLabel } : { status: 'live', breakLabel: null };
    return { status: WORD[edgeKey(r)], breakLabel: null };
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

/**
 * #195 (D-41): the followable cricket league a match belongs to: its series' fixed league (BBL, WBBL, Shield...), else
 * the International group its international class says, else (#230) "Other cricket" when its class is known and not
 * international; undefined when its class is unknown.
 */
function leagueOfMatch(seriesId, event) {
    const fixed = Object.entries(require('./sportsFixtures').ESPN_LEAGUE_PATHS).find(([, p]) => p === `cricket/${seriesId}`)?.[0];
    if (fixed) return fixed;
    const group = espn.cricketGroupOf([event]);
    return group === null ? OTHER_CRICKET : group; // undefined (class unknown) is counted as unclassified, as before
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
    const cardId = validId(c.id) || id;
    return {
        id, seriesId, competition: competitionOf(league), label: text(c.description), format,
        venue: text(c.venue?.fullName), city: text(c.venue?.address?.city),
        start, envelopeEnd: ms(c.endDate || event?.endDate), status, breakLabel,
        day: dayNumber ? `Day ${dayNumber}` : null, dayNumber,
        teams, keys, innings: raw.map(inningsOf),
        scores: raw.map(x => text(x.score)),
        summary: text(c.status?.summary),
        winner: raw.findIndex(x => isTrue(x.winner)),
        international: String(c.class?.internationalClassId ?? '0') !== '0',
        league: leagueOfMatch(seriesId, event),
        // #297: the score collector's id for the same match (sportsScoresEspn.normalize) and which side is home, in `teams`' order
        card: seriesId ? `espn:cricket/${seriesId}:${cardId}` : null,
        sides: raw.map(x => (x.homeAway === 'home' || x.homeAway === 'away' ? x.homeAway : null))
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
    // `inPlay`: a day in progress (live or a break within it, never stumps), for the overrun rule (#191, sportOverrun.js).
    return begin === null ? null : { id: m.id, start: begin - HOUR_MS, end: begin + dayLength(m), teams: m.teams.map(t => t.name), inPlay: inPlay(m) };
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

/**
 * The lead: a followed team's current or next match; else the first live match, else the next; a finished match only
 * when nothing is in play or to come (the followed team's, else the latest). 0383 Codex round 1: a followed team's
 * finished match no longer outranks a live one.
 */
function pickLead(matches, followed) {
    const names = (followed || []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
    const theirs = matches.filter(m => m.keys.some(ks => names.some(n => ks.includes(n))));
    // Array.sort is stable: within a rank the feed's (panel) order stands, so "first live" is ESPN's first.
    const best = (pool) => pool.slice().sort(byInterest)[0] || null;
    const open = (m) => m.status !== 'done';
    return best(theirs.filter(open)) || best(matches.filter(open)) || best(theirs) || best(matches);
}

function followedTeams() {
    try { const t = prefs.get()?.teams?.Cricket; return Array.isArray(t) ? t.filter(n => typeof n === 'string') : []; }
    catch (err) { console.warn('[Sport] Cricket page prefs:', err.message); return []; }
}

/** The page's ESPN part at `now` (channels empty; page() attaches them). Never rejects; null on failure. */
async function build(now, { registerImage = (u) => u, followed = followedTeams(), leagues: competitions = ['Cricket'], rosters = {} } = {}) {
    // #195 (D-41): only the account's followed cricket competitions (the men's internationals when it follows none).
    const wanted = new Set(competitions.length ? competitions : ['Cricket']);
    // #195 (D-41): in a group whose nations the account follows, a tour's match shows only for them; ICC events in full.
    const groups = require('./sportGroups');
    const names = (followed || []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
    const narrowed = new Set([...wanted].filter(l => groups.isGroup(l) && groups.followsNation(l, followed, rosters[l] ?? groups.storedRoster(l))));
    const shown = (m) => !narrowed.has(m.league) || groups.isTournament({ league: m.league, competition: m.competition })
        || m.keys.some(ks => names.some(n => ks.includes(n)));
    const today = utcDay(now);
    const panels = await Promise.all([today, today + DAY_MS].map(d => fetcher.get(`${BASE}/scorepanel?dates=${ymd(d)}`)));
    if (!panels[0]?.ok || !Array.isArray(panels[0].json?.scores)) return null;
    const leagues = new Map();
    const raws = new Map();
    const matches = [];
    let unclassified = 0;
    for (const panel of panels) {
        for (const block of panel?.ok && Array.isArray(panel.json?.scores) ? panel.json.scores : []) {
            const league = (block?.leagues || [])[0];
            const seriesId = validId(league?.id);
            if (!seriesId) continue;
            if (!leagues.has(seriesId)) leagues.set(seriesId, league);
            for (const e of Array.isArray(block.events) ? block.events : []) {
                const m = matchOf(e, league, registerImage);
                if (!m || raws.has(m.id)) continue; // today's copy first: the fresher listing
                if (m.league === undefined) { unclassified++; continue; }
                if (!wanted.has(m.league) || !shown(m)) continue;
                raws.set(m.id, e);
                matches.push(m);
            }
        }
    }
    // 0401 (0400 Codex round 2, medium): matches whose international class ESPN left out may be the followed ones; with
    // nothing else to show, this is a failed refresh (the last page stays), not an empty one.
    if (unclassified && !matches.length) return null;
    const pick = pickLead(matches, followed);
    let lead = null, series = null, airings = [], leadDays = 1, lastAll = [];
    if (pick) {
        const league = leagues.get(pick.seriesId);
        const [summaryAnswer, all] = await Promise.all([
            fetcher.get(`${BASE}/${pick.seriesId}/summary?event=${pick.id}`),
            seriesMatches(pick, league, matches, now, registerImage)
        ]);
        const summary = summaryAnswer?.ok && summaryAnswer.json && typeof summaryAnswer.json === 'object' ? summaryAnswer.json : null;
        const n = dayCount(pick, summaryDays(summary));
        leadDays = n; lastAll = all;
        lead = {
            // #210: `league` the followed catalogue league the match is the page's for (C-U), so a client files it there.
            id: pick.id, seriesId: pick.seriesId, competition: pick.competition, league: pick.league ?? null, label: pick.label, format: pick.format,
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
    const otherMatches = matches
        .filter(m => m.seriesId !== pick?.seriesId && !m.teams.every(t => /^tbc$/i.test(t.name)))
        .sort(byInterest).slice(0, MAX_OTHERS);
    const others = otherMatches
        .map(m => {
            const n = dayCount(m);
            const air = airingOf(m, n, now);
            if (air) airings.push(air);
            return { id: m.id, seriesId: m.seriesId, competition: m.competition, league: m.league ?? null, teams: m.teams, scores: m.scores,
                line: m.summary, status: m.status, start: m.start, nextStart: nextStartOf(m, n, now), channels: [] };
        });
    const value = { available: true, updatedAt: now, lead, series, others };
    AIRINGS.set(value, airings);
    META.set(value, { lead: pick ? { m: pick, n: leadDays } : null, all: lastAll, others: otherMatches });
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
function channelsForMatches(airings, events, { now, observedAt } = {}) {
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
            const kept = seen.has(key) ? null : overrun.keep(ch, e, a.inPlay === true, now, observedAt); // #191: a day's play past its slot
            if (kept) { seen.add(key); list.push(kept); }
        }
        if (list.length) out.set(a.id, list);
    }
    return out;
}

/**
 * C-S's answer at `now`: the cached ESPN part (refreshed in the background once stale), or, the first time (or after
 * the account's followed teams change), the result of a refresh; `{ available: false }` while nothing has been
 * fetched. The channels are this request's (`deps.channelsFor(airings)`: the current guide, this user's order).
 */
async function page(now = Date.now(), deps = {}) {
    let value = await espnPart(now, deps);
    if (value.available && deps.state) value = await withState(value, now, deps);
    if (!value.available || !deps.channelsFor) return value;
    const airings = AIRINGS.get(value) || [];
    let channels = new Map();
    try { if (airings.length) channels = await deps.channelsFor(airings, value.updatedAt); } catch (err) { console.warn('[Sport] Cricket page channels:', err.message); }
    const withChannels = (m) => ({ ...m, channels: channels.get(m.id) || [] });
    return { ...value, lead: value.lead ? withChannels(value.lead) : null, others: value.others.map(withChannels) };
}

/** This request's cache key and build: one entry per follow list. */
function entryOf(now, deps) {
    const followed = Array.isArray(deps.followed) ? deps.followed.filter(n => typeof n === 'string') : followedTeams();
    const leagues = Array.isArray(deps.leagues) ? deps.leagues.filter(l => LEAGUES.includes(l)) : ['Cricket'];
    const key = JSON.stringify([followed.map(n => n.toLowerCase()), [...leagues].sort()]);
    return { key, make: () => build(now, { ...deps, followed, leagues }) };
}

async function espnPart(now, deps) {
    const { key, make } = entryOf(now, deps);
    // Only this follow list's own page: another's lead and series were chosen for someone else (0393, Codex round 1).
    const own = await caches.get(key, now, make);
    return own ? own.value : { available: false };
}

/** The collector's word for a match as C-S says it: { status, breakLabel } (a break only with a label C-S knows), or null. */
function wordOf(snapshot) {
    const key = snapshot?.espn?.key;
    if (key === 'break') return BREAKS.has(snapshot.breakLabel) ? { status: 'break', breakLabel: snapshot.breakLabel } : { status: 'live', breakLabel: null };
    return Object.hasOwn(WORD, key ?? '') ? { status: WORD[key], breakLabel: null } : null;
}

/**
 * #297: each match's status and score from the score collector's store for this account (`deps.state`, sportPageState:
 * its delay; only a fresh or final snapshot), as the front page's card for the same match. The collector further on than
 * the page's read (a match it has seen start or finish): the read is renewed at once (sportPageCache.renew: one build, at
 * most every 30 s, landing for the next request), as the innings' detail, the batting card, the notes and the result
 * line come only from it; a finish the read still lacks after that keeps the page's own status and score (never a
 * finished match without its result). The page's read newer than the account's delayed view: the collector's status and
 * score, without the result line (`summary`, `line`, a series match's `result`) or the series tally counting it. A line
 * read for another state is not shown with the collector's (null). The days, the next start, the session, the crease and
 * the airings follow the status shown. A match the collector holds nothing usable for keeps the page's own.
 */
async function withState(value, now, deps) {
    let view = overlay(value, deps.state, now);
    if (view.renew) {
        const { key, make } = entryOf(now, deps);
        const entry = await caches.renew(key, now, make);
        if (entry?.value?.available && entry.value !== value) view = overlay(entry.value, deps.state, now);
    }
    return view.value;
}

/** A side's text as a page score: trimmed, empty is null. */
const scoreText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function overlay(value, state, now) {
    const { rank } = require('./sportPageState');
    const meta = META.get(value);
    if (!meta) return { value, renew: false };
    let renew = false;
    // One match's view: { status, breakLabel, moved (another rank than the read's), scores, innings } or null (the page's own)
    const viewOf = (m) => {
        let seen = null;
        try { seen = state(m.card); } catch { seen = null; }
        const word = seen ? wordOf(seen.snapshot) : null;
        if (!word) return null;
        const theirs = rank(word.status), ours = rank(m.status);
        if (theirs > ours) { renew = true; if (word.status === 'done') return null; }
        const snap = seen.snapshot;
        const at = m.sides.map(side => (side ? (snap.espn.sides || []).indexOf(side) : -1));
        const placed = at.length === 2 && at.every(i => i >= 0);
        const before = word.status === 'scheduled';
        const scores = before ? [null, null] : placed && Array.isArray(snap.scores) ? at.map(i => scoreText(snap.scores[i])) : null;
        const innings = before ? [[], []] : placed && Array.isArray(snap.situation?.innings)
            ? at.map(i => (Array.isArray(snap.situation.innings[i]) ? snap.situation.innings[i] : []).map(r => ({ runs: r?.runs ?? null,
                wickets: r?.wickets ?? null, overs: r?.overs === '' || r?.overs === undefined || r?.overs === null ? null : String(r.overs),
                declared: false, current: r?.current === true }))) : null;
        return { ...word, moved: theirs !== ours, scores, innings };
    };
    const views = new Map();
    for (const m of [meta.lead?.m, ...meta.all, ...meta.others]) if (m && !views.has(m.id)) views.set(m.id, viewOf(m));
    if (![...views.values()].some(Boolean)) return { value, renew };
    const as = (m) => { const v = views.get(m.id); return v ? { ...m, status: v.status, breakLabel: v.breakLabel } : m; };
    const airings = [];
    let lead = value.lead;
    if (lead && meta.lead) {
        const { m, n } = meta.lead;
        const v = views.get(m.id);
        const shown = as(m);
        if (v) {
            // #297 (Codex, high): the read's summary, crease, session and a declaration go with ITS score; shown beside the
            // collector's (this account's delayed) score only when the two are the same point of the match, else held back
            const same = (a, b) => Boolean(a && b) && a.runs === b.runs && a.wickets === b.wickets && (a.overs ?? null) === (b.overs ?? null);
            const declared = (i, k, r) => lead.innings?.[i]?.[k]?.declared === true && same(lead.innings[i][k], r);
            const aligned = !v.moved && (!v.innings || (v.innings.length === (lead.innings || []).length
                && v.innings.every((list, i) => list.length === lead.innings[i].length && list.every((r, k) => same(r, lead.innings[i][k])))));
            lead = { ...lead, status: v.status, breakLabel: v.breakLabel, days: daysOf(shown, n, now), nextStart: nextStartOf(shown, n, now),
                session: aligned && v.status === 'live' && lead.status === 'live' ? lead.session : null,
                crease: aligned && ['live', 'break'].includes(v.status) ? lead.crease : null,
                summary: aligned ? lead.summary : null,
                innings: v.innings ? v.innings.map((list, i) => list.map((r, k) => ({ ...r, declared: declared(i, k, r) }))) : lead.innings,
                seriesLine: seriesLineOf(shown, meta.all.map(as)) };
        }
        const air = airingOf(shown, n, now);
        if (air) airings.push(air);
    }
    const series = value.series && { ...value.series, matches: value.series.matches.map(x => {
        const v = views.get(x.id);
        return v ? { ...x, status: v.status, result: v.status === 'done' && !v.moved ? x.result : null } : x;
    }) };
    const byId = new Map(meta.others.map(m => [m.id, m]));
    const others = value.others.map(o => {
        const m = byId.get(o.id);
        if (!m) return o;
        const n = dayCount(m);
        const air = airingOf(as(m), n, now);
        if (air) airings.push(air);
        const v = views.get(m.id);
        if (!v) return o;
        // #297 (Codex, high): the read's line goes with its own scores: shown only beside the same scores
        const aligned = !v.moved && (!v.scores || JSON.stringify(v.scores) === JSON.stringify((o.scores || []).map(x => (typeof x === 'string' && x.trim() ? x.trim() : null))));
        return { ...o, status: v.status, nextStart: nextStartOf(as(m), n, now), line: aligned ? o.line : null, scores: v.scores || o.scores };
    });
    const out = { ...value, lead, series, others };
    AIRINGS.set(out, airings);
    return { value: out, renew };
}

/** Tests: forget everything. */
function reset() { caches.reset(); pastDays.clear(); }

/** The span of the airings, for asking C-I for the events around them. */
const spanOf = (airings) => ({ from: Math.min(...airings.map(a => a.start)), to: Math.max(...airings.map(a => a.end)) });

module.exports = { page, build, reset, fetcher, prefs, matchOf, statusOf, formatOf, channelsForMatches, ttlOf, spanOf, airingsOf: (v) => AIRINGS.get(v) || [], LEAGUES };
