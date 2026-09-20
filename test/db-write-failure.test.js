const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A copy of the server with its own data/ folder, so the real db.json is never touched
// (same approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbfail-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
const dbFile = path.join(sandbox, 'data', 'db.json');
const tmpFile = dbFile + '.tmp';
fs.writeFileSync(dbFile, JSON.stringify({ sources: [], settings: { quality: 'medium' }, users: [], nextId: 1 }));

const db = require(path.join(sandbox, 'server', 'db'));

after(() => {
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// A directory where the temp file must go makes the write fail the way a full disk or a
// read-only mount would - portably, and without touching anything real.
const breakDisk = () => fs.mkdirSync(tmpFile);
const fixDisk = () => fs.rmdirSync(tmpFile);
const quietly = async (fn) => {
    const realError = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = realError; }
};
const onDisk = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

test('a write that fails is reported to the caller, not passed off as saved', async () => {
    breakDisk();
    try {
        await quietly(async () => {
            await assert.rejects(db.settings.update({ quality: 'high' }), (err) => {
                assert.match(err.message, /could not save its data/);
                assert.ok(!/db\.json|tmp/.test(err.message), 'no file path in what a client may be shown');
                assert.ok(err.cause, 'the underlying error is kept for the log');
                return true;
            });
        });
    } finally { fixDisk(); }
    assert.equal(onDisk().settings.quality, 'medium', 'and the file was left as it was');
});

test('the change does not stay live in memory after it failed to save', async () => {
    assert.equal((await db.settings.get()).quality, 'medium', 'the rejected update was rolled back');
});

test('one failed write does not jam the queue: the next save goes through', async () => {
    breakDisk();
    try { await quietly(() => assert.rejects(db.settings.update({ quality: 'high' }))); } finally { fixDisk(); }

    await db.settings.update({ quality: 'low' });
    assert.equal(onDisk().settings.quality, 'low');
    assert.equal((await db.settings.get()).quality, 'low');
});

test('a source created while the disk is failing is not left half-created', async () => {
    breakDisk();
    try { await quietly(() => assert.rejects(db.sources.create({ type: 'm3u', name: 'Ghost', url: 'http://x.invalid/list.m3u' }))); } finally { fixDisk(); }
    assert.deepEqual((await db.sources.getAll()).map(s => s.name), [], 'nothing to see in memory');
    assert.deepEqual(onDisk().sources, [], 'or on disk');

    const real = await db.sources.create({ type: 'm3u', name: 'Real', url: 'http://x.invalid/list.m3u' });
    assert.equal(real.name, 'Real');
    assert.deepEqual(onDisk().sources.map(s => s.name), ['Real']);
});

test('a later save that succeeds is not undone by an earlier one that failed', async () => {
    // Two saves in flight together: the first write fails, the second (which carries the whole
    // database) succeeds. Rolling the memory back for the first would leave it behind the disk.
    const a = await db.loadDb(); a.settings.quality = 'FIRST';
    const b = await db.loadDb(); b.settings.quality = 'SECOND';

    const fsp = require('node:fs/promises');
    const realWrite = fsp.writeFile;
    let calls = 0;
    fsp.writeFile = async (...args) => {
        if (++calls === 1) throw new Error('ENOSPC: no space left on device (simulated)');
        return realWrite(...args);
    };
    try {
        await quietly(async () => {
            const first = db.saveDb(a);
            const second = db.saveDb(b);
            await assert.rejects(first, (err) => /could not save/.test(err.message) && /ENOSPC/.test(err.cause.message));
            await second;
        });
    } finally { fsp.writeFile = realWrite; }

    assert.equal(calls, 2, 'both writes were attempted');
    assert.equal(onDisk().settings.quality, 'SECOND');
    assert.equal((await db.settings.get()).quality, 'SECOND', 'memory agrees with the disk');
});
