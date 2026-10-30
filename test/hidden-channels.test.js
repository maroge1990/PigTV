const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #10 (0347): hidden channels follow the channel, not its line in the playlist. The real M3U sync in a sandbox
// against a local playlist, and the real hide/show routes. On 0346 the flag stayed with the position, so a line the
// provider inserted moved every later flag onto its neighbour.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-hidden-ch-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-hidden-channels-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const auth = load('auth');

const line = (name, group, id) => [`#EXTINF:-1 tvg-id="${id}" group-title="${group}",${name}`, `http://p.invalid/live/u/p/${id}.ts`];
const playlistOf = (entries) => ['#EXTM3U', ...entries.flatMap(e => line(...e))].join('\n');
const BASE = [
    ['BBC News', 'News', 101], ['Sky News', 'News', 102],
    ['Adult 1', 'Adult', 201], ['Adult 2', 'Adult', 202],
    ['Fox Cricket', 'Sport', 501], ['Fox Footy', 'Sport', 502]
];
let M3U = playlistOf(BASE);
const provider = http.createServer((req, res) => { res.setHeader('content-type', 'audio/x-mpegurl'); res.end(M3U); });
let source, server, base, admin;
const realLog = console.log;

before(async () => {
    console.log = () => {};
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `http://127.0.0.1:${provider.address().port}/get.php?username=u&password=p` });
    admin = auth.generateToken(await db.users.create({ username: 'admin', role: 'admin' }));
    const app = express(); app.use(express.json()); app.use('/api/channels', auth.requireAuth, load('routes/channels'));
    server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    console.log = realLog;
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    if (server?.listening) await new Promise(r => server.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
};
const get = async (url) => (await fetch(base + url, { headers: { authorization: `Bearer ${admin}` } })).json();
/** What the guide shows: the row and its group both visible. */
const visible = () => sqlite.getDb().prepare(`SELECT p.name FROM playlist_items p
    JOIN categories c ON c.source_id = p.source_id AND c.type = p.type AND c.category_id = p.category_id
    WHERE p.source_id = ? AND p.type = 'live' AND p.is_hidden = 0 AND c.is_hidden = 0 ORDER BY p.sort_order`).all(source.id).map(r => r.name);
const itemId = (name) => sqlite.getDb().prepare(`SELECT item_id FROM playlist_items WHERE source_id = ? AND name = ?`).get(source.id, name).item_id;

test('a line inserted mid-playlist moves no hidden flag onto a neighbour', async () => {
    await sync.syncM3u(source);
    assert.equal((await post('/api/channels/hide', { sourceId: source.id, itemType: 'group', itemId: 'Adult' })).status, 200);
    assert.equal((await post('/api/channels/hide', { sourceId: source.id, itemType: 'channel', itemId: itemId('Sky News') })).status, 200);
    assert.deepEqual(visible(), ['BBC News', 'Fox Cricket', 'Fox Footy']);
    // The provider inserts one line at the top: every row's pos_N shifts by one.
    M3U = playlistOf([['ABC News', 'News', 100], ...BASE]);
    await sync.syncM3u(source);
    assert.notEqual(itemId('Sky News'), 'pos_1', 'the rows did move');
    assert.deepEqual(visible(), ['ABC News', 'BBC News', 'Fox Cricket', 'Fox Footy'],
        'Sky News and the Adult group stay hidden; nothing beside them disappears; a new channel in a shown group shows');
    // And back again: the line removed.
    M3U = playlistOf(BASE);
    await sync.syncM3u(source);
    assert.deepEqual(visible(), ['BBC News', 'Fox Cricket', 'Fox Footy']);
});

test('a group the provider adds arrives hidden and is listed for review; showing it takes it off the list', async () => {
    M3U = playlistOf([...BASE, ['Kayo 1', 'AU | Kayo Events', 801], ['Kayo 2', 'AU | Kayo Events', 802]]);
    await sync.syncM3u(source);
    assert.deepEqual(visible(), ['BBC News', 'Fox Cricket', 'Fox Footy'], 'the new group is not on screen');
    const listed = await get(`/api/channels/new-groups?sourceId=${source.id}`);
    assert.deepEqual(listed.map(g => [g.categoryId, g.name, g.channels]), [['AU | Kayo Events', 'AU | Kayo Events', 2]]);
    // A later sync keeps it hidden and listed once.
    await sync.syncM3u(source);
    assert.equal((await get(`/api/channels/new-groups?sourceId=${source.id}`)).length, 1);
    assert.equal((await post('/api/channels/show', { sourceId: source.id, itemType: 'group', itemId: 'AU | Kayo Events' })).status, 200);
    assert.deepEqual(visible(), ['BBC News', 'Fox Cricket', 'Fox Footy', 'Kayo 1', 'Kayo 2']);
    assert.deepEqual(await get(`/api/channels/new-groups?sourceId=${source.id}`), []);
});

