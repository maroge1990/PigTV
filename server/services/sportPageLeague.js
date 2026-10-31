/**
 * #21 (0388, C-T): a sport page for every ESPN team league without a page of its own, so a client can show any team
 * sport with one design. Modelled on the NFL page (sportPageNFL.js, C-Q): fetched on demand only, per-answer TTLs
 * (2 min while a game is on, 10 min on a game day, 1 h otherwise), a stale answer served while one refresh runs, and
 * every field read defensively (missing → null; nothing here throws).
 *
 * Sources (verified 31 Oct 2026, no key):
 *   site …/<path>/scoreboard                                 the league's current round (week.number) or ESPN's day
 *   site …/<path>/scoreboard?seasontype=T&week=N&dates=Y     another round (round leagues: AFL, NRL)
 *   site …/<path>/scoreboard?dates=YYYYMMDD                  one US-Eastern day (day leagues: everything else)
 *   site (apis/v2) …/<path>/standings                        the table(s); kept an hour, whatever the page's TTL
 * ESPN's date ranges (dates=A-B) answer HTTP 400 on every league tried on 31 Oct 2026, so a day league asks for each
 * US-Eastern day that overlaps the server's local yesterday, today and tomorrow (up to 4; the default scoreboard's own
 * day is reused).
 *
 * Rounds: where the scoreboard reports a round (week.number), the previous round, the current one and, once the current
 * one is entirely over, the next (ESPN's calendar names them). Elsewhere games are grouped by the server's local day:
 * the day with games before the current one, the current one (today, or the next day with games) and, once it is
 * over, the next. Channels are joined per request with the dashboard's conservative game↔guide join
 * (sportsDashboard.matchBroadcasts), never kept with the page.
 */
const espn = require('./sportsFixturesEspn');
const overrun = require('./sportOverrun');
const { ESPN_LEAGUE_PATHS } = require('./sportsFixtures');
const { teamAliases } = require('./sportsScoresEspn');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
const TIMEOUT_MS = 10000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIVE_TTL_MS = 2 * 60 * 1000;
const GAME_DAY_TTL_MS = 10 * 60 * 1000;
const QUIET_TTL_MS = HOUR_MS;
const STANDINGS_TTL_MS = HOUR_MS;
const GAME_MS = 3.5 * HOUR_MS; // a game's length when nothing better is known
const COLD_WAIT_MS = 8000;
const MAX_DAYS = 4;            // US-Eastern days asked for per path (a day league)

// F1 and NFL have their own pages (C-P, C-Q); IPL and BBL are on the Cricket page (C-S).
const EXCLUDED = new Set(['F1', 'NFL', 'IPL', 'BBL']);
const LEAGUES = Object.keys(ESPN_LEAGUE_PATHS).filter(l => !EXCLUDED.has(l));
const COMPETITIONS = { 'soccer/uefa.champions': 'Champions League', 'soccer/uefa.europa': 'Europa League' };
const FAMILIES = new Set(['australian-football', 'rugby-league', 'rugby', 'soccer', 'basketball', 'baseball', 'hockey']);
const ROUND_WORD = { 'australian-football': 'Round', 'rugby-league': 'Round', rugby: 'Round', soccer: 'Matchday' };

// Test seam: `get(url) -> { ok, json } | { ok: false, error }`, as sportsFixturesEspn.getJson.
const fetcher = { get: (url) => espn.getJson(url, TIMEOUT_MS) };

