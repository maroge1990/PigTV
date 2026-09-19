const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Real playback router with a real token. Copy the server so its relative data
// paths never touch real data (same approach as access.test.js; a junction so
// it works on Windows without admin rights).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-clientevents-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const auth = load('auth');
const router = load('routes/playback');

let server, base, token;
const logged = [];
const realWarn = console.warn;

before(async () => {
    token = auth.generateToken({ id: 1, username: 'owner', role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/api/playback', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    console.warn = (...args) => { logged.push(args.join(' ')); };
});

after(() => {
    console.warn = realWarn;
    server?.closeAllConnections?.();
    server?.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const post = (body, withToken = true) => fetch(`${base}/api/playback/client-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withToken ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
});

const event = (overrides = {}) => ({
    event: 'media-error', code: 3, codeName: 'MEDIA_ERR_DECODE', message: 'PIPELINE_ERROR_DECODE: video decode error',
    networkState: 2, readyState: 1, currentTime: 10, bufferedEnd: 9.9, strategy: 'remux', path: '/api/remux', ...overrides
});

test('a media error lands in the server log as one readable line', async () => {
    logged.length = 0;
    const response = await post(event());
    assert.equal(response.status, 204);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^\[Player\] media-error MEDIA_ERR_DECODE\(3\) via remux path=\/api\/remux /);
    assert.match(logged[0], /msg="PIPELINE_ERROR_DECODE: video decode error"/);
    assert.match(logged[0], /t=10s buffered=9.9s from=user:1$/);
});

test('it needs a token: an anonymous caller cannot write to the log', async () => {
    logged.length = 0;
    assert.equal((await post(event(), false)).status, 401);
    assert.equal(logged.length, 0);
});

test('only the known event is accepted', async () => {
    logged.length = 0;
    assert.equal((await post({ event: 'something-else', message: 'x' })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal(logged.length, 0);
});

test('nothing a client sends can forge a log line, blow up its size, or smuggle a login', async () => {
    logged.length = 0;
    await post(event({
        message: `line one\n[Auth] Login OK for admin\r\n${'A'.repeat(5000)} http://provider.example/live/myuser/mypassword/1.ts`,
        strategy: 'remux\n[Fake] injected',
        path: '/x'.repeat(500),
        code: 'not a number', currentTime: { nested: true }, bufferedEnd: null
    }));
    assert.equal(logged.length, 1);
    const line = logged[0];
    assert.ok(!line.includes('\n') && !line.includes('\r'), 'control characters are stripped, so one event stays one line');
    assert.ok(line.length < 700, `bounded (${line.length} chars)`);
    assert.ok(!line.includes('mypassword'), 'a provider login in a message is redacted');
    assert.match(line, /\(\?\)/, 'a non-numeric code is shown as ?, not passed through');
});

test('a flood is dropped quietly rather than filling the log', async () => {
    router.clientEventLimiter.max = 3;
    router.clientEventLimiter.clear('127.0.0.1');
    router.clientEventLimiter.clear('::ffff:127.0.0.1');
    logged.length = 0;
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(event())).status);
    assert.deepEqual(statuses, [204, 204, 204, 204, 204, 204], 'the client is never told, and never retries');
    assert.equal(logged.length, 3, 'but only three reached the log');
});
