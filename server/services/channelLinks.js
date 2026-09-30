/**
 * The channel linker (0171, multi-provider brief 2.4).
 *
 * Every visible live channel of the primary is linked to the same channel at each backup
 * provider (and to the primary's own "(Backup)" feed of it, a *sibling*), so a play that fails
 * on the primary can go somewhere else (P6). Links live in `channel_links`, keyed by the
 * primary channel's identity (source + COALESCE(stable_id, item_id), the favourites' key).
 *
 * What the providers' lists look like (fixtures in test/fixtures/providers/, 30 Sept):
 *   - EPGenius tvg-ids are shared across providers (`skysport1.nz`), except that Strong8K adds
 *     `.alt` (`FoxSports503.alt.au`) and a state-city prefix (`NSW-SydneyFoxFooty.au`).
 *   - A raw Xtream list's epg ids are its own (`FoxSports5.au` for Fox Sports 505).
 *   - Names alone match the wrong country ("ABC" is also US ABC, "beIN Sports 1" also French
 *     beIN), so a name match needs the same, known region on both sides.
 *   - AU Fox channels are the same by number (Fox Cricket 501 = FOX SPORTS 501 HD).
 *   - Event/PPV slots ("NBA 06 :", "AFL TV 01 | ...") are a different game per provider: never linked.
 *
 * Matching, per primary channel and backup provider (candidatesFor):
 *   1. exact: the tvg-id key (backup: overlay id or its own) is equal and the regions agree or one
 *      is unknown -> `auto` (used at once). `pending` instead when the two names carry different
 *      small numbers ("Sky Sports 1" vs "SKY SPORTS +" under one id: EPGenius does that).
 *   2. number: both names have fox/kayo and the same 5xx number, same region -> `pending`.
 *   3. name: equal name keys, same known region -> `pending`.
 *   Ranked: auto first, then exact > number > name, same quality class, equal name, same city,
 *   HD over UHD over SD, the shorter name. Up to 3 per backup; failover uses rank 1 only.
 *
 * Relinking recomputes `auto`/`pending` rows and keeps the admin's decisions (`approved`,
 * `rejected`, `manual`), which rank ahead of computed ones. A kept row whose stream has gone is
 * `broken` (and comes back to what it was if the stream returns); a rejected one is dropped.
 *
 * Nothing here returns a stream URL or a login: `url_data` is never read.
 */
const { getDb } = require('../db/sqlite');
const { VISIBLE_SQL, NUMBER_JOIN } = require('./channelNumbers');
const providerFields = require('./providerFields');

const MAX_RANK = 3;
const KEPT = new Set(['approved', 'rejected', 'manual', 'broken']);
const USABLE = new Set(['auto', 'approved', 'manual']);
const STATUSES = ['auto', 'pending', 'approved', 'manual', 'rejected', 'broken'];

// ---- normalisation (pure) ----------------------------------------------------

// Country codes a prefix, a flag or a tvg-id suffix may name. GB is folded into UK.
const COUNTRIES = new Set(('au nz uk gb us ca ie fr de es it pt nl be ch at se no dk fi pl sg in my za ar br mx ' +
    'ph hk cl pk ae qa sa tr gr ro jp kr cn tw th id vn ng ke il ru ua cz hu hr rs si sk bg lb eg ma co pe').split(' '));
// A country in brackets anywhere in a name ("Sky Sports Cricket (UK)"): only the ones that are
// never also a region abbreviation ("9Gem (Sa)" is South Australia).
const BRACKET_COUNTRIES = new Set(['au', 'nz', 'uk', 'us', 'ca', 'ie']);
const AU_STATES = 'nsw|vic|qld|sa|wa|tas|act|nt';
const AU_CITIES = ['sydney', 'melbourne', 'brisbane', 'adelaide', 'perth', 'canberra', 'hobart', 'darwin',
    'goldcoast', 'lismore', 'newcastle'];
// Words a name key drops: AU feed cities and states, and the 9Now platform name ("AU: 9NOW 9GO!").
const NOISE_WORDS = new Set([...AU_CITIES, 'national', 'nsw', 'vic', 'qld', 'tas', '9now']);
const STATE_CITY_PREFIX = new RegExp(`^(?:${AU_STATES})-(?:${AU_CITIES.join('|')})`);
const QUALITY_WORD = /^(?:uhd|fhd|hd|sd|4k|8k|hevc|hdr|raw|ganja|h26[45]|backup|bk|\d{3,4}[pi]\d{0,3}|\d{2,3}fps)$/;
// A region prefix: `AU:`, `AU|`, `AU |`, `(AU)`, and Dream4K's `|AU|`, `||AU||`, `|AU||`, `|AU|  `, `|✪ AU|`.
const PREFIX = /^[\s|(\[✪]*([a-z]{2})\s*[|:)\]]+\s*/;

const country = (code) => {
    const c = String(code || '').toLowerCase();
    if (!COUNTRIES.has(c)) return null;
    return c === 'gb' ? 'UK' : c.toUpperCase();
};

/** Lower case, compatibility forms (ᵁᴴᴰ -> UHD, ⁽ᴮᴷ⁾ -> (BK)), no accents. */
function fold(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The comparable form of a tvg-id: lower case, `.alt` and a `<state>-<city>` prefix removed, no
 * punctuation in the body, the country suffix kept. Null when there is no suffix to trust
 * (`447013`, `dummy-857775`, `ABC Kids`).
 */
function tvgKey(tvgId) {
    const s = fold(tvgId).trim();
    if (!s || s.includes('dummy')) return null;
    const m = /^(.+)\.([a-z]{2,3}\d?)$/.exec(s);
    if (!m || m[2] === 'epg') return null;
    // `TNT.Sports.1.HD.uk` (a raw list's form) -> `tntsports1.uk`: a dotted quality tag is not the id.
    let body = m[1].replace(/\.alt$/, '').replace(/\.(?:hd|fhd|uhd|sd|4k)$/, '').replace(STATE_CITY_PREFIX, '');
    body = body.replace(/[^a-z0-9]+/g, '');
    return body ? `${body}.${m[2]}` : null;
}

/** The region a tvg-id's suffix names (`.au` -> AU, `.us2` -> US), else null. */
function tvgRegion(tvgId) {
    const m = /\.([a-z]{2})\d?$/.exec(fold(tvgId).trim());
    return m ? country(m[1]) : null;
}

/** A flag emoji's country (🇦🇺 -> AU), else null. */
function flagRegion(text) {
    const m = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u.exec(String(text || ''));
    if (!m) return null;
    const letter = ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 97);
    return country(letter(m[1]) + letter(m[2]));
}

