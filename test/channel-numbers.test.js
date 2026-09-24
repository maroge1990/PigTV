const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0117 (roadmap X2.1, contract C-A): every visible live channel has a persisted
// number keyed by its identity, assigned when a sync completes, kept across a
// provider reorder, reserved for 30 days when the channel disappears, editable
// by the admin, and the guide is ordered by it with exact cursor paging.
// The old code had no numbers at all: every assertion on `number`, the lineup
// routes and the flag fails against it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-channel-numbers-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

let server, base, adminToken, viewerToken, source;

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
const get = async route => (await call('GET', route)).body;

// An Xtream-shaped M3U: the stream id in the URL is the channel's stable_id.
function playlist(channels) {
    return '#EXTM3U\n' + channels.map(([id, name, group]) =>
        `#EXTINF:-1 tvg-id="${id}.tv" group-title="${group}",${name}\nhttp://provider.invalid/live/user/pass/${id}.ts`
    ).join('\n') + '\n';
}

async function syncWith(channels) {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(playlist(channels));
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }
}

const numbersByName = rows => Object.fromEntries(rows.map(r => [r.name, r.number]));

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken({ ...admin, id: 1 });
    const viewer = await db.users.create({ username: 'viewer', role: 'user' });
    viewerToken = auth.generateToken(viewer);
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
    app.use('/api/info', load('routes/info'));
    app.use('/api/library', load('routes/library'));
    app.use('/api/lineup', load('routes/lineup'));
    app.use('/api/channels', auth.requireAuth, load('routes/channels'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    delete process.env.PIGTV_CHANNEL_NUMBERS;
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('/api/info advertises channelNumbers, and not when PIGTV_CHANNEL_NUMBERS=0', async () => {
    assert.equal((await get('/api/info')).features.channelNumbers, true);
    process.env.PIGTV_CHANNEL_NUMBERS = '0';
    try {
        assert.equal((await get('/api/info')).features.channelNumbers, undefined);
    } finally {
        delete process.env.PIGTV_CHANNEL_NUMBERS;
    }
});

test('a completed sync numbers the visible channels in guide order, once per identity', async () => {
    await syncWith([
        [101, 'Alpha', 'News'],
        [102, 'Bravo', 'News'],
        [103, 'Charlie', 'Sport'],
        [101, 'Alpha', 'Sport'], // cross-listed: same channel, same number
        [104, 'Delta', 'Sport']
    ]);
    const guide = await get('/api/library/guide?limit=50');
    assert.deepEqual(guide.channels.map(c => [c.name, c.number]), [
        ['Alpha', 1], ['Alpha', 1], ['Bravo', 2], ['Charlie', 3], ['Delta', 4]
    ]);
    const channels = await get('/api/library/channels?limit=50');
    assert.deepEqual(numbersByName(channels.channels), { Alpha: 1, Bravo: 2, Charlie: 3, Delta: 4 });
});

test('favourites and recent rows carry number too', async () => {
    const d = sqlite.getDb();
    const bravo = d.prepare(`SELECT item_id, stable_id FROM playlist_items WHERE name = 'Bravo'`).get();
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (1, ?, ?, 'channel', ?)`)
        .run(source.id, bravo.item_id, bravo.stable_id);
    d.prepare(`INSERT INTO channel_history (user_id, source_id, channel_item_id, channel_name, watched_at, stable_id)
               VALUES ('1', ?, ?, 'Bravo', ?, ?)`).run(source.id, bravo.item_id, Date.now(), bravo.stable_id);
    assert.equal((await get('/api/library/favourites'))[0].number, 2);
    assert.equal((await get('/api/library/recent'))[0].number, 2);
});

test('a provider reorder keeps every number (identity, not position); a new channel gets the next one; a gone one is reserved', async () => {
    const d = sqlite.getDb();
    const bravoBefore = d.prepare(`SELECT item_id FROM playlist_items WHERE name = 'Bravo'`).get().item_id;
    await syncWith([
        [105, 'Echo', 'News'],     // new, and first in the playlist
        [104, 'Delta', 'Sport'],
        [102, 'Bravo', 'News'],
        [101, 'Alpha', 'News']
        // 103 Charlie has gone
    ]);
    const bravoAfter = d.prepare(`SELECT item_id FROM playlist_items WHERE name = 'Bravo'`).get().item_id;
    assert.notEqual(bravoAfter, bravoBefore, 'the reorder really moved the position ids');

    const guide = await get('/api/library/guide?limit=50');
    // Ordered by number: the old (playlist) order would put Echo first.
    assert.deepEqual(guide.channels.map(c => [c.name, c.number]), [
        ['Alpha', 1], ['Bravo', 2], ['Delta', 4], ['Echo', 5]
    ]);
    assert.ok(d.prepare(`SELECT 1 FROM channel_numbers WHERE number = 3`).get(), 'Charlie keeps 3 while it is gone');

    // Back within 30 days: the same number.
    await syncWith([[105, 'Echo', 'News'], [104, 'Delta', 'Sport'], [102, 'Bravo', 'News'],
        [101, 'Alpha', 'News'], [103, 'Charlie', 'Sport']]);
    assert.equal(numbersByName((await get('/api/library/channels?limit=50')).channels).Charlie, 3);
});

test('a reservation is released after 30 days, and a returning channel then gets a fresh number', async () => {
    const numbers = load('services/channelNumbers');
    await syncWith([[105, 'Echo', 'News'], [104, 'Delta', 'Sport'], [102, 'Bravo', 'News'], [101, 'Alpha', 'News']]);
    numbers.assignChannelNumbers({ now: Date.now() + 29 * 24 * 3600e3 });
    assert.ok(sqlite.getDb().prepare('SELECT 1 FROM channel_numbers WHERE number = 3').get(), 'still reserved at 29 days');
    numbers.assignChannelNumbers({ now: Date.now() + 31 * 24 * 3600e3 });
    assert.equal(sqlite.getDb().prepare('SELECT 1 FROM channel_numbers WHERE number = 3').get(), undefined, 'released after 30');
    await syncWith([[105, 'Echo', 'News'], [104, 'Delta', 'Sport'], [102, 'Bravo', 'News'],
        [101, 'Alpha', 'News'], [103, 'Charlie', 'Sport']]);
    assert.equal(numbersByName((await get('/api/library/channels?limit=50')).channels).Charlie, 6);
});

test('hiding a channel keeps its number reserved; showing a never-numbered one numbers it', async () => {
    const d = sqlite.getDb();
    const delta = d.prepare(`SELECT item_id FROM playlist_items WHERE name = 'Delta'`).get().item_id;
    await call('POST', '/api/channels/hide', { body: { sourceId: source.id, itemType: 'channel', itemId: delta } });
    assert.equal(numbersByName((await get('/api/lineup'))).Delta, undefined, 'hidden: not in the lineup');
    await call('POST', '/api/channels/show', { body: { sourceId: source.id, itemType: 'channel', itemId: delta } });
    assert.equal(numbersByName(await get('/api/lineup')).Delta, 4, 'shown again: same number');
});

test('GET /api/lineup is admin only and lists each visible channel once, by number', async () => {
    assert.equal((await call('GET', '/api/lineup', { token: viewerToken })).status, 403);
    const lineup = await get('/api/lineup');
    assert.deepEqual(lineup.map(r => [r.name, r.number]), [['Alpha', 1], ['Bravo', 2], ['Delta', 4], ['Echo', 5], ['Charlie', 6]]);
    const alpha = lineup[0];
    assert.deepEqual(Object.keys(alpha).sort(), ['category', 'id', 'name', 'number', 'sourceId', 'stableId']);
    assert.equal(alpha.sourceId, source.id);
    assert.ok(alpha.stableId);
});

test('PUT /api/lineup/numbers validates: admin only, positive whole numbers, no duplicates, no clash with another visible channel', async () => {
    const lineup = await get('/api/lineup');
    const id = name => lineup.find(r => r.name === name).id;
    const put = (numbers, token) => call('PUT', '/api/lineup/numbers', { token, body: { numbers } });

    assert.equal((await put([{ sourceId: source.id, id: id('Alpha'), number: 9 }], viewerToken)).status, 403);
    for (const bad of [0, -1, 1.5, '3', null]) {
        const r = await put([{ sourceId: source.id, id: id('Alpha'), number: bad }]);
        assert.equal(r.status, 400, `number ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal((await put([])).status, 400);
    assert.equal((await put([{ sourceId: source.id, id: 'pos_999', number: 9 }])).status, 400, 'unknown channel');

    const dup = await put([{ sourceId: source.id, id: id('Alpha'), number: 7 }, { sourceId: source.id, id: id('Bravo'), number: 7 }]);
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /Duplicate number 7/);

    const clash = await put([{ sourceId: source.id, id: id('Alpha'), number: 5 }]); // Echo holds 5
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /Duplicate number 5/);
    assert.deepEqual(numbersByName(await get('/api/lineup')), { Alpha: 1, Bravo: 2, Delta: 4, Echo: 5, Charlie: 6 },
        'a refused request changes nothing');
});

