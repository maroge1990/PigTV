/**
 * 0428 (C-V, #197, D-43): the sport pages of the leagues followed by individuals (tennis, golf, UFC, IndyCar, NASCAR),
 * from ESPN's free feeds, on demand. One answer per league: this week's events, the same ones (and the same ids, dates
 * and states) as the C-R cards (sportIndividual.normalize), each with what its page draws:
 *
 *   tennis  every match, flat (draw, round, court, players with seed and country, set scores), and the draws' rounds
 *   golf    the whole field in position order (position, to par, each round's strokes, cut or withdrawn)
 *   fight   the bouts in the feed's order (first bout to main event), each on the main card or the prelims, with its
 *           winner and the round and clock it ended in
 *   race    the entry list (alphabetical), plus the last race's winner and the next race (top level)
 *
 * Sources (checked on 1 Nov 2026, no key):
 *   …/<feed>/scoreboard                       tennis and golf: this week's events (as the cards); racing: the season
 *                                             calendar (whose times are hours out, so they only find a race's day)
 *   …/golf/leaderboard?league=<tour>          golf: each player's position ("T4") and status (missed cut), by player id
 *   …/<feed>/scoreboard?dates=A-B             UFC and racing: the events from 3 days ago to 7 days ahead; racing: the
 *                                             last and the next race's days, when they are outside that
 * What the feeds do not give is never sent (D-43): a tennis point score or server, golf tee times or the hole a
 * player is on, a UFC method or record, a race's running order, practice or standings, a car number or team.
 *
 * Nothing is fetched until a page is asked for; an answer is kept 10 min while one of its events is on, 1 h otherwise,
 * and a stale one is served while a single refresh runs (as C-P). Results are always sent: the client hides them when
 * the account is spoiler-free (C-P, C-S, C-T). `followed` is per request: the account's follows never enter the cache.
 */
const individual = require('./sportIndividual');
const { stateOf, place, text, time, personKey } = individual;
const { BASE, fetchJson } = require('./sportsScoresEspn');

const KINDS = Object.freeze(Object.fromEntries(Object.entries(individual.LEAGUES).map(([l, s]) => [l, s.kind])));
const LEAGUES = Object.keys(KINDS);
const SPORT = { tennis: 'Tennis', golf: 'Golf', fight: 'Combat', race: 'Motorsport' };
const DAY = 24 * 3600000;
const ON_TTL_MS = 10 * 60 * 1000;
const QUIET_TTL_MS = 60 * 60 * 1000;
const BACK_DAYS = 3, AHEAD_DAYS = 7; // UFC and racing: "this week"
const MAX_MATCHES = 1500, MAX_FIELD = 300, MAX_BOUTS = 40, MAX_ENTRIES = 80;

const TUNING = Object.freeze({ coldWaitMs: 8000 });
const tuning = { ...TUNING };
// Test seam: `get(url) -> { ok, json } | { ok: false, error }`.
const fetcher = {
    get: async (url) => {
        try { return { ok: true, json: await fetchJson(url, { maxBytes: individual.MAX_BYTES }) }; }
        catch (err) { return { ok: false, error: err.message }; }
    }
};

const caches = new Map();     // league -> { value, at, ttl }
const refreshing = new Map(); // league -> the refresh in flight
let generation = 0;

/** The canonical league for `name` (any case), or null outside the five sports' catalogue leagues. */
function leagueOf(name) {
    if (typeof name !== 'string') return null;
    const wanted = name.trim().toLowerCase();
    return LEAGUES.find(l => l.toLowerCase() === wanted) || null;
}

const list = (v) => (Array.isArray(v) ? v : []);
const int = (v) => (Number.isInteger(v) ? v : null);
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const range = (from, to) => `?dates=${ymd(from)}-${ymd(to)}`;
const country = (a) => text(a?.flag?.alt, 60) || null;
// A winner only once the match or bout is over (ESPN says `false` for both sides before then).
const winnerOf = (x, status) => (status === 'finished' ? x?.winner === true : null);
const byOrder = (a, b) => (Number(a?.order) || 99) - (Number(b?.order) || 99);