/**
 * A channel's region: a `XX|`/`XX:`/`(XX)` prefix on the name, a country in brackets in the name,
 * the tvg-id's suffix, a prefix on the group (`UK| Sky Sports`, `AU SPORTS`), a flag in the group;
 * null when none. The group comes last: providers file channels by audience (Strong8K's
 * "🇦🇺 TV Guide" lists NZ's Sky Sport and a Singapore beIN), which is not where they are from.
 */
function regionOf({ name, group, tvgId } = {}) {
    const n = fold(name);
    let m = PREFIX.exec(n);
    if (m && country(m[1])) return country(m[1]);
    for (const b of n.matchAll(/[(\[]\s*([a-z]{2})\s*[)\]]/g)) {
        if (BRACKET_COUNTRIES.has(b[1])) return country(b[1]);
    }
    const fromTvg = tvgRegion(tvgId);
    if (fromTvg) return fromTvg;
    const g = String(group || '');
    m = PREFIX.exec(fold(g)) || /^([A-Z]{2})\s/.exec(g.trim());
    if (m && country(m[1])) return country(m[1]);
    return flagRegion(g);
}

/** The words of a name that identify the channel (see nameKey). */
function nameTokens(name) {
    let s = fold(name);
    for (let i = 0; i < 2; i++) {
        const m = PREFIX.exec(s);
        if (!m || !country(m[1])) break;
        s = s.slice(m[0].length);
    }
    s = s.replace(/^\s*kayo\s*-?\s*/, ' ')
        .replace(/[(\[{][^)\]}]*[)\]}]/g, ' ')
        .replace(/\b(4k|8k|uhd|hd)\+/g, '$1 ')
        .replace(/&/g, ' and ')
        .replace(/\+/g, ' plus ')
        .replace(/\bgold[\s-]?coast\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ');
    const tokens = s.split(' ').filter(t => t && !QUALITY_WORD.test(t) && !NOISE_WORDS.has(t));
    if (tokens[0] === 'channel' && /^\d/.test(tokens[1] || '')) tokens.shift();
    return tokens;
}

/**
 * The comparable form of a name: lower case, no region prefix, bracketed text, quality tags
 * (UHD, 1080p50, ᴿᴬᵂ...), "Kayo -", AU city words or punctuation, spaces removed ("7 Flix" =
 * "7FLIX"). Digits are kept: "Sky Sport 1" is not "Sky Sport 2".
 */
function nameKey(name) {
    return nameTokens(name).join('');
}

/**
 * The comparable form of a *raw* provider name (P9): case, whitespace runs and the country-prefix
 * separator only (`AU:`, `AU|`, `|AU|`, `||AU||`, `AU |` -> `au|`). Superscript tags, brackets,
 * qualities and everything else are kept: two providers of one upstream list a channel under the
 * same raw name character for character, so nothing needs to be guessed.
 */
function rawNameKey(name) {
    let s = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const m = /^[\s|✪]*([a-z]{2})\s*[|:]+\s*/.exec(s);
    if (m && country(m[1])) s = `${m[1]}|${s.slice(m[0].length)}`;
    return s;
}

/** A raw epg_channel_id compared case-insensitively; null for none or a placeholder. */
function rawEpgKey(epg) {
    const s = String(epg || '').trim().toLowerCase();
    return !s || s.includes('dummy') ? null : s;
}

/**
 * A raw name with any leading label ("NOW:", "VIP:", "UK|", not only a country) dropped, then
 * nameTokens() with a trailing plural "s" removed per word: "VIP: SKY SPORTS ACTION ᴿᴬᵂ" and
 * "UK| SKY SPORT ACTION HD" agree, "SPORTSNET 360" and "SPORTSMAN" do not (0179).
 */
function looseRawKey(name) {
    const s = String(name || '').replace(/^[\s|✪]*[A-Za-z0-9]{2,5}\s*[|:]+\s*/, '');
    return nameTokens(s).map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)).join('');
}

/** What the raw rules compare for one channel's raw row ({ name, epg, category }), or null. */
function describeRaw(raw) {
    if (!raw || !raw.name) return null;
    return {
        nameKey: rawNameKey(raw.name),
        // The loose name (prefixes, quality tags and punctuation gone): what a raw-epg match must
        // also agree on before it is used unreviewed (0179).
        looseKey: looseRawKey(raw.name),
        epg: rawEpgKey(raw.epg),
        region: regionOf({ name: raw.name, group: raw.category, tvgId: raw.epg }),
        event: isEventSlot({ name: raw.name, group: raw.category })
    };
}

/** 'uhd' (UHD/4K/8K/2160/3840/HDR), 'hd', 'sd' or 'unknown', from the whole name. */
function qualityOf(name) {
    const s = fold(name);
    if (/\b(?:uhd|4k|8k|2160[pi]?\d*|3840[pi]?\d*|hdr)\b/.test(s)) return 'uhd';
    if (/\b(?:fhd|hd|1080[pi]?\d*|720[pi]?\d*|hevc)\b/.test(s)) return 'hd';
    if (/\b(?:sd|576[pi]?\d*|540[pi]?\d*|480[pi]?\d*|360[pi]?\d*)\b/.test(s)) return 'sd';
    return 'unknown';
}

