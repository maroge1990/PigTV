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
    await quiet(() => db.settings.update({ forceProxy: true, requireStreamAuth: true, quality: 'low' }));
    assert.equal(storedKeys().includes('forceProxy'), false);
    assert.equal(storedKeys().includes('requireStreamAuth'), false);
    assert.equal((await db.settings.get()).quality, 'low');
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
