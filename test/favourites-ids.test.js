const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-favs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

// A database as an earlier PigTV left it: favourites the web app wrote under
// its composite id, next to ones the native client wrote bare.
fs.mkdirSync(path.join(sandbox, 'data'));
{
    const legacy = new Database(path.join(sandbox, 'data/content.db'));
    legacy.exec(`CREATE TABLE favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
        item_id TEXT NOT NULL, item_type TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, source_id, item_id, item_type))`);
    const ins = legacy.prepare('INSERT INTO favorites (user_id, source_id, item_id, item_type) VALUES (?, ?, ?, ?)');
    ins.run(1, 5, 'm3u_5_pos_9', 'channel');      // web-written, no bare twin: must be rewritten
    ins.run(1, 5, 'm3u_5_pos_3', 'channel');      // web-written ...
    ins.run(1, 5, 'pos_3', 'channel');            // ... with a bare twin from the native client: must merge, not duplicate
    ins.run(1, 6, 'xtream_6_1042', 'channel');    // Xtream composite
    ins.run(2, 5, 'm3u_5_pos_9', 'channel');      // another user's, independent
    ins.run(1, 5, 'm3u_5_movie', 'movie');        // not a channel: must not be touched
    ins.run(1, 5, 'pos_1', 'channel');            // already bare
    legacy.close();
}

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const auth = load('auth');
const sync = load('services/syncService');
const { bareChannelId, compositeChannelId } = load('services/channelIds');

let server, base, token, source;
const favs = (userId) => sqlite.getDb().prepare('SELECT source_id, item_id, item_type FROM favorites WHERE user_id = ? ORDER BY source_id, item_id').all(userId);

async function request(method, route, body) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });

    const lines = ['#EXTM3U'];
    for (let i = 0; i < 4; i++) lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="All",Channel ${i}`, `https://provider.invalid/live/${i}.ts`);
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(lines.join('\n'));
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // loading it is what registers the JWT strategy
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

test('bare and composite spellings convert both ways', () => {
    assert.equal(bareChannelId('m3u_5_pos_9'), 'pos_9');
    assert.equal(bareChannelId('xtream_6_1042'), '1042');
    assert.equal(bareChannelId('pos_9'), 'pos_9', 'a bare id is returned unchanged');
    assert.equal(bareChannelId('1042'), '1042');
    assert.equal(compositeChannelId('m3u', 5, 'pos_9'), 'm3u_5_pos_9');
    assert.equal(compositeChannelId('xtream', 6, '1042'), 'xtream_6_1042');
    assert.equal(compositeChannelId('m3u', 5, 'm3u_5_pos_9'), 'm3u_5_pos_9', 'already composite: not doubled');
});

test('startup rewrites web-written favourites to the bare id and merges duplicates', () => {
    assert.deepEqual(favs(1), [
        { source_id: 5, item_id: 'm3u_5_movie', item_type: 'movie' },   // not a channel: untouched
        { source_id: 5, item_id: 'pos_1', item_type: 'channel' },
        { source_id: 5, item_id: 'pos_3', item_type: 'channel' },   // one row, not two
        { source_id: 5, item_id: 'pos_9', item_type: 'channel' },
        { source_id: 6, item_id: '1042', item_type: 'channel' }
    ].sort((a, b) => a.source_id - b.source_id || (a.item_id < b.item_id ? -1 : 1)));
    assert.deepEqual(favs(2), [{ source_id: 5, item_id: 'pos_9', item_type: 'channel' }], "another user's favourites are migrated independently");
});

test('a favourite the web app adds shows up in the library API the native client reads', async () => {
    const channels = (await request('GET', '/api/library/channels')).data.channels;
    const target = channels[2];
    assert.match(String(target.id), /^pos_/);

    // The web app sends its composite id.
    const composite = `m3u_${source.id}_${target.id}`;
    assert.equal((await request('POST', '/api/favorites', { sourceId: source.id, itemId: composite })).status, 200);

    assert.equal(favs(1).filter(f => f.source_id === source.id).map(f => f.item_id).join(), target.id, 'stored under the bare id');
    const listed = (await request('GET', '/api/library/favourites')).data;
    assert.deepEqual(listed.map(c => c.id), [target.id], 'the native client sees it');
    const flagged = (await request('GET', '/api/library/channels')).data.channels.find(c => c.id === target.id);
    assert.equal(flagged.favourite, true, 'and the channel list flags it');
});

test('a favourite the native client adds shows up in the web app, in the id form it uses', async () => {
    const channels = (await request('GET', '/api/library/channels')).data.channels;
    const target = channels[0];
    // The native client writes the bare id.
    assert.equal((await request('POST', '/api/favorites', { sourceId: source.id, itemId: target.id })).status, 200);

    const web = (await request('GET', '/api/favorites')).data.filter(f => f.source_id === source.id);
    assert.ok(web.some(f => f.item_id === `m3u_${source.id}_${target.id}`),
        'the web app matches favourites against its composite channel id');
    const raw = (await request('GET', '/api/favorites?format=bare')).data.filter(f => f.source_id === source.id);
    assert.ok(raw.some(f => f.item_id === target.id), 'the stored form is available on request');
});

test('check and remove accept either spelling and hit the same row', async () => {
    const channels = (await request('GET', '/api/library/channels')).data.channels;
    const target = channels[0];
    const composite = `m3u_${source.id}_${target.id}`;
    for (const id of [target.id, composite]) {
        const check = await request('GET', `/api/favorites/check?sourceId=${source.id}&itemId=${encodeURIComponent(id)}`);
        assert.equal(check.data.isFavorite, true, `${id} is a favourite`);
    }
    await request('DELETE', '/api/favorites', { sourceId: source.id, itemId: composite });
    const after = await request('GET', `/api/favorites/check?sourceId=${source.id}&itemId=${encodeURIComponent(target.id)}`);
    assert.equal(after.data.isFavorite, false, 'removing by the web spelling removes the native one');
});

test('movie and series favourites keep whatever id they were given', async () => {
    await request('POST', '/api/favorites', { sourceId: source.id, itemId: 'm3u_1_something', itemType: 'movie' });
    const stored = sqlite.getDb().prepare("SELECT item_id FROM favorites WHERE item_type = 'movie' AND source_id = ?").all(source.id);
    assert.deepEqual(stored.map(r => r.item_id), ['m3u_1_something']);
});
