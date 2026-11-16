/**
 * #57 (C-Y): GET /api/library/search?q=&limit= — one answer across what the household can watch, record or play:
 *   channels    visible channels whose name has every word of q, in guide order
 *   programmes  guide programmes on now or later whose title or subtitle has every word (as prefixes; the FTS5 index in
 *               programmeSearch.js), soonest first, each on its best visible channel (quality, then guide order)
 *   events      C-I sport events (kind `event`) not yet over whose title or a raw guide title (alias) matches, soonest first
 *   teams       the teams in the leagues' stored rosters (sport_fixture_teams) whose name matches; followed ones first
 *   recordings  completed or in-progress recordings whose title matches, as GET /api/recordings lists them
 * Channel objects have the guide's channel-row shape (no `programmes`). Each list holds at most `limit`.
 * The route (routes/library.js) supplies the guide's own row builder and decorations, so the shapes cannot drift.
 */
const { getDb } = require('../db/sqlite');
const { foldText, personKey } = require('./textFold');
const { qualityLabel, qualityRank } = require('./channelQuality');
const channelNumbers = require('./channelNumbers');
const { currentGuideVersion } = require('./libraryRev');
const epgMapping = require('./epgMapping');
const programmeSearch = require('./programmeSearch');
const programmeFields = require('./programmeFields');

const MIN_Q = 2;
const MAX_Q = 100;
const EVENT_HOURS = 72;
const PROGRAMME_PAGE = 200; // candidates read at a time
const PROGRAMME_SCAN_MAX = 5000; // candidates read at most per search

/** q trimmed, or an error text when it is not 2-100 characters. */
function checkQuery(raw) {
    const q = typeof raw === 'string' ? raw.trim() : '';
    if (q.length < MIN_Q || q.length > MAX_Q) return { error: `q must be ${MIN_Q} to ${MAX_Q} characters` };
    return { q };
}

/** A test for "every word of q is in this text" (case and accents aside); the whole of q when it has no word. */
function matcher(q) {
    const folded = foldText(q);
    const list = programmeSearch.words(folded);
    const parts = list.length ? list : [folded.trim()];
    return (...texts) => {
        const hay = texts.filter(t => typeof t === 'string').map(foldText).join('\u0001');
        return parts.every(w => hay.includes(w));
    };
}

// The visible channels (one per channel identity, guide order), kept while the guide version holds.
let channelCache = null;
function visibleChannels() {
    const version = currentGuideVersion();
    if (channelCache && channelCache.version === version) return channelCache;
    const rows = getDb().prepare(`
        SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id, p.tvg_id, p.id,
               ${channelNumbers.CHANNEL_KEY_SQL} AS channel_key, n.number AS channel_number
        FROM playlist_items p
        ${channelNumbers.NUMBER_JOIN}
        WHERE ${channelNumbers.VISIBLE_SQL}
        ORDER BY COALESCE(p.sort_order, 999999999) ASC, p.name ASC, p.id ASC
    `).all();
    const list = [];
    const seen = new Set();
    const byTvg = new Map();
    for (const row of rows) {
        const key = `${row.source_id}:${row.channel_key}`;
        if (seen.has(key)) continue; // cross-listed in another category: one channel
        seen.add(key);
        const entry = { key, row, order: list.length, tvgId: epgMapping.rowTvgId(row.source_id, row) };
        list.push(entry);
        if (!entry.tvgId) continue;
        if (!byTvg.has(entry.tvgId)) byTvg.set(entry.tvgId, []);
        byTvg.get(entry.tvgId).push(entry);
    }
    // The channel a programme is shown on: the best quality copy, then guide order (C-I's first two keys).
    for (const group of byTvg.values()) {
        group.sort((a, b) => qualityRank(qualityLabel(a.row.name)) - qualityRank(qualityLabel(b.row.name)) || a.order - b.order);
    }
    channelCache = { version, list, byTvg };
    return channelCache;
}

