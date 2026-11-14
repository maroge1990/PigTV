const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0285: settings left behind by removed features (12 on the live server, 27 Oct) are never saved
// again. (The start-up delete of stored ones went with D-57: every database still opened has had it.)
// A copy of the server with its own data/ folder.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-retired-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite'));
const db = require(path.join(sandbox, 'server', 'db'));
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const storedKeys = () => sqlite.getDb().prepare('SELECT key FROM app_settings').all().map(r => r.key);

test('a save that still carries a retired setting does not bring it back', async () => {
    await quiet(() => db.settings.update({ forceProxy: true, requireStreamAuth: true, epgRefreshInterval: '12' }));
    assert.equal(storedKeys().includes('forceProxy'), false);
    assert.equal(storedKeys().includes('requireStreamAuth'), false);
    assert.equal((await db.settings.get()).epgRefreshInterval, '12');
});

// #322: a value an older server stored before its key was retired (no start-up delete runs any more, D-57) is not in
// what settings.get() hands out, so no code and no client can read it back.
test('a retired setting still stored from before is never handed out', async () => {
    const put = sqlite.getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
    for (const k of db.RETIRED_SETTINGS) put.run(k, JSON.stringify('stored-before'));
    await quiet(() => db.settings.update({ epgRefreshInterval: '6' })); // a write: the next get() reads the store again
    const s = await db.settings.get();
    for (const k of db.RETIRED_SETTINGS) assert.equal(k in s, false, k);
    assert.equal(s.epgRefreshInterval, '6');
});

test('no retired setting is one the server still has a default for', () => {
    const defaults = db.getDefaultSettings();
    for (const k of db.RETIRED_SETTINGS) assert.equal(k in defaults, false, k);
});

// 0290: a fresh install shares connections; an explicit stored opt-out remains authoritative.
test('shared ingest defaults on and a stored false survives a settings reload', async () => {
    assert.equal(db.getDefaultSettings().sharedIngestEnabled, true);
    assert.equal((await db.settings.get()).sharedIngestEnabled, true);
    await quiet(() => db.settings.update({ sharedIngestEnabled: false }));
    delete require.cache[require.resolve(path.join(sandbox, 'server', 'db'))];
    const reloaded = require(path.join(sandbox, 'server', 'db'));
    assert.equal((await reloaded.settings.get()).sharedIngestEnabled, false);
});
