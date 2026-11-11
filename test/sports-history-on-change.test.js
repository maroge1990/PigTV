const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const Database = require('better-sqlite3');
const espn = require('../server/services/sportsScoresEspn');
const { createStore } = require('../server/services/sportsDashboardStore');

// #272 (I-3, 0549): the score collector wrote a history row for every game on every fetch, changed or not. Now a row is
// written only when the game's observed state changes (status, scores, period/clock, situation, final time); the catalogue
// row's observed_at is the game's last-confirmed time (every successful fetch moves it), and a superseded row keeps
// `confirmed_at`, the last fetch that still saw it. Freshness reads those, never the row's own first-seen time.
const NOW = Date.parse('2026-10-29T01:00Z'), S = 1000, M = 60 * S;
const databases = [];
const open = () => { const db = new Database(':memory:'); databases.push(db); return db; };
after(() => databases.forEach(db => db.close()));
const fresh = (r, now, delay) => r !== null && now - r.observedAt <= delay * S + 120 * S; // sportsDashboard.buildDashboard's rule

// A real game's catalogue entry (A-League, from ESPN's stored scoreboard), its snapshot scripted through a match.
const [base] = espn.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/espn/league/aleague-scoreboard.json'), 'utf8')), 'A-League', 'soccer/aus.1');
const snap = (state, scores = null, progress = {}, extra = {}) => ({ ...base, snapshot: { state, progress, scores, situation: null, ...extra } });
const historyRows = (db, id) => db.prepare('SELECT COUNT(*) AS n FROM sports_score_history WHERE game_id=?').get(id).n;

test('unchanged fetches write no history row, and the last-confirmed time still advances', () => {
    const db = open(), s = createStore(db);
    for (let i = 0; i < 4; i++) s.ingest([snap('live', ['1', '0'], { clock: "23'", period: 1 })], NOW + i * 30 * S);
    assert.equal(historyRows(db, base.id), 1, 'one row for four identical answers (0548 wrote four)');
    assert.equal(s.latest(base.id).observedAt, NOW + 90 * S, 'latest is as recent as the last fetch');
    assert.equal(s.catalog()[0].observedAt, NOW + 90 * S);
    s.ingest([snap('live', ['1', '0'], { clock: "24'", period: 1 })], NOW + 120 * S);
    assert.equal(historyRows(db, base.id), 2, 'the clock moved: a row');
});

test('a quiet live game does not go stale; one that stops updating does, on time', () => {
    const s = createStore(open()), delay = 90;
    let now = NOW;
    for (; now <= NOW + 20 * M; now += 30 * S) {
        s.ingest([snap('live', ['0', '0'], { clock: 'HT', period: 1 })], now);
        if (now >= NOW + delay * S) assert.ok(fresh(s.delayed(base.id, now, delay), now, delay), `stale at +${(now - NOW) / S}s`);
    }
    const last = now - 30 * S; // no more answers from here
    assert.ok(fresh(s.delayed(base.id, last + delay * S + 120 * S, delay), last + delay * S + 120 * S, delay), 'fresh until the allowance ends');
    assert.equal(fresh(s.delayed(base.id, last + delay * S + 121 * S, delay), last + delay * S + 121 * S, delay), false, 'stale one second later');
    // the score delay still hides a change until it is eligible
    s.ingest([snap('live', ['1', '0'], { clock: "52'", period: 2 })], last + 5 * M);
    assert.deepEqual(s.delayed(base.id, last + 5 * M + 89 * S, delay).data.scores, ['0', '0']);
    assert.deepEqual(s.delayed(base.id, last + 5 * M + 90 * S, delay).data.scores, ['1', '0']);
});