test('a renamed group keeps its channels on screen, and a hidden channel stays hidden under the new name', async () => {
    await post('/api/channels/hide', { sourceId: source.id, itemType: 'channel', itemId: itemId('Fox Footy') });
    M3U = playlistOf([...BASE.map(([n, g, id]) => [n, g === 'Sport' ? 'Sport AU' : g, id]),
        ['Kayo 1', 'AU | Kayo Events', 801], ['Kayo 2', 'AU | Kayo Events', 802]]);
    await sync.syncM3u(source);
    assert.deepEqual(visible(), ['BBC News', 'Fox Cricket', 'Kayo 1', 'Kayo 2']);
    assert.deepEqual(await get(`/api/channels/new-groups?sourceId=${source.id}`), [], 'not offered as new');
});

test('a database from before this build: flags set by position are captured before the first sync moves them', async () => {
    const legacy = await db.sources.create({ type: 'm3u', name: 'Old', url: `http://127.0.0.1:${provider.address().port}/old.m3u` });
    M3U = playlistOf(BASE);
    await sync.syncM3u(legacy);
    // As 0346 left it: no record, only the positional flags (and its first-sync marker is what 0347 writes).
    const d = sqlite.getDb();
    d.prepare(`DELETE FROM hidden_channels WHERE source_id = ?`).run(legacy.id);
    d.prepare(`DELETE FROM meta WHERE key = ?`).run(`hidden_channels_captured:${legacy.id}`);
    d.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND name = 'Sky News'`).run(legacy.id);
    M3U = playlistOf([['ABC News', 'News', 100], ...BASE]);
    await sync.syncM3u(legacy);
    const hidden = d.prepare(`SELECT name FROM playlist_items WHERE source_id = ? AND is_hidden = 1`).all(legacy.id).map(r => r.name);
    assert.deepEqual(hidden, ['Sky News']);
});

test('a channel listed twice in one group: hiding one copy keeps the other shown across a reshuffle', async () => {
    const twice = await db.sources.create({ type: 'm3u', name: 'Twice', url: `http://127.0.0.1:${provider.address().port}/twice.m3u` });
    const NBA = [['Lakers v Celtics', 'NBA', 601], ['Lakers v Celtics', 'NBA', 601], ['Bulls v Knicks', 'NBA', 602]];
    M3U = playlistOf(NBA);
    await sync.syncM3u(twice);
    const d = sqlite.getDb();
    const second = d.prepare(`SELECT item_id FROM playlist_items WHERE source_id = ? ORDER BY sort_order`).all(twice.id)[1].item_id;
    await post('/api/channels/hide', { sourceId: twice.id, itemType: 'channel', itemId: second });
    M3U = playlistOf([['Suns v Heat', 'NBA', 600], ...NBA]);
    await sync.syncM3u(twice);
    const flags = d.prepare(`SELECT name, is_hidden FROM playlist_items WHERE source_id = ? ORDER BY sort_order`).all(twice.id)
        .map(r => `${r.name}:${r.is_hidden}`);
    assert.deepEqual(flags, ['Suns v Heat:0', 'Lakers v Celtics:0', 'Lakers v Celtics:1', 'Bulls v Knicks:0']);
});

test('#167: a hide or show while the source is syncing is refused, so nothing is recorded against moving rows', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slow = http.createServer(async (req, res) => {
        await gate;
        res.setHeader('content-type', 'audio/x-mpegurl'); res.end(playlistOf(BASE));
    });
    slow.listen(0, '127.0.0.1'); await once(slow, 'listening');
    const busy = await db.sources.create({ type: 'm3u', name: 'Busy', url: `http://127.0.0.1:${slow.address().port}/busy.m3u` });
    try {
        const running = sync.syncSource(busy.id);
        await new Promise(r => setTimeout(r, 100));
        for (const [url, body] of [['/api/channels/hide', { sourceId: busy.id, itemType: 'channel', itemId: 'pos_0' }],
            ['/api/channels/show', { sourceId: busy.id, itemType: 'group', itemId: 'News' }],
            ['/api/channels/hide/bulk', { items: [{ sourceId: busy.id, itemType: 'channel', itemId: 'pos_1' }] }],
            ['/api/channels/hide/all', { sourceId: busy.id }]]) {
            const r = await post(url, body);
            assert.equal(r.status, 409, url);
            assert.match(r.body.error, /being updated from the provider/);
        }
        release();
        await running;
        assert.equal((await post('/api/channels/hide', { sourceId: busy.id, itemType: 'group', itemId: 'Adult' })).status, 200, 'after the sync it works');
    } finally {
        release();
        slow.closeAllConnections(); await new Promise(r => slow.close(r));
    }
});

test('the review list is admin-only and validated', async () => {
    const viewer = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    const r = await fetch(`${base}/api/channels/new-groups`, { headers: { authorization: `Bearer ${viewer}` } });
    assert.equal(r.status, 403);
    assert.equal((await post('/api/channels/new-groups/dismiss', { sourceId: 'x' })).status, 400);
    assert.equal((await post('/api/channels/new-groups/dismiss', { sourceId: source.id, categoryIds: 'all' })).status, 400);
    assert.equal((await post('/api/channels/new-groups/dismiss', { sourceId: source.id })).status, 200);
});
