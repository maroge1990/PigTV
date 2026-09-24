const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 0137 (roadmap S4.3c): Express 5. The real server (server/index.js) in a sandbox, checked
// where Express 5 differs from 4 and the server was adjusted to keep answering as before:
// the SPA fallback's wildcard ('*' is not valid Express 5 path syntax), a POST with no JSON
// body (Express 5 leaves req.body undefined), and a port
// already in use (Express 5 hands the error to the listen callback instead of crashing).
// Segments under the dotted timeshift folder (send 1.x refuses dot-folders by default) are
// covered by tuner-timeshift.test.js. On the old code express is 4.x.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-express5-'));
for (const d of ['server', 'public']) fs.cpSync(path.join(__dirname, '..', d), path.join(sandbox, d), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');

let child, base, port;

const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function startServer(p) {
    const proc = spawn(process.execPath, ['server/index.js'], { cwd: sandbox, env: { ...process.env, PORT: String(p), JWT_SECRET: 'test-only-signing-key-not-used-outside-fixtures-12345' } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.output = () => out;
    return proc;
}

before(async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = startServer(port);
    for (let i = 0; i < 100; i++) {
        try { await fetch(`${base}/api/version`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error(`server did not start: ${child.output()}`);
});

after(() => {
    child?.kill('SIGKILL');
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('express is 5.x', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.match(pkg.dependencies.express, /^\^5\./);
    assert.match(require('express/package.json').version, /^5\./);
});

test('the web app is still served for any non-API path, and an unknown API path is still the JSON 404', async () => {
    for (const p of ['/', '/guide', '/settings/epg/deep/link']) {
        const r = await fetch(`${base}${p}`);
        assert.equal(r.status, 200, p);
        assert.match(r.headers.get('content-type'), /text\/html/);
    }
    const api = await fetch(`${base}/api/no/such/thing?token=abc`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'No such API endpoint', endpoint: 'GET /api/no/such/thing' });
});

test('a POST without a JSON body still reaches the route\'s own validation (not a 500)', async () => {
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST' });
    assert.equal(setup.status, 400);
    assert.deepEqual(await setup.json(), { error: 'Username and password required' });
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST' });
    assert.equal(login.status, 401);
    assert.deepEqual(await login.json(), { error: 'Missing credentials' });
});

test('a port already in use stops the server with a clear message, as Express 4\'s crash did', async () => {
    const second = startServer(port);
    const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { second.kill('SIGKILL'); resolve('still running'); }, 15000);
        second.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1);
    assert.match(second.output(), new RegExp(`Could not listen on port ${port}`));
});
