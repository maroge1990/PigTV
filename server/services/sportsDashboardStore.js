/** Isolated persisted catalog/history/preferences for the opt-in sports dashboard. */
const HISTORY_MS = 15 * 60000;
function initSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS sports_dashboard_catalog (
        id TEXT PRIMARY KEY, league TEXT NOT NULL, start INTEGER NOT NULL, data TEXT NOT NULL, observed_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE INDEX IF NOT EXISTS sports_dashboard_start ON sports_dashboard_catalog(start);
        CREATE TABLE IF NOT EXISTS sports_score_history (
        game_id TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, observed_at));
        CREATE INDEX IF NOT EXISTS sports_score_age ON sports_score_history(observed_at);
        CREATE TABLE IF NOT EXISTS sports_user_preferences (
        user_id TEXT PRIMARY KEY, avoid_spoilers INTEGER NOT NULL, delay_seconds INTEGER NOT NULL, revision INTEGER NOT NULL);`);
}
function createStore(db, { readOnly = false } = {}) {
    if (!readOnly) {
        initSchema(db);
        // Upgrade 0309 history once. A final's retention timestamp belongs to that observed
        // snapshot, not to the catalog's latest (possibly corrected) state.
        if (db.prepare("SELECT 1 FROM sports_score_history WHERE json_type(data,'$.finishedAt') IS NULL LIMIT 1").get()) {
            db.transaction(() => {
                const rows = db.prepare('SELECT game_id,observed_at,data FROM sports_score_history ORDER BY game_id,observed_at').all();
                const catalogFinish = db.prepare('SELECT finished_at FROM sports_dashboard_catalog WHERE id=?');
                const update = db.prepare('UPDATE sports_score_history SET data=? WHERE game_id=? AND observed_at=?');
                let id = null, previous = null, finishedAt = null;
                for (const row of rows) {
                    const data = JSON.parse(row.data);
                    if (id !== row.game_id) { id = row.game_id; previous = null; finishedAt = null; }
                    if (Object.hasOwn(data, 'finishedAt')) finishedAt = data.finishedAt;
                    else if (data.state !== 'finished') finishedAt = null;
                    else if (previous && previous !== 'finished') finishedAt = row.observed_at;
                    else if (!previous) {
                        const known = catalogFinish.get(id)?.finished_at;
                        finishedAt = known !== null && known !== undefined && known <= row.observed_at ? known : null;
                    }
                    if (!Object.hasOwn(data, 'finishedAt')) update.run(JSON.stringify({ ...data, finishedAt }), id, row.observed_at);
                    previous = data.state;
                }
            })();
        }
    }
    // Prepared once per connection, including the worker's read-only connection.
    const prefStmt = db.prepare('SELECT * FROM sports_user_preferences WHERE user_id=?');
    const latestStmt = db.prepare('SELECT observed_at,data FROM sports_score_history WHERE game_id=? ORDER BY observed_at DESC LIMIT 1');
    const delayedStmt = db.prepare('SELECT observed_at,data FROM sports_score_history WHERE game_id=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1');
    const catalogStmt = db.prepare('SELECT * FROM sports_dashboard_catalog ORDER BY start,id');
    const selectedStmt = db.prepare(`SELECT h.game_id,h.observed_at,h.data FROM sports_score_history h
        JOIN (SELECT game_id,MAX(observed_at) AS at FROM sports_score_history WHERE observed_at<=? GROUP BY game_id) s
        ON s.game_id=h.game_id AND s.at=h.observed_at`);
    const decode = row => {
        if (!row) return null;
        const { finishedAt, ...data } = JSON.parse(row.data);
        return { observedAt: row.observed_at, finishedAt: finishedAt ?? null, data };
    };
    const preferences = userId => {
        const row = prefStmt.get(String(userId));
        return row ? { avoidSpoilers: Boolean(row.avoid_spoilers), scoreDelaySeconds: row.delay_seconds, revision: row.revision }
            : { avoidSpoilers: false, scoreDelaySeconds: 90, revision: 0 };
    };
    const latest = gameId => decode(latestStmt.get(gameId));
    const catalog = () => catalogStmt.all().map(r => ({ ...JSON.parse(r.data), observedAt: r.observed_at, finishedAt: r.finished_at }));
    const result = {
        preferences, latest, catalog,
        delayed: (gameId, now, delay) => decode(delayedStmt.get(gameId, now - delay * 1000)),
        view: db.transaction((now, delay) => ({ catalog: catalog(), selected: new Map(selectedStmt.all(now - delay * 1000)
            .map(row => [row.game_id, decode(row)])) }))
    };
    if (readOnly) return result;
    const updatePref = db.prepare('INSERT OR REPLACE INTO sports_user_preferences VALUES(?,?,?,?)');
    const previousStmt = db.prepare('SELECT observed_at,finished_at FROM sports_dashboard_catalog WHERE id=?');
    const putCatalog = db.prepare('INSERT OR REPLACE INTO sports_dashboard_catalog VALUES(?,?,?,?,?,?)');
    const putHistory = db.prepare('INSERT INTO sports_score_history VALUES(?,?,?)');
    result.updatePreferences = db.transaction((userId, patch) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['avoidSpoilers','scoreDelaySeconds','revision'].includes(k)) ||
            !Number.isSafeInteger(patch.revision) || patch.revision < 0 ||
            (!Object.hasOwn(patch,'avoidSpoilers') && !Object.hasOwn(patch,'scoreDelaySeconds')) ||
            (Object.hasOwn(patch,'avoidSpoilers') && typeof patch.avoidSpoilers !== 'boolean') ||
            (Object.hasOwn(patch,'scoreDelaySeconds') && (!Number.isInteger(patch.scoreDelaySeconds) || patch.scoreDelaySeconds < 0 || patch.scoreDelaySeconds > 300)))
            throw Object.assign(new Error('Invalid sports preferences'), { status: 400 });
        const current = preferences(userId);
        if (current.revision !== patch.revision) throw Object.assign(new Error('Sports preference conflict'), { status: 409 });
        const next = { ...current, ...patch, revision: current.revision + 1 };
        updatePref.run(String(userId), Number(next.avoidSpoilers), next.scoreDelaySeconds, next.revision);
        return next;
    });
    result.ingestBatch = db.transaction(entries => {
        for (const { game, observedAt: at } of entries) {
            if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid score observation');
            const previous = previousStmt.get(game.id);
            if (previous && previous.observed_at >= at) continue;
            const old = latest(game.id);
            // Unknown/partial status cannot revive a completed or cancelled event.
            if (game.snapshot.state === 'unknown' && old && old.data.state !== 'unknown') continue;
            const finishedAt = game.snapshot.state === 'finished'
                ? previous?.finished_at ?? (old && old.data.state !== 'finished' ? at : null) : null;
            const { snapshot, ...metadata } = game;
            putCatalog.run(game.id, game.league, game.start, JSON.stringify(metadata), at, finishedAt);
            putHistory.run(game.id, at, JSON.stringify({ ...snapshot, finishedAt }));
        }
    });
    result.ingest = (games, at) => result.ingestBatch(games.map(game => ({ game, observedAt: at })));
    const pruneHistory = db.prepare(`DELETE FROM sports_score_history WHERE observed_at<? AND (game_id,observed_at) NOT IN
        (SELECT game_id,MAX(observed_at) FROM sports_score_history GROUP BY game_id)`);
    const pruneOrphans = db.prepare('DELETE FROM sports_score_history WHERE game_id IN (SELECT id FROM sports_dashboard_catalog WHERE start<? AND observed_at<?)');
    const pruneCatalog = db.prepare('DELETE FROM sports_dashboard_catalog WHERE start<? AND observed_at<?');
    result.prune = db.transaction(now => {
        pruneHistory.run(now - HISTORY_MS);
        pruneOrphans.run(now - 8 * 86400000, now - 86400000);
        pruneCatalog.run(now - 8 * 86400000, now - 86400000);
    });
    return result;
}
module.exports = { initSchema, createStore, HISTORY_MS };
