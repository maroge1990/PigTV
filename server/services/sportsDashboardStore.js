/**
 * Isolated persisted catalog/history/preferences for the opt-in sports dashboard.
 *
 * #272 (I-3, 0549): a history row is written only when a game's observed state changes (the snapshot: status, break,
 * clock/period, scores, situation, and its final time), or when an answer comes after more than CONFIRM_GAP_MS of
 * silence; an unchanged answer moves only the catalogue row's `observed_at`, the game's last-confirmed time. A row a newer
 * one supersedes keeps `confirmed_at`, the last fetch that still saw it. Readers credit a snapshot with its last
 * confirmation (never later than the delayed time asked for), so freshness reads as it did with a row per fetch: a quiet
 * game stays fresh, one ESPN stops answering for goes stale on time. The gap rule keeps that exact: a confirmation after a
 * silence of more than two minutes (the freshness allowance) is its own row, so it never vouches for the silence.
 *
 * #272 (D-1): `sports_dashboard_coverage`, one row per league: the last complete scoreboard window the collector holds.
 */
const HISTORY_MS = 15 * 60000;
const MAX_DELAY_MS = 300000; // scoreDelaySeconds is at most 300
const CONFIRM_GAP_MS = 120000; // sportsDashboard's freshness allowance: an answer after a longer silence is a row
function initSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS sports_dashboard_catalog (
        id TEXT PRIMARY KEY, league TEXT NOT NULL, start INTEGER NOT NULL, data TEXT NOT NULL, observed_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE INDEX IF NOT EXISTS sports_dashboard_start ON sports_dashboard_catalog(start);
        CREATE TABLE IF NOT EXISTS sports_score_history (
        game_id TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL, confirmed_at INTEGER, PRIMARY KEY(game_id, observed_at));
        CREATE INDEX IF NOT EXISTS sports_score_age ON sports_score_history(observed_at);
        CREATE TABLE IF NOT EXISTS sports_user_preferences (
        user_id TEXT PRIMARY KEY, avoid_spoilers INTEGER NOT NULL, delay_seconds INTEGER NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sports_dashboard_coverage (
        league TEXT PRIMARY KEY, covered_from INTEGER NOT NULL, covered_to INTEGER NOT NULL, observed_at INTEGER NOT NULL, listed TEXT NOT NULL,
        teams TEXT);`);
    // #272 (0549): a history table from before 0549 (one row per fetch) gains confirmed_at; its rows keep NULL (their own time).
    if (!hasConfirmed(db)) db.exec('ALTER TABLE sports_score_history ADD COLUMN confirmed_at INTEGER');
    if (!db.prepare("SELECT 1 FROM pragma_table_info('sports_dashboard_coverage') WHERE name='teams'").get()) db.exec('ALTER TABLE sports_dashboard_coverage ADD COLUMN teams TEXT');
}
const hasConfirmed = (db) => !!db.prepare("SELECT 1 FROM pragma_table_info('sports_score_history') WHERE name='confirmed_at'").get();
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
    // #272 (0549): a row's last confirmation: its confirmed_at once superseded; the newest row's is the catalogue's
    // last-confirmed time; a row from before 0549 (a row per fetch) its own time. A read-only connection to a database not
    // yet upgraded (the worker's) reads every row as before 0549.
    const confirmed = `MAX(h.observed_at, COALESCE(${hasConfirmed(db) ? 'h.confirmed_at' : 'NULL'},
        CASE WHEN h.observed_at=(SELECT MAX(x.observed_at) FROM sports_score_history x WHERE x.game_id=h.game_id)
            THEN (SELECT c.observed_at FROM sports_dashboard_catalog c WHERE c.id=h.game_id) END, h.observed_at)) AS confirmed`;
    const latestStmt = db.prepare(`SELECT h.observed_at,h.data,${confirmed} FROM sports_score_history h WHERE h.game_id=? ORDER BY h.observed_at DESC LIMIT 1`);
    const delayedStmt = db.prepare(`SELECT h.observed_at,h.data,${confirmed} FROM sports_score_history h WHERE h.game_id=? AND h.observed_at<=? ORDER BY h.observed_at DESC LIMIT 1`);
    const catalogStmt = db.prepare('SELECT * FROM sports_dashboard_catalog ORDER BY start,id');
    const selectedStmt = db.prepare(`SELECT h.game_id,h.observed_at,h.data,${confirmed} FROM sports_score_history h
        JOIN (SELECT game_id,MAX(observed_at) AS at FROM sports_score_history WHERE observed_at<=? GROUP BY game_id) s
        ON s.game_id=h.game_id AND s.at=h.observed_at`);
    // `observedAt`: when the snapshot was last confirmed, at most `asOf` (the delayed time) when one is asked for.
    const decode = (row, asOf = Infinity) => {
        if (!row) return null;
        const { finishedAt, ...data } = JSON.parse(row.data);
        return { observedAt: Math.min(row.confirmed ?? row.observed_at, asOf), finishedAt: finishedAt ?? null, data };
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
        delayed: (gameId, now, delay) => decode(delayedStmt.get(gameId, now - delay * 1000), now - delay * 1000),
        view: db.transaction((now, delay) => ({ catalog: catalog(), selected: new Map(selectedStmt.all(now - delay * 1000)
            .map(row => [row.game_id, decode(row, now - delay * 1000)])) }))
    };
    if (readOnly) return result;
    const updatePref = db.prepare('INSERT OR REPLACE INTO sports_user_preferences VALUES(?,?,?,?)');
    const previousStmt = db.prepare('SELECT observed_at,finished_at FROM sports_dashboard_catalog WHERE id=?');
    const putCatalog = db.prepare('INSERT OR REPLACE INTO sports_dashboard_catalog VALUES(?,?,?,?,?,?)');
    const putHistory = db.prepare('INSERT INTO sports_score_history(game_id,observed_at,data) VALUES(?,?,?)');
    const newestStmt = db.prepare('SELECT observed_at,data,confirmed_at FROM sports_score_history WHERE game_id=? ORDER BY observed_at DESC LIMIT 1');
    const confirmStmt = db.prepare('UPDATE sports_score_history SET confirmed_at=? WHERE game_id=? AND observed_at=?');
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
            const record = JSON.stringify({ ...snapshot, finishedAt });
            // #272 (0549): a row only when the state changed, or after a silence longer than the freshness allowance; the
            // superseded row keeps the last fetch that saw it (the catalogue's time until now).
            const newest = newestStmt.get(game.id);
            if (!newest || newest.data !== record || !previous || at - previous.observed_at > CONFIRM_GAP_MS) {
                if (newest && previous && newest.confirmed_at === null && previous.observed_at >= newest.observed_at) confirmStmt.run(previous.observed_at, game.id, newest.observed_at);
                putHistory.run(game.id, at, record);
            }
            putCatalog.run(game.id, game.league, game.start, JSON.stringify(metadata), at, finishedAt);
        }
    });
    // #272 (D-1): a league's last complete scoreboard window (every day of it answered): the span it covers, its oldest
    // answer's time and the games it listed. What the guide's classifier reads as "ESPN checked and found..." (sportsFixtures
    // snapshot). Kept apart from sport_fixture_status, which a build before this one reads with its own fixtures.
    const putCoverage = db.prepare(`INSERT INTO sports_dashboard_coverage (league, covered_from, covered_to, observed_at, listed, teams) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(league) DO UPDATE SET covered_from = excluded.covered_from, covered_to = excluded.covered_to,
            observed_at = excluded.observed_at, listed = excluded.listed, teams = excluded.teams`);
    // `teams`: every team those answers name (sportsFixturesEspn.teamsFromScoreboard), a league's roster where ESPN's /teams
    // has none (cricket) or does not answer, as the fixture refresh used its own scoreboards' (sportsFixtures.refreshRoster).
    result.putCoverage = (league, { from, to, at, listed, teams = [] }) => putCoverage.run(league, from, to, at, JSON.stringify(listed), JSON.stringify(teams));
    result.ingest = (games, at) => result.ingestBatch(games.map(game => ({ game, observedAt: at })));
    // #212: cards that turned out not to be their league's (sportsDashboard's collector), with their history.
    const forgetHistory = db.prepare('DELETE FROM sports_score_history WHERE game_id=?');
    const forgetCatalog = db.prepare('DELETE FROM sports_dashboard_catalog WHERE id=?');
    result.forget = db.transaction(ids => { for (const id of ids) { forgetHistory.run(id); forgetCatalog.run(id); } });
    // Also keep each game's newest row at or before now - max delay: a slowly polled game's only
    // delayed-eligible snapshot can be older than the window, and losing it buffers or revives a final.
    const pruneHistory = db.prepare(`DELETE FROM sports_score_history WHERE observed_at<? AND (game_id,observed_at) NOT IN
        (SELECT game_id,MAX(observed_at) FROM sports_score_history GROUP BY game_id) AND (game_id,observed_at) NOT IN
        (SELECT game_id,MAX(observed_at) FROM sports_score_history WHERE observed_at<=? GROUP BY game_id)`);
    const pruneOrphans = db.prepare('DELETE FROM sports_score_history WHERE game_id IN (SELECT id FROM sports_dashboard_catalog WHERE start<? AND observed_at<?)');
    const pruneCatalog = db.prepare('DELETE FROM sports_dashboard_catalog WHERE start<? AND observed_at<?');
    result.prune = db.transaction(now => {
        pruneHistory.run(now - HISTORY_MS, now - MAX_DELAY_MS);
        pruneOrphans.run(now - 8 * 86400000, now - 86400000);
        pruneCatalog.run(now - 8 * 86400000, now - 86400000);
    });
    return result;
}
module.exports = { initSchema, createStore, HISTORY_MS, CONFIRM_GAP_MS };
