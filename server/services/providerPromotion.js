/**
 * #15: making a backup provider the primary keeps the curated lineup.
 *
 * The lineup (which channels are shown, their numbers, favourites, guide matches, series rules and pending
 * recordings) is keyed on the primary's channel identities, so a new primary started from nothing: if Strong8K
 * went, ~1,100 chosen channels, their numbers and the rest had to be rebuilt by hand. The linker (channelLinks.js)
 * already knows, for each shown primary channel, the same channel at each backup. `plan` turns those links into a
 * mapping from the old primary's keys to the keys the backup's channels will have once it is the primary, and
 * reports what would and would not carry over (the dry run). 0374: `store` keeps that mapping when the order makes
 * the backup the primary, and `applyIfPlanned` uses it the moment the new primary's channel list is written
 * (syncService, before channel numbers are refreshed): the carried channels are shown and every other one hidden,
 * and the numbers, favourites, guide matches, series rules and pending recordings move to the new keys. The old
 * primary keeps its own record of hidden channels (hiddenChannels.js), so moving back restores it.
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
    const favourites = db.prepare(`SELECT COALESCE(stable_id, item_id) AS k FROM favorites WHERE source_id = ? AND item_type = 'channel'`).all(fromId).map(r => r.k);
    const guideMatches = db.prepare('SELECT channel_key AS k FROM epg_mappings WHERE source_id = ?').all(fromId).map(r => r.k);
    const rules = tableExists(db, 'recording_rules')
        ? db.prepare(`SELECT COALESCE(channel_stable_id, channel_item_id) AS k FROM recording_rules
            WHERE kind = 'series' AND source_id = ?`).all(fromId).map(r => r.k) : [];
    const schedules = tableExists(db, 'scheduled_recordings')
        ? db.prepare(`SELECT COALESCE(channel_stable_id, channel_item_id) AS k FROM scheduled_recordings
            WHERE source_id = ? AND status IN ('scheduled', 'waiting')`).all(fromId).map(r => r.k) : [];

    const report = {
        fromSourceId: fromId, toSourceId: toId,
        // 0374: a provider that was the primary before keeps its own record of what was shown; that decides.
        visibility: ownRecord(db, toId) ? 'own' : 'carried',
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

/** Whether `sourceId` has its own record of hidden channels from an earlier time as the primary (hiddenChannels.js). */
function ownRecord(db, sourceId) {
    return tableExists(db, 'hidden_channels')
        && !!db.prepare('SELECT 1 FROM hidden_channels WHERE source_id = ? LIMIT 1').get(Number(sourceId));
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

function ensure(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_promotions (
        to_source_id INTEGER PRIMARY KEY, from_source_id INTEGER NOT NULL, mapping TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}

/** 0374: keep the plan for making `toId` the primary in place of `fromId` (one at a time). Returns the report. */
function store(fromId, toId, db = getDb()) {
    ensure(db);
    const { report, mapping } = plan(fromId, toId, db);
    db.transaction(() => {
        db.prepare('DELETE FROM provider_promotions').run();
        db.prepare('INSERT INTO provider_promotions (to_source_id, from_source_id, mapping, created_at) VALUES (?, ?, ?, ?)')
            .run(Number(toId), Number(fromId), JSON.stringify([...mapping.entries()]), Date.now());
    })();
    return report;
}

/** #180: the plan waiting for its new primary's first complete sync, as { fromId, toId }, or null. */
function pending(db = getDb()) {
    ensure(db);
    const row = db.prepare('SELECT from_source_id AS fromId, to_source_id AS toId FROM provider_promotions LIMIT 1').get();
    return row || null;
}

/** 0374: drop a stored plan (the old primary was put back first before the new one was synced). */
function clear(db = getDb()) {
    ensure(db);
    db.prepare('DELETE FROM provider_promotions').run();
}

/**
 * 0374: once `sourceId`'s live channels are written as the primary, carry the old primary's lineup over (see the top).
 * Kept for the next sync when no live channel was written. Returns what moved, or null when there was no plan.
 */
function applyIfPlanned(db, sourceId) {
    ensure(db);
    const row = db.prepare('SELECT from_source_id AS fromId, mapping FROM provider_promotions WHERE to_source_id = ?').get(Number(sourceId));
    if (!row) return null;
    const toId = Number(sourceId), fromId = row.fromId;
    const mapping = new Map(JSON.parse(row.mapping));
    const rows = db.prepare(`SELECT id, item_id, COALESCE(stable_id, item_id) AS k, is_hidden FROM playlist_items
        WHERE source_id = ? AND type = 'live' ORDER BY COALESCE(sort_order, 999999999), id`).all(toId);
    if (!rows.length) return null;
    const itemOf = new Map();
    for (const r of rows) if (!itemOf.has(r.k)) itemOf.set(r.k, r.item_id);
    const shown = new Set([...mapping.values()].filter(k => itemOf.has(k)));
    // Its own record (already re-applied by hiddenChannels.after) decides what a former primary shows: moving back
    // restores it exactly. Otherwise the carried channels are shown and every other one is hidden.
    const own = ownRecord(db, toId);
    const moved = { visibility: own ? 'own' : 'carried', shown: 0, hidden: 0, numbers: 0, favourites: 0, guideMatches: 0, seriesRules: 0, schedules: 0 };
    const now = Date.now();
    db.transaction(() => {
        if (!own) {
            const setFlag = db.prepare('UPDATE playlist_items SET is_hidden = ? WHERE id = ?');
            for (const r of rows) {
                const hidden = shown.has(r.k) ? 0 : 1;
                if (hidden !== r.is_hidden) setFlag.run(hidden, r.id);
            }
            db.prepare(`UPDATE categories SET is_hidden = CASE WHEN EXISTS (SELECT 1 FROM playlist_items p
                    WHERE p.source_id = categories.source_id AND p.type = 'live' AND p.category_id = categories.category_id
                    AND p.is_hidden = 0) THEN 0 ELSE 1 END
                WHERE source_id = ? AND type = 'live'`).run(toId);
        }
        for (const r of db.prepare(`SELECT is_hidden FROM playlist_items WHERE source_id = ? AND type = 'live'`).all(toId)) {
            if (r.is_hidden) moved.hidden++; else moved.shown++;
        }

        const pairs = [...mapping.entries()].filter(([, k]) => itemOf.has(k));
        // Numbers: the old channel's number moves; a key that already took one keeps it (two channels linked to one).
        const taken = new Set();
        const oldNumber = db.prepare('SELECT number FROM channel_numbers WHERE source_id = ? AND channel_key = ?');
        const dropStale = db.prepare('DELETE FROM channel_numbers WHERE source_id = ? AND channel_key = ?');
        const moveNumber = db.prepare(`UPDATE channel_numbers SET source_id = ?, channel_key = ?, item_id = ?, last_seen = ?
            WHERE source_id = ? AND channel_key = ?`);
        for (const [from, to] of [...pairs].sort((a, b) => (oldNumber.get(fromId, a[0])?.number ?? 1e9) - (oldNumber.get(fromId, b[0])?.number ?? 1e9))) {
            if (taken.has(to) || !oldNumber.get(fromId, from)) continue;
            dropStale.run(toId, to);
            moved.numbers += moveNumber.run(toId, to, itemOf.get(to), now, fromId, from).changes;
            taken.add(to);
        }
        // A favourite keeps its identity in stable_id and the row it was made on in item_id (favorites.js).
        const favourites = db.prepare(`SELECT user_id, COALESCE(stable_id, item_id) AS k FROM favorites WHERE source_id = ? AND item_type = 'channel'`).all(fromId);
        const addFavourite = db.prepare(`INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, ?, ?, 'channel', ?)`);
        for (const f of favourites) {
            const to = mapping.get(f.k);
            if (to && itemOf.has(to)) moved.favourites += addFavourite.run(f.user_id, toId, itemOf.get(to), to).changes;
        }
        const matches = db.prepare('SELECT channel_key, tvg_id, batch FROM epg_mappings WHERE source_id = ?').all(fromId);
        const addMatch = db.prepare(`INSERT INTO epg_mappings (source_id, channel_key, tvg_id, updated_at, batch) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_id, channel_key) DO UPDATE SET tvg_id = excluded.tvg_id, updated_at = excluded.updated_at, batch = excluded.batch`);
        for (const m of matches) if (mapping.has(m.channel_key) && itemOf.has(mapping.get(m.channel_key))) {
            moved.guideMatches += addMatch.run(toId, mapping.get(m.channel_key), m.tvg_id, now, m.batch ?? null).changes;
        }
        const repoint = (table, where) => {
            if (!tableExists(db, table)) return 0;
            let n = 0;
            const update = db.prepare(`UPDATE ${table} SET source_id = ?, channel_stable_id = ?, channel_item_id = ? WHERE id = ?`);
            for (const r of db.prepare(`SELECT id, COALESCE(channel_stable_id, channel_item_id) AS k FROM ${table} WHERE source_id = ? AND ${where}`).all(fromId)) {
                const to = mapping.get(r.k);
                if (to && itemOf.has(to)) n += update.run(toId, to, itemOf.get(to), r.id).changes;
            }
            return n;
        };
        moved.seriesRules = repoint('recording_rules', "kind = 'series'");
        moved.schedules = repoint('scheduled_recordings', "status IN ('scheduled', 'waiting')");
        db.prepare('DELETE FROM provider_promotions').run();
        db.prepare('DELETE FROM new_channel_groups WHERE source_id = ?').run(toId);
    })();
    if (!own) require('./hiddenChannels').capture(db, toId);
    try { require('./epgMapping').reset(); } catch (e) { /* re-read on its own */ }
    return { fromSourceId: fromId, ...moved };
}

module.exports = { plan, keyOf, currentPrimary, store, clear, pending, applyIfPlanned };
