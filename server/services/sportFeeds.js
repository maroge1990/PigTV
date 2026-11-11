/**
 * #196 (D-41): fixtures for the leagues ESPN does not cover, from each sport's own public feed (checked 1 Nov 2026),
 * as the score collector's games (the shape sportsScoresEspn.normalize gives): no guessing, and a source that fails or
 * changes shape gives no games and its error, never invented ones.
 *
 *   AFLW            AFL's own API (aflapi.afl.com.au): the current season of competition 3, scores while live
 *   NRLW, Super Netball  Champion Data (mc.championdata.com): the newest season's regular and finals competitions
 *   MotoGP          MotoGP's results API (api.motogp.pulselive.com): each MotoGP-class session of the events ahead
 *   Supercars       the calendar page of supercars.com: one card per event weekend (no session times are published)
 *
 * Logos: AFLW and NRLW sides are their clubs' (ESPN's AFL badges, NRL's own); Super Netball's are Champion Data's own, by
 * squad id, for the eight clubs listed by hand (a new club keeps its monogram); motorsport follows riders and drivers,
 * so none. Each answer is kept for a minute while a game is live, else 15 minutes.
 */
const TIMEOUT_MS = 10000;
const MAX_BYTES = 5 * 1024 * 1024; // 0403 (Codex round 1): the largest answer read (the Supercars page is ~150 KB)
const LIVE_TTL = 60 * 1000;
const QUIET_TTL = 15 * 60 * 1000;
const { fetchFeed } = require('./sportFetch'); // #272: the allowed hosts are sportFetch.ALLOWED
const H = 3600 * 1000;

/** A feed's answer: `{ ok, json }`, `{ ok, text }` (as: 'text'), or `{ ok: false, error }`, through the one sport fetch
 * (sportFetch.js, #272: its host list, no redirect, read up to MAX_BYTES, the ESPN cooldown for ESPN's AFL badges). */
const getUrl = (url, { as = 'json' } = {}) => fetchFeed(url, { as, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, headers: { 'user-agent': 'PigTV (self-hosted; fixtures)' } });
// Test seam: `get(url, { as })`, as getUrl.
const fetcher = { get: getUrl };

const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const score = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? String(Number(v)) : null);
const side = (id, name, aliases, logo = null) => ({ id: String(id), name, aliases: [...new Set([name, ...aliases].filter(Boolean))], logo });
const game = (fields) => ({ end: null, format: null, session: null, circuit: null, ...fields });

// ---- AFLW --------------------------------------------------------------------------------------------------------------

const AFL_API = 'https://aflapi.afl.com.au/afl/v2';
const AFL_STATE = { CONCLUDED: 'finished', POSTGAME: 'finished', LIVE: 'live', SCHEDULED: 'scheduled', CONFIRMED_TEAMS: 'scheduled',
    UNCONFIRMED_TEAMS: 'scheduled', PLACEHOLDER: 'scheduled', POSTPONED: 'postponed', CANCELLED: 'cancelled' };

/** Does an abbreviation fit a name? Its letters start a word of the name ("SYD" ~ Sydney Swans, "SUNS" ~ Gold Coast SUNS)
 * or are the initials of its words ("WB" ~ Western Bulldogs). "GCFC" does not fit "Sydney Swans". */