test('PUT /api/lineup/numbers applies a swap, bumps the guide version, and the guide follows the new order', async () => {
    const lineup = await get('/api/lineup');
    const id = name => lineup.find(r => r.name === name).id;
    const before = (await get('/api/library/guide/version')).version;
    const r = await call('PUT', '/api/lineup/numbers', { body: { numbers: [
        { sourceId: source.id, id: id('Alpha'), number: 5 },
        { sourceId: source.id, id: id('Echo'), number: 1 }
    ] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true });
    assert.notEqual((await get('/api/library/guide/version')).version, before, 'renumbering must change the guide version');
    const guide = await get('/api/library/guide?limit=50');
    assert.deepEqual(guide.channels.map(c => c.name), ['Echo', 'Bravo', 'Delta', 'Alpha', 'Charlie']);
});

test('a number reserved for a vanished channel yields to the admin', async () => {
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO channel_numbers (source_id, channel_key, item_id, number, last_seen) VALUES (?, 'sGone', 'pos_77', 50, ?)`)
        .run(source.id, Date.now());
    const bravo = (await get('/api/lineup')).find(r => r.name === 'Bravo');
    const r = await call('PUT', '/api/lineup/numbers', { body: { numbers: [{ sourceId: source.id, id: bravo.id, number: 50 }] } });
    assert.equal(r.status, 200);
    assert.equal(d.prepare(`SELECT channel_key FROM channel_numbers WHERE number = 50`).get().channel_key, bravo.stableId);
});

test('cursor paging by number is exact: the same rows, once each, in the offset order', async () => {
    // Many channels, then a renumbering that scrambles number order against
    // playlist order and leaves some channels unnumbered (nulls sort last).
    const d = sqlite.getDb();
    const insert = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data, stable_id)
                              VALUES (?, ?, ?, 'live', ?, 'Bulk', ?, '{}', ?)`);
    for (let i = 0; i < 60; i++) insert.run(`${source.id}:bulk_${i}`, source.id, `bulk_${i}`, `Bulk ${String(i).padStart(2, '0')}`, 1000 + (i % 7), `sb${i}`);
    load('services/channelNumbers').assignChannelNumbers();
    const numbers = [];
    for (let i = 0; i < 60; i += 2) numbers.push({ sourceId: source.id, id: `bulk_${i}`, number: 200 - i });
    assert.equal((await call('PUT', '/api/lineup/numbers', { body: { numbers } })).status, 200);
    d.prepare(`DELETE FROM channel_numbers WHERE channel_key IN ('sb1', 'sb3', 'sb5')`).run(); // unnumbered

    const all = (await get('/api/library/guide?limit=500')).channels;
    const keys = all.map(c => c.number ?? Infinity);
    assert.deepEqual([...keys].sort((a, b) => a - b), keys, 'offset listing is ordered by number, nulls last');
    assert.equal(all.at(-1).number, null);

    const paged = [];
    let cursor = null;
    let first = true;
    while (first || cursor) {
        const page = await get(`/api/library/guide?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        paged.push(...page.channels);
        cursor = page.nextCursor;
        first = false;
    }
    assert.deepEqual(paged.map(c => c.id), all.map(c => c.id), 'cursor pages give the same rows in the same order as the offset listing');

    // A cursor from the un-numbered ordering is refused rather than mis-paged.
    const legacy = Buffer.from(JSON.stringify({ sk: 1, name: 'x', id: 'y' })).toString('base64');
    assert.equal((await call('GET', `/api/library/guide?cursor=${encodeURIComponent(legacy)}`)).status, 400);
});

test('PIGTV_CHANNEL_NUMBERS=0 puts the guide back in its old order (numbers still present)', async () => {
    process.env.PIGTV_CHANNEL_NUMBERS = '0';
    try {
        const guide = (await get('/api/library/guide?limit=500')).channels;
        const sortOrders = sqlite.getDb().prepare(`SELECT item_id, COALESCE(sort_order, 999999999) AS so FROM playlist_items`).all();
        const so = Object.fromEntries(sortOrders.map(r => [r.item_id, r.so]));
        const keys = guide.map(c => so[c.id]);
        assert.deepEqual([...keys].sort((a, b) => a - b), keys);
        assert.ok(guide.some(c => c.number !== null));
    } finally {
        delete process.env.PIGTV_CHANNEL_NUMBERS;
    }
});