/** A "(Backup)" / "[Backup]" / "(BK)" feed: the D5 sibling marker. */
function isSibling(name) {
    return /[(\[]\s*(?:backup|bk)\s*[)\]]/.test(fold(name));
}

/** A `### SECTION ###` line or an empty name: nothing to watch. */
function isPlaceholder(name) {
    const s = String(name || '').trim();
    return !s || /^#{2,}/.test(s) || /#{2,}$/.test(s) || /^dummy category$/i.test(s);
}

const EVENT_WORDS = /\bppv\b|\bpackage\b|league pass|sunday ticket|espn\s*\+|\bflo\b|flosports|\bstan\b|\bdazn\b|24\/7|\breplays?\b|no event|no game|red button/;

/**
 * An event/PPV slot, never linked: the same name carries a different game at each provider.
 * Placeholders count as slots too. "Main Event" is a channel, not an event.
 */
function isEventSlot({ name, group } = {}) {
    if (isPlaceholder(name)) return true;
    const g = fold(group);
    if (EVENT_WORDS.test(g) || /\bevents?\b/.test(g)) return true;
    const n = fold(name).trim();
    return EVENT_WORDS.test(n)
        || /(?<!main )\bevents?\b/.test(n)
        || /^[a-z0-9 ]+ \d{1,3} ?[:|]/.test(n)       // "NBA 06 :", "AFL TV 01 | ..."
        || /^(?:next|ended)\s*\|/.test(n)
        || /(?:^|\s):/.test(n)                        // ":Sky Sports UK 12", "... :NBA 01"
        || /\(\d{4}-\d{2}-\d{2}/.test(n)              // "(2026-09-29 22:00:00)"
        || /\s(?:vs?\.?|@)\s/.test(n);                // "Bath v Exeter", "Falcons @ Packers"
}

/** The AU Fox channel number (500-599) of a name with "fox" or "kayo" in it, else null. */
function foxNumber(name) {
    const s = fold(name);
    if (!/\b(?:fox|kayo)\b/.test(s)) return null;
    const m = /(?:^|[^0-9])(5\d\d)(?![0-9])/.exec(s);
    return m ? Number(m[1]) : null;
}

// The city (or "national") a feed is for: a tie-break between an AU network's regional feeds.
const citiesOf = (...texts) => {
    const s = texts.map(fold).join(' ').replace(/[^a-z]+/g, '');
    return [...AU_CITIES, 'national'].filter(c => s.includes(c));
};

// What tells two variants of a network apart: the small numbers ("sky sports 1" -> "1") and the
// variant words ("MSG Plus", "Willow Cricket Extra"). Channel numbers (>= 100, "Fox Sports News
// 500") are labels and are left out. Two names under one tvg-id whose variants differ are not
// linked automatically: EPGenius puts `skysports1.uk` on "SKY SPORTS +" too.
const VARIANT_WORDS = new Set(['plus', 'extra', 'xtra', 'east', 'west', 'alternate']);
const digitsOf = tokens => [
    ...tokens.flatMap(t => t.match(/\d+/g) || []).filter(d => Number(d) < 100),
    ...tokens.filter(t => VARIANT_WORDS.has(t))
].sort().join(',');

/**
 * Everything the matcher compares, for one channel of either side. `overlayTvgId` is a backup's
 * EPGenius id (it wins over its own for the region).
 */
function describe({ name, group, tvgId, overlayTvgId, raw } = {}) {
    const tokens = nameTokens(name);
    return {
        name: String(name || ''),
        tvgKey: tvgKey(tvgId),
        overlayKey: tvgKey(overlayTvgId),
        region: regionOf({ name, group, tvgId: overlayTvgId || tvgId }),
        quality: qualityOf(name),
        event: isEventSlot({ name, group }),
        sibling: isSibling(name),
        nameKey: tokens.join(''),
        digits: digitsOf(tokens),
        fox: foxNumber(name),
        cities: citiesOf(name, overlayTvgId || tvgId),
        raw: describeRaw(raw)
    };
}

/** Buckets of a backup's channels by tvg key, region + name key and region + Fox number. */
function indexBackup(rows) {
    const idx = { byTvg: new Map(), byName: new Map(), byFox: new Map(), byRawName: new Map(), byRawEpg: new Map() };
    const push = (map, key, row) => { const list = map.get(key); if (list) list.push(row); else map.set(key, [row]); };
    for (const r of rows) {
        const f = r.f || (r.f = describe(r));
        if (f.event) continue;
        if (f.tvgKey) push(idx.byTvg, f.tvgKey, r);
        if (f.overlayKey && f.overlayKey !== f.tvgKey) push(idx.byTvg, f.overlayKey, r);
        if (f.region && f.nameKey) push(idx.byName, `${f.region}|${f.nameKey}`, r);
        if (f.region && f.fox) push(idx.byFox, `${f.region}|${f.fox}`, r);
        if (f.raw && !f.raw.event) {
            if (f.raw.region) push(idx.byRawName, `${f.raw.region}|${f.raw.nameKey}`, r);
            if (f.raw.epg) push(idx.byRawEpg, f.raw.epg, r);
        }
    }
    return idx;
}

const METHOD_ORDER = { 'raw-name': 0, 'raw-epg': 1, exact: 2, number: 3, name: 4 };
// HD over SD; an unmarked stream is usually HD, so it comes before UHD for a non-UHD channel.
const QUALITY_ORDER = { hd: 0, unknown: 1, uhd: 2, sd: 3 };

function scoreOf(c) {
    const base = c.method === 'raw-name' ? 95 : c.method === 'raw-epg' ? (c.status === 'auto' ? 92 : 77) : c.method === 'exact' ? (c.status === 'auto' ? 90 : 75) : c.method === 'number' ? 70 : 60;
    return Math.min(100, base + (c.sameQuality ? 5 : 0) + (c.sameName ? 3 : 0) + (c.sameCity ? 2 : 0));
}

function compareCandidates(a, b) {
    return (a.status === 'auto' ? 0 : 1) - (b.status === 'auto' ? 0 : 1)
        || METHOD_ORDER[a.method] - METHOD_ORDER[b.method]
        || (b.sameQuality ? 1 : 0) - (a.sameQuality ? 1 : 0)
        || (b.sameName ? 1 : 0) - (a.sameName ? 1 : 0)
        || (b.sameCity ? 1 : 0) - (a.sameCity ? 1 : 0)
        || QUALITY_ORDER[a.row.f.quality] - QUALITY_ORDER[b.row.f.quality]
        || a.row.f.name.length - b.row.f.name.length
        || String(a.streamId).localeCompare(String(b.streamId), 'en', { numeric: true });
}

/**
 * The ranked candidates for one primary channel at one backup: [{ streamId, method, status,
 * score, row }], best first (not cut to MAX_RANK). `backup` is indexBackup(rows) or the rows.
 * `primary` is describe()'d (or has name/group/tvgId to describe).
 */
function candidatesFor(primary, backup) {
    const p = primary && primary.nameKey !== undefined && primary.digits !== undefined ? primary : describe(primary);
    if (p.event) return [];
    const idx = Array.isArray(backup) ? indexBackup(backup) : backup;
    const found = new Map();
    const add = (row, method, status) => {
        const streamId = String(row.streamId ?? row.stream_id);
        const had = found.get(streamId);
        if (had && (had.status === 'auto' || status !== 'auto')) return;
        const f = row.f;
        const c = {
            streamId, method, status, row,
            sameQuality: p.quality !== 'unknown' && f.quality === p.quality,
            sameName: Boolean(p.nameKey) && f.nameKey === p.nameKey,
            sameCity: p.cities.some(x => f.cities.includes(x))
        };
        c.score = scoreOf(c);
        found.set(streamId, c);
    };
    // The raw rules (P9) come first: the provider's own names and ids, compared raw with raw.
    if (p.raw && !p.raw.event && !p.event) {
        if (p.raw.region) {
            for (const row of idx.byRawName.get(`${p.raw.region}|${p.raw.nameKey}`) || []) add(row, 'raw-name', 'auto');
        }
        if (p.raw.epg) {
            for (const row of idx.byRawEpg.get(p.raw.epg) || []) {
                if (p.region && row.f.region && p.region !== row.f.region) continue;
                if (p.raw.region && row.f.raw.region && p.raw.region !== row.f.raw.region) continue;
                // 0179: a shared raw epg id alone is not enough to play a channel unreviewed - a
                // provider's data error puts one id on two channels (Dream4K lists "SPORTSMAN" under
                // sportsnet360.ca). Auto only when the loose names agree too; otherwise pending.
                const namesAgree = Boolean(p.raw.looseKey) && (p.raw.looseKey === row.f.raw.looseKey || p.nameKey === row.f.nameKey);
                add(row, 'raw-epg', row.f.digits === p.digits && namesAgree ? 'auto' : 'pending');
            }
        }
    }
    if (p.tvgKey) {
        for (const row of idx.byTvg.get(p.tvgKey) || []) {
            if (p.region && row.f.region && p.region !== row.f.region) continue;
            add(row, 'exact', row.f.digits === p.digits ? 'auto' : 'pending');
        }
    }
    if (p.fox && p.region) {
        for (const row of idx.byFox.get(`${p.region}|${p.fox}`) || []) add(row, 'number', 'pending');
    }
    if (p.nameKey && p.region) {
        for (const row of idx.byName.get(`${p.region}|${p.nameKey}`) || []) add(row, 'name', 'pending');
    }
    return [...found.values()].sort(compareCandidates);
}

/** Siblings of one primary channel among its provider's "(Backup)" feeds, best first. */
function siblingCandidatesFor(p, pool) {
    if (p.event || p.sibling) return [];
    const out = [];
    for (const s of pool) {
        if (s.key === p.key) continue;
        const byId = p.tvgKey && s.f.tvgKey === p.tvgKey;
        const byName = !byId && p.nameKey && s.f.nameKey === p.nameKey && (s.f.region || '') === (p.region || '');
        if (byId || byName) out.push({ streamId: s.key, method: 'sibling', status: 'auto', row: s, sameQuality: s.f.quality === p.quality });
    }
    return out.sort((a, b) => (b.sameQuality ? 1 : 0) - (a.sameQuality ? 1 : 0)
        || a.row.f.name.length - b.row.f.name.length
        || String(a.streamId).localeCompare(String(b.streamId), 'en', { numeric: true }))
        .map(c => ({ ...c, score: c.sameQuality ? 100 : 95 }));
}

/**
 * What one (primary channel, provider) pair's rows should be after a relink. `existing` are its
 * rows now; `fresh` the computed candidates; `exists(streamId)` whether a stream is still listed.
 * Kept decisions first (the newest first), then computed rows up to MAX_RANK, then broken and
 * rejected rows. Returns rows without rank; the order is the rank.
 */
function planLinks(existing, fresh, exists, now) {
    const kept = [];
    for (const r of existing) {
        if (!KEPT.has(r.status)) continue;
        const there = exists(r.backup_stream_id);
        if (r.status === 'rejected') { if (there) kept.push(r); continue; }
        if (r.status === 'broken') {
            kept.push(there ? { ...r, status: r.method === 'manual' ? 'manual' : 'approved', updated_at: now } : r);
        } else {
            kept.push(there ? r : { ...r, status: 'broken', updated_at: now });
        }
    }
    const good = kept.filter(r => r.status === 'approved' || r.status === 'manual')
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || a.rank - b.rank);
    const taken = new Set(kept.map(r => r.backup_stream_id));
    const previous = new Map(existing.filter(r => !KEPT.has(r.status)).map(r => [r.backup_stream_id, r]));
    const computed = fresh.filter(c => !taken.has(c.streamId)).slice(0, Math.max(0, MAX_RANK - good.length)).map(c => {
        const old = previous.get(c.streamId);
        const same = old && old.method === c.method && old.status === c.status;
        return {
            id: old ? old.id : null, backup_stream_id: c.streamId, method: c.method, status: c.status,
            score: c.score, updated_at: same ? old.updated_at : now
        };
    });
    const tail = kept.filter(r => r.status === 'broken' || r.status === 'rejected').sort((a, b) => a.rank - b.rank);
    return [...good, ...computed, ...tail];
}

