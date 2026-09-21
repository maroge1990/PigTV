const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A real database in a sandbox, so the migration and the queries are exercised
// rather than described.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-favstable-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const { favorites } = sqlite;

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_505 = 'http://pro.speed8k.top/live/u/p/441360.ts';
const URL_TSN = 'http://pro.speed8k.top/live/u/p/1239048.ts';
const USER = '1';

function channel(pos, name, url, stableId) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, 2, ?, 'live', ?, 'Sport', NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, stable_id = excluded.stable_id
    `).run(`2:${pos}`, pos, name, JSON.stringify({ url }), Number(String(pos).replace(/\D/g, '')) || 1, stableId);
}
const clear = () => {
    sqlite.getDb().prepare('DELETE FROM favorites').run();
    sqlite.getDb().prepare('DELETE FROM playlist_items').run();
};

test('a favourite is recorded against the channel, not the playlist position', () => {
    clear();
    channel('pos_1187', 'Fox Sports 505', URL_505, 's441360');
    assert.equal(favorites.add(USER, 2, 'pos_1187'), true);

    const row = sqlite.getDb().prepare('SELECT item_id, stable_id FROM favorites').get();
    assert.equal(row.stable_id, 's441360', 'the identity is what it is for');
    assert.equal(row.item_id, 'pos_1187', 'and the position it was made at is still recorded');
});

test('after a reorder the favourite still finds the right channel', () => {
    clear();
    channel('pos_1187', 'Fox Sports 505', URL_505, 's441360');
    favorites.add(USER, 2, 'pos_1187');

    // The reorder that happened on 21 Sept: the channel moves two lines earlier
    // and something else takes the position it had.
    sqlite.getDb().prepare("DELETE FROM playlist_items WHERE id = '2:pos_1187'").run();
    channel('pos_1185', 'Fox Sports 505', URL_505, 's441360');
    channel('pos_1187', 'Shopping Channel', 'http://pro.speed8k.top/live/u/p/999999.ts', 's999999');

    assert.equal(favorites.isFavorite(USER, 2, 'pos_1185'), true, 'the channel is still favourited at its new position');
    assert.equal(favorites.isFavorite(USER, 2, 'pos_1187'), false,
        'and whatever moved into the old position is NOT - this is the bug being fixed');
});

test('a channel listed in two categories is one favourite, and unstarring clears both', () => {
    clear();
    // 845 of this provider's channels are listed more than once.
    channel('pos_1185', 'Fox Sports 505', URL_505, 's441360');
    channel('pos_28282', 'Fox Sports 505', URL_505, 's441360');

    favorites.add(USER, 2, 'pos_1185');
    assert.equal(favorites.isFavorite(USER, 2, 'pos_28282'), true, 'favouriting one listing favourites the channel');

    favorites.remove(USER, 2, 'pos_28282');
    assert.equal(favorites.isFavorite(USER, 2, 'pos_1185'), false, 'and unstarring either clears it everywhere');
    assert.equal(sqlite.getDb().prepare('SELECT COUNT(*) n FROM favorites').get().n, 0);
});

test('favourites made before identities existed are migrated to one', () => {
    clear();
    channel('pos_463', 'TSN', URL_TSN, 's1239048');
    // A row as it was stored before this shipped: no identity.
    sqlite.getDb().prepare(
        "INSERT INTO favorites (user_id, source_id, item_id, item_type) VALUES (?, 2, 'pos_463', 'channel')"
    ).run(USER);

    sqlite.backfillFavoriteIdentities();

    assert.equal(sqlite.getDb().prepare('SELECT stable_id FROM favorites').get().stable_id, 's1239048');
});

test('a favourite whose channel is not in the playlist still works the old way', () => {
    clear();
    // An unsynced source, or an id that no longer exists: there is no identity to
    // use, so matching falls back to the stored item_id rather than failing.
    assert.equal(favorites.add(USER, 9, 'pos_777'), true);
    assert.equal(sqlite.getDb().prepare('SELECT stable_id FROM favorites').get().stable_id, null);
    assert.equal(favorites.isFavorite(USER, 9, 'pos_777'), true);
    assert.equal(favorites.remove(USER, 9, 'pos_777'), true);
});

test('the composite id the web app sends still works', () => {
    clear();
    channel('pos_463', 'TSN', URL_TSN, 's1239048');
    assert.equal(favorites.add(USER, 2, 'm3u_2_pos_463'), true);
    assert.equal(sqlite.getDb().prepare('SELECT stable_id FROM favorites').get().stable_id, 's1239048');
    assert.equal(favorites.isFavorite(USER, 2, 'pos_463'), true, 'and matches the bare form, as 0059 requires');
});

test('movies and series are untouched - identities are a channel concern', () => {
    clear();
    assert.equal(favorites.add(USER, 2, '900', 'movie'), true);
    const row = sqlite.getDb().prepare("SELECT item_id, stable_id FROM favorites WHERE item_type = 'movie'").get();
    assert.equal(row.item_id, '900');
    assert.equal(row.stable_id, null);
    assert.equal(favorites.isFavorite(USER, 2, '900', 'movie'), true);
});
