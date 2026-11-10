const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The JSON-file collections db.json once held are gone from the store module. (The import of a
// db.json itself went with D-57.) A copy of the server with its own data/ folder (same approach as
// access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dblegacy-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const db = require(path.join(sandbox, 'server', 'db'));

after(() => {
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('the JSON-file hidden items and favourites collections are gone from the module', () => {
    assert.equal(db.hiddenItems, undefined);
    assert.equal(db.favorites, undefined);
    assert.equal(typeof db.sources.getAll, 'function', 'sources, settings and users are untouched');
    assert.equal(typeof db.settings.get, 'function');
    assert.equal(typeof db.users.getByUsername, 'function');
});
