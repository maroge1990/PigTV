/**
 * Sport events (contract C-I; 0147 categories, 0148 events).
 *
 * Sport is recognised per PROGRAMME, not per channel: about 100 channels carry
 * NFL only some of the time. A programme is sport when
 *   (a) one of its EPG categories matches the sport vocabulary, or
 *   (b) its title or a category contains a followed keyword (the admin's list), or
 *   (c) its channel's category is marked sport (C-H, services/sportCategories.js)
 *       and its title reads like a live event ("Live", "vs", " v ").
 * News, Highlights, Preview, Replay, Classic and Magazine (in the title or a
 * category) are not events, unless a followed keyword matches.
 *
 * Sport programmes with the same normalised title at overlapping times are one
 * event with several channels. Channels are ordered best first: quality from
 * the name (UHD, HD, unknown, SD), then health ok (C-G), then the user's
 * favourite, then guide order.
 *
 * Only visible channels count (not hidden, not in a hidden category), once per
 * channel identity. The event list scans a window of epg_live across every
 * visible channel, so it is built once per (library_rev + EPG generations,
 * follow-list version, minute) for the next 24 hours; each request then only
 * filters by its `hours`, marks `live` and orders channels for its user.
 */
const crypto = require('crypto');
const { getDb } = require('../db/sqlite');
const { currentGuideVersion } = require('./libraryRev');
const { NUMBER_JOIN, VISIBLE_SQL, CHANNEL_KEY_SQL } = require('./channelNumbers');
const channelHealth = require('./channelHealth');
const epgMapping = require('./epgMapping');
const sportCategories = require('./sportCategories');

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR_MS;      // what one build covers, from its minute
const MAX_PROGRAMME_MS = 24 * HOUR_MS; // as routes/library.js: bounds start_time for the index
const DEFAULT_HOURS = 6;
const MAX_HOURS = 24;
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

function compileFollow(keywords) {
    const list = keywords.map(k => ({ keyword: k, re: wordRegExp(phrase(k.toLowerCase())) }));
    return {
        list,
        any: list.length ? wordRegExp(list.map(k => phrase(k.keyword.toLowerCase())).join('|')) : null
    };
}

