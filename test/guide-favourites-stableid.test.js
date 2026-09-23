const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0106: /library/channels has always returned stableId (via decorate()), but
// /library/favourites' SQL never selected p.stable_id (so decorate() produced
// null) and /library/guide built its rows without a stableId field at all -
// even though the hand-off already claimed all three routes had it (0097).
// Same sandboxed-server approach as guide-bounds.test.js and
// library-logos.test.js: a real sync against a real sqlite db, not mocks.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-fav-stableid-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sync = load('services/syncService');

let server, base, token, source;

async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });

    // An Xtream-shaped URL, so stableIds.js derives a stream-id-based identity
    // (s441360) rather than a URL hash - the same shape used elsewhere in the
    // suite (favourites-stable.test.js).
    const m3u = [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="ch1" group-title="All",One',
        'http://provider.invalid/live/u/p/441360.ts',
        ''
    ].join('\n');
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(m3u);
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    const app = express();
    app.use(express.json());
    app.use(auth.passport.initialize());
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
    try { load('db/sqlite').getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('the channel actually has a stableId (sanity check on the fixture)', async () => {
    const { channels } = await get('/api/library/channels');
    const one = channels.find(c => c.name === 'One');
    assert.ok(one, 'fixture channel exists');
    assert.equal(one.stableId, 's441360');
});

test('GET /library/favourites carries stableId, not null', async () => {
    const addResp = await fetch(`${base}/api/favorites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, itemId: 'pos_1', itemType: 'channel' })
    });
    assert.equal(addResp.status, 200, await addResp.text());

    const favourites = await get('/api/library/favourites');
    assert.equal(favourites.length, 1);
    assert.equal(favourites[0].stableId, 's441360', 'favourites must carry the identity, not decorate()-to-null');
});

test('GET /library/guide carries stableId on each channel row', async () => {
    const guide = await get('/api/library/guide');
    const one = guide.channels.find(c => c.name === 'One');
    assert.ok(one, 'fixture channel exists in the guide');
    assert.equal(one.stableId, 's441360', 'guide rows must carry stableId too');
});
