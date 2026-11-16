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
const { createPageCache } = require('./sportPageCache');
const individual = require('./sportIndividual');
const { stateOf, place, text, time, personKey } = individual;
const { BASE } = require('./sportsScoresEspn');
const { fetchFeed } = require('./sportFetch');

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
// The one sport fetch (sportFetch.js, #272), with the collector's 8 s and the individual leagues' 6 MB.
const fetcher = { get: (url) => fetchFeed(url, { timeoutMs: 8000, maxBytes: individual.MAX_BYTES }) };

/**
 * #328 (owner's call of 16 Nov 2026, option 2): the collector holds an event's status but none of the page's detail, so
 * for an account with a score delay the page shows its own detail from its newest read at least that delay old while the
 * event is on. Each read is kept per league and event (the same objects as the cache's: the current read costs nothing
 * more), only for an event on in that read. Bounded: per event at most READS_KEPT reads, none older than the newest
 * one at or before MAX_DELAY_MS ago (no later request with any allowed delay can ask for an older one), and an event no
 * longer on in the reads is forgotten once its newest read is READS_MS old (the slowest a read of an event on comes, plus
 * the longest delay).
 */
const MAX_DELAY_MS = 300000; // C-O scoreDelaySeconds is at most 300 (sportsDashboardStore)
const READS_MS = MAX_DELAY_MS + ON_TTL_MS;
const READS_KEPT = 16; // renewals come at most every 30 s (sportPageCache), so the longest delay spans about 11 reads
const DETAIL = ['matches', 'draws', 'round', 'leaderboard', 'bouts'];
const ON = new Set(['live', 'break', 'suspended']);
const OVER = new Set(['finished', 'postponed', 'cancelled']);
const reads = new Map(); // league -> Map(event id -> [{ at, event }], oldest first)
let readGeneration = 0;

function keepRead(league, value, at) {
    if (!reads.has(league)) reads.set(league, new Map());
    const byEvent = reads.get(league);
    for (const e of value.events) {
        const kept = byEvent.get(e.id) || [];
        // an event on, or its first read over after reads on (so its result shows once that read is the delay old)
        if (!ON.has(e.status) && !(OVER.has(e.status) && kept.length && ON.has(kept.at(-1).event.status))) continue;
        let i = kept.length;
        while (i > 0 && kept[i - 1].at > at) i--;
        kept.splice(i, 0, { at, event: e });
        byEvent.set(e.id, kept);
    }
    for (const [id, kept] of byEvent) {
        let base = -1;
        kept.forEach((r, i) => { if (r.at <= at - MAX_DELAY_MS) base = i; });
        if (base > 0) kept.splice(0, base);
        if (kept.length > READS_KEPT) kept.splice(0, kept.length - READS_KEPT);
        if (!kept.length || kept.at(-1).at < at - READS_MS) byEvent.delete(id);
    }
}
const oldestRead = (league, id) => reads.get(league)?.get(id)?.[0]?.event || null;
const hasReads = (league, id) => Boolean(reads.get(league)?.get(id)?.length);
/** The event `id` from the newest kept read at or before `asOf`, or null. */
function readAsOf(league, id, asOf) {
    const kept = reads.get(league)?.get(id) || [];
    for (let i = kept.length - 1; i >= 0; i--) if (kept[i].at <= asOf) return kept[i].event;
    return null;
}
/** One build of `league`'s answer, kept in the reads (unless reset() came first). */
async function read(league, now) {
    const mine = readGeneration;
    const value = await build(league, now);
    if (value && mine === readGeneration) keepRead(league, value, now);
    return value;
}

const caches = createPageCache({ label: 'events', coldWaitMs: () => tuning.coldWaitMs, ttlOf: (value, now) => ttlOf(value, now) });

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
    const entry = await caches.get(league, now, () => read(league, now));
    return entry?.value || null;
}

/**
 * C-V's answer for `league` at `now`, for an account following `names` (its sport's followed names, C-U): the cached
 * ESPN part with each event's `followed` (the event's own spellings of those names), or `{ available: false }`.
 */
async function page(league, now = Date.now(), { names = [], event: eventState = null, delay = 0 } = {}) {
    let value = await cached(league, now);
    if (!value) return { available: false };
    const delayed = Number.isFinite(delay) && delay > 0 ? (id) => readAsOf(league, id, now - delay * 1000) : null;
    if (eventState) value = await withState(league, value, now, eventState, delayed);
    const wanted = new Set(names.map(personKey).filter(Boolean));
    return { ...value, events: value.events.map(({ players, ...e }) => ({ ...e, followed: players.filter(p => wanted.has(personKey(p))) })) };
}

/**
 * #297: each event's status (and break label) from the score collector's store for this account (`state(cardId)`,
 * sportPageState.deps `event`: its delay; only a fresh or final snapshot), as the front page's card for the same event:
 * the ids and words are the cards' (sportIndividual). The collector further on than the page's read: the read is renewed
 * at once (sportPageCache.renew: one build, at most every 30 s, landing for the next request), as the draws, the
 * leaderboard, the bouts and a race's winner come only from it; a finish the read still lacks after that keeps the
 * page's own status. The page's read newer than the account's delayed view: the collector's status, no results from the
 * read (withoutResults) and no `lastWinner` when it is this race's. Each match, round and bout keeps its own state.
 * #328: with a score delay (`delayed(id)`: the event from the newest read at least the delay old), an event on for the
 * account and on or over in the read takes its draws, matches, round, leaderboard and bouts from that older read; only
 * when no read is old enough yet does it fall back to withoutResults.
 */
