const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer, stopServer } = require('./helpers/server');

// #44 (0896): a crash used to leave nothing behind but Node's own unredacted stack on stderr. Now the server writes
// one redacted record to data/crashes.jsonl, logs one redacted line and exits non-zero, so the container's restart
// policy brings it back and the Status page can say it happened. On 0895 there is no crashLog module and index.js
// installs no handler, so every test here fails.

const SECRET = 'hunter2secret';
const LEAKY = `could not open http://viewer:${SECRET}@provider.invalid/live/viewer/${SECRET}/441360.ts?token=${SECRET}`;
const MODULE = path.join(__dirname, '../server/services/crashLog.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-crash-'));

function run(code, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', (code) => resolve({ code, out }));
    });
}
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

function assertRedacted(text) {
    assert.ok(!text.includes(SECRET), `a secret leaked: ${text}`);
    assert.ok(!text.includes('provider.invalid'), `a provider host leaked: ${text}`);
}

test('an uncaught exception exits non-zero and leaves one redacted record and one redacted log line', async () => {
    const file = path.join(tmp(), 'crashes.jsonl');
    const r = await run(`
        require(${JSON.stringify(MODULE)}).install({ file: ${JSON.stringify(file)} });
        setTimeout(() => { throw new TypeError(${JSON.stringify(LEAKY)}); }, 10);
    `);
    assert.notEqual(r.code, 0, 'the process must exit non-zero so the container restarts it');
    const recs = lines(file);
    assert.equal(recs.length, 1);
    const rec = JSON.parse(recs[0]);
    assert.equal(rec.kind, 'uncaughtException');
    assert.equal(rec.name, 'TypeError');
    assert.match(rec.message, /could not open/);
    assert.ok(Number.isFinite(rec.at) && Math.abs(Date.now() - rec.at) < 60000);
    assert.equal(typeof rec.build, 'string');
    assert.equal(typeof rec.uptimeSec, 'number');
    assert.deepEqual(Object.keys(rec.active).sort(), ['recordings', 'sessions']);
    assert.ok(Array.isArray(rec.stack) && rec.stack.length >= 1 && rec.stack.length <= 5);
    assert.ok(rec.stack.every(f => /^at /.test(f)), 'frames only, never the message line');
    assertRedacted(recs[0]);
    assertRedacted(r.out);
    assert.match(r.out, /\[Crash\] uncaughtException: TypeError/);
});

test('an unhandled rejection is handled the same way', async () => {
    const file = path.join(tmp(), 'crashes.jsonl');
    const r = await run(`
        require(${JSON.stringify(MODULE)}).install({ file: ${JSON.stringify(file)} });
        setTimeout(() => { Promise.reject(new RangeError(${JSON.stringify(LEAKY)})); }, 10);
        setTimeout(() => {}, 5000);
    `);
    assert.notEqual(r.code, 0);
    const recs = lines(file);
    assert.equal(recs.length, 1);
    const rec = JSON.parse(recs[0]);
    assert.equal(rec.kind, 'unhandledRejection');
    assert.equal(rec.name, 'RangeError');
    assertRedacted(recs[0]);
    assertRedacted(r.out);
});

test('the file is capped at the newest 50 and a corrupt or missing file reads as what is valid in it', () => {
    const crashLog = require(MODULE);
    const file = path.join(tmp(), 'crashes.jsonl');
    assert.deepEqual(crashLog.read({ file }), [], 'missing: nothing');
    fs.writeFileSync(file, 'not json\n{"half":\n\u0000\u0000garbage\n');
    assert.deepEqual(crashLog.read({ file }), [], 'corrupt: nothing, no throw');
    const base = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 60; i++) crashLog.write({ at: base + i * 1000, kind: 'uncaughtException', name: `E${i}`, message: 'x' }, { file });
    const kept = crashLog.read({ file });
    assert.equal(kept.length, crashLog.KEEP);
    assert.equal(crashLog.KEEP, 50);
    assert.equal(kept[0].name, 'E10', 'the oldest went first');
    assert.equal(kept.at(-1).name, 'E59');
    assert.equal(lines(file).length, 50, 'the file itself is cut back, not just the read');
    const s = crashLog.summary({ file, now: base + 59 * 1000 + 60000 });
    assert.equal(s.last24h, 50);
    assert.equal(s.lastName, 'E59');
    assert.equal(s.lastAt, base + 59 * 1000);
    assert.equal(crashLog.summary({ file, now: base + 3 * 86400e3 }).last24h, 0, 'older than a day: not counted');
});

test('the real server starts with a corrupt crash file, and a crash in it is recorded and exits non-zero', async () => {
    const sandbox = tmp();
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.cpSync(path.join(__dirname, '../public'), path.join(sandbox, 'public'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    fs.mkdirSync(path.join(sandbox, 'data'));
    const file = path.join(sandbox, 'data', 'crashes.jsonl');
    fs.writeFileSync(file, '{"at":1,"kind":"uncaughtException","name":"Old"}\n{{{corrupt\n');
    // A preload that throws once the server has started: what a bug in a timer callback does.
    const preload = path.join(sandbox, 'throw-later.js');
    fs.writeFileSync(preload, `setTimeout(() => { throw new Error(${JSON.stringify(LEAKY)}); }, 2500).unref?.();\n`);
    const server = await startServer({ cwd: sandbox, env: {
        JWT_SECRET: 'test-only-signing-key-not-used-outside-fixtures-12345', NODE_OPTIONS: `--require ${preload}`, PIGTV_DB_BACKUPS: '0'
    } });
    try {
        const code = await new Promise((resolve) => {
            if (server.child.exitCode !== null) return resolve(server.child.exitCode);
            server.child.once('exit', resolve);
            setTimeout(() => resolve('still running'), 20000);
        });
        assert.notEqual(code, 0);
        assert.notEqual(code, 'still running');
        const recs = require(MODULE).read({ file });
        assert.equal(recs.at(-1).name, 'Error');
        assert.match(recs.at(-1).message, /could not open/);
        assertRedacted(fs.readFileSync(file, 'utf8'));
        assertRedacted(server.output());
    } finally {
        await stopServer(server);
        try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp */ }
    }
});

test('0900: a message quoting a JSON password or a Bearer value with no URL is masked in the record and the log line, and cut at 300', async () => {
    const file = path.join(tmp(), 'crashes.jsonl');
    const msg = `Unexpected token in JSON at position 40: {"username":"owner","password":"${SECRET}"} sent with Bearer ${SECRET}x9 ` + 'z'.repeat(600);
    const r = await run(`
        require(${JSON.stringify(MODULE)}).install({ file: ${JSON.stringify(file)} });
        setTimeout(() => { throw new SyntaxError(${JSON.stringify(msg)}); }, 10);
    `);
    assert.notEqual(r.code, 0);
    const rec = JSON.parse(lines(file)[0]);
    assert.ok(!lines(file)[0].includes(SECRET), lines(file)[0]);
    assert.ok(!r.out.includes(SECRET), r.out);
    assert.match(rec.message, /"password":\*\*\*/);
    assert.match(rec.message, /Bearer \*\*\*/);
    assert.ok(rec.message.length <= 300);
});
