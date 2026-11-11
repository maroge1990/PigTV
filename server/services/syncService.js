const { getDb } = require('../db/sqlite');
const { stripBadgeSuffix } = require('./textCleanup');
const { bumpLibraryRev } = require('./libraryRev');
const { refreshChannelNumbers } = require('./channelNumbers');
const { stableChannelId, providerStreamId, summarise } = require('./stableIds');
const { sources, settings } = require('../db'); // For source config and settings
const xtreamApi = require('./xtreamApi');
const { redact } = require('../redact');
const m3uParser = require('./m3uParser');
const backupChannels = require('./backupChannels');
const hiddenChannels = require('./hiddenChannels');
const epgParser = require('./epgParser');
const feedCheck = require('./feedCheck');

// #237: the heap readings and "so far" progress lines (hundreds a day) only with PIGTV_DEBUG_SYNC=1.
const debugSync = () => process.env.PIGTV_DEBUG_SYNC === '1';
const logMemory = () => {
    if (debugSync()) console.log(`[Sync] Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap`);
};
// #237: what a sync that found its playlist or guide unchanged returns.
const UNCHANGED = Object.freeze({ unchanged: true });

// Sync tracking
const activeSyncs = new Set(); // sourceId

// I-7 (#273): mixed into the result fingerprints (a backup's rows, an Xtream primary's answers). Bump it when the way
// channel rows are derived from a provider's answer changes (names, stream ids, guide ids...), so the next scheduled
// sync rewrites an otherwise unchanged list instead of keeping rows the old code derived. Not used by the M3U
// primary's byte fingerprint (feedCheck.fetchFeed).
const RESULT_FINGERPRINT_VERSION = 1;

/**
 * I-7 (#273): channel rows written whose failover links have not yet been rebuilt. Since a scheduled sync skips an
 * unchanged list, a relink that failed (or a restart before a global sync's deferred relink) would otherwise never be
 * retried. Stored in `meta` as { seq, all, ids: { backupId: seq } }: `all` is owed by a primary's write (relinkAll),
 * `ids` by a backup's (relinkSource). Set before the write and again after it, in a `finally` so a write that throws
 * part-way still owes it (a relink that started in between cannot pay for it); paid only by a relink that ran to the end
 * and started after it was owed. `seq` only ever grows: the row is kept, with nothing owed, once it exists (a reset
 * would let a relink queued earlier pay for a newer debt). Every read/modify/write here is synchronous (better-sqlite3,
 * no await), so two of them never interleave.
 */
const RELINK_OWED_KEY = 'relink_owed';
function readRelinkOwed() {
    try {
        const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(RELINK_OWED_KEY);
        const v = row ? JSON.parse(row.value) : null;
        return v && typeof v === 'object' ? { seq: Number(v.seq) || 0, all: Number(v.all) || 0, ids: v.ids && typeof v.ids === 'object' ? v.ids : {} } : { seq: 0, all: 0, ids: {} };
    } catch { return { seq: 0, all: 0, ids: {} }; }
}
function writeRelinkOwed(owed) {
    // Never deleted: { seq, all: 0, ids: {} } is "nothing owed", and keeps the sequence (see above).
    getDb().prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(RELINK_OWED_KEY, JSON.stringify(owed));
}
/** A relink is owed: of every backup (`backupId` null, a primary's channels moved) or of one backup (its rows moved). */
function oweRelink(backupId) {
    const owed = readRelinkOwed();
    owed.seq++;
    if (backupId == null) owed.all = owed.seq; else owed.ids[String(backupId)] = owed.seq;
    writeRelinkOwed(owed);
}
const relinkIsOwed = () => { const o = readRelinkOwed(); return !!o.all || Object.keys(o.ids).length > 0; };
/**
 * A relink that started at `seq` ran to the end: relinkAll (`backupId` null) pays everything, one backup's its own.
 * Why `<= seq` is safe: `seq` is read (relink()) before channelLinks is called, and channelLinks.relink reads every
 * channel row (allVisible, loadBackup) only after that, inside its serial queue. `seq` never goes down, so a debt
 * `<= seq` was recorded before the snapshot: its write began before this relink read anything. If the write had ended
 * by then, the relink saw it; if not, the write's second oweRelink (in a `finally`, so a throw too) records a newer
 * debt that this relink does not pay. A relink queued behind another only starts later, so it pays less, never more.
 */
function payRelink(backupId, seq) {
    const owed = readRelinkOwed();
    if (backupId == null) {
        if (owed.all && owed.all <= seq) owed.all = 0;
        for (const [id, s] of Object.entries(owed.ids)) if (s <= seq) delete owed.ids[id];
    } else if (owed.ids[String(backupId)] && owed.ids[String(backupId)] <= seq) {
        delete owed.ids[String(backupId)];
    }
    writeRelinkOwed(owed);
}

// 0147: a programme's XMLTV <category> values as stored in epg_programs.categories:
// a JSON array of the provider's strings, trimmed and de-duplicated (case aside),
// at most 12 of up to 100 characters; NULL when there are none.
/**
 * R5: what else the guide says about a programme, kept in epg_programs.data as JSON - `sub` (its
 * <sub-title>) and `ep` (its <episode-num>) - for series rules to tell episodes apart, and (R6)
 * `img`, its <icon>, for a recording's artwork. NULL when it has none of them.
 */
function programmeData(p) {
    const clip = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : null);
    const out = {};
    if (clip(p.subtitle)) out.sub = clip(p.subtitle);
    if (clip(p.episodeNum)) out.ep = clip(p.episodeNum);
    // R6: the programme's image (<icon src>), http(s) only; served through the logo cache, never as is.
    if (typeof p.icon === 'string' && /^https?:\/\//i.test(p.icon.trim()) && p.icon.trim().length <= 500) out.img = p.icon.trim();
    return Object.keys(out).length ? JSON.stringify(out) : null;
}

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

// #42 (0348): a provider answering with a much smaller list (maintenance, an "account expired" placeholder, a
// region-limited list) is held, not applied: the last good playlist or guide stays until a sync brings the usual
// size back, or the admin accepts the smaller one (POST /api/sources/:id/sync { acceptSmaller: true }).
const SHRINK = Object.freeze({ playlist: 0.7, guide: 0.5, minPlaylist: 50, minGuide: 1000, guideHorizonMs: 36 * 3600e3 });
const linesKey = (sourceId) => `playlist_lines:${sourceId}`;

function heldError(message) {
    return Object.assign(new Error(message), { held: true });
}

/** Throws a held error when `count` lines is a shrink against the last good sync's; remembers nothing itself. */
function checkPlaylistSize(db, sourceId, count, { acceptSmaller = false } = {}) {
    const previous = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(linesKey(sourceId))?.value) || storedLines(db, sourceId);
    shrinkCheck(previous, count, acceptSmaller);
}

