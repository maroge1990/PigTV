const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const { sqlCount } = require('./helpers/sqlCount');

// I-1 (#273): every media request from a paired device (an HLS playlist and a segment every few
// seconds) looked its user up, checked the device's revocation and wrote last_seen_at: three
// statements prepared afresh, one a write. Now the statements are prepared once per handle and
// last_seen_at is written at most once a minute per device (or when its client string changes);
// the user and revocation stay live reads, so nothing about the auth answer is cached.
// On the old code: 50 requests are 50 UPDATEs and 147 re-prepares after the first; a client-less or
// same-client request inside the minute writes; a late touch after revocation writes the row.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-device-hot-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const SECRET = process.env.JWT_SECRET;
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const handle = sqlite.getDb();
// Installed before anything prepares, so every statement the hot path prepares is counted.
const c = sqlCount(handle);
const db = load('db');
const auth = load('auth');
const deviceAuth = load('services/deviceAuth');

const HOT = /SELECT data FROM app_users WHERE id = \?|SELECT revoked_at FROM devices WHERE id = \?|UPDATE devices SET last_seen_at/;
const TOUCH = /UPDATE devices SET last_seen_at/;
const CLIENT_A = 'PigTV/84 (tvOS 26.1; AppleTV14,1)';
const CLIENT_B = 'PigTV/85 (tvOS 26.1; AppleTV14,1)';

let app, owner;

before(async () => {
    owner = await db.users.create({ username: 'owner', passwordHash: await auth.hashPassword('correct horse'), role: 'admin' });
    const a = express();
    a.use(express.json());
    // A media route behind the real streamAuth, answering with the user it let in.
    a.get('/api/transcode/:id/:file', auth.streamAuth, (req, res) => res.json(req.user));
    a.use('/api/devices', load('routes/devices'));
    auth.configureJwtStrategy(async (id) => db.users.getById(id));
    const server = a.listen(0, '127.0.0.1');
    await once(server, 'listening');
    app = { server, base: `http://127.0.0.1:${server.address().port}` };
});

