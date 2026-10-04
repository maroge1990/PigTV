const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stopServer } = require('./helpers/server');
const { once } = require('node:events');
const express = require('express');

// R01: media and session control always require a signed-in user. Two halves:
//   A. the real server/index.js in a child process (the mounts, the Referrer-Policy header, the
//      proxy refusing ?url=, admin-only session control, the user store deciding the role);
//   B. the routers in-process behind streamAuth, with a stand-in transcode session, for the
//      cases that need to reach into the process (revoked device, a throwing settings store,
//      the token on every playlist URI).
// Each half has its own sandbox copy of the server so neither touches real data.
const SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.JWT_SECRET = SECRET;

function sandboxCopy(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.cpSync(path.join(__dirname, '../server'), path.join(dir, 'server'), { recursive: true });
    // version.js reads ../package.json: without it the spawned server dies at once (it used to
    // pass only when something else happened to leave one where Node looked).
    fs.cpSync(path.join(__dirname, '../package.json'), path.join(dir, 'package.json'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return dir;
}
const rm = (dir) => {
    try { fs.rmdirSync(path.join(dir, 'node_modules')); } catch { /* link already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
};
const json = (token, body) => ({
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

// ---------------------------------------------------------------------------------------------
// A. the real server
// ---------------------------------------------------------------------------------------------
const serverSandbox = sandboxCopy('pigtv-streamauth-srv-');
let server, base, adminToken, viewerToken, deletedToken, deletedId;
const HANDLE = '0'.repeat(32);

before(async () => {
    server = await startServer({ cwd: serverSandbox, env: { JWT_SECRET: SECRET } });
    base = server.base;
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', ...json(null, { username: 'owner', password: 'owner-password' }) });
    adminToken = (await setup.json()).token;
    assert.ok(adminToken, 'first-run admin');
    const make = async (username, role) => (await (await fetch(`${base}/api/auth/users`, { method: 'POST', ...json(adminToken, { username, password: 'a-long-password', role }) })).json());
    const viewer = await make('viewer', 'viewer');
    const doomed = await make('doomed', 'viewer');
    const login = async (username) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', ...json(null, { username, password: 'a-long-password' }) })).json()).token;
    viewerToken = await login('viewer');
    deletedToken = await login('doomed');
    deletedId = (doomed.user || doomed).id;
    assert.ok(viewerToken && deletedToken && viewer);
});

after(async () => {
    await stopServer(server);
    rm(serverSandbox);
});

const MEDIA_ROUTES = [
    `/api/proxy/stream?h=${HANDLE}`,
    '/api/transcode/abc/stream.m3u8',
    '/api/transcode/abc/master.m3u8',
    '/api/transcode/abc/seg0001.ts',
    '/api/recordings/1/media.mp4',
    '/api/recordings/1/stream',
    '/api/recordings/1/download',
    '/api/recordings/1/index.m3u8',
    '/api/recordings/1/seg00001.m4s'
];

test('no token: every media route is a 401, with no setting to change that', async () => {
    for (const route of MEDIA_ROUTES) {
        const r = await fetch(`${base}${route}`);
        assert.equal(r.status, 401, route);
        assert.equal((await r.json()).error, 'Authentication required', route);
    }
    // The old opt-in setting is simply ignored: switching it off (or leaving a stored value) changes nothing.
    assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', ...json(adminToken, { requireStreamAuth: false }) })).status, 200);
    assert.equal((await fetch(`${base}/api/recordings/1/media.mp4`)).status, 401);
    const defaults = await (await fetch(`${base}/api/settings/defaults`, json(adminToken))).json();
    assert.equal('requireStreamAuth' in defaults, false, 'the setting is gone from the defaults');
});

test('a garbage or forged token is a 401 too', async () => {
    const forged = require('jsonwebtoken').sign({ id: 1, username: 'x', role: 'admin' }, 'some-other-key');
    for (const t of ['garbage', forged]) {
        for (const route of MEDIA_ROUTES) assert.equal((await fetch(`${base}${route}?token=${t}`)).status, 401, route);
    }
});

test('a valid token gets past auth: ?token= and the bearer header both work', async () => {
    // Nothing exists behind these ids, so the answer is the route's own 404, never a 401.
    for (const route of ['/api/transcode/abc/stream.m3u8', '/api/recordings/1/media.mp4', '/api/recordings/1/download', `/api/proxy/stream?h=${HANDLE}`]) {
        const sep = route.includes('?') ? '&' : '?';
        assert.equal((await fetch(`${base}${route}${sep}token=${encodeURIComponent(viewerToken)}`)).status, 404, `${route} by query`);
        assert.equal((await fetch(`${base}${route}`, json(viewerToken))).status, 404, `${route} by header`);
    }
});

test('the proxy takes handles only: ?url= is a 400 even with a valid token, loopback included', async () => {
    for (const token of [viewerToken, adminToken]) {
        for (const target of [`${base}/api/version`, 'http://127.0.0.1:1/', 'http://192.168.1.1/']) {
            const r = await fetch(`${base}/api/proxy/stream?url=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}`);
            assert.equal(r.status, 400, target);
        }
    }
    assert.equal((await fetch(`${base}/api/proxy/stream?token=${encodeURIComponent(viewerToken)}`)).status, 400, 'and no handle at all');
});

test('a deleted user\'s token stops working at once, on every media route', async () => {
    assert.equal((await fetch(`${base}/api/recordings/1/download?token=${encodeURIComponent(deletedToken)}`)).status, 404, 'works while the user exists');
    const del = await fetch(`${base}/api/auth/users/${deletedId}`, { method: 'DELETE', ...json(adminToken) });
    assert.equal(del.status, 200);
    for (const route of MEDIA_ROUTES) assert.equal((await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}token=${encodeURIComponent(deletedToken)}`)).status, 401, route);
});

test('session control is admin only: 403 for a viewer, 200 for an admin; releasing one session stays open to a viewer', async () => {
    assert.equal((await fetch(`${base}/api/transcode/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/transcode/sessions`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/api/transcode/sessions`, json(viewerToken))).status, 403);
    assert.equal((await fetch(`${base}/api/transcode/sessions/all`, { method: 'DELETE', ...json(viewerToken) })).status, 403);
    assert.equal((await fetch(`${base}/api/transcode/sessions?token=${encodeURIComponent(viewerToken)}`)).status, 403);
    const list = await fetch(`${base}/api/transcode/sessions`, json(adminToken));
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(await list.json()));
    const all = await fetch(`${base}/api/transcode/sessions/all`, { method: 'DELETE', ...json(adminToken) });
    assert.equal(all.status, 200);
    assert.equal((await all.json()).success, true);
    assert.equal((await fetch(`${base}/api/transcode/some-session`, { method: 'DELETE', ...json(viewerToken) })).status, 200, 'players release their own sessions');
    assert.equal((await fetch(`${base}/api/transcode/some-session`, { method: 'DELETE' })).status, 401);
});

test('the role comes from the user store, not the token: a viewer holding admin claims is still a viewer', async () => {
    const viewerId = JSON.parse(Buffer.from(viewerToken.split('.')[1], 'base64url')).id;
    const promoted = require('jsonwebtoken').sign({ id: viewerId, username: 'viewer', role: 'admin' }, SECRET);
    assert.equal((await fetch(`${base}/api/transcode/sessions`, json(promoted))).status, 403);
    assert.equal((await fetch(`${base}/api/transcode/sessions?token=${encodeURIComponent(promoted)}`)).status, 403);
});

test('every response carries Referrer-Policy: no-referrer, errors and the web app included', async () => {
    for (const route of ['/api/version', '/api/recordings/1/media.mp4', '/api/no-such-endpoint', '/', '/api/logo/nothing']) {
        const r = await fetch(`${base}${route}`);
        assert.equal(r.headers.get('referrer-policy'), 'no-referrer', route);
        await r.arrayBuffer();
    }
});

// ---------------------------------------------------------------------------------------------
// B. in-process routers
// ---------------------------------------------------------------------------------------------
const sandbox = sandboxCopy('pigtv-streamauth-proc-');
const load = p => require(path.join(sandbox, 'server', p));
let app, appServer, appBase, owner, ownerToken, deviceToken, deviceId;
const realGetSession = {};
const PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4.0,', 'seg0001.m4s', '#EXTINF:4.0,', 'seg0002.m4s', ''].join('\n');
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nstream.m3u8\n';

before(async () => {
    const db = load('db');
    const auth = load('auth');
    const deviceAuth = load('services/deviceAuth');
    const transcodeSession = load('services/transcodeSession');
    owner = await db.users.create({ username: 'owner', role: 'admin' });
    ownerToken = auth.generateToken(owner);

    // A device, paired the way the Apple client pairs.
    const { code } = deviceAuth.startPairing({ name: 'Apple TV', platform: 'tvos' });
    deviceId = deviceAuth.approvePairing(code, owner).deviceId;
    deviceToken = deviceAuth.pollPairing(code).token;

    // A stand-in session: a playlist, a master playlist and one segment on disk.
    const segFile = path.join(sandbox, 'seg0001.m4s');
    fs.writeFileSync(segFile, 'segment-bytes');
    realGetSession.fn = transcodeSession.getSession;
    transcodeSession.getSession = (id) => (id === 'live1' ? {
        status: 'ready',
        getPlaylist: async () => PLAYLIST,
        getMasterPlaylist: () => MASTER,
        getSegment: async (name) => (name === 'seg0001.m4s' ? segFile : null)
    } : realGetSession.fn(id));

    app = express();
    app.use('/api/transcode', auth.streamAuth, load('routes/transcode'));
    app.use('/api/recordings', auth.streamAuth, load('routes/recordings'));
    appServer = app.listen(0, '127.0.0.1');
    await once(appServer, 'listening');
    appBase = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
    appServer?.closeAllConnections?.();
    appServer?.close();
    try { load('db/sqlite').getDb().close(); } catch { /* already closed */ }
    rm(sandbox);
});

test('a transcode playlist fetched with ?token= carries the token on every segment and init URI, and the master on its variant', async () => {
    const q = `token=${encodeURIComponent(ownerToken)}`;
    const media = await (await fetch(`${appBase}/api/transcode/live1/stream.m3u8?${q}`)).text();
    assert.ok(media.includes(`#EXT-X-MAP:URI="init.mp4?${q}"`), media);
    const uris = media.split('\n').filter(l => l && !l.startsWith('#'));
    assert.equal(uris.length, 2);
    for (const u of uris) assert.ok(u.endsWith(`?${q}`), u);
    const master = await (await fetch(`${appBase}/api/transcode/live1/master.m3u8?${q}`)).text();
    assert.ok(master.includes(`stream.m3u8?${q}`), master);
    // And what the playlist points at plays with that token, not without it.
    assert.equal((await fetch(`${appBase}/api/transcode/live1/seg0001.m4s?${q}`)).status, 200);
    assert.equal((await fetch(`${appBase}/api/transcode/live1/seg0001.m4s`)).status, 401);
    assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8`)).status, 401);
});

test('a revoked device\'s token is refused on playlist and segment, a live one is not', async () => {
    const q = `token=${encodeURIComponent(deviceToken)}`;
    assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8?${q}`)).status, 200);
    load('services/deviceAuth').revokeDevice(owner.id, deviceId);
    assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8?${q}`)).status, 401);
    assert.equal((await fetch(`${appBase}/api/transcode/live1/seg0001.m4s?${q}`)).status, 401);
    assert.equal((await fetch(`${appBase}/api/recordings/1/media.mp4`, json(deviceToken))).status, 401);
});

test('a throwing settings store changes nothing: stream auth no longer reads settings, so it is still a 401 without a token', async () => {
    const db = load('db');
    const realGet = db.settings.get;
    db.settings.get = async () => { throw new Error('settings store is down'); };
    try {
        assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8`)).status, 401);
        assert.equal((await fetch(`${appBase}/api/recordings/1/media.mp4`)).status, 401);
        assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8?token=${encodeURIComponent(ownerToken)}`)).status, 200);
    } finally {
        db.settings.get = realGet;
    }
});

test('a throwing user store is a 401, never a pass', async () => {
    const auth = load('auth');
    auth.configureJwtStrategy(async () => { throw new Error('user store is down'); });
    try {
        assert.equal((await fetch(`${appBase}/api/transcode/live1/stream.m3u8?token=${encodeURIComponent(ownerToken)}`)).status, 401);
    } finally {
        auth.configureJwtStrategy(async (id) => load('db').users.getById(id));
    }
});
