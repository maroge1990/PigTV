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
 *
 * 0152: an event that names a game is then checked across its airings (resolveLive): the
 * guide's flags, the first airing within 36 h, a "Live" title and the league's local live
 * hours (LIVE_HOURS) can make it a replay.
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
    // 0185: guides say plain "Premier League"; other countries' and other sports' are told apart
    // by the word before or after it (third element: a title this matches is not this league).
    ['IPL', ['ipl', 'indian premier league']],
    ['EPL', ['epl', 'english premier league', 'premier league'],
        /(?:^| )(?:indian|scottish|welsh|irish|northern ireland|lanka|caribbean|pakistan|bangladesh|nepal|womens|russian|egyptian|saudi|kabaddi|darts) premier league|premier league (?:darts|cricket|kabaddi|snooker|2|cup)(?= |$)/],
    ['La Liga', ['la liga', 'laliga']],
    ['Bundesliga', ['bundesliga']],
    ['Serie A', ['serie a']],
    ['Ligue 1', ['ligue 1']],
    ['FA Cup', ['fa cup']],
    ['UFC', ['ufc']],
    ['MotoGP', ['motogp', 'moto gp']],
    ['NASCAR', ['nascar']],
    ['IndyCar', ['indycar']],
    ['Supercars', ['supercars']],
    ['BBL', ['bbl', 'big bash']],
    ['NBL', ['nbl']],
    ['Super Rugby', ['super rugby']],
    // 0161: international cricket (Tests, ODIs, T20Is) has no fixed competition name the way
    // IPL/BBL do, so it is caught by the sport itself, most specific spellings first - never the
    // bare word "test" on its own (far too common outside cricket: "screen test", "field test").
    // "Australia v India - 1st Test" needs none of these: its match-up ("Australia v India")
    // already parses without a keyword at all (parseMatchup); this is what gives it a LEAGUE, so
    // sportsFixtures.js's international-cricket fixtures (services/sportsFixtures.js) apply.
    ['Cricket', ['test cricket', 'twenty20 international', 't20i', 'odi cricket', 'one day international', 'the ashes', 'cricket']],
    // 0152: leagues the live-hours table (LIVE_HOURS) names
    ['UEFA', ['uefa', 'champions league', 'europa league', 'conference league']],
    ['Championship', ['efl championship', 'sky bet championship']],
    ['A-League', ['a league', 'aleague', 'a leagues']]
].map(([name, aliases, not]) => ({ name, aliases, re: words(aliases), not: not || null }));
const ALL_ALIASES_RE = new RegExp(`(?:^| )(?:${LEAGUES.flatMap(l => l.aliases).sort((a, b) => b.length - a.length).join('|')})(?= |$)`, 'g');
const MOTOR = new Set(['F1', 'MotoGP', 'NASCAR', 'IndyCar', 'Supercars']);

/** The canonical league a followed keyword names ("Formula 1" -> "F1"), or null. */
function canonicalLeague(keyword) {
    const k = normText(keyword);
    for (const l of LEAGUES) if (l.aliases.includes(k) || normText(l.name) === k) return l.name;
    return null;
}

/**
 * 0185: a followed team is written "League: Team" ("NFL: Arizona Cardinals"), the league in any
 * spelling the server knows. -> { league (canonical), team } | null for any other keyword.
 */
function teamFollow(keyword) {
    const m = /^([^:]{1,30}):\s*(\S.*)$/.exec(String(keyword || '').trim());
    if (!m) return null;
    const league = canonicalLeague(m[1]);
    return league ? { league, team: m[2].trim() } : null;
}

