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
function createStore(db) {
    initSchema(db);
    const preferences = userId => {
        const row=db.prepare('SELECT * FROM sports_user_preferences WHERE user_id=?').get(String(userId));
        return row ? {avoidSpoilers:Boolean(row.avoid_spoilers),scoreDelaySeconds:row.delay_seconds,revision:row.revision} : {avoidSpoilers:false,scoreDelaySeconds:90,revision:0};
    };
    const latest = gameId => {
        const row=db.prepare('SELECT observed_at,data FROM sports_score_history WHERE game_id=? ORDER BY observed_at DESC LIMIT 1').get(gameId);
        return row ? {observedAt:row.observed_at,data:JSON.parse(row.data)} : null;
    };
    return {
        preferences,
        updatePreferences:db.transaction((userId, patch) => {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['avoidSpoilers','scoreDelaySeconds','revision'].includes(k)) ||
                !Number.isSafeInteger(patch.revision) || patch.revision < 0 ||
                (!Object.hasOwn(patch,'avoidSpoilers') && !Object.hasOwn(patch,'scoreDelaySeconds')) ||
                (Object.hasOwn(patch,'avoidSpoilers') && typeof patch.avoidSpoilers !== 'boolean') ||
                (Object.hasOwn(patch,'scoreDelaySeconds') && (!Number.isInteger(patch.scoreDelaySeconds) || patch.scoreDelaySeconds < 0 || patch.scoreDelaySeconds > 300)))
                throw Object.assign(new Error('Invalid sports preferences'),{status:400});
            const current=preferences(userId);
            if(current.revision!==patch.revision) throw Object.assign(new Error('Sports preference conflict'),{status:409});
            const next={...current,...patch,revision:current.revision+1};
            db.prepare('INSERT OR REPLACE INTO sports_user_preferences VALUES(?,?,?,?)').run(String(userId),Number(next.avoidSpoilers),next.scoreDelaySeconds,next.revision);
            return next;
        }),
        ingest:db.transaction((games, at) => {
            if(!Number.isSafeInteger(at) || at<0) throw new Error('Invalid score observation');
            for(const game of games) {
                const previous=db.prepare('SELECT observed_at,finished_at FROM sports_dashboard_catalog WHERE id=?').get(game.id);
                if(previous && previous.observed_at>=at) continue;
                const old=latest(game.id);
                // A partial/malformed status is not evidence that a completed/cancelled game restarted.
                // Retain the last known observation and let its freshness expire instead.
                if (game.snapshot.state === 'unknown' && old && old.data.state !== 'unknown') continue;
                const finishedAt=game.snapshot.state==='finished' ? previous?.finished_at ?? (old && old.data.state!=='finished' ? at : null) : null;
                const {snapshot,...metadata}=game;
                db.prepare('INSERT OR REPLACE INTO sports_dashboard_catalog VALUES(?,?,?,?,?,?)').run(game.id,game.league,game.start,JSON.stringify(metadata),at,finishedAt);
                db.prepare('INSERT INTO sports_score_history VALUES(?,?,?)').run(game.id,at,JSON.stringify(snapshot));
            }
        }),
        catalog:() => db.prepare('SELECT * FROM sports_dashboard_catalog ORDER BY start,id').all().map(r=>({...JSON.parse(r.data),observedAt:r.observed_at,finishedAt:r.finished_at})),
        latest,
        delayed:(gameId, now, delay) => {
            const row=db.prepare('SELECT observed_at,data FROM sports_score_history WHERE game_id=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1').get(gameId,now-delay*1000);
            return row ? {observedAt:row.observed_at,data:JSON.parse(row.data)} : null;
        },
        prune:db.transaction(now => {
            db.prepare('DELETE FROM sports_score_history WHERE observed_at<? AND (game_id,observed_at) NOT IN (SELECT game_id,MAX(observed_at) FROM sports_score_history GROUP BY game_id)').run(now-HISTORY_MS);
            db.prepare('DELETE FROM sports_score_history WHERE game_id IN (SELECT id FROM sports_dashboard_catalog WHERE start<? AND observed_at<?)').run(now-8*86400000,now-86400000);
            db.prepare('DELETE FROM sports_dashboard_catalog WHERE start<? AND observed_at<?').run(now-8*86400000,now-86400000);
        })
    };
}
module.exports = { initSchema, createStore, HISTORY_MS };