// ---- the old write rule, as 0548 had it (a row per fetch; its three readers), for the equivalence below ----------
function oldStore(db) {
    db.exec(`CREATE TABLE c (id TEXT PRIMARY KEY, observed_at INTEGER, finished_at INTEGER);
        CREATE TABLE h (game_id TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, observed_at));`);
    const decode = row => { if (!row) return null; const { finishedAt, ...data } = JSON.parse(row.data); return { observedAt: row.observed_at, finishedAt: finishedAt ?? null, data }; };
    const latest = id => decode(db.prepare('SELECT observed_at,data FROM h WHERE game_id=? ORDER BY observed_at DESC LIMIT 1').get(id));
    return {
        rows: 0, latest,
        delayed: (id, now, delay) => decode(db.prepare('SELECT observed_at,data FROM h WHERE game_id=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1').get(id, now - delay * S)),
        selected(now, delay) {
            return new Map(db.prepare(`SELECT h.game_id,h.observed_at,h.data FROM h JOIN (SELECT game_id,MAX(observed_at) AS at FROM h WHERE observed_at<=? GROUP BY game_id) s
                ON s.game_id=h.game_id AND s.at=h.observed_at`).all(now - delay * S).map(r => [r.game_id, decode(r)]));
        },
        ingest(games, at) {
            for (const game of games) {
                const previous = db.prepare('SELECT observed_at,finished_at FROM c WHERE id=?').get(game.id);
                if (previous && previous.observed_at >= at) continue;
                const old = latest(game.id);
                if (game.snapshot.state === 'unknown' && old && old.data.state !== 'unknown') continue;
                const finishedAt = game.snapshot.state === 'finished' ? previous?.finished_at ?? (old && old.data.state !== 'finished' ? at : null) : null;
                db.prepare('INSERT OR REPLACE INTO c VALUES(?,?,?)').run(game.id, at, finishedAt);
                db.prepare('INSERT INTO h VALUES(?,?,?)').run(game.id, at, JSON.stringify({ ...game.snapshot, finishedAt }));
                this.rows++;
            }
        },
        prune(now) {
            db.prepare(`DELETE FROM h WHERE observed_at<? AND (game_id,observed_at) NOT IN (SELECT game_id,MAX(observed_at) FROM h GROUP BY game_id)
                AND (game_id,observed_at) NOT IN (SELECT game_id,MAX(observed_at) FROM h WHERE observed_at<=? GROUP BY game_id)`).run(now - 15 * M, now - 300 * S);
        }
    };
}

/** One match polled every 30 s with a gap, a second game quiet all along, a late correction and repeated final polls. */
function sequence() {
    const ticks = [];
    const other = { ...snap('scheduled'), id: 'espn:soccer/aus.1:other', start: NOW + 6 * 60 * M };
    let score = ['0', '0'];
    for (let t = 0; t <= 150; t++) {
        const at = NOW + t * 30 * S, minute = Math.max(0, t - 10);
        let g;
        if (t < 10) g = snap('scheduled');
        else if (t < 100 && t >= 55 && t < 65) g = snap('break', score, {}, { breakLabel: 'Half-time' });
        else if (t < 120) {
            if (t === 30) score = ['1', '0'];
            if (t === 80) score = ['1', '1'];
            if (t === 110) score = ['2', '1'];
            g = snap('live', score, { clock: `${Math.floor(minute / 2)}'`, period: t < 55 ? 1 : 2 });
        } else if (t === 121) g = snap('unknown');                                     // a partial answer: ignored
        else g = snap('finished', t >= 135 ? ['2', '2'] : score, { period: 2 });       // a correction after the final
        if (t >= 40 && t < 48) continue;                                                // the collector could not reach ESPN for 4 minutes
        ticks.push({ at, games: [g, other] });
    }
    return ticks;
}

test('every reader answers as before at every tick, with a fraction of the rows (old and new write rule side by side)', (t) => {
    const oldS = oldStore(open()), newDb = open(), newS = createStore(newDb);
    let newRows = 0;
    const count = () => newDb.prepare('SELECT COUNT(*) AS n FROM sports_score_history').get().n;
    let observedDiff = 0, compared = 0;
    for (const { at, games } of sequence()) {
        const before = count();
        oldS.ingest(games, at); newS.ingest(games, at);
        newRows += count() - before;
        for (const now of [at, at + 10 * S]) {
            for (const g of games) assert.deepEqual(newS.latest(g.id), oldS.latest(g.id), `latest ${g.id} at ${now}`);
            for (const delay of [0, 30, 90, 300]) {
                const sel = newS.view(now, delay).selected, oldSel = oldS.selected(now, delay);
                assert.deepEqual([...sel.keys()].sort(), [...oldSel.keys()].sort());
                for (const g of games) {
                    const a = newS.delayed(g.id, now, delay), b = oldS.delayed(g.id, now, delay);
                    compared++;
                    if (b === null) { assert.equal(a, null); continue; }
                    // what is shown, and whether it is fresh, is the same; the time it is credited to may be later, never
                    // past the delayed time (a later fetch that saw the same state confirms it)
                    assert.deepEqual([a.data, a.finishedAt, fresh(a, now, delay)], [b.data, b.finishedAt, fresh(b, now, delay)], `${g.id} at +${(now - NOW) / S}s, delay ${delay}`);
                    assert.ok(a.observedAt >= b.observedAt && a.observedAt <= now - delay * S);
                    assert.deepEqual(sel.get(g.id), a);
                    observedDiff = Math.max(observedDiff, a.observedAt - b.observedAt);
                }
            }
        }
        oldS.prune(at); newS.prune(at);
    }
    t.diagnostic(`history rows written: 0548 rule ${oldS.rows}, 0549 rule ${newRows}; ${compared} delayed reads compared; observedAt later by at most ${observedDiff / S} s`);
    assert.ok(newRows * 5 < oldS.rows, `${newRows} rows vs ${oldS.rows}`);
});

