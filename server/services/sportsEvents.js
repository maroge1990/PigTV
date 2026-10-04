/**
 * Sport events (contract C-I; 0147 categories, 0148 events, 0150 kinds and merging by meaning).
 *
 * Sport is recognised per PROGRAMME, not per channel: about 100 channels carry
 * NFL only some of the time. A programme is sport when
 *   (a) one of its EPG categories matches the sport vocabulary, or
 *   (b) its title or a category names a followed keyword (the admin's list; a league
 *       keyword stands for all its spellings: "F1" = "Formula 1" = "Formula One"), or
 *   (c) its channel's category is marked sport (C-H, services/sportCategories.js)
 *       and its title reads like a live event ("Live", "vs", " v ").
 *
 * 0150: each sport programme then has a KIND (services/sportsClassify.js): event,
 * replay (of an identifiable game), show (magazines, highlights, news) or placeholder
 * (empty PPV slots, stale dated listings, 24/7 replay loops). Programmes of the same
 * kind and league at overlapping times that name the same game (the same teams, or the
 * same session and grand prix) are one item with several channels, titled by its
 * cleanest form and listing the raw titles as `aliases`. Channels are ordered best first: quality from
 * the name (UHD, HD, unknown, SD), then health ok (C-G), then the user's
 * favourite, then guide order.
 *
 * 0152: an event that names a game can then turn out a replay (sportsClassify.resolveLive:
 * the guide's XMLTV flags, the first airing within 36 h, a "Live" title, the league's live
 * hours), so a build also reads the 36 h before its minute.
 *
 * Only visible channels count (not hidden, not in a hidden category), once per
 * channel identity. The event list scans a window of epg_live across every
 * visible channel, so it is built once per (library_rev + EPG generations,
 * follow-list version, 5 minutes; 0153, a minute before) for the next 72 hours (0153: a whole
 * weekend; 24 before); each request then only
 * filters by its `hours`, marks `live` and orders channels for its user.
 *
 * R09: the build (0.3-1.1 s on 1,000 channels) runs on a worker thread, never on the event loop
 * that serves live HLS; a request is answered from the last result (stale-while-revalidate) and
 * only the very first one, with nothing cached, waits for a build. See "the cache and the
 * request" below.
 */
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const { monitorEventLoopDelay } = require('perf_hooks');
const { getDb } = require('../db/sqlite');
const { currentGuideVersion } = require('./libraryRev');
const { NUMBER_JOIN, VISIBLE_SQL, CHANNEL_KEY_SQL } = require('./channelNumbers');
const channelHealth = require('./channelHealth');
const epgMapping = require('./epgMapping');
const sportCategories = require('./sportCategories');
const sportsClassify = require('./sportsClassify');
const sportsFixtures = require('./sportsFixtures');

const HOUR_MS = 60 * 60 * 1000;
// 0153: a build is kept for 5 minutes (it was rebuilt every minute; a 72 h build on a large guide
// takes about a second), and covers 72 h (a whole weekend) plus those 5 minutes, so a request
// late in the bucket still sees its full `hours`. `live` and the time filter are per request.
const BUILD_EVERY_MS = 5 * 60 * 1000;
const WINDOW_MS = 72 * HOUR_MS + BUILD_EVERY_MS;
// 0152: a build also reads the 36 h before its minute, so a later airing of a game can be
// told from its first (live) airing (sportsClassify.resolveLive). epg_live holds what the
// provider's feed carries, usually the previous day too; the sync trims nothing by time.
const LOOKBACK_MS = 36 * HOUR_MS;
const DEFAULT_HOURS = 6;
const MAX_HOURS = 72; // 0153 (was 24); the default stays 6 for older clients
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 60;

// ---- matching ----------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words, whatever the script: a keyword or term must not sit inside a longer word.
const wordRegExp = (alternation) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${alternation})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const phrase = (term) => term.split(' ').map(escapeRegExp).join('[\\s\\-_/]*');

// (a) The sport vocabulary, matched against each EPG category as whole words
// (a trailing "s" allowed), case-insensitively. The contract's list and similar.
const VOCABULARY = [
    'sport', 'sporting event', 'football', 'american football', 'soccer', 'futsal', 'basketball', 'baseball', 'softball',
    'ice hockey', 'hockey', 'cricket', 'rugby', 'rugby league', 'rugby union', 'australian rules', 'aussie rules',
    'australian football', 'gaelic football', 'hurling', 'tennis', 'table tennis', 'squash', 'badminton', 'golf',
    'motor sport', 'motor racing', 'racing', 'formula 1', 'formula one', 'motogp', 'nascar', 'indycar', 'supercars',
    'speedway', 'boxing', 'mma', 'mixed martial arts', 'martial arts', 'martial sport', 'ufc', 'wrestling', 'cycling',
    'athletics', 'track and field', 'marathon', 'triathlon', 'swimming', 'diving', 'rowing', 'sailing', 'surfing',
    'water sport', 'winter sport', 'skiing', 'snowboarding', 'figure skating', 'equestrian', 'horse racing',
    'harness racing', 'greyhound', 'darts', 'snooker', 'billiards', 'bowls', 'netball', 'volleyball', 'handball',
    'lacrosse', 'polo', 'water polo', 'olympics', 'olympic games', 'paralympics', 'commonwealth games', 'world cup',
    'gymnastics', 'weightlifting', 'fencing', 'archery', 'nfl', 'nba', 'mlb', 'nhl', 'mls', 'afl', 'nrl', 'epl'
];
const VOCABULARY_RE = wordRegExp(`(?:${VOCABULARY.map(phrase).join('|')})s?`);

// Categories that say "sport" and nothing more, so never a league.
const GENERIC_CATEGORY_RE = /^(?:live\s+)?(?:sports?|sporting|sport(?:ing|s)?\s+events?|events?|special\s+events?|team\s+sports?|live)$/i;
// Programme genres that are never a league either.
const GENRE_CATEGORY_RE = /^(?:movies?|films?|series|drama|comedy|entertainment|documentar(?:y|ies)|factual|kids|children|family|music|lifestyle|reality|talk|talk\s+show|shopping|education(?:al)?|religio(?:n|us)|game\s+show|general|other|unknown|hd|uhd|4k|new|premiere|repeat|rerun)$/i;

