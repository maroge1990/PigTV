const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const express = require('express');

// #19 (0363): the Apple app names itself on every request (`X-PigTV-Client: PigTV/<build> (<OS> <version>; <model>)`).
// The server keeps it on the device row, from the pairing request onwards and on every authenticated request (API and
// stream URLs alike); a request without the header keeps what was recorded. Settings → Devices shows it. The old code
// has no app_client column and GET /api/devices has no `app`.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-device-client-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const db = require(path.join(sandbox, 'server/db'));
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const auth = require(path.join(sandbox, 'server/auth'));
const devices = require(path.join(sandbox, 'server/services/deviceAuth'));

const TV = 'PigTV/84 (tvOS 26.1; AppleTV14,1)';
let server, base, owner;

before(async () => {
    owner = await db.users.create({ username: 'owner', role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/api/devices', require(path.join(sandbox, 'server/routes/devices')));
    app.get('/api/stream', auth.streamAuth, (req, res) => res.json({ ok: true }));
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

async function pair(client) {
    const res = await fetch(`${base}/api/devices/pair/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(client ? { 'X-PigTV-Client': client } : {}) },
        body: JSON.stringify({ name: 'PigTV tvOS', platform: 'tvOS' })
    });
    assert.equal(res.status, 200);
    const { code } = await res.json();
    devices.approvePairing(code, owner);
    const poll = await (await fetch(`${base}/api/devices/pair/poll?code=${code}`)).json();
    return poll;
}

const row = (id) => devices.listDevices(owner.id).find(d => d.id === id);

test('the app the pairing request named is on the new device, and each request keeps it current', async () => {
    const { token, deviceId } = await pair('PigTV/83 (tvOS 26.0; AppleTV14,1)');
    assert.deepEqual(row(deviceId).app, { text: 'PigTV/83 (tvOS 26.0; AppleTV14,1)', build: '83', os: 'tvOS 26.0', model: 'AppleTV14,1', kind: 'Apple TV' });

    const list = await fetch(`${base}/api/devices`, { headers: { Authorization: `Bearer ${token}`, 'X-PigTV-Client': TV } });
    assert.equal(list.status, 200);
    const mine = (await list.json()).find(d => d.id === deviceId);
    assert.equal(mine.app.build, '84', 'an API request records the build it came from');
    assert.equal(mine.app_client, undefined, 'the raw column is not passed through');

    await fetch(`${base}/api/devices`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(row(deviceId).app.build, '84', 'a request without the header (the web, an older app) keeps it');

    const stream = await fetch(`${base}/api/stream?token=${encodeURIComponent(token)}`, { headers: { 'X-PigTV-Client': 'PigTV/85 (iPadOS 26.1; iPad13,4)' } });
    assert.equal(stream.status, 200);
    assert.equal(row(deviceId).app.kind, 'iPad', 'a stream request with the header counts too');
});

test('a device that never sent the header has no app; an odd or hostile header is kept as a short single line', async () => {
    const { deviceId } = await pair(null);
    assert.equal(row(deviceId).app, null);

    const { token, deviceId: other } = await pair(null);
    await fetch(`${base}/api/devices`, { headers: { Authorization: `Bearer ${token}`, 'X-PigTV-Client': `Curl/8   ${'x'.repeat(200)}` } });
    let app = row(other).app;
    assert.equal(app.build, undefined);
    assert.ok(app.text.startsWith('Curl/8 x') && Array.from(app.text).length <= 80, app.text);
    devices.touchDevice(other, 'PigTV/84 \u202e(tvOS 26.1;\nAppleTV14,1)');
    app = row(other).app;
    assert.ok(!/[\u202e\n]/.test(app.text), app.text);
    assert.equal(devices.describeClient('PigTV/84 (tvOS 26.1; arm64)').kind, null, 'a simulator names no device kind');
});

test('Settings → Devices shows the device kind, OS and app build, and says when the app has not reported one', async () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/pages/Settings.js'), 'utf8');
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const ctx = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => (id === 'devices-list' ? list : null), querySelectorAll: () => [], querySelector: () => null },
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [
            { id: 'a', name: 'PigTV tvOS', platform: 'tvOS', created_at: 1, last_seen_at: 2, revoked_at: null, app: devices.describeClient(TV) },
            { id: 'b', name: 'PigTV iOS', platform: 'iOS', created_at: 1, last_seen_at: 2, revoked_at: null, app: null }] })
    });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8'), ctx);
    vm.runInContext(js, ctx);
    await Object.create(ctx.SettingsPage.prototype).loadDevices();
    assert.ok(list.innerHTML.includes('Apple TV · tvOS 26.1 · PigTV 84'), list.innerHTML);
    assert.ok(list.innerHTML.includes('iOS · app version not reported yet'), list.innerHTML);
});
