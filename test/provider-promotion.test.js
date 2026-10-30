const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #15: making a backup the primary loses the curated lineup, which is keyed on the old primary's channels. The links
// already pair each shown primary channel with the same channel at each backup. 0373: a dry run says what would
// carry over. The old code has no preview (404).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-promotion-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_DB_BACKUPS = '0';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, token, primary, backup, other;
const realLog = console.log;

/**
 * The primary (Strong8K, M3U): five shown channels in Sport and one hidden group. The backup (Dream 4K): Fox Footy
 * and ESPN linked (auto; ESPN at rank 2 after a rank-1 link to a channel only in the provider's whole list), Sky
 * Sports F1 linked by hand (manual), beIN only pending, Kayo with no link.
 */
before(async () => {
    console.log = () => {};
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    primary = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://p.invalid/get.php' });
    backup = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://b.invalid/get.php', role: 'backup', priority: 1 });
    other = await db.sources.create({ type: 'm3u', name: 'Trex', url: 'http://t.invalid/get.php', role: 'backup', priority: 2 });
    const d = sqlite.getDb();
    load('db/recordingsDb').initSchema();
    d.prepare(`INSERT INTO categories (id, source_id, category_id, type, name, is_hidden) VALUES (?, ?, ?, 'live', ?, ?)`).run(`${primary.id}:Sport`, primary.id, 'Sport', 'Sport', 0);
    d.prepare(`INSERT INTO categories (id, source_id, category_id, type, name, is_hidden) VALUES (?, ?, ?, 'live', ?, ?)`).run(`${primary.id}:Hidden`, primary.id, 'Hidden', 'Hidden', 1);
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
        VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)`);
    const shown = [['pos_1', 'Fox Footy 504', 's100'], ['pos_2', 'ESPN', 's101'], ['pos_3', 'Sky Sports F1', 's102'],
        ['pos_4', 'beIN Sports 1', 's103'], ['pos_5', 'Kayo 1', 's104']];
    shown.forEach(([id, name, sid], i) => item.run(`${primary.id}:${id}`, primary.id, id, name, 'Sport', 0, i + 1, sid, `http://p.invalid/live/u/p/${sid.slice(1)}.ts`));
    item.run(`${primary.id}:pos_9`, primary.id, 'pos_9', 'Hidden channel', 'Hidden', 0, 9, 's109', 'http://p.invalid/live/u/p/109.ts');
    item.run(`${primary.id}:pos_0`, primary.id, 'pos_0', '### LOCAL NETWORKS ###', 'Sport', 0, 0, null, null); // a section line
    item.run(`${primary.id}:pos_10`, primary.id, 'pos_10', 'Hidden one', 'Sport', 1, 10, 's110', 'http://p.invalid/live/u/p/110.ts');

    const bc = d.prepare(`INSERT INTO backup_channels (source_id, stream_id, name, category_id, category_name, listed) VALUES (?, ?, ?, ?, ?, ?)`);
    bc.run(backup.id, '9100', 'AU| FOX FOOTY HD', 'AU Sport', 'AU Sport', 1);
    bc.run(backup.id, '9101', 'ESPN HD', 'US Sport', 'US Sport', 1);
    bc.run(backup.id, '9901', 'ESPN (provider list)', '77', 'Sports', 0);
    bc.run(backup.id, '9102', 'SKY SPORTS F1', 'UK Sport', 'UK Sport', 1);
    bc.run(backup.id, '9103', 'beIN 1', 'Sport', 'Sport', 1);
    const link = d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
        VALUES (?, ?, ?, ?, 'exact', ?, ?, 0, 0)`);
    link.run(primary.id, 's100', backup.id, '9100', 'auto', 1);
    link.run(primary.id, 's101', backup.id, '9901', 'auto', 1);
    link.run(primary.id, 's101', backup.id, '9101', 'auto', 2);
    link.run(primary.id, 's102', backup.id, '9102', 'manual', 1);
    link.run(primary.id, 's103', backup.id, '9103', 'pending', 1);
    link.run(primary.id, 's104', other.id, '5104', 'auto', 1); // Kayo is linked, but on the other backup

    const num = d.prepare('INSERT INTO channel_numbers (source_id, channel_key, item_id, number, last_seen) VALUES (?, ?, ?, ?, ?)');
    [['s100', 504], ['s101', 520], ['s102', 530], ['s104', 540]].forEach(([k, n]) => num.run(primary.id, k, null, n, Date.now()));
    const fav = d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type) VALUES (?, ?, ?, 'channel')`);
    fav.run(admin.id, primary.id, 's100'); fav.run(admin.id, primary.id, 's104');
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
    console.log = realLog;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const preview = (id) => fetch(`${base}/api/sources/${id}/promotion-preview`, { headers: { Authorization: `Bearer ${token}` } });

test('#15: the dry run says what making a backup the primary would carry over, and what not', async () => {
    const res = await preview(backup.id);
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.deepEqual(r.shown, { total: 5, carried: 3 }, 'Fox Footy, ESPN (its rank-2 link: rank 1 is not in the playlist) and Sky Sports F1');
    assert.equal(r.missing.count, 2);
    assert.deepEqual(r.missing.names, ['beIN Sports 1', 'Kayo 1'], 'in guide order');
    assert.equal(r.missing.withPendingMatch, 1, 'beIN has a match waiting for approval');
    assert.deepEqual(r.numbers, { total: 4, carried: 3 });
    assert.deepEqual(r.favourites, { total: 2, carried: 1 });
    assert.deepEqual(r.guideMatches, { total: 1, carried: 1 });
    assert.deepEqual(r.seriesRules, { total: 1, carried: 1 });
    assert.deepEqual(r.schedules, { total: 1, carried: 1 });
    assert.equal(r.listingUnknown, false);
    assert.ok(!JSON.stringify(r).includes('invalid'), 'no address');
});

test('#15: the mapping gives each carried channel its key as a primary channel, and nothing is changed', () => {
    const promotion = load('services/providerPromotion');
    const before = sqlite.getDb().prepare('SELECT COUNT(*) AS c FROM channel_numbers WHERE source_id = ?').get(primary.id).c;
    const { mapping } = promotion.plan(primary.id, backup.id);
    assert.deepEqual([...mapping.entries()].sort(), [['s100', 's9100'], ['s101', 's9101'], ['s102', 's9102']]);
    assert.equal(promotion.keyOf('h3f9a'), 'h3f9a', 'a hashed id stays as it is');
    assert.equal(sqlite.getDb().prepare('SELECT COUNT(*) AS c FROM channel_numbers WHERE source_id = ?').get(primary.id).c, before);
});

test('#15: the preview is for a backup, by an admin', async () => {
    assert.equal((await preview(primary.id)).status, 400, 'already the primary');
    assert.equal((await preview(99999)).status, 404);
    const viewer = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    assert.equal((await fetch(`${base}/api/sources/${backup.id}/promotion-preview`, { headers: { Authorization: `Bearer ${viewer}` } })).status, 403);
});
