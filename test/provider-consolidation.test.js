const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0182: one card per provider: the guide that is synced from the primary's card and dropped for a
// backup. (The one-time move at start-up into one card per provider went with D-57: every database
// still opened has had it.)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-consolidation-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const syncService = load('services/syncService');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const sql = () => sqlite.getDb();
const addProgramme = (sourceId, gen = 0) => sql().prepare(
    `INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, gen) VALUES ('abc.au', ?, 1, 2, 'News', '', ?)`).run(sourceId, gen);
const liveGuide = (sourceId) => sql().prepare('SELECT COUNT(*) AS n FROM epg_live WHERE source_id = ?').get(sourceId).n;
const GUIDE = 'http://epgenius.invalid/guide.xml?user=SECRETUSER';

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
    assert.match(source, /async syncBackup\(source, options = \{\}\) \{\s*await this\.dropGuide\(source\.id\);/);
});