after(() => {
    deviceAuth._setClock?.();
    app?.server.closeAllConnections?.();
    app?.server.close();
    c.restore();
    try { handle.close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
function addDevice(id, userId = owner.id) {
    const t = Date.now() - 1000;
    handle.prepare('INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, String(userId), 'TV', 'tvos', t, t);
}
const row = id => handle.prepare('SELECT last_seen_at, revoked_at, app_client FROM devices WHERE id = ?').get(id);
const deviceToken = (user, deviceId) => jwt.sign({ id: user.id, username: user.username, role: user.role, deviceId }, SECRET);
const media = (token, client) => fetch(`${app.base}/api/transcode/live1/seg0001.ts?token=${encodeURIComponent(token)}`,
    { headers: client ? { 'X-PigTV-Client': client } : {} });
const totalChanges = () => handle.prepare('SELECT total_changes() AS n').get().n;

test('50 media requests from one device: one write, and no statement prepared again after the first', async () => {
    addDevice('hot1');
    const token = deviceToken(owner, 'hot1');
    c.reset();
    assert.equal((await media(token, CLIENT_A)).status, 200);
    const firstWrites = c.runs(TOUCH);
    c.reset();
    for (let i = 0; i < 49; i++) assert.equal((await media(token, CLIENT_A)).status, 200);
    const writes = firstWrites + c.runs(TOUCH);
    const prepares = c.prepares(HOT);
    const counted = `UPDATE devices ran ${writes} times for 50 requests; ${prepares} hot-path statements prepared again after the first`;
    assert.ok(writes <= 1 && prepares === 0, counted);
    assert.ok(writes <= 1, `UPDATE devices ran ${writes} times for 50 requests`);
    assert.equal(prepares, 0, `${prepares} hot-path statements prepared again after the first request`);
    // And nothing is cached about the answer: the user and the device are read on every request.
    assert.equal(c.gets(/SELECT data FROM app_users WHERE id = \?/), 49, 'the user is read live every time');
    assert.equal(c.gets(/SELECT revoked_at FROM devices WHERE id = \?/), 49, 'the revocation is read live every time');
});

test('revoked through the route: the very next request is a 401, and the row keeps the last request', async () => {
    addDevice('rev1');
    const token = deviceToken(owner, 'rev1');
    assert.equal((await media(token)).status, 200);
    await sleep(20);
    const t2 = Date.now();
    assert.equal((await media(token)).status, 200);
    const del = await fetch(`${app.base}/api/devices/rev1`, { method: 'DELETE', headers: { Authorization: `Bearer ${auth.generateToken(owner)}` } });
    assert.equal(del.status, 200);
    assert.equal((await media(token)).status, 401);
    assert.equal((await media(token)).status, 401);
    assert.ok(row('rev1').last_seen_at >= t2, 'the last request before revocation was flushed to the row');
    assert.ok(row('rev1').revoked_at);
});

test('revoked by raw SQL behind the module\'s back: the very next request is a 401', async () => {
    addDevice('rev2');
    const token = deviceToken(owner, 'rev2');
    for (let i = 0; i < 3; i++) assert.equal((await media(token)).status, 200);
    handle.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), 'rev2');
    assert.equal((await media(token)).status, 401);
    // A row deleted outright is refused too.
    addDevice('gone1');
    const goneToken = deviceToken(owner, 'gone1');
    assert.equal((await media(goneToken)).status, 200);
    handle.prepare('DELETE FROM devices WHERE id = ?').run('gone1');
    assert.equal((await media(goneToken)).status, 401);
});

test('a user changed or deleted is seen on the very next request', async () => {
    const temp = await db.users.create({ username: 'temp', passwordHash: await auth.hashPassword('a-long-password'), role: 'viewer' });
    addDevice('usr1', temp.id);
    const token = deviceToken(temp, 'usr1'); // the token says viewer for good
    let r = await media(token);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).role, 'viewer');
    await db.users.update(temp.id, { role: 'admin' });
    r = await media(token);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).role, 'admin', 'the role is the store\'s, read on this request');
    await db.users.update(temp.id, { role: 'viewer' });
    assert.equal((await (await media(token)).json()).role, 'viewer');
    await db.users.delete(temp.id);
    assert.equal((await media(token)).status, 401);
});

test('listDevices right after a request shows that request, inside the minute, as the usual integer milliseconds', async () => {
    addDevice('seen1');
    const token = deviceToken(owner, 'seen1');
    assert.equal((await media(token)).status, 200);
    await sleep(25);
    const t = Date.now();
    assert.equal((await media(token)).status, 200);
    const listed = deviceAuth.listDevices(owner.id).find(d => d.id === 'seen1');
    assert.ok(Number.isInteger(listed.last_seen_at), `last_seen_at ${typeof listed.last_seen_at}`);
    assert.ok(listed.last_seen_at >= t && listed.last_seen_at <= Date.now(), 'the latest request, not the first');
    // The route the web app reads says the same.
    await sleep(10);
    const t3 = Date.now();
    assert.equal((await media(token)).status, 200);
    const viaRoute = (await (await fetch(`${app.base}/api/devices`, { headers: { Authorization: `Bearer ${auth.generateToken(owner)}` } })).json())
        .find(d => d.id === 'seen1');
    assert.ok(viaRoute.last_seen_at >= t3);
});

test('a changed client string is written at once; an empty one keeps it and writes nothing', async () => {
    addDevice('cli1');
    const token = deviceToken(owner, 'cli1');
    assert.equal((await media(token, CLIENT_A)).status, 200);
    assert.equal(row('cli1').app_client, CLIENT_A);
    c.reset();
    assert.equal((await media(token, CLIENT_B)).status, 200);
    assert.equal(c.runs(TOUCH), 1, 'a new client string is written inside the minute');
    assert.equal(row('cli1').app_client, CLIENT_B);
    c.reset();
    assert.equal((await media(token)).status, 200);
    assert.equal((await media(token, CLIENT_B)).status, 200);
    assert.equal(c.runs(TOUCH), 0, `no client, or the same one, inside the minute: ${c.runs(TOUCH)} writes`);
    assert.equal(row('cli1').app_client, CLIENT_B, 'a request without a client does not wipe it');
    assert.equal(deviceAuth.listDevices(owner.id).find(d => d.id === 'cli1').app.build, '85');
});