// ---- the store ---------------------------------------------------------------

const tick = () => new Promise(resolve => setImmediate(resolve));

function providers() {
    const rows = getDb().prepare('SELECT data FROM app_sources ORDER BY id').all();
    const all = rows.map(r => { try { return providerFields.withDefaults(JSON.parse(r.data)); } catch { return null; } })
        .filter(s => s && s.type !== 'epg');
    return {
        all,
        primaries: all.filter(s => s.role !== 'backup'),
        backups: all.filter(s => s.role === 'backup')
    };
}

/** The provider's stream id in a stable id (`s1562537` -> `1562537`), else null. */
const streamIdOf = stableId => { const m = /^s(\d+)$/.exec(String(stableId || '')); return m ? m[1] : null; };

/** The visible live channels of a primary source, one per identity, describe()'d. */
function visibleChannels(sourceId) {
    const epgMapping = require('./epgMapping');
    const rows = getDb().prepare(`
        SELECT p.source_id, p.item_id, p.stable_id, COALESCE(p.stable_id, p.item_id) AS channel_key,
               p.name, p.tvg_id, p.category_id, c.name AS category_name, n.number
        FROM playlist_items p
        LEFT JOIN categories c ON c.source_id = p.source_id AND c.type = p.type AND c.category_id = p.category_id
        ${NUMBER_JOIN}
        WHERE ${VISIBLE_SQL} AND p.source_id = ?
        ORDER BY COALESCE(p.sort_order, 999999999), p.name, p.id
    `).all(sourceId);
    const rawMap = require('./rawChannels').loadMap(sourceId);
    const byKey = new Map();
    for (const r of rows) {
        const had = byKey.get(r.channel_key);
        if (had) { had.categoryIds.add(r.category_id); continue; }
        const tvgId = epgMapping.effectiveTvgId(r.source_id, r.stable_id, r.item_id, r.tvg_id);
        byKey.set(r.channel_key, {
            ...describe({ name: r.name, group: r.category_name, tvgId, raw: rawMap.get(streamIdOf(r.stable_id)) }),
            sourceId: r.source_id, key: r.channel_key, itemId: r.item_id, tvgId,
            categoryId: r.category_id, categoryName: r.category_name, number: r.number ?? null,
            categoryIds: new Set([r.category_id])
        });
    }
    return [...byKey.values()];
}