/** The event's common fields from its C-R card. `players` stays internal (the account's follows are found in it). */
function eventBase(card) {
    const { state, breakLabel } = card.snapshot || {};
    return { id: card.id, name: card.title, start: card.start, end: card.end, status: state || 'unknown',
        ...(breakLabel ? { breakLabel } : {}), venue: card.circuit, players: card.players || [] };
}
/** The cards normalize() makes from one answer, each with its raw ESPN event. */
function cardsOf(json, league) {
    const path = individual.LEAGUES[league].path;
    const raw = new Map(list(json?.events).map(e => [`espn:${path}:${e?.id}`, e]));
    return individual.normalize(json, league, path).map(card => ({ card, event: raw.get(card.id) }));
}

// ---- tennis ----
function tennisPlayer(x, status) {
    const pair = list(x?.roster?.athletes);
    const names = pair.length ? pair.map(a => text(a?.displayName, 80)) : [text(x?.athlete?.displayName, 80)];
    const known = names.filter(n => n && n !== 'TBD');
    const countries = [...new Set((pair.length ? pair : [x?.athlete]).map(country))];
    return { name: known.length === names.length ? known.join(' / ') : null, seed: int(x?.curatedRank?.current),
        country: countries.length === 1 ? countries[0] : null, winner: winnerOf(x, status) };
}
function setsOf(players) {
    const lines = players.map(x => list(x?.linescores));
    const n = Math.max(0, ...lines.map(l => l.length));
    if (!n || lines.length !== 2) return null;
    return Array.from({ length: n }, (_, i) => lines.map(l => (Number.isFinite(l[i]?.value) ? l[i].value : null)));
}
// Qualifying first, then the main draw, each in ESPN's round order ("Round 1" id 1 … "Final" id 7; qualifying 11–14).
const roundKey = (r) => [/qualif/i.test(r.name) ? 0 : 1, Number(r.id) || 99];
function tennisPart(event) {
    const matches = [], draws = [];
    for (const g of list(event?.groupings)) {
        const draw = text(g?.grouping?.displayName, 80);
        if (!draw) continue;
        const rounds = new Map();
        for (const c of list(g?.competitions)) {
            const id = String(c?.id ?? '');
            if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || matches.length >= MAX_MATCHES) continue;
            const competitors = list(c?.competitors).slice().sort(byOrder);
            const round = text(c?.round?.displayName, 60) || null;
            const status = stateOf(c?.status);
            matches.push({ id, draw, round, start: time(c?.date), status, court: text(c?.venue?.court, 60) || null,
                players: competitors.map(x => tennisPlayer(x, status)), sets: setsOf(competitors) });
            const key = round || '';
            if (!rounds.has(key)) rounds.set(key, { id: c?.round?.id, name: round, matchIds: [] });
            rounds.get(key).matchIds.push({ id, start: time(c?.date) });
        }
        const ordered = [...rounds.values()].sort((a, b) => { const [x, y] = [roundKey(a), roundKey(b)]; return x[0] - y[0] || x[1] - y[1]; });
        draws.push({ name: draw, rounds: ordered.map(r => ({ name: r.name,
            matchIds: r.matchIds.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id)).map(m => m.id) })) });
    }
    matches.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id));
    return { matches, draws };
}

// ---- golf ----
const GOLF_STATUS = [[/CUT/, 'cut'], [/WD|WITHDR/, 'wd'], [/DQ|DISQUAL/, 'dq']];
/** Player id -> { pos, status } from the leaderboard feed's event `eventId`. */
function positionsOf(json, eventId) {
    const out = new Map();
    const e = list(json?.events).find(x => String(x?.id) === String(eventId));
    for (const y of list(e?.competitions?.[0]?.competitors)) {
        const shown = text(y?.status?.position?.displayName, 8);
        const name = String(y?.status?.type?.name || '');
        out.set(String(y?.id), { pos: shown && shown !== '-' ? shown : null, status: (GOLF_STATUS.find(([re]) => re.test(name)) || [])[1] || null });
    }
    return out;
}
// A round's strokes once it is played: ESPN lists its holes; a round still being played (fewer than 18) is null.
function roundsOf(x) {
    return [1, 2, 3, 4].map(n => {
        const r = list(x?.linescores).find(l => l?.period === n);
        if (!r || !Number.isFinite(r.value) || r.value <= 0) return null;
        return Array.isArray(r.linescores) && r.linescores.length < 18 ? null : r.value;
    });
}
function golfPart(event, positions) {
    const c = list(event?.competitions)[0];
    const field = list(c?.competitors).slice().sort(byOrder).slice(0, MAX_FIELD);
    return { round: int(c?.status?.period) && c.status.period > 0 ? c.status.period : null,
        leaderboard: field.map(x => {
            const known = positions?.get(String(x?.id));
            return { pos: known?.pos ?? null, name: text(x?.athlete?.displayName, 80) || null, country: country(x?.athlete),
                toPar: text(x?.score, 8) || null, rounds: roundsOf(x), status: known?.status ?? null };
        }) };
}

