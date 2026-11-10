const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const helper = require('./helpers/server');

// D-57 (#270): the oldest database PigTV opens is one last opened by build 0476 or later. An older one, data with no
// build recorded (before 0213) or a db.json never moved into the database (before 0135) is refused at start, before
// anything touches the data folder: one plain message naming the way through (v0502 once), a non-zero exit, and the
// files exactly as they were. On the old code each of these databases was opened and migrated.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbminimum-'));
for (const d of ['server', 'public']) fs.cpSync(path.join(__dirname, '..', d), path.join(sandbox, d), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const dataDir = path.join(sandbox, 'data');
const dbPath = path.join(dataDir, 'content.db');
const JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';

after(() => {
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

/** A data folder as a server left it: a WAL database with a source row, stamped with `build` (null: no stamp); `db: false`, none. */
function dataFolder({ build = null, db = true, rows = true, migrated = true, json = false } = {}) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    if (db) {
        const d = new Database(dbPath);
        d.pragma('journal_mode = WAL');
        d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE app_sources (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
        if (build !== null) d.prepare(`INSERT INTO meta VALUES ('schema_build', ?)`).run(build);
        if (migrated) d.prepare(`INSERT INTO meta VALUES ('app_data_migrated', 'db.json 2026-10-01')`).run();
        if (rows) d.prepare(`INSERT INTO app_sources VALUES (1, '{"name":"Household"}')`).run();
        d.close();
    }
    if (json) fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ sources: [{ id: 1, name: 'Household' }], users: [], settings: {} }));
    return snapshot();
}
/** Every file in the data folder (recursively) with a hash of its bytes. */
function snapshot(dir = dataDir) {
    const out = {};
    for (const name of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        out[name] = fs.statSync(p).isDirectory() ? snapshot(p) : crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
    return out;
}

/** server/index.js, run until it exits by itself (a refusal) or 20 s. */
function runServer() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['server/index.js'], { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: '0', JWT_SECRET } });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
    });
}

test('a database last opened by 0475 is refused: exit 1, one message with the way through, every file as it was', async () => {
    const before = dataFolder({ build: '0475' });
    const { code, out } = await runServer();
    assert.equal(code, 1, out);
    assert.match(out, /last opened by PigTV build 0475\./);
    assert.match(out, /opens databases from build 0476 on/);
    assert.match(out, /start PigTV v0502 once with this data folder/);
    assert.doesNotMatch(out, /PigTV server running|Opening database/, 'it stopped before opening anything');
    assert.deepEqual(snapshot(), before, 'byte-identical, and no backup, -wal or -shm file appeared');
});

test('a database with data and no build recorded (before 0213) is refused and left as it was', async () => {
    const before = dataFolder({ build: null });
    const { code, out } = await runServer();
    assert.equal(code, 1, out);
    assert.match(out, /last opened by a PigTV build before 0213\..*0476.*v0502/);
    assert.deepEqual(snapshot(), before);
});

test('a db.json with no database (before 0135) is refused, never started empty, and left as it was', async () => {
    const before = dataFolder({ db: false, json: true });
    const { code, out } = await runServer();
    assert.equal(code, 1, out);
    assert.match(out, /db\.json holds sources, users and settings in the format PigTV used before build 0135.*0476.*v0502/);
    assert.deepEqual(snapshot(), before, 'no content.db was created and db.json is untouched');
});

test('databases stamped 0476 and 0521 start, and so does an empty data folder', async () => {
    for (const build of ['0476', '0521', 'fresh']) {
        if (build === 'fresh') dataFolder({ db: false }); else dataFolder({ build });
        const server = await helper.startServer({ cwd: sandbox, env: { JWT_SECRET } });
        try {
            assert.doesNotMatch(server.output(), /Not started/);
        } finally { await helper.stopServer(server); }
    }
});

test('the verdicts, case by case', () => {
    const minimum = require(path.join(sandbox, 'server/services/dbMinimum'));
    const verdict = (opts) => { dataFolder(opts); return minimum.check(dbPath); };
    // Fresh: no database; an empty data folder; a database with no stamp and nothing but meta rows (a first start cut short).
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.deepEqual(minimum.check(dbPath), { ok: true, kind: 'fresh' }, 'no data folder at all');
    assert.deepEqual(verdict({ db: false }), { ok: true, kind: 'fresh' });
    assert.deepEqual(verdict({ build: null, rows: false, migrated: true }), { ok: true, kind: 'fresh' });
    // Supported: 0476 on. Only a stamp that is exactly a build number (4+ digits, an optional v) is compared;
    // anything else opens with a warning and is never refused.
    for (const build of ['0476', '0502', 'v0502', '0521', '1000']) assert.deepEqual(verdict({ build }), { ok: true, kind: 'supported' }, build);
    for (const build of ['0123abc', '123', '475', 'dev', '0521-dev', '1.2.3', '']) {
        const v = verdict({ build });
        assert.equal(v.ok, true, build);
        assert.match(v.warning, /not a build number/, build);
    }
    // Too old.
    for (const build of ['0475', 'v0475', '0213', '0001']) assert.deepEqual(
        [verdict({ build }).ok, minimum.check(dbPath).reason], [false, 'old'], build);
    assert.equal(verdict({ build: null }).reason, 'unstamped');
    // db.json: refused unless its contents were moved in before (then ignored, as since 0135).
    assert.equal(verdict({ db: false, json: true }).reason, 'db.json');
    assert.equal(verdict({ build: '0521', migrated: false, json: true }).reason, 'db.json');
    const moved = verdict({ build: '0521', migrated: true, json: true });
    assert.equal(moved.ok, true);
    assert.match(moved.warning, /db\.json is present but its contents were moved/);
});