test('a minute after its last write, the next touch writes once more', async () => {
    let now = Date.now() + 10 * 60 * 1000;
    deviceAuth._setClock?.(() => now);
    try {
        addDevice('clk1');
        const token = deviceToken(owner, 'clk1');
        c.reset();
        assert.equal((await media(token)).status, 200);
        assert.equal(c.runs(TOUCH), 1, 'the first touch writes');
        now += 30_000;
        assert.equal((await media(token)).status, 200);
        now += 29_999;
        assert.equal((await media(token)).status, 200);
        assert.equal(c.runs(TOUCH), 1, `inside the minute: ${c.runs(TOUCH)} writes`);
        now += 1;
        assert.equal((await media(token)).status, 200);
        assert.equal(c.runs(TOUCH), 2, 'a minute on, one more write');
        assert.equal(row('clk1').last_seen_at, now);
    } finally {
        deviceAuth._setClock?.();
    }
});

test('after revocation a late touch writes nothing, nor does a later flush', async () => {
    addDevice('late1');
    const token = deviceToken(owner, 'late1');
    assert.equal((await media(token, CLIENT_A)).status, 200);
    assert.equal(deviceAuth.revokeDevice(owner.id, 'late1'), true);
    const before = row('late1');
    await sleep(5);
    const changes = totalChanges();
    deviceAuth.touchDevice('late1', CLIENT_B); // a request that passed isDeviceValid just before the revocation
    deviceAuth.flushPending?.();
    assert.equal(totalChanges() - changes, 0, 'no row was written');
    assert.deepEqual(row('late1'), before);
});

test('#300: deleting a user removes their devices, and only theirs; their device token stays refused', async () => {
    const gone = await db.users.create({ username: 'leaver', passwordHash: await auth.hashPassword('a-long-password'), role: 'viewer' });
    const stays = await db.users.create({ username: 'stayer', passwordHash: await auth.hashPassword('a-long-password'), role: 'viewer' });
    addDevice('del1', gone.id);
    addDevice('del2', gone.id);
    addDevice('keep1', stays.id);
    const goneToken = deviceToken(gone, 'del1');
    const keepToken = deviceToken(stays, 'keep1');
    assert.equal((await media(goneToken)).status, 200); // leaves a pending last-seen entry
    assert.equal((await media(keepToken)).status, 200);
    await db.users.delete(gone.id);
    const left = handle.prepare('SELECT id FROM devices WHERE user_id = ?');
    assert.deepEqual(left.all(String(gone.id)), [], 'no device row of the deleted user remains');
    assert.deepEqual(left.all(String(stays.id)).map(r => r.id), ['keep1'], 'another user\'s device is untouched');
    assert.equal(deviceAuth.isDeviceValid('del1'), false);
    assert.equal((await media(goneToken)).status, 401, 'the deleted user\'s device token is refused');
    assert.equal((await media(keepToken)).status, 200, 'the other user\'s still works');
    deviceAuth.flushPending();
    assert.equal(row('del1'), undefined, 'a pending last-seen flush does not bring the row back');
});

test('flushPending is safe with nothing to do, and at shutdown after the handle closes (runs last)', async () => {
    assert.equal(typeof deviceAuth.flushPending, 'function');
    assert.doesNotThrow(() => deviceAuth.flushPending());
    addDevice('shut1');
    const token = deviceToken(owner, 'shut1');
    assert.equal((await media(token)).status, 200);
    await sleep(5);
    assert.equal((await media(token)).status, 200); // pending in memory
    handle.close();
    assert.doesNotThrow(() => deviceAuth.flushPending());
    assert.doesNotThrow(() => deviceAuth.touchDevice('shut1', CLIENT_A));
});