/** Rewrite every row of one provider (or one primary's siblings) in one transaction. */
function writeRows(where, params, rows) {
    const db = getDb();
    const insert = db.prepare(`
        INSERT INTO channel_links (id, primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
        VALUES (@id, @primary_source_id, @primary_key, @backup_source_id, @backup_stream_id, @method, @status, @rank, @score, @updated_at)
    `);
    db.transaction(() => {
        db.prepare(`DELETE FROM channel_links WHERE ${where}`).run(...params);
        for (const r of rows) insert.run(r);
    })();
}

const OUT_OF_PLAY = new Set(['broken', 'rejected']);

/**
 * [row, rank] in order: the candidates rank 1, 2, 3...; broken and rejected rows rank after
 * MAX_RANK (and after every candidate), so rank 1 is always a candidate when there is one.
 */
function rankedOrder(rows) {
    const live = rows.filter(r => !OUT_OF_PLAY.has(r.status));
    const out = rows.filter(r => OUT_OF_PLAY.has(r.status));
    const start = Math.max(live.length, MAX_RANK);
    return [...live.map((r, i) => [r, i + 1]), ...out.map((r, i) => [r, start + i + 1])];
}

/** Plan and write the links of one provider. `candidates(p)` gives a channel's fresh candidates. */
function commit({ where, params, backupSourceId, channels, candidates, exists, now }) {
    const existing = getDb().prepare(`SELECT * FROM channel_links WHERE ${where}`).all(...params);
    const byChannel = new Map();
    for (const r of existing) {
        const k = `${r.primary_source_id}\u0000${r.primary_key}`;
        if (!byChannel.has(k)) byChannel.set(k, []);
        byChannel.get(k).push(r);
    }
    const out = [];
    const counts = { auto: 0, pending: 0, approved: 0, manual: 0, rejected: 0, broken: 0 };
    const emit = (primarySourceId, primaryKey, planned) => rankedOrder(planned).forEach(([r, rank]) => {
        counts[r.status] = (counts[r.status] || 0) + 1;
        out.push({
            id: r.id ?? null, primary_source_id: primarySourceId, primary_key: primaryKey, backup_source_id: backupSourceId,
            backup_stream_id: r.backup_stream_id, method: r.method, status: r.status, rank,
            score: r.score ?? null, updated_at: r.updated_at ?? now
        });
    });
    for (const p of channels) {
        const k = `${p.sourceId}\u0000${p.key}`;
        emit(p.sourceId, p.key, planLinks(byChannel.get(k) || [], candidates(p), exists, now));
        byChannel.delete(k);
    }
    // Channels not visible now keep their decisions (a hidden category may come back).
    for (const rows of byChannel.values()) {
        emit(rows[0].primary_source_id, rows[0].primary_key, planLinks(rows, [], exists, now));
    }
    writeRows(where, params, out);
    return counts;
}

