const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createLimiter } = require('../server/services/rateLimit');

// --- the limiter itself, on a clock the test controls ---

function clock(start = 1_000_000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

test('a key is blocked once it has max events in the window, and freed as they age out', () => {
    const now = clock();
    const limiter = createLimiter({ windowMs: 60_000, max: 3, now });
    for (let i = 0; i < 2; i++) { limiter.record('a'); now.advance(1000); }
    assert.equal(limiter.check('a').blocked, false, 'two of three');
    limiter.record('a');
    const blocked = limiter.check('a');
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.retryAfterSec, 58, 'free again when the oldest event leaves the window (60s after t=0, now t=2s)');

    now.advance(58_000);
    assert.equal(limiter.check('a').blocked, false, 'the oldest event aged out');
});

test('keys are independent, clear() forgets one, and idle keys are dropped', () => {
    const now = clock();
    const limiter = createLimiter({ windowMs: 1000, max: 1, now });
    limiter.record('a');
    assert.equal(limiter.check('a').blocked, true);
    assert.equal(limiter.check('b').blocked, false, "one client's failures never block another");
    limiter.clear('a');
    assert.equal(limiter.check('a').blocked, false);

    limiter.record('c');
    now.advance(2000);
    limiter.check('c');
    assert.equal(limiter.size(), 0, 'an expired key no longer occupies memory');
});

test('a flood of distinct keys cannot grow memory without bound', () => {
    const limiter = createLimiter({ windowMs: 60_000, max: 5, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.record(`client-${i}`);
    assert.ok(limiter.size() <= 100);
});

// --- through the real routes ---

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-ratelimit-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const authRouter = load('routes/auth');
const devicesRouter = load('routes/devices');

let server, base;
const login = async (username, password) => {
    const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
};

before(async () => {
    await db.users.create({ username: 'owner', role: 'admin', passwordHash: await auth.hashPassword('right-password') });
    await db.users.create({ username: 'guest', role: 'viewer', passwordHash: await auth.hashPassword('guest-password') });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/devices', devicesRouter);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('ten wrong passwords lock that user out of this client, with a Retry-After', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await login('owner', `wrong-${i}`)).status, 401);
    const locked = await login('owner', 'wrong-again');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.retryAfter) > 0, 'Retry-After tells the client when to come back');
    assert.equal((await login('owner', 'right-password')).status, 429, 'even the right password waits: otherwise the limit is just a slower guess');
});

test("another user on the same client is unaffected by owner's lockout", async () => {
    assert.equal((await login('guest', 'guest-password')).status, 200);
});

test('a successful login forgets earlier mistakes, so the household is never locked out for typos', async () => {
    for (let i = 0; i < 9; i++) assert.equal((await login('guest', 'typo')).status, 401);
    assert.equal((await login('guest', 'guest-password')).status, 200, 'the ninth failure did not lock them out');
    for (let i = 0; i < 9; i++) assert.equal((await login('guest', 'typo')).status, 401, 'and the count started again from zero');
});

test('pairing endpoints answer 429 once a client exceeds its ceiling', async () => {
    devicesRouter.limiters.pairStart.max = 3;
    const start = async () => {
        const r = await fetch(`${base}/api/devices/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return { status: r.status, retryAfter: r.headers.get('retry-after') };
    };
    for (let i = 0; i < 3; i++) assert.equal((await start()).status, 200);
    const over = await start();
    assert.equal(over.status, 429);
    assert.ok(Number(over.retryAfter) > 0);

    devicesRouter.limiters.pairPoll.max = 2;
    const poll = async () => (await fetch(`${base}/api/devices/pair/poll?code=ABC123`)).status;
    assert.equal(await poll(), 200);
    assert.equal(await poll(), 200);
    assert.equal(await poll(), 429);
});
