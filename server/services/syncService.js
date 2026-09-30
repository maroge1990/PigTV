const { getDb } = require('../db/sqlite');
const { stripBadgeSuffix } = require('./textCleanup');
const { bumpLibraryRev } = require('./libraryRev');
const { refreshChannelNumbers } = require('./channelNumbers');
const { stableChannelId, summarise } = require('./stableIds');
const { sources, settings } = require('../db'); // For source config and settings
const xtreamApi = require('./xtreamApi');
const { redact } = require('../redact');
const m3uParser = require('./m3uParser');
const epgParser = require('./epgParser');

// Sync tracking
const activeSyncs = new Set(); // sourceId

// 0147: a programme's XMLTV <category> values as stored in epg_programs.categories:
// a JSON array of the provider's strings, trimmed and de-duplicated (case aside),
// at most 12 of up to 100 characters; NULL when there are none.
function categoriesJson(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= 12) break;
    }
    return out.length ? JSON.stringify(out) : null;
}

/**
 * 0153: one log line saying how far ahead a synced guide reaches. The sync stores whatever the
 * feed carries (nothing is trimmed by time); the Sport list (C-I) looks up to 72 h ahead, so a
 * shorter feed is called out.
 */
function epgCoverageLine(lastStop, now = Date.now()) {
    if (!lastStop) return '[Sync] EPG coverage: no programme has an end time';
    const ahead = Math.round((lastStop - now) / 3600000);
    const short = ahead < 72 ? ' (less than the 72 h the Sport list looks ahead)' : '';
    return `[Sync] EPG covers until ${new Date(lastStop).toISOString()}, ${ahead} h ahead${short}`;
}

class SyncService {
    constructor() {
        this.lastSyncTime = null; // Track when global sync last completed
        this._syncTimer = null;   // Server-side sync timer
        this._currentInterval = null;
    }

    /**
     * Get when the last global sync completed
     */
    getLastSyncTime() {
        return this.lastSyncTime;
    }

    /**
     * Start the server-side sync timer based on settings
     * Should be called once on server startup after initial sync
     */
    async startSyncTimer() {
        // Get interval from settings
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.epgRefreshInterval) || 24;

        // If interval is 0, don't start timer (manual only mode)
        if (intervalHours <= 0) {
            console.log('[Sync] Auto-sync disabled (manual only mode)');
            this.stopSyncTimer();
            this._currentInterval = 0;
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;

        // Don't restart if interval hasn't changed and timer exists
        if (this._currentInterval === intervalHours && this._syncTimer) {
            console.log(`[Sync] Timer already running for ${intervalHours} hours, not restarting`);
            return;
        }

        // Clear existing timer
        this.stopSyncTimer();

        const nextSyncTime = new Date(Date.now() + intervalMs);
        console.log(`[Sync] Starting server-side sync timer: every ${intervalHours} hours`);
        console.log(`[Sync] Next scheduled sync at: ${nextSyncTime.toLocaleString()}`);

        this._syncTimer = setInterval(async () => {
            console.log('[Sync] Scheduled sync triggered');
            await this.syncAll();
            // Log next sync time
            const next = new Date(Date.now() + intervalMs);
            console.log(`[Sync] Next scheduled sync at: ${next.toLocaleString()}`);
        }, intervalMs);

        this._currentInterval = intervalHours;
    }

