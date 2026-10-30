const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #8: a hung recordings share must not freeze the server. Its file calls run in a helper process with a deadline
// (services/shareFs.js), so the event loop that serves every stream keeps going. The hang is simulated twice over:
// the helper waits forever on the share folder (PIGTV_TEST_SHARE_HANG), and any synchronous call this process still
// makes on it blocks for 3 s, which is what a frozen SMB server does to Node.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-share-hang-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const share = path.join(sandbox, 'share');
const recordingsPath = path.join(share, 'Recordings');
fs.mkdirSync(recordingsPath, { recursive: true });
process.env.PIGTV_TEST_SHARE_HANG = share;

const load = p => require(path.join(sandbox, 'server', p));
const express = require(path.join(sandbox, 'node_modules', 'express'));
const db = load('db');
const auth = load('auth');
const engine = load('services/recordingEngine');
let shareFs = null; // absent before #8: the proof runs this file against the old server too
try { shareFs = load('services/shareFs'); } catch { /* old server */ }

// Any synchronous call on the share from this process blocks, as on a hung mount.
const blocked = [];
const onShare = (p) => String(p).startsWith(share);
const hang = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
for (const name of ['existsSync', 'statSync', 'statfsSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'unlinkSync']) {
    const real = fs[name];
    fs[name] = function (p, ...rest) {
        if (onShare(p)) { blocked.push(`${name} ${p}`); hang(); }
        return real.call(this, p, ...rest);
    };
}

/** The longest gap between 20 ms timer ticks while `work` runs: how long the event loop was frozen. */
async function loopFreeze(work) {
    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    try { return { result: await work(), worst: () => worst }; } finally { clearInterval(timer); }
}

let server, base, token;
before(async () => {
    if (shareFs) shareFs.tuning.timeoutMs = 1500;
    await db.settings.update({ recordingsPath, minFreeSpaceGB: 0 });
    token = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    load('db/recordingsDb').initSchema();
    const app = express();
    app.use(express.json());
    app.use('/api/status', load('routes/status'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.close();
    shareFs?.reset();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('GET /api/status answers at once and never touches the share', async () => {
    blocked.length = 0;
    const began = Date.now();
    const r = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    const ms = Date.now() - began;
    assert.equal(r.status, 200);
    assert.deepEqual(blocked, [], 'no synchronous call on the share');
    assert.ok(ms < 1000, `answered in ${ms} ms`);
    const body = await r.json();
    assert.equal(JSON.stringify(body).includes('hunter'), false);
});

test('the folder health check reports a hung share as unresponsive without freezing the loop', async () => {
    blocked.length = 0;
    const { result, worst } = await loopFreeze(() => engine.checkFolderHealthNow());
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'unresponsive');
    assert.deepEqual(blocked, []);
    assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
});

test('getRecordingsRoot fails with a clear reason instead of blocking, and the helper comes back for a working folder', async () => {
    blocked.length = 0;
    const { worst } = await loopFreeze(() => assert.rejects(() => engine.getRecordingsRoot(), /not responding/));
    assert.deepEqual(blocked, []);
    assert.ok(worst() < 300, `the event loop stalled for ${worst()} ms`);
    const elsewhere = path.join(sandbox, 'local-recordings');
    fs.mkdirSync(elsewhere);
    await db.settings.update({ recordingsPath: elsewhere });
    try {
        assert.equal(await engine.getRecordingsRoot(), elsewhere, 'a fresh helper answers for a healthy folder');
        assert.equal((await engine.checkFolderHealthNow()).ok, true);
    } finally {
        await db.settings.update({ recordingsPath });
    }
});
