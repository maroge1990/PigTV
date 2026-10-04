const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stopServer } = require('./helpers/server');

// The real server in a sandbox copy with its own data/ folder (as api-404.test.js does):
// the container HEALTHCHECK (R17) depends on this endpoint, so test the real thing.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-health-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../public'), path.join(sandbox, 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');

let server, base;

before(async () => {
    server = await startServer({ cwd: sandbox, env: { JWT_SECRET: 'test-only-signing-key-not-used-outside-fixtures-12345' } });
    base = server.base;
});

after(async () => {
    await stopServer(server);
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
