/**
 * EPG matching (0134, roadmap S4.2).
 *
 * A channel whose playlist tvg-id has no programmes in the EPG shows "No
 * programme information". The admin can map it to the right EPG channel id;
 * the mapping lives in `epg_mappings`, keyed by the channel's identity (source
 * + stable_id, else item_id - the channel numbers' key), and wins over the
 * playlist's tvg-id everywhere the library looks up the EPG: the guide's
 * programmes, now/next on channel rows, and the EPG logo fallback.
 *
 * Applied at query time rather than written into playlist_items.tvg_id: every
 * sync rewrites that column from the playlist (syncService's upsert sets
 * `tvg_id = excluded.tvg_id`, on both the M3U and Xtream paths), so an
 * "effective" column would have to be re-derived after every sync and by every
 * future ingest path, and one missed call would silently lose the admin's
 * work. A separate table the sync never touches cannot be wiped by it; the
 * cost is one small read (cached until the next change) per library request.
 * Keying on identity also means a provider reorder keeps the mapping.
 *
 * Candidates for an unmatched channel come from the EPG's own channel list
 * (playlist_items rows of type 'epg_channel'), scored by name similarity:
 * both names normalised (case, accents, quality and country tags, punctuation),
 * then token overlap (Dice) blended with character-bigram similarity; an exact
 * normalised match scores 1. Only EPG channels with programmes in the next
 * 24 hours are offered: mapping to one without would not fix anything.
 */
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('./libraryRev');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TVG_ID = 200;

let cache = null; // Map "sourceId:channelKey" -> tvgId

function overrides() {
    if (cache) return cache;
    const map = new Map();
    for (const r of getDb().prepare('SELECT source_id, channel_key, tvg_id FROM epg_mappings').all()) {
        map.set(`${r.source_id}:${r.channel_key}`, r.tvg_id);
    }
    cache = map;
    return map;
}

/** The mapped tvg-id for a channel identity, or null. */
function overrideFor(sourceId, stableId, itemId) {
    try {
        const map = overrides();
        if (!map.size) return null;
        return map.get(`${sourceId}:${stableId || itemId}`) || null;
    } catch (e) {
        return null;
    }
}

/** The tvg-id the library should use for a channel: the admin's mapping, else the playlist's. */
function effectiveTvgId(sourceId, stableId, itemId, playlistTvgId) {
    return overrideFor(sourceId, stableId, itemId) || playlistTvgId || null;
}

// ---- name similarity --------------------------------------------------------

const TAGS = /\b(?:hd|fhd|uhd|sd|4k|8k|hevc|h265|h264|1080[pi]?|720p|576[pi]?|50fps|60fps|raw|backup|vip)\b/g;

/** Lower case, no accents, badges, bracketed notes, country prefixes, quality tags or punctuation. */
function normaliseName(name) {
    let s = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    s = s.toLowerCase();
    s = s.replace(/[\[(][^\])]*[\])]/g, ' ');                 // (AU), [HD]
    s = s.replace(/^\s*[a-z]{2,3}\s*[:|\-]\s+/, ' ');        // "AU: ", "UK | ", "US - "
    s = s.replace(/^\s*[a-z]{2,3}\s*[:|]/, ' ');             // "AU:Seven"
    s = s.replace(/&/g, ' and ');
    s = s.replace(/[^a-z0-9]+/g, ' ');
    s = s.replace(TAGS, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

const tokensOf = (norm) => new Set(norm.split(' ').filter(Boolean));

function bigrams(norm) {
    const s = norm.replace(/ /g, '');
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
}

function dice(a, b) {
    if (!a.size && !b.size) return 0;
    let common = 0;
    for (const t of a) if (b.has(t)) common++;
    return (2 * common) / (a.size + b.size);
}

function bigramDice(a, b) {
    let total = 0, common = 0;
    for (const n of a.values()) total += n;
    for (const n of b.values()) total += n;
    if (!total) return 0;
    for (const [g, n] of a) if (b.has(g)) common += Math.min(n, b.get(g));
    return (2 * common) / total;
}

function prepare(name) {
    const norm = normaliseName(name);
    return { norm, tokens: tokensOf(norm), grams: bigrams(norm) };
}

/** 0..1, two decimals. */
function similarity(a, b) {
    const pa = typeof a === 'string' ? prepare(a) : a;
    const pb = typeof b === 'string' ? prepare(b) : b;
    if (!pa.norm || !pb.norm) return 0;
    if (pa.norm === pb.norm) return 1;
    const score = 0.6 * dice(pa.tokens, pb.tokens) + 0.4 * bigramDice(pa.grams, pb.grams);
    return Math.round(Math.min(0.99, score) * 100) / 100;
}

// ---- EPG channels -----------------------------------------------------------

/** EPG channel ids with programmes overlapping [now, now + 24 h). */
function channelsWithProgrammes(now = Date.now()) {
    const rows = getDb().prepare(`
        SELECT DISTINCT channel_id FROM epg_live
        WHERE start_time > ? AND end_time > ? AND start_time < ?
    `).all(now - DAY_MS, now, now + DAY_MS);
    return new Set(rows.map(r => r.channel_id));
}

/** The EPG's channel list (one row per EPG channel id), prepared for scoring. */
function epgChannels(withProgrammes) {
    const rows = getDb().prepare(`
        SELECT item_id, name FROM playlist_items WHERE type = 'epg_channel' ORDER BY source_id, rowid
    `).all();
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        if (seen.has(r.item_id)) continue;
        seen.add(r.item_id);
        if (withProgrammes && !withProgrammes.has(r.item_id)) continue;
        out.push({ tvgId: r.item_id, name: r.name || r.item_id, ...prepare(r.name || r.item_id) });
    }
    return out;
}

