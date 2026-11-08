const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #49 (0444, C-M): "Change recording": PUT /api/recordings/scheduled/:id changes a schedule's start-early / finish-late
// minutes. The real engine and routes over a sandboxed database; ffmpeg is a node script that writes until told "q".
// On 0443 there was no such route: a second POST /recordings/schedule answered the existing schedule unchanged.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sched-edit-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const auth = load('auth');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const { scheduled } = load('db/recordingsDb');
const OVERRUN_MAX = load('services/sportOverrun').OVERRUN_MAX;

const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(out, Buffer.alloc(4000));
setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(0); });
`);
fs.chmodSync(FFMPEG, 0o755);

const realConsole = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIN = 60000, H = 60 * MIN;
let A, server, base, tokenA, deviceToken;

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
const put = (id, body, token = tokenA) => request('PUT', `/api/recordings/scheduled/${id}`, token, body);

before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Fake', url: 'http://fake.invalid/get.php?username=u&password=p' });
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, tvg_id, stream_url)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 0, 1, 's1', 'footy.au', 'http://fake.invalid/live/u/p/1.ts')`).run(`${A.id}:pos_1`, A.id);
    // 0494: recordings are segmented by default; these tests cover the part-based (.ts) path, so they ask for it.
    await db.settings.update({ segmentedRecordings: false, recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown(); // the test drives tick() itself

    const a = await db.users.create({ username: 'alice', role: 'admin', passwordHash: await auth.hashPassword('alice-password') });
    const b = await db.users.create({ username: 'bob', role: 'user', passwordHash: await auth.hashPassword('bob-password') });
    tokenA = auth.generateToken(b); // an ordinary user: schedules are the household's (as DELETE)
    const deviceAuth = load('services/deviceAuth');
    const code = 'TESTCODE';
    sqlite.getDb().prepare('INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)').run(code, Date.now(), Date.now() + 60000);
    const pairing = deviceAuth.approvePairing(code, a, { name: 'Living room', platform: 'tvos' });
    deviceToken = require('jsonwebtoken').sign({ id: a.id, username: a.username, role: a.role, deviceId: pairing.deviceId }, load('authSecret'), { expiresIn: '1h' });

    const app = express();
    app.use(express.json());
    app.use('/api/recordings', load('routes/recordings'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await engine.stopAllActive(3000);
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    Object.assign(console, realConsole);
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function schedule({ start, end, pre = 0, post = 0, title = `Show ${++n}`, createdBy = 1 }) {
    return scheduled.create({ title, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's1',
        channel_name: 'Fox Footy', channel_logo: null, program_start: start, program_end: end,
        pre_buffer_min: pre, post_buffer_min: post, created_by: createdBy, created_at: Date.now() + n++ });
}
async function untilRecording(id) {
    for (let i = 0; i < 50 && scheduled.getById(id).status !== 'recording'; i++) { await engine.tick(); await sleep(40); }
    assert.equal(scheduled.getById(id).status, 'recording');
}
const listed = async (id) => (await request('GET', '/api/recordings/scheduled', tokenA)).data.find(r => r.id === id);

test('not started: both change, the answer is the row as listed, and the engine starts at the new start', async () => {
    const now = Date.now();
    const s = schedule({ start: now + 20 * MIN, end: now + 80 * MIN, pre: 1, post: 5 });
    assert.equal(scheduled.findDueToStart(now).some(r => r.id === s.id), false);

    const res = await put(s.id, { preBufferMin: 30, postBufferMin: 15 });
    assert.equal(res.status, 200);
    assert.equal(res.data.pre_buffer_min, 30);
    assert.equal(res.data.post_buffer_min, 15);
    assert.equal(res.data.stopsAt, now + 80 * MIN + 15 * MIN, 'the stop is worked out from the new finish-late');
    assert.deepEqual(res.data, await listed(s.id), 'same shape as a GET /scheduled element');
    assert.equal(engine._stopTimeOf(scheduled.getById(s.id)), now + 95 * MIN);

    // 30 min early from 20 min away: due now, and the engine starts it.
    await untilRecording(s.id);
    await engine.cancelScheduled(s.id);
});

test('only the field sent changes; a waiting schedule has not started and may change too', async () => {
    const now = Date.now();
    const s = schedule({ start: now + H, end: now + 2 * H, pre: 2, post: 7 });
    let res = await put(s.id, { postBufferMin: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.pre_buffer_min, res.data.post_buffer_min], [2, 0]);
    scheduled.setStatus(s.id, 'waiting', { error: 'Another recording is using the recording slot.' });
    res = await put(s.id, { preBufferMin: 10 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.pre_buffer_min, res.data.post_buffer_min], [10, 0]);
    scheduled.setStatus(s.id, 'cancelled');
});

test('recording: a shorter finish-late stops it at the new stop (the hard stop is re-armed)', async () => {
    const now = Date.now();
    // Guide end 58.5 s ago: with 2 min late it stops in ~61.5 s, with 1 min in ~1.5 s.
    const s = schedule({ start: now - 2 * MIN, end: now - 58500, post: 2 });
    await untilRecording(s.id);
    const res = await put(s.id, { postBufferMin: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.data.post_buffer_min, 1);
    assert.equal(res.data.status, 'recording');
    for (let i = 0; i < 80 && scheduled.getById(s.id).status === 'recording'; i++) await sleep(50); // no tick
    assert.equal(scheduled.getById(s.id).status, 'completed', 'stopped at the new stop, not the old one a minute later');
});

test('recording: a longer finish-late keeps it recording past the old stop', async () => {
    const now = Date.now();
    const s = schedule({ start: now - 1000, end: now + 1200, post: 0 });
    await untilRecording(s.id);
    const res = await put(s.id, { postBufferMin: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.data.stopsAt, s.program_end + MIN);
    await sleep(2500);
    assert.equal(scheduled.getById(s.id).status, 'recording', 'still recording past the old stop');
    await engine.cancelScheduled(s.id);
});

test('recording: a stop at or before now is refused (409), and so is any start-early in the body', async () => {
    const now = Date.now();
    const s = schedule({ start: now - 5 * MIN, end: now - 30000, post: 2 });
    await untilRecording(s.id);
    let res = await put(s.id, { postBufferMin: 0 });
    assert.equal(res.status, 409);
    assert.equal(scheduled.getById(s.id).post_buffer_min, 2, 'unchanged');
    res = await put(s.id, { preBufferMin: 3 });
    assert.equal(res.status, 409);
    res = await put(s.id, { preBufferMin: 0, postBufferMin: 5 });
    assert.equal(res.status, 409, 'start-early in the body at all');
    assert.deepEqual([scheduled.getById(s.id).pre_buffer_min, scheduled.getById(s.id).post_buffer_min], [0, 2]);
    await engine.cancelScheduled(s.id);
});

test('finished, failed, cancelled, missed and unknown schedules are 404', async () => {
    const now = Date.now();
    for (const status of ['completed', 'failed', 'cancelled', 'missed']) {
        const s = schedule({ start: now + H, end: now + 2 * H });
        scheduled.setStatus(s.id, status);
        const res = await put(s.id, { postBufferMin: 3 });
        assert.equal(res.status, 404, status);
        assert.equal(scheduled.getById(s.id).post_buffer_min, 0);
    }
    assert.equal((await put(999999, { postBufferMin: 3 })).status, 404);
    assert.equal((await put('abc', { postBufferMin: 3 })).status, 404);
    const gone = schedule({ start: now + H, end: now + 2 * H });
    scheduled.delete(gone.id);
    assert.equal((await put(gone.id, { postBufferMin: 3 })).status, 404);
});

test('bad values are 400, as a rule\'s: whole minutes, start early 0-60, finish late 0-180', async () => {
    const now = Date.now();
    const s = schedule({ start: now + H, end: now + 2 * H, pre: 1, post: 5 });
    for (const body of [{ preBufferMin: -1 }, { preBufferMin: 61 }, { postBufferMin: 181 }, { postBufferMin: 1.5 },
        { postBufferMin: '5' }, { preBufferMin: true }, { postBufferMin: -5 }, { preBufferMin: 5, postBufferMin: 'x' }]) {
        const res = await put(s.id, body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual([scheduled.getById(s.id).pre_buffer_min, scheduled.getById(s.id).post_buffer_min], [1, 5]);
    assert.equal((await put(s.id, { preBufferMin: 60, postBufferMin: 180 })).status, 200, 'the limits themselves');
    scheduled.setStatus(s.id, 'cancelled');
});

test('household schedules: any signed-in user or paired device may change one (as DELETE); no token is 401', async () => {
    const now = Date.now();
    const s = schedule({ start: now + H, end: now + 2 * H, createdBy: 12345 }); // made by someone else
    assert.equal((await put(s.id, { postBufferMin: 9 }, null)).status, 401);
    assert.equal(scheduled.getById(s.id).post_buffer_min, 0);
    assert.equal((await put(s.id, { postBufferMin: 9 }, tokenA)).status, 200);
    const res = await put(s.id, { postBufferMin: 11 }, deviceToken);
    assert.equal(res.status, 200);
    assert.equal(res.data.post_buffer_min, 11);
    scheduled.setStatus(s.id, 'cancelled');
});

test('a rule\'s schedule stays linked to its rule', async () => {
    const now = Date.now();
    const s = schedule({ start: now + H, end: now + 2 * H });
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET rule_id = 42 WHERE id = ?').run(s.id);
    const res = await put(s.id, { preBufferMin: 4, postBufferMin: 20 });
    assert.equal(res.status, 200);
    assert.equal(res.data.rule_id, 42);
    assert.equal(scheduled.getById(s.id).rule_id, 42);
    scheduled.setStatus(s.id, 'cancelled');
});

test('#217: a sport schedule\'s event stop stays capped at the guide end + new finish-late + 4 h', async () => {
    const now = Date.now();
    const s = schedule({ start: now - 30 * MIN, end: now + H, post: 5, title: 'AFL: Collingwood v Carlton' });
    scheduled.setStatus(s.id, 'recording'); // not captured: the stored stop is what is checked
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET sport_game_id = ?, event_stop = ? WHERE id = ?')
        .run('espn:afl:edit', now + 11 * H, s.id); // far past any cap
    let res = await put(s.id, { postBufferMin: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.data.stopsAt, now + H + 30 * MIN + OVERRUN_MAX, 'capped at the new guide end + 4 h');
    assert.equal(engine._stopTimeOf(scheduled.getById(s.id)), res.data.stopsAt, 'the stop the engine reads agrees');
    assert.equal(res.data.endsWith, 'event');
    assert.equal('event_stop' in res.data, false, 'the internal columns stay internal');
    assert.equal('sport_game_id' in res.data, false);
    assert.equal(scheduled.getById(s.id).sport_game_id, 'espn:afl:edit', 'still linked to its game');

    // An event stop inside the cap: shortening finish-late does not cut the game off.
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET event_stop = ? WHERE id = ?').run(now + 3 * H, s.id);
    res = await put(s.id, { postBufferMin: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.data.stopsAt, now + 3 * H);
    scheduled.setStatus(s.id, 'cancelled');
});