const CHUNK = 5000;

/** A backup's channels, describe()'d, with region/quality/is_event written back where they changed. */
async function loadBackup(sourceId) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT stream_id, name, category_name, tvg_id, overlay_tvg_id, region, quality, is_event
        FROM backup_channels WHERE source_id = ?
    `).all(sourceId);
    const rawMap = require('./rawChannels').loadMap(sourceId);
    const update = db.prepare('UPDATE backup_channels SET region = ?, quality = ?, is_event = ? WHERE source_id = ? AND stream_id = ?');
    for (let i = 0; i < rows.length; i += CHUNK) {
        const changed = [];
        for (const r of rows.slice(i, i + CHUNK)) {
            r.streamId = r.stream_id;
            r.f = describe({ name: r.name, group: r.category_name, tvgId: r.tvg_id, overlayTvgId: r.overlay_tvg_id, raw: rawMap.get(String(r.stream_id)) });
            const ev = r.f.event ? 1 : 0;
            if (r.region !== r.f.region || r.quality !== r.f.quality || r.is_event !== ev) changed.push(r);
        }
        if (changed.length) {
            db.transaction(() => { for (const r of changed) update.run(r.f.region, r.f.quality, r.f.event ? 1 : 0, sourceId, r.stream_id); })();
        }
        await tick();
    }
    return rows;
}

function allVisible(primaries) {
    return primaries.flatMap(s => visibleChannels(s.id));
}

async function linkBackup(backup, channels, now) {
    const rows = await loadBackup(backup.id);
    const idx = indexBackup(rows);
    const listed = new Set(rows.map(r => String(r.stream_id)));
    return commit({
        where: 'backup_source_id = ?', params: [backup.id], backupSourceId: backup.id, channels, now,
        candidates: p => candidatesFor(p, idx), exists: id => listed.has(String(id))
    });
}

function linkSiblings(primary, channels, now) {
    const db = getDb();
    const rows = db.prepare(`SELECT COALESCE(stable_id, item_id) AS channel_key, name, tvg_id, category_id FROM playlist_items WHERE source_id = ? AND type = 'live'`).all(primary.id);
    const keys = new Set(rows.map(r => r.channel_key));
    const groups = new Map(db.prepare(`SELECT category_id, name FROM categories WHERE source_id = ? AND type = 'live'`).all(primary.id)
        .map(c => [c.category_id, c.name]));
    const seen = new Set();
    const pool = [];
    for (const r of rows) {
        if (!/backup|bk|ᴮᴷ/i.test(r.name || '') || seen.has(r.channel_key)) continue;
        const f = describe({ name: r.name, group: groups.get(r.category_id), tvgId: r.tvg_id });
        if (!f.sibling || f.event) continue;
        seen.add(r.channel_key);
        pool.push({ key: r.channel_key, f });
    }
    const mine = channels.filter(c => c.sourceId === primary.id);
    return commit({
        where: 'backup_source_id = ? AND primary_source_id = ?', params: [primary.id, primary.id],
        backupSourceId: primary.id, channels: mine, now,
        candidates: p => siblingCandidatesFor(p, pool), exists: id => keys.has(id)
    });
}

/** Rows of providers that no longer exist, or are no longer what the row says they are. */
function dropStale(all) {
    const db = getDb();
    const primaryIds = new Set(all.filter(s => s.role !== 'backup').map(s => s.id));
    const backupIds = new Set(all.filter(s => s.role === 'backup').map(s => s.id));
    let n = 0;
    for (const r of db.prepare('SELECT DISTINCT primary_source_id, backup_source_id FROM channel_links').all()) {
        const sibling = r.primary_source_id === r.backup_source_id;
        const ok = primaryIds.has(r.primary_source_id) && (sibling || backupIds.has(r.backup_source_id));
        if (!ok) n += db.prepare('DELETE FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ?').run(r.primary_source_id, r.backup_source_id).changes;
    }
    return n;
}

let chain = Promise.resolve();
/** Relinks run one at a time: two syncs finishing together must not interleave their writes. */
function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
}

async function relink(onlyBackupId) {
    const started = Date.now();
    const { all, primaries, backups } = providers();
    dropStale(all);
    // With no backup provider nothing is linked: everything behaves as before (brief rule 4).
    const targets = backups.filter(b => b.enabled && (onlyBackupId == null || b.id === Number(onlyBackupId)));
    if (!backups.some(b => b.enabled) || (onlyBackupId != null && !targets.length)) return { skipped: true };
    const now = Date.now();
    const channels = allVisible(primaries.filter(p => p.enabled));
    const result = { channels: channels.length, siblings: {}, backups: {} };
    for (const p of primaries.filter(x => x.enabled)) result.siblings[p.id] = linkSiblings(p, channels, now);
    for (const b of targets) {
        await tick();
        result.backups[b.id] = await linkBackup(b, channels, now);
    }
    result.ms = Date.now() - started;
    const summary = Object.entries(result.backups).map(([id, c]) => `${id}: ${c.auto} auto, ${c.pending} pending`).join('; ');
    console.log(`[Links] Relinked ${channels.length} channels (${summary || 'siblings only'}) in ${result.ms} ms`);
    return result;
}

/** Relink one backup provider (after its sync), and the primaries' siblings. */
function relinkSource(backupSourceId) {
    return serial(() => relink(backupSourceId));
}

/** Relink every enabled backup provider and the siblings (after a primary sync). */
function relinkAll() {
    return serial(() => relink(null));
}

/** Every row of a deleted source, on either side. */
function removeFor(sourceId) {
    return getDb().prepare('DELETE FROM channel_links WHERE primary_source_id = ? OR backup_source_id = ?').run(sourceId, sourceId).changes;
}

/**
 * The links P6's failover may use for a primary channel: rank 1 of each provider with status
 * auto/approved/manual, siblings first, then enabled backups by `priority` (then id).
 * [{ backupSourceId, streamId, method }]; streamId is the sibling's identity for a sibling.
 */
function usableLinks(primarySourceId, primaryKey) {
    const rows = getDb().prepare(`
        SELECT backup_source_id, backup_stream_id, method, status FROM channel_links
        WHERE primary_source_id = ? AND primary_key = ? AND rank = 1
    `).all(Number(primarySourceId), String(primaryKey)).filter(r => USABLE.has(r.status));
    if (!rows.length) return [];
    const { backups } = providers();
    const order = new Map(backups.filter(b => b.enabled)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.id - b.id)
        .map((b, i) => [b.id, i]));
    const sibling = r => r.backup_source_id === Number(primarySourceId);
    return rows.filter(r => sibling(r) || order.has(r.backup_source_id))
        .sort((a, b) => (sibling(b) ? 1 : 0) - (sibling(a) ? 1 : 0) || (order.get(a.backup_source_id) ?? -1) - (order.get(b.backup_source_id) ?? -1))
        .map(r => ({ backupSourceId: r.backup_source_id, streamId: r.backup_stream_id, method: r.method }));
}

// ---- the admin API's side (routes/links.js) ----------------------------------

/** Re-rank one (channel, provider) after a decision: kept decisions first, as a relink would. */
function rerank(primarySourceId, primaryKey, backupSourceId, now = Date.now()) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM channel_links WHERE primary_source_id = ? AND primary_key = ? AND backup_source_id = ?')
        .all(primarySourceId, primaryKey, backupSourceId);
    const group = s => (s === 'approved' || s === 'manual') ? 0 : s === 'auto' ? 1 : s === 'pending' ? 2 : 3;
    rows.sort((a, b) => group(a.status) - group(b.status)
        || (group(a.status) === 0 ? (b.updated_at || 0) - (a.updated_at || 0) : 0) || a.rank - b.rank);
    const set = db.prepare('UPDATE channel_links SET rank = ? WHERE id = ?');
    db.transaction(() => {
        rows.forEach((r, i) => set.run(-(i + 1), r.id));
        for (const [r, rank] of rankedOrder(rows)) set.run(rank, r.id);
    })();
    return rows.length;
}

function linkById(id) {
    return getDb().prepare('SELECT * FROM channel_links WHERE id = ?').get(Number(id)) || null;
}

/**
 * The admin's decision on one link: 'approved', 'rejected', or 'pending' (undo: a manual link is
 * removed, anything else waits for the next relink to be recomputed). Returns the row or null.
 */
function setStatus(id, status, now = Date.now()) {
    const row = linkById(id);
    if (!row) return null;
    const db = getDb();
    if (status === 'pending' && row.method === 'manual') {
        db.prepare('DELETE FROM channel_links WHERE id = ?').run(row.id);
    } else {
        db.prepare('UPDATE channel_links SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id);
    }
    rerank(row.primary_source_id, row.primary_key, row.backup_source_id, now);
    return linkById(row.id) || { ...row, status: 'removed' };
}

/** The primary channel of this identity (any row, hidden or not), or null. */
function primaryChannel(primarySourceId, primaryKey) {
    return getDb().prepare(`SELECT source_id, item_id, name FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND COALESCE(stable_id, item_id) = ? LIMIT 1`).get(Number(primarySourceId), String(primaryKey)) || null;
}

/**
 * The admin's own pick: this backup stream for this primary channel, ranked first. Returns
 * { row } or { error, status } (404 for a channel or stream that does not exist).
 */
function addManual({ primarySourceId, primaryKey, backupSourceId, streamId }, now = Date.now()) {
    const { primaries, backups } = providers();
    const pid = Number(primarySourceId), bid = Number(backupSourceId);
    if (!primaries.some(s => s.id === pid)) return { status: 400, error: 'primarySourceId is not a primary provider' };
    if (!backups.some(s => s.id === bid)) return { status: 400, error: 'backupSourceId is not a backup provider' };
    if (!primaryKey || !primaryChannel(pid, primaryKey)) return { status: 404, error: 'No such primary channel' };
    const sid = String(streamId ?? '');
    const db = getDb();
    if (!sid || !db.prepare('SELECT 1 FROM backup_channels WHERE source_id = ? AND stream_id = ?').get(bid, sid)) {
        return { status: 404, error: 'That backup provider has no such stream' };
    }
    const existing = db.prepare('SELECT id FROM channel_links WHERE primary_source_id = ? AND primary_key = ? AND backup_source_id = ? AND backup_stream_id = ?')
        .get(pid, String(primaryKey), bid, sid);
    let id;
    if (existing) {
        db.prepare("UPDATE channel_links SET method = 'manual', status = 'manual', score = NULL, updated_at = ? WHERE id = ?").run(now, existing.id);
        id = existing.id;
    } else {
        const max = db.prepare('SELECT MAX(rank) AS m FROM channel_links WHERE primary_source_id = ? AND primary_key = ? AND backup_source_id = ?')
            .get(pid, String(primaryKey), bid).m || 0;
        id = db.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
            VALUES (?, ?, ?, ?, 'manual', 'manual', ?, NULL, ?)`).run(pid, String(primaryKey), bid, sid, max + 1, now).lastInsertRowid;
    }
    rerank(pid, String(primaryKey), bid, now);
    return { row: linkById(id) };
}

