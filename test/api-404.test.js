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
    ['GET', '/api/library/favourites'], ['GET', '/api/library/guide'], ['GET', '/api/library/guide/version'],
    ['GET', '/api/logo/0123456789abcdef0123456789abcdef'],
    ['POST', '/api/favorites'], ['DELETE', '/api/favorites'], ['GET', '/api/favorites/check'],
    ['POST', '/api/playback/resolve'], ['GET', '/api/playback/conflict'], ['POST', '/api/playback/conflict/decline'],
    ['POST', '/api/playback/client-event'],
    ['GET', '/api/playback/some-session-id/terminal-status'],
    ['GET', '/api/recordings'], ['GET', '/api/recordings/scheduled'], ['POST', '/api/recordings/schedule'],
    ['GET', '/api/recordings/1/playback'], ['GET', '/api/recordings/1/media.mp4'], ['GET', '/api/recordings/1/markers'],
    // 0127 (C-E): an HLS recording's playlist and the files it references.
    ['GET', '/api/recordings/1/index.m3u8'], ['GET', '/api/recordings/1/init.mp4'], ['GET', '/api/recordings/1/seg00000.m4s'],
    ['GET', '/api/proxy/stream'],
    ['GET', '/api/transcode/abc/stream.m3u8'], ['GET', '/api/transcode/abc/master.m3u8'],
    ['DELETE', '/api/playback/abc'],
    // 0148 (C-I): the Sport tab and the Home screen's "Sport now & next" row.
    ['GET', '/api/sports/events']
];

test('every route the Apple client calls still reaches its real handler', async () => {
    const swallowed = [];
    for (const [method, route] of APPLE_CLIENT_ROUTES) {
        const r = await call(method, route);
        if (r.body && r.body.error === 'No such API endpoint') swallowed.push(`${method} ${route}`);
    }
    assert.deepEqual(swallowed, []);
});

// 0122: the fork's leftovers, removed once nothing called them. Each must now reach the
// generic reply - with a token, so a router that authenticates first cannot answer 401
// instead. The token is the first-run admin's, made on this sandbox's empty database.
const REMOVED_ROUTES = [
    // Xtream-provider emulation, the whole-EPG dump, M3U-as-JSON and the file cache
    ['GET', '/api/proxy/xtream/1'], ['GET', '/api/proxy/xtream/1/live_categories'], ['GET', '/api/proxy/xtream/1/live_streams'],
    ['GET', '/api/proxy/xtream/1/vod_categories'], ['GET', '/api/proxy/xtream/1/vod_streams'], ['GET', '/api/proxy/xtream/1/series_categories'],
    ['GET', '/api/proxy/xtream/1/series'], ['GET', '/api/proxy/xtream/1/series_info'], ['GET', '/api/proxy/xtream/1/vod_info'],
    ['GET', '/api/proxy/xtream/1/short_epg'], ['GET', '/api/proxy/xtream/1/stream/2/live'], ['GET', '/api/proxy/xtream/1/stream/2'],
    ['GET', '/api/proxy/epg/1'], ['POST', '/api/proxy/epg/1/channels'], ['DELETE', '/api/proxy/epg/1/cache'],
    ['GET', '/api/proxy/m3u/1'], ['DELETE', '/api/proxy/cache/1'], ['GET', '/api/proxy/image?url=http%3A%2F%2Fx%2Fa.png'],
    // what only the movie/series pages used
    ['POST', '/api/transcode/session'], ['GET', '/api/probe?url=http%3A%2F%2Fx%2F1.ts'], ['GET', '/api/subtitle?url=http%3A%2F%2Fx%2F1.ts&index=0'],
    ['GET', '/api/history'], ['POST', '/api/history'], ['DELETE', '/api/history/1'], ['GET', '/api/channels/recent?type=movie']
];

test('the removed fork routes answer the generic 404, even with a token (0122)', async () => {
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'fixture-password' }) });
    const { token } = await setup.json();
    assert.ok(token, 'the sandbox admin');
    const still = [];
    for (const [method, route] of REMOVED_ROUTES) {
        const r = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: method === 'GET' ? undefined : '{}' });
        const body = await r.json().catch(() => null);
        if (r.status !== 404 || body?.error !== 'No such API endpoint') still.push(`${method} ${route} -> ${r.status}`);
    }
    assert.deepEqual(still, []);
    const stream = await fetch(`${base}/api/proxy/stream?h=${'0'.repeat(32)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stream.status, 404, 'an unknown handle');
    assert.equal((await stream.json()).error, 'Unknown or expired playback handle', 'but /api/proxy/stream itself is still there');
});

test('nothing in the web app still calls a removed route (0122)', () => {
    const files = [path.join(__dirname, '../public/index.html')];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
        }
    };
    walk(path.join(__dirname, '../public/js'));
    const needles = ['/proxy/xtream', '/proxy/epg', '/proxy/m3u', '/proxy/cache', '/proxy/image', 'API.proxy',
        "/transcode/session'", '/transcode/session`', '/api/probe', '/api/subtitle', "'/history", '/channels/recent',
        'MoviesPage', 'SeriesPage', 'WatchPage', 'data-page="movies"', 'data-page="series"', 'data-page="watch"'];
    const found = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const n of needles) if (src.includes(n)) found.push(`${path.relative(path.join(__dirname, '..'), f)}: ${n}`);
    }
    assert.deepEqual(found, []);
    for (const gone of ['pages/MoviesPage.js', 'pages/SeriesPage.js', 'pages/WatchPage.js']) {
        assert.equal(fs.existsSync(path.join(__dirname, '../public/js', gone)), false, gone);
    }
});