/** The first followed keyword (in list order) in the title or a category, or null. */
function followedKeyword(follow, title, categories) {
    if (!follow.any) return null;
    const texts = [title, ...categories].filter(Boolean);
    if (!texts.some(t => follow.any.test(t))) return null;
    for (const k of follow.list) if (texts.some(t => k.re.test(t))) return k.keyword;
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
 * programme's channel.
 */
function classify({ title, categories = [], sportChannel = false }, follow) {
    const text = String(title || '');
    const keyword = followedKeyword(follow, text, categories);
    if (keyword) return { rule: 'keyword', match: keyword, league: keyword };
    if (EXCLUDE_RE.test(text) || categories.some(c => EXCLUDE_RE.test(c))) return null;
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
            SELECT channel_id, title, start_time, end_time, categories
            FROM epg_live
            WHERE channel_id IN (${chunk.map(() => '?').join(',')})
              AND start_time > ? AND end_time > ? AND start_time < ?
        `).all(...chunk, from - MAX_PROGRAMME_MS, from, to));
    }
    return out;
}

const RULE_RANK = { keyword: 0, category: 1, sportChannel: 2 };

/** Every sport event in [from, from + 24 h): the cached part of a request. */
function buildEvents({ from, decorateChannels } = {}) {
    const db = getDb();
    const follow = compileFollow(getFollow());
    const channels = visibleChannels(db);
    if (decorateChannels) decorateChannels(channels);
    channelHealth.applyHealth(channels);

    const byTvg = new Map();
    for (const ch of channels) {
        if (!ch.tvgId) continue;
        if (!byTvg.has(ch.tvgId)) byTvg.set(ch.tvgId, []);
        byTvg.get(ch.tvgId).push(ch);
    }
    const progs = programmesFor(db, [...byTvg.keys()], from, from + WINDOW_MS);

    // Titles and category sets repeat across channels and days: classify each once.
    const verdicts = new Map();
    const airingsByTitle = new Map();
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
            const norm = normaliseTitle(p.title, ch.name);
            if (!norm) continue;
            if (!airingsByTitle.has(norm)) airingsByTitle.set(norm, []);
            airingsByTitle.get(norm).push({ title: p.title, start: p.start_time, end: p.end_time, channel: ch, verdict });
        }
    }

    const keywordOrder = new Map(follow.list.map((k, i) => [k.keyword, i]));
    const events = [];
    for (const [norm, airings] of airingsByTitle) {
        airings.sort((a, b) => a.start - b.start || a.channel.order - b.channel.order);
        let current = null;
        const flush = () => { if (current) events.push(finishEvent(norm, current, keywordOrder)); };
        for (const a of airings) {
            if (current && a.start < current.end) {
                current.end = Math.max(current.end, a.end);
                current.airings.push(a);
            } else {
                flush();
                current = { start: a.start, end: a.end, airings: [a] };
            }
        }
        flush();
    }
    return { from, events, channelCount: channels.length, programmeCount: progs.length };
}

function finishEvent(norm, group, keywordOrder) {
    const first = group.airings[0];
    // The rule: the strongest among its programmes (keyword, then category, then sport channel).
    let best = first.verdict;
    for (const a of group.airings) {
        const v = a.verdict;
        if (RULE_RANK[v.rule] < RULE_RANK[best.rule]
            || (v.rule === 'keyword' && best.rule === 'keyword' && keywordOrder.get(v.match) < keywordOrder.get(best.match))) best = v;
    }
    let league = best.league;
    if (best.rule !== 'keyword' && league === 'Sport') {
        league = group.airings.map(a => a.verdict.league).find(l => l !== 'Sport') || 'Sport';
    }
    const channels = [];
    const seen = new Set();
    for (const a of group.airings) {
        if (seen.has(a.channel.key)) continue;
        seen.add(a.channel.key);
        channels.push(a.channel);
    }
    return {
        id: crypto.createHash('sha1').update(`${norm}\u0000${group.start}`).digest('hex').slice(0, 16),
        title: first.title,
        league,
        start: group.start,
        end: group.end,
        rule: best.rule,
        match: best.match,
        channels
    };
}

// ---- the cache and the request --------------------------------------------------

let cache = null; // { key, built }
const stats = { builds: 0, lastBuildMs: 0 };

function cachedEvents(now, decorateChannels) {
    const bucket = Math.floor(now / 60000) * 60000;
    const key = `${currentGuideVersion()}|${followVersion}|${bucket}`;
    if (cache && cache.key === key) return cache.built;
    const t0 = process.hrtime.bigint();
    const built = buildEvents({ from: bucket, decorateChannels });
    stats.builds++;
    stats.lastBuildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    cache = { key, built };
    return built;
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

/**
 * The events for one request (C-I):
 *   { now, events: [{ id, title, league, start, end, live, channels: [{ sourceId, id, stableId, name, number, logo, quality }] }] }
 * live and on-now first (by start), then upcoming (by start). `withRule` adds
 * `rule` and `match` (the admin preview).
 */
function eventsFor({ hours, userId, now = Date.now(), withRule = false, decorateChannels } = {}) {
    const span = clampHours(hours) * HOUR_MS;
    const built = cachedEvents(now, decorateChannels);
    const favs = favouriteKeys(userId);
    const isFav = (ch) => favs.has(`${ch.sourceId}:${ch.stableId || ch.id}`) || favs.has(`${ch.sourceId}:${ch.id}`);

    const events = [];
    for (const ev of built.events) {
        if (!(ev.end > now && ev.start < now + span)) continue;
        const channels = ev.channels.slice().sort((a, b) =>
            qualityRank(a.quality) - qualityRank(b.quality)
            || healthRank(a.health) - healthRank(b.health)
            || (isFav(b) ? 1 : 0) - (isFav(a) ? 1 : 0)
            || a.order - b.order);
        const out = {
            id: ev.id,
            title: ev.title,
            league: ev.league,
            start: ev.start,
            end: ev.end,
            live: ev.start <= now && now < ev.end,
            channels: channels.map(ch => ({
                sourceId: ch.sourceId, id: ch.id, stableId: ch.stableId, name: ch.name,
                number: ch.number, logo: ch.logo, quality: ch.quality
            }))
        };
        if (withRule) { out.rule = ev.rule; out.match = ev.match; }
        events.push(out);
    }
    events.sort((a, b) => (a.live === b.live ? 0 : a.live ? -1 : 1) || a.start - b.start || a.title.localeCompare(b.title));
    return { now, events };
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
    followCache = null;
}

module.exports = {
    // 0147
    categoryCounts, epgGenerations, CATEGORY_LIMIT,
    // 0148
    classify, compileFollow, normaliseTitle, qualityFromName, leagueFromCategories,
    getFollow, setFollow, cleanFollow, eventsFor, buildEvents, clampHours, stats,
    DEFAULT_HOURS, MAX_HOURS, MAX_KEYWORDS,
    reset
};