// Common non-events, excluded unless a followed keyword matches.
const EXCLUDE_RE = wordRegExp('news|highlights?|previews?|replays?|classics?|magazines?');

// (c) A title that reads like a live event.
const LIVE_TITLE_RE = /(?:^|[^\p{L}\p{N}])(?:live|vs)(?=$|[^\p{L}\p{N}])|\sv\s/iu;

/**
 * A keyword that names a league ("F1", "Formula 1", "AFLW") follows that canonical league
 * in all its spellings (sportsClassify.LEAGUES), and only it: "AFL" does not follow
 * "Women's AFL". A team ("NFL: Arizona Cardinals", 0185) follows that team's games: its full
 * name anywhere, or one of its shorter names ("Cardinals", "Arizona") in a programme of its
 * league - the St. Louis Cardinals are MLB, so the short name alone would not do. Any other
 * keyword ("Chiefs") is matched as whole words.
 */
function compileFollow(keywords) {
    const list = keywords.map(k => {
        const league = sportsClassify.canonicalLeague(k);
        if (league) return { keyword: k, league, team: null, re: null };
        const team = sportsClassify.teamFollow(k);
        if (team) return { keyword: k, league: null, team: teamNames(team), re: null };
        return { keyword: k, league: null, team: null, re: wordRegExp(phrase(k.toLowerCase())) };
    });
    const literal = [
        ...list.filter(k => k.re).map(k => phrase(k.keyword.toLowerCase())),
        ...list.filter(k => k.team).flatMap(k => k.team.phrases)
    ];
    return {
        list,
        leagues: new Set(list.filter(k => k.league).map(k => k.league)),
        any: literal.length ? wordRegExp(literal.join('|')) : null
    };
}

/**
 * A followed team's names as patterns: { league, full (its whole name), short (its nickname,
 * and its place when no other team of the league shares it), phrases }. The shorter names come
 * from the league's cached roster; without one, only the name as written is known.
 */
function teamNames({ league, team }) {
    const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = fold(team);
    let roster = [];
    try { roster = sportsFixtures.teamsOf(league); } catch (e) { /* no roster yet */ }
    const entry = roster.find(t => fold(t.displayName) === wanted);
    const short = new Set();
    if (entry) {
        for (const name of [entry.name, entry.shortDisplayName]) if (fold(name) && fold(name) !== wanted) short.add(fold(name));
        const place = fold(entry.location);
        if (place && place !== wanted && roster.filter(t => fold(t.location) === place).length === 1) short.add(place);
    }
    const fullPhrase = phrase(wanted);
    const shortPhrases = [...short].filter(n => n.length >= 3).map(phrase);
    return {
        league,
        full: wordRegExp(fullPhrase),
        short: shortPhrases.length ? wordRegExp(shortPhrases.join('|')) : null,
        phrases: [fullPhrase, ...shortPhrases]
    };
}

/** Does a followed team play in this programme? */
function teamFollowed(team, texts, leagues) {
    if (texts.some(t => team.full.test(t))) return true;
    return Boolean(team.short) && leagues.includes(team.league) && texts.some(t => team.short.test(t));
}

/** The first followed keyword (in list order) in the title or a category, or null. */
function followedKeyword(follow, title, categories, leagues) {
    if (!follow.list.length) return null;
    const texts = [title, ...categories].filter(Boolean);
    const literalHit = follow.any && texts.some(t => follow.any.test(t));
    if (!literalHit && !leagues.some(l => follow.leagues.has(l))) return null;
    for (const k of follow.list) {
        if (k.league ? leagues.includes(k.league) : k.team ? teamFollowed(k.team, texts, leagues) : texts.some(t => k.re.test(t))) return k;
    }
    return null;
}

/** The most specific EPG category: the non-generic one with the most words, the later on a tie; else "Sport". */
function leagueFromCategories(categories) {
    let best = null;
    let bestWords = 0;
    for (const c of categories) {
        const text = String(c).trim();
        if (!text || GENERIC_CATEGORY_RE.test(text) || GENRE_CATEGORY_RE.test(text) || EXCLUDE_RE.test(text)) continue;
        const words = text.split(/\s+/).length;
        if (words >= bestWords) { best = text; bestWords = words; }
    }
    return best || 'Sport';
}

/**
 * Is this programme sport, and by which rule?
 *   -> null | { rule: 'keyword'|'category'|'sportChannel', match, league }
 * `follow` is compileFollow()'s result; `sportChannel` is C-H's mark on the
 * programme's channel. A followed keyword's league is the canonical league the title
 * (else a category) names, else the keyword's own. Whether it is an event, a replay,
 * a show or a placeholder is sportsClassify.classifyKind's question (0150; before,
 * news/highlights/preview/replay/classic/magazine were dropped here).
 */
function classify({ title, categories = [], sportChannel = false }, follow) {
    const text = String(title || '');
    const titleLeague = sportsClassify.detectLeague(text);
    const leagues = [titleLeague, ...categories.map(c => sportsClassify.detectLeague(c))].filter(Boolean);
    const keyword = followedKeyword(follow, text, categories, leagues);
    if (keyword) return { rule: 'keyword', match: keyword.keyword, league: leagues[0] || keyword.league || (keyword.team && keyword.team.league) || keyword.keyword };
    const category = categories.find(c => VOCABULARY_RE.test(String(c).replace(/[\-_/]+/g, ' ')));
    if (category) return { rule: 'category', match: category, league: leagueFromCategories(categories) };
    if (sportChannel && LIVE_TITLE_RE.test(text)) {
        return { rule: 'sportChannel', match: 'Sport category + live title', league: leagueFromCategories(categories) };
    }
    return null;
}

// ---- normalisation -----------------------------------------------------------

const QUALITY_WORDS = /(?:^|\s)(?:live|hd|uhd|fhd|4k|hdr)(?=\s|$)/g;
const TAG_IN_BRACKETS = /\((?:\s*(?:live|hd|uhd|fhd|4k|hdr|sd|r|rpt|repeat|new|cc)\s*)\)/gi;

