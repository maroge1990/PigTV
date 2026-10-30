/**
 * #21 (0376, C-Q): the NFL sport page's data, from ESPN's free NFL feeds, on demand.
 *
 * What the page shows (the "NFL · Apple TV" mock-up, DESIGN.md › Sport pages): the current week and the one before it,
 * in order (Week 7, Week 8), each game with its teams, records, score or kick-off, status (with the clock and, while
 * live, down and distance) and PigTV's own C-I channels; the teams on a bye; and the standings by division, from
 * which the page also draws the conference (seeds) and overall views. Following a team is the household's
 * (sportPagePrefs, `following.NFL` = a team abbreviation).
 *
 * Sources (verified 31 Oct 2026, no key):
 *   site …/football/nfl/scoreboard                          the current week: number, season type, byes, games
 *   site …/football/nfl/scoreboard?seasontype=T&week=N&dates=Y   another week's games
 *   site (apis/v2) …/football/nfl/standings?level=3          the eight divisions: record, seed, streak, points
 *
 * Nothing is fetched until the page is asked for; an answer is kept 2 min while a game is on, 10 min on a game day,
 * 1 h otherwise, and a stale one is served while a single refresh runs. Unofficial feed: every field is read
 * defensively, a missing one is null, and nothing here throws.
 */
const espn = require('./sportsFixturesEspn');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings?level=3';
const TIMEOUT_MS = 10000;
const HOUR_MS = 60 * 60 * 1000;
const LIVE_TTL_MS = 2 * 60 * 1000;
const GAME_DAY_TTL_MS = 10 * 60 * 1000;
const QUIET_TTL_MS = HOUR_MS;
const GAME_MS = 3.5 * HOUR_MS; // a game's length when the guide has nothing better
const COLD_WAIT_MS = 8000;

// Test seam: `get(url) -> { ok, json } | { ok: false, error }`, as sportsFixturesEspn.getJson.
const fetcher = { get: (url) => espn.getJson(url, TIMEOUT_MS) };