/** I-7: a backup's assembled list against the size it had at its last good sync (its own key, else its rows). */
const backupLinesKey = (sourceId) => `backup_lines:${sourceId}`;
function checkBackupSize(db, sourceId, count, { acceptSmaller = false } = {}) {
    const previous = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(backupLinesKey(sourceId))?.value)
        || backupChannels.count(sourceId);
    shrinkCheck(previous, count, acceptSmaller);
}
function rememberBackupSize(db, sourceId, count) {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(backupLinesKey(sourceId), String(count));
}

function shrinkCheck(previous, count, acceptSmaller) {
    if (acceptSmaller || previous < SHRINK.minPlaylist || count >= previous * SHRINK.playlist) return;
    throw heldError(`Held: the provider's list had ${count.toLocaleString('en-AU')} of the usual `
        + `${previous.toLocaleString('en-AU')} channels; the last good list is kept`);
}

/**
 * #169: an install upgraded from before 0348 has no stored count: the lineup it already holds is the baseline (its
 * rows, plus the lines the admin's import exclusions skipped at the last sync), so its first sync is guarded too.
 */
function storedLines(db, sourceId) {
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(sourceId).n;
    let skipped = 0;
    try {
        skipped = db.prepare('SELECT COALESCE(SUM(skipped), 0) AS n FROM import_exclusion_stats WHERE source_id = ?').get(sourceId).n;
    } catch (e) { /* no exclusions table yet */ }
    return rows + skipped;
}

function rememberPlaylistSize(db, sourceId, count) {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(linesKey(sourceId), String(count));
}

// #11 (0350): the scheduled sync runs at fixed local times (04:30, then every `epgRefreshInterval` hours from it), not
// on an uptime timer that every redeploy reset; a source whose playlist or guide failed (or was held) is retried
// after 15 min, 1 h and 3 h; and a guide that reaches less than 36 h ahead is raised on Status and by webhook.
const SCHEDULE = { hour: 4, minute: 30, retriesMs: [15 * 60e3, 60 * 60e3, 3 * 3600e3],
    guideShortMs: 36 * 3600e3, guideCheckMs: 60 * 60e3 }; // not frozen: tests shorten the retries

/** The next scheduled run after `now`: local 04:30 plus whole multiples of `intervalHours` (DST-safe: local hours). */
function nextRunAt(now, intervalHours) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(SCHEDULE.hour, SCHEDULE.minute, 0, 0);
    while (d.getTime() <= now) d.setHours(d.getHours() + intervalHours);
    return d.getTime();
}

class SyncService {
    constructor() {
        this.lastSyncTime = null; // Track when global sync last completed
        this._syncTimer = null;   // Server-side sync timer
        this._currentInterval = null;
        this._retries = new Map(); // #11: sourceId -> { attempt, timer }
        this._guideTimer = null;
        this._guideAhead = new Map(); // #11: sourceId -> the active guide's last end (ms)
        this._guideAlerted = new Set();
        this.resultFingerprintVersion = RESULT_FINGERPRINT_VERSION; // I-7: a test may change it
        this._relinkRuns = 0; // I-7: relinks attempted, so a sync knows whether it already tried one
    }

    /** I-7: a result fingerprint (backup rows, Xtream answers), carrying the version of how rows are derived. */
    resultFingerprint(value) {
        return feedCheck.fingerprint({ v: this.resultFingerprintVersion, ...value });
    }

    /**
     * Get when the last global sync completed
     */
    getLastSyncTime() {
        return this.lastSyncTime;
    }

    /** #61 (0368): each enabled source's feeds: { id, name, feeds: [{ type, status, at }] }, from sync_status. */
    async lastSyncs() {
        const rows = getDb().prepare('SELECT source_id, type, status, last_sync FROM sync_status').all();
        return (await sources.getAll()).filter(s => s.enabled).map(s => ({
            id: s.id, name: s.name,
            feeds: rows.filter(r => r.source_id === s.id).map(r => ({ type: r.type, status: r.status, at: r.last_sync }))
        }));
    }

    /**
     * Start the server-side sync timer based on settings
     * Should be called once on server startup after initial sync
     */
    async startSyncTimer() {
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.epgRefreshInterval) || 0;
        this.startGuideWatch();

        // If interval is 0, don't start timer (manual only mode)
        if (intervalHours <= 0) {
            console.log('[Sync] Auto-sync disabled (manual only mode)');
            this.stopSyncTimer();
            this._currentInterval = 0;
            return;
        }

        // Don't restart if interval hasn't changed and timer exists
        if (this._currentInterval === intervalHours && this._syncTimer) {
            console.log(`[Sync] Timer already running for ${intervalHours} hours, not restarting`);
            return;
        }

