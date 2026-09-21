const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A real database, in a sandbox, so the migration and the index are exercised
// rather than described (same approach as access.test.js; a junction so it works
// on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-stableid-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_505 = 'http://pro.speed8k.top/live/u/p/441360.ts';
const URL_TSN = 'http://pro.speed8k.top/live/u/p/1239048.ts';

// A channel as the M3U sync writes one: stream_url is left NULL and the URL
// lives in the data blob, which is what caught out the first capture script.
function writeChannel(db, { pos, name, url, stableId = null }) {
    db.prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, 2, ?, 'live', ?, 'Sport', NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, stable_id = excluded.stable_id
    `).run(`2:${pos}`, pos, name, JSON.stringify({ url }), 1, stableId);
}

test('the column and its index exist after initSchema', () => {
    const db = sqlite.getDb();
    const cols = db.prepare('PRAGMA table_info(playlist_items)').all().map(c => c.name);
    assert.ok(cols.includes('stable_id'), 'stable_id column');
    const indexes = db.prepare('PRAGMA index_list(playlist_items)').all().map(i => i.name);
    assert.ok(indexes.includes('idx_playlist_items_stable'), 'and the lookup index');
});

test('rows written before the column get an identity backfilled from the data blob', () => {
    const db = sqlite.getDb();
    writeChannel(db, { pos: 'pos_1187', name: 'Fox Sports 505', url: URL_505 });
    writeChannel(db, { pos: 'pos_463', name: 'TSN', url: URL_TSN });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM playlist_items WHERE stable_id IS NULL").get().n, 2);

    sqlite.backfillStableIds();

    assert.equal(db.prepare("SELECT stable_id FROM playlist_items WHERE id = '2:pos_1187'").get().stable_id, 's441360');
    assert.equal(db.prepare("SELECT stable_id FROM playlist_items WHERE id = '2:pos_463'").get().stable_id, 's1239048');
});

test('a placeholder row with no URL is left without an identity rather than given a fake one', () => {
    const db = sqlite.getDb();
    db.prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order)
        VALUES ('2:pos_2', 2, 'pos_2', 'live', '### LOCAL NETWORKS ###', 'Sport', NULL, '{}', 1)
    `).run();
    sqlite.backfillStableIds();
    assert.equal(db.prepare("SELECT stable_id FROM playlist_items WHERE id = '2:pos_2'").get().stable_id, null);
});

test('the backfill is idempotent: a second start changes nothing', () => {
    const db = sqlite.getDb();
    const before = db.prepare('SELECT id, stable_id FROM playlist_items ORDER BY id').all();
    sqlite.backfillStableIds();
    sqlite.backfillStableIds();
    assert.deepEqual(db.prepare('SELECT id, stable_id FROM playlist_items ORDER BY id').all(), before);
});

test('the identity survives the reorder that started all this', () => {
    // 21 Sept: the provider inserted channels and Fox Sports 505 moved from
    // pos_1187 to pos_1185 - same channel, same URL. Before stable_id, anything
    // keyed on the position now pointed at a different channel; a favourite was
    // seen playing the wrong one. The position must move and the identity must not.
    const db = sqlite.getDb();
    const identityBefore = db.prepare("SELECT stable_id FROM playlist_items WHERE id = '2:pos_1187'").get().stable_id;

    // The reorder: the channel is now two lines earlier, and something else has
    // taken the line it used to occupy.
    db.prepare("DELETE FROM playlist_items WHERE id = '2:pos_1187'").run();
    writeChannel(db, { pos: 'pos_1185', name: 'Fox Sports 505', url: URL_505, stableId: 's441360' });
    writeChannel(db, { pos: 'pos_1187', name: 'Something Else', url: 'http://pro.speed8k.top/live/u/p/999999.ts', stableId: 's999999' });

    const byPosition = db.prepare("SELECT name FROM playlist_items WHERE id = '2:pos_1187'").get();
    assert.equal(byPosition.name, 'Something Else', 'the position really did come to mean a different channel');

    const byIdentity = db.prepare("SELECT item_id, name FROM playlist_items WHERE source_id = 2 AND stable_id = ?").all(identityBefore);
    assert.deepEqual(byIdentity.map(r => r.name), ['Fox Sports 505'], 'the identity still finds the right one');
    assert.equal(byIdentity[0].item_id, 'pos_1185', 'at its new position');
});

test('a channel cross-listed twice resolves to both rows, which is the point', () => {
    // Fox Sports 505 is listed at two positions with an identical URL. One
    // identity, two rows - so a favourite on either is a favourite on the channel.
    const db = sqlite.getDb();
    writeChannel(db, { pos: 'pos_28282', name: 'Fox Sports 505', url: URL_505, stableId: 's441360' });
    const rows = db.prepare("SELECT item_id FROM playlist_items WHERE source_id = 2 AND stable_id = 's441360' ORDER BY item_id").all();
    assert.deepEqual(rows.map(r => r.item_id), ['pos_1185', 'pos_28282']);
});