function squash(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The title an event is grouped by: lower case; "live"/"(live)", channel tags
 * ([...], a bracketed quality/repeat tag, the channel's own name at either
 * end), HD/UHD/4K markers and punctuation removed; "vs" written "v";
 * whitespace collapsed.
 */
function normaliseTitle(title, channelName = '') {
    let t = String(title || '').toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(TAG_IN_BRACKETS, ' ');
    t = squash(t).replace(/(?:^|\s)vs(?=\s|$)/g, ' v ');
    t = ` ${t} `.replace(QUALITY_WORDS, ' ').replace(QUALITY_WORDS, ' ').replace(/\s+/g, ' ').trim();
    const name = ` ${squash(channelName)} `.replace(QUALITY_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (name && t !== name) {
        if (t.startsWith(`${name} `)) t = t.slice(name.length + 1);
        if (t.endsWith(` ${name}`)) t = t.slice(0, -name.length - 1);
    }
    return t;
}

/** "UHD" | "HD" | "SD" | null, from the channel's name. */
function qualityFromName(name) {
    const n = String(name || '');
    if (/(?:^|[^\p{L}\p{N}])(?:4k|uhd|2160p?)(?=$|[^\p{L}\p{N}])/iu.test(n)) return 'UHD';
    if (/(?:^|[^\p{L}\p{N}])(?:fhd|hd|1080[pi]?|720p)(?=$|[^\p{L}\p{N}])/iu.test(n)) return 'HD';
    if (/(?:^|[^\p{L}\p{N}])sd(?=$|[^\p{L}\p{N}])/iu.test(n)) return 'SD';
    return null;
}

const QUALITY_RANK = { UHD: 0, HD: 1, SD: 3 };
const qualityRank = (q) => QUALITY_RANK[q] ?? 2;       // unknown between HD and SD
const healthRank = (h) => (h === 'ok' ? 0 : h === 'flaky' ? 2 : 1);

// ---- the follow list -----------------------------------------------------------

let followCache = null; // [keyword]
let followVersion = 0;

function getFollow() {
    if (!followCache) {
        followCache = getDb().prepare('SELECT keyword FROM sports_follow ORDER BY position').all().map(r => r.keyword);
    }
    return followCache;
}

/**
 * Validate an admin's list: strings, trimmed (inner whitespace collapsed),
 * empties dropped, de-duplicated case-insensitively (first spelling kept).
 * -> { keywords } or { error }.
 */
function cleanFollow(keywords) {
    if (!Array.isArray(keywords)) return { error: 'keywords must be a list' };
    const out = [];
    const seen = new Set();
    for (const k of keywords) {
        if (typeof k !== 'string') return { error: 'every keyword must be text' };
        const text = k.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > MAX_KEYWORD_LENGTH) return { error: `a keyword is at most ${MAX_KEYWORD_LENGTH} characters` };
        if (seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        out.push(text);
    }
    if (out.length > MAX_KEYWORDS) return { error: `at most ${MAX_KEYWORDS} keywords` };
    return { keywords: out };
}

/** Replace the list (already cleaned). */
function setFollow(keywords) {
    const db = getDb();
    const insert = db.prepare('INSERT INTO sports_follow (position, keyword) VALUES (?, ?)');
    db.transaction(() => {
        db.prepare('DELETE FROM sports_follow').run();
        keywords.forEach((k, i) => insert.run(i, k));
    })();
    followCache = null;
    followVersion++;
    // 0159: rebuild in the background (R09: on the worker) rather than leaving it for the
    // next request to wait on (see cachedEvents() below).
    scheduleRebuild();
    return getFollow();
}

// ---- building the events --------------------------------------------------------

/** Visible live channels, once per identity, in guide order, with what ordering needs. */
function visibleChannels(db) {
    const rows = db.prepare(`
        SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.data, p.stable_id, p.tvg_id,
               ${CHANNEL_KEY_SQL} AS channel_key, n.number AS channel_number
        FROM playlist_items p
        ${NUMBER_JOIN}
        WHERE ${VISIBLE_SQL}
        ORDER BY COALESCE(p.sort_order, 999999999) ASC, p.name ASC, p.id ASC
    `).all();
    const byKey = new Map();
    for (const r of rows) {
        const key = `${r.source_id}:${r.channel_key}`;
        const sport = sportCategories.isSport(r.source_id, r.category_id);
        const seen = byKey.get(key);
        if (seen) { seen.sportChannel = seen.sportChannel || sport; continue; } // cross-listed
        let tvgId = r.tvg_id || null;
        if (!tvgId) {
            try { const d = JSON.parse(r.data || '{}'); tvgId = d.tvgId || d.epg_channel_id || null; } catch { tvgId = null; }
        }
        tvgId = epgMapping.effectiveTvgId(r.source_id, r.stable_id, r.item_id, tvgId);
        byKey.set(key, {
            key,
            order: byKey.size,
            tvgId,
            sportChannel: sport,
            // the response fields (C-I)
            sourceId: r.source_id,
            id: r.item_id,
            stableId: r.stable_id || null,
            name: r.name,
            number: r.channel_number ?? null,
            logo: r.stream_icon || null,
            quality: qualityFromName(r.name)
        });
    }
    return [...byKey.values()];
}

function programmesFor(db, tvgIds, from, to) {
    const out = [];
    for (let i = 0; i < tvgIds.length; i += 500) {
        const chunk = tvgIds.slice(i, i + 500);
        out.push(...db.prepare(`
            SELECT channel_id, title, start_time, end_time, categories, flags
            FROM epg_live
            WHERE channel_id IN (${chunk.map(() => '?').join(',')})
              AND start_time >= ? AND start_time < ?
        `).all(...chunk, from - LOOKBACK_MS, to));
    }
    return out;
}

const RULE_RANK = { keyword: 0, category: 1, sportChannel: 2 };

/**
 * Every sport event in [from, from + 72 h): the cached part of a request. Synchronous and
 * heavy: it runs on the build worker (sportsEventsWorker.js), not on the serving loop, unless
 * the worker is unavailable. `follow` is the keyword list (the worker has no follow cache of
 * its own to trust); `decorateChannels`, if given, is applied here (the worker has none).
 */
function buildEvents({ from, follow: keywords, decorateChannels } = {}) {
    const db = getDb();
    const follow = compileFollow(keywords || getFollow());
    const channels = visibleChannels(db);
    if (decorateChannels) decorateChannels(channels);
    channelHealth.applyHealth(channels);

    const tvgIds = [...new Set(channels.map(ch => ch.tvgId).filter(Boolean))];
    const progs = programmesFor(db, tvgIds, from, from + WINDOW_MS);
    // 0161: ESPN's real kickoff/session times, for whichever leagues currently matter
    // (sportsFixtures.neededLeagues() - the follow list, or a marked sport category's own name;
    // never a scan of this build's own programmes, so this stays cheap even before any of them
    // are classified). Read here, in the DB-touching build, and handed down as plain data - so
    // eventsFromProgrammes below stays the pure part of a build its own comment promises: no
    // caller of it (a test, sportsClassify's own tests) is silently made to open a database.
    const fixturesByLeague = sportsFixtures.snapshot(sportsFixtures.neededLeagues(db));
    // Items that ended before this minute were only read to find first airings.
    const events = eventsFromProgrammes(channels, progs, follow, fixturesByLeague).filter(ev => ev.end > from);
    return { from, events, channelCount: channels.length, programmeCount: progs.length };
}

/**
 * The pure part of a build: every sport item (all kinds) from the visible channels
 * ({ key, order, tvgId, sportChannel, name, ... }) and their programmes (epg_live rows:
 * channel_id, title, start_time, end_time, categories as JSON, flags (0152)). `follow` is
 * compileFollow()'s result, or the keyword list. `fixturesByLeague` (0161) is
 * services/sportsFixtures.js's snapshot, or undefined - plain data in, plain data out; this
 * function itself never touches the database or the network.
 */
function eventsFromProgrammes(channels, progs, follow, fixturesByLeague) {
    if (Array.isArray(follow)) follow = compileFollow(follow);
    const byTvg = new Map();
    for (const ch of channels) {
        if (!ch.tvgId) continue;
        if (!byTvg.has(ch.tvgId)) byTvg.set(ch.tvgId, []);
        byTvg.get(ch.tvgId).push(ch);
    }

    // Titles and category sets repeat across channels and days: classify each once.
    // Loop detection needs each channel's whole window, so it runs once per build.
    const looped = sportsClassify.loopedProgrammes(progs);
    const verdicts = new Map();
    const parsedTitles = new Map();
    const channelTokens = new Map();
    const airings = [];
    for (const p of progs) {
        if (!(p.end_time > p.start_time)) continue;
        let categories = [];
        if (p.categories) { try { categories = JSON.parse(p.categories) || []; } catch { categories = []; } }
        for (const ch of byTvg.get(p.channel_id) || []) {
            const vkey = `${p.title}\u0001${p.categories || ''}\u0001${ch.sportChannel ? 1 : 0}`;
            let verdict = verdicts.get(vkey);
            if (verdict === undefined) {
                verdict = classify({ title: p.title, categories, sportChannel: ch.sportChannel }, follow);
                verdicts.set(vkey, verdict);
            }
            if (!verdict) continue;
            let parsed = parsedTitles.get(p.title);
            if (!parsed) { parsed = sportsClassify.parseTitle(p.title); parsedTitles.set(p.title, parsed); }
            let chTokens = channelTokens.get(ch.key);
            if (!chTokens) { chTokens = sportsClassify.channelTokens(ch.name); channelTokens.set(ch.key, chTokens); }
            const kind = sportsClassify.classifyKind({
                title: p.title, start: p.start_time, categories, rule: verdict.rule, loop: looped.has(p), parsed, chTokens
            });
            airings.push({
                title: p.title, start: p.start_time, end: p.end_time, channel: ch, order: ch.order, verdict,
                rule: verdict.rule, parsed, kind: kind.kind, why: kind.why, generic: !!kind.generic, flags: p.flags | 0,
                // merged within one canonical league: the one the title names, else the recognised one
                league: sportsClassify.detectLeague(p.title) || verdict.league
            });
        }
    }

    // 0152: live or replay, across each game's airings (flags, first airing, hours; 0161: ESPN first).
    sportsClassify.resolveLive(airings, fixturesByLeague);

    const keywordOrder = new Map(follow.list.map((k, i) => [k.keyword, i]));
    const items = sportsClassify.mergeAirings(airings, a => normaliseTitle(a.title, a.channel.name) || a.title.toLowerCase());
    return items.map(item => finishEvent(item, keywordOrder));
}

function finishEvent(item, keywordOrder) {
    const first = item.airings[0];
    // The rule: the strongest among its programmes (keyword, then category, then sport channel).
    let best = first.verdict;
    for (const a of item.airings) {
        const v = a.verdict;
        if (RULE_RANK[v.rule] < RULE_RANK[best.rule]
            || (v.rule === 'keyword' && best.rule === 'keyword' && keywordOrder.get(v.match) < keywordOrder.get(best.match))) best = v;
    }
    let league = best.league;
    if (best.rule !== 'keyword' && league === 'Sport') {
        league = item.airings.map(a => a.verdict.league).find(l => l !== 'Sport') || 'Sport';
    }
    const channels = [];
    const seen = new Set();
    for (const a of item.airings) {
        if (seen.has(a.channel.key)) continue;
        seen.add(a.channel.key);
        channels.push(a.channel);
    }
    return {
        id: crypto.createHash('sha1').update(`${item.key}\u0000${item.start}`).digest('hex').slice(0, 16),
        kind: item.kind,
        kindRule: `${item.kind}: ${item.why}`,
        title: item.title,
        aliases: item.aliases,
        league,
        start: item.start,
        end: item.end,
        rule: best.rule,
        match: best.match,
        channels
    };
}

// ---- the cache and the request (0159: stale-while-revalidate; R09: off the event loop) ---------
//
// buildEvents() is measured at ~0.3-1.1 s on 1,000 channels (module comment above),
// synchronous - and the event loop it would block also serves live HLS segments, so
// a build on it is a playback stall. Two steps took it off:
//   0159  requests are always served the last built result; a rebuild for a new key is
//         triggered by scheduleRebuild() - after an EPG sync, when the follow list changes,
//         and from a timer aligned to the 5-minute bucket (below) - so the fresh result is
//         normally already in `cache` by the time a request asks for it.
//   R09   setImmediate did not help: it still ran on the same loop. The build now runs on a
//         long-lived worker thread (sportsEventsWorker.js) with its own read-only database
//         connection, so the serving loop only pays for receiving the result (a structured
//         clone) and decorating its channels, in slices (below).
// Once any result is cached a request NEVER builds: it gets the last result and, if that is
// stale, a rebuild is scheduled. Only the very first request (nothing cached at all, so
// nothing else to serve) waits - asynchronously - for a build. At most one build runs and one
// waits behind it; a newer key replaces the waiting one (the latest key wins).
//
// If the worker cannot be used (it will not start or dies) the build
// runs inline as it did before R09 - correct, but it blocks the loop - and a warning says so.

let cache = null; // { key, built }, replaced whole: a reader sees the old result or the new, never a mix
let running = null; // the job being built
let queued = null; // the job waiting for it: only the latest key is kept
let generation = 0; // bumped by reset(): a result from before it is not published
let lastDecorateChannels = null; // the most recent request's channel-decorator, reused by triggers that have none of their own
let staleSince = 0; // when a request or trigger first found `cache` out of date; 0 when it is current
let wantedKey = null; // the key the latest request or trigger asked for
const stats = {
    builds: 0, lastBuildMs: 0, // lastBuildMs: the build itself (on the worker)
    lastTotalMs: 0, // ... plus the hand-over and decorating on the main thread
    lastMaxLoopDelayMs: 0, // the worst event-loop stall seen on the main thread during the last build
    revision: 0, // +1 each time a result is published
    inlineBuilds: 0 // builds that had to run on the main thread (no worker)
};

function buildKeyFor(now) {
    const bucket = Math.floor(now / BUILD_EVERY_MS) * BUILD_EVERY_MS;
    return { bucket, key: `${currentGuideVersion()}|${followVersion}|${bucket}` };
}

/** The numbers for the Status page: stats, plus how long the served result has been out of date. */
function status() {
    return { ...stats, staleSinceMs: staleSince ? Date.now() - staleSince : 0, building: Boolean(running), cached: Boolean(cache) };
}

// ---- the worker ----

const LOOP_RESOLUTION_MS = 10;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
// Test seam only: a test that edits classification constants in-process builds inline.
let useWorker = true;
function _buildInline(on) { useWorker = on === false; }
const workerEnabled = () => useWorker;

let worker = null;
let nextMessageId = 1;
const waiting = new Map(); // message id -> { resolve, reject, channels: Map(key -> channel), events: [] }

function failWaiting(err) {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
}

function startWorker() {
    const w = new Worker(path.join(__dirname, 'sportsEventsWorker.js'), { workerData: { pigtvReadOnlyDb: true } });
    w.on('message', ({ id, channels, events, done, error }) => {
        const pending = waiting.get(id);
        if (!pending) return;
        if (channels) { for (const ch of channels) pending.channels.set(ch.key, ch); return; }
        if (events) { pending.events.push(...events); return; }
        waiting.delete(id);
        if (!waiting.size) w.unref(); // idle: never keeps the process (or a test) alive
        if (error) return pending.reject(new Error(error));
        // the events name their channels by key: put the shared objects back
        for (const ev of pending.events) ev.channels = ev.channels.map(key => pending.channels.get(key));
        pending.resolve({
            built: { from: done.from, events: pending.events, channelCount: done.channelCount, programmeCount: done.programmeCount },
            buildMs: done.buildMs
        });
    });
    w.on('error', (err) => {
        if (worker === w) worker = null;
        failWaiting(err);
    });
    w.on('exit', () => {
        if (worker === w) worker = null;
        failWaiting(new Error('the sport event worker stopped'));
    });
    w.unref();
    return w;
}

function buildInWorker(from, follow) {
    if (!worker) worker = startWorker();
    return new Promise((resolve, reject) => {
        const id = nextMessageId++;
        waiting.set(id, { resolve, reject, channels: new Map(), events: [] });
        worker.ref(); // a build is pending: the process stays up for it
        worker.postMessage({ id, from, follow });
    });
}

/** Stop the worker (server shutdown; tests). A later build starts a new one. */
function stopWorker() {
    const w = worker;
    worker = null;
    if (w) w.terminate().catch(() => {});
}

/** Stop everything this module runs in the background. */
function shutdown() {
    stopBackgroundRebuilds();
    stopWorker();
}

let warnedInline = false;
async function computeBuild(from, follow) {
    if (workerEnabled()) {
        try {
            return await buildInWorker(from, follow);
        } catch (err) {
            console.warn('[Sport] The build worker failed, building on the main thread this once:', err.message);
        }
    } else if (!warnedInline) {
        warnedInline = true;
        console.warn('[Sport] Building events on the main thread (tests only)');
    }
    stats.inlineBuilds++;
    const t0 = process.hrtime.bigint();
    const built = buildEvents({ from, follow });
    return { built, buildMs: Number(process.hrtime.bigint() - t0) / 1e6 };
}

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const DECORATE_SLICE = 100; // channels per slice: ~1 ms of logo lookups each, then back to the loop

/**
 * Run the route's decorateChannels (logos: it writes the logo cache, so it can only run here) over
 * the channels the events name - each once, they are shared between events - a slice at a time.
 */
async function decorateBuilt(built, decorateChannels) {
    if (!decorateChannels) return;
    const channels = new Set();
    for (const ev of built.events) for (const ch of ev.channels) channels.add(ch);
    const all = [...channels];
    for (let i = 0; i < all.length; i += DECORATE_SLICE) {
        decorateChannels(all.slice(i, i + DECORATE_SLICE));
        if (i + DECORATE_SLICE < all.length) await yieldToLoop();
    }
}

async function runJob(job) {
    const t0 = process.hrtime.bigint();
    loopDelay.reset();
    loopDelay.enable();
    try {
        const { built, buildMs } = await computeBuild(job.bucket, getFollow().slice());
        await decorateBuilt(built, lastDecorateChannels);
        await prepareBuilt(built); // after the logos: the serialised channels carry them
        if (job.generation === generation) { // not reset() meanwhile
            cache = { key: job.key, built }; // atomically replaces the previous result
            stats.builds++;
            stats.revision++;
            built.rev = stats.revision;
            stats.lastBuildMs = buildMs;
            stats.lastTotalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            if (job.key === wantedKey) staleSince = 0;
        }
        job.resolve(built);
    } catch (err) {
        job.reject(err);
    } finally {
        // the timer's resolution is part of what it measures
        if (job.generation === generation) stats.lastMaxLoopDelayMs = Math.max(0, loopDelay.max / 1e6 - LOOP_RESOLUTION_MS);
        loopDelay.disable();
        // free the slot before whoever awaited the result continues, so a trigger it makes
        // starts at once rather than queueing behind a build that has already finished
        if (running === job) running = null;
    }
}

function pump() {
    if (running || !queued) return;
    const job = queued;
    queued = null;
    running = job;
    runJob(job).then(() => {}, () => {}).finally(pump);
}

/**
 * The promise of a build for `now`'s key: the cached result if current, else the running or
 * waiting job's, else a new job queued behind the running one (replacing any waiting job: the
 * latest key wins, and whoever waited on the replaced one gets the newer result).
 */
function buildFor(now) {
    const { bucket, key } = buildKeyFor(now);
    wantedKey = key;
    if (cache && cache.key === key) return Promise.resolve(cache.built);
    if (running && running.key === key && running.generation === generation) return running.promise;
    if (queued && queued.key === key) return queued.promise;
    const job = { key, bucket, generation };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (queued) queued.resolve(job.promise);
    queued = job;
    pump();
    return job.promise;
}

/**
 * The events for a request. Current: straight from the cache. Stale: the last result,
 * immediately, and a rebuild is scheduled. Nothing cached at all: wait for the first build
 * (on the worker, so the loop keeps serving meanwhile).
 */
function cachedEvents(now, decorateChannels) {
    if (decorateChannels) lastDecorateChannels = decorateChannels;
    const { key } = buildKeyFor(now);
    if (cache && cache.key === key) return Promise.resolve(cache.built);
    if (cache) {
        scheduleRebuild(now);
        return Promise.resolve(cache.built);
    }
    return buildFor(now);
}

/**
 * Rebuild in the background for `now` (default: this minute) without blocking the
 * caller or the loop. An EPG sync landing, an admin saving the follow list, and the 5-minute
 * timer (below) all call this. A request that lands while this is running is answered by
 * cachedEvents() above from the previous result; once this finishes, the next request sees
 * the fresh one. A no-op when the key is already current or already being built, so it never
 * overlaps itself. Returns the promise of the build (never rejects), for a test to await.
 */
function scheduleRebuild(now = Date.now(), decorateChannels = lastDecorateChannels) {
    if (decorateChannels) lastDecorateChannels = decorateChannels;
    if (cache && cache.key !== buildKeyFor(now).key && !staleSince) staleSince = Date.now();
    return buildFor(now).then(() => {}, (err) => {
        console.error('[Sport] Background rebuild failed:', err.message);
    });
}

/** Resolves once no build is running or waiting (tests; a clean shutdown). */
async function idle() {
    while (running || queued) await (running || queued).promise.then(() => {}, () => {});
}

// A timer aligned to the 5-minute bucket, so the background rebuild for the next
// bucket is usually already done by the time anyone asks for it, rather than every
// request after a bucket rolls over racing to be the one that pays for the build.
let rebuildTimer = null;

function msUntilNextBucket(now = Date.now()) {
    const rem = BUILD_EVERY_MS - (now % BUILD_EVERY_MS);
    return (rem <= 0 ? BUILD_EVERY_MS : rem) + 1000; // a second past the boundary
}

function armRebuildTimer() {
    rebuildTimer = setTimeout(() => {
        scheduleRebuild();
        armRebuildTimer();
    }, msUntilNextBucket());
    if (rebuildTimer.unref) rebuildTimer.unref(); // never keeps the process alive on its own
}

/** Start the 5-minute-bucket background rebuild timer (called once, at server start). */
function startBackgroundRebuilds() {
    if (rebuildTimer) return;
    armRebuildTimer();
}

function stopBackgroundRebuilds() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = null;
}

const clampHours = (v) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return DEFAULT_HOURS;
    return Math.min(MAX_HOURS, Math.max(1, n));
};