        this.stopSyncTimer();
        this._currentInterval = intervalHours;
        const schedule = () => {
            const next = nextRunAt(Date.now(), intervalHours);
            console.log(`[Sync] Next scheduled sync at: ${new Date(next).toLocaleString()} (every ${intervalHours} h from 04:30)`);
            this._syncTimer = setTimeout(async () => {
                console.log('[Sync] Scheduled sync triggered');
                try { await this.syncAll({ retry: true, ifChanged: true }); } finally { if (this._syncTimer) schedule(); }
            }, Math.max(1000, next - Date.now()));
            if (this._syncTimer.unref) this._syncTimer.unref();
        };
        schedule();
    }

    /**
     * Stop the server-side sync timer
     */
    stopSyncTimer() {
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
    }

    /** #11: the sync row(s) of a source that failed or were held at its last attempt. */
    failedFeeds(sourceId) {
        return getDb().prepare(`SELECT type, status FROM sync_status WHERE source_id = ? AND status IN ('error', 'held')`).all(sourceId);
    }

    /**
     * #11: sync a source; when its playlist or guide failed (or was held), try again after 15 min, 1 h and 3 h.
     * A later success, or a new scheduled run, ends the series.
     */
    async syncWithRetry(sourceId, attempt = 0, options = {}) {
        const pending = this._retries.get(sourceId);
        if (pending) { clearTimeout(pending.timer); this._retries.delete(sourceId); }
        await this.syncSource(sourceId, options);
        const failed = this.failedFeeds(sourceId);
        if (!failed.length || attempt >= SCHEDULE.retriesMs.length) return;
        const delay = SCHEDULE.retriesMs[attempt];
        console.warn(`[Sync] Source ${sourceId}: ${failed.map(f => `${f.type} ${f.status}`).join(', ')}; trying again in ${Math.round(delay / 60e3)} min`);
        const timer = setTimeout(() => { this.syncWithRetry(sourceId, attempt + 1, options).catch(console.error); }, delay);
        if (timer.unref) timer.unref();
        this._retries.set(sourceId, { attempt: attempt + 1, timer });
    }

    /** #11: how far each source's live guide reaches (its last programme end), re-read after syncs and hourly. */
    guideReach() {
        const rows = getDb().prepare(`SELECT p.source_id AS id, MAX(p.end_time) AS stop FROM epg_programs p
            JOIN epg_state s ON s.source_id = p.source_id AND s.active_gen = p.gen GROUP BY p.source_id`).all();
        return new Map(rows.map(r => [r.id, r.stop]));
    }

    /** #11: raise a guide reaching less than 36 h ahead (webhook once per episode); Status reads `guideAhead()`. */
    async checkGuide(now = Date.now()) {
        let reach;
        try { reach = this.guideReach(); } catch (e) { return; }
        this._guideAhead = reach;
        const all = await sources.getAll();
        for (const source of all) {
            if (!source.enabled || !reach.has(source.id)) continue;
            const short = reach.get(source.id) - now < SCHEDULE.guideShortMs;
            if (!short) { this._guideAlerted.delete(source.id); continue; }
            if (this._guideAlerted.has(source.id)) continue;
            this._guideAlerted.add(source.id);
            const hours = Math.max(0, Math.round((reach.get(source.id) - now) / 3600e3));
            try {
                require('./notify').send('guide-stale', { key: `guide-stale:${source.id}`, title: 'PigTV guide running out',
                    message: `${source.name}'s guide covers only ${hours} hours ahead. Sport pages and recording rules see less until it syncs.` });
            } catch (e) { /* best-effort */ }
        }
    }

    guideAhead() { return this._guideAhead; }

    startGuideWatch() {
        if (this._guideTimer) return;
        this.checkGuide().catch(() => {});
        this._guideTimer = setInterval(() => this.checkGuide().catch(() => {}), SCHEDULE.guideCheckMs);
        if (this._guideTimer.unref) this._guideTimer.unref();
    }

    /**
     * Restart the sync timer with updated settings
     * Called when sync interval setting changes
     */
    async restartSyncTimer() {
        await this.startSyncTimer();
    }

    /**
     * #237: the channel linker runs once, after the last source, however many sources `work` syncs (it ran once per
     * backup and again per primary, 2.4-3.3 s each). A sync that ends after `work` relinks on its own, as before.
     */
    async withOneRelink(work) {
        const outer = !this._relinkDeferred;
        if (outer) this._relinkDeferred = { pending: false };
        const deferred = this._relinkDeferred;
        this._batchDepth = (this._batchDepth || 0) + 1; // #273 C-3: counts the final relink too
        try {
            try {
                return await work();
            } finally {
                if (outer) {
                    this._relinkDeferred = null;
                    // I-7: a relink still owed from an earlier run (it failed, or the server stopped before it) runs
                    // too, though every list was unchanged this time.
                    if (deferred.pending || relinkIsOwed()) await this.relink(null);
                }
            }
        } finally {
            this._batchDepth--;
        }
    }

    /** #273 C-3: true while any sync runs: a multi-source run (gaps and final relink included) or a single source. */
    isSyncingAny() {
        return (this._batchDepth || 0) > 0 || (this._globalDepth || 0) > 0 || activeSyncs.size > 0;
    }

    /** Relink one backup (`backupId`) or every one (null) now, or once at the end of a global sync. */
    async relink(backupId) {
        if (this._relinkDeferred) { this._relinkDeferred.pending = true; return; }
        this._relinkRuns++;
        let seq = 0;
        try {
            seq = readRelinkOwed().seq; // only what was owed before this relink started is paid by it
            const links = require('./channelLinks');
            if (backupId == null && typeof links.relinkAll === 'function') await links.relinkAll();
            else if (backupId != null && typeof links.relinkSource === 'function') await links.relinkSource(backupId);
            payRelink(backupId, seq); // I-7: ran to the end
        } catch (e) {
            if (e && e.code !== 'MODULE_NOT_FOUND') {
                console.warn('[Sync] Relink failed:', redact(e.message));
                // I-7: the debt stays recorded; the next sync, scheduled or not, relinks even if nothing changed.
                try { if (relinkIsOwed()) console.warn('[Sync] Failover links are owed: the next sync relinks'); } catch { /* best-effort */ }
            }
        }
    }

    /**
     * I-7: a sync that relinked nothing itself (its list was unchanged) pays a relink still owed from an earlier run.
     * In a global sync this only asks for the one relink at the end.
     */
    async settleRelinkDebt(runsBefore) {
        if (this._relinkRuns !== runsBefore) return; // it tried one already: a failure waits for the next sync
        const owed = readRelinkOwed();
        const ids = Object.keys(owed.ids);
        if (!owed.all && !ids.length) return;
        await this.relink(!owed.all && ids.length === 1 ? Number(ids[0]) : null);
    }

    /**
     * Sync all enabled sources. `ifChanged` (#237, the scheduled run): a playlist or guide unchanged since its last
     * good sync is not rewritten. "Sync all" from Settings leaves it off, so it always does the whole work.
     */
    async syncAll({ retry = false, ifChanged = false } = {}) {
        console.log('[Sync] Starting global sync...');
        this._globalDepth = (this._globalDepth || 0) + 1;
        try {
            const allSources = await sources.getAll();
            await this.withOneRelink(async () => {
                for (const source of allSources) {
                    if (source.enabled) {
                        // Run sequentially to not overload
                        if (retry) await this.syncWithRetry(source.id, 0, { ifChanged });
                        else await this.syncSource(source.id, { ifChanged });
                    }
                }
            });
            this.checkGuide().catch(() => {});
            this.lastSyncTime = new Date();
            console.log('[Sync] Global sync completed at', this.lastSyncTime.toISOString());
        } catch (err) {
            console.error('[Sync] Global sync failed:', err);
        } finally {
            this._globalDepth--;
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

            await this.withOneRelink(async () => { for (const source of allSources) {
                if (!source.enabled) continue;

                // Check if we have any data at all for this source
                // 0170: a backup provider keeps its channels in backup_channels
                const hasData = source.role === 'backup' && source.type !== 'epg'
                    ? { c: backupChannels.count(source.id) }
                    : db.prepare('SELECT COUNT(*) as c FROM playlist_items WHERE source_id = ?').get(source.id);

                if (!hasData || hasData.c === 0) {
                    console.log(`[Sync] Source "${source.name}" has no data, syncing...`);
                    await this.syncWithRetry(source.id, 0, { ifChanged: true });
                    synced++;
                    continue;
                }

                // #11: each feed on its own (the playlist and the provider's guide): one that failed, was held or
                // was cut off mid-sync is stale whatever its age; otherwise the oldest success decides, against the
                // admin's own interval (Settings, "Sync channels and guide every"), not a field nothing ever set.
                const rows = db.prepare('SELECT type, status, last_sync FROM sync_status WHERE source_id = ?').all(source.id);
                const intervalHours = parseInt((await settings.get()).epgRefreshInterval) || 24;
                const bad = rows.find(r => r.status !== 'success');
                const oldest = rows.length ? Math.min(...rows.map(r => r.last_sync || 0)) : 0;
                const age = Date.now() - oldest;

                if (bad || age > intervalHours * 3600e3) {
                    const desc = bad ? `its ${bad.type} sync ${bad.status === 'success' ? 'is old' : `is ${bad.status}`}`
                        : oldest ? `${Math.round(age / 3600000)}h old` : 'never synced';
                    console.log(`[Sync] Source "${source.name}" is stale (${desc}), syncing...`);
                    await this.syncWithRetry(source.id, 0, { ifChanged: true });
                    synced++;
                } else {
                    console.log(`[Sync] Source "${source.name}" is fresh (${Math.round(age / 3600000)}h old), skipping`);
                }
            } });

            // #61 (0368): only a check that synced something is a sync ("Just now" after every restart misled).
            if (synced === 0) console.log('[Sync] All sources are fresh, no sync needed');
            else this.lastSyncTime = new Date();
        } catch (err) {
            console.error('[Sync] Stale check failed:', err);
        }
    }

    /**
     * Start sync for a source
     */
    async syncSource(sourceId, options = {}) {
        if (activeSyncs.has(sourceId)) {
            console.log(`[Sync] Source ${sourceId} is already syncing`);
            return;
        }

        activeSyncs.add(sourceId);
        const relinkRunsBefore = this._relinkRuns;
        let ran = false; // I-7: the sync got past its checks (a missing or disabled source settles nothing)

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
            ran = true;

            const isBackup = source.role === 'backup' && source.type !== 'epg';
            // #42: a held playlist keeps the last good one; the rest of the sync (the guide) still runs.
            let held = null;
            let unchanged = false; // #237: an M3U playlist or a guide source found as it was: nothing moved
            const holding = async (work) => {
                try { unchanged = (await work()) === UNCHANGED; } catch (e) { if (!e || !e.held) throw e; held = e.message; }
            };
            if (isBackup) {
                await holding(() => this.syncBackup(source, options));
            } else if (source.type === 'xtream') {
                this.dropBackupRows(source.id);
                await holding(() => this.syncXtream(source, options));
            } else if (source.type === 'm3u') {
                this.dropBackupRows(source.id);
                await holding(() => this.syncM3u(source, options));
                await this.syncProviderGuide(source, null, options);
            } else if (source.type === 'epg') {
                await holding(() => this.syncEpg(source, options));
            }

            if (held) {
                console.warn(`[Sync] ${source.name}: ${held}`);
                this.updateSyncStatus(sourceId, 'all', 'held', held);
                return;
            }
            this.updateSyncStatus(sourceId, 'all', 'success');
            // A completed sync (playlist or EPG) can change every guide row, so
            // the guide's "did anything change?" version must move. The EPG
            // generation flip inside syncEpg() also changes epg_state directly,
            // which currentGuideVersion() reads on its own - this bump covers the
            // playlist/category side, which has nothing else recording a change.
            // 0170: a backup provider is not library-facing: nothing it does moves the library.
            if (!isBackup && !unchanged) bumpLibraryRev();
            // 0117: number any channel that is new, refresh the reservations of
            // the ones still here, release numbers reserved for 30 days.
            if (source.type !== 'epg' && !isBackup) refreshChannelNumbers();
            // 0171: the primary's channels may have changed: relink them to the backups (a no-op
            // with no backup provider). After the numbers, so it sees what is visible now.
            if (source.type !== 'epg' && !isBackup) await this.relinkAfterPrimarySync(source, { changed: !unchanged });
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
            // I-7: a relink owed from an earlier sync runs now if this one relinked nothing (held, failed or unchanged).
            if (ran) {
                try { await this.settleRelinkDebt(relinkRunsBefore); } catch (e) { console.warn('[Sync] Owed relink failed:', redact(e && e.message)); }
            }
            activeSyncs.delete(sourceId);
        }
    }

    /** #167: whether a source is syncing now (its rows may be part-way through moving). */
    isSyncing(sourceId) {
        return activeSyncs.has(Number(sourceId));
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
    async syncXtream(source, options = {}) {
        return this.withHiddenChannels(source, (publish) => this.syncXtreamRows(source, options, publish));
    }

    async syncXtreamRows(source, options = {}, publish = () => {}) {
        const api = xtreamApi.createFromSource(source);
        const db = getDb();

        // 1. Live Categories and Streams, both fetched before anything is written (#42: a shrunken list is held)
        console.log(`[Sync] Fetching Live Categories for ${source.name}`);
        const liveCats = await api.getLiveCategories();
        console.log(`[Sync] Fetching Live Streams for ${source.name}`);
        const liveStreams = await api.getLiveStreams();
        // #168: a held list keeps the lineup, but the rest of the sync (the guide above all) still runs; the hold is
        // reported at the end.
        let held = null;
        try { checkPlaylistSize(db, source.id, (liveStreams || []).length, options); } catch (e) { if (!e.held) throw e; held = e; }
        // I-7 (#273): on a scheduled run, the same answers (and the same groups never imported) as the last good write
        // leave the channel rows as they are; the guide below still syncs, as it does for an M3U playlist.
        let same = false;
        if (!held) {
            const importFilters = require('./importFilters');
            // Evaluated once: the set hashed is the set written (a favourite added mid-sync cannot split them).
            const { excluded } = importFilters.applicable(source.id, await importFilters.excludedFor(source.id));
            const hash = this.resultFingerprint({ cats: liveCats, streams: liveStreams, excluded: [...(excluded || [])].sort() });
            const hasRows = !!db.prepare(`SELECT 1 FROM playlist_items WHERE source_id = ? AND type = 'live' LIMIT 1`).get(source.id);
            if (options.ifChanged && hasRows && (liveStreams || []).length > 0 && feedCheck.matches(source.id, 'playlist', hash)) {
                same = true;
                console.log(`[Sync] Playlist for ${source.name} unchanged (the same answers as the last good sync): nothing rewritten`);
            } else {
                feedCheck.forget(source.id, 'playlist'); // a write that dies part-way is never the last good one
                oweRelink(null); // I-7: the channels may move; owed until a relinkAll runs to the end
                try { await this.syncXtreamLive(source, liveCats, liveStreams, excluded); }
                finally { oweRelink(null); } // again after the write, thrown or not: a relink that started during it does not pay for it
                if ((liveStreams || []).length > 0) feedCheck.remember(source.id, 'playlist', hash);
            }
        }
        publish(!held); // #173: hidden channels and new groups settled before the rest downloads (#181: a held list is not new)
        await this.syncXtreamRest(source, api, options);
        if (held) throw held;
        return same ? UNCHANGED : undefined;
    }

    /** The live part of an Xtream sync: groups, channels (R8: minus excluded groups), then stale rows out. */
    async syncXtreamLive(source, liveCats, liveStreams, excludedGroups = undefined) {
        const db = getDb();
        await this.saveCategories(source.id, 'live', liveCats);

        // 2. Live Streams (R8: minus any group the admin never imports); `excludedGroups`: the set the caller hashed
        const importFilters = require('./importFilters');
        const excluded = excludedGroups !== undefined ? excludedGroups
            : importFilters.applicable(source.id, await importFilters.excludedFor(source.id)).excluded;
        const skipped = new Map();
        const keptLive = importFilters.filterItems(liveStreams || [], excluded, skipped);
        const liveIds = await this.saveStreams(source.id, 'live', keptLive, { skipPurge: true });
        // S1 (0240): the provider answered with channels and every one is in an excluded group:
        // that is a deliberate empty import, so the old rows go. An empty answer (no channels at
        // all) still keeps them - it is more likely a provider fault than an empty lineup.
        if ((liveStreams || []).length > 0) await this.purgeStaleItems(source.id, 'live', this.keepBlocked(source.id, excluded, liveIds), { allowEmpty: true });
        if ((liveStreams || []).length > 0) rememberPlaylistSize(db, source.id, liveStreams.length);
        importFilters.recordSkipped(source.id, excluded, skipped);
    }

    /** The rest of an Xtream sync: the guide. Films and series are not downloaded: nothing in PigTV plays them. */
    async syncXtreamRest(source, api, options = {}) {
        // Try to fetch XMLTV if available
        // 0182: the guide address on the provider's card wins; with none, the provider's own XMLTV.
        let ownUrl = null;
        try { ownUrl = api.getXmltvUrl(); } catch (e) { /* no XMLTV address for this login */ }
        await this.syncProviderGuide(source, ownUrl, options); // #170: acceptSmaller reaches the guide too
    }

    /**
     * 0182: the primary provider's guide, stored under the provider's own id: the address on
     * its card (`epgUrl`), else `ownUrl` (an Xtream login's XMLTV). A failure is recorded as
     * the provider's 'epg' sync status and never fails the channel sync; the guide it had is
     * kept. With no address at all, whatever guide it had is removed.
     */
    async syncProviderGuide(source, ownUrl = null, options = {}) {
        const url = source.epgUrl || ownUrl;
        if (!url) {
            await this.dropGuide(source.id);
            return;
        }
        console.log(`[Sync] Fetching EPG for ${source.name}`);
        this.updateSyncStatus(source.id, 'epg', 'syncing');
        try {
            await this.syncEpgFromUrl(source.id, url, options);
            this.updateSyncStatus(source.id, 'epg', 'success');
        } catch (e) {
            if (e && e.held) {
                console.warn(`[Sync] Guide for ${source.name}: ${e.message}`);
                this.updateSyncStatus(source.id, 'epg', 'held', e.message);
                return;
            }
            // The address can carry a login: it is never stored or logged.
            const message = String(redact(e && e.message)).replace(/\bhttps?:\/\/\S+/gi, '[address]').slice(0, 200);
            console.warn(`[Sync] Guide for ${source.name} failed, keeping the previous one: ${message}`);
            this.updateSyncStatus(source.id, 'epg', 'error', message);
        }
    }

    /** 0182: remove a provider's guide (it became a backup, or its guide address was removed). */
    async dropGuide(sourceId) {
        const db = getDb();
        const had = db.prepare('SELECT 1 FROM epg_programs WHERE source_id = ? LIMIT 1').get(sourceId);
        db.prepare(`DELETE FROM sync_status WHERE source_id = ? AND type = 'epg'`).run(sourceId);
        feedCheck.forget(sourceId, 'guide');
        if (!had) return;
        const removed = await this.purgeEpgRows(sourceId, '<>', -1);
        db.prepare('DELETE FROM epg_state WHERE source_id = ?').run(sourceId);
        console.log(`[Sync] Removed ${removed} guide programmes of source ${sourceId}`);
        try { require('./sportsEvents').scheduleRebuild(); } catch (e) { /* best-effort */ }
    }

    /**
     * 0171: relink every backup after a primary sync. Guarded like the backup side: a failure
     * is logged and never fails the sync.
     */
    async relinkAfterPrimarySync(source, { changed = true } = {}) {
        try {
            // 0178 (P9): with a backup configured, this provider's raw Xtream rows are read too
            // (one more API call); with none, nothing is fetched and nothing changes.
            if (source && (await sources.getAll()).some(s => s.role === 'backup' && s.type !== 'epg' && s.enabled)) {
                await require('./rawChannels').fetchFor(source);
            }
        } catch (e) {
            console.warn('[Sync] Raw list fetch failed:', redact(e && e.message));
        }
        // #237: an unchanged playlist moved no channel, so there is nothing to relink for it.
        if (changed) await this.relink(null);
    }

    /**
     * 0170: a source that is a primary (again) has no backup rows.
     */
    dropBackupRows(sourceId) {
        const n = backupChannels.removeFor(sourceId);
        feedCheck.forget(sourceId, 'backup'); // I-7
        // I-7: and its size, so a later return as a backup is not held against the list it had before
        getDb().prepare('DELETE FROM meta WHERE key = ?').run(backupLinesKey(sourceId));
        if (n > 0) console.log(`[Sync] Removed ${n} backup channels of source ${sourceId} (it is a primary now)`);
    }

    /**
     * 0170: a source that became a backup keeps nothing in the library. Returns whether
     * anything was removed (then the library, and the channel numbers, have changed).
     */
    dropLibraryRows(sourceId) {
        const db = getDb();
        const items = db.prepare('DELETE FROM playlist_items WHERE source_id = ?').run(sourceId).changes;
        const cats = db.prepare('DELETE FROM categories WHERE source_id = ?').run(sourceId).changes;
        feedCheck.forget(sourceId, 'playlist');
        if (items + cats === 0) return false;
        console.log(`[Sync] Removed ${items} channels and ${cats} categories of source ${sourceId} from the library (it is a backup now)`);
        return true;
    }

    /**
     * 0170 (multi-provider P2): sync a backup provider. List only: the live categories and
     * streams (Xtream) or the live entries (M3U), no VOD, series or guide. Writes
     * backup_channels alone, replaced in one transaction after everything has been fetched,
     * so a failed fetch leaves the previous rows. Then the optional id overlay, then the linker.
     */
    async syncBackup(source, options = {}) {
        await this.dropGuide(source.id); // 0182: only the primary's guide is shown
        if (this.dropLibraryRows(source.id)) {
            refreshChannelNumbers();
            bumpLibraryRev();
        }

        const rows = [];
        let rawList = null;
        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            console.log(`[Sync] Fetching backup live channels for ${source.name}`);
            const cats = await api.getLiveCategories();
            const streams = await api.getLiveStreams();
            if (!Array.isArray(streams)) throw new Error('The backup provider returned no channel list');
            rawList = require('./rawChannels').toRows(cats, streams);
            const names = new Map((Array.isArray(cats) ? cats : []).map(c => [String(c.category_id), c.category_name]));
            for (const s of streams) {
                if (!s || s.stream_id == null) continue;
                rows.push({
                    streamId: String(s.stream_id),
                    name: stripBadgeSuffix(s.name) || `Channel ${s.stream_id}`,
                    categoryId: s.category_id == null ? null : String(s.category_id),
                    categoryName: names.get(String(s.category_id)) || null,
                    tvgId: s.epg_channel_id || null,
                    logo: s.stream_icon || null,
                    urlData: null
                });
            }
        } else if (source.type === 'm3u') {
            console.log(`[Sync] Fetching backup playlist for ${source.name}`);
            let credentialsLine = null;
            for await (const batch of m3uParser.fetchAndParseStreaming(source.url)) {
                if (batch.credentials) credentialsLine = batch.credentials;
                for (const ch of batch.channels) {
                    const streamId = providerStreamId(ch.url) || stableChannelId(ch.url);
                    if (!streamId) continue;
                    rows.push({
                        streamId,
                        name: ch.name,
                        categoryId: ch.groupTitle || null,
                        categoryName: ch.groupTitle || null,
                        tvgId: backupChannels.realTvgId(ch),
                        logo: ch.tvgLogo || null,
                        urlData: ch.url
                    });
                }
            }
            if (credentialsLine) {
                try { require('./providerAccounts').noteM3uHeader(source.id, credentialsLine); } catch (e) { /* the stream URLs are the fallback */ }
            }
            // 0183: the playlist (an EPGenius M3U is a curated cut) is not all the provider has.
            // With the login the playlist names, the provider's whole list is read too, and the
            // channels the playlist leaves out are added, so they can back the primary up as well.
            rawList = await this.addUnlistedChannels(source, rows);
        } else {
            throw new Error(`A ${source.type} source cannot be a backup`);
        }
        // Nothing listed is a failed fetch, not an empty provider: keep what we had.
        if (!rows.length) throw new Error('The backup provider listed no channels');

        const overlay = source.idOverlayUrl ? await this.fetchOverlay(source) : null;

        // I-7 (#273): fingerprint the assembled result (rows, overlay ids, raw rows), after the download on purpose: an
        // unchanged playlist must not hide channels the provider's own list newly adds. On a scheduled run, the same
        // result as the last good write is not written, refetched or relinked.
        const db = getDb();
        const hash = this.resultFingerprint({ rows, overlay: overlay ? [...overlay.entries()].sort() : null, rawList });
        if (options.ifChanged && backupChannels.count(source.id) > 0 && feedCheck.matches(source.id, 'backup', hash)) {
            console.log(`[Sync] Backup ${source.name} unchanged (the same ${rows.length} channels as the last good sync): nothing rewritten`);
            return UNCHANGED;
        }
        checkBackupSize(db, source.id, rows.length, options); // held: the last good rows stay, nothing is relinked
        feedCheck.forget(source.id, 'backup'); // a write that dies part-way is never the last good one
        oweRelink(source.id); // I-7: owed until this backup's relink runs to the end (a restart before it included)
        try { backupChannels.replaceAll(source.id, rows, overlay); }
        finally { oweRelink(source.id); } // again after the write, thrown or not: a relink that started during it does not pay for it
        rememberBackupSize(db, source.id, rows.length);
        console.log(`[Sync] Backup ${source.name}: ${rows.length} channels${overlay ? `, ${overlay.size} overlay ids` : ''}`);

        // 0178 (P9): the raw rows of every provider, written the same way whatever its role. An
        // Xtream backup's come from the fetch above; an M3U backup's are fetched; the other
        // providers get theirs now if this is the first backup (they were not fetched before).
        let rawOk = false;
        try {
            const rawChannels = require('./rawChannels');
            if (rawList) rawChannels.replaceAll(source.id, rawList);
            else await rawChannels.fetchFor(source);
            await rawChannels.fetchMissing(await sources.getAll(), source.id);
            rawOk = true;
        } catch (e) {
            console.warn('[Sync] Raw rows after backup sync failed:', redact(e && e.message));
        }
        if (rawOk) feedCheck.remember(source.id, 'backup', hash); // only a write that finished whole is the last good one

        await this.relink(source.id);
    }

    /**
     * 0183: for an M3U backup whose login is known (its playlist header, a stream address or
     * its get.php address), read the provider's whole Xtream list and append the channels the
     * playlist does not carry: name, category and guide id as the provider gives them, the
     * stream address built from the login. The playlist's own rows are left as they are (they
     * carry the EPGenius ids). Returns the raw rows for provider_raw_channels, or null when
     * there is no login or the provider could not be read (then the playlist alone is used).
     */
    async addUnlistedChannels(source, rows) {
        const accounts = require('./providerAccounts');
        const login = accounts.deriveLogin(source) || rows.map(r => accounts.loginFromStreamUrl(r.urlData)).find(Boolean);
        if (!login) return null;
        try {
            const api = new xtreamApi.XtreamApi(login.url, login.username, login.password);
            const cats = await api.getLiveCategories();
            const streams = await api.getLiveStreams();
            if (!Array.isArray(streams) || !streams.length) throw new Error('no channel list');
            const names = new Map((Array.isArray(cats) ? cats : []).map(c => [String(c.category_id), c.category_name]));
            const listed = new Set(rows.map(r => r.streamId));
            let added = 0;
            for (const s of streams) {
                if (!s || s.stream_id == null || listed.has(String(s.stream_id))) continue;
                listed.add(String(s.stream_id));
                rows.push({
                    streamId: String(s.stream_id),
                    name: stripBadgeSuffix(s.name) || `Channel ${s.stream_id}`,
                    categoryId: s.category_id == null ? null : String(s.category_id),
                    categoryName: names.get(String(s.category_id)) || null,
                    tvgId: s.epg_channel_id || null,
                    logo: s.stream_icon || null,
                    urlData: api.buildStreamUrl(s.stream_id, 'live', 'ts'),
                    listed: false // #15: not in the playlist, so not a channel this provider would have as the primary
                });
                added++;
            }
            console.log(`[Sync] Backup ${source.name}: ${added} channels the playlist leaves out were added from the provider's own list`);
            return require('./rawChannels').toRows(cats, streams);
        } catch (e) {
            console.warn(`[Sync] The provider's own list for ${source.name} could not be read, using the playlist alone: ${redact(e && e.message)}`);
            return null;
        }
    }

    /**
     * 0170: the id overlay of a backup: an EPGenius M3U whose tvg-ids are copied onto the raw
     * list by stream id. Returns Map(stream id -> tvg-id). A failure is logged (redacted, no
     * URL) and is not fatal: the overlay values the rows already have are kept.
     */
    async fetchOverlay(source) {
        try {
            const map = new Map();
            for await (const batch of m3uParser.fetchAndParseStreaming(source.idOverlayUrl)) {
                for (const ch of batch.channels) {
                    const id = providerStreamId(ch.url);
                    const tvg = backupChannels.realTvgId(ch);
                    if (id && tvg) map.set(id, tvg);
                }
            }
            return map;
        } catch (e) {
            console.warn(`[Sync] Overlay for ${source.name} failed, keeping the previous ids: ${redact(e && e.message)}`);
            return backupChannels.overlayOf(source.id);
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
            INSERT INTO categories (id, source_id, category_id, type, name, sort_order, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
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
                stmt.run(id, sourceId, String(catId), type, name,
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
     * Batch save live streams
     * Also purges stale entries that no longer exist in the source (unless skipPurge is true)
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (always 'live')
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
                stream_icon, stream_url, sort_order, data, stable_id, tvg_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                category_id = excluded.category_id,
                stream_icon = excluded.stream_icon,
                sort_order = excluded.sort_order,
                data = excluded.data,
                -- Rewritten every sync: the position moves, the identity does not,
                -- so a row that changes position must not keep a stale identity.
                stable_id = excluded.stable_id,
                tvg_id = excluded.tvg_id
        `);

        const insertBatch = db.transaction((batch) => {
            for (const item of batch) {
                const itemId = item.stream_id;
                // 0138: the Xtream path too (the M3U parser already strips it).
                const name = stripBadgeSuffix(item.name) || `Channel ${item.stream_id}`;
                const catId = item.category_id;
                const icon = item.stream_icon;

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
     * S2 (0240): the purge is where an excluded group's rows are deleted. A group that became
     * protected while this sync ran (a favourite or a schedule added since it filtered) keeps the
     * rows it has: they are added to the ids kept. Returns the set to keep.
     */
    keepBlocked(sourceId, excluded, syncedIds) {
        const importFilters = require('./importFilters');
        const { blocked } = importFilters.applicable(sourceId, excluded);
        if (blocked.length === 0) return syncedIds;
        const keep = new Set(syncedIds);
        const rows = getDb().prepare(`SELECT id FROM playlist_items WHERE source_id = ? AND type = 'live' AND category_id = ?`);
        for (const b of blocked) for (const r of rows.all(sourceId, b.id)) keep.add(r.id);
        return keep;
    }

    /**
     * Purge stale items that are no longer in the source
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Set} syncedIds - Set of IDs that should be kept
     */
    async purgeStaleItems(sourceId, type, syncedIds, { allowEmpty = false } = {}) {
        if (!syncedIds || (syncedIds.size === 0 && !allowEmpty)) return;

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
    async syncEpgFromUrl(sourceId, url, { acceptSmaller = false, ifChanged = false } = {}) {
        console.log(`[Sync] Fetching EPG from: ${redact(url).slice(0, 80)}...`);
        logMemory();

        const db = getDb();
        // The guide stays live while the new feed loads. Programmes are written
        // as the *next* generation, which readers (the epg_live view) cannot
        // see, and only once the whole feed is in does epg_state flip to it.
        const activeGen = db.prepare('SELECT active_gen FROM epg_state WHERE source_id = ?').get(sourceId)?.active_gen ?? 0;
        // #237: downloaded and fingerprinted first; on a scheduled run, a guide as it was is not rewritten.
        const hasRows = !!db.prepare('SELECT 1 FROM epg_programs WHERE source_id = ? AND gen = ? LIMIT 1').get(sourceId, activeGen);
        const feed = await feedCheck.fetchFeed({ sourceId, kind: 'guide', url, compare: ifChanged, hasRows });
        if (feed.unchanged) {
            console.log(`[Sync] Guide unchanged (${feed.how}): the current guide is kept, nothing rewritten`);
            return UNCHANGED;
        }
        try {
            // #237 (Codex round 1, high): the last good guide only once every write of it is done, the old generation's
            // removal and the guide channels included, so a scheduled retry repairs a half-finished import.
            if (await this.loadEpgFile(sourceId, url, feed, activeGen, { acceptSmaller })) feed.commit();
        } finally {
            feed.discard();
        }
    }

    /** The guide `feed` (downloaded by feedCheck) written as the next generation, then swapped in. */
    async loadEpgFile(sourceId, url, feed, activeGen, { acceptSmaller = false } = {}) {
        const db = getDb();
        let allChannels = [];
        let totalProgrammes = 0;
        let batchCount = 0;
        let lastStop = 0; // 0153: how far ahead the feed reaches (the Sport list looks 72 h ahead)
        const newGen = activeGen + 1;
        // Anything not live at this point is debris from an interrupted sync.
        await this.purgeEpgRows(sourceId, '<>', activeGen);

        const programmeStmt = db.prepare(`
            INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, gen, categories, flags, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    p.flags || null, // 0152: <previously-shown/>, <premiere/>, <new/>, <live/> (epgParser.PROGRAMME_FLAGS)
                    programmeData(p) // R5: subtitle and episode number
                );
            }
        });

        // Stream and process in batches (default 1000 programmes per batch)
        try {
            for await (const batch of epgParser.parseFileStreaming(feed.file, url, feed.contentType)) {
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
                if (batchCount % 10 === 0 && debugSync()) {
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
                return false;
            }

            // #42: a guide much smaller, or reaching much less far ahead, than the one on screen is held.
            if (!acceptSmaller) {
                const prev = db.prepare(`SELECT COUNT(*) AS n, MAX(end_time) AS stop FROM epg_programs
                    WHERE source_id = ? AND gen = ?`).get(sourceId, activeGen);
                const now = Date.now();
                const prevAhead = (prev.stop || 0) - now;
                const shrunk = prev.n >= SHRINK.minGuide && totalProgrammes < prev.n * SHRINK.guide;
                const shorter = prevAhead > SHRINK.guideHorizonMs && (lastStop - now) < prevAhead * SHRINK.guide;
                if (shrunk || shorter) {
                    await this.purgeEpgRows(sourceId, '=', newGen);
                    const hours = (ms) => Math.max(0, Math.round(ms / 3600e3));
                    throw heldError(shrunk
                        ? `Held: the guide had ${totalProgrammes.toLocaleString('en-AU')} programmes against `
                          + `${prev.n.toLocaleString('en-AU')} last time; the last good guide is kept`
                        : `Held: the guide reached ${hours(lastStop - now)} h ahead against ${hours(prevAhead)} h; the last good guide is kept`);
                }
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
            // R4: a recording's end follows the guide that just landed.
            try { require('./recordingEngine').followGuide(); } catch (e) { /* best-effort */ }
            // R5: recording rules act on the guide that just landed.
            try { require('./recordingRules').evaluate().catch(() => {}); } catch (e) { /* best-effort */ }
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
        return true;
    }

    /**
     * M3U Sync Logic (Streaming - Memory Efficient)
     * Processes M3U files in batches to avoid OOM on large playlists
     */
    /**
     * #10 (0347): around a playlist sync, hidden channels follow their channel, not their line (hiddenChannels.js).
     * The record is re-applied even when the sync fails part-way, since the rows it did write may have moved.
     */
    async withHiddenChannels(source, work) {
        const db = getDb();
        const state = hiddenChannels.before(db, source.id);
        let published = false;
        // #173: run as soon as the live rows are written (Xtream calls it before films, series and the guide), and
        // with the pre-sync snapshot even when the sync fails later, so a new group is never left on screen.
        // #181: `complete` is false when the live import failed part-way (or was held): the hidden channels are still
        // settled, but a promotion's plan waits for a sync that wrote the whole list.
        const publish = (complete = true) => {
            if (published) return;
            published = true;
            const listed = hiddenChannels.after(db, source.id, state);
            if (listed.length) console.log(`[Sync] ${listed.length} new group(s) on ${source.name} arrive hidden, listed for review: ${listed.map(g => g.name).join(', ')}`);
            if (!complete) return;
            // #15 (0374): a backup just made the primary takes over the old primary's lineup through its links.
            try {
                const carried = require('./providerPromotion').applyIfPlanned(db, source.id);
                if (carried) console.log(`[Sync] ${source.name} is the primary now: ${carried.shown} channels shown (${carried.visibility === 'own' ? 'its own earlier choice' : 'as on the old primary'}; ${carried.hidden} hidden), ${carried.numbers} numbers, ${carried.favourites} favourites, ${carried.guideMatches} guide matches, ${carried.seriesRules} series rules and ${carried.schedules} recordings carried over`);
            } catch (e) {
                console.error(`[Sync] Carrying the lineup over to ${source.name} failed (kept for the next sync): ${e.message}`);
            }
        };
        let ok = false;
        try {
            const result = await work(publish);
            ok = true;
            return result;
        } finally {
            publish(ok);
        }
    }

    async syncM3u(source, options = {}) {
        return this.withHiddenChannels(source, () => this.syncM3uRows(source, options));
    }

    async syncM3uRows(source, options = {}) {
        console.log(`[Sync] Fetching M3U playlist for ${source.name}`);
        logMemory();

        // R8: groups never imported. Filtered after the positions are given out, so every
        // other line keeps its pos_N id whatever is excluded.
        const importFilters = require('./importFilters');
        const { excluded } = importFilters.applicable(source.id, await importFilters.excludedFor(source.id));
        const skipped = new Map();

        // #237: downloaded and fingerprinted first (with the groups never imported, which decide the rows too); on a
        // scheduled run, a playlist as it was is not rewritten.
        const hasRows = !!getDb().prepare(`SELECT 1 FROM playlist_items WHERE source_id = ? AND type = 'live' LIMIT 1`).get(source.id);
        const feed = await feedCheck.fetchFeed({ sourceId: source.id, kind: 'playlist', url: source.url,
            scope: JSON.stringify([...(excluded || [])].sort()), compare: !!options.ifChanged, hasRows });
        if (feed.unchanged) {
            console.log(`[Sync] Playlist for ${source.name} unchanged (${feed.how}): nothing rewritten`);
            return UNCHANGED;
        }
        try {
            await this.loadM3uFile(source, options, feed, { excluded, skipped, importFilters }); // owes a relink (I-7)
            feed.commit();
        } finally {
            feed.discard();
        }
    }

    /** The playlist `feed` (downloaded by feedCheck) written; held (#42) when much smaller than the last. */
    async loadM3uFile(source, options, feed, { excluded, skipped, importFilters }) {
        const allGroups = new Set();
        const pending = []; // #42: the parsed batches, written once the size is known
        // Just the URLs, for the identity tally below - not the rows.
        const identityUrls = [];
        const allSyncedIds = new Set(); // Collect IDs across all batches
        let totalChannels = 0;
        let batchCount = 0;
        let credentialsLine = null; // 0168: the playlist's #EXT-X-CREDENTIALS header, if any
        for await (const batch of m3uParser.parseFileStreaming(feed.file)) {
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

            // Kept until the whole list is in (#42: a shrunken list is held before anything is written)
            if (playlistItems.length > 0) {
                pending.push(importFilters.filterItems(playlistItems, excluded, skipped));
                totalChannels += playlistItems.length; // every line counts towards the positions
            }

            // Collect groups for category creation at the end
            batch.groups.forEach(g => allGroups.add(g));

            // Log progress every 10 batches
            if (batchCount % 10 === 0 && debugSync()) {
                console.log(`[Sync] Processed ${totalChannels} channels so far...`);
                logMemory();
            }
        }

        checkPlaylistSize(getDb(), source.id, totalChannels, options);
        oweRelink(null); // I-7: the channels may move; owed until a relinkAll runs to the end
        try {
            for (const imported of pending) {
                const batchIds = await this.saveStreams(source.id, 'live', imported, { skipPurge: true });
                batchIds.forEach(id => allSyncedIds.add(id));
            }
            pending.length = 0;

            if (credentialsLine) {
                try { require('./providerAccounts').noteM3uHeader(source.id, credentialsLine); } catch (e) { /* the stream URLs are the fallback */ }
            }
            importFilters.recordSkipped(source.id, excluded, skipped);

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

            // Purge stale items after all batches are complete. S1 (0240): also when every line was in
            // an excluded group (a parsed playlist with channels, none imported); never when the
            // playlist itself had no channels.
            if (totalChannels > 0) {
                await this.purgeStaleItems(source.id, 'live', this.keepBlocked(source.id, excluded, allSyncedIds), { allowEmpty: true });
                rememberPlaylistSize(getDb(), source.id, totalChannels);
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
        } finally {
            oweRelink(null); // I-7: again after the write, thrown or not: a relink that started during it does not pay for it
        }
        console.log(`[Sync] M3U sync complete for ${source.name}`);
    }

    /**
     * EPG Source Sync Logic
     */
    async syncEpg(source, options = {}) {
        console.log(`[Sync] Fetching standalone EPG for ${source.name}`);
        return this.syncEpgFromUrl(source.id, source.url, options);
    }
}

module.exports = new SyncService();
module.exports.epgCoverageLine = epgCoverageLine; // 0153, for tests
module.exports.programmeData = programmeData; // R5, for tests
module.exports.SHRINK = SHRINK; // #42, for tests
module.exports.nextRunAt = nextRunAt; // #11, for tests
module.exports.SCHEDULE = SCHEDULE;
module.exports.RESULT_FINGERPRINT_VERSION = RESULT_FINGERPRINT_VERSION; // I-7, for tests
module.exports.RELINK_OWED_KEY = RELINK_OWED_KEY; // I-7, for tests
