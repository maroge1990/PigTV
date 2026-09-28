const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0157: the recordings folder is checked for real - missing, not writable, an
// unmounted network share (which reads back as a filesystem too small to be
// real rather than as "missing"), or genuinely low on space - instead of just
// "not enough free space", which is what a stale Docker bind of an Unraid SMB
// share looked like in production (a 1 MB tmpfs standing in for the share).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-recfolder-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const { checkRecordingsFolder, refusalMessage, validateRecordingsPathSetting, formatBytes } = load('services/recordingsFolder');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// A scratch area outside the sandboxed server tree, for real directories to probe.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-recfolder-scratch-'));
after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leave it */ } });

test('checkRecordingsFolder: missing, not writable, tiny (an unmounted share), low space, and ok', () => {
    const missing = checkRecordingsFolder(path.join(scratch, 'does-not-exist'), 10);
    assert.deepEqual(missing, { ok: false, problem: 'missing', freeBytes: null, totalBytes: null });

    const notWritable = path.join(scratch, 'read-only');
    fs.mkdirSync(notWritable);
    fs.chmodSync(notWritable, 0o500);
    try {
        // Root (and some CI containers) can write through a mode that denies everyone
        // else, which would make this assertion meaningless - skip in that case.
        if (process.getuid && process.getuid() !== 0) {
            const result = checkRecordingsFolder(notWritable, 10);
            assert.equal(result.problem, 'not-writable');
            assert.equal(result.ok, false);
        }
    } finally {
        fs.chmodSync(notWritable, 0o700);
    }

    const real = path.join(scratch, 'real');
    fs.mkdirSync(real, { recursive: true });
    const ok = checkRecordingsFolder(real, 0); // no minimum: only existence/writability/size matter
    assert.equal(ok.ok, true);
    assert.equal(ok.problem, null);
});

test('refusalMessage: the tiny (unmounted share) wording matches what was seen live', () => {
    const check = { ok: false, problem: 'tiny', freeBytes: 1024 * 1024, totalBytes: 1024 * 1024 };
    const msg = refusalMessage(check, '/app/recordings', 10);
    assert.equal(msg, "The recordings folder isn't reachable: only 1.0 MB free at /app/recordings. Is the network share connected?");
});

test('refusalMessage: low space keeps the old wording, just from checkRecordingsFolder', () => {
    const check = { ok: false, problem: 'low-space', freeBytes: 2.3 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 };
    const msg = refusalMessage(check, '/app/recordings', 10);
    assert.equal(msg, 'Only 2.3 GB free at /app/recordings, below the 10 GB minimum');
});

test('formatBytes: MB under a GB, GB at and above it', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
    assert.equal(formatBytes(null), 'an unknown amount');
});

test('validateRecordingsPathSetting: an existing, writable folder is fine', () => {
    const dir = path.join(scratch, 'writable-existing');
    fs.mkdirSync(dir, { recursive: true });
    assert.deepEqual(validateRecordingsPathSetting(dir), { ok: true });
});

test('validateRecordingsPathSetting: a not-yet-created folder is fine when its parent exists (getRecordingsRoot creates it later)', () => {
    const dir = path.join(scratch, 'not-yet-created');
    assert.deepEqual(validateRecordingsPathSetting(dir), { ok: true });
});

