const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The real server (server/index.js), started as a child process in a copy with its own data/
// folder, so what is tested is exactly what the fallback ordering in index.js does.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-api404-'));
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

const call = async (method, route) => {
    const response = await fetch(`${base}${route}`, { method, redirect: 'manual' });
    const type = response.headers.get('content-type') || '';
    const text = await response.text();
    let body = null;
    if (type.includes('json')) { try { body = JSON.parse(text); } catch { /* not json */ } }
    return { status: response.status, type, text, body };
};

test('an unknown API path is a JSON 404, not the web app', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
        const r = await call(method, '/api/no-such-endpoint');
        assert.equal(r.status, 404, method);
        assert.match(r.type, /json/, method);
        assert.equal(r.body.error, 'No such API endpoint');
        assert.equal(r.body.endpoint, `${method} /api/no-such-endpoint`);
    }
});

test('it also covers a missing path under a real router, and paths the old code answered with HTML', async () => {
    assert.equal((await call('GET', '/api/info/no-such-thing')).body?.error, 'No such API endpoint');
    assert.equal((await call('GET', '/api/hello')).status, 404, 'the removed demo plugin route');
    assert.equal((await call('GET', '/api/auth/oidc/login')).status, 404, 'the removed SSO route');
});

test('the piped remux and the legacy piped transcode are gone - one delivery path (0103)', async () => {
    for (const route of ['/api/remux?url=http%3A%2F%2Fx%2F1.ts', '/api/transcode?url=http%3A%2F%2Fx%2F1.ts']) {
        const r = await call('GET', route);
        assert.equal(r.status, 404, route);
        assert.equal(r.body?.error, 'No such API endpoint', route);
    }
});

test('a router that needs a token still asks for one first, so an anonymous caller learns nothing about which paths exist', async () => {
    const real = await call('GET', '/api/library/channels');
    const missing = await call('GET', '/api/library/no-such-thing');
    assert.equal(real.status, 401);
    assert.equal(missing.status, 401);
});

test('the reply never echoes a query string, which can carry a token', async () => {
    const r = await call('GET', '/api/no-such-endpoint?token=SECRET-TOKEN&url=http%3A%2F%2Fuser%3Apass%40host');
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('SECRET-TOKEN') && !r.text.includes('pass@host'));
    assert.equal(r.body.endpoint, 'GET /api/no-such-endpoint');
});

test('a very long path cannot make a very long reply', async () => {
    const r = await call('GET', `/api/${'x'.repeat(5000)}`);
    assert.equal(r.status, 404);
    assert.ok(r.body.endpoint.length <= 200);
});

test('the web app itself is still served for everything that is not /api', async () => {
    for (const route of ['/', '/some/client/side/route', '/live']) {
        const r = await call('GET', route);
        assert.equal(r.status, 200, route);
        assert.match(r.type, /html/, route);
    }
    assert.equal((await call('GET', '/api/version')).status, 200, 'and real API routes are untouched');
});

// Every path the Apple client calls (PigTV-Swift-Client: APIClient.swift and the views that call it),
// with the method it uses. The catch-all above must never swallow one: each has to reach its real
// router, which answers with something of its own (401 without a token, 400 for a missing parameter,
// its own "not found" for an unknown id) - anything except the generic reply. A route that is
// missing, or moved behind the catch-all, fails here instead of on somebody's Apple TV.
const APPLE_CLIENT_ROUTES = [
    ['GET', '/api/info'], ['GET', '/api/version'],
    ['POST', '/api/auth/login'], ['GET', '/api/auth/me'],
    ['POST', '/api/devices/pair/start'], ['GET', '/api/devices/pair/poll'],
    ['GET', '/api/sources'],
    ['GET', '/api/library/categories'], ['GET', '/api/library/channels'],
    ['GET', '/api/library/favourites'], ['GET', '/api/library/guide'],
    ['POST', '/api/favorites'], ['DELETE', '/api/favorites'], ['GET', '/api/favorites/check'],
    ['POST', '/api/playback/resolve'], ['GET', '/api/playback/conflict'], ['POST', '/api/playback/conflict/decline'],
    ['POST', '/api/playback/client-event'],
    ['GET', '/api/playback/some-session-id/terminal-status'],
    ['GET', '/api/recordings'], ['GET', '/api/recordings/scheduled'], ['POST', '/api/recordings/schedule'],
    ['GET', '/api/recordings/1/playback'], ['GET', '/api/recordings/1/media.mp4'], ['GET', '/api/recordings/1/markers'],
    ['GET', '/api/proxy/stream'],
    ['GET', '/api/transcode/abc/stream.m3u8'], ['GET', '/api/transcode/abc/master.m3u8'],
    ['DELETE', '/api/playback/abc']
];

test('every route the Apple client calls still reaches its real handler', async () => {
    const swallowed = [];
    for (const [method, route] of APPLE_CLIENT_ROUTES) {
        const r = await call(method, route);
        if (r.body && r.body.error === 'No such API endpoint') swallowed.push(`${method} ${route}`);
    }
    assert.deepEqual(swallowed, []);
});