/** The user's favourites as "sourceId:identity" (identity when stored, else the item id). */
function favouriteKeys(userId) {
    if (userId === undefined || userId === null) return new Set();
    const rows = getDb().prepare(`SELECT source_id, item_id, stable_id FROM favorites WHERE user_id = ? AND item_type = 'channel'`)
        .all(String(userId));
    return new Set(rows.map(f => `${f.source_id}:${f.stable_id || f.item_id}`));
}

const DEFAULT_KINDS = new Set(['event', 'replay']);
const KIND_ORDER = { event: 0, replay: 1, show: 2, placeholder: 3 };

/**
 * The events for one request (C-I):
 *   { now, events: [{ id, kind, title, aliases, league, start, end, live,
 *                     channels: [{ sourceId, id, stableId, name, number, logo, quality }] }] }
 * Events and replays (0150), or every kind with `include: 'all'`. Ordered by kind
 * (events, replays, shows, placeholders), each live first, then by start. `withRule`
 * adds `rule` and `match` (how it was recognised) and `kindRule` (why it is that kind;
 * the admin preview).
 */
async function eventsFor({ hours, userId, now = Date.now(), withRule = false, include, decorateChannels } = {}) {
    const span = clampHours(hours) * HOUR_MS;
    const built = await cachedEvents(now, decorateChannels);
    const favs = favouriteKeys(userId);
    const isFav = (ch) => favs.has(`${ch.sourceId}:${ch.stableId || ch.id}`) || favs.has(`${ch.sourceId}:${ch.id}`);

    const events = [];
    const all = include === 'all';
    for (const ev of built.events) {
        if (!all && !DEFAULT_KINDS.has(ev.kind)) continue;
        if (!(ev.end > now && ev.start < now + span)) continue;
        const channels = ev.channels.slice().sort((a, b) =>
            qualityRank(a.quality) - qualityRank(b.quality)
            || healthRank(a.health) - healthRank(b.health)
            || (isFav(b) ? 1 : 0) - (isFav(a) ? 1 : 0)
            || a.order - b.order);
        const out = {
            id: ev.id,
            kind: ev.kind,
            title: ev.title,
            aliases: ev.aliases,
            league: ev.league,
            start: ev.start,
            end: ev.end,
            live: ev.start <= now && now < ev.end,
            channels: channels.map(ch => ({
                sourceId: ch.sourceId, id: ch.id, stableId: ch.stableId, name: ch.name,
                number: ch.number, logo: ch.logo, quality: ch.quality
            }))
        };
        if (withRule) { out.rule = ev.rule; out.match = ev.match; out.kindRule = ev.kindRule; }
        events.push(out);
    }
    events.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
        || (a.live === b.live ? 0 : a.live ? -1 : 1) || a.start - b.start || a.title.localeCompare(b.title));
    return { now, events };
}

