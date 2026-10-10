const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0207: failed/missed schedules can be deleted (with their failed recordings and files), and
// each login has its own resume position per recording. Same sandbox as recordings-async-io.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-delpos-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const auth = load('auth');
const { scheduled, recordings } = load('db/recordingsDb');

let server, base, tokenA, tokenB, deviceToken, dir;

async function request(method, route, token, body) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
}

before(async () => {
    dir = path.join(sandbox, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const a = await db.users.create({ username: 'alice', role: 'admin', passwordHash: await auth.hashPassword('alice-password') });
    const b = await db.users.create({ username: 'bob', role: 'user', passwordHash: await auth.hashPassword('bob-password') });
    tokenA = auth.generateToken(a);
    tokenB = auth.generateToken(b);
    // A paired Apple TV: a device token names the user who approved the pairing.
    const deviceAuth = load('services/deviceAuth');
    const pairing = deviceAuth.approvePairing(
        (() => { const c = 'TESTCODE'; sqlite.getDb().prepare('INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)').run(c, Date.now(), Date.now() + 60000); return c; })(),
        a, { name: 'Living room', platform: 'tvos' });
    deviceToken = require('jsonwebtoken').sign({ id: a.id, username: a.username, role: a.role, deviceId: pairing.deviceId }, load('authSecret'), { expiresIn: '1h' });

    const app = express();
    app.use(express.json());
    app.use('/api/recordings', load('routes/recordings'));
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

let n = 0;
function makeSchedule(status) {
    const s = scheduled.create({ title: `Show ${++n}`, description: null, source_id: 1, channel_item_id: 'x', channel_name: 'ABC',
        channel_logo: null, program_start: Date.now() - 7200e3, program_end: Date.now() - 3600e3, pre_buffer_min: 0,
        post_buffer_min: 0, created_by: 1, created_at: Date.now() });
    return scheduled.setStatus(s.id, status, { error: 'boom' });
}
function makeRecording({ scheduleId = null, status = 'completed', durationSec = 1800, withFile = true, part = 1 } = {}) {
    const file = path.join(dir, `rec-${++n}.ts`);
    if (withFile) fs.writeFileSync(file, 'x'.repeat(2048));
    const r = recordings.create({ scheduled_id: scheduleId, title: `Rec ${n}`, channel_name: 'ABC', channel_logo: '/api/logo/abc',
        source_id: 1, channel_item_id: 'x', file_path: file, started_at: Date.now() - 3600e3, part });
    recordings.finish(r.id, { status, ended_at: Date.now(), file_size_bytes: 2048, duration_sec: durationSec, error: status === 'failed' ? 'bad' : null });
    return { id: r.id, file };
}

// ---- deleting failed things -------------------------------------------------

test('a failed recording whose file is already gone deletes cleanly', async () => {
    const r = makeRecording({ status: 'failed', withFile: false });
    const res = await request('DELETE', `/api/recordings/${r.id}`, tokenA);
    assert.equal(res.status, 200);
    assert.equal(recordings.getById(r.id), null);
});

test('deleting a failed schedule removes its failed recordings and their files, and keeps a completed part', async () => {
    const s = makeSchedule('failed');
    const failed = makeRecording({ scheduleId: s.id, status: 'failed', part: 2 });
    const done = makeRecording({ scheduleId: s.id, status: 'completed', part: 1 });
    const res = await request('DELETE', `/api/recordings/scheduled/${s.id}`, tokenA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { deleted: true });
    assert.equal(scheduled.getById(s.id), null);
    assert.equal(recordings.getById(failed.id), null);
    assert.ok(!fs.existsSync(failed.file), 'the partial file is gone');
    assert.ok(recordings.getById(done.id), 'the completed part stays');
    assert.ok(fs.existsSync(done.file));
});

test('deleting a missed schedule removes it', async () => {
    const s = makeSchedule('missed');
    const res = await request('DELETE', `/api/recordings/scheduled/${s.id}`, tokenA);
    assert.deepEqual(res.data, { deleted: true });
    assert.equal(scheduled.getById(s.id), null);
});

test('cancelling an upcoming schedule is unchanged: it stays, marked cancelled', async () => {
    const s = makeSchedule('scheduled');
    const res = await request('DELETE', `/api/recordings/scheduled/${s.id}`, tokenA);
    assert.equal(res.status, 200);
    assert.equal(res.data.id, s.id);
    assert.equal(res.data.status, 'cancelled');
    assert.ok(scheduled.getById(s.id));
});

// ---- resume position ----------------------------------------------------------

test('no position yet: zeros, and 404 for a recording that does not exist', async () => {
    const r = makeRecording();
    const res = await request('GET', `/api/recordings/${r.id}/position`, tokenA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { position_sec: 0, watched: false, updated_at: null });
    assert.equal((await request('GET', '/api/recordings/999999/position', tokenA)).status, 404);
    assert.equal((await request('PUT', '/api/recordings/999999/position', tokenA, { position_sec: 5 })).status, 404);
});

test('a saved position is returned, and last write wins', async () => {
    const r = makeRecording();
    const put = await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 120.5 });
    assert.equal(put.status, 200);
    assert.equal(put.data.position_sec, 120.5);
    assert.equal(put.data.watched, false);
    assert.equal(typeof put.data.updated_at, 'number');
    await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 300 });
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, tokenA)).data.position_sec, 300);
});

