/**
 * A provider's raw Xtream channel rows (0178, multi-provider P9).
 *
 * Every provider is Xtream underneath. Whatever its role (primary or backup) and however it is
 * connected (Xtream, or an EPGenius M3U whose stream URLs carry the provider's stream id), its
 * `player_api.php` gives each stream id's raw name, raw `epg_channel_id` and raw category. The
 * linker compares those raw rows between providers (raw-name, raw-epg), so nothing here or there
 * depends on which provider is primary: a swap of roles keeps working.
 *
 * Table `provider_raw_channels(source_id, stream_id, name, epg_channel_id, category_name)`:
 *   - an Xtream backup's rows are written from the very fetch that fills backup_channels;
 *   - every other source is fetched once after a successful sync, when a backup exists
 *     (none: nothing is fetched, exactly as before) and when the first backup appears.
 * A failed fetch is logged (redacted, never a URL or login) and never fails a sync: the previous
 * rows stay. Rows are replaced in one transaction.
 */
const { getDb } = require('../db/sqlite');
const { redact } = require('../redact');

/** Xtream's catch-up flag as days (tv_archive 1 + tv_archive_duration; 1 when no duration is given), else 0. */
function archiveDaysOf(s) {
    if (Number(s.tv_archive) !== 1) return 0;
    const days = Math.floor(Number(s.tv_archive_duration));
    return Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 1;
}

function toRows(cats, streams) {
    const names = new Map((Array.isArray(cats) ? cats : []).map(c => [String(c.category_id), c.category_name]));
    const rows = [];
    for (const s of Array.isArray(streams) ? streams : []) {
        if (!s || s.stream_id == null) continue;
        rows.push({
            streamId: String(s.stream_id),
            name: s.name == null ? null : String(s.name),
            epg: s.epg_channel_id ? String(s.epg_channel_id) : null,
            category: names.get(String(s.category_id)) || null,
            archiveDays: archiveDaysOf(s)
        });
    }
    return rows;
}

/** Replace all of a source's raw rows in one transaction (a throw leaves the old rows). */
function replaceAll(sourceId, rows) {
    const db = getDb();
    const now = Date.now();
    const insert = db.prepare(`INSERT OR REPLACE INTO provider_raw_channels
        (source_id, stream_id, name, epg_channel_id, category_name, updated_at, archive_days) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        db.prepare('DELETE FROM provider_raw_channels WHERE source_id = ?').run(sourceId);
        for (const r of rows) insert.run(sourceId, r.streamId, r.name, r.epg, r.category, now, r.archiveDays || 0);
    })();
}

function removeFor(sourceId) {
    return getDb().prepare('DELETE FROM provider_raw_channels WHERE source_id = ?').run(sourceId).changes;
}

function count(sourceId) {
    return getDb().prepare('SELECT COUNT(*) AS c FROM provider_raw_channels WHERE source_id = ?').get(sourceId).c;
}

/** Map(stream id -> { name, epg, category }) of one source. */
function loadMap(sourceId) {
    const map = new Map();
    for (const r of getDb().prepare('SELECT stream_id, name, epg_channel_id, category_name FROM provider_raw_channels WHERE source_id = ?').all(sourceId)) {
        map.set(String(r.stream_id), { name: r.name, epg: r.epg_channel_id, category: r.category_name });
    }
    return map;
}

/**
 * Fetch and store one source's raw rows: one get_live_categories and one get_live_streams call.
 * Skipped (false) when no login can be derived. Never throws.
 */
async function fetchFor(source) {
    try {
        const login = require('./providerAccounts').deriveLogin(source);
        if (!login) return false;
        const { XtreamApi } = require('./xtreamApi');
        const api = new XtreamApi(login.url, login.username, login.password);
        const cats = await api.getLiveCategories();
        const streams = await api.getLiveStreams();
        if (!Array.isArray(streams) || !streams.length) throw new Error('no channel list');
        const rows = toRows(cats, streams);
        replaceAll(source.id, rows);
        console.log(`[Raw] ${source.name}: ${rows.length} raw rows`);
        return true;
    } catch (err) {
        console.warn(`[Raw] Raw list of ${source && source.name} could not be read, keeping the last one: ${String(redact(err && err.message)).slice(0, 160)}`);
        return false;
    }
}

/** Fetch for every enabled stream source that has no raw rows yet (when the first backup appears). */
async function fetchMissing(sources, exceptId = null) {
    for (const s of sources) {
        if (!s || s.type === 'epg' || !s.enabled || s.id === exceptId) continue;
        if (count(s.id) === 0) await fetchFor(s);
    }
}

/**
 * For the Status page: per provider with raw rows, how many streams it lists and how many the
 * provider flags for catch-up (and the longest archive). Answers "does any provider offer
 * catch-up?" from data the sync already fetches.
 */
function archiveSummary() {
    return getDb().prepare(`
        SELECT source_id AS sourceId, COUNT(*) AS streams,
               SUM(CASE WHEN archive_days > 0 THEN 1 ELSE 0 END) AS withArchive,
               MAX(archive_days) AS maxDays, MAX(updated_at) AS checkedAt
        FROM provider_raw_channels GROUP BY source_id ORDER BY source_id
    `).all();
}

module.exports = { toRows, replaceAll, removeFor, count, loadMap, fetchFor, fetchMissing, archiveSummary, archiveDaysOf };