// ---- the serialised answer (a request costs the serving loop a few ms, not 100-200) ----------
//
// eventsFor() above is the reference: it filters ~10,000 cached events by `hours`, marks `live`,
// orders every event's channels for the user and builds ~10,000 objects that res.json then
// walks again - 100-200 ms of the loop that also serves live HLS segments, for every Home and
// Sport appearance and every minute after. Nearly all of that is the same for every request, so:
//   per build   each event's JSON is written once, in two halves around `"live":` (the one field
//               that moves with the clock), with its channels in the order a user with no
//               favourites sees them; events sorted once by kind, start, title. This is done in
//               slices at the end of the build (prepareBuilt), not by a request.
//   per request the events in the window are picked (a compare each), put live-first, and the
//               strings joined - for a user whose favourites are among an event's channels, only
//               THAT event's channels are re-ordered and re-written.
//   per minute  the finished body is kept per (build, hours, include, favourites, minute) and
//               a repeat is a buffer send with an ETag, so an unchanged answer is a 304.
// The inputs that can change an answer are exactly those: the build (guide, follow list, channel
// health, logos - all baked in at build time; health refreshes with the 5-minute build), the
// window, the user's favourites (read per request: one indexed query - the key is a hash of
// WHICH channels, so two users with the same favourites share an entry) and the clock, which
// is why `now` is the minute's start here (live flips, and events enter and leave, at most a
// minute late). The bytes are those of eventsFor({ now: <that minute> }) through res.json.
// The cold miss (once a minute per distinct request) is a few ms of string joining, so it stays
// on the main thread: the worker would have to send ~MBs back, which costs more than it saves.