function abbreviationFits(abbreviation, name) {
    const a = String(abbreviation || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return !!a && (words.some(w => w.startsWith(a)) || words.map(w => w[0]).join('') === a);
}

/** ESPN's AFL badges by club name, for AFLW's sides (the same 18 clubs). Never fails: {} when ESPN does not answer.
 * #281: ESPN lists a second team called "Sydney Swans" (abbreviation GCFC, the Gold Coast badge). When two entries share a
 * name the one whose abbreviation fits the name wins; if that does not single one out the name gets no badge (the client
 * draws its lettered one), never another club's. */
async function aflBadges() {
    const r = await fetcher.get('https://site.api.espn.com/apis/site/v2/sports/australian-football/afl/teams');
    const byName = new Map();
    for (const t of (r.ok ? r.json?.sports?.[0]?.leagues?.[0]?.teams : null) || []) {
        const href = str(t?.team?.logos?.[0]?.href, 300);
        for (const n of [t?.team?.displayName, t?.team?.shortDisplayName]) {
            if (!href || !str(n)) continue;
            const key = n.toLowerCase();
            if (!byName.has(key)) byName.set(key, new Map());
            byName.get(key).set(t.team.id ?? href, { href, abbreviation: t.team.abbreviation, name: n }); // one entry per team, not per name
        }
    }
    const out = {};
    for (const [key, entries] of byName) {
        let pick = [...entries.values()];
        if (pick.length > 1) pick = pick.filter(e => abbreviationFits(e.abbreviation, e.name));
        if (pick.length === 1 || (pick.length > 1 && new Set(pick.map(e => e.href)).size === 1)) out[key] = pick[0].href;
    }
    return out;
}

function aflwGames(json, badges = {}, registerImage = (u) => u) {
    const out = [];
    for (const m of Array.isArray(json?.matches) ? json.matches : []) {
        const start = ms(m?.utcStartTime);
        const sides = [m?.home, m?.away].map(s => s?.team);
        if (!m?.id || start === null || sides.some(t => !str(t?.name))) continue;
        const state = AFL_STATE[m.status] || 'unknown';
        const competitors = sides.map(t => {
            const badge = badges[str(t.club?.name)?.toLowerCase()] || badges[t.name.toLowerCase()];
            return side(t.id, t.name, [str(t.nickname), str(t.abbreviation), str(t.club?.name)].filter(n => n && n !== 'TBD'), badge ? registerImage(badge) : null);
        });
        const scores = [m.home?.score?.totalScore, m.away?.score?.totalScore].map(score);
        out.push(game({ id: `aflw:${m.id}`, league: 'AFLW', start, title: competitors.map(c => c.name).join(' v '), competitors,
            snapshot: { state, progress: {}, scores: ['live', 'finished'].includes(state) && scores.every(Boolean) ? scores : null, situation: null } }));
    }
    return out;
}

async function aflw({ registerImage } = {}) {
    const seasons = await fetcher.get(`${AFL_API}/competitions/3/compseasons`);
    const season = seasons.ok ? seasons.json?.compSeasons?.[0]?.id : null;
    if (!Number.isInteger(season)) return { ok: false, error: seasons.ok ? 'no AFLW season listed' : seasons.error };
    const r = await fetcher.get(`${AFL_API}/matches?compSeasonId=${season}&pageSize=250`);
    if (!r.ok) return { ok: false, error: r.error };
    if (!Array.isArray(r.json?.matches)) return { ok: false, error: 'not an AFL match list' };
    return { ok: true, games: aflwGames(r.json, await aflBadges(), registerImage) };
}

// ---- Champion Data (NRLW, Super Netball) -------------------------------------------------------------------------------

const CD = 'https://mc.championdata.com/data';
const CD_STATE = { complete: 'finished', playing: 'live', live: 'live', inprogress: 'live', scheduled: 'scheduled', upcoming: 'scheduled',
    postponed: 'postponed', cancelled: 'cancelled' };
// 0405: Super Netball's clubs by Champion Data squad id (Thunderbirds, Vixens, Swifts, Firebirds, Fever, Lightning, GIANTS,
// Mavericks; checked 1 Nov 2026), whose match centre serves each badge by that id.
const NETBALL_SQUADS = new Set([801, 804, 806, 807, 810, 8117, 8118, 9698]);
const CHAMPION = {
    NRLW: { season: /^(\d{4}) NRLW(?: Finals)?$/, badge: (nickname) => nickname && `https://www.nrl.com/.theme/${nickname.toLowerCase().replace(/[^a-z]+/g, '-')}/badge.png` },
    'Super Netball': { season: /^(\d{4}) Super Netball(?: Finals)?$/,
        badge: (nickname, id) => NETBALL_SQUADS.has(id) ? `https://mc.championdata.com/global/images/teams/scoreboard/${id}.png` : null }
};

/** The newest season's competitions (regular and finals) whose names fit `re`. */
function championComps(json, re) {
    const comps = (Array.isArray(json?.competitionDetails?.competition) ? json.competitionDetails.competition : [])
        .filter(c => Number.isInteger(c?.id) && re.test(String(c.name || '')));
    const newest = Math.max(...comps.map(c => Number(re.exec(c.name)[1])));
    return comps.filter(c => Number(re.exec(c.name)[1]) === newest).map(c => c.id);
}

function championGames(league, json, registerImage = (u) => u) {
    const out = [];
    const { badge } = CHAMPION[league];
    for (const m of Array.isArray(json?.fixture?.match) ? json.fixture.match : []) {
        const start = ms(m?.utcStartTime);
        if (!m?.matchId || start === null || !str(m.homeSquadName) || !str(m.awaySquadName)) continue;
        const competitors = ['home', 'away'].map(h => {
            const nick = str(m[`${h}SquadNickname`]);
            const logo = badge(nick, m[`${h}SquadId`]);
            return side(m[`${h}SquadId`], str(m[`${h}SquadName`]), [nick, str(m[`${h}SquadShortCode`])], logo ? registerImage(logo) : null);
        });
        const state = CD_STATE[String(m.matchStatus || '').toLowerCase()] || 'unknown';
        const scores = [m.homeSquadScore, m.awaySquadScore].map(score);
        out.push(game({ id: `cd:${m.matchId}`, league, start, title: competitors.map(c => c.name).join(' v '), competitors,
            snapshot: { state, progress: {}, scores: ['live', 'finished'].includes(state) && scores.every(Boolean) ? scores : null, situation: null } }));
    }
    return out;
}

async function champion(league, { registerImage } = {}) {
    const list = await fetcher.get(`${CD}/competitions.json`);
    if (!list.ok) return { ok: false, error: list.error };
    const ids = championComps(list.json, CHAMPION[league].season);
    if (!ids.length) return { ok: false, error: `no ${league} competition listed` };
    const games = [];
    for (const id of ids) {
        const r = await fetcher.get(`${CD}/${id}/fixture.json`);
        if (!r.ok) return { ok: false, error: r.error };
        if (!Array.isArray(r.json?.fixture?.match)) return { ok: false, error: 'not a Champion Data fixture' };
        games.push(...championGames(league, r.json, registerImage));
    }
    return { ok: true, games };
}

// ---- MotoGP ------------------------------------------------------------------------------------------------------------

const MOTOGP = 'https://api.motogp.pulselive.com/motogp/v1/results';
const MOTOGP_SESSIONS = { FP: 'Practice', PR: 'Practice', Q: 'Qualifying', SPR: 'Sprint', WUP: 'Warm Up', RAC: 'Race' };
const MOTOGP_STATE = { 'NOT-STARTED': 'scheduled', FINISHED: 'finished', STARTED: 'live', 'IN-PROGRESS': 'live', CANCELLED: 'cancelled' };
const title = (s) => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bOf\b/g, 'of');