// ---- UFC ----
// The main card is the bouts that start last; every earlier start is the prelims (ESPN gives each part one start time).
function fightPart(event) {
    const bouts = list(event?.competitions).slice(0, MAX_BOUTS);
    const starts = bouts.map(b => time(b?.date)).filter(t => t !== null);
    const main = starts.length ? Math.max(...starts) : null;
    return { bouts: bouts.map(b => {
        const status = stateOf(b?.status), start = time(b?.date);
        return { id: String(b?.id ?? ''), start, status, weightClass: text(b?.type?.abbreviation, 40) || null,
            card: start === null || start === main ? 'main' : 'prelims',
            fighters: list(b?.competitors).slice().sort(byOrder).map(x => ({ name: text(x?.athlete?.displayName, 80) || null, winner: winnerOf(x, status) })),
            result: status === 'finished' && int(b?.status?.period) ? { round: b.status.period, clock: text(b?.status?.displayClock, 8) || null } : null };
    }) };
}

// ---- racing ----
function entryListOf(event) {
    const c = list(event?.competitions)[0];
    return [...new Set(list(c?.competitors).map(x => text(x?.athlete?.displayName, 80)).filter(n => n && n !== 'TBD'))]
        .sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENTRIES).map(name => ({ name }));
}
function winnerOfRace(event) {
    const c = list(event?.competitions)[0];
    const w = list(c?.competitors).find(x => x?.winner === true);
    const name = text(w?.athlete?.displayName, 80);
    return name ? { name, race: text(event?.name), date: time(c?.date || event?.date) } : null;
}
/** The season's races from a scoreboard's calendar: [{ eventId, name, start }] (start the calendar's: hours out). */
function calendarOf(json) {
    return list(json?.leagues?.[0]?.calendar).map(c => ({ eventId: (/\/events\/(\d+)/.exec(String(c?.event?.$ref || '')) || [])[1] || null,
        name: text(c?.label), start: time(c?.startDate) })).filter(c => c.eventId && c.name && c.start !== null).sort((a, b) => a.start - b.start);
}
/** One race by id from the days around its calendar date (ESPN's days are US Eastern), or null. */
async function raceOn(spec, entry) {
    const r = await fetcher.get(`${BASE}${spec.path}/scoreboard${range(entry.start - DAY, entry.start + DAY)}`);
    return r.ok ? list(r.json?.events).find(e => String(e?.id) === entry.eventId) || null : null;
}

