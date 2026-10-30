const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Ending a playback session (DELETE /api/transcode/:id, and DELETE /api/playback/:id
// which the Apple client sends) is for the account that started it, a device paired
// to that account, or an admin. Another viewer's request is refused and the session
// keeps running. An id that names no session still answers success, as before.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-session-owner-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
const cwd = process.cwd();
process.chdir(sandbox); // the session cache folder is relative to the working directory
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const deviceAuth = load('services/deviceAuth');
const transcodeSession = load('services/transcodeSession');
const relay = load('services/streamRelay');

let server, base;
const tokens = {};
const ids = {};

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    const alice = await db.users.create({ username: 'alice', role: 'viewer' });
    const bob = await db.users.create({ username: 'bob', role: 'viewer' });
    ids.alice = alice.id;
    tokens.admin = auth.generateToken(admin);
    tokens.alice = auth.generateToken(alice);
    tokens.bob = auth.generateToken(bob);
    // Alice's Apple TV, paired the way the Apple client pairs.
    const { code } = deviceAuth.startPairing({ name: 'PigTV tvOS', platform: 'tvOS' });
    ids.aliceTv = deviceAuth.approvePairing(code, alice).deviceId;
    tokens.aliceTv = deviceAuth.pollPairing(code).token;

    const app = express();
    app.use(express.json());
    app.use('/api/transcode', auth.streamAuth, load('routes/transcode'));
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(cwd);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

// A session as the playback path registers it: owner key in its options, never started.
const session = (owner) => transcodeSession.createSession('http://provider.invalid/live/1.ts', { owner });
const end = (route, id, token) => fetch(`${base}${route}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const alive = (id) => !!transcodeSession.peekSession(id);

for (const route of ['/api/transcode', '/api/playback']) {
    test(`${route}: another viewer cannot end a session, and it keeps running`, async () => {
        const s = await session(`user:${ids.alice}`);
        const res = await end(route, s.id, tokens.bob);
        assert.equal(res.status, 403);
        assert.ok(alive(s.id), 'still running');
        await transcodeSession.removeSession(s.id);
    });

    test(`${route}: the viewer who started a session can end it`, async () => {
        const s = await session(`user:${ids.alice}`);
        const res = await end(route, s.id, tokens.alice);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { success: true });
        assert.ok(!alive(s.id));
    });

    test(`${route}: a paired device ends its own session, and its account may too`, async () => {
        const s1 = await session(`device:${ids.aliceTv}`);
        assert.equal((await end(route, s1.id, tokens.aliceTv)).status, 200);
        assert.ok(!alive(s1.id));
        const s2 = await session(`device:${ids.aliceTv}`);
        assert.equal((await end(route, s2.id, tokens.bob)).status, 403, 'not another account');
        assert.equal((await end(route, s2.id, tokens.alice)).status, 200, 'the account the device is paired to');
        assert.ok(!alive(s2.id));
    });

    test(`${route}: an admin can end anyone's session`, async () => {
        const s = await session(`device:${ids.aliceTv}`);
        assert.equal((await end(route, s.id, tokens.admin)).status, 200);
        assert.ok(!alive(s.id));
    });

    test(`${route}: an id that names no session still answers success`, async () => {
        const res = await end(route, 'no-such-session', tokens.bob);
        assert.equal(res.status, 200);
    });
}

test('a followed stream (relay) is owned by the viewer that started it', async () => {
    const realGet = relay.get;
    const closed = [];
    const fake = { ctx: { owner: `user:${ids.alice}` } };
    relay.get = (id) => (id === 'relay-1' ? fake : realGet(id));
    const realClose = relay.close;
    relay.close = async (id) => { if (id === 'relay-1') { closed.push(id); return true; } return realClose(id); };
    try {
        assert.equal((await end('/api/playback', 'relay-1', tokens.bob)).status, 403);
        assert.equal((await end('/api/transcode', 'relay-1', tokens.bob)).status, 403);
        assert.deepEqual(closed, []);
        assert.equal((await end('/api/playback', 'relay-1', tokens.alice)).status, 200);
        assert.deepEqual(closed, ['relay-1']);
    } finally {
        relay.get = realGet;
        relay.close = realClose;
    }
});
