const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// A pairing request's device name and platform are stored as a tidy label:
// trimmed, without control characters, and of bounded length. What the Apple
// client sends ("PigTV tvOS" / "PigTV iOS", platform "tvOS" / "iOS") is kept
// exactly as sent.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-pairing-name-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const db = require(path.join(sandbox, 'server/db'));
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const devices = require(path.join(sandbox, 'server/services/deviceAuth'));

let server, base, owner;

before(async () => {
    owner = await db.users.create({ username: 'owner', role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/api/devices', require(path.join(sandbox, 'server/routes/devices')));
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

async function pairOverHttp(body) {
    const res = await fetch(`${base}/api/devices/pair/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(res.status, 200);
    const { code } = await res.json();
    const device = devices.approvePairing(code, owner);
    return devices.listDevices(owner.id).find(d => d.id === device.deviceId);
}

test('the Apple client\'s pairing name and platform are stored as sent', async () => {
    for (const platform of ['tvOS', 'iOS']) {
        const row = await pairOverHttp({ name: `PigTV ${platform}`, platform });
        assert.equal(row.name, `PigTV ${platform}`);
        assert.equal(row.platform, platform);
    }
});

test('a pairing name is trimmed, loses control characters and is capped in length', async () => {
    const row = await pairOverHttp({ name: '  Living\u0000 room\u001b TV‮\n  ', platform: '\ttvOS\r\n' });
    assert.equal(row.name, 'Living room TV');
    assert.equal(row.platform, 'tvOS');
    assert.equal((await pairOverHttp({ name: 'Den\tTV', platform: 'tvOS' })).name, 'Den TV', 'a tab is a space');

    const long = await pairOverHttp({ name: 'x'.repeat(500), platform: 'y'.repeat(200) });
    assert.ok(long.name.length <= 64, `name length ${long.name.length}`);
    assert.ok(long.platform.length <= 32, `platform length ${long.platform.length}`);
});

test('a pairing name that is not text, or empty once cleaned, gets the default label', async () => {
    const odd = await pairOverHttp({ name: { nested: true }, platform: ['tvOS'] });
    assert.equal(odd.name, 'Unnamed device');
    assert.equal(odd.platform, 'unknown');
    const blank = await pairOverHttp({ name: ' \u0007\u0008 ', platform: '' });
    assert.equal(blank.name, 'Unnamed device');
    assert.equal(blank.platform, 'unknown');
});

test('a name given at approval is cleaned the same way', () => {
    const { code } = devices.startPairing({ name: 'PigTV tvOS', platform: 'tvOS' });
    const device = devices.approvePairing(code, owner, { name: ' Bedroom\u0000 TV ', platform: 'tvOS\u0001' });
    assert.equal(device.name, 'Bedroom TV');
    assert.equal(device.platform, 'tvOS');
});
