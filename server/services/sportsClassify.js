/**
 * What a sport programme IS, and which programmes are the same game (0150, contract C-I).
 *
 * Pure functions, no database: services/sportsEvents.js recognises a programme as sport
 * (keyword, EPG category, sport channel), then asks this module
 *   - its canonical league (a small alias table: F1 = Formula 1 = Formula One = FIA F1;
 *     AFL and AFLW stay apart; see LEAGUES),
 *   - its kind: "event" | "replay" | "show" | "placeholder" (classifyKind), and
 *   - its event key (teams, session, location), so that differently-worded listings of one
 *     game at overlapping times merge into one item (mergeAirings).
 *
 * Precedence: placeholder > highlights (show) > replay of an identifiable game > show words >
 * a replay signal with no identifiable game (placeholder: a 24/7 replay channel) > event
 * (a match-up or a session) > what EPG categories say > "only matched a keyword" (show).
 */
const crypto = require('crypto');

// ---- text helpers -----------------------------------------------------------------

/** Lower case, apostrophes dropped, every other run of non-letters/digits a single space. */
function normText(s) {
    return String(s || '').toLowerCase()
        .replace(/['’‘`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}
const words = (list) => new RegExp(`(?:^| )(?:${list.join('|')})(?= |$)`);

// ---- leagues ------------------------------------------------------------------------

// [canonical name, aliases as normText() spells them]. Most specific first: AFLW is looked for
// before AFL ("Women's AFL" contains "AFL"), NRLW before NRL.
const LEAGUES = [
    ['F1', ['f1', 'formula 1', 'formula one', 'formula1', 'fia f1']],
    ['AFLW', ['aflw', 'womens afl', 'afl womens', 'afl women', 'afl w']],
    ['AFL', ['afl']],
    ['NRLW', ['nrlw', 'womens nrl', 'nrl womens']],
    ['NRL', ['nrl']],
    ['WNBA', ['wnba']],
    ['NBA', ['nba']],
    ['NFL', ['nfl']],
    ['MLB', ['mlb']],
    ['NHL', ['nhl']],
    ['MLS', ['mls']],
    ['EPL', ['epl', 'english premier league']],
    ['UFC', ['ufc']],
    ['MotoGP', ['motogp', 'moto gp']],
    ['NASCAR', ['nascar']],
    ['IndyCar', ['indycar']],
    ['Supercars', ['supercars']],
    ['BBL', ['bbl', 'big bash']]
].map(([name, aliases]) => ({ name, aliases, re: words(aliases) }));
const ALL_ALIASES_RE = new RegExp(`(?:^| )(?:${LEAGUES.flatMap(l => l.aliases).sort((a, b) => b.length - a.length).join('|')})(?= |$)`, 'g');
const MOTOR = new Set(['F1', 'MotoGP', 'NASCAR', 'IndyCar', 'Supercars']);

/** The canonical league a followed keyword names ("Formula 1" -> "F1"), or null. */
function canonicalLeague(keyword) {
    const k = normText(keyword);
    for (const l of LEAGUES) if (l.aliases.includes(k) || normText(l.name) === k) return l.name;
    return null;
}

/** The canonical league a title (or category) mentions, most specific first, or null. */
function detectLeague(text) {
    const t = normText(text);
    if (!t) return null;
    for (const l of LEAGUES) if (l.re.test(t)) return l.name;
    return null;
}

// ---- word lists (normText spelling) ---------------------------------------------------

const PLACEHOLDER_RE = words(['no events?', 'no games?', 'off air', 'event ends', 'events? ended', 'coming up', 'stay tuned',
    'no stream(?:ing)?', 'channel guide', '24 7']);
const HIGHLIGHTS_RE = words(['highlights?', 'hls', 'bitesize', 'plays of']);
const REPLAY_RE = words(['replays?', 're ?airs?', 're ?airing', 'classics?', 'throwback', 'playback', 'mini', 'condensed',
    'rerun', 'repeat', 'encore', 'full game', 'full match', 'full race', 'rewind']);
const SHOW_RE = words(['tonight', 'daily', 'report', 'blitz', 'gameday', 'game ?day', 'films?', 'presents', 'network',
    'fantasy', 'total access', 'pro', '360', 'bounce', 'action', 'today', 'documentar[a-z]*', 'draft', 'plays of', 'explained',
    'academy', 'notebook', 'pre ?game', 'post ?game', 'pre ?show', 'post ?show', 'pre ?race', 'post ?race', 'pre qualifying',
    'previews?', 'review', 'magazine', 'show', 'project', 'talk', 'podcast', 'news', 'best of', 'analysis', 'countdown']);
const LIVE_RE = words(['live']);

// EPG categories that say "not an event" (used only when the title has no match-up or session).
const CATEGORY_SHOW_RE = words(['news', 'magazines?', 'previews?', 'talk', 'highlights?', 'documentar[a-z]*']);
const CATEGORY_REPLAY_RE = words(['replays?', 'classics?', 'repeat']);

// Tokens that carry no meaning of their own once league and channel are gone.
const FILLER = new Set(['ppv', 'pass', 'ch', 'channel', 'exclusive', 'hd', 'uhd', 'fhd', 'sd', '4k', '8k', 'hdr', 'us', 'usa',
    'uk', 'au', 'ca', 'nz', 'tv', 'feed', 'backup', 'alt', 'vip', 'the', 'stream', 'streaming', 'start', 'stop', 'am', 'pm']);
// ...and those a plain broadcast title is made of ("AFL Premiership Football", "NFL Football").
const BROADCAST = new Set(['football', 'premiership', 'league', 'soccer', 'basketball', 'rugby', 'match', 'game', 'games',
    'coverage', 'womens', 'women', 'mens', 'grand', 'prix', 'racing', 'motor', 'sport', 'sports', 'championship',
    'world', 'fia', 'season', 'regular', 'on', 'of']);
// Words that are never part of a grand prix location.
const LOCATION_STOP = new Set([...BROADCAST, ...FILLER, 'live', 'gp', 'practice', 'free', 'qualifying', 'sprint', 'shootout', 'race',
    'final', 'finals', 'semi', 'preliminary', 'elimination', 'the', 'round', 'rd', 'week', 'wk', 'day', 'session', 'formula',
    'one', 'at', 'from', 'in', 'and', 'all', 'star']);

// ---- sessions ----------------------------------------------------------------------------

// First match wins, most specific first. [pattern, id (m => string), label (m => string)]
const SESSIONS = [
    [/(?:^| )sprint (?:qualifying|shootout)(?= |$)/, () => 'sprint qualifying', () => 'Sprint Qualifying'],
    [/(?:^| )qualifying final(?: ([1-4]))?(?= |$)/, m => `qualifying final${m[1] ? ` ${m[1]}` : ''}`, m => `Qualifying Final${m[1] ? ` ${m[1]}` : ''}`],
    [/(?:^| )qf ?([1-4])(?= |$)/, m => `qualifying final ${m[1]}`, m => `Qualifying Final ${m[1]}`],
    [/(?:^| )elimination final(?: ([1-4]))?(?= |$)/, m => `elimination final${m[1] ? ` ${m[1]}` : ''}`, m => `Elimination Final${m[1] ? ` ${m[1]}` : ''}`],
    [/(?:^| )ef ?([1-4])(?= |$)/, m => `elimination final ${m[1]}`, m => `Elimination Final ${m[1]}`],
    [/(?:^| )semi ?finals?(?: ([1-4]))?(?= |$)/, m => `semi final${m[1] ? ` ${m[1]}` : ''}`, m => `Semi Final${m[1] ? ` ${m[1]}` : ''}`],
    [/(?:^| )sf ?([1-4])(?= |$)/, m => `semi final ${m[1]}`, m => `Semi Final ${m[1]}`],
    [/(?:^| )preliminary final(?: ([1-4]))?(?= |$)/, m => `preliminary final${m[1] ? ` ${m[1]}` : ''}`, m => `Preliminary Final${m[1] ? ` ${m[1]}` : ''}`],
    [/(?:^| )pf ?([1-4])(?= |$)/, m => `preliminary final ${m[1]}`, m => `Preliminary Final ${m[1]}`],
    [/(?:^| )grand final(?= |$)/, () => 'grand final', () => 'Grand Final'],
    [/(?:^| )all star game(?= |$)/, () => 'all star game', () => 'All-Star Game'],
    [/(?:^| )(?:free )?practice ([1-3])(?= |$)/, m => `practice ${m[1]}`, m => `Practice ${m[1]}`],
    [/(?:^| )fp ?([1-3])(?= |$)/, m => `practice ${m[1]}`, m => `Practice ${m[1]}`],
    [/(?:^| )qualifying(?= |$)/, () => 'qualifying', () => 'Qualifying'],
    [/(?:^| )sprint(?: race)?(?= |$)/, () => 'sprint', () => 'Sprint'],
    [/(?:^| )race(?= |$)/, () => 'race', () => 'Race'],
    [/(?:^| )(?:free )?practice(?= |$)/, () => 'practice', () => 'Practice'],
    [/(?:^| )(?:grand prix|gp)(?= |$)/, () => 'race', () => 'Race'],
    [/(?:^| )finals?(?= |$)/, () => 'final', () => 'Final']
];

/** { id, label } of the session a title names ("Practice 3", "Qualifying", "Preliminary Final 2"), or null. */
function parseSession(norm) {
    for (const [re, id, label] of SESSIONS) {
        const m = re.exec(norm);
        if (m) return { id: id(m), label: label(m) };
    }
    return null;
}

// ---- match-ups --------------------------------------------------------------------------

const SEPARATOR_RE = /^(.+?)\s+(?:v|v\.|vs|vs\.|versus|at|@|x)\s+(.+)$/i;
const SIDE_DROP_RE = /^(?:live|hd|uhd|fhd|4k|8k|hls|highlights?|(?:pf|qf|sf|ef|gf)\d?|(?:19|20)\d\d|r\d{1,2}|rd\d{1,2}|wk\d{1,2})$/i;
const LEAGUE_TOKENS = new Set(LEAGUES.flatMap(l => l.aliases).filter(a => !a.includes(' ')));

/** One side of a match-up: its tokens (for matching) and its name (for display), or null if it isn't team-like. */
function parseSide(raw) {
    let parts = raw.replace(/[()[\]{}]/g, ' ').split(/\s+/).map(p => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '')).filter(Boolean);
    const kept = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const low = normText(p);
        if (!low || SIDE_DROP_RE.test(p) || LEAGUE_TOKENS.has(low) || low === 'womens' || low === 'fc' || low === 'the') continue;
        if (/^(?:round|rd|week|wk|game)$/i.test(p) && /^\d{1,2}$/.test(parts[i + 1] || '')) { i++; continue; }
        kept.push(p);
    }
    parts = kept;
    if (parts.length < 1 || parts.length > 5) return null;
    if (!parts.every(p => /^[\p{L}\p{N}.&'’-]+$/u.test(p)) || !parts.some(p => /\p{L}/u.test(p))) return null;
    const tokens = parts.map(normText).filter(Boolean);
    const abbr = parts.length === 1 && /^[A-Z]{2,4}$/.test(parts[0]);
    // The first letters of its words as bits: teamMatch() needs one side's within the other's.
    const mask = tokens.reduce((m, t) => m | (1 << (t.charCodeAt(0) % 31)), 0);
    return { tokens, abbr, mask, name: parts.join(' ') };
}

/** [sideA, sideB] of the first segment that reads "A v B" (v, vs, vs., at, @, x), or null. */
function parseMatchup(title) {
    const cleaned = String(title || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\b(?:start|stop):\s*\S+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/gi, ' ');
    for (const segment of cleaned.split(/\s*[|·]\s*|\s+[-–—]+\s+|\s*:\s*/)) {
        const m = SEPARATOR_RE.exec(segment.trim());
        if (!m) continue;
        const a = parseSide(m[1]);
        const b = parseSide(m[2]);
        if (a && b) return [a, b];
    }
    return null;
}

const tokenMatch = (x, y) => x === y || (x.length === 1 && y[0] === x) || (y.length === 1 && x[0] === y);
/** "FRE" ~ Fremantle, "BRL" ~ Brisbane Lions: the same first letter, and its letters in order. */
function abbrMatch(abbr, tokens) {
    const s = tokens.join('');
    if (!s || s[0] !== abbr[0]) return false;
    let i = 0;
    for (const ch of s) if (ch === abbr[i] && ++i === abbr.length) return true;
    return false;
}
/** Two team names: an abbreviation by its letters, else one's words within the other's ("Carlton" ~ "Carlton Blues", "N Melbourne" ~ "North Melbourne"). */
function teamMatch(a, b) {
    const both = a.mask & b.mask;
    if (both !== a.mask && both !== b.mask) return false; // a quick no (see parseSide)
    if (a.abbr && b.abbr) return a.tokens[0] === b.tokens[0];
    if (a.abbr) return abbrMatch(a.tokens[0], b.tokens);
    if (b.abbr) return abbrMatch(b.tokens[0], a.tokens);
    const [s, l] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
    return s.every(x => l.some(y => tokenMatch(x, y)));
}
/** The same pair of teams, in either order. */
function pairMatch(p, q) {
    return (teamMatch(p[0], q[0]) && teamMatch(p[1], q[1])) || (teamMatch(p[0], q[1]) && teamMatch(p[1], q[0]));
}
const pairKey = (p) => p.map(t => t.tokens.join(' ')).sort().join(' | ');

// ---- dates and years -----------------------------------------------------------------------

const MONTHS = ['jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?', 'aug(?:ust)?',
    'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];
const MONTH_RE = MONTHS.map((m, i) => [new RegExp(`^${m}$`), i]);
const monthIndex = (w) => { for (const [re, i] of MONTH_RE) if (re.test(w)) return i; return -1; };
const MONTH_ALT = MONTHS.join('|');
const MONTH_DAY_RE = new RegExp(`(?:^|[^a-z])(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)`, 'gi');
const DAY_MONTH_RE = new RegExp(`(?:^|[^\\d])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})(?![a-z])`, 'gi');
const ISO_DATE_RE = /(?:^|[^\d])((?:19|20)\d\d)-(\d\d)-(\d\d)(?!\d)/g;
const YEAR_RE = /(?:^|[^\d-])((?:19|20)\d\d)(?![\d-])/g;

/** The dates a title mentions: [{ year|null, month (0-11), day }]. */
function parseDates(title) {
    const t = String(title || '');
    const out = [];
    for (const m of t.matchAll(ISO_DATE_RE)) out.push({ year: +m[1], month: +m[2] - 1, day: +m[3] });
    for (const m of t.matchAll(MONTH_DAY_RE)) out.push({ year: null, month: monthIndex(m[1].toLowerCase()), day: +m[2] });
    for (const m of t.matchAll(DAY_MONTH_RE)) out.push({ year: null, month: monthIndex(m[2].toLowerCase()), day: +m[1] });
    return out.filter(d => d.month >= 0 && d.day >= 1 && d.day <= 31);
}
const parseYears = (title) => [...String(title || '').matchAll(YEAR_RE)].map(m => +m[1]);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Is this date more than a day away from the airing (either way, to allow for time zones)? */
function dateIsStale(d, start) {
    const at = new Date(start);
    const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    const years = d.year ? [d.year] : [at.getUTCFullYear() - 1, at.getUTCFullYear(), at.getUTCFullYear() + 1];
    return years.every(y => Math.abs(Date.UTC(y, d.month, d.day) - day) > DAY_MS);
}
/** The season an airing belongs to: its year, or last year's in January to March (NFL playoffs, AFL off-season). */
function seasonYear(start) {
    const at = new Date(start);
    return at.getUTCMonth() <= 2 ? at.getUTCFullYear() - 1 : at.getUTCFullYear();
}

// ---- one title ------------------------------------------------------------------------------

/**
 * Everything about a title that doesn't depend on where or when it airs (cached by the caller).
 */
function parseTitle(title) {
    const raw = String(title || '');
    const norm = normText(raw);
    const teams = parseMatchup(raw);
    const session = parseSession(norm);
    const core = norm.replace(ALL_ALIASES_RE, ' ').split(' ').filter(w => w && !FILLER.has(w) && !/^\d+$/.test(w));
    const location = !teams && session
        ? norm.replace(ALL_ALIASES_RE, ' ').split(' ').filter(w => w && !LOCATION_STOP.has(w) && !/\d/.test(w) && monthIndex(w) < 0
            && !REPLAY_RE.test(w) && !SHOW_RE.test(w) && !HIGHLIGHTS_RE.test(w))
        : [];
    return {
        norm,
        teams,
        session,
        location,
        core,
        // a plain broadcast title: league and broadcast words only ("Live: NFL Football", not "NFL Live")
        broadcast: core.some(w => w !== 'live') && core.every(w => w === 'live' || BROADCAST.has(w)),
        endsColon: /:\s*$/.test(raw),
        placeholderWord: (PLACEHOLDER_RE.exec(norm) || [])[0]?.trim() || null,
        highlightsWord: (HIGHLIGHTS_RE.exec(norm) || [])[0]?.trim() || null,
        replayWord: (REPLAY_RE.exec(norm) || [])[0]?.trim() || null,
        showWord: (SHOW_RE.exec(norm) || [])[0]?.trim() || null,
        live: LIVE_RE.test(norm),
        dates: parseDates(raw),
        years: parseYears(raw)
    };
}

/** The words of a channel's name, to tell a title that only repeats it. */
const channelTokens = (name) => new Set(normText(name).split(' ').filter(Boolean));

/**
 * The kind of one recognised sport programme, and why:
 *   -> { kind: 'event'|'replay'|'show'|'placeholder', why, generic }
 * `rule` is how it was recognised ('keyword' | 'category' | 'sportChannel'); `loop` says the
 * channel repeats this title in identical blocks (loopedProgrammes). `generic` marks a plain
 * broadcast title ("AFL Premiership Football") that merges into an overlapping event, and is a
 * show when there is none and it matched only a keyword.
 */
function classifyKind({ title, channelName = '', start = Date.now(), categories = [], rule = 'keyword', loop = false, parsed, chTokens }) {
    const p = parsed || parseTitle(title);
    const game = p.teams || p.session;
    // placeholder
    if (p.placeholderWord) return { kind: 'placeholder', why: `says "${p.placeholderWord}"` };
    if (p.endsColon) return { kind: 'placeholder', why: 'ends in a bare ":"' };
    const stale = p.dates.find(d => dateIsStale(d, start));
    if (stale) return { kind: 'placeholder', why: `dated ${stale.year ? `${stale.year}-` : ''}${String(stale.month + 1).padStart(2, '0')}-${String(stale.day).padStart(2, '0')}, not today` };
    if (loop) return { kind: 'placeholder', why: 'the channel repeats it in identical blocks' };
    if (!game && !p.showWord) {
        const tokens = chTokens || channelTokens(channelName);
        if (p.core.every(w => tokens.has(w))) return { kind: 'placeholder', why: 'nothing but the league and channel name' };
    }
    // highlights are a show; a replay needs a game
    if (p.highlightsWord) return { kind: 'show', why: `highlights ("${p.highlightsWord}")` };
    const pastYear = p.years.find(y => y < seasonYear(start));
    if (game && (p.replayWord || pastYear)) {
        return { kind: 'replay', why: p.replayWord ? `a game with "${p.replayWord}"` : `a game from ${pastYear}` };
    }
    if (p.showWord) return { kind: 'show', why: `"${p.showWord}"` };
    if (p.replayWord) return { kind: 'placeholder', why: `"${p.replayWord}" with no game named` };
    if (p.live && !game && !p.broadcast) return { kind: 'show', why: '"live" with no game named' };
    // event
    if (p.teams) return { kind: 'event', why: 'a match-up' };
    if (p.session) return { kind: 'event', why: `a session (${p.session.label})` };
    const cats = categories.map(normText);
    if (cats.some(c => CATEGORY_REPLAY_RE.test(c))) return { kind: 'show', why: 'a replay category, no game named' };
    if (cats.some(c => CATEGORY_SHOW_RE.test(c))) return { kind: 'show', why: 'a news or magazine category' };
    if (p.broadcast) return { kind: 'event', why: 'a broadcast title', generic: true };
    if (rule === 'keyword') return { kind: 'show', why: 'only a keyword, no game named' };
    return { kind: 'event', why: rule === 'category' ? 'a sport category' : 'a sport channel, live title' };
}

/**
 * Loop detection: programmes whose channel shows the SAME title in 3 or more consecutive
 * blocks of identical length (a placeholder or loop channel). `programmes` are rows with
 * channel_id, title, start_time, end_time; returns the Set of rows in such runs.
 */
function loopedProgrammes(programmes) {
    const byChannel = new Map();
    for (const p of programmes) {
        if (!byChannel.has(p.channel_id)) byChannel.set(p.channel_id, []);
        byChannel.get(p.channel_id).push(p);
    }
    const looped = new Set();
    for (const list of byChannel.values()) {
        if (list.length < 3) continue;
        list.sort((a, b) => a.start_time - b.start_time);
        let runStart = 0;
        for (let i = 1; i <= list.length; i++) {
            const prev = list[i - 1];
            const cur = list[i];
            const same = cur && cur.title === prev.title && cur.start_time >= prev.end_time
                && cur.end_time - cur.start_time === prev.end_time - prev.start_time;
            if (same) continue;
            if (i - runStart >= 3) for (let j = runStart; j < i; j++) looped.add(list[j]);
            runStart = i;
        }
    }
    return looped;
}

// ---- merging --------------------------------------------------------------------------------

const titleCase = (s) => s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

/** A raw title without channel tags, "LIVE" markers, quality words and dangling punctuation. */
function cleanTitle(title) {
    return String(title || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\((?:\s*(?:live|hd|uhd|fhd|4k|hdr|sd|r|rpt|repeat|new|cc)\s*)\)/gi, ' ')
        .replace(/^\s*live\s*[:\-–|]?\s+/i, '')
        .replace(/(?:^|\s)(?:hd|uhd|fhd|4k|hdr)(?=\s|$)/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s:\-–|·]+|[\s:\-–|·]+$/g, '')
        .trim();
}

const overlaps = (a, c) => a.start < c.end && a.end > c.start;
const locationMatch = (a, b) => !a.length || !b.length || a.every(w => b.includes(w)) || b.every(w => a.includes(w));
const sessionMatch = (a, b) => !a || !b || a.id === b.id;

/**
 * Merge airings into items by meaning. Each airing: { title, start, end, league (canonical, for
 * merging), kind, why, generic, parsed, ... }. Only the same kind merges (an event never absorbs
 * a replay), within one league, at overlapping times:
 *   - match-ups: the same pair of teams (in either order; abbreviations and short names allowed),
 *   - sessions with no teams: the same session and a compatible location ("Azerbaijan" ~
 *     "Qatar Airways Azerbaijan"); a session such as "Grand Final" joins the one overlapping
 *     match-up of its league,
 *   - broadcast titles ("AFL Premiership Football"): join the overlapping event they overlap most,
 *   - anything else: the same normalised title (`normalise`).
 * -> [{ kind, why, title, aliases, start, end, airings }]
 */
function mergeAirings(airings, normalise) {
    const sorted = airings.slice().sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0));
    const items = [];
    const newItem = (a, extra) => {
        const item = { kind: a.kind, why: a.why, league: a.league, start: a.start, end: a.end, airings: [a], ...extra };
        items.push(item);
        return item;
    };
    const join = (item, a) => { item.airings.push(a); item.end = Math.max(item.end, a.end); item.start = Math.min(item.start, a.start); };

    // 1. match-ups
    const games = new Map(); // `${kind}\u0001${league}` -> { active: [], all: [] }
    const bucket = (a) => {
        const k = `${a.kind}\u0001${a.league}`;
        if (!games.has(k)) games.set(k, { active: [], all: [], exact: new Map() });
        return games.get(k);
    };
    const gameKind = (a) => a.kind === 'event' || a.kind === 'replay';
    for (const a of sorted) {
        if (!gameKind(a) || !a.parsed.teams) continue;
        const b = bucket(a);
        const key = pairKey(a.parsed.teams);
        let item = b.exact.get(key);
        if (!(item && item.end > a.start && sessionMatch(a.parsed.session, item.session))) {
            b.active = b.active.filter(c => c.end > a.start);
            item = b.active.find(c => sessionMatch(a.parsed.session, c.session) && c.pairs.some(p => pairMatch(p, a.parsed.teams)));
        }
        if (item) {
            join(item, a);
            if (!item.pairs.some(p => pairKey(p) === key)) item.pairs.push(a.parsed.teams);
            item.session = item.session || a.parsed.session;
        } else {
            item = newItem(a, { type: 'matchup', pairs: [a.parsed.teams], session: a.parsed.session, location: [] });
            b.active.push(item);
            b.all.push(item);
        }
        b.exact.set(key, item);
    }

    // 2. sessions without teams
    const sessions = new Map();
    for (const a of sorted) {
        if (!gameKind(a) || a.parsed.teams || !a.parsed.session) continue;
        const b = bucket(a);
        const withTeams = b.all.filter(c => overlaps(a, c));
        let item = withTeams.find(c => c.session && c.session.id === a.parsed.session.id);
        if (!item && withTeams.length === 1 && !withTeams[0].session) item = withTeams[0];
        if (item) {
            join(item, a);
            item.session = item.session || a.parsed.session;
            continue;
        }
        const k = `${a.kind}\u0001${a.league}`;
        if (!sessions.has(k)) sessions.set(k, []);
        const list = sessions.get(k);
        item = list.find(c => c.end > a.start && c.session.id === a.parsed.session.id && locationMatch(c.location, a.parsed.location));
        if (item) {
            join(item, a);
            if (a.parsed.location.length && (!item.location.length || a.parsed.location.length < item.location.length)) item.location = a.parsed.location;
        } else {
            list.push(newItem(a, { type: 'session', session: a.parsed.session, location: a.parsed.location }));
        }
    }

    // 3. broadcast titles join the event they overlap most
    const rest = [];
    for (const a of sorted) {
        if (a.kind === 'event' && a.generic) {
            const b = bucket(a);
            const candidates = [...b.all, ...(sessions.get(`${a.kind}\u0001${a.league}`) || [])].filter(c => overlaps(a, c));
            if (candidates.length) {
                // It adds its channel and title, not its (usually longer) coverage times.
                const overlap = (c) => Math.min(a.end, c.end) - Math.max(a.start, c.start);
                candidates.reduce((best, c) => (overlap(c) > overlap(best) ? c : best)).airings.push(a);
                continue;
            }
            if (a.rule === 'keyword') { rest.push({ ...a, kind: 'show', why: 'a broadcast title, no event at that time' }); continue; }
        }
        if (gameKind(a) && (a.parsed.teams || a.parsed.session)) continue;
        rest.push(a);
    }

    // 4. everything else: the same normalised title at overlapping times
    const byTitle = new Map();
    for (const a of rest) {
        const k = `${a.kind}\u0001${normalise(a)}`;
        if (!byTitle.has(k)) byTitle.set(k, []);
        byTitle.get(k).push(a);
    }
    for (const list of byTitle.values()) {
        let current = null;
        for (const a of list) {
            if (current && a.start < current.end) join(current, a);
            else current = newItem(a, { type: 'title' });
        }
    }

    for (const item of items) finishItem(item);
    return items;
}

/** The display title and aliases of a merged item. */
function finishItem(item) {
    const aliases = [];
    for (const a of item.airings) if (!aliases.includes(a.title)) aliases.push(a.title);
    item.aliases = aliases;
    if (item.type === 'matchup') {
        // The fullest names, abbreviations last; in the order that listing gave them.
        const score = (p) => p.reduce((n, t) => n + (t.abbr ? -10 : t.tokens.length), 0);
        const best = item.pairs.reduce((b, p) => (score(p) > score(b) ? p : b));
        const name = (t) => (t.name === t.name.toUpperCase() && !t.abbr ? titleCase(t.name) : t.name);
        item.title = `${name(best[0])} v ${name(best[1])}${item.session ? ` · ${item.session.label}` : ''}`;
    } else if (item.type === 'session') {
        const place = item.location.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const motor = MOTOR.has(item.league) || item.airings.some(a => / (?:gp|grand prix)(?= |$)/.test(` ${a.parsed.norm}`));
        if (place && motor) item.title = item.session.id === 'race' ? `${place} Grand Prix` : `${place} GP · ${item.session.label}`;
        else if (place) item.title = `${place} · ${item.session.label}`;
        else item.title = `${item.league} ${item.session.label}`;
        // a replay says which year's ("AFL Grand Final 2025")
        const years = [...new Set(item.airings.flatMap(a => a.parsed.years))];
        if (item.kind === 'replay' && years.length === 1) item.title += ` ${years[0]}`;
    } else {
        item.title = cleanTitle(item.airings[0].title) || item.airings[0].title;
    }
    item.key = crypto.createHash('sha1').update(`${item.kind}\u0000${item.league}\u0000${normText(item.title)}`).digest('hex');
    return item;
}

module.exports = {
    LEAGUES, normText, canonicalLeague, detectLeague,
    parseTitle, parseSession, parseMatchup, parseDates, teamMatch, pairMatch,
    classifyKind, channelTokens, loopedProgrammes, mergeAirings, cleanTitle
};
