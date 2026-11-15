const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { createFakeProvider } = require('../scripts/fake-provider');

// #330: POST /api/sources/test checks a provider's details before they are saved. Admin only, writes nothing, the same
// rules as creating a source and the same reply as POST /api/sources/:id/test (one helper, sourceTest.js), every error
// without the login, the address or its host. The provider is scripts/fake-provider.js and local stand-ins.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-source-test-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sourceTest = load('services/sourceTest');
const sync = load('services/syncService');
const syncCalls = [];
sync.syncSource = async (id) => { syncCalls.push(id); };

const LOGIN = { user: 'tester', pass: 'fake-pass-330' };
let fake, fakeBase, app, server, base, adminToken, viewerToken;

async function call(route, body, token = adminToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, data, text };
}
/** Every table's row count: a call that writes nothing leaves them all as they were. */
function rowCounts() {
    const d = sqlite.getDb();
    const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name);
    return Object.fromEntries(tables.map(t => [t, d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}
/** A port nothing listens on (fetch refuses the "bad ports" such as 9 before connecting). */
async function closedPort() {
    const probe = http.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise(r => probe.close(r));
    return port;
}
const xtream = () => ({ type: 'xtream', url: fakeBase, username: LOGIN.user, password: LOGIN.pass });

before(async () => {
    fake = createFakeProvider({ ...LOGIN, channels: 0, quiet: true, ffmpegPath: '/nonexistent/ffmpeg' });
    fakeBase = await fake.listen(0, '127.0.0.1');
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(viewer);
    app = express();
    app.use(express.json());
    app.use('/api/sources', load('routes/sources'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    server?.closeAllConnections?.();
    await new Promise(r => server ? server.close(r) : r());
    await fake?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp cleaner */ }
});

test('#330: only an admin can test details, and a refused call reaches no provider', async () => {
    const before = fake.status().requests.api;
    assert.equal((await call('/api/sources/test', xtream(), null)).status, 401);
    assert.equal((await call('/api/sources/test', xtream(), viewerToken)).status, 403);
    assert.equal(fake.status().requests.api, before, 'nothing was fetched');
});

test('#330: the same rules as creating a source', async () => {
    assert.deepEqual((await call('/api/sources/test', { type: 'xtream' })).data, { error: 'Type and URL are required' });
    assert.deepEqual((await call('/api/sources/test', { url: fakeBase })).data, { error: 'Type and URL are required' });
    const bad = await call('/api/sources/test', { type: 'ftp', url: fakeBase });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data, { error: 'Invalid source type' });
    assert.equal((await call('/api/sources', { type: 'ftp', name: 'x', url: fakeBase })).data.error, 'Invalid source type', 'create says the same');
});

test('#330: a pass answers the account facts, writes nothing and matches the saved provider\'s test', async () => {
    const counts = rowCounts();
    const fresh = await call('/api/sources/test', xtream());
    assert.equal(fresh.status, 200);
    assert.deepEqual(rowCounts(), counts, 'no row written');
    assert.deepEqual(syncCalls, [], 'no sync started');
    assert.equal(fresh.data.success, true, fresh.text);
    assert.deepEqual(Object.keys(fresh.data).sort(), ['activeConnections', 'expiresAt', 'isTrial', 'maxConnections', 'status', 'success']);
    for (const secret of [LOGIN.user, LOGIN.pass, '127.0.0.1']) assert.ok(!fresh.text.includes(secret), `${secret} in ${fresh.text}`);

    const saved = await db.sources.create({ type: 'xtream', name: 'Fake', url: fakeBase, username: LOGIN.user, password: LOGIN.pass });
    try {
        const old = await call(`/api/sources/${saved.id}/test`, {});
        assert.deepEqual(fresh.data, old.data, 'the same reply as a saved provider');
    } finally {
        await db.sources.delete(saved.id);
    }

    for (const [type, url, message] of [['m3u', `${fakeBase}/get.php?username=${LOGIN.user}&password=${LOGIN.pass}`, 'Valid M3U playlist'],
        ['epg', `${fakeBase}/xmltv.php?username=${LOGIN.user}&password=${LOGIN.pass}`, 'Valid EPG XML']]) {
        const r = await call('/api/sources/test', { type, url });
        assert.deepEqual(r.data, { success: true, message }, type);
    }
    const wrong = await call('/api/sources/test', { ...xtream(), password: 'not-it' });
    assert.deepEqual(wrong.data, { success: false, error: 'The provider rejected the login' });
    assert.deepEqual(rowCounts(), counts, 'still nothing written');
});

test('#330: an upstream error quoting the address and password is redacted in the reply and the log', async () => {
    const secretUrl = `http://secret-host.invalid:8181/player_api.php?username=${LOGIN.user}&password=${LOGIN.pass}`;
    const originalFetch = global.fetch;
    const logs = [];
    const saved = { warn: console.warn, error: console.error };
    console.warn = console.error = (...a) => logs.push(a.join(' '));
    global.fetch = async (url, opts) => {
        if (String(url).startsWith(base)) return originalFetch(url, opts);
        throw new Error(`connect failed for ${secretUrl} (secret-host.invalid:8181, 10.20.30.40:8181)`);
    };
    try {
        const r = await call('/api/sources/test', { type: 'xtream', url: 'http://secret-host.invalid:8181', username: LOGIN.user, password: LOGIN.pass });
        assert.equal(r.data.success, false);
        assert.ok(r.data.error, 'a reason for the admin');
        for (const text of [r.text, ...logs]) {
            for (const bit of [LOGIN.pass, LOGIN.user, 'secret-host.invalid', '8181', '10.20.30.40', '://']) {
                assert.ok(!text.includes(bit), `"${bit}" in ${text}`);
            }
        }
        assert.ok(logs.some(l => /Test of a new provider failed/.test(l)), logs.join('\n'));
    } finally {
        global.fetch = originalFetch;
        Object.assign(console, saved);
    }
});

test('#330: a server that never answers fails within the test\'s deadline; a refused one says so', async () => {
    const hang = http.createServer(() => { /* never answers */ }).listen(0, '127.0.0.1');
    await once(hang, 'listening');
    const was = sourceTest.limits.timeoutMs;
    sourceTest.limits.timeoutMs = 300;
    try {
        const startedAt = Date.now();
        const r = await call('/api/sources/test', { type: 'm3u', url: `http://127.0.0.1:${hang.address().port}/list.m3u` });
        assert.equal(r.data.success, false);
        assert.match(r.data.error, /did not answer/);
        assert.ok(Date.now() - startedAt < 5000);
    } finally {
        sourceTest.limits.timeoutMs = was;
        hang.closeAllConnections(); hang.close();
    }
    const refused = await call('/api/sources/test', { type: 'm3u', url: `http://127.0.0.1:${await closedPort()}/list.m3u` });
    assert.deepEqual(refused.data, { success: false, error: 'Could not reach the server (ECONNREFUSED)' });
});

test('#330: POST /estimate returns its error without the address or the login', async () => {
    const url = `http://secret-host.invalid:8181/get.php?username=${LOGIN.user}&password=${LOGIN.pass}`;
    const originalFetch = global.fetch;
    const logs = [];
    const saved = console.error;
    console.error = (...a) => logs.push(a.join(' '));
    global.fetch = async (target, opts) => {
        if (String(target).startsWith(base)) return originalFetch(target, opts);
        throw new Error(`connect failed for ${url} (secret-host.invalid:8181)`);
    };
    try {
        const r = await call('/api/sources/estimate', { type: 'm3u', url });
        assert.equal(r.status, 500);
        assert.equal(r.data.error, 'Failed to estimate playlist size');
        for (const text of [r.text, ...logs]) {
            for (const bit of [LOGIN.pass, LOGIN.user, 'secret-host.invalid', '8181', '://']) assert.ok(!text.includes(bit), `"${bit}" in ${text}`);
        }
    } finally {
        global.fetch = originalFetch;
        console.error = saved;
    }
});