test('a file SQLite says is not a database: the damaged message, refused, untouched', () => {
    const minimum = require(path.join(sandbox, 'server/services/dbMinimum'));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir);
    fs.writeFileSync(dbPath, 'not a database, but long enough to look like one at a glance '.repeat(20));
    const before = snapshot();
    const bad = minimum.check(dbPath);
    assert.equal(bad.reason, 'damaged');
    assert.match(minimum.message(bad), /SQLite says .* is not a database or is damaged \(SQLITE_NOTADB: .*Restore the newest backup/);
    assert.deepEqual(snapshot(), before);
});

test('a database that cannot be opened: says so with the error and the usual causes, never "restore a backup"',
    { skip: process.getuid?.() === 0 ? 'root can open a chmod 000 file' : process.platform === 'win32' && 'no chmod' }, () => {
        const minimum = require(path.join(sandbox, 'server/services/dbMinimum'));
        dataFolder({ build: '0521' });
        fs.chmodSync(dbPath, 0o000);
        try {
            const names = fs.readdirSync(dataDir).sort(); // the file cannot be hashed now: the listing instead
            const v = minimum.check(dbPath);
            assert.equal(v.reason, 'unopenable', JSON.stringify(v));
            const text = minimum.message(v);
            assert.match(text, /could not be opened \(SQLITE_CANTOPEN: /);
            assert.match(text, /owner or permissions after a restore.*another PigTV still running/);
            assert.doesNotMatch(text, /restore (a|the newest) backup/i);
            assert.deepEqual(fs.readdirSync(dataDir).sort(), names);
        } finally { fs.chmodSync(dbPath, 0o644); }
    });

test('a process that cannot know its own build opens an unstamped database with data, and writes no stamp', () => {
    // A copy of server/ alone, without package.json: version.js cannot load (as in some tests' sandboxes).
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dbminimum-bare-'));
    try {
        fs.cpSync(path.join(sandbox, 'server'), path.join(bare, 'server'), { recursive: true });
        fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(bare, 'node_modules'), 'junction');
        fs.mkdirSync(path.join(bare, 'data'));
        const file = path.join(bare, 'data', 'content.db');
        const d = new Database(file);
        d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE app_sources (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
        d.prepare(`INSERT INTO app_sources VALUES (1, '{"name":"Household"}')`).run();
        d.close();
        const minimum = require(path.join(bare, 'server/services/dbMinimum'));
        assert.deepEqual(minimum.check(file), { ok: true, kind: 'unchecked' });
        const code = `try { require(${JSON.stringify(path.join(bare, 'server/db/sqlite'))}).getDb(); console.log('OPENED'); }
            catch (e) { console.log('REFUSED', e.code); }`;
        for (let run = 1; run <= 2; run++) {
            const out = require('node:child_process').execFileSync(process.execPath, ['-e', code], { cwd: bare, encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'] });
            assert.match(out, /OPENED/, `run ${run}`);
        }
        const r = new Database(file, { readonly: true });
        try { assert.equal(r.prepare(`SELECT value FROM meta WHERE key = 'schema_build'`).get(), undefined, 'no stamp'); } finally { r.close(); }
    } finally {
        try { fs.rmdirSync(path.join(bare, 'node_modules')); } catch { /* gone */ }
        fs.rmSync(bare, { recursive: true, force: true });
    }
});

test('getDb() refuses the same databases, before the pre-migration copy (scripts and tests open through it too)', () => {
    dataFolder({ build: '0475' });
    const before = snapshot();
    const code = `try { require(${JSON.stringify(path.join(sandbox, 'server/db/sqlite'))}).getDb(); console.log('OPENED'); }
        catch (e) { console.log(e.code); }`;
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', code], { cwd: sandbox, encoding: 'utf8',
        env: { ...process.env, JWT_SECRET } });
    assert.match(out, /PIGTV_DB_UNSUPPORTED/);
    assert.doesNotMatch(out, /OPENED/);
    assert.deepEqual(snapshot(), before, 'no backups/ folder, no copy');
});