test('validateRecordingsPathSetting: a relative path is refused, even one whose parent (the working folder) exists (0167)', () => {
    for (const dir of ['fake', 'recordings/new', './here']) {
        const result = validateRecordingsPathSetting(dir);
        assert.equal(result.ok, false, dir);
        assert.match(result.reason, /full path starting with \//);
    }
});

test('validateRecordingsPathSetting: refused when neither the path nor its parent exists', () => {
    const dir = path.join(scratch, 'nope', 'still-nope', 'recordings');
    const result = validateRecordingsPathSetting(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not exist, and neither does its parent/);
});

// 0160: a disconnected share's mount point exists but sits on a tiny tmpfs
// (Unraid's /mnt/remotes is 1 MB). A real one can't be made in a test, so the
// filesystem size is stubbed for the paths under `tinyRoot` only.
const tinyRoot = path.join(scratch, 'remotes');
fs.mkdirSync(path.join(tinyRoot, 'SERVER01_Video'), { recursive: true });
function withTinyFilesystem(fn) {
    const real = fs.statfsSync;
    fs.statfsSync = (dir, ...rest) => (String(dir).startsWith(tinyRoot)
        ? { ...real(scratch), blocks: 256, bsize: 4096, bavail: 256 }
        : real(dir, ...rest));
    return Promise.resolve().then(fn).finally(() => { fs.statfsSync = real; });
}

test('validateRecordingsPathSetting: refused on a tiny filesystem, existing or not yet created (0160)', () => withTinyFilesystem(() => {
    const existing = validateRecordingsPathSetting(path.join(tinyRoot, 'SERVER01_Video'));
    assert.equal(existing.ok, false);
    assert.match(existing.reason, /isn't on a real volume/);

    const notYet = validateRecordingsPathSetting(path.join(tinyRoot, 'SERVER01_Video', 'Recordings'));
    assert.equal(notYet.ok, false);
    assert.match(notYet.reason, /its parent isn't on a real volume/);
    assert.ok(!fs.existsSync(path.join(tinyRoot, 'SERVER01_Video', 'Recordings')));
}));

// ---- getRecordingsRoot / recordingEngine integration -----------------------

test('getRecordingsRoot only creates the final segment, never a whole missing tree (0157)', async () => {
    const engine = load('services/recordingEngine');
    const db = load('db');

    const parentMissing = path.join(scratch, 'unmounted-share', 'recordings');
    await db.settings.update({ recordingsPath: parentMissing });
    await assert.rejects(() => engine.getRecordingsRoot(), /parent does not exist/);
    assert.ok(!fs.existsSync(path.join(scratch, 'unmounted-share')), 'nothing was created inside the unmounted mount point');

    const parentPresent = path.join(scratch, 'mounted-share');
    fs.mkdirSync(parentPresent, { recursive: true });
    await db.settings.update({ recordingsPath: path.join(parentPresent, 'recordings') });
    const root = await engine.getRecordingsRoot();
    assert.equal(root, path.join(parentPresent, 'recordings'));
    assert.ok(fs.existsSync(root), 'the final folder is still created when its parent exists');
});

test('getRecordingsRoot never creates the folder inside a disconnected share, and a minimum of 0 still refuses it (0160)', () => withTinyFilesystem(async () => {
    const engine = load('services/recordingEngine');
    const db = load('db');
    const target = path.join(tinyRoot, 'SERVER01_Video', 'Recordings');
    await db.settings.update({ recordingsPath: target });
    await assert.rejects(() => engine.getRecordingsRoot(), /isn't reachable/);
    assert.ok(!fs.existsSync(target), 'nothing was created on the tiny filesystem');

    // The folder exists on the tiny filesystem: checkRecordingsFolder still says
    // so with no free-space minimum at all.
    fs.mkdirSync(target);
    const check = checkRecordingsFolder(target, 0);
    assert.equal(check.problem, 'tiny');
    fs.rmdirSync(target);
}));

test('the recordings-folder health check logs a warning only when the state changes, and once on recovery', async () => {
    const engine = load('services/recordingEngine');
    const db = load('db');
    const lines = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a) => lines.push(['warn', a.join(' ')]);
    console.log = (...a) => lines.push(['log', a.join(' ')]);
    try {
        const missing = path.join(scratch, 'health-check-missing');
        await db.settings.update({ recordingsPath: missing });
        await engine.checkFolderHealthNow();
        await engine.checkFolderHealthNow();
        await engine.checkFolderHealthNow();
        const warnings = lines.filter(([lvl, text]) => lvl === 'warn' && text.includes('recordings folder does not exist'));
        assert.equal(warnings.length, 1, `expected exactly one warning for three identical checks, got: ${JSON.stringify(lines)}`);
        assert.equal(engine.getFolderHealth().ok, false);
        assert.equal(engine.getFolderHealth().problem, 'missing');

        lines.length = 0;
        const present = path.join(scratch, 'health-check-present');
        fs.mkdirSync(present, { recursive: true });
        await db.settings.update({ recordingsPath: present });
        await engine.checkFolderHealthNow();
        const recovered = lines.filter(([lvl, text]) => lvl === 'log' && text.includes('reachable again'));
        assert.equal(recovered.length, 1);
        assert.equal(engine.getFolderHealth().ok, true);
    } finally {
        console.warn = realWarn;
        console.log = realLog;
    }
});

// ---- settings route validation (B.5) ---------------------------------------

test('PUT /api/settings refuses an unusable recordingsPath with 400 and a plain message; a good one saves', async () => {
    const auth = load('auth');
    const db = load('db');
    const admin = await db.users.create({ username: 'settings-admin', role: 'admin' });
    const token = auth.generateToken(admin);

    const app = express();
    app.use(express.json());
    app.use('/api/settings', load('routes/settings'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const put = (body) => fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    });

    try {
        const bad = await put({ recordingsPath: path.join(scratch, 'no', 'such', 'share', 'recordings') });
        assert.equal(bad.status, 400);
        const badBody = await bad.json();
        assert.match(badBody.error, /does not exist, and neither does its parent/);

        const saved = await db.settings.get();
        assert.notEqual(saved.recordingsPath, path.join(scratch, 'no', 'such', 'share', 'recordings'), 'the bad path was never saved');

        const goodDir = path.join(scratch, 'settings-good-parent');
        fs.mkdirSync(goodDir, { recursive: true });
        const good = await put({ recordingsPath: path.join(goodDir, 'recordings') });
        assert.equal(good.status, 200);
        const after = await db.settings.get();
        assert.equal(after.recordingsPath, path.join(goodDir, 'recordings'));
    } finally {
        server.close();
    }
});
