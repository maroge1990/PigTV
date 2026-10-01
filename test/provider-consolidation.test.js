const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0182: one card per provider. The one-time move at startup (the standalone EPG source becomes
// the primary's guide address, hand-typed limits and dates go, one primary and numbered
// backups), and the guide that is synced from the primary's card and dropped for a backup.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-consolidation-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const syncService = load('services/syncService');
const migration = load('services/providerMigration');
const synced = [];
syncService.syncSource = async (id) => { synced.push(id); };

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const sql = () => sqlite.getDb();
const addLive = (sourceId) => sql().prepare(
    `INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order)
     VALUES (?, ?, 'pos_1', 'live', 'Alpha', 'News', 0, 1)`).run(`${sourceId}:pos_1`, sourceId);
const addProgramme = (sourceId, gen = 0) => sql().prepare(
    `INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, gen) VALUES ('abc.au', ?, 1, 2, 'News', '', ?)`).run(sourceId, gen);
const liveGuide = (sourceId) => sql().prepare('SELECT COUNT(*) AS n FROM epg_live WHERE source_id = ?').get(sourceId).n;
const GUIDE = 'http://epgenius.invalid/guide.xml?user=SECRETUSER';

test('the one-time move: guide onto the primary with its programmes, hand-typed fields gone, one primary, backups numbered', async () => {
    const strong = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://s.invalid/a.m3u', maxConnections: 2 });
    const second = await db.sources.create({ type: 'm3u', name: 'Added the old way', url: 'http://o.invalid/a.m3u' });
    const dream = await db.sources.create({ type: 'xtream', name: 'Dream4K', url: 'http://d.invalid', username: 'u', password: 'p',
        role: 'backup', priority: 3, subscription: { endsAt: '2027-01-01' }, idOverlayUrl: 'http://e.invalid/list.m3u' });
    const epg = await db.sources.create({ type: 'epg', name: 'EPGenius', url: GUIDE });
    const other = await db.sources.create({ type: 'epg', name: 'Second guide', url: 'http://g2.invalid/x.xml' });
    addLive(strong.id);
    // The EPG source is on generation 4: its live rows must stay live under the primary.
    sql().prepare('INSERT INTO epg_state (source_id, active_gen) VALUES (?, 4)').run(epg.id);
    addProgramme(epg.id, 4); addProgramme(epg.id, 4);
    sql().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES (?, ?, 'abc.au', 'epg_channel', 'ABC')`).run(`${epg.id}:abc.au`, epg.id);
    sql().prepare(`INSERT INTO sync_status (source_id, type, last_sync, status) VALUES (?, 'all', 123, 'success')`).run(epg.id);
    addProgramme(other.id);

    const report = await migration.run();
    assert.deepEqual(report, { cleared: 2, reordered: true, guide: 'moved' });

    const all = await db.sources.getAll();
    const of = (id) => all.find(s => s.id === id);
    assert.equal(of(epg.id), undefined, 'the EPG source is gone');
    assert.ok(of(other.id), 'a second EPG source is left alone');
    assert.equal(of(strong.id).epgUrl, GUIDE);
    assert.deepEqual([of(strong.id).role, of(strong.id).priority], ['primary', null]);
    assert.deepEqual([of(dream.id).role, of(dream.id).priority], ['backup', 1], 'the backup it already had comes first');
    assert.deepEqual([of(second.id).role, of(second.id).priority], ['backup', 2], 'a second "primary" becomes the last backup');
    for (const s of all) assert.ok(s.maxConnections == null && s.subscription == null, s.name);
    assert.equal(of(dream.id).idOverlayUrl, 'http://e.invalid/list.m3u', 'the overlay address is kept');

    assert.equal(liveGuide(strong.id), 2, 'the guide is live under the primary, never empty in between');
    assert.equal(liveGuide(epg.id), 0);
    assert.equal(liveGuide(other.id), 1);
    assert.equal(sql().prepare(`SELECT id FROM playlist_items WHERE type = 'epg_channel'`).get().id, `${strong.id}:abc.au`);
    assert.deepEqual(sql().prepare(`SELECT type, last_sync FROM sync_status WHERE source_id = ?`).all(strong.id), [{ type: 'epg', last_sync: 123 }]);
    assert.equal(sql().prepare('SELECT COUNT(*) AS n FROM sync_status WHERE source_id = ?').get(epg.id).n, 0);
    assert.deepEqual(synced, [], 'nothing needed a sync');

    assert.equal(await migration.run(), null, 'it runs once');
    for (const s of await db.sources.getAll()) await db.sources.delete(s.id);
    sql().exec('DELETE FROM epg_programs; DELETE FROM epg_state; DELETE FROM playlist_items; DELETE FROM sync_status');
});

test('the one-time move, an Xtream primary with its own guide: the EPG source\'s rows go and the primary is synced', async () => {
    sql().prepare(`DELETE FROM meta WHERE key = 'providers_consolidated'`).run();
    const x = await db.sources.create({ type: 'xtream', name: 'Raw', url: 'http://x.invalid', username: 'u', password: 'p' });
    const epg = await db.sources.create({ type: 'epg', name: 'Guide', url: GUIDE });
    const disabled = await db.sources.create({ type: 'epg', name: 'Off', url: 'http://off.invalid/x.xml' });
    await db.sources.toggleEnabled(disabled.id);
    addProgramme(x.id); addProgramme(epg.id);
    const report = await migration.run();
    assert.deepEqual(report, { cleared: 0, reordered: false, guide: 'resync' });
    assert.equal((await db.sources.getById(x.id)).epgUrl, GUIDE);
    assert.equal(liveGuide(epg.id), 0);
    assert.equal(liveGuide(x.id), 1, 'its own guide stays until the sync replaces it');
    assert.deepEqual(synced, [x.id]);
    assert.ok(await db.sources.getById(disabled.id), 'a disabled EPG source is not taken');
    for (const s of await db.sources.getAll()) await db.sources.delete(s.id);
    sql().exec('DELETE FROM epg_programs; DELETE FROM epg_state');
});

test('with nothing to move it only records that it ran', async () => {
    sql().prepare(`DELETE FROM meta WHERE key = 'providers_consolidated'`).run();
    assert.deepEqual(await migration.run(), { cleared: 0, reordered: false, guide: null });
    const only = await db.sources.create({ type: 'm3u', name: 'Only', url: 'http://s.invalid/a.m3u', epgUrl: 'http://kept.invalid/x.xml' });
    const epg = await db.sources.create({ type: 'epg', name: 'Guide', url: GUIDE });
    sql().prepare(`DELETE FROM meta WHERE key = 'providers_consolidated'`).run();
    assert.deepEqual(await migration.run(), { cleared: 0, reordered: false, guide: null });
    assert.equal((await db.sources.getById(only.id)).epgUrl, 'http://kept.invalid/x.xml', 'a guide address already on the card wins');
    assert.ok(await db.sources.getById(epg.id));
    for (const s of await db.sources.getAll()) await db.sources.delete(s.id);
});

test('the primary\'s guide: its card\'s address, else the provider\'s own; a failure is recorded and keeps the old guide', async () => {
    const calls = [];
    const real = syncService.syncEpgFromUrl;
    syncService.syncEpgFromUrl = async (id, url) => { calls.push([id, url]); };
    const status = (id) => sql().prepare(`SELECT status, error FROM sync_status WHERE source_id = ? AND type = 'epg'`).get(id);
    try {
        await syncService.syncProviderGuide({ id: 71, name: 'P', epgUrl: GUIDE }, 'http://own.invalid/xmltv.php');
        await syncService.syncProviderGuide({ id: 71, name: 'P' }, 'http://own.invalid/xmltv.php');
        assert.deepEqual(calls, [[71, GUIDE], [71, 'http://own.invalid/xmltv.php']]);
        assert.deepEqual(status(71), { status: 'success', error: null });

        addProgramme(71);
        syncService.syncEpgFromUrl = async () => { throw new Error(`HTTP 502 from ${GUIDE}`); };
        await syncService.syncProviderGuide({ id: 71, name: 'P', epgUrl: GUIDE });
        assert.equal(status(71).status, 'error');
        assert.ok(!status(71).error.includes('SECRETUSER'), status(71).error);
        assert.equal(liveGuide(71), 1, 'the guide it had is kept');

        // No address at all (an M3U whose guide address was removed): the guide goes.
        calls.length = 0;
        syncService.syncEpgFromUrl = async (id, url) => { calls.push([id, url]); };
        await syncService.syncProviderGuide({ id: 71, name: 'P' });
        assert.deepEqual(calls, []);
        assert.equal(liveGuide(71), 0);
        assert.equal(status(71), undefined);
    } finally {
        syncService.syncEpgFromUrl = real;
    }
});

test('a provider that became a backup keeps no guide', async () => {
    sql().prepare('INSERT INTO epg_state (source_id, active_gen) VALUES (72, 3)').run();
    addProgramme(72, 3); addProgramme(72, 2); addProgramme(73);
    await syncService.dropGuide(72);
    assert.equal(sql().prepare('SELECT COUNT(*) AS n FROM epg_programs WHERE source_id = 72').get().n, 0);
    assert.equal(sql().prepare('SELECT COUNT(*) AS n FROM epg_state WHERE source_id = 72').get().n, 0);
    assert.equal(liveGuide(73), 1, 'another provider\'s guide is untouched');
    await syncService.dropGuide(72); // nothing left: a no-op
    const source = fs.readFileSync(path.join(sandbox, 'server/services/syncService.js'), 'utf8');
    assert.match(source, /async syncBackup\(source\) \{\s*await this\.dropGuide\(source\.id\);/);
});