/** Candidates sharing at least one token (or, failing that, all of them), best first. */
function rankCandidates(name, pool, index, limit = 5) {
    const target = prepare(name);
    if (!target.norm) return [];
    let pickFrom = pool;
    if (index && target.tokens.size) {
        const hit = new Set();
        for (const t of target.tokens) for (const i of (index.get(t) || [])) hit.add(i);
        pickFrom = hit.size ? [...hit].map(i => pool[i]) : pool;
    }
    return pickFrom
        .map(c => ({ tvgId: c.tvgId, name: c.name, score: similarity(target, c) }))
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
}

function tokenIndex(pool) {
    const index = new Map();
    pool.forEach((c, i) => {
        for (const t of c.tokens) {
            if (!index.has(t)) index.set(t, []);
            index.get(t).push(i);
        }
    });
    return index;
}

/**
 * Visible channels (one per identity) whose effective tvg-id has no programmes
 * in the next 24 hours, each with its best candidates.
 */
function unmatched({ now = Date.now(), limit = 500, search = '' } = {}) {
    const { VISIBLE_SQL, CHANNEL_KEY_SQL } = require('./channelNumbers');
    const rows = getDb().prepare(`
        SELECT p.source_id, p.item_id, p.stable_id, p.name, p.category_id, p.tvg_id, ${CHANNEL_KEY_SQL} AS channel_key
        FROM playlist_items p
        WHERE ${VISIBLE_SQL}
        ORDER BY COALESCE(p.sort_order, 999999999) ASC, p.name ASC, p.id ASC
    `).all();
    const live = channelsWithProgrammes(now);
    const pool = epgChannels(live);
    const index = tokenIndex(pool);
    const q = String(search || '').trim().toLowerCase();

    const seen = new Set();
    const out = [];
    let total = 0;
    for (const r of rows) {
        const k = `${r.source_id}:${r.channel_key}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const mapped = overrideFor(r.source_id, r.stable_id, r.item_id);
        const tvgId = mapped || r.tvg_id || null;
        if (tvgId && live.has(tvgId)) continue;
        if (q && !String(r.name || '').toLowerCase().includes(q)) continue;
        total++;
        if (out.length >= limit) continue;
        out.push({
            sourceId: r.source_id,
            id: r.item_id,
            stableId: r.stable_id || null,
            name: r.name,
            category: r.category_id,
            tvgId,
            mapped: !!mapped,
            candidates: rankCandidates(r.name, pool, index)
        });
    }
    return { total, channels: out };
}

/** The EPG channel list searched by name or id (the panel's search box), best first. */
function searchEpgChannels(query, { now = Date.now(), limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const live = channelsWithProgrammes(now);
    const lower = q.toLowerCase();
    const target = prepare(q);
    return epgChannels(null)
        .map(c => {
            const direct = c.name.toLowerCase().includes(lower) || c.tvgId.toLowerCase().includes(lower);
            const score = Math.max(direct ? 0.5 : 0, similarity(target, c));
            return { tvgId: c.tvgId, name: c.name, score, hasProgrammes: live.has(c.tvgId) };
        })
        .filter(c => c.score > 0.2)
        .sort((a, b) => (b.hasProgrammes - a.hasProgrammes) || b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
}

/** Every mapping, with the channel's current name. */
function listMappings() {
    return getDb().prepare(`
        SELECT m.source_id, m.channel_key, m.tvg_id, m.updated_at,
               (SELECT p.name FROM playlist_items p WHERE p.source_id = m.source_id AND p.type = 'live'
                  AND COALESCE(p.stable_id, p.item_id) = m.channel_key ORDER BY p.sort_order LIMIT 1) AS name,
               (SELECT p.item_id FROM playlist_items p WHERE p.source_id = m.source_id AND p.type = 'live'
                  AND COALESCE(p.stable_id, p.item_id) = m.channel_key ORDER BY p.sort_order LIMIT 1) AS item_id
        FROM epg_mappings m ORDER BY name
    `).all().map(r => ({
        sourceId: r.source_id, id: r.item_id || null, name: r.name || null, tvgId: r.tvg_id, updatedAt: r.updated_at
    }));
}

/**
 * Store (or, with an empty tvgId, remove) the admin's mapping for a channel.
 * Returns null when the channel is not in the playlist.
 */
function setMapping(sourceId, channelId, tvgId) {
    const db = getDb();
    const stripped = String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
    const row = db.prepare(`
        SELECT COALESCE(stable_id, item_id) AS channel_key FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
    `).get(sourceId, stripped);
    if (!row) return null;
    const value = tvgId === null || tvgId === undefined ? '' : String(tvgId).trim();
    if (value) {
        db.prepare(`
            INSERT INTO epg_mappings (source_id, channel_key, tvg_id, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_id, channel_key) DO UPDATE SET tvg_id = excluded.tvg_id, updated_at = excluded.updated_at
        `).run(sourceId, row.channel_key, value, Date.now());
    } else {
        db.prepare('DELETE FROM epg_mappings WHERE source_id = ? AND channel_key = ?').run(sourceId, row.channel_key);
    }
    cache = null;
    bumpLibraryRev();
    return { tvgId: value || null };
}

function reset() { cache = null; }

module.exports = {
    effectiveTvgId, overrideFor, unmatched, searchEpgChannels, listMappings, setMapping,
    normaliseName, similarity, reset, MAX_TVG_ID
};