const MINUTE_MS = 60 * 1000;
const PREP_SLICE = 500; // events per slice: ~2 ms of stringify, then back to the loop
const RESPONSE_ENTRIES = 12; // a couple of hours values x include x a handful of distinct favourite sets
const RESPONSE_BYTES = 48 * 1024 * 1024; // each 72 h body is a few MB (plus its gzip); least recently used go first
const bootNonce = crypto.randomBytes(3).toString('hex'); // a restart restarts `revision`: its ETags must not collide
const responses = new Map(); // key -> entry, least recently used first (a Map iterates in insertion order)
let responseBytes = 0;

const channelJson = (ch) => JSON.stringify({
    sourceId: ch.sourceId, id: ch.id, stableId: ch.stableId, name: ch.name,
    number: ch.number, logo: ch.logo, quality: ch.quality
});
const favKeysOf = (ch) => [`${ch.sourceId}:${ch.stableId || ch.id}`, `${ch.sourceId}:${ch.id}`];
const byBaseOrder = (a, b) => qualityRank(a.quality) - qualityRank(b.quality)
    || healthRank(a.health) - healthRank(b.health)
    || a.order - b.order;

/** The ',"channels":[...]}' end of an event's JSON for these channels, already in order. */
const channelsTail = (channels, jsons) => `,"channels":[${channels.map(ch => jsons.get(ch)).join(',')}]}`;