let cache = null;        // { value, at, ttl }
let refreshing = null;
let generation = 0;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const colour = (v) => (/^[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toUpperCase() : null);
const abbrOf = (team) => str(team?.abbreviation);

const STATUS = { pre: 'scheduled', in: 'live', post: 'done' };

/** One scoreboard event as a page game. `teams` collects each team's names, colour and logo. */
function gameOf(event, teams, registerImage) {
    const c = event?.competitions?.[0];
    if (!c) return null;
    const side = (homeAway) => {
        const x = (c.competitors || []).find(t => t?.homeAway === homeAway);
        const abbr = abbrOf(x?.team);
        if (!abbr) return null;
        if (!teams.has(abbr)) {
            const logo = str(x.team.logo);
            teams.set(abbr, { abbr, name: str(x.team.shortDisplayName) || str(x.team.name), full: str(x.team.displayName),
                location: str(x.team.location), color: colour(x.team.color), logo: logo ? registerImage(logo) : null });
        }
        const record = (x.records || []).find(r => r?.type === 'total' || r?.name === 'overall') || (x.records || [])[0];
        return { abbr, score: num(x.score), record: str(record?.summary) };
    };
    const home = side('home'), away = side('away');
    if (!home || !away) return null;
    const state = c.status?.type?.state;
    const status = STATUS[state] || 'scheduled';
    const start = ms(event.date || c.date);
    if (!Number.isFinite(start)) return null;
    // ESPN's own words: "Final", "Final/OT", "1st Quarter", "Halftime"; the clock separately.
    const period = num(c.status?.period);
    const clock = str(c.status?.displayClock);
    let detail = str(c.status?.type?.shortDetail);
    if (status === 'done') detail = /OT/i.test(detail || '') ? 'Final · OT' : 'Final';
    else if (status === 'live' && period && clock && !/half/i.test(detail || '')) detail = `${period > 4 ? 'OT' : `Q${period}`} ${clock}`;
    else if (status === 'scheduled') detail = null;
    const sit = status === 'live' ? c.situation : null;
    const possession = sit ? (c.competitors || []).find(t => String(t?.id) === String(sit.possession) || String(t?.team?.id) === String(sit.possession)) : null;
    return {
        id: str(String(event.id ?? '')),
        start, status, detail,
        home, away,
        situation: sit ? { downDistance: str(sit.downDistanceText) || str(sit.shortDownDistanceText), possession: abbrOf(possession?.team) || null,
            redZone: sit.isRedZone === true } : null,
        broadcasts: [...new Set((c.broadcasts || []).flatMap(b => b?.names || []).map(str).filter(Boolean))],
        channels: []
    };
}

/** The season's weeks of one season type, from the scoreboard's calendar: [{ number, label, start, end }]. */
function weeksOf(json, seasonType) {
    const cal = (json?.leagues?.[0]?.calendar || []).find(c => String(c?.value) === String(seasonType)) || null;
    return (cal?.entries || []).map(e => ({ number: num(e?.value), label: str(e?.label), start: ms(e?.startDate), end: ms(e?.endDate) }))
        .filter(w => w.number !== null && w.label);
}

/** The eight divisions: [{ name, conference, teams: [{ abbr, wins, losses, ties, record, seed, streak, pointsFor, pointsAgainst }] }]. */
function standingsOf(json, teams, registerImage) {
    const out = [];
    for (const conf of json?.children || []) {
        const conference = str(conf?.abbreviation) || (/american/i.test(conf?.name || '') ? 'AFC' : /national/i.test(conf?.name || '') ? 'NFC' : null);
        for (const div of conf?.children || []) {
            const rows = [];
            for (const e of div?.standings?.entries || []) {
                const abbr = abbrOf(e?.team);
                if (!abbr) continue;
                if (!teams.has(abbr)) {
                    const logo = str(e.team?.logos?.[0]?.href);
                    teams.set(abbr, { abbr, name: str(e.team.shortDisplayName) || str(e.team.name), full: str(e.team.displayName),
                        location: str(e.team.location), color: colour(e.team.color), logo: logo ? registerImage(logo) : null });
                }
                const stat = (name) => (e.stats || []).find(s => s?.name === name);
                const value = (name) => num(stat(name)?.value ?? stat(name)?.displayValue);
                rows.push({ abbr, wins: value('wins'), losses: value('losses'), ties: value('ties'),
                    record: str(stat('overall')?.displayValue) || null, seed: value('playoffSeed'),
                    streak: str(stat('streak')?.displayValue), pointsFor: value('pointsFor'), pointsAgainst: value('pointsAgainst') });
            }
            if (rows.length) out.push({ name: str(div?.name), conference, teams: rows });
        }
    }
    return out.length ? out : null;
}

/**
 * C-I channels for each game: NFL events overlapping the kick-off whose title names both teams (nickname or city),
 * or one of them when only one event overlaps. Best channels first, as C-I orders them.
 */
function channelsForGames(games, events, teams) {
    const nfl = (events || []).filter(e => e.league === 'NFL' && e.kind === 'event');
    const out = new Map();
    const names = (abbr) => [teams.get(abbr)?.name, teams.get(abbr)?.location].filter(Boolean).map(n => n.toLowerCase());
    for (const g of games) {
        const near = nfl.filter(e => e.start <= g.start + HOUR_MS && e.end > g.start - HOUR_MS);
        const says = (e, abbr) => { const t = `${e.title} ${(e.aliases || []).join(' ')}`.toLowerCase(); return names(abbr).some(n => t.includes(n)); };
        let matched = near.filter(e => says(e, g.home.abbr) && says(e, g.away.abbr));
        if (!matched.length && near.length === 1 && (says(near[0], g.home.abbr) || says(near[0], g.away.abbr))) matched = near;
        const seen = new Set();
        const list = [];
        for (const e of matched) {
            for (const ch of e.channels || []) {
                const key = `${ch.sourceId}:${ch.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                list.push(ch);
            }
        }
        if (list.length) out.set(g.id, list);
    }
    return out;
}

/** The page's ESPN part at `now` (games with `channels: []`; page() attaches them). Never rejects; null on failure. */
async function build(now, { registerImage = (u) => u } = {}) {
    const sb = await fetcher.get(`${SITE}/scoreboard`);
    if (!sb.ok || !Array.isArray(sb.json?.events)) return null;
    const seasonType = num(sb.json?.season?.type);
    const year = num(sb.json?.season?.year);
    const current = num(sb.json?.week?.number);
    if (seasonType === null || year === null || current === null) return null;
    const weeks = weeksOf(sb.json, seasonType);
    const teams = new Map();
    const index = weeks.findIndex(w => w.number === current);
    const previous = index > 0 ? weeks[index - 1] : null;
    const [prevAnswer, standingsAnswer] = await Promise.all([
        previous ? fetcher.get(`${SITE}/scoreboard?seasontype=${seasonType}&week=${previous.number}&dates=${year}`) : Promise.resolve(null),
        fetcher.get(STANDINGS)
    ]);
    const gamesOf = (json) => (json?.events || []).map(e => gameOf(e, teams, registerImage)).filter(Boolean).sort((a, b) => a.start - b.start);
    const label = (n) => weeks.find(w => w.number === n)?.label || `Week ${n}`;
    const out = [];
    if (previous && prevAnswer?.ok) out.push({ number: previous.number, label: label(previous.number), current: false, byes: byesOf(prevAnswer.json), games: gamesOf(prevAnswer.json) });
    out.push({ number: current, label: label(current), current: true, byes: byesOf(sb.json), games: gamesOf(sb.json) });
    const divisions = standingsAnswer?.ok ? standingsOf(standingsAnswer.json, teams, registerImage) : null;
    return {
        available: true,
        updatedAt: now,
        season: { year, type: seasonType === 1 ? 'preseason' : seasonType === 3 ? 'postseason' : 'regular' },
        weeks: out,
        teams: Object.fromEntries([...teams.entries()].sort(([a], [b]) => a.localeCompare(b))),
        standings: divisions ? { divisions } : null
    };
}

function byesOf(json) {
    return (json?.week?.teamsOnBye || []).map(abbrOf).filter(Boolean);
}

/** How long a page built at `now` stays fresh: short while a game is on, longer on a game day, an hour otherwise. */
function ttlOf(value, now) {
    const games = value.weeks.flatMap(w => w.games);
    if (games.some(g => g.status === 'live')) return LIVE_TTL_MS;
    if (games.some(g => g.status === 'scheduled' && g.start - now < 12 * HOUR_MS && g.start + GAME_MS > now)) return GAME_DAY_TTL_MS;
    return QUIET_TTL_MS;
}

/**
 * C-Q's answer at `now`: the cached ESPN part (refreshed in the background once stale), or, the first time, the result
 * of a refresh; `{ available: false }` while nothing has been fetched. The games' channels are this request's
 * (`deps.channelsFor`: the current guide, this user's order), never kept with the page.
 */
async function page(now = Date.now(), deps = {}) {
    const value = await espnPart(now, deps);
    if (!value.available || !deps.channelsFor) return value;
    const games = value.weeks.flatMap(w => w.games);
    let channels = new Map();
    try { channels = await deps.channelsFor(games, value.teams); } catch (err) { console.warn('[Sport] NFL page channels:', err.message); }
    return { ...value, weeks: value.weeks.map(w => ({ ...w, games: w.games.map(g => ({ ...g, channels: channels.get(g.id) || [] })) })) };
}

async function espnPart(now, deps) {
    const fresh = cache && now - cache.at < cache.ttl;
    if (!fresh && !refreshing) {
        const mine = generation;
        refreshing = build(now, deps).then((value) => {
            if (value && mine === generation) cache = { value, at: now, ttl: ttlOf(value, now) };
        }).catch((err) => console.warn('[Sport] NFL page refresh failed:', err.message))
            .finally(() => { refreshing = null; });
    }
    if (!cache && refreshing) {
        let timer;
        await Promise.race([refreshing, new Promise(resolve => { timer = setTimeout(resolve, COLD_WAIT_MS); })]);
        clearTimeout(timer);
    }
    return cache ? cache.value : { available: false };
}

/** Tests: forget everything. */
function reset() { cache = null; refreshing = null; generation++; }

/** The span of `games` with a margin, for asking C-I for the events around them. */
const spanOf = (games) => ({ from: Math.min(...games.map(g => g.start)) - HOUR_MS, to: Math.max(...games.map(g => g.start)) + GAME_MS + HOUR_MS });

module.exports = { page, build, reset, fetcher, gameOf, weeksOf, standingsOf, channelsForGames, ttlOf, spanOf, GAME_MS };