async function build(league, now) {
    const spec = individual.LEAGUES[league], kind = spec.kind;
    const out = { available: true, league, sport: SPORT[kind], kind, updatedAt: now, events: [] };
    if (kind === 'tennis' || kind === 'golf') {
        const sb = await fetcher.get(`${BASE}${spec.path}/scoreboard`);
        if (!sb.ok) return null;
        const found = cardsOf(sb.json, league);
        // Golf: positions and cuts from the leaderboard; without it, `pos` and `status` are null (never worked out here).
        const board = kind === 'golf' && found.length ? await fetcher.get(`${BASE}golf/leaderboard?league=${spec.path.split('/')[1]}`) : null;
        out.events = found.map(({ card, event }) => ({ ...eventBase(card),
            ...(kind === 'tennis' ? tennisPart(event) : golfPart(event, board?.ok ? positionsOf(board.json, event?.id) : null)) }));
        return out;
    }
    const week = await fetcher.get(`${BASE}${spec.path}/scoreboard${range(now - BACK_DAYS * DAY, now + AHEAD_DAYS * DAY)}`);
    if (!week.ok) return null;
    const found = cardsOf(week.json, league);
    out.events = found.map(({ card, event }) => ({ ...eventBase(card), ...(kind === 'fight' ? fightPart(event) : { entryList: entryListOf(event) }) }));
    if (kind !== 'race') return out;
    // The last winner and the next race: this week's when it has them, else the calendar's race, asked for by its day.
    const finished = found.filter(f => f.card.snapshot?.state === 'finished').map(f => winnerOfRace(f.event)).filter(Boolean);
    const coming = found.filter(f => f.card.snapshot?.state === 'scheduled' && f.card.start > now);
    out.lastWinner = finished.sort((a, b) => b.date - a.date)[0] || null;
    out.next = coming.length ? { name: coming[0].card.title, start: coming[0].card.start } : null;
    if (out.lastWinner && out.next) return out;
    const season = await fetcher.get(`${BASE}${spec.path}/scoreboard`);
    const calendar = season.ok ? calendarOf(season.json) : [];
    const listed = new Set(list(week.json?.events).map(e => String(e?.id)));
    if (!out.lastWinner) {
        const before = calendar.filter(c => c.start < now && !listed.has(c.eventId)).at(-1);
        const event = before ? await raceOn(spec, before) : null;
        out.lastWinner = event ? winnerOfRace(event) : null;
    }
    if (!out.next) {
        const after = calendar.find(c => c.start > now - DAY && !listed.has(c.eventId)); // its calendar time is hours out
        const event = after ? await raceOn(spec, after) : null;
        const start = event ? time(list(event.competitions)[0]?.date || event.date) : null;
        out.next = event && start !== null && start > now ? { name: text(event.name) || after.name, start } : null;
    }
    return out;
}

const onNow = (value, now) => value.events.some(e => ['live', 'break', 'suspended'].includes(e.status) ||
    (Number.isFinite(e.start) && e.start <= now && (Number.isFinite(e.end) ? now < e.end : now < e.start + DAY)));

/**
 * How long an answer is kept: ON_TTL_MS while an event is on; otherwise QUIET_TTL_MS, but never past the next start
 * this week's events or the next race give (0428 Codex round 1, medium: an answer fetched a minute before a start was
 * kept an hour into play).
 */
function ttlOf(value, now) {
    if (onNow(value, now)) return ON_TTL_MS;
    const starts = [...value.events.map(e => e.start), value.next?.start].filter(t => Number.isFinite(t) && t > now);
    return starts.length ? Math.min(QUIET_TTL_MS, Math.max(0, Math.min(...starts) - now)) : QUIET_TTL_MS;
}

async function cached(league, now) {
    const kept = caches.get(league);
    const fresh = kept && now - kept.at < kept.ttl;
    if (!fresh && !refreshing.has(league)) {
        const mine = generation;
        refreshing.set(league, build(league, now).then((value) => {
            if (value && mine === generation) caches.set(league, { value, at: now, ttl: ttlOf(value, now) });
        }).catch((err) => console.warn('[Sport] events page refresh failed:', err.message))
            .finally(() => { if (mine === generation) refreshing.delete(league); }));
    }
    if (!caches.has(league) && refreshing.has(league)) {
        let timer;
        await Promise.race([refreshing.get(league), new Promise(resolve => { timer = setTimeout(resolve, tuning.coldWaitMs); })]);
        clearTimeout(timer);
    }
    return caches.get(league)?.value || null;
}

/**
 * C-V's answer for `league` at `now`, for an account following `names` (its sport's followed names, C-U): the cached
 * ESPN part with each event's `followed` (the event's own spellings of those names), or `{ available: false }`.
 */
async function page(league, now = Date.now(), { names = [] } = {}) {
    const value = await cached(league, now);
    if (!value) return { available: false };
    const wanted = new Set(names.map(personKey).filter(Boolean));
    return { ...value, events: value.events.map(({ players, ...e }) => ({ ...e, followed: players.filter(p => wanted.has(personKey(p))) })) };
}

/** Tests: forget everything. */
function reset() { caches.clear(); refreshing.clear(); generation++; }

module.exports = { LEAGUES, leagueOf, page, build, reset, fetcher, tuning, TUNING };