    /**
     * Stop the server-side sync timer
     */
    stopSyncTimer() {
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
            this._syncTimer = null;
        }
    }

    /**
     * Restart the sync timer with updated settings
     * Called when sync interval setting changes
     */
    async restartSyncTimer() {
        await this.startSyncTimer();
    }

    /**
     * Sync all enabled sources
     */
    async syncAll() {
        console.log('[Sync] Starting global sync...');
        try {
            const allSources = await sources.getAll();
            for (const source of allSources) {
                if (source.enabled) {
                    // Run sequentially to not overload
                    await this.syncSource(source.id);
                }
            }
            this.lastSyncTime = new Date();
            console.log('[Sync] Global sync completed at', this.lastSyncTime.toISOString());
        } catch (err) {
            console.error('[Sync] Global sync failed:', err);
        }
    }

    /**
     * Only sync sources whose data is older than their configured interval.
     * Called on server start instead of syncAll to avoid re-downloading
     * the entire EPG (hundreds of thousands of programmes) every time
     * the container restarts.
     */
    async syncIfStale() {
        console.log('[Sync] Checking for stale sources...');
        try {
            const allSources = await sources.getAll();
            const db = getDb();
            let synced = 0;

            for (const source of allSources) {
                if (!source.enabled) continue;

                // Check if we have any data at all for this source
                const hasData = db.prepare(
                    'SELECT COUNT(*) as c FROM playlist_items WHERE source_id = ?'
                ).get(source.id);

                if (!hasData || hasData.c === 0) {
                    console.log(`[Sync] Source "${source.name}" has no data, syncing...`);
                    await this.syncSource(source.id);
                    synced++;
                    continue;
                }

                // sync_status is written on every successful sync and is the
                // only record that actually exists. An earlier version of this
                // checked a file cache that syncEpgFromUrl never writes, so it
                // always missed and re-parsed the entire EPG — several hundred
                // thousand programmes — on every container start.
                const lastRow = db.prepare(`
                    SELECT MAX(last_sync) AS last_sync FROM sync_status
                    WHERE source_id = ? AND status = 'success'
                `).get(source.id);

                const syncInterval = (source.syncInterval || 24) * 60 * 60 * 1000;
                const lastSync = lastRow?.last_sync || 0;
                const age = Date.now() - lastSync;

                if (age > syncInterval) {
                    const desc = lastSync ? `${Math.round(age / 3600000)}h old` : 'never synced';
                    console.log(`[Sync] Source "${source.name}" is stale (${desc}), syncing...`);
                    await this.syncSource(source.id);
                    synced++;
                } else {
                    console.log(`[Sync] Source "${source.name}" is fresh (${Math.round(age / 3600000)}h old), skipping`);
                }
            }

            if (synced === 0) {
                console.log('[Sync] All sources are fresh, no sync needed');
            }
            this.lastSyncTime = new Date();
        } catch (err) {
            console.error('[Sync] Stale check failed:', err);
        }
    }

    /**
     * Start sync for a source
     */
    async syncSource(sourceId) {
        if (activeSyncs.has(sourceId)) {
            console.log(`[Sync] Source ${sourceId} is already syncing`);
            return;
        }

        activeSyncs.add(sourceId);

        try {
            const db = getDb();
            const source = await sources.getById(sourceId);

            if (!source) {
                throw new Error(`Source ${sourceId} not found`);
            }

            console.log(`[Sync] Starting sync for source ${source.name} (ID: ${sourceId})`);

            if (!source.enabled) {
                console.log(`[Sync] Skipping disabled source ${source.name}`);
                activeSyncs.delete(sourceId);
                return;
            }

            // Update status
            this.updateSyncStatus(sourceId, 'all', 'syncing');

            if (source.type === 'xtream') {
                await this.syncXtream(source);
            } else if (source.type === 'm3u') {
                await this.syncM3u(source);
            } else if (source.type === 'epg') {
                await this.syncEpg(source);
            }

            this.updateSyncStatus(sourceId, 'all', 'success');
            // A completed sync (playlist or EPG) can change every guide row, so
            // the guide's "did anything change?" version must move. The EPG
            // generation flip inside syncEpg() also changes epg_state directly,
            // which currentGuideVersion() reads on its own - this bump covers the
            // playlist/category side, which has nothing else recording a change.
            bumpLibraryRev();
            // 0117: number any channel that is new, refresh the reservations of
            // the ones still here, release numbers reserved for 30 days.
            if (source.type !== 'epg') refreshChannelNumbers();
            // 0168: the provider's account (expiry, connections) is re-read after a good sync,
            // in the background: it never slows or fails the sync.
            if (source.type !== 'epg') {
                try { require('./providerAccounts').refresh(sourceId).catch(() => {}); } catch (e) { /* best-effort */ }
            }
            console.log(`[Sync] Completed sync for source ${source.name}`);

        } catch (err) {
            console.error(`[Sync] Failed sync for source ${sourceId}:`, err);
            this.updateSyncStatus(sourceId, 'all', 'error', err.message);
        } finally {
            activeSyncs.delete(sourceId);
        }
    }

    /**
     * Update sync status in DB
     */
    updateSyncStatus(sourceId, type, status, error = null) {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO sync_status (source_id, type, last_sync, status, error)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_id, type) DO UPDATE SET
                last_sync = excluded.last_sync,
                status = excluded.status,
                error = excluded.error
        `);
        stmt.run(sourceId, type, Date.now(), status, error);
    }

    /**
     * Xtream Sync Logic
     */
    async syncXtream(source) {
        const api = xtreamApi.createFromSource(source);
        const db = getDb();

        // 1. Live Categories
        console.log(`[Sync] Fetching Live Categories for ${source.name}`);
        const liveCats = await api.getLiveCategories();
        await this.saveCategories(source.id, 'live', liveCats);

        // 2. Live Streams
        console.log(`[Sync] Fetching Live Streams for ${source.name}`);
        const liveStreams = await api.getLiveStreams();
        await this.saveStreams(source.id, 'live', liveStreams);

        // 3. VOD Categories
        console.log(`[Sync] Fetching VOD Categories for ${source.name}`);
        const vodCats = await api.getVodCategories();
        await this.saveCategories(source.id, 'movie', vodCats);

        // 4. VOD Streams
        console.log(`[Sync] Fetching VOD Streams for ${source.name}`);
        const vodStreams = await api.getVodStreams();
        await this.saveStreams(source.id, 'movie', vodStreams);

        // 5. Series Categories
        console.log(`[Sync] Fetching Series Categories for ${source.name}`);
        const seriesCats = await api.getSeriesCategories();
        await this.saveCategories(source.id, 'series', seriesCats);

        // 6. Series
        console.log(`[Sync] Fetching Series for ${source.name}`);
        const series = await api.getSeries();
        await this.saveStreams(source.id, 'series', series);

        // 7. EPG (Xmltv)
        // Try to fetch XMLTV if available
        console.log(`[Sync] Fetching EPG for ${source.name}`);
        try {
            const xmltvUrl = api.getXmltvUrl();
            await this.syncEpgFromUrl(source.id, xmltvUrl);
        } catch (e) {
            console.warn('[Sync] XMLTV fetch failed, skipping EPG sync for now:', e.message);
        }
    }

    /**
     * Batch save categories
     */
    async saveCategories(sourceId, type, categories) {
        if (!categories || categories.length === 0) return;
        console.log(`[Sync] Saving ${categories.length} ${type} categories for source ${sourceId}...`);
        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO categories (id, source_id, category_id, type, name, parent_id, sort_order, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                sort_order = excluded.sort_order,
                data = excluded.data
        `);

        const insertBatch = db.transaction((batch) => {
            for (const cat of batch) {
                const catId = cat.category_id; // standard xtream field
                const name = cat.category_name;
                const id = `${sourceId}:${catId}`;
                stmt.run(id, sourceId, String(catId), type, name, cat.parent_id || null,
                    Number.isFinite(cat.sort_order) ? cat.sort_order : null, JSON.stringify(cat));
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < categories.length; i += BATCH_SIZE) {
            insertBatch(categories.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        console.log(`[Sync] Saved ${categories.length} ${type} categories`);
    }

    /**
     * Batch save streams (channels, vod, series)
     * Also purges stale entries that no longer exist in the source (unless skipPurge is true)
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Array} items - Items to save
     * @param {Object} options - Options { skipPurge: boolean }
     * @returns {Set} Set of synced IDs (for external purge if skipPurge was true)
     */
    async saveStreams(sourceId, type, items, options = {}) {
        if (!items || items.length === 0) return new Set();
        const db = getDb();
        const { skipPurge = false } = options;

        // Collect all IDs we're syncing
        const syncedIds = new Set();

        const stmt = db.prepare(`
            INSERT INTO playlist_items (
                id, source_id, item_id, type, name, category_id,
                stream_icon, stream_url, container_extension,
                rating, year, added_at, sort_order, data, stable_id, tvg_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                category_id = excluded.category_id,
                stream_icon = excluded.stream_icon,
                container_extension = excluded.container_extension,
                sort_order = excluded.sort_order,
                data = excluded.data,
                -- Rewritten every sync: the position moves, the identity does not,
                -- so a row that changes position must not keep a stale identity.
                stable_id = excluded.stable_id,
                tvg_id = excluded.tvg_id
        `);

        const insertBatch = db.transaction((batch) => {
            for (const item of batch) {
                // Map fields based on type
                let itemId, name, catId, icon, container;
                let rating = null, year = null, added = null;

                if (type === 'live') {
                    itemId = item.stream_id;
                    // 0138: the Xtream path too (the M3U parser already strips it).
                    name = stripBadgeSuffix(item.name) || `Channel ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon;
                    added = item.added;
                } else if (type === 'movie') {
                    itemId = item.stream_id;
                    name = item.name || `Movie ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon; // or cover
                    container = item.container_extension;
                    rating = item.rating;
                    added = item.added;
                } else if (type === 'series') {
                    itemId = item.series_id;
                    name = item.name || `Series ${item.series_id}`;
                    catId = item.category_id;
                    icon = item.cover;
                    rating = item.rating;
                    year = item.releaseDate;
                    added = item.last_modified;
                }

                const id = `${sourceId}:${itemId}`;
                syncedIds.add(id);

                stmt.run(
                    id,
                    sourceId,
                    String(itemId),
                    type,
                    name,
                    String(catId),
                    icon,
                    null, // Direct URL not stored for Xtream usually, built on fly
                    container,
                    rating,
                    year,
                    added,
                    item.sort_order || null,
                    JSON.stringify(item),
                    // What this channel is, as opposed to where it sits. From the
                    // URL for an M3U row (it carries the provider's stream id), and
                    // from the item id itself for an Xtream row, whose id already IS
                    // that stream id and so never moved in the first place.
                    stableChannelId(item.stream_url || null)
                        || (/^\d+$/.test(String(itemId)) ? `s${itemId}` : null),
                    // The EPG channel id, wherever this item's shape carries it: M3U
                    // rows set tvgId (see below); Xtream's raw JSON uses
                    // epg_channel_id. Read straight from the source item rather than
                    // round-tripping through JSON so this is filled at ingest, not
                    // only by the startup backfill.
                    item.tvgId || item.epg_channel_id || null
                );
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            insertBatch(items.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        // Purge stale entries (skip if doing batch sync like M3U)
        if (!skipPurge && syncedIds.size > 0) {
            await this.purgeStaleItems(sourceId, type, syncedIds);
        }

        console.log(`[Sync] Saved ${items.length} ${type} items`);
        return syncedIds;
    }

    /**
     * Purge stale items that are no longer in the source
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Set} syncedIds - Set of IDs that should be kept
     */
    async purgeStaleItems(sourceId, type, syncedIds) {
        if (!syncedIds || syncedIds.size === 0) return;

        const db = getDb();
        db.exec('CREATE TEMP TABLE IF NOT EXISTS synced_ids (id TEXT PRIMARY KEY)');
        db.exec('DELETE FROM synced_ids');

        const insertTemp = db.prepare('INSERT OR IGNORE INTO synced_ids (id) VALUES (?)');
        const insertTempBatch = db.transaction((ids) => {
            for (const id of ids) {
                insertTemp.run(id);
            }
        });
        insertTempBatch([...syncedIds]);

        const deleteStmt = db.prepare(`
            DELETE FROM playlist_items 
            WHERE source_id = ? AND type = ? 
            AND id NOT IN (SELECT id FROM synced_ids)
        `);
        const deleted = deleteStmt.run(sourceId, type);

        if (deleted.changes > 0) {
            console.log(`[Sync] Purged ${deleted.changes} stale ${type} items`);
        }
    }


    /**
     * Delete a source's programmes whose generation is (op '=') or is not
     * (op '<>') the given one, in slices that yield between them.
     */
    async purgeEpgRows(sourceId, op, gen) {
        const db = getDb();
        const stmt = db.prepare(`
            DELETE FROM epg_programs WHERE id IN (
                SELECT id FROM epg_programs WHERE source_id = ? AND gen ${op === '=' ? '=' : '<>'} ? LIMIT 20000
            )
        `);
        let total = 0;
        for (;;) {
            const { changes } = stmt.run(sourceId, gen);
            if (!changes) return total;
            total += changes;
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    /**
     * Sync EPG from URL (Streaming - Memory Efficient)
     * Processes EPG files in batches to avoid OOM on large EPG data
     */
    async syncEpgFromUrl(sourceId, url) {
        console.log(`[Sync] Fetching EPG from: ${redact(url).slice(0, 80)}...`);

        // Temporary memory logging for verification
        const logMemory = () => {
            const used = process.memoryUsage();
            console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
        };

        logMemory();

        const db = getDb();
        let allChannels = [];
        let totalProgrammes = 0;
        let batchCount = 0;
        let lastStop = 0; // 0153: how far ahead the feed reaches (the Sport list looks 72 h ahead)

        // The guide stays live while the new feed loads. Programmes are written
        // as the *next* generation, which readers (the epg_live view) cannot
        // see, and only once the whole feed is in does epg_state flip to it.
        // Anything not live at this point is debris from an interrupted sync.
        const activeGen = db.prepare('SELECT active_gen FROM epg_state WHERE source_id = ?').get(sourceId)?.active_gen ?? 0;
        const newGen = activeGen + 1;
        await this.purgeEpgRows(sourceId, '<>', activeGen);

        const programmeStmt = db.prepare(`
            INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, gen, categories, flags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertProgrammes = db.transaction((progs) => {
            for (const p of progs) {
                programmeStmt.run(
                    p.channelId,
                    sourceId,
                    p.start ? p.start.getTime() : 0,
                    p.stop ? p.stop.getTime() : 0,
                    p.title,
                    p.description || p.desc,
                    newGen,
                    categoriesJson(p.category),
                    p.flags || null // 0152: <previously-shown/>, <premiere/>, <new/>, <live/> (epgParser.PROGRAMME_FLAGS)
                );
            }
        });

        // Stream and process in batches (default 1000 programmes per batch)
        try {
            for await (const batch of epgParser.fetchAndParseStreaming(url)) {
                batchCount++;

                // Collect channels from first batch
                if (batch.channels) {
                    allChannels = batch.channels;
                }

                // Save this batch of programmes immediately
                if (batch.programmes.length > 0) {
                    for (const p of batch.programmes) {
                        const stop = p.stop ? p.stop.getTime() : 0;
                        if (stop > lastStop) lastStop = stop;
                    }
                    insertProgrammes(batch.programmes);
                    totalProgrammes += batch.programmes.length;
                }

                // Log progress every 10 batches
                if (batchCount % 10 === 0) {
                    console.log(`[Sync] Processed ${totalProgrammes} programmes so far...`);
                    logMemory();
                }

                // Yield to event loop
                await new Promise(resolve => setImmediate(resolve));
            }

            console.log(`[Sync] EPG Parsed: ${allChannels.length} channels, ${totalProgrammes} programmes`);
            console.log(epgCoverageLine(lastStop));
            logMemory();

            // A feed with no programmes at all is a broken feed, not a guide
            // that has genuinely become empty. Keep what we have.
            if (totalProgrammes === 0) {
                console.warn('[Sync] EPG feed contained no programmes; keeping the existing guide');
                await this.purgeEpgRows(sourceId, '=', newGen);
                return;
            }

            // The swap: one small statement, so readers see the old guide or
            // the new one and never a mixture or an empty table.
            db.prepare(`
                INSERT INTO epg_state (source_id, active_gen) VALUES (?, ?)
                ON CONFLICT(source_id) DO UPDATE SET active_gen = excluded.active_gen
            `).run(sourceId, newGen);

            // 0159: the Sport tab's event list is keyed on the guide version (among
            // other things), which just moved - rebuild it now in the background
            // rather than leaving the first request after this sync to pay for a
            // synchronous build inline.
            try { require('./sportsEvents').scheduleRebuild(); } catch (e) { /* best-effort */ }
            // 0161: an EPG sync landing is also one of the three fixture-refresh triggers
            // (services/sportsFixtures.js) - a newly-synced guide may sport-recognise a league
            // for the first time, and its fixtures should not wait up to 30 minutes for it.
            try { require('./sportsFixtures').scheduleRefresh(); } catch (e) { /* best-effort */ }
        } catch (err) {
            // The live guide was never touched; just discard the half-loaded one.
            await this.purgeEpgRows(sourceId, '=', newGen).catch(e =>
                console.warn('[Sync] Could not discard partial EPG load:', e.message));
            throw err;
        }

        // The previous generation is now unreachable. Delete it in slices so a
        // large guide does not hold the event loop (and every stream) hostage.
        const purged = await this.purgeEpgRows(sourceId, '<>', newGen);
        if (purged > 0) console.log(`[Sync] Removed ${purged} superseded programmes`);

        // Save EPG Channels
        if (allChannels.length > 0) {
            const channelStmt = db.prepare(`
                INSERT INTO playlist_items (
                    id, source_id, item_id, type, name, stream_icon, 
                    stream_url, category_id, data
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    stream_icon = excluded.stream_icon,
                    data = excluded.data
            `);

            const insertChannels = db.transaction((chanList) => {
                for (const ch of chanList) {
                    const id = `${sourceId}:${ch.id}`;
                    channelStmt.run(
                        id,
                        sourceId,
                        ch.id,
                        'epg_channel',
                        ch.name,
                        ch.icon || null,
                        null,
                        null,
                        JSON.stringify(ch)
                    );
                }
            });

            insertChannels(allChannels);
            console.log(`[Sync] Saved ${allChannels.length} EPG channels`);
        }

        console.log(`[Sync] Saved ${totalProgrammes} programmes`);
    }

    /**
     * M3U Sync Logic (Streaming - Memory Efficient)
     * Processes M3U files in batches to avoid OOM on large playlists
     */
    async syncM3u(source) {
        console.log(`[Sync] Fetching M3U playlist for ${source.name}`);

        // Temporary memory logging for verification
        const logMemory = () => {
            const used = process.memoryUsage();
            console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
        };

        logMemory();

        const allGroups = new Set();
        // Just the URLs, for the identity tally below - not the rows.
        const identityUrls = [];
        const allSyncedIds = new Set(); // Collect IDs across all batches
        let totalChannels = 0;
        let batchCount = 0;

        // Stream and process in batches (default 500 channels per batch)
        let credentialsLine = null; // 0168: the playlist's #EXT-X-CREDENTIALS header, if any
        for await (const batch of m3uParser.fetchAndParseStreaming(source.url)) {
            batchCount++;
            if (batch.credentials) credentialsLine = batch.credentials;

            // Map M3U channel format to our schema
            const playlistItems = batch.channels.map(ch => ({
                // Use the entry's position in the M3U file as the unique ID.
                // tvg-id collides for regional feeds sharing an EPG ID.
                // URL hash collides for channels cross-listed in multiple
                // categories or placeholder/header entries with no real URL.
                // Position is the only value guaranteed unique per M3U line.
                stream_id: 'pos_' + (totalChannels + ch.position),
                name: ch.name,
                category_id: ch.groupTitle || 'Uncategorized',
                stream_icon: ch.tvgLogo,
                stream_url: ch.url,
                tvgId: ch.tvgId || null,
                sort_order: totalChannels + ch.position,
            }));

            for (const p of playlistItems) identityUrls.push(p.stream_url || null);

            // Save this batch immediately (skip purge - we'll do it at the end)
            if (playlistItems.length > 0) {
                const batchIds = await this.saveStreams(source.id, 'live', playlistItems, { skipPurge: true });
                batchIds.forEach(id => allSyncedIds.add(id));
                totalChannels += playlistItems.length;
            }

            // Collect groups for category creation at the end
            batch.groups.forEach(g => allGroups.add(g));

            // Log progress every 10 batches
            if (batchCount % 10 === 0) {
                console.log(`[Sync] Processed ${totalChannels} channels so far...`);
                logMemory();
            }
        }

        if (credentialsLine) {
            try { require('./providerAccounts').noteM3uHeader(source.id, credentialsLine); } catch (e) { /* the stream URLs are the fallback */ }
        }

        console.log(`[Sync] M3U Parsed: ${totalChannels} channels, ${allGroups.size} groups`);
        // Evidence that the identity derivation suits this provider, before anything
        // is keyed on it: a large "no URL" or "listed more than once" count would mean
        // the playlist is not shaped the way stableIds.js assumes. Counted from the
        // batches as they go by - re-reading every row and its data blob to tally them
        // would be a memory spike in the one place this code is careful about memory.
        const c = summarise(identityUrls);
        console.log(`[Sync] Channel identity: ${c.providerId} from the provider's stream id, ${c.urlHash} from the URL, `
            + `${c.none} with no URL; ${c.distinct} distinct, ${c.shared} listed more than once`);
        logMemory();

        // Purge stale items after all batches are complete
        if (allSyncedIds.size > 0) {
            await this.purgeStaleItems(source.id, 'live', allSyncedIds);
        }

        // Save Categories (Groups) at the end
        // allGroups is a Set, so iteration order is first-seen order in the
        // M3U. Carry that index through as sort_order so the UI can render
        // categories in the provider's intended sequence (header/placeholder
        // categories sit directly above the categories they introduce).
        const categories = Array.from(allGroups).map((name, idx) => ({
            category_id: name,
            category_name: name,
            parent_id: null,
            sort_order: idx + 1
        }));

        await this.saveCategories(source.id, 'live', categories);
        console.log(`[Sync] M3U sync complete for ${source.name}`);
    }

    /**
     * EPG Source Sync Logic
     */
    async syncEpg(source) {
        console.log(`[Sync] Fetching standalone EPG for ${source.name}`);
        await this.syncEpgFromUrl(source.id, source.url);
    }
}

module.exports = new SyncService();
module.exports.epgCoverageLine = epgCoverageLine; // 0153, for tests
