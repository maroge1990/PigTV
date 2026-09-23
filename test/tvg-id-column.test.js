const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0111 (roadmap S1.3): the guide used to JSON.parse `data` for every row on
// every page just to find its tvg-id. tvg_id is now its own indexed column,
// filled at ingest and backfilled once at startup for rows that predate it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tvgid-col-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const sync = require(path.join(sandbox, 'server/services/syncService'));

after(() => {
    process.chdir(os.tmpdir());
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('backfillTvgIds fills the column from the data blob for pre-existing rows', () => {
    const db = sqlite.getDb();
    db.prepare('DELETE FROM playlist_items').run();
    db.prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data)
        VALUES ('2:pos_1', 2, 'pos_1', 'live', 'One', 'All', 1, ?)
    `).run(JSON.stringify({ tvgId: 'ch1' }));
    // Simulate a row that predates the column.
    db.prepare("UPDATE playlist_items SET tvg_id = NULL").run();

    sqlite.backfillTvgIds();

    assert.equal(db.prepare('SELECT tvg_id FROM playlist_items').get().tvg_id, 'ch1');
});

test('backfillTvgIds falls back to epg_channel_id when tvgId is absent (Xtream shape)', () => {
    const db = sqlite.getDb();
    db.prepare('DELETE FROM playlist_items').run();
    db.prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data)
        VALUES ('2:pos_2', 2, 'pos_2', 'live', 'Two', 'All', 2, ?)
    `).run(JSON.stringify({ epg_channel_id: 'ch2' }));
    db.prepare("UPDATE playlist_items SET tvg_id = NULL").run();

    sqlite.backfillTvgIds();

    assert.equal(db.prepare('SELECT tvg_id FROM playlist_items').get().tvg_id, 'ch2');
});

test('an M3U sync fills tvg_id at ingest, not only at the startup backfill', async () => {
    const source = await require(path.join(sandbox, 'server/db')).sources.create({
        type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u'
    });
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="ch9" group-title="All",Nine\nhttps://provider.invalid/9.ts\n';
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(m3u);
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    const row = sqlite.getDb().prepare(
        "SELECT tvg_id FROM playlist_items WHERE source_id = ? AND name = 'Nine'"
    ).get(source.id);
    assert.equal(row.tvg_id, 'ch9', 'tvg_id must be set by the sync itself, without needing a restart');
});