/** The canonical league a title (or category) mentions, most specific first, or null. */
function detectLeague(text) {
    const t = normText(text);
    if (!t) return null;
    for (const l of LEAGUES) if (l.re.test(t) && !(l.not && l.not.test(t))) return l.name;
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

// ---- live or replay (0152) ---------------------------------------------------------------------

/**
 * XMLTV programme flags, as services/epgParser.js collects them and epg_programs.flags stores
 * them (a bitmask; NULL/0 when none): <previously-shown/>, <premiere/>, <new/>, and the
 * non-standard <live/> (also set by a <category>Live</category>).
 */
const FLAGS = { PREVIOUSLY_SHOWN: 1, PREMIERE: 2, NEW: 4, LIVE: 8 };

/**
 * When a league's games are played live, in its home time zone: an airing of one of its
 * match-ups that starts outside the window is a rebroadcast (the last-resort rule in
 * resolveLive). To add a league: its canonical name (LEAGUES above, or the text a keyword or
 * category gives it) -> { tz (an IANA zone), from, to ("HH:MM", 24 h, inclusive) }.
 * A league that travels (F1, MotoGP) has no entry, so the rule never applies to it.
 */
const US_EVENING = { tz: 'America/New_York', from: '11:00', to: '23:30' };
const UK_DAY = { tz: 'Europe/London', from: '11:00', to: '22:00' };
const AU_DAY = { tz: 'Australia/Melbourne', from: '11:00', to: '21:30' };
const LIVE_HOURS = {
    MLB: US_EVENING,
    NFL: { ...US_EVENING, from: '09:00' }, // the London games kick off at 9:30 am New York time
    NBA: US_EVENING,
    WNBA: US_EVENING,
    NHL: US_EVENING,
    MLS: US_EVENING,
    EPL: UK_DAY,
    Championship: UK_DAY,
    UEFA: UK_DAY,
    AFL: AU_DAY,
    AFLW: AU_DAY,
    NRL: AU_DAY,
    NRLW: AU_DAY,
    'A-League': AU_DAY,
    BBL: AU_DAY
};

const clockFormats = new Map();
/** The local wall-clock time of `ms` in `tz`: { minutes (since midnight), text ("07:00") }. */
function localClock(ms, tz) {
    let f = clockFormats.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        clockFormats.set(tz, f);
    }
    const parts = f.formatToParts(new Date(ms));
    const h = +parts.find(x => x.type === 'hour').value;
    const m = +parts.find(x => x.type === 'minute').value;
    return { minutes: h * 60 + m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}
const hhmm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** The live-hours entry for a league (its canonical name, or text that names one), or null. */
function liveHoursFor(league) {
    if (!league) return null;
    return LIVE_HOURS[league] || LIVE_HOURS[detectLeagueCached(league)] || null;
}
const leagueNames = new Map();
function detectLeagueCached(text) {
    if (!leagueNames.has(text)) {
        if (leagueNames.size > 5000) leagueNames.clear();
        leagueNames.set(text, detectLeague(text));
    }
    return leagueNames.get(text);
}

/** Does `ms` fall inside the league's live hours? -> { inside, text } (inside is true when the league has none). */
function inLiveHours(ms, league) {
    const hours = liveHoursFor(league);
    if (!hours) return { inside: true, hours: null };
    const { minutes, text } = localClock(ms, hours.tz);
    return { inside: minutes >= hhmm(hours.from) && minutes <= hhmm(hours.to), hours, text };
}

const FIRST_AIRING_WINDOW_MS = 36 * 60 * 60 * 1000; // an earlier airing this recent is the same game
const SAME_AIRING_MS = 30 * 60 * 1000;             // ...and one starting within 30 min of it is a simulcast
const NEXT_GAME_MS = 20 * 60 * 60 * 1000;           // ...unless it is a day later, in hours: the next game of a series

const minutesText = (ms) => {
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
};
const flagWhy = (flags) => (flags & FLAGS.LIVE ? 'flagged live in the guide'
    : flags & FLAGS.PREMIERE ? 'flagged a premiere in the guide' : 'flagged new in the guide');

/**
 * Index keys for finding a team again without comparing every pair (teamMatch is fuzzy). Of two
 * matching names, one's words of two letters or more are all among the other's (single letters
 * are initials), and an abbreviation starts with the name's first letter. So a name is filed
 * under its whole word set ("=") and every subset of it ("<"), and looked for under its whole
 * set among the subsets (it is the shorter) and each of its subsets among the whole sets (the
 * other is); an abbreviation is filed and found by its first letter ("a:", "f:").
 */
function wordSubsets(t) {
    const words = [...new Set(t.tokens.filter(w => w.length > 1))].sort();
    const out = [];
    for (let m = 0; m < (1 << words.length); m++) out.push(words.filter((_, i) => m & (1 << i)).join(' '));
    return { whole: words.join(' '), subsets: out };
}
function teamIndexKeys(t) {
    if (t.abbr) return [`a:${t.tokens[0][0]}`];
    const { whole, subsets } = wordSubsets(t);
    return [`=${whole}`, ...subsets.map(x => `<${x}`), `f:${t.tokens[0][0]}`];
}
function teamLookupKeys(t) {
    if (t.abbr) return [`a:${t.tokens[0][0]}`, `f:${t.tokens[0][0]}`];
    const { whole, subsets } = wordSubsets(t);
    return [`<${whole}`, ...subsets.map(x => `=${x}`), `a:${t.tokens[0][0]}`];
}

/** Can this airing be told live or replay: an event naming a game (teams, or a session of a known league)? */
const decidable = (a) => a.kind === 'event' && (a.parsed.teams
    || (a.parsed.session && LEAGUES.some(l => l.name === a.league)));

/**
 * Live or replay, for airings that classifyKind called an event and that name a game (0152).
 * A match-up airing at an implausible hour is almost always a rebroadcast titled like the live
 * game (Mark: MLB "being played" at 7 am in the US). Airings of the same game (the merge key:
 * league + teams, or league + session + grand prix) are walked in start order, and the first
 * rule that gives an answer decides:
 *   (0) ESPN (0161, fixtureVerdict): when `fixturesByLeague` covers this airing's league and
 *       either matches its teams/session to a real fixture (near its real start -> live, else
 *       replay, worded with the real kickoff) or recognises both teams as the league's but finds
 *       no such game at this time (-> replay). Checked first - it settles exactly the cases the
 *       rules below have to guess at - and only when it has something to say: not covered, or
 *       covered but inconclusive, falls through unchanged;
 *   (a) the guide's flags: <previously-shown/> -> replay; <live/>, <new/>, <premiere/> (or a
 *       "Live" category) -> live;
 *   (b) the first airing wins: the earliest airing within 36 h is live, and later airings
 *       starting more than 30 min after it are replays - except one 20 h or more later that is
 *       inside its league's live hours (the next game of a series: MLB, NBA and NHL teams meet
 *       on consecutive days), which starts a new first airing;
 *   (c) a title marked "Live" -> live (after (b): a rebroadcast often copies the live title);
 *   (d) the league's live hours (LIVE_HOURS): outside them -> replay.
 * An airing that is a replay, or outside its league's hours, is never the first airing others
 * are measured from. Changes `kind` and `why` in place; returns the airings. `fixturesByLeague`
 * is services/sportsFixtures.js's pure snapshot (Map of league -> { fixtures, teamsAliases,
 * coverage }), or undefined/null when fixtures are off or nothing has been fetched yet - every
 * existing call site (and every test that predates 0161) keeps working unchanged. `now` (0162)
 * is only used to judge how fresh that snapshot's coverage is (fixtureVerdict); it defaults to
 * the real clock and only needs to be passed explicitly by a test.
 */
function resolveLive(airings, fixturesByLeague, now = Date.now()) {
    const games = airings.filter(decidable).sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0));
    const groups = [];          // { league, teams: [pair], session, location, list }
    const exact = new Map();    // league + pairKey + session -> group
    const byTeam = new Map();   // league + a team's index key -> [group] (candidates for pairMatch)
    const sessionsOf = new Map(); // league -> [group] without teams
    for (const a of games) {
        const p = a.parsed;
        let g = null;
        if (p.teams) {
            const key = `${a.league}\u0001${pairKey(p.teams)}\u0001${p.session ? p.session.id : ''}`;
            g = exact.get(key);
            if (!g) {
                const seen = new Set();
                for (const k of teamLookupKeys(p.teams[0])) {
                    for (const c of byTeam.get(`${a.league}\u0001${k}`) || []) {
                        if (seen.has(c)) continue;
                        seen.add(c);
                        if (sessionMatch(p.session, c.session) && c.teams.some(t => pairMatch(t, p.teams))) { g = c; break; }
                    }
                    if (g) break;
                }
            }
            if (!g) {
                g = { league: a.league, teams: [], session: p.session, location: [], list: [] };
                groups.push(g);
            }
            if (!g.teams.some(t => pairKey(t) === pairKey(p.teams))) {
                g.teams.push(p.teams);
                for (const side of p.teams) {
                    for (const k of teamIndexKeys(side)) {
                        const k2 = `${a.league}\u0001${k}`;
                        if (!byTeam.has(k2)) byTeam.set(k2, []);
                        byTeam.get(k2).push(g);
                    }
                }
            }
            exact.set(key, g);
        } else {
            if (!sessionsOf.has(a.league)) sessionsOf.set(a.league, []);
            const list = sessionsOf.get(a.league);
            g = list.find(c => c.session.id === p.session.id && locationMatch(c.location, p.location));
            if (!g) {
                g = { league: a.league, teams: [], session: p.session, location: p.location, list: [] };
                groups.push(g);
                list.push(g);
            }
        }
        g.list.push(a);
    }
    const replay = (a, why) => { a.kind = 'replay'; a.why = why; };
    for (const g of groups) {
        let first = null;
        for (const a of g.list) {
            const flags = a.flags | 0;
            let hoursMemo = null;
            const hours = () => hoursMemo || (hoursMemo = inLiveHours(a.start, a.league));
            // (0)
            if (fixturesByLeague) {
                const verdict = fixtureVerdict(a, fixturesByLeague.get(a.league), now);
                if (verdict) {
                    if (verdict.live) { a.why = `${a.why}, ${verdict.why}`; first = a; } else { replay(a, verdict.why); }
                    continue;
                }
            }
            // (a)
            if (flags & FLAGS.PREVIOUSLY_SHOWN) { replay(a, 'previously shown, says the guide'); continue; }
            if (flags & (FLAGS.LIVE | FLAGS.NEW | FLAGS.PREMIERE)) { a.why = `${a.why}, ${flagWhy(flags)}`; first = a; continue; }
            // (b)
            if (first && a.start - first.start <= FIRST_AIRING_WINDOW_MS) {
                const gap = a.start - first.start;
                if (gap <= SAME_AIRING_MS) continue;
                if (gap >= NEXT_GAME_MS && hours().hours && hours().inside) {
                    a.why = `${a.why}, a day after the last airing and within ${a.league} hours (the next game)`;
                    first = a;
                    continue;
                }
                replay(a, `aired first ${minutesText(gap)} earlier${first.channel?.name ? ` (${first.channel.name})` : ''}`);
                continue;
            }
            // (c)
            if (a.parsed.live) { a.why = `${a.why}, "live" in the title`; first = a; continue; }
            // (d)
            if (!hours().inside) { replay(a, `outside ${a.league} hours (${hours().text} ${hours().hours.tz})`); continue; }
            first = a;
        }
    }
    return airings;
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

