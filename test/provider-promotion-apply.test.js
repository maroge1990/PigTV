const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #15 (0374): moving a backup to the top of the provider order makes it the primary, and the old primary's lineup
// comes with it: the shown channels (and only those), their numbers, favourites, guide matches, series rules and
// pending recordings. On 0373 the new primary showed all of its channels, freshly numbered, with nothing carried.
// Two fake M3U providers over HTTP, the real order route and the real syncs.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-promotion-apply-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_DB_BACKUPS = '0';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const hiddenChannels = load('services/hiddenChannels');

let provider, providerBase, server, base, token, admin, primary, backup;
const entry = (id, name, group) => `#EXTINF:-1 tvg-id="" group-title="${group}",${name}\n${providerBase}/live/u/p/${id}.ts`;
const playlists = {
    '/p.m3u': () => ['#EXTM3U', entry(100, 'Fox Footy 504', 'Sport'), entry(101, 'ESPN', 'Sport'), entry(102, 'Sky Sports F1', 'Sport'),
        entry(103, 'beIN Sports 1', 'Sport'), entry(110, 'Some film channel', 'Movies')].join('\n'),
    '/b.m3u': () => ['#EXTM3U', entry(9200, 'Random channel', 'Other'), entry(9100, 'AU| FOX FOOTY HD', 'AU Sport'),
        entry(9101, 'ESPN HD', 'US Sport'), entry(9102, 'SKY SPORTS F1', 'UK Sport'), entry(9103, 'beIN 1', 'Intl')].join('\n')
};
const realLog = console.log, realWarn = console.warn;

