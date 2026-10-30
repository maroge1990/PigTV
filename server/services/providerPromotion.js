/**
 * #15: making a backup provider the primary keeps the curated lineup.
 *
 * The lineup (which channels are shown, their numbers, favourites, guide matches, series rules and pending
 * recordings) is keyed on the primary's channel identities, so a new primary started from nothing: if Strong8K
 * went, ~1,100 chosen channels, their numbers and the rest had to be rebuilt by hand. The linker (channelLinks.js)
 * already knows, for each shown primary channel, the same channel at each backup. `plan` turns those links into a
 * mapping from the old primary's keys to the keys the backup's channels will have once it is the primary, and
 * reports what would and would not carry over (the dry run). 0374 stores the plan when the order changes and
 * applies it as the new primary's first channel list is written.
 *
 * Only a usable link (auto, approved or manual) carries a channel, best rank first, and only to a channel in the
 * backup's own playlist (backup_channels.listed): the channels an M3U backup adds from the provider's whole list
 * (0183) would not be there. Rows synced before 0372 have no listing (`listingUnknown`), and are counted as listed.
 *
 * A backup channel's key as a primary channel follows stableIds.js: `s<id>` for a provider stream id, else the
 * hash the backup row was keyed by. Nothing here reads a stream URL.
 */
const { getDb } = require('../db/sqlite');
const { LISTED_SQL } = require('./channelNumbers');

const USABLE = "('auto', 'approved', 'manual')";
const MISSING_LISTED = 50;

/** The key a backup stream has once its provider is the primary. */
const keyOf = (streamId) => (/^\d+$/.test(String(streamId)) ? `s${streamId}` : String(streamId));

/**
 * What making `toId` the primary in place of `fromId` would carry over. Pure read.
 * Returns { report, mapping } (mapping: old key -> new key, for the shown channels that carry).
 */
function plan(fromId, toId, db = getDb()) {
    fromId = Number(fromId); toId = Number(toId);
    const listed = new Map();
    // A row with no identity is a `### SECTION ###` line (stableIds.js): nothing to play, nothing to carry.
    for (const r of db.prepare(`SELECT p.stable_id AS k, p.name FROM playlist_items p
            WHERE ${LISTED_SQL} AND p.source_id = ? AND p.stable_id IS NOT NULL AND p.stable_id <> ''
            ORDER BY COALESCE(p.sort_order, 999999999), p.name, p.id`).all(fromId)) {
        if (!listed.has(r.k)) listed.set(r.k, r.name);
    }
    const mapping = new Map();
    let listingUnknown = false;
    let notInPlaylist = 0;
    const links = db.prepare(`SELECT l.primary_key AS k, l.backup_stream_id AS stream, b.listed, b.stream_id AS present
        FROM channel_links l
        LEFT JOIN backup_channels b ON b.source_id = l.backup_source_id AND b.stream_id = l.backup_stream_id
        WHERE l.primary_source_id = ? AND l.backup_source_id = ? AND l.status IN ${USABLE}
        ORDER BY l.rank`).all(fromId, toId);
    const outside = new Set();
    for (const l of links) {
        if (mapping.has(l.k) || !listed.has(l.k) || l.present == null) continue;
        if (l.listed === 0) { outside.add(l.k); continue; }
        if (l.listed == null) listingUnknown = true;
        mapping.set(l.k, keyOf(l.stream));
    }
    for (const k of outside) if (!mapping.has(k)) notInPlaylist++;

    const missing = [...listed.keys()].filter(k => !mapping.has(k));
    const pending = new Set(db.prepare(`SELECT DISTINCT primary_key AS k FROM channel_links
        WHERE primary_source_id = ? AND backup_source_id = ? AND status = 'pending'`).all(fromId, toId).map(r => r.k));
    const carried = (keys) => keys.filter(k => mapping.has(k)).length;

    const numbered = db.prepare('SELECT channel_key AS k FROM channel_numbers WHERE source_id = ?').all(fromId).map(r => r.k);
    const favourites = db.prepare(`SELECT item_id AS k FROM favorites WHERE source_id = ? AND item_type = 'channel'`).all(fromId).map(r => r.k);
    const guideMatches = db.prepare('SELECT channel_key AS k FROM epg_mappings WHERE source_id = ?').all(fromId).map(r => r.k);
    const rules = tableExists(db, 'recording_rules')
        ? db.prepare(`SELECT COALESCE(channel_stable_id, channel_item_id) AS k FROM recording_rules
            WHERE kind = 'series' AND source_id = ?`).all(fromId).map(r => r.k) : [];
    const schedules = tableExists(db, 'scheduled_recordings')
        ? db.prepare(`SELECT COALESCE(channel_stable_id, channel_item_id) AS k FROM scheduled_recordings
            WHERE source_id = ? AND status IN ('scheduled', 'waiting')`).all(fromId).map(r => r.k) : [];

    const report = {
        fromSourceId: fromId, toSourceId: toId,
        shown: { total: listed.size, carried: mapping.size },
        missing: {
            count: missing.length,
            withPendingMatch: missing.filter(k => pending.has(k)).length,
            onlyOutsidePlaylist: notInPlaylist,
            names: missing.slice(0, MISSING_LISTED).map(k => listed.get(k))
        },
        numbers: { total: numbered.filter(k => listed.has(k)).length, carried: carried(numbered) },
        favourites: { total: favourites.length, carried: carried(favourites) },
        guideMatches: { total: guideMatches.length, carried: carried(guideMatches) },
        seriesRules: { total: rules.length, carried: carried(rules) },
        schedules: { total: schedules.length, carried: carried(schedules) },
        listingUnknown
    };
    return { report, mapping };
}

function tableExists(db, name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** The current primary provider's id (the first card), or null. */
function currentPrimary(db = getDb()) {
    for (const r of db.prepare('SELECT id, data FROM app_sources ORDER BY id').all()) {
        try {
            const s = JSON.parse(r.data);
            if (s.type !== 'epg' && s.role !== 'backup') return r.id;
        } catch { /* skip */ }
    }
    return null;
}

module.exports = { plan, keyOf, currentPrimary };