/** Approve every rank-1 pending link of the visible channels in a category (optionally one backup). */
function approvePending({ categoryId, backupSourceId = null }, now = Date.now()) {
    const { primaries } = providers();
    const channels = allVisible(primaries).filter(c => c.categoryIds.has(String(categoryId)) || c.categoryIds.has(categoryId));
    const db = getDb();
    const pick = db.prepare(`SELECT id FROM channel_links WHERE primary_source_id = ? AND primary_key = ? AND rank = 1
        AND status = 'pending' AND backup_source_id != primary_source_id ${backupSourceId == null ? '' : 'AND backup_source_id = ?'}`);
    const set = db.prepare("UPDATE channel_links SET status = 'approved', updated_at = ? WHERE id = ?");
    let approved = 0;
    db.transaction(() => {
        for (const c of channels) {
            const args = backupSourceId == null ? [c.sourceId, c.key] : [c.sourceId, c.key, Number(backupSourceId)];
            for (const r of pick.all(...args)) approved += set.run(now, r.id).changes;
        }
    })();
    return { approved };
}

/**
 * One row per visible primary channel with its links (never a URL). Filters: status (the channel
 * has a link with it), backupSourceId (only that provider's links), categoryId, search (name),
 * unlinked (no usable or pending rank-1 link at that backup, or at any backup). Paged.
 */