test('pruning still keeps the last-known snapshot and the newest one the maximum delay can reach', () => {
    const db = open(), s = createStore(db);
    s.ingest([snap('live', ['0', '0'], { clock: "10'", period: 1 })], NOW);
    for (let i = 1; i <= 60; i++) s.ingest([snap('live', ['0', '0'], { clock: "10'", period: 1 })], NOW + i * 30 * S);
    s.prune(NOW + 30 * M);
    assert.equal(historyRows(db, base.id), 1);
    assert.equal(s.delayed(base.id, NOW + 30 * M, 300).observedAt, NOW + 25 * M, 'confirmed by the fetches since: fresh at the maximum delay');
    s.ingest([snap('finished', ['2', '0'], { period: 2 })], NOW + 31 * M);
    s.prune(NOW + 24 * 60 * M);
    assert.equal(s.delayed(base.id, NOW + 24 * 60 * M, 90).data.state, 'finished');
});

test('a database from before 0549 is upgraded; a read-only one without the column still reads (as before)', () => {
    const db = open();
    db.exec(`CREATE TABLE sports_dashboard_catalog (id TEXT PRIMARY KEY, league TEXT NOT NULL, start INTEGER NOT NULL, data TEXT NOT NULL, observed_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE TABLE sports_score_history (game_id TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, observed_at));
        CREATE TABLE sports_user_preferences (user_id TEXT PRIMARY KEY, avoid_spoilers INTEGER NOT NULL, delay_seconds INTEGER NOT NULL, revision INTEGER NOT NULL);`);
    const { snapshot, ...meta } = snap('live', ['1', '0'], { clock: "5'", period: 1 });
    db.prepare('INSERT INTO sports_dashboard_catalog VALUES(?,?,?,?,?,NULL)').run(base.id, 'A-League', base.start, JSON.stringify(meta), NOW + 30 * S);
    for (const at of [NOW, NOW + 30 * S]) db.prepare('INSERT INTO sports_score_history VALUES(?,?,?)').run(base.id, at, JSON.stringify({ ...snapshot, finishedAt: null }));
    const ro = createStore(db, { readOnly: true }); // the worker's connection, before the main one upgraded
    assert.equal(ro.delayed(base.id, NOW + 60 * S, 30).observedAt, NOW + 30 * S);
    assert.equal(ro.latest(base.id).observedAt, NOW + 30 * S);
    const s = createStore(db);
    // 0553 (review H1): the history table keeps its three columns (earlier builds write it positionally); a side table holds the times
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sports_score_confirmed'").get(), 'side table added');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sports_score_history')").get().n, 3);
    s.ingest([snap('live', ['1', '0'], { clock: "5'", period: 1 })], NOW + 60 * S);
    assert.equal(historyRows(db, base.id), 2, 'an unchanged answer after the upgrade adds no row');
    assert.equal(s.delayed(base.id, NOW + 70 * S, 0).observedAt, NOW + 60 * S);
    assert.equal(s.delayed(base.id, NOW + 50 * S, 0).observedAt, NOW + 50 * S, 'confirmed by the fetch at +60 s: credited up to the time asked for');
    assert.equal(s.delayed(base.id, NOW + 20 * S, 0).observedAt, NOW, 'a superseded row from before 0549 keeps its own time');
    s.ingest([snap('live', ['2', '0'], { clock: "9'", period: 1 })], NOW + 90 * S);
    assert.equal(s.delayed(base.id, NOW + 89 * S, 0).observedAt, NOW + 60 * S, 'a superseded old row is credited to its last fetch');
    createStore(db); // opening twice is harmless
});