function motogpGames(event, sessions) {
    const out = [];
    const name = title(event?.name);
    for (const s of Array.isArray(sessions) ? sessions : []) {
        const label = MOTOGP_SESSIONS[s?.type];
        const start = ms(s?.date);
        if (!label || !s?.id || start === null) continue;
        const session = s.number ? `${label} ${s.number}` : label;
        out.push(game({ id: `motogp:${s.id}`, league: 'MotoGP', start, title: `${name} · ${session}`, session, competitors: [],
            circuit: { name: str(event.circuit?.name), city: str(event.circuit?.place), country: str(event.country?.name) },
            snapshot: { state: MOTOGP_STATE[s.status] || 'unknown', progress: {}, scores: null, situation: null } }));
    }
    return out;
}

async function motogp({ now = Date.now() } = {}) {
    const seasons = await fetcher.get(`${MOTOGP}/seasons`);
    const season = seasons.ok && Array.isArray(seasons.json) ? seasons.json.find(s => s?.current)?.id : null;
    if (!season) return { ok: false, error: seasons.ok ? 'no current MotoGP season' : seasons.error };
    const [events, categories] = await Promise.all([fetcher.get(`${MOTOGP}/events?seasonUuid=${season}`), fetcher.get(`${MOTOGP}/categories?seasonUuid=${season}`)]);
    if (!events.ok || !Array.isArray(events.json)) return { ok: false, error: events.error || 'not a MotoGP event list' };
    const category = categories.ok && Array.isArray(categories.json) ? categories.json.find(c => /^MotoGP/.test(String(c?.name)))?.id : null;
    if (!category) return { ok: false, error: categories.error || 'no MotoGP class listed' };
    // The events around the collector's window: a day back to four ahead; tests are not races.
    const near = events.json.filter(e => !e?.test && ms(e?.date_end) !== null && ms(e.date_end) + 2 * 24 * H >= now && ms(e.date_start) <= now + 4 * 24 * H);
    const games = [];
    for (const e of near) {
        const r = await fetcher.get(`${MOTOGP}/sessions?eventUuid=${e.id}&categoryUuid=${category}`);
        if (!r.ok) return { ok: false, error: r.error };
        games.push(...motogpGames(e, r.json));
    }
    return { ok: true, games };
}

