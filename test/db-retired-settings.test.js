const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0285: settings left behind by removed features (12 on the live server, 27 Oct) are dropped at
// start and never saved again. A copy of the server with its own data/ folder; the rows are put in
// the store the way the live database has them, before the settings module first opens it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-retired-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite'));
const LEFTOVERS = { forceProxy: false, requireStreamAuth: false, streamFormat: 'm3u8', showMovies: false, probeCacheTTL: 300 };
{
    const d = sqlite.getDb();
    // As on a server running for a while: the one-time first start (which seeds the defaults) is done.
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_data_migrated', ?)").run(new Date().toISOString());
    const put = d.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries({ ...LEFTOVERS, quality: 'high' })) put.run(k, JSON.stringify(v));
}
const db = require(path.join(sandbox, 'server', 'db'));
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const storedKeys = () => sqlite.getDb().prepare('SELECT key FROM app_settings').all().map(r => r.key);

test('retired settings are removed from the store at start; the rest are kept', async () => {
    const s = await quiet(() => db.settings.get());
    for (const k of Object.keys(LEFTOVERS)) {
        assert.equal(k in s, false, `${k} is not handed out`);
        assert.equal(storedKeys().includes(k), false, `${k} is not stored`);
    }
    assert.equal(s.quality, 'high', 'a setting in use is untouched');
});

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