function teamsFor(q, userId, limit) {
    const match = matcher(q);
    let rows = [];
    try { rows = getDb().prepare('SELECT league, data FROM sport_fixture_teams ORDER BY league').all(); } catch (e) { return []; }
    const catalog = require('./sportCatalog');
    let followed = new Map(); // sport -> Set of personKey
    try {
        for (const s of require('./sportPagePrefs').follows(userId).sports || []) {
            followed.set(s.sport, new Set((s.teams || []).map(personKey)));
        }
    } catch (e) { followed = new Map(); }
    const { registerLogo } = require('./logoCache');
    const out = [];
    const seen = new Set();
    for (const { league, data } of rows) {
        let roster = [];
        try { roster = JSON.parse(data) || []; } catch (e) { continue; }
        const sport = catalog.sportOf(league);
        for (const t of roster) {
            const name = t && t.displayName;
            if (!name || !match(name, t.shortDisplayName, t.name)) continue;
            const id = String(t.id ?? name);
            if (seen.has(`${league}\u0001${id}`)) continue;
            seen.add(`${league}\u0001${id}`);
            const team = { id, name, league, followed: !!(sport && followed.get(sport)?.has(personKey(name))) };
            if (typeof t.logo === 'string' && /^https?:\/\//i.test(t.logo)) {
                try { team.logo = registerLogo(t.logo); } catch (e) { /* no logo */ }
            }
            out.push(team);
        }
    }
    out.sort((a, b) => (b.followed ? 1 : 0) - (a.followed ? 1 : 0) || a.name.localeCompare(b.name) || a.league.localeCompare(b.league));
    return out.slice(0, limit);
}

async function eventsFor(q, userId, limit, now, decorateChannels) {
    const match = matcher(q);
    const { events } = await require('./sportsEvents').eventsFor({ hours: EVENT_HOURS, userId, now, decorateChannels });
    return events
        .filter(ev => ev.kind === 'event' && ev.end > now && (match(ev.title) || (ev.aliases || []).some(a => match(a))))
        .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
        .slice(0, limit);
}

function recordingsFor(q, userId, limit) {
    const match = matcher(q);
    return require('./recordingEngine').listRecordings(userId)
        .filter(r => (r.status === 'completed' || r.status === 'recording') && match(r.title))
        .slice(0, limit);
}

/**
 * The whole answer. `channelRow(row)` and `decorate(rows)` are the guide's (routes/library.js); `decorateChannels`
 * the sport events' logo decoration.
 */
async function search({ q, limit, userId, now = Date.now(), channelRow, decorate, decorateChannels }) {
    const { list, byTvg } = visibleChannels();
    const match = matcher(q);
    const rowsByKey = new Map();
    const rowFor = (entry) => {
        let row = rowsByKey.get(entry.key);
        if (!row) { row = channelRow(entry.row); rowsByKey.set(entry.key, row); }
        return row;
    };

    const channels = [];
    for (const entry of list) {
        if (channels.length >= limit) break;
        if (match(entry.row.name)) channels.push(rowFor(entry));
    }

    const programmes = [];
    const airings = new Set();
    const liveIndex = programmeFields.liveIndex();
    // Matches on hidden or unknown channels, and a second guide's copy of an airing, are skipped: page through the
    // candidates until `limit` are kept or the matches run out (bounded, so a common word cannot walk the whole guide).
    for (let offset = 0; programmes.length < limit && offset < PROGRAMME_SCAN_MAX; offset += PROGRAMME_PAGE) {
        const page = await programmeSearch.search(q, { now, max: PROGRAMME_PAGE, offset });
        for (const p of page) {
            if (programmes.length >= limit) break;
            const entry = byTvg.get(p.channel_id)?.[0];
            if (!entry) continue; // no visible channel shows it
            const airing = `${entry.key}\u0001${p.start_time}`;
            if (airings.has(airing)) continue; // two guides list the same airing
            airings.add(airing);
            const channel = rowFor(entry);
            programmes.push({
                channel,
                title: p.title,
                start: p.start_time,
                end: p.end_time,
                ...programmeFields.extras(p, channel, liveIndex)
            });
        }
        if (page.length < PROGRAMME_PAGE) break;
    }
    programmeFields.applyImages(programmes);
    decorate([...rowsByKey.values()]);

    let events = [];
    try { events = await eventsFor(q, userId, limit, now, decorateChannels); } catch (e) {
        console.warn('[Search] sport events:', e.message);
    }
    let teams = [];
    try { teams = teamsFor(q, userId, limit); } catch (e) { console.warn('[Search] teams:', e.message); }
    let recordings = [];
    try { recordings = recordingsFor(q, userId, limit); } catch (e) { console.warn('[Search] recordings:', e.message); }

    return { q, channels, programmes, events, teams, recordings };
}

module.exports = { search, checkQuery, matcher, MIN_Q, MAX_Q, _resetChannels: () => { channelCache = null; } };
