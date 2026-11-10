const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #270: films and series are no longer downloaded. A database written by an older build still holds their rows, their
// category rows and the unused watch_history table; the first start of this build removes them, once, and leaves live
// rows and favourites alone. A fresh database has nothing to remove and is marked done.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-films-cleanup-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));

// A database as an older build left it, written before this build ever opens it.
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
{
    const Database = require('better-sqlite3');
    const raw = new Database(path.join(sandbox, 'data', 'content.db'));
    raw.exec(`
        CREATE TABLE categories (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, category_id TEXT NOT NULL, type TEXT NOT NULL,
            name TEXT NOT NULL, parent_id TEXT, is_hidden INTEGER DEFAULT 0, sort_order INTEGER, data JSON);
        CREATE INDEX idx_categories_source_type ON categories(source_id, type);
        CREATE TABLE playlist_items (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, item_id TEXT NOT NULL, type TEXT NOT NULL,
            name TEXT NOT NULL, category_id TEXT, parent_id TEXT, stream_icon TEXT, stream_url TEXT, container_extension TEXT,
            rating REAL, year TEXT, added_at TEXT, is_hidden INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0, sort_order INTEGER, data JSON);
        CREATE INDEX idx_items_source_type ON playlist_items(source_id, type);
        CREATE TABLE watch_history (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, source_id INTEGER, item_type TEXT NOT NULL,
            item_id TEXT NOT NULL, parent_id TEXT, progress INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, data JSON);
        CREATE INDEX idx_history_user_updated ON watch_history(user_id, updated_at DESC);
        CREATE INDEX idx_history_user_item ON watch_history(user_id, item_id);
        CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL, item_type TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, source_id, item_id, item_type));
    `);
    const item = raw.prepare('INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id) VALUES (?, ?, ?, ?, ?, ?)');
    for (const sid of [1, 2]) {
        item.run(`${sid}:10`, sid, '10', 'live', 'A channel', '5');
        item.run(`${sid}:20`, sid, '20', 'movie', 'A film', '6');
        item.run(`${sid}:30`, sid, '30', 'series', 'A series', '7');
    }
    const cat = raw.prepare('INSERT INTO categories (id, source_id, category_id, type, name) VALUES (?, ?, ?, ?, ?)');
    cat.run('1:5', 1, '5', 'live', 'A group');
    cat.run('1:6', 1, '6', 'movie', 'Films');
    cat.run('2:7', 2, '7', 'series', 'Series');
    raw.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type) VALUES (1, 1, '20', 'movie')`).run();
    raw.prepare(`INSERT INTO watch_history (id, user_id, item_type, item_id, updated_at) VALUES ('1:20', 1, 'movie', '20', 1)`).run();
    // D-57: a database PigTV still opens was last opened by 0476 or later.
    raw.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT); INSERT OR REPLACE INTO meta VALUES ('schema_build', '0476')`);
    raw.close();
}

const sqlite = load('db/sqlite');
const d = () => sqlite.getDb();
const types = (table) => d().prepare(`SELECT type, COUNT(*) n FROM ${table} GROUP BY type ORDER BY type`).all().map(r => `${r.type}:${r.n}`);
const hasTable = (name) => !!d().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const hasIndex = (name) => !!d().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);

after(() => {
    try { d().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('the first start removes film and series rows and their categories, and the watch_history table', () => {
    d(); // opens the database: the clean-up runs with the schema
    assert.deepEqual(types('playlist_items'), ['live:2'], 'only live channels remain');
    assert.deepEqual(types('categories'), ['live:1'], 'and only the live group');
    assert.equal(hasTable('watch_history'), false);
    assert.equal(hasIndex('idx_history_user_updated') || hasIndex('idx_history_user_item'), false);
    assert.deepEqual(d().prepare('SELECT item_id, item_type FROM favorites').all(), [{ item_id: '20', item_type: 'movie' }], 'favourites are left alone');
    assert.ok(d().prepare(`SELECT 1 FROM meta WHERE key = 'films_series_cleanup'`).get(), 'and it is marked done');
});

test('it runs once: rows that appear later are not touched', () => {
    d().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES ('1:99', 1, '99', 'movie', 'Later')`).run();
    assert.equal(sqlite.dropFilmsAndSeries(), 0);
    assert.deepEqual(types('playlist_items'), ['live:2', 'movie:1']);
});

test('a database with no film or series rows is marked done and nothing else changes', () => {
    d().prepare(`DELETE FROM meta WHERE key = 'films_series_cleanup'`).run();
    d().prepare(`DELETE FROM playlist_items WHERE type = 'movie'`).run();
    assert.equal(sqlite.dropFilmsAndSeries(), 0);
    assert.deepEqual(types('playlist_items'), ['live:2']);
    assert.ok(d().prepare(`SELECT 1 FROM meta WHERE key = 'films_series_cleanup'`).get());
});

test('a new database no longer has playlist_items.is_favorite or watch_history', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-films-fresh-'));
    try {
        fs.cpSync(path.join(__dirname, '../server'), path.join(fresh, 'server'), { recursive: true });
        fs.cpSync(path.join(__dirname, '../package.json'), path.join(fresh, 'package.json'));
        fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(fresh, 'node_modules'), 'junction');
        const out = require('node:child_process').execFileSync(process.execPath, ['-e', `
            const d = require(${JSON.stringify(path.join(fresh, 'server/db/sqlite'))}).getDb();
            console.log(JSON.stringify({
                cols: d.prepare('PRAGMA table_info(playlist_items)').all().map(c => c.name),
                history: !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'watch_history'").get()
            }));`], { encoding: 'utf8', cwd: fresh, env: { ...process.env, PIGTV_DB_BACKUPS: '0' } });
        const result = JSON.parse(out.trim().split('\n').pop());
        assert.ok(!result.cols.includes('is_favorite'));
        assert.ok(result.cols.includes('is_hidden'));
        assert.equal(result.history, false);
    } finally {
        try { fs.rmdirSync(path.join(fresh, 'node_modules')); } catch { /* junction already gone */ }
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
