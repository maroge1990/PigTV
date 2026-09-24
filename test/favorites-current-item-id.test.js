const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0110: Mark's live test showed the Apple TV starring "Fox Footy 504" while the
// web app starred "Fox Footy 502" for the very same favourite. Cause: GET
// /api/favorites returned the favourite's STORED item_id (the playlist
// position it sat on when it was starred), and the provider had since
// reordered - that position now names a different channel. GET
// /library/favourites already joins on stable_id and was correct; this test
// exercises /api/favorites the same way favourites-stable.test.js exercises
// the db layer, but through the actual route so the bug (in routes/favorites.js,
// not db/sqlite.js) is caught.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fav-currentid-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, token, source;

async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
}

function channel(pos, name, url, stableId, sourceId) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, ?, ?, 'live', ?, 'Sport', NULL, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, stable_id = excluded.stable_id
    `).run(`${sourceId}:${pos}`, sourceId, pos, name, JSON.stringify({ url }), stableId);
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/favorites', load('routes/favorites'));
    app.use('/api/library', load('routes/library'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('GET /api/favorites follows the channel after a provider reorder, not the stored position', async () => {
    const URL_FOOTY = 'http://provider.invalid/live/u/p/504504.ts';
    channel('pos_A', 'Fox Footy 502', URL_FOOTY, 'sFootyStable', source.id);

    const addResp = await fetch(`${base}/api/favorites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, itemId: 'pos_A', itemType: 'channel' })
    });
    assert.equal(addResp.status, 200, await addResp.text());

    // The provider reorders: the channel moves to pos_B, and something else
    // (a different stable identity) takes over pos_A.
    sqlite.getDb().prepare('DELETE FROM playlist_items WHERE source_id = ? AND item_id = ?').run(source.id, 'pos_A');
    channel('pos_B', 'Fox Footy 502', URL_FOOTY, 'sFootyStable', source.id);
    channel('pos_A', 'Some Other Channel', 'http://provider.invalid/live/u/p/999999.ts', 'sOtherStable', source.id);

    const bare = await get('/api/favorites?format=bare');
    assert.equal(bare.length, 1);
    assert.equal(bare[0].item_id, 'pos_B',
        'the stored form should still resolve to the CURRENT position, not the stale pos_A (this is the bug)');

    const composite = await get('/api/favorites');
    assert.equal(composite.length, 1);
    assert.equal(composite[0].item_id, `m3u_${source.id}_pos_B`,
        'the web app must see the channel at its current position, matching /library/favourites');
});

test('a channel cross-listed in two categories shows a star in both current listings', async () => {
    sqlite.getDb().prepare('DELETE FROM favorites').run();
    sqlite.getDb().prepare('DELETE FROM playlist_items').run();

    channel('pos_C1', 'Fox Footy 502', 'http://provider.invalid/live/u/p/504504.ts', 'sFootyStable', source.id);
    channel('pos_C2', 'Fox Footy 502', 'http://provider.invalid/live/u/p/504504.ts', 'sFootyStable', source.id);

    await fetch(`${base}/api/favorites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, itemId: 'pos_C1', itemType: 'channel' })
    });

    const bare = await get('/api/favorites?format=bare');
    const ids = bare.map(f => f.item_id).sort();
    assert.deepEqual(ids, ['pos_C1', 'pos_C2'], 'one entry per current listing of the same channel');
});

test('a favourite without a stable_id keeps its stored item_id (no identity to fall back to)', async () => {
    sqlite.getDb().prepare('DELETE FROM favorites').run();
    sqlite.getDb().prepare('DELETE FROM playlist_items').run();

    // An unsynced source: add() finds no playlist row, so no identity is
    // recorded and the favourite must keep working the old way.
    const addResp = await fetch(`${base}/api/favorites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: 987654, itemId: 'pos_orphan', itemType: 'channel' })
    });
    assert.equal(addResp.status, 200, await addResp.text());

    const bare = await get('/api/favorites?format=bare');
    assert.equal(bare.length, 1);
    assert.equal(bare[0].item_id, 'pos_orphan');
});
