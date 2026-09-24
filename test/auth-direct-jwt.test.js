const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0136 (roadmap S4.3b): passport, passport-jwt and passport-local are gone; server/auth.js
// verifies bearer tokens with jsonwebtoken itself and routes/auth.js checks passwords with
// bcrypt itself. The semantics are passport's: 401 "Unauthorized" (plain) without a valid
// token, the role taken from the user store rather than the token, revoked devices refused,
// "Missing credentials" / "Invalid credentials" at sign-in, a failing lookup is a 500.
// On the old code the packages are still dependencies, auth exports `passport`, and
// requireAuth on an app that never mounted routes/auth.js throws "Unknown authentication
// strategy" (a 500) instead of authenticating.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-auth-direct-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let bare, full, owner, viewer;
const SECRET = process.env.JWT_SECRET;

async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
    owner = await db.users.create({ username: 'owner', passwordHash: await auth.hashPassword('correct horse'), role: 'admin' });
    viewer = await db.users.create({ username: 'viewer', passwordHash: await auth.hashPassword('battery staple'), role: 'viewer' });

    // An app with requireAuth but without routes/auth.js mounted: nothing configures anything.
    const a = express();
    a.get('/me', auth.requireAuth, (req, res) => res.json(req.user));
    a.get('/admin', auth.requireAuth, auth.requireAdmin, (req, res) => res.json({ ok: true }));
    a.get('/maybe', auth.optionalAuth, (req, res) => res.json({ user: req.user || null }));
    a.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));
    bare = await listen(a);

    const b = express();
    b.use(express.json());
    b.use('/api/auth', load('routes/auth'));
    full = await listen(b);
});

after(() => {
    for (const s of [bare, full]) { s?.server.closeAllConnections?.(); s?.server.close(); }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const getWith = (url, header) => fetch(url, { headers: header ? { Authorization: header } : {} });

test('passport is gone: not a dependency, not exported', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    for (const name of ['passport', 'passport-jwt', 'passport-local']) {
        assert.equal(pkg.dependencies[name], undefined, `${name} is not a dependency`);
    }
    const lock = fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8');
    assert.ok(!/"node_modules\/passport/.test(lock), 'nor in the lockfile');
    assert.equal(auth.passport, undefined);
});

test('requireAuth: a valid bearer token passes, with the user as the store has it', async () => {
    const r = await getWith(`${bare.base}/me`, `Bearer ${auth.generateToken(owner)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: owner.id, username: 'owner', role: 'admin', deviceId: null });

    const lower = await getWith(`${bare.base}/me`, `bearer ${auth.generateToken(owner)}`);
    assert.equal(lower.status, 200, 'the scheme is case-insensitive, as passport-jwt had it');
});

test('requireAuth: no token, a bad or expired one, another scheme or a deleted user is 401 "Unauthorized"', async () => {
    const expired = jwt.sign({ id: owner.id, username: 'owner', role: 'admin' }, SECRET, { expiresIn: -10 });
    const forged = jwt.sign({ id: owner.id, username: 'owner', role: 'admin' }, 'some-other-key');
    const ghost = jwt.sign({ id: 999, username: 'ghost', role: 'admin' }, SECRET);
    for (const header of [null, 'Bearer', 'Bearer not.a.token', `Bearer ${expired}`, `Bearer ${forged}`,
        `Token ${auth.generateToken(owner)}`, `Bearer ${ghost}`]) {
        const r = await getWith(`${bare.base}/me`, header);
        assert.equal(r.status, 401, String(header));
        assert.equal(await r.text(), 'Unauthorized');
    }
});

test('the role comes from the store, not the token: a demoted admin\'s old token cannot administer', async () => {
    const stale = jwt.sign({ id: viewer.id, username: 'viewer', role: 'admin' }, SECRET);
    const r = await getWith(`${bare.base}/admin`, `Bearer ${stale}`);
    assert.equal(r.status, 403);
});

test('device tokens: valid while the device is, refused once it is revoked', async () => {
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev1', ?, 'TV', 'tvos', ?)`).run(String(owner.id), Date.now());
    const token = jwt.sign({ id: owner.id, username: 'owner', role: 'admin', deviceId: 'dev1' }, SECRET);
    const ok = await getWith(`${bare.base}/me`, `Bearer ${token}`);
    assert.equal((await ok.json()).deviceId, 'dev1');
    d.prepare(`UPDATE devices SET revoked_at = ? WHERE id = 'dev1'`).run(Date.now());
    assert.equal((await getWith(`${bare.base}/me`, `Bearer ${token}`)).status, 401);
    assert.deepEqual(await (await getWith(`${bare.base}/maybe`, `Bearer ${token}`)).json(), { user: null });
});

test('optionalAuth never refuses: a user when the token is good, none otherwise', async () => {
    assert.equal((await (await getWith(`${bare.base}/maybe`, `Bearer ${auth.generateToken(viewer)}`)).json()).user.username, 'viewer');
    assert.deepEqual(await (await getWith(`${bare.base}/maybe`, 'Bearer junk')).json(), { user: null });
    assert.deepEqual(await (await getWith(`${bare.base}/maybe`)).json(), { user: null });
});

test('a user lookup that fails is a 500 through the error handler, not a 401', async () => {
    const realGet = db.users.getById;
    db.users.getById = async () => { throw new Error('database is locked'); };
    auth.configureJwtStrategy(async (id) => db.users.getById(id));
    try {
        const r = await getWith(`${bare.base}/me`, `Bearer ${auth.generateToken(owner)}`);
        assert.equal(r.status, 500);
    } finally {
        db.users.getById = realGet;
        auth.configureJwtStrategy(async (id) => db.users.getById(id));
    }
});

test('sign-in: bcrypt-checked password, the same messages as before, a token that works', async () => {
    const login = (body) => fetch(`${full.base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    let r = await login({ username: 'owner' });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'Missing credentials' });

    r = await login({ username: 'owner', password: 'wrong' });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'Invalid credentials' });

    r = await login({ username: 'nobody', password: 'x' });
    assert.deepEqual(await r.json(), { error: 'Invalid credentials' });

    r = await login({ username: 'owner', password: 'correct horse' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.user, { id: owner.id, username: 'owner', role: 'admin' });
    assert.equal((await getWith(`${bare.base}/me`, `Bearer ${body.token}`)).status, 200);
});
