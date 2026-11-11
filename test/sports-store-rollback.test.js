const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createStore } = require('../server/services/sportsDashboardStore');

// #272 (0553, review H1): 0549 added a column to sports_score_history; every earlier build prepares
// `INSERT INTO sports_score_history VALUES(?,?,?)`, which SQLite refuses on a 4-column table, so a rollback to the previous
// image (OPERATIONS.md › Rollback) lost the score store: no collector, no team/game rules, recordings no longer following
// the game's end. The history table keeps its three columns; confirmation times live in a side table old builds never read.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-store-rollback-'));
const databases = [];
after(() => { databases.forEach(db => db.close()); fs.rmSync(dir, { recursive: true, force: true }); });
const open = (name = ':memory:') => { const db = new Database(name === ':memory:' ? name : path.join(dir, name)); databases.push(db); return db; };

// The store as it was before this batch (8fb0648, build 0541; the same statements back to 0476). It requires nothing.
const oldFile = path.join(dir, 'oldStore.js');
fs.writeFileSync(oldFile, execFileSync('git', ['show', '8fb0648:server/services/sportsDashboardStore.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
const oldStore = require(oldFile);

const NOW = Date.parse('2026-10-29T01:00Z'), S = 1000;
const game = (scores, clock) => ({ id: 'espn:football/nfl:1', league: 'NFL', start: NOW, end: null, title: 'A v B', session: null, circuit: null, format: null,
    competitors: [{ id: '1', name: 'A', aliases: ['A'], logo: null }, { id: '2', name: 'B', aliases: ['B'], logo: null }],
    snapshot: { state: 'live', progress: { clock, period: 1 }, scores, situation: null } });
const columns = (db) => db.prepare("SELECT name FROM pragma_table_info('sports_score_history')").all().map(r => r.name);

test('(a) the store of a build before 0549 opens and ingests on a database this build has opened and written', () => {
    const db = open();
    const s = createStore(db);
    s.ingest([game(['0', '0'], '10:00')], NOW);
    s.ingest([game(['0', '0'], '10:00')], NOW + 30 * S);
    s.ingest([game(['7', '0'], '9:12')], NOW + 60 * S);
    assert.deepEqual(columns(db), ['game_id', 'observed_at', 'data']);
    const old = oldStore.createStore(db); // the rollback
    old.ingest([game(['7', '3'], '8:00')], NOW + 90 * S);
    assert.deepEqual(old.latest(game().id).data.scores, ['7', '3']);
    old.prune(NOW + 2 * 3600 * S);
    // and forward again
    const again = createStore(db);
    again.ingest([game(['7', '3'], '8:00')], NOW + 120 * S);
    assert.equal(again.latest(game().id).observedAt, NOW + 120 * S);
});

test('(b) a database 0549-0552 gave a confirmed_at column is repaired on open and keeps its confirmation times', () => {
    const db = open('b.db');
    db.exec(`CREATE TABLE sports_dashboard_catalog (id TEXT PRIMARY KEY, league TEXT NOT NULL, start INTEGER NOT NULL, data TEXT NOT NULL, observed_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE TABLE sports_score_history (game_id TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT NOT NULL, confirmed_at INTEGER, PRIMARY KEY(game_id, observed_at));
        CREATE INDEX sports_score_age ON sports_score_history(observed_at);`);
    const { snapshot, ...meta } = game(['0', '0'], '10:00');
    db.prepare('INSERT INTO sports_dashboard_catalog VALUES(?,?,?,?,?,NULL)').run(meta.id, 'NFL', NOW, JSON.stringify(meta), NOW + 90 * S);
    const row = db.prepare('INSERT INTO sports_score_history VALUES(?,?,?,?)');
    row.run(meta.id, NOW, JSON.stringify({ ...snapshot, finishedAt: null }), NOW + 60 * S);
    row.run(meta.id, NOW + 90 * S, JSON.stringify({ ...snapshot, scores: ['7', '0'], finishedAt: null }), null);
    const reader = new Database(path.join(dir, 'b.db'), { readonly: true }); databases.push(reader);
    const s = createStore(db);
    assert.deepEqual(columns(db), ['game_id', 'observed_at', 'data']);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sports_score_age'").get(), 'its index is kept');
    assert.equal(s.delayed(meta.id, NOW + 80 * S, 0).observedAt, NOW + 60 * S, 'the superseded row is still credited to its last fetch');
    assert.equal(s.latest(meta.id).observedAt, NOW + 90 * S);
    assert.equal(createStore(reader, { readOnly: true }).delayed(meta.id, NOW + 80 * S, 0).observedAt, NOW + 60 * S, 'a read-only connection reads after the repair');
    oldStore.createStore(db).ingest([game(['7', '3'], '8:00')], NOW + 120 * S); // and a rollback works on it
    createStore(db);
});

test('(d) a database from the oldest supported build (3-column history, no side table) opens, reads and writes', () => {
    const db = open();
    oldStore.createStore(db).ingest([game(['0', '0'], '10:00')], NOW);
    const ro = createStore(db, { readOnly: true }); // the worker's connection before the main one opened the store
    assert.equal(ro.delayed(game().id, NOW + 10 * S, 0).observedAt, NOW);
    const s = createStore(db);
    s.ingest([game(['0', '0'], '10:00')], NOW + 30 * S);
    assert.equal(s.latest(game().id).observedAt, NOW + 30 * S);
    assert.deepEqual(columns(db), ['game_id', 'observed_at', 'data']);
});