async function withState(league, value, now, state, delayed = null) {
    let view = overlay(value, state, delayed);
    if (view.renew) {
        const entry = await caches.renew(league, now, () => read(league, now));
        if (entry?.value && entry.value !== value) view = overlay(entry.value, state, delayed);
    }
    return view.value;
}

/**
 * #297 (Opus review, medium): an event the page's read has further on than the account's delayed view (over in the read,
 * still on for the account) shows nothing of its results from that read: no tennis `sets` or `winner`, no golf `pos`,
 * `toPar`, `rounds` or `status`, and the field by name rather than ESPN's finishing order; no UFC `winner` or `result`
 * (the race's `lastWinner` is held back by overlay()). The draws, the card and each match's or bout's own status and start
 * stay: matches go by start, bouts by the card's running order, neither by result.
 */
function withoutResults(e) {
    const out = { ...e };
    if (Array.isArray(e.matches)) out.matches = e.matches.map(m => ({ ...m, sets: null, players: (m.players || []).map(p => ({ ...p, winner: null })) }));
    // Codex sign-off (high): ESPN's order is the finishing order, so the field goes by name (a copy: the cached one stays)
    if (Array.isArray(e.leaderboard)) out.leaderboard = e.leaderboard.map(r => ({ ...r, pos: null, toPar: null, rounds: (r.rounds || []).map(() => null), status: null }))
        .sort((a, b) => (a.name === null) - (b.name === null) || String(a.name || '').localeCompare(String(b.name || '')));
    if (Array.isArray(e.bouts)) out.bouts = e.bouts.map(b => ({ ...b, result: null, fighters: (b.fighters || []).map(f => ({ ...f, winner: null })) }));
    return out;
}

function overlay(value, state, delayed = null, league = value.league) {
    const { rank } = require('./sportPageState');
    let renew = false, changed = false, lastWinner = value.lastWinner ?? null;
    // #328: what the account may see of an event its delayed view has on: the read at least the delay old, else none
    const held = (e, theirs = null) => {
        const old = delayed ? delayed(e.id) : null;
        const ahead = old && theirs !== null && (rank(old.status) ?? 0) > theirs; // a kept read over, the account's view on
        return old && !ahead ? { ...e, ...Object.fromEntries(DETAIL.filter(k => k in old).map(k => [k, old[k]])) } : withoutResults(e);
    };
    const events = value.events.map(e => {
        let seen = null;
        try { seen = state(e.id); } catch { seen = null; }
        const word = seen?.snapshot?.state;
        const theirs = rank(word), ours = rank(e.status) ?? 0; // the page's `unknown`: nothing shown yet
        if (theirs === null) {
            // #328 (lead's call): no fresh snapshot for the event: its status and detail still the delay old while it is
            // on in the read, or over with reads of it on kept (an event never seen on is shown as read)
            const ownOn = ours === 1 || (ours === 2 && delayed !== null && hasReads(league, e.id));
            if (delayed === null || !ownOn) return e;
            changed = true;
            // its status too: the delayed read's, else the oldest kept read's (on), never a newer one
            const shown = delayed(e.id) || oldestRead(league, e.id);
            const { breakLabel: _b, ...own } = e;
            const status = shown?.status ?? e.status;
            if (!OVER.has(status) && lastWinner && lastWinner.race === e.name && lastWinner.date === e.start) lastWinner = null;
            return { ...held(own), status, ...(shown ? (shown.breakLabel ? { breakLabel: shown.breakLabel } : {}) : (e.breakLabel ? { breakLabel: e.breakLabel } : {})) };
        }
        if (theirs > ours) { renew = true; if (theirs === 2) return e; }
        const breakLabel = word === 'break' && typeof seen.snapshot.breakLabel === 'string' ? seen.snapshot.breakLabel : null;
        const behind = theirs < ours || (delayed !== null && theirs === 1 && ours === 1);
        if (!behind && word === e.status && (e.breakLabel ?? null) === breakLabel) return e;
        changed = true;
        if (theirs < ours && lastWinner && lastWinner.race === e.name && lastWinner.date === e.start) lastWinner = null;
        const { breakLabel: _drop, ...rest } = e;
        return { ...(behind ? held(rest, theirs) : rest), status: word, ...(breakLabel ? { breakLabel } : {}) };
    });
    if (!changed) return { value, renew };
    return { value: { ...value, events, ...('lastWinner' in value ? { lastWinner } : {}) }, renew };
}

/** Tests: forget everything. */
function reset() { caches.reset(); reads.clear(); readGeneration++; }

module.exports = { LEAGUES, leagueOf, page, build, reset, fetcher, tuning, TUNING, READS_KEPT, READS_MS, _reads: reads };