async function prepareBuilt(built) {
    if (built.prep) return built.prep;
    const jsons = new Map(); // channel -> its JSON, shared by every event naming it
    const entries = [];
    const byFav = new Map(); // "sourceId:identity" -> entries with such a channel
    const sorted = built.events.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
        || a.start - b.start || a.title.localeCompare(b.title));
    for (let i = 0; i < sorted.length; i++) {
        const ev = sorted[i];
        for (const ch of ev.channels) if (!jsons.has(ch)) jsons.set(ch, channelJson(ch));
        const channels = ev.channels.slice().sort(byBaseOrder);
        const entry = {
            ev, kind: KIND_ORDER[ev.kind],
            head: JSON.stringify({ id: ev.id, kind: ev.kind, title: ev.title, aliases: ev.aliases, league: ev.league, start: ev.start, end: ev.end })
                .slice(0, -1) + ',"live":',
            tail: channelsTail(channels, jsons)
        };
        entries.push(entry);
        for (const ch of ev.channels) {
            for (const k of favKeysOf(ch)) {
                const list = byFav.get(k);
                if (!list) byFav.set(k, [entry]); else if (list[list.length - 1] !== entry) list.push(entry);
            }
        }
        if ((i + 1) % PREP_SLICE === 0) await yieldToLoop();
    }
    built.prep = { entries, byFav, jsons, favTails: new Map() };
    return built.prep;
}

/**
 * The ends of the events a user's favourites touch, re-ordered for them: Map(entry -> tail).
 * Kept per set of favourites for the life of the build (a few sets at most).
 */
function favouriteTails(prep, favs, favSig) {
    let tails = prep.favTails.get(favSig);
    if (tails) return tails;
    const isFav = (ch) => favs.has(`${ch.sourceId}:${ch.stableId || ch.id}`) || favs.has(`${ch.sourceId}:${ch.id}`);
    tails = new Map();
    for (const k of favs) {
        for (const entry of prep.byFav.get(k) || []) {
            if (tails.has(entry)) continue;
            const channels = entry.ev.channels.slice().sort((a, b) =>
                qualityRank(a.quality) - qualityRank(b.quality)
                || healthRank(a.health) - healthRank(b.health)
                || (isFav(b) ? 1 : 0) - (isFav(a) ? 1 : 0)
                || a.order - b.order);
            tails.set(entry, channelsTail(channels, prep.jsons));
        }
    }
    if (prep.favTails.size >= 8) prep.favTails.delete(prep.favTails.keys().next().value);
    prep.favTails.set(favSig, tails);
    return tails;
}