function list({ status = null, backupSourceId = null, categoryId = null, search = '', unlinked = false, offset = 0, limit = 100 } = {}) {
    const db = getDb();
    const { primaries, backups } = providers();
    let channels = allVisible(primaries);
    if (categoryId != null && categoryId !== '') channels = channels.filter(c => c.categoryIds.has(String(categoryId)));
    const q = fold(search).trim();
    if (q) channels = channels.filter(c => fold(c.name).includes(q));

    const bid = backupSourceId == null || backupSourceId === '' ? null : Number(backupSourceId);
    const rows = db.prepare(`SELECT id, primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at
        FROM channel_links ${bid == null ? '' : 'WHERE backup_source_id = ?'} ORDER BY rank`).all(...(bid == null ? [] : [bid]));
    const byChannel = new Map();
    for (const r of rows) {
        const k = `${r.primary_source_id}\u0000${r.primary_key}`;
        if (!byChannel.has(k)) byChannel.set(k, []);
        byChannel.get(k).push(r);
    }
    const linksOf = c => byChannel.get(`${c.sourceId}\u0000${c.key}`) || [];
    if (status) channels = channels.filter(c => linksOf(c).some(l => l.status === status));
    if (unlinked) {
        channels = channels.filter(c => !c.event && !linksOf(c).some(l =>
            l.rank === 1 && l.backup_source_id !== l.primary_source_id && (USABLE.has(l.status) || l.status === 'pending')));
    }

    const total = channels.length;
    const page = channels.slice(offset, offset + limit);
    const names = new Map(backups.map(b => [b.id, b.name]));
    const streamInfo = db.prepare('SELECT name, category_name FROM backup_channels WHERE source_id = ? AND stream_id = ?');
    const siblingInfo = db.prepare(`SELECT name FROM playlist_items WHERE source_id = ? AND type = 'live' AND COALESCE(stable_id, item_id) = ? LIMIT 1`);
    return {
        total, offset, limit,
        channels: page.map(c => ({
            sourceId: c.sourceId, key: c.key, id: c.itemId, name: c.name, number: c.number,
            categoryId: c.categoryId, categoryName: c.categoryName, tvgId: c.tvgId, region: c.region,
            quality: c.quality, event: c.event,
            links: linksOf(c).map(l => {
                const sibling = l.backup_source_id === l.primary_source_id;
                const info = sibling ? siblingInfo.get(l.backup_source_id, l.backup_stream_id) : streamInfo.get(l.backup_source_id, l.backup_stream_id);
                return {
                    id: l.id, backupSourceId: l.backup_source_id, provider: sibling ? 'sibling' : (names.get(l.backup_source_id) || null),
                    streamId: l.backup_stream_id, name: info ? info.name : null, category: info ? (info.category_name ?? null) : null,
                    method: l.method, status: l.status, rank: l.rank, score: l.score, updatedAt: l.updated_at
                };
            })
        }))
    };
}

/** Per provider (siblings included): rows per status, and how many visible channels have a usable rank-1 link. */
function summary() {
    const db = getDb();
    const { primaries, backups } = providers();
    const channels = allVisible(primaries);
    const visible = new Set(channels.map(c => `${c.sourceId}\u0000${c.key}`));
    const linkable = channels.filter(c => !c.event).length;
    const out = [];
    const one = (id, name, role, where, params) => {
        const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
        for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM channel_links WHERE ${where} GROUP BY status`).all(...params)) counts[r.status] = r.n;
        const linked = new Set(db.prepare(`SELECT primary_source_id, primary_key, status FROM channel_links WHERE ${where} AND rank = 1`).all(...params)
            .filter(r => USABLE.has(r.status)).map(r => `${r.primary_source_id}\u0000${r.primary_key}`).filter(k => visible.has(k)));
        out.push({ backupSourceId: id, name, role, enabled: true, counts, linked: linked.size, unlinked: Math.max(0, linkable - linked.size) });
    };
    for (const b of backups) {
        one(b.id, b.name, 'backup', 'backup_source_id = ? AND backup_source_id != primary_source_id', [b.id]);
        out[out.length - 1].enabled = Boolean(b.enabled);
        out[out.length - 1].priority = b.priority ?? null;
    }
    for (const p of primaries) one(p.id, p.name, 'sibling', 'backup_source_id = ? AND primary_source_id = ?', [p.id, p.id]);
    return { channels: channels.length, linkable, providers: out };
}

module.exports = {
    MAX_RANK,
    STATUSES,
    // pure
    fold, tvgKey, regionOf, rawNameKey, describeRaw, nameKey, nameTokens, qualityOf, isSibling, isPlaceholder, isEventSlot, foxNumber,
    describe, indexBackup, candidatesFor, siblingCandidatesFor, planLinks,
    // store
    relinkSource, relinkAll, removeFor, usableLinks, visibleChannels,
    // admin
    list, summary, setStatus, addManual, approvePending, rerank, linkById
};
