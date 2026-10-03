const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The real server in a sandbox copy with its own data/ folder (as api-404.test.js does):
// the container HEALTHCHECK (R17) depends on this endpoint, so test the real thing.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-health-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../public'), path.join(sandbox, 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');

let child, base;

const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
    probe.on('error', reject);
});

before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], {
        cwd: sandbox, stdio: 'ignore',
        env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-only-signing-key-not-used-outside-fixtures-12345' }
    });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/api/version`)).ok) return; } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('the server did not start');
});

after(async () => {
    if (child) {
        child.kill();
        await new Promise(r => { child.once('exit', r); setTimeout(r, 3000); });
    }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('GET /api/health answers 200 with no token, in a fixed small shape', async () => {
    const r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /json/);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['db', 'ok', 'recordingsFolder']);
    assert.equal(body.ok, true);
    assert.equal(body.db, true);
    assert.ok(body.recordingsFolder === null || typeof body.recordingsFolder === 'boolean');
});

test('it leaks no paths, versions or secrets', async () => {
    const text = await (await fetch(`${base}/api/health`)).text();
    assert.ok(text.length < 100, text);
    assert.doesNotMatch(text, /\/|token|secret|password|build|version/i);
});