before(async () => {
    console.log = () => {}; console.warn = () => {};
    provider = http.createServer((req, res) => {
        const body = playlists[req.url.split('?')[0]];
        if (!body) { res.statusCode = 404; return res.end(); }
        res.setHeader('content-type', 'audio/x-mpegurl');
        res.end(body());
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    providerBase = `http://127.0.0.1:${provider.address().port}`;
    admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    load('db/recordingsDb').initSchema();

    primary = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `${providerBase}/p.m3u` });
    await sync.syncSource(primary.id);
    const d = sqlite.getDb();
    // The admin's lineup on the primary: Movies hidden; the rest shown and numbered by the sync.
    d.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND category_id = 'Movies'`).run(primary.id);
    d.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND category_id = 'Movies'`).run(primary.id);
    hiddenChannels.capture(d, primary.id);
    load('services/channelNumbers').refreshChannelNumbers();

    backup = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: `${providerBase}/b.m3u`, role: 'backup', priority: 1 });
    await sync.syncSource(backup.id);
    // Links the admin approved (kept by every relink): Fox Footy, ESPN and Sky Sports F1. beIN has none.
    const link = d.prepare(`DELETE FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ?`);
    link.run(primary.id, backup.id);
    const add = d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
        VALUES (?, ?, ?, ?, 'manual', 'approved', 1, 0, 0)`);
    add.run(primary.id, 's100', backup.id, '9100'); add.run(primary.id, 's101', backup.id, '9101'); add.run(primary.id, 's102', backup.id, '9102');
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, ?, 'pos_1', 'channel', 's100')`).run(admin.id, primary.id);
    d.prepare('INSERT INTO epg_mappings (source_id, channel_key, tvg_id, updated_at) VALUES (?, ?, ?, ?)').run(primary.id, 's102', 'SkySportsF1.uk', 1);
    d.prepare(`INSERT INTO recording_rules (kind, match, source_id, channel_item_id, channel_stable_id, channel_name, created_at)
        VALUES ('series', 'Formula 1', ?, 'pos_3', 's102', 'Sky Sports F1', 1)`).run(primary.id);
    d.prepare(`INSERT INTO scheduled_recordings (title, source_id, channel_item_id, channel_stable_id, channel_name, program_start, program_end, status, created_at)
        VALUES ('AFL', ?, 'pos_1', 's100', 'Fox Footy 504', ?, ?, 'scheduled', 1)`).run(primary.id, Date.now() + 3600e3, Date.now() + 7200e3);

    const app = express();
    app.use(express.json());
    app.use('/api/sources', load('routes/sources'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    console.log = realLog; console.warn = realWarn;
    sync.stopSyncTimer?.();
    server.closeAllConnections(); await new Promise(r => server.close(r));
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const order = (ids) => fetch(`${base}/api/sources/order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ids })
}).then(r => r.json());
const live = (id) => sqlite.getDb().prepare(`SELECT p.stable_id AS k, p.is_hidden AS h, p.name FROM playlist_items p WHERE source_id = ? AND type = 'live' ORDER BY stable_id`).all(id);
const shownKeys = (id) => live(id).filter(r => !r.h).map(r => r.k);
async function settled(id) {
    for (let i = 0; i < 200; i++) {
        const s = sqlite.getDb().prepare(`SELECT status FROM sync_status WHERE source_id = ? AND type = 'all'`).get(id)?.status;
        if (s === 'success' && live(id).length && !sqlite.getDb().prepare('SELECT 1 FROM provider_promotions LIMIT 1').get()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('the new primary did not finish syncing');
}

test('#15: a backup moved to the top takes over the shown channels, numbers, favourites, guide matches, rules and recordings', async () => {
    const d = sqlite.getDb();
    const number = (src, key) => d.prepare('SELECT number FROM channel_numbers WHERE source_id = ? AND channel_key = ?').get(src, key)?.number;
    const before = { s100: number(primary.id, 's100'), s101: number(primary.id, 's101'), s102: number(primary.id, 's102') };
    assert.ok(before.s100 && before.s101 && before.s102, 'numbered on the primary');
    assert.deepEqual(shownKeys(primary.id), ['s100', 's101', 's102', 's103']);

    const res = await order([backup.id, primary.id]);
    assert.equal(res.primaryChanged, true);
    assert.deepEqual(res.promotion.shown, { total: 4, carried: 3 }, 'the response carries the dry run');
    await settled(backup.id);

    assert.deepEqual(shownKeys(backup.id), ['s9100', 's9101', 's9102'], 'only the carried channels are shown');
    const groups = Object.fromEntries(d.prepare(`SELECT category_id, is_hidden FROM categories WHERE source_id = ? AND type = 'live'`).all(backup.id).map(c => [c.category_id, c.is_hidden]));
    assert.deepEqual(groups, { 'AU Sport': 0, 'US Sport': 0, 'UK Sport': 0, Intl: 1, Other: 1 });
    assert.deepEqual([number(backup.id, 's9100'), number(backup.id, 's9101'), number(backup.id, 's9102')], [before.s100, before.s101, before.s102],
        'each carried channel keeps its number');
    assert.ok(d.prepare(`SELECT 1 FROM favorites WHERE source_id = ? AND stable_id = 's9100' AND item_type = 'channel'`).get(backup.id), 'the favourite');
    assert.equal(d.prepare('SELECT tvg_id FROM epg_mappings WHERE source_id = ? AND channel_key = ?').get(backup.id, 's9102')?.tvg_id, 'SkySportsF1.uk');
    const rule = d.prepare(`SELECT source_id, channel_stable_id, channel_item_id FROM recording_rules WHERE match = 'Formula 1'`).get();
    assert.deepEqual([rule.source_id, rule.channel_stable_id], [backup.id, 's9102']);
    assert.match(rule.channel_item_id, /^pos_\d+$/);
    const sched = d.prepare(`SELECT source_id, channel_stable_id FROM scheduled_recordings WHERE title = 'AFL'`).get();
    assert.deepEqual([sched.source_id, sched.channel_stable_id], [backup.id, 's9100']);

    // The next sync keeps it (the record follows the channels), and nothing is listed as new.
    await sync.syncSource(backup.id);
    assert.deepEqual(shownKeys(backup.id), ['s9100', 's9101', 's9102']);
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM new_channel_groups WHERE source_id = ?').get(backup.id).c, 0);
});

test('#15: moving the old primary back restores its own choice of channels', async () => {
    await order([primary.id, backup.id]);
    await settled(primary.id);
    assert.deepEqual(shownKeys(primary.id), ['s100', 's101', 's102', 's103'], 'its own record: beIN shown, the film channel hidden');
    assert.equal(sqlite.getDb().prepare('SELECT 1 FROM provider_promotions LIMIT 1').get(), undefined, 'no plan left behind');
});

// #181: the plan was applied (and gone) at publish even when the import failed part-way: only the channels written so
// far carried, and the sync that then wrote the whole list had nothing to apply.
test('#181: a playlist import that fails part-way keeps the plan; the next complete one uses it', async () => {
    const d = sqlite.getDb();
    const promotion = load('services/providerPromotion');
    // The switch as the order route makes it, without its background syncs (so nothing races the failed import).
    promotion.store(primary.id, backup.id);
    await db.sources.setOrder([{ id: backup.id, role: 'primary', priority: null }, { id: primary.id, role: 'backup', priority: 1 }]);
    await sync.syncSource(primary.id); // demoted: out of the library
    await sync.withHiddenChannels(backup, async () => {
        // One channel written, then the playlist connection drops.
        d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id)
            VALUES (?, ?, 'pos_1', 'live', 'AU| FOX FOOTY HD', 'AU Sport', 0, 1, 's9100')`).run(`${backup.id}:pos_1`, backup.id);
        throw new Error('the playlist connection dropped');
    }).catch(() => {});
    assert.deepEqual(promotion.pending(), { fromId: primary.id, toId: backup.id }, 'kept after a failed import');
    await sync.syncSource(backup.id);
    assert.equal(promotion.pending(), null, 'used by the complete sync');
    assert.deepEqual(shownKeys(backup.id), ['s9100', 's9101', 's9102']);
    await db.sources.setOrder([{ id: primary.id, role: 'primary', priority: null }, { id: backup.id, role: 'backup', priority: 1 }]);
    await sync.syncSource(backup.id);
    await sync.syncSource(primary.id);
    assert.deepEqual(shownKeys(primary.id), ['s100', 's101', 's102', 's103']);
});

