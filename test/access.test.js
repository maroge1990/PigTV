const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// Copy the server so its existing relative data paths never touch real data.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-access-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'dir');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const db = require(path.join(sandbox, 'server/db'));
const auth = require(path.join(sandbox, 'server/auth'));
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const sync = require(path.join(sandbox, 'server/services/syncService'));
const hw = require(path.join(sandbox, 'server/services/hwDetect'));
const upstreamCalls = [];
sync.syncSource = async id => { upstreamCalls.push(id); };
sync.syncAll = async () => { upstreamCalls.push('all'); };
sync.restartSyncTimer = async () => {};
hw.getCapabilities = () => ({ recommended: 'software' });
hw.refresh = async () => ({ recommended: 'software' });
let server, base, admin, viewer, source, epg, adminToken, viewerToken;

async function request(method, route, token, body) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, { method, headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
}

before(async () => {
    admin = await db.users.create({ username: 'owner', role: 'admin', passwordHash: await auth.hashPassword('owner-password') });
    viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(viewer);
    source = await db.sources.create({ type: 'm3u', name: 'Household channels',
        url: 'https://provider.invalid/list?token=playlist-secret', username: 'provider-user', password: 'provider-password' });
    epg = await db.sources.create({ type: 'epg', name: 'Separate guide', url: 'https://guide.invalid/feed?key=epg-secret' });
    const app = express();
    app.use(express.json());
    app.use(auth.passport.initialize());
    // Mount the actual auth/router implementations, not mocked authorization.
    app.use('/api/auth', require(path.join(sandbox, 'server/routes/auth')));
    app.use('/api/sources', require(path.join(sandbox, 'server/routes/sources')));
    app.use('/api/settings', require(path.join(sandbox, 'server/routes/settings')));
    app.use('/api/library', require(path.join(sandbox, 'server/routes/library')));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    sqlite.getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('anonymous requests cannot read sources/settings or invoke administration', async () => {
    const endpoints = [
        ['GET', '/api/sources'], ['GET', '/api/sources/type/m3u'], ['GET', `/api/sources/${source.id}`],
        ['GET', '/api/sources/status'], ['POST', '/api/sources'], ['PUT', `/api/sources/${source.id}`],
        ['DELETE', `/api/sources/${source.id}`], ['POST', `/api/sources/${source.id}/toggle`],
        ['POST', `/api/sources/${source.id}/test`], ['POST', `/api/sources/${source.id}/sync`],
        ['POST', '/api/sources/estimate'], ['GET', `/api/sources/${source.id}/estimate`],
        ['POST', '/api/sources/sync-all'], ['GET', '/api/settings'], ['PUT', '/api/settings'],
        ['DELETE', '/api/settings'], ['GET', '/api/settings/defaults'],
        ['GET', '/api/settings/sync-status'], ['GET', '/api/settings/hw-info'],
        ['POST', '/api/settings/hw-info/refresh']
    ];
    for (const [method, route] of endpoints) {
        assert.equal((await request(method, route)).status, 401, `${method} ${route}`);
    }
    assert.deepEqual(upstreamCalls, []);
});

test('viewers can discover M3U and separate EPG sources without configuration secrets', async () => {
    for (const token of [viewerToken, adminToken]) {
        for (const route of ['/api/sources', '/api/sources/type/m3u', '/api/sources/type/epg']) {
            const result = await request('GET', route, token);
            assert.equal(result.status, 200);
            assert.equal(result.headers.get('cache-control'), 'no-store');
            assert(result.data.length > 0);
            for (const item of result.data) {
                assert.deepEqual(Object.keys(item).sort(), ['enabled', 'id', 'name', 'type']);
            }
            assert(!JSON.stringify(result.data).includes('secret'));
            assert(!JSON.stringify(result.data).includes('provider-password'));
        }
    }
    assert.equal((await request('GET', '/api/settings', viewerToken)).status, 200);
    assert.equal((await request('GET', '/api/settings/sync-status', viewerToken)).status, 200);
});

test('viewers cannot mutate sources/settings, inspect edit credentials or initiate upstream work', async () => {
    for (const [method, route] of [
        ['GET', `/api/sources/${source.id}`], ['GET', '/api/sources/status'], ['POST', '/api/sources'],
        ['PUT', `/api/sources/${source.id}`], ['DELETE', `/api/sources/${source.id}`],
        ['POST', `/api/sources/${source.id}/toggle`], ['POST', `/api/sources/${source.id}/sync`],
        ['POST', `/api/sources/${source.id}/test`], ['GET', `/api/sources/${source.id}/estimate`],
        ['POST', '/api/sources/estimate'], ['POST', '/api/sources/sync-all'],
        ['PUT', '/api/settings'], ['DELETE', '/api/settings'], ['GET', '/api/settings/hw-info'],
        ['POST', '/api/settings/hw-info/refresh']
    ]) {
        assert.equal((await request(method, route, viewerToken, method === 'PUT' ? { requireStreamAuth: false } : undefined)).status, 403, `${method} ${route}`);
    }
    assert.deepEqual(upstreamCalls, []);
    assert.equal((await db.sources.getById(source.id)).name, 'Household channels');
});

test('known-default signatures, deleted users and stale admin claims cannot administer', async () => {
    const forged = jwt.sign(admin, 'pigtv-secret-key-change-in-production');
    assert.equal((await request('GET', '/api/sources', forged)).status, 401);
    const promotedClaims = jwt.sign({ ...viewer, role: 'admin' }, process.env.JWT_SECRET);
    assert.equal((await request('PUT', '/api/settings', promotedClaims, { requireStreamAuth: false })).status, 403);
    const deleted = await db.users.create({ username: 'deleted', role: 'admin' });
    const deletedToken = auth.generateToken(deleted);
    await db.users.delete(deleted.id);
    assert.equal((await request('GET', '/api/settings', deletedToken)).status, 401);
});

test('existing admin login and source edit preserve a write-only password', async () => {
    const login = await request('POST', '/api/auth/login', null, { username: 'owner', password: 'owner-password' });
    assert.equal(login.status, 200);
    assert(login.data.token);
    const detail = await request('GET', `/api/sources/${source.id}`, adminToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.hasPassword, true);
    assert.equal(detail.data.password, undefined);
    assert.equal(detail.data.url, source.url);
    const changed = await request('PUT', `/api/sources/${source.id}`, adminToken, { name: 'Renamed channels', url: source.url });
    assert.equal(changed.status, 200);
    assert.deepEqual(Object.keys(changed.data).sort(), ['enabled', 'id', 'name', 'type']);
    assert.equal((await db.sources.getById(source.id)).password, 'provider-password');
    await request('PUT', `/api/sources/${source.id}`, adminToken, { password: 'replacement-password' });
    assert.equal((await db.sources.getById(source.id)).password, 'replacement-password');
});

test('admin create/toggle/delete and settings writes remain usable', async () => {
    const created = await request('POST', '/api/sources', adminToken, { name: 'Disposable', type: 'm3u', url: 'https://fixture.invalid/?token=secret' });
    assert.equal(created.status, 201);
    assert.equal(created.data.url, undefined);
    const id = created.data.id;
    assert.equal((await request('POST', `/api/sources/${id}/toggle`, adminToken)).data.enabled, false);
    assert.equal((await request('DELETE', `/api/sources/${id}`, adminToken)).status, 200);
    assert.equal((await request('PUT', '/api/settings', adminToken, { showMovies: false, vaapiCpuScale: true })).status, 200);
    assert.equal((await request('GET', '/api/settings', viewerToken)).data.showMovies, false);
    assert.equal((await request('GET', '/api/settings/hw-info', adminToken)).status, 200);
    assert.equal((await request('POST', '/api/settings/hw-info/refresh', adminToken)).status, 200);
    assert.equal((await request('POST', '/api/sources/sync-all', adminToken)).status, 200);
});

test('paired device tokens share the signing key and revocation still works', async () => {
    const devices = require(path.join(sandbox, 'server/services/deviceAuth'));
    const pairing = devices.startPairing({ name: 'Test TV', platform: 'tvos' });
    const device = devices.approvePairing(pairing.code, viewer);
    const { token } = devices.pollPairing(pairing.code);
    assert.equal((await request('GET', '/api/sources', token)).status, 200);
    assert.equal(devices.pollPairing(pairing.code).status, 'claimed');
    devices.revokeDevice(viewer.id, device.deviceId);
    assert.equal((await request('GET', '/api/sources', token)).status, 401);
});

test('M3U duplicates, provider order, hidden groups and a separate EPG survive', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 505; i++) {
        lines.push(`#EXTINF:-1 tvg-id="shared.epg" group-title="${i < 502 ? 'Z first' : 'A second'}",Channel ${i}`,
            'https://fixture.invalid/same-stream');
    }
    const originalFetch = global.fetch;
    try {
        global.fetch = async url => {
            assert.equal(url, source.url);
            return new Response(lines.join('\n'));
        };
        await sync.syncM3u(source);
    } finally { global.fetch = originalFetch; }
    const sql = sqlite.getDb();
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ?').get(source.id).n, 505);
    const categories = await request('GET', '/api/library/categories', viewerToken);
    assert.deepEqual(categories.data.map(c => c.name), ['Z first', 'A second']);
    const now = Date.now();
    sql.prepare('INSERT INTO epg_programs (source_id, channel_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)')
        .run(epg.id, 'shared.epg', now - 60000, now + 3600000, 'Separate EPG programme');
    const guide = await request('GET', '/api/library/guide?limit=2', viewerToken);
    assert.equal(guide.status, 200);
    assert.deepEqual(guide.data.channels.map(c => c.name), ['Channel 0', 'Channel 1']);
    assert.equal(guide.data.channels[0].programmes[0].title, 'Separate EPG programme');
    assert.equal(guide.data.channels[0].programmes[0].isNow, true);
    sql.prepare('UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND name = ?').run(source.id, 'Z first');
    const visible = await request('GET', '/api/library/channels', viewerToken);
    assert.equal(visible.data.total, 3);
    assert.equal(visible.data.channels[0].name, 'Channel 502');
});

test('HE-AAC still requires audio conversion and HEVC compatibility follows the client', () => {
    const { analyzeProbeResult } = require(path.join(sandbox, 'server/services/streamProbe'));
    const media = profile => ({ streams: [{ codec_type: 'video', codec_name: 'hevc' },
        { codec_type: 'audio', codec_name: 'aac', profile, channels: 2 }], format: { format_name: 'mpegts' } });
    const he = analyzeProbeResult(media('HE-AAC'), 'https://fixture.invalid/live.ts', { hevc: true });
    assert.equal(he.videoOk, true);
    assert.equal(he.audioOk, false);
    const lc = analyzeProbeResult(media('LC'), 'https://fixture.invalid/live.ts', { hevc: true });
    assert.equal(lc.videoOk, true);
    assert.equal(lc.audioOk, true);
    assert.equal(analyzeProbeResult(media('LC'), 'https://fixture.invalid/live.ts', { hevc: false }).videoOk, false);
});