const cache = new Map();      // league -> { value, join, at, ttl, standings: { value, teams, at } }
const refreshing = new Map(); // league -> promise
let generation = 0;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const colour = (v) => (/^[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toUpperCase() : null);
const pathsOf = (league) => [].concat(ESPN_LEAGUE_PATHS[league] || []);
const familyOf = (league) => { const f = String(pathsOf(league)[0] || '').split('/')[0]; return FAMILIES.has(f) ? f : null; };
const TERMINAL = new Set(['done', 'postponed', 'cancelled']);
const ongoing = (status) => status === 'live' || status === 'break';

/** A canonical league this page serves (as written, or case-insensitively), or null. */
function leagueOf(name) {
    if (typeof name !== 'string') return null;
    return LEAGUES.find(l => l === name) || LEAGUES.find(l => l.toLowerCase() === name.trim().toLowerCase()) || null;
}

// ---- days in a time zone ----------------------------------------------------------------------------------------

const formats = new Map();
function dayIn(t, zone) {
    if (!formats.has(zone)) {
        if (formats.size >= 8) formats.delete(formats.keys().next().value);
        formats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    }
    const parts = formats.get(zone).formatToParts(t);
    const v = (type) => parts.find(p => p.type === type).value;
    return `${v('year')}-${v('month')}-${v('day')}`;
}
function zoneOf(zone) {
    const z = zone || process.env.TZ || 'Australia/Melbourne';
    try { dayIn(Date.now(), z); return z; } catch { return 'Australia/Melbourne'; }
}

/**
 * Local yesterday, today and tomorrow at `now` (as YYYY-MM-DD in `zone`), and the US-Eastern days (YYYYMMDD, ESPN's
 * scoreboard days) that overlap them, sampled every 15 min so half-hour zones are covered.
 */
function windowOf(now, zone) {
    const step = 15 * 60 * 1000;
    const from = Math.floor(now / step) * step - 3 * DAY_MS, to = now + 3 * DAY_MS;
    const days = [];
    const samples = [];
    for (let t = from; t <= to; t += step) {
        const d = dayIn(t, zone);
        if (days[days.length - 1] !== d) days.push(d);
        samples.push([t, d]);
    }
    const today = dayIn(now, zone);
    const i = days.indexOf(today);
    const yesterday = days[i - 1] || null, tomorrow = days[i + 1] || null;
    const wanted = new Set([yesterday, today, tomorrow]);
    const espnDays = [];
    for (const [t, d] of samples) {
        if (!wanted.has(d)) continue;
        const e = dayIn(t, 'America/New_York').replace(/-/g, '');
        if (!espnDays.includes(e)) espnDays.push(e);
    }
    return { yesterday, today, tomorrow, espnDays };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(key, { yesterday, today, tomorrow }) {
    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';
    if (key === tomorrow) return 'Tomorrow';
    const d = new Date(`${key}T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : key;
}

// ---- one game ---------------------------------------------------------------------------------------------------

/** ESPN's status as the page's: scheduled, live, break, done, postponed or cancelled. */
function statusOf(c, family) {
    const t = c?.status?.type || {};
    const words = `${t.name || ''} ${t.description || ''}`;
    if (/cancel|abandon|forfeit/i.test(words)) return 'cancelled';
    if (/postpon/i.test(words)) return 'postponed';
    if (t.state === 'pre') return 'scheduled';
    if (t.completed === true || t.state === 'post') return 'done';
    if (t.state === 'in') {
        const text = `${words} ${t.shortDetail || ''} ${t.detail || ''}`;
        if (/half.?time|\bHT\b|quarter.?time|three.?quarter|intermission|suspend|delay/i.test(text)) return 'break';
        if (family !== 'baseball' && /end.?period|end of (?:the )?(?:\d|first|second|third|fourth)/i.test(text)) return 'break';
        return 'live';
    }
    return 'scheduled';
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;

/** The short text beside the score: null before the start; the period and clock while live; the break; the result. */
function detailOf(c, status, family) {
    const t = c?.status?.type || {};
    const short = str(t.shortDetail) || str(t.detail);
    if (status === 'scheduled' || status === 'postponed' || status === 'cancelled') return null;
    if (status === 'break') return short || 'Break';
    if (status === 'done') {
        if (family === 'soccer') return /pen/i.test(short || '') ? 'FT · Pens' : /AET|extra/i.test(short || '') ? 'AET' : 'FT';
        if (family === 'baseball') { const inn = /\/(\d+)/.exec(short || ''); return inn ? `Final · ${inn[1]} inn` : 'Final'; }
        return /\bOT\b|overtime|\bSO\b|shoot.?out|golden|extra/i.test(short || '') ? 'Final · OT' : 'Final';
    }
    const period = num(c?.status?.period);
    const clock = str(c?.status?.displayClock);
    if (!period) return short;
    if (family === 'australian-football' || family === 'basketball') return clock ? `${period > 4 ? 'OT' : `Q${period}`} ${clock}` : short;
    if (family === 'hockey') return clock ? `${period > 3 ? 'OT' : ordinal(period)} ${clock}` : short;
    if (family === 'soccer' || family === 'rugby' || family === 'rugby-league') {
        const half = period === 1 ? '1st Half' : period === 2 ? '2nd Half' : (family === 'soccer' && period >= 5) ? 'Penalties' : 'Extra Time';
        return half === 'Penalties' ? half : (clock && /\d/.test(clock) ? `${half} ${clock}` : half);
    }
    return short; // baseball: ESPN's "Top 5th"
}

function teamOf(team, teams, registerImage, logo) {
    // Keyed by ESPN's team id: abbreviations repeat across a merged competition (UEFA).
    const id = str(String(team?.id ?? ''));
    const abbr = str(team?.abbreviation);
    if (!id || !abbr) return null;
    if (!teams.has(id)) {
        teams.set(id, { id, abbr, name: str(team.shortDisplayName) || str(team.name), full: str(team.displayName),
            location: str(team.location), color: colour(team.color), logo: logo ? registerImage(logo) : null });
    }
    return teams.get(id);
}

/**
 * One scoreboard event as a page game, and what the channel join needs (the teams' names, never in the answer).
 * `teams` collects each team's names, colour and logo. Null when the event lacks two teams or a start.
 */
function gameOf(event, { family, competition = null, league = null, teams = new Map(), registerImage = (u) => u } = {}) {
    const c = event?.competitions?.[0];
    if (!c) return null;
    const start = ms(c.date || event.date);
    if (!Number.isFinite(start)) return null;
    const status = statusOf(c, family);
    const before = status === 'scheduled' || status === 'postponed' || status === 'cancelled';
    const sides = {};
    for (const homeAway of ['home', 'away']) {
        const x = (c.competitors || []).find(t => t?.homeAway === homeAway);
        const t = teamOf(x?.team, teams, registerImage, str(x?.team?.logo));
        if (!t) return null;
        sides[homeAway] = { side: { id: t.id, abbr: t.abbr, score: before ? null : str(String(x.score ?? '')) }, aliases: teamAliases(x.team) };
    }
    if (sides.home.side.id === sides.away.side.id) return null;
    const game = {
        id: str(String(event.id ?? '')),
        start, status, detail: detailOf(c, status, family),
        home: sides.home.side, away: sides.away.side,
        venue: str(c.venue?.fullName) || str(event.venue?.displayName) || null,
        competition,
        channels: []
    };
    if (!game.id) return null;
    return { game, join: { id: game.id, league, start, competitors: [{ aliases: sides.home.aliases }, { aliases: sides.away.aliases }] },
        week: num(event.week?.number), seasonType: num(event.season?.type) };
}

// ---- standings --------------------------------------------------------------------------------------------------

// [key, label, ESPN stat names in order of preference], per sport family; a column no row has is dropped.
const COLUMNS = {
    'australian-football': [['played', 'P', ['gamesPlayed']], ['wins', 'W', ['wins']], ['losses', 'L', ['losses']], ['draws', 'D', ['ties']],
        ['points', 'Pts', ['points']], ['percentage', '%', ['percentage']]],
    'rugby-league': [['played', 'P', ['gamesPlayed']], ['wins', 'W', ['gamesWon', 'wins']], ['losses', 'L', ['gamesLost', 'losses']],
        ['draws', 'D', ['gamesDrawn', 'ties']], ['diff', 'Diff', ['pointsDifference', 'pointDifferential']], ['points', 'Pts', ['points']]],
    soccer: [['played', 'P', ['gamesPlayed']], ['wins', 'W', ['wins']], ['draws', 'D', ['ties']], ['losses', 'L', ['losses']],
        ['diff', 'GD', ['pointDifferential']], ['points', 'Pts', ['points']]],
    basketball: [['wins', 'W', ['wins']], ['losses', 'L', ['losses']], ['pct', 'PCT', ['winPercent']], ['gb', 'GB', ['gamesBehind']]],
    hockey: [['played', 'GP', ['gamesPlayed']], ['wins', 'W', ['wins']], ['losses', 'L', ['losses']], ['otl', 'OTL', ['otLosses', 'overtimeLosses']],
        ['points', 'PTS', ['points']]]
};
COLUMNS.rugby = COLUMNS['rugby-league'];
COLUMNS.baseball = COLUMNS.basketball;

/** The leaf tables of one standings answer: [{ name, entries }]. */
function tablesOf(node, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 4) return out;
    if (Array.isArray(node.standings?.entries) && node.standings.entries.length) out.push({ name: str(node.name), entries: node.standings.entries });
    for (const child of Array.isArray(node.children) ? node.children : []) tablesOf(child, out, depth + 1);
    return out;
}

/**
 * Standings answers (one per path, with its competition) as `{ groups: [{ name, columns, rows }] }`, or null. A single
 * table has `name: null`; several are named by ESPN (conference, league), or by their competition (UEFA).
 */
function standingsOf(answers, family, teams, registerImage) {
    const columns = COLUMNS[family] || [];
    const tables = [];
    for (const { json, competition } of answers) {
        const found = tablesOf(json);
        for (const t of found) tables.push({ ...t, name: competition ? (found.length > 1 && t.name ? `${competition} · ${t.name}` : competition) : t.name });
    }
    if (!tables.length) return null;
    const groups = [];
    for (const table of tables) {
        let rows = [];
        for (const [i, e] of table.entries.entries()) {
            const t = teamOf(e?.team, teams, registerImage, str(e?.team?.logos?.[0]?.href));
            if (!t) continue;
            const stat = (names) => { for (const n of names) { const s = (e.stats || []).find(x => x?.name === n); if (s) return s; } return null; };
            const values = {};
            for (const [key, , names] of columns) { const s = stat(names); values[key] = s ? (str(s.displayValue) ?? (num(s.value) !== null ? String(s.value) : null)) : null; }
            const rank = num(stat(['rank'])?.value ?? stat(['rank'])?.displayValue)
                ?? (family === 'basketball' || family === 'hockey' ? num(stat(['playoffSeed'])?.value ?? stat(['playoffSeed'])?.displayValue) : null);
            rows.push({ id: t.id, abbr: t.abbr, rank, values, order: i, pct: num(stat(['winPercent'])?.value ?? stat(['winPercent'])?.displayValue) });
        }
        if (!rows.length) continue;
        if (rows.every(r => r.rank !== null)) rows.sort((a, b) => a.rank - b.rank || a.order - b.order);
        else if (family === 'baseball') rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.order - b.order);
        rows = rows.map((r, i) => ({ id: r.id, abbr: r.abbr, rank: r.rank ?? i + 1, values: r.values }));
        groups.push({ name: tables.length > 1 ? table.name : null, rows });
    }
    if (!groups.length) return null;
    const kept = columns.filter(([key]) => groups.some(g => g.rows.some(r => r.values[key] !== null)));
    return { groups: groups.map(g => ({ name: g.name, columns: kept.map(([key, label]) => ({ key, label })),
        rows: g.rows.map(r => ({ id: r.id, abbr: r.abbr, rank: r.rank, values: Object.fromEntries(kept.map(([key]) => [key, r.values[key]])) })) })) };
}

// ---- the season and its rounds ----------------------------------------------------------------------------------

/** The scoreboard calendar's rounds in order, across season types: [{ type, week, label }]. */
function calendarOf(json) {
    const out = [];
    for (const cal of json?.leagues?.[0]?.calendar || []) {
        if (!cal || typeof cal !== 'object') continue;
        const type = num(cal.value);
        for (const e of cal.entries || []) {
            const week = num(e?.value);
            if (type !== null && week !== null) out.push({ type, week, label: str(e.label) });
        }
    }
    return out;
}

function seasonOf(json, family) {
    const lg = json?.leagues?.[0]?.season || {};
    const type = num(json?.season?.type) ?? num(lg.type?.type);
    const cal = (json?.leagues?.[0]?.calendar || []).find(c => c && typeof c === 'object' && num(c.value) === type);
    const event = (json?.events || []).find(e => num(e?.season?.type) === type);
    const words = [str(cal?.label), str(event?.season?.slug), num(lg.type?.type) === type ? str(lg.type?.name) : null].filter(Boolean).join(' ');
    let kind = null;
    if (/post|playoff/i.test(words) || (family !== 'soccer' && /final/i.test(words))) kind = 'postseason';
    else if (/pre.?season/i.test(words)) kind = 'preseason';
    else if (/reg/i.test(words)) kind = 'regular';
    else if (!words && family !== 'soccer' && [1, 2, 3].includes(type)) kind = ['preseason', 'regular', 'postseason'][type - 1];
    return { year: num(json?.season?.year) ?? num(lg.year), type: kind, label: str(lg.displayName) };
}

function roundLabel(entry, week, family) {
    const word = ROUND_WORD[family] || 'Week';
    if (entry?.label && !/^(?:round|week|matchday)\s*\d+$/i.test(entry.label)) return entry.label;
    return `${word} ${week}`;
}

const allOver = (games) => games.length > 0 && games.every(g => TERMINAL.has(g.status));

/** One path's games: { ok, mode, season, rounds? (round mode), parsed: [gameOf…] }. */
async function fetchPath(path, ctx) {
    const sb = await fetcher.get(`${SITE}/${path}/scoreboard`);
    if (!sb.ok || !Array.isArray(sb.json?.events)) return { ok: false };
    const { family, league, teams, registerImage, now, zone } = ctx;
    const competition = COMPETITIONS[path] || null;
    const parse = (json) => (Array.isArray(json?.events) ? json.events : []).map(e => gameOf(e, { family, competition, league, teams, registerImage })).filter(Boolean);
    const season = seasonOf(sb.json, family);
    const week = num(sb.json?.week?.number);
    const type = num(sb.json?.season?.type);
    if (week !== null && type !== null && ctx.single) {
        const cal = calendarOf(sb.json);
        const i = cal.findIndex(c => c.type === type && c.week === week);
        const prev = i > 0 ? cal[i - 1] : null, next = i >= 0 ? cal[i + 1] || null : null;
        const year = season.year;
        const roundUrl = (r) => `${SITE}/${path}/scoreboard?seasontype=${r.type}&week=${r.week}${year !== null ? `&dates=${year}` : ''}`;
        const only = (list, r) => list.filter(p => (p.week === null || p.week === r.week) && (p.seasonType === null || p.seasonType === r.type));
        const current = { type, week, label: (cal[i] || {}).label || null };
        const currentGames = only(parse(sb.json), current);
        const [prevAnswer, nextAnswer] = await Promise.all([
            prev ? fetcher.get(roundUrl(prev)) : null,
            next && allOver(currentGames.map(p => p.game)) ? fetcher.get(roundUrl(next)) : null
        ]);
        const rounds = [];
        if (prev && prevAnswer?.ok) rounds.push({ key: `${prev.type}:${prev.week}`, label: roundLabel(prev, prev.week, family), current: false, parsed: only(parse(prevAnswer.json), prev) });
        rounds.push({ key: `${type}:${week}`, label: roundLabel(cal[i], week, family), current: true, parsed: currentGames });
        if (next && nextAnswer?.ok) rounds.push({ key: `${next.type}:${next.week}`, label: roundLabel(next, next.week, family), current: false, parsed: only(parse(nextAnswer.json), next) });
        return { ok: true, mode: 'rounds', season, rounds };
    }
    // A day league: ESPN's own day (the default scoreboard) and each US-Eastern day around the server's local three.
    const { espnDays } = windowOf(now, zone);
    const own = str(sb.json?.day?.date)?.replace(/-/g, '') || null;
    const ask = espnDays.filter(d => d !== own).slice(0, MAX_DAYS);
    const answers = await Promise.all(ask.map(d => fetcher.get(`${SITE}/${path}/scoreboard?dates=${d}&limit=100`)));
    const parsed = parse(sb.json);
    for (const a of answers) if (a?.ok) parsed.push(...parse(a.json));
    return { ok: true, mode: 'days', season, parsed };
}

/** Day-league games grouped by local day: the day before the current one, the current one, and the next once it is over. */
function dayRounds(parsed, now, zone) {
    const win = windowOf(now, zone);
    const byDay = new Map();
    const seen = new Set();
    for (const p of parsed) {
        if (seen.has(p.game.id)) continue;
        seen.add(p.game.id);
        const d = dayIn(p.game.start, zone);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(p);
    }
    const days = [...byDay.keys()].sort();
    if (!days.length) return [];
    let i = days.findIndex(d => d >= win.today);
    if (i < 0) i = days.length - 1;
    const round = (d, current) => ({ key: d, label: dayLabel(d, win), current, parsed: byDay.get(d) });
    const out = [];
    if (i > 0) out.push(round(days[i - 1], false));
    out.push(round(days[i], true));
    if (days[i + 1] && allOver(byDay.get(days[i]).map(p => p.game))) out.push(round(days[i + 1], false));
    return out;
}

/**
 * The page's ESPN part for `league` at `now` (games with `channels: []`; page() attaches them), with the channel join's
 * data beside it. Never rejects; null when no scoreboard answered. `prior` is the cached entry, whose standings are
 * reused while under an hour old.
 */
async function build(league, now, { registerImage = (u) => u, zone, prior = null } = {}) {
    const paths = pathsOf(league);
    const family = familyOf(league);
    if (!paths.length || !family) return null;
    zone = zoneOf(zone);
    const teams = new Map();
    const ctx = { family, league, teams, registerImage, now, zone, single: paths.length === 1 };
    const reuse = prior?.standings && now - prior.standings.at < STANDINGS_TTL_MS && now >= prior.standings.at ? prior.standings : null;
    const [results, standingsAnswers] = await Promise.all([
        Promise.all(paths.map(p => fetchPath(p, ctx).catch(() => ({ ok: false })))),
        reuse ? null : Promise.all(paths.map(p => fetcher.get(`${STANDINGS}/${p}/standings`).then(a => (a?.ok ? { json: a.json, competition: COMPETITIONS[p] || null } : null)).catch(() => null)))
    ]);
    const ok = results.filter(r => r.ok);
    if (!ok.length) return null;
    let rounds;
    if (ok.length === 1 && ok[0].mode === 'rounds') rounds = ok[0].rounds;
    else rounds = dayRounds(ok.flatMap(r => r.mode === 'rounds' ? r.rounds.flatMap(x => x.parsed) : r.parsed), now, zone);
    const join = [];
    const outRounds = rounds.map(r => {
        const parsed = r.parsed.slice().sort((a, b) => a.game.start - b.game.start || String(a.game.id).localeCompare(String(b.game.id)));
        for (const p of parsed) join.push({ ...p.join, status: p.game.status });
        return { key: r.key, label: r.label, current: r.current, games: parsed.map(p => p.game) };
    });
    let standings;
    const answered = (standingsAnswers || []).filter(Boolean);
    if (!reuse && answered.length) {
        const before = new Set(teams.keys());
        const parsed = standingsOf(answered, family, teams, registerImage);
        standings = { value: parsed, teams: [...teams.values()].filter(t => !before.has(t.id)), at: now };
    } else {
        // Under an hour old, or this refresh's request failed: the last good table, if any (retried next refresh).
        standings = reuse || prior?.standings || { value: null, teams: [], at: -Infinity };
        for (const t of standings.teams) if (!teams.has(t.id)) teams.set(t.id, t);
    }
    const value = {
        available: true,
        updatedAt: now,
        league,
        sport: family,
        season: ok[0].season,
        rounds: outRounds,
        teams: Object.fromEntries([...teams.entries()].sort(([, a], [, b]) => a.abbr.localeCompare(b.abbr) || a.id.localeCompare(b.id))),
        following: null,
        standings: standings.value
    };
    return { value, join, standings };
}

/** How long a page built at `now` stays fresh: short while a game is on, longer on a game day, an hour otherwise. */
function ttlOf(value, now) {
    const games = (value.rounds || []).flatMap(r => r.games);
    if (games.some(g => ongoing(g.status))) return LIVE_TTL_MS;
    if (games.some(g => g.status === 'scheduled' && g.start - now < 12 * HOUR_MS && g.start + GAME_MS > now)) return GAME_DAY_TTL_MS;
    return QUIET_TTL_MS;
}

/** The household's followed team's id in `teams` (by name, full name or abbreviation, any case): the first of `names` found. */
function followingOf(teams, names) {
    for (const n of Array.isArray(names) ? names : []) {
        if (typeof n !== 'string' || !n.trim()) continue;
        const want = n.trim().toLowerCase();
        const t = Object.values(teams || {}).find(x => [x.name, x.full, x.abbr].some(v => typeof v === 'string' && v.toLowerCase() === want));
        if (t) return t.id;
    }
    return null;
}

/**
 * C-I channels for each game, by the dashboard's join (sportsDashboard.matchBroadcasts: both teams named, start within
 * 90 min; an airing that fits two games joins neither). Best channels first, as C-I orders them; #191's overrun rule
 * with the page's `updatedAt` as observedAt.
 */
function channelsForGames(joinGames, events, { now, observedAt } = {}) {
    const { matchBroadcasts } = require('./sportsDashboard');
    const out = new Map();
    const matched = matchBroadcasts(joinGames.map(g => ({ id: g.id, league: g.league, start: g.start, competitors: g.competitors })), events || []);
    for (const g of joinGames) {
        const seen = new Set();
        const list = [];
        for (const e of matched.get(g.id) || []) {
            for (const ch of e.channels || []) {
                const key = `${ch.sourceId}:${ch.id}`;
                if (seen.has(key)) continue;
                const kept = overrun.keep(ch, e, ongoing(g.status), now, observedAt);
                if (!kept) continue;
                seen.add(key);
                list.push(kept);
            }
        }
        if (list.length) out.set(g.id, list);
    }
    return out;
}

/**
 * C-T's answer for `league` at `now`: the cached ESPN part (refreshed in the background once stale), or, the first time,
 * the result of a refresh; `{ available: false }` while nothing has been fetched. Channels (`deps.channelsFor(joinGames,
 * observedAt)`) and `following` (`deps.followed()`: the household's names for this league) are this request's.
 */
async function page(league, now = Date.now(), deps = {}) {
    const entry = await espnPart(league, now, deps);
    if (!entry) return { available: false };
    let value = entry.value;
    let following = null;
    try { following = followingOf(value.teams, deps.followed ? deps.followed() : []); } catch (err) { console.warn('[Sport] league page following:', err.message); }
    value = { ...value, following };
    if (!deps.channelsFor) return value;
    let channels = new Map();
    try { channels = (await deps.channelsFor(entry.join, value.updatedAt)) || new Map(); } catch (err) { console.warn('[Sport] league page channels:', err.message); }
    return { ...value, rounds: value.rounds.map(r => ({ ...r, games: r.games.map(g => ({ ...g, channels: channels.get(g.id) || [] })) })) };
}

async function espnPart(league, now, deps) {
    const cached = cache.get(league);
    const fresh = cached && now - cached.at < cached.ttl;
    if (!fresh && !refreshing.has(league)) {
        const mine = generation;
        const p = build(league, now, { ...deps, prior: cached || null }).then((built) => {
            if (built && mine === generation) cache.set(league, { value: built.value, join: built.join, standings: built.standings, at: now, ttl: ttlOf(built.value, now) });
        }).catch((err) => console.warn('[Sport] league page refresh failed:', err.message))
            .finally(() => { if (refreshing.get(league) === p) refreshing.delete(league); });
        refreshing.set(league, p);
    }
    if (!cache.has(league) && refreshing.has(league)) {
        let timer;
        await Promise.race([refreshing.get(league), new Promise(resolve => { timer = setTimeout(resolve, COLD_WAIT_MS); })]);
        clearTimeout(timer);
    }
    return cache.get(league) || null;
}

/** Tests: forget everything. */
function reset() { cache.clear(); refreshing.clear(); generation++; }

/** The span of the join's games with a margin, for asking C-I for the events around them. */
const spanOf = (games) => ({ from: Math.min(...games.map(g => g.start)) - 2 * HOUR_MS, to: Math.max(...games.map(g => g.start)) + GAME_MS + HOUR_MS });

module.exports = { LEAGUES, page, build, reset, fetcher, leagueOf, gameOf, statusOf, detailOf, standingsOf, seasonOf, calendarOf,
    windowOf, dayRounds, channelsForGames, followingOf, ttlOf, spanOf, GAME_MS };