test('watched threshold: min(10 min, 5%) from the end', async () => {
    const long = makeRecording({ durationSec: 4 * 3600 });
    const half = makeRecording({ durationSec: 1800 });
    const put = (id, pos) => request('PUT', `/api/recordings/${id}/position`, tokenA, { position_sec: pos });
    assert.equal((await put(long.id, 4 * 3600 - 600)).data.watched, true, '4 h with 10 min left');
    assert.equal((await put(long.id, 4 * 3600 - 601)).data.watched, false, '4 h with just over 10 min left');
    assert.equal((await put(half.id, 1800 - 120)).data.watched, false, '30 min with 2 min left');
    assert.equal((await put(half.id, 1800 - 60)).data.watched, true, '30 min with 1 min left');
    const unknown = makeRecording({ durationSec: 0 });
    assert.equal((await put(unknown.id, 50)).data.watched, false, 'unknown length is never watched');
});

test('watched can be forced, e.g. mark unwatched', async () => {
    const r = makeRecording();
    assert.equal((await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 10, watched: true })).data.watched, true);
    const back = await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 0, watched: false });
    assert.deepEqual({ p: back.data.position_sec, w: back.data.watched }, { p: 0, w: false });
});

test('invalid positions are refused', async () => {
    const r = makeRecording();
    for (const body of [{}, { position_sec: -1 }, { position_sec: '5' }, { position_sec: null }, { position_sec: 1e999 }, { position_sec: 5, watched: 'yes' }]) {
        const res = await request('PUT', `/api/recordings/${r.id}/position`, tokenA, body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, tokenA)).data.updated_at, null, 'nothing stored');
});

test('positions are per login, and a paired device shares its login\'s', async () => {
    const r = makeRecording();
    await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 77 });
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, tokenB)).data.position_sec, 0, 'another login sees none');
    await request('PUT', `/api/recordings/${r.id}/position`, tokenB, { position_sec: 5 });
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, tokenA)).data.position_sec, 77, 'and does not overwrite it');
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, deviceToken)).data.position_sec, 77, 'the TV is the same login');
    await request('PUT', `/api/recordings/${r.id}/position`, deviceToken, { position_sec: 90 });
    assert.equal((await request('GET', `/api/recordings/${r.id}/position`, tokenA)).data.position_sec, 90);
});

test('the library list carries this login\'s position and watched, and keeps channel_logo', async () => {
    const r = makeRecording({ durationSec: 1000 });
    await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 400 });
    const mine = (await request('GET', '/api/recordings', tokenA)).data.find(x => x.id === r.id);
    assert.equal(mine.position_sec, 400);
    assert.equal(mine.watched, false);
    assert.equal(mine.channel_logo, '/api/logo/abc');
    const theirs = (await request('GET', '/api/recordings', tokenB)).data.find(x => x.id === r.id);
    assert.equal(theirs.position_sec, 0);
    assert.equal(theirs.watched, false);
    await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 990 });
    assert.equal((await request('GET', '/api/recordings', tokenA)).data.find(x => x.id === r.id).watched, true);
});

test('deleting a recording deletes its positions', async () => {
    const r = makeRecording();
    await request('PUT', `/api/recordings/${r.id}/position`, tokenA, { position_sec: 10 });
    await request('PUT', `/api/recordings/${r.id}/position`, tokenB, { position_sec: 20 });
    await request('DELETE', `/api/recordings/${r.id}`, tokenA);
    const left = sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM recording_positions WHERE recording_id = ?').get(r.id).n;
    assert.equal(left, 0);
});

test('/api/info advertises recordingPositions', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '../server/routes/info.js'), 'utf8'), /recordingPositions: true/);
});