// ---- ESPN fixtures (0161): a ground-truth first rule for resolveLive -----------------------

const ESPN_GRACE_MS = 30 * 60 * 1000; // "the airing started at/near the real kickoff"
// 0162: how long ago the last successful fetch can be and still be trusted to say "no such game" -
// the matched-fixture branch may keep using older data (a kickoff time rarely moves once ESPN has
// it), but an ABSENCE of a fixture is only evidence while the data is fresh: a day of ESPN being
// unreachable must never quietly turn a real, unlisted live game into a replay.
const NO_GAME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// ...and the covered window must reach this far either side of the airing, not just touch its
// start - ESPN saying nothing about the hour before or after is not the same as checking it.
const NO_GAME_HALF_WINDOW_MS = 12 * 60 * 60 * 1000;

/** A weekday + 12-hour time in `tz` ("Sat 1:30 pm"), for the fixture rule's `why`. */
function espnWhen(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz || 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    }).formatToParts(new Date(ms));
    const get = (t) => parts.find(p => p.type === t)?.value || '';
    return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`;
}

/** Does any of a fixture team's alias "sides" (parseSide of its displayName/shortDisplayName/…) match this airing side? */
const aliasHit = (aliases, side) => aliases.some(alias => teamMatch(side, alias));
/** The fixture's two teams (each already an array of alias-sides) against the airing's pair, either order. */
const fixtureTeamsMatch = (aliasesA, aliasesB, teams) =>
    (aliasHit(aliasesA, teams[0]) && aliasHit(aliasesB, teams[1])) || (aliasHit(aliasesA, teams[1]) && aliasHit(aliasesB, teams[0]));
/** Is this side one of the league's known teams (any alias), even with no fixture pairing it today? */
const teamIsKnown = (side, teamsAliases) => teamsAliases.some(aliases => aliasHit(aliases, side));

/**
 * live/replay from a real ESPN kickoff, for one candidate fixture already chosen as the closest
 * to the airing's start. "Live" is about the AIRING starting at/near the real kickoff (0161's
 * ESPN_GRACE_MS), not about how long the match runs - a replay days later still starts its own
 * guide block at its own (wrong) time. The one exception is a multi-day Test (league === 'Cricket'
 * only: IPL/BBL are always a single day, whatever ESPN's own `endDate` optimistically claims,
 * because live play only happens once a day but coverage is fresh every day): an airing on a
 * later day of a `Cricket` fixture that hasn't ended is live too.
 */
function fixtureLiveVerdict(a, best, kind) {
    const tz = liveHoursFor(a.league)?.tz;
    const near = a.start <= best.start + ESPN_GRACE_MS && a.end > best.start;
    const multiDay = a.league === 'Cricket' && best.end && best.end > best.start + ESPN_GRACE_MS
        && a.start >= best.start && a.start < best.end;
    if (near || multiDay) return { live: true, why: `ESPN: the ${kind} started ${espnWhen(best.start, tz)}` };
    const deltaMs = a.start - best.start;
    const later = deltaMs >= 0;
    return {
        live: false,
        why: `ESPN: the ${kind} started ${espnWhen(best.start, tz)}; this airing is ${minutesText(Math.abs(deltaMs))} ${later ? 'later' : 'earlier'}`
    };
}

/**
 * The ESPN fixture rule (0161, gated by coverage since 0162): when `fixturesByLeague` (services/sportsFixtures.js's snapshot)
 * covers this airing's league AND time, its answer is checked FIRST, ahead of the guide's own
 * flags - a replay wrongly flagged <live/> by the provider, or a first-airing walk with no earlier
 * guide entry, is exactly the case ESPN settles. -> { live, why } | null (null: not covered, out of
 * the covered window, or covered but inconclusive - every other rule in resolveLive runs unchanged).
 *
 * `leagueData.coverage` (0162) is the LAST SUCCESSFUL fetch's own [from, to] window and when it
 * happened: stale or out-of-window data must never manufacture a verdict, let alone a replay, for
 * a real live game ESPN simply has not been asked about recently. The airing's start has to fall
 * inside that window for EITHER branch below; the "no such game" branch (an absence, not a
 * presence) is additionally trusted only while the fetch is recent (NO_GAME_MAX_AGE_MS) and the
 * window reaches a full NO_GAME_HALF_WINDOW_MS either side of the airing - a matched fixture's own
 * kickoff time, once seen, rarely moves, but "ESPN found nothing" is only as good as how recently
 * and how widely ESPN was actually asked.
 */
function fixtureVerdict(a, leagueData, now) {
    if (!leagueData || !leagueData.coverage) return null;
    const { from, to, at } = leagueData.coverage;
    if (!(Number.isFinite(from) && Number.isFinite(to)) || a.start < from || a.start > to) return null;
    const p = a.parsed;
    if (p.teams) {
        const candidates = (leagueData.fixtures || []).filter(f => f.teamsAliases && fixtureTeamsMatch(f.teamsAliases[0], f.teamsAliases[1], p.teams));
        if (candidates.length) {
            const best = candidates.reduce((b, c) => (Math.abs(c.start - a.start) < Math.abs(b.start - a.start) ? c : b));
            return fixtureLiveVerdict(a, best, 'game');
        }
        const recent = Number.isFinite(at) && Number.isFinite(now) && now - at <= NO_GAME_MAX_AGE_MS;
        const widelyEnoughCovered = from <= a.start - NO_GAME_HALF_WINDOW_MS && to >= a.start + NO_GAME_HALF_WINDOW_MS;
        if (recent && widelyEnoughCovered) {
            const teamsAliases = leagueData.teamsAliases || [];
            if (teamIsKnown(p.teams[0], teamsAliases) && teamIsKnown(p.teams[1], teamsAliases)) {
                return { live: false, why: 'ESPN has no such game at this time' };
            }
        }
        return null;
    }
    if (p.session) {
        const candidates = (leagueData.fixtures || []).filter(f => f.session && sessionMatch(f.session, p.session) && locationMatch(f.location, p.location));
        if (!candidates.length) {
            // 0185: last weekend's grand prix shown again midweek. ESPN has no session of this
            // league anywhere near this airing, so it cannot be live. Trusted like "no such game":
            // only on a fresh fetch whose window reaches well either side. With any session of the
            // league nearby (a race weekend, perhaps named differently) nothing is concluded.
            const recent = Number.isFinite(at) && Number.isFinite(now) && now - at <= NO_GAME_MAX_AGE_MS;
            const widelyEnoughCovered = from <= a.start - NO_GAME_HALF_WINDOW_MS && to >= a.start + NO_GAME_HALF_WINDOW_MS;
            const anyNearby = (leagueData.fixtures || []).some(f => Math.abs(f.start - a.start) <= NO_GAME_HALF_WINDOW_MS
                || (f.end && f.start <= a.start && f.end >= a.start));
            if (recent && widelyEnoughCovered && !anyNearby) return { live: false, why: `ESPN has no ${a.league} session at this time` };
            return null;
        }
        const best = candidates.reduce((b, c) => (Math.abs(c.start - a.start) < Math.abs(b.start - a.start) ? c : b));
        return fixtureLiveVerdict(a, best, 'session');
    }
    return null;
}

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
    LEAGUES, normText, canonicalLeague, detectLeague, teamFollow,
    parseTitle, parseSession, parseMatchup, parseSide, parseDates, teamMatch, pairMatch,
    classifyKind, channelTokens, loopedProgrammes, mergeAirings, cleanTitle,
    // 0152
    FLAGS, LIVE_HOURS, liveHoursFor, inLiveHours, localClock, resolveLive,
    // 0161: exported so services/sportsFixtures.js can build a snapshot resolveLive understands,
    // and so tests can exercise the matching/wording directly without a live ESPN fetch.
    sessionMatch, locationMatch, fixtureVerdict, espnWhen
};
