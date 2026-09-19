const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const auth = load('auth');
const sync = load('services/syncService');

const H = 3600000;
let server, base, token, source;

async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });
    const epg = await db.sources.create({ type: 'epg', name: 'Guide', url: 'https://guide.invalid/x.xml' });

    const originalFetch = global.fetch;
    global.fetch = async () => new Response('#EXTM3U\n#EXTINF:-1 tvg-id="ch1" group-title="All",One\nhttps://provider.invalid/1.ts\n');
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    const now = Date.now();
    const ins = sqlite.getDb().prepare('INSERT INTO epg_programs (source_id, channel_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)');
    // Around the window [now, now+3h]:
    ins.run(epg.id, 'ch1', now - 72 * H, now - 71 * H, 'Three days ago');           // long gone
    ins.run(epg.id, 'ch1', now - 30 * H, now + 1 * H, 'Ancient marathon');           // began 30 h ago (past the bound)
    ins.run(epg.id, 'ch1', now - 20 * H, now + 2 * H, 'Overnight marathon');         // began 20 h ago, still running
    ins.run(epg.id, 'ch1', now - 1 * H, now + 1 * H, 'On now');
    ins.run(epg.id, 'ch1', now + 1 * H, now + 2 * H, 'Up next');
    ins.run(epg.id, 'ch1', now + 30 * H, now + 31 * H, 'Tomorrow, outside the window');

    const app = express();
    app.use(auth.passport.initialize());
    app.use('/api/auth', load('routes/auth')); // registers the JWT strategy
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

test('the guide shows what overlaps the window, including a long programme that began well before it', async () => {
    const { channels } = await get('/api/library/guide?limit=5');
    const titles = channels[0].programmes.map(p => p.title);
    assert.deepEqual(titles, ['Overnight marathon', 'On now', 'Up next']);
});

test('the lower bound is what keeps the scan short: a programme older than a day is not fetched', async () => {
    const { channels } = await get('/api/library/guide?limit=5');
    const titles = channels[0].programmes.map(p => p.title);
    assert.ok(!titles.includes('Ancient marathon'), 'documented limit: a programme that began over 24 h before the window is not shown');
    assert.ok(!titles.includes('Three days ago'));
    assert.ok(!titles.includes('Tomorrow, outside the window'));
});

test('now and next on the channel list are unaffected', async () => {
    const { channels } = await get('/api/library/channels');
    // "Overnight marathon" also overlaps now and starts earlier than "On now"; the
    // query orders by start time, so it is the first current programme found.
    assert.equal(channels[0].now.title, 'Overnight marathon');
    assert.equal(channels[0].next.title, 'Up next');
});

test('item lookups by (source, item id) are indexed', () => {
    const db = sqlite.getDb();
    const indexes = db.prepare("PRAGMA index_list('playlist_items')").all().map(i => i.name);
    assert.ok(indexes.includes('idx_items_source_item'));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT stream_url FROM playlist_items WHERE source_id = ? AND item_id = ?").all(1, 'x')
        .map(r => r.detail).join(' ');
    assert.match(plan, /idx_items_source_item/, `expected the item index to be used, got: ${plan}`);
});

test('the EPG range scan is bounded on both sides of start_time', () => {
    // The shape library.js relies on: with a lower bound on start_time the index
    // is searched as a range instead of walked from the start of the feed.
    const plan = sqlite.getDb().prepare(`EXPLAIN QUERY PLAN
        SELECT title FROM epg_live WHERE channel_id IN (?) AND start_time > ? AND end_time > ? AND start_time < ?`)
        .all('ch1', 0, 0, 1).map(r => r.detail).join(' ');
    assert.match(plan, /idx_epg_channel_time \(channel_id=\? AND start_time>\? AND start_time<\?\)/, plan);
});