// #182: on 0377 whether the new primary keeps "its own earlier choice" was decided when the plan was applied. A failed
// first import that wrote some groups makes the retry hide the other groups as new and record them, so the record
// looked like an earlier choice: the carried visibility was skipped and the plan used up.
test('#182: a partial first import and a retry show exactly the carried channels', async () => {
    const d = sqlite.getDb();
    const promotion = load('services/providerPromotion');
    d.prepare('DELETE FROM hidden_channels WHERE source_id = ?').run(backup.id); // as a backup that was never the primary
    d.prepare(`DELETE FROM meta WHERE key = ?`).run(`hidden_channels_captured:${backup.id}`);
    // The admin's approved links, as in before() (the switches above relinked).
    d.prepare('DELETE FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ?').run(primary.id, backup.id);
    const add = d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
        VALUES (?, ?, ?, ?, 'manual', 'approved', 1, 0, 0)`);
    add.run(primary.id, 's100', backup.id, '9100'); add.run(primary.id, 's101', backup.id, '9101'); add.run(primary.id, 's102', backup.id, '9102');
    assert.equal(promotion.store(primary.id, backup.id).shown.carried, 3);
    await db.sources.setOrder([{ id: backup.id, role: 'primary', priority: null }, { id: primary.id, role: 'backup', priority: 1 }]);
    await sync.syncSource(primary.id);
    await sync.withHiddenChannels(backup, async () => {
        // One group and its channel written, then the import fails.
        d.prepare(`INSERT INTO categories (id, source_id, category_id, type, name, is_hidden) VALUES (?, ?, 'AU Sport', 'live', 'AU Sport', 0)`).run(`${backup.id}:AU Sport`, backup.id);
        d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id)
            VALUES (?, ?, 'pos_2', 'live', 'AU| FOX FOOTY HD', 'AU Sport', 0, 2, 's9100')`).run(`${backup.id}:pos_2`, backup.id);
        throw new Error('the playlist connection dropped');
    }).catch(() => {});
    await sync.syncSource(backup.id);
    assert.equal(promotion.pending(), null);
    assert.deepEqual(shownKeys(backup.id), ['s9100', 's9101', 's9102'], 'exactly the carried channels, the groups the retry saw as new included');
    await db.sources.setOrder([{ id: primary.id, role: 'primary', priority: null }, { id: backup.id, role: 'backup', priority: 1 }]);
    await sync.syncSource(backup.id);
    await sync.syncSource(primary.id);
});