function assemble(prep, tails, minute, span, all) {
    const lanes = [[], [], [], [], [], [], [], []]; // kind x (live, not live): the order the answer wants
    const end = minute + span;
    for (const entry of prep.entries) {
        const ev = entry.ev;
        if (!all && !DEFAULT_KINDS.has(ev.kind)) continue;
        if (!(ev.end > minute && ev.start < end)) continue;
        const live = ev.start <= minute && minute < ev.end;
        lanes[entry.kind * 2 + (live ? 0 : 1)].push(entry);
    }
    const parts = [];
    for (let l = 0; l < lanes.length; l++) {
        const live = l % 2 === 0 ? 'true' : 'false';
        for (const entry of lanes[l]) parts.push(entry.head + live + (tails.get(entry) || entry.tail));
    }
    return Buffer.from(`{"now":${minute},"events":[${parts.join(',')}]}`);
}

function trimResponses(rev, minute) {
    for (const [k, e] of responses) {
        if (e.rev < rev || e.minute < minute) { responses.delete(k); responseBytes -= e.bytes; }
    }
    while (responses.size > RESPONSE_ENTRIES || responseBytes > RESPONSE_BYTES) {
        const [k, e] = responses.entries().next().value;
        responses.delete(k);
        responseBytes -= e.bytes;
    }
}

/**
 * The /events answer, serialised: { body: Buffer, etag, gzip(): Promise<Buffer>, cached }.
 * Same JSON as `JSON.stringify(await eventsFor({ hours, userId, include, now: <the minute's start> }))`.
 */
async function eventsResponse({ hours, userId, now = Date.now(), include, decorateChannels } = {}) {
    const hrs = clampHours(hours);
    const all = include === 'all';
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const built = await cachedEvents(now, decorateChannels);
    const favs = favouriteKeys(userId);
    const favSig = favs.size ? crypto.createHash('sha1').update([...favs].sort().join('\u0000')).digest('hex').slice(0, 12) : '';
    const key = `${built.rev}|${hrs}|${all ? 'all' : 'd'}|${favSig}|${minute}`;
    const hit = built.rev ? responses.get(key) : null;
    if (hit) {
        responses.delete(key); // most recently used goes last
        responses.set(key, hit);
        return { ...hit.out, cached: true };
    }
    const prep = await prepareBuilt(built);
    const body = assemble(prep, favs.size ? favouriteTails(prep, favs, favSig) : new Map(), minute, hrs * HOUR_MS, all);
    const etag = `W/"${bootNonce}-${built.rev || 'x'}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}"`;
    const entry = { rev: built.rev, minute, bytes: body.length };
    let gz = null;
    entry.out = {
        body, etag, cached: false,
        // compressed once, off the loop (zlib's threadpool), for every client that takes gzip
        gzip: () => gz || (gz = new Promise((resolve, reject) => require('zlib').gzip(body, (err, buf) => {
            if (err) return reject(err);
            if (responses.get(key) === entry) { entry.bytes += buf.length; responseBytes += buf.length; }
            resolve(buf);
        })))
    };
    if (built.rev) {
        trimResponses(built.rev, minute);
        responses.set(key, entry);
        responseBytes += entry.bytes;
        trimResponses(built.rev, minute);
    }
    return entry.out;
}

// ---- 0147: EPG categories ---------------------------------------------------------

const CATEGORY_LIMIT = 200;
const CATEGORY_TTL_MS = 10 * 60 * 1000;
let categoryCache = null; // { key, builtAt, rows }

/** The live EPG generations, which change exactly when a sync lands a new guide. */
function epgGenerations(db = getDb()) {
    return db.prepare('SELECT source_id, active_gen FROM epg_state ORDER BY source_id').all()
        .map(r => `${r.source_id}:${r.active_gen}`).join(',');
}

/**
 * [{category, programmes}] over the live generation(s), most used first (then by
 * name), at most 200. Counting walks every programme, so the answer is kept until
 * a sync changes the guide (or 10 minutes pass).
 */
function categoryCounts({ now = Date.now() } = {}) {
    const db = getDb();
    const key = epgGenerations(db);
    if (categoryCache && categoryCache.key === key && now - categoryCache.builtAt < CATEGORY_TTL_MS
        && now >= categoryCache.builtAt) return categoryCache.rows;
    const rows = db.prepare(`
        SELECT j.value AS category, COUNT(*) AS programmes
        FROM epg_live e, json_each(e.categories) j
        WHERE e.categories IS NOT NULL
        GROUP BY j.value
        ORDER BY programmes DESC, category ASC
        LIMIT ?
    `).all(CATEGORY_LIMIT);
    categoryCache = { key, builtAt: now, rows };
    return rows;
}

function reset() {
    categoryCache = null;
    cache = null;
    responses.clear();
    responseBytes = 0;
    followCache = null;
    generation++; // a build still under way will not publish into the fresh state
    running = null;
    queued = null;
    staleSince = 0;
    wantedKey = null;
}

module.exports = {
    // 0147
    categoryCounts, epgGenerations, CATEGORY_LIMIT,
    // 0148
    classify, compileFollow, normaliseTitle, qualityFromName, leagueFromCategories,
    getFollow, setFollow, cleanFollow, eventsFor, buildEvents, clampHours, stats, eventsResponse,
    // for tests: what the response cache holds, and an empty one
    responseCacheSize: () => ({ entries: responses.size, bytes: responseBytes }),
    clearResponses: () => { responses.clear(); responseBytes = 0; },
    // 0150
    eventsFromProgrammes,
    DEFAULT_HOURS, MAX_HOURS, MAX_KEYWORDS,
    reset,
    // 0159: builds run in the background instead of blocking a request
    scheduleRebuild, startBackgroundRebuilds, stopBackgroundRebuilds,
    // R09: builds run on a worker thread
    status, idle, shutdown, stopWorker, _buildInline
};