// ---- Supercars ---------------------------------------------------------------------------------------------------------

/** The calendar page's events (its embedded data: title, slug, location, startDate, endDate), as weekend cards. */
function supercarsGames(html, now = Date.now()) {
    const text = String(html || '').replace(/\\"/g, '"');
    const out = [];
    const seen = new Set();
    // Each event's dates, then the nearest slug, title and location before them within the same event object.
    const re = /"startDate":"([^"]+)","endDate":"([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) {
        const [, from, to] = m;
        const start = ms(from), end = ms(to);
        const before = text.slice(Math.max(0, m.index - 1500), m.index);
        const last = (key) => { const all = [...before.matchAll(new RegExp(`"${key}":"([^"]{2,100})"`, 'g'))]; return all.length ? all[all.length - 1] : null; };
        const slug = last('slug'), name = last('title'), location = last('location');
        if (!slug || !name || slug.index < name.index || start === null || end === null || end < start || !/^[a-z0-9-]{3,80}$/.test(slug[1])) continue;
        if (seen.has(slug[1]) || end - start > 7 * 24 * H) continue;
        seen.add(slug[1]);
        out.push(game({ id: `supercars:${slug[1]}`, league: 'Supercars', start, end, title: name[1], competitors: [],
            circuit: { name: null, city: location && location.index > slug.index ? str(location[1]) : null, country: null },
            snapshot: { state: now < start ? 'scheduled' : now > end ? 'finished' : 'unknown', progress: {}, scores: null, situation: null } }));
    }
    return out;
}

async function supercars({ now = Date.now() } = {}) {
    const r = await fetcher.get('https://www.supercars.com/calendar', { as: 'text' });
    if (!r.ok) return { ok: false, error: r.error };
    const games = supercarsGames(r.text, now);
    return games.length ? { ok: true, games } : { ok: false, error: 'no events found on the calendar page' };
}

// ---- the collector's entry ---------------------------------------------------------------------------------------------

const SOURCES = { AFLW: aflw, NRLW: (o) => champion('NRLW', o), 'Super Netball': (o) => champion('Super Netball', o), MotoGP: motogp, Supercars: supercars };
const cache = new Map(); // league -> { at, ttl, answer }

const has = (league) => Object.hasOwn(SOURCES, league);

/** A league's games: `{ ok, games, observedAt }` or `{ ok: false, error }`, kept a minute while live, else 15 minutes. */
async function games(league, { now = Date.now(), registerImage } = {}) {
    if (!has(league)) return { ok: false, error: 'no feed for this league' };
    const kept = cache.get(league);
    if (kept && now - kept.at < kept.ttl) return kept.answer;
    let answer;
    try { answer = await SOURCES[league]({ now, registerImage }); } catch (err) { answer = { ok: false, error: err?.message || 'feed failed' }; }
    if (answer.ok) answer = { ...answer, observedAt: now };
    const live = answer.ok && answer.games.some(g => g.snapshot.state === 'live');
    cache.set(league, { at: now, ttl: live ? LIVE_TTL : QUIET_TTL, answer });
    return answer;
}

function reset() { cache.clear(); }

module.exports = { has, games, reset, fetcher, getUrl, MAX_BYTES, LEAGUES: Object.keys(SOURCES),
    // exposed for tests
    aflBadges, aflwGames, championGames, championComps, motogpGames, supercarsGames };
