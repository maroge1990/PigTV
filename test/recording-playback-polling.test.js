const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// The real recordings and info routers over a real database, with ffmpeg / ffprobe stood in for
// (so this needs neither). A copy of the server keeps its data/ folder away from the real one
// (same approach as native-playback.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-recpoll-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json')); // routes/info.js reads it
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const auth = load('auth');
const db = load('db');
const sqlite = load('db/sqlite');
const { recordings, initSchema } = load('db/recordingsDb');
initSchema();

const dir = path.join(sandbox, 'recordings');
fs.mkdirSync(dir, { recursive: true });

const calls = { ffmpeg: 0 };
let behaviour;
beforeEach(() => {
    calls.ffmpeg = 0;
    behaviour = { delayMs: 20, exitCode: 0 };
    engine._nativeTools.startGraceMs = 1500; // the real value unless a test shortens it
    engine._nativeTools.codecs = async () => ({ video: 'h264', audio: 'aac' });
    engine._nativeTools.duration = async () => 60;
    engine._nativeTools.ffmpeg = async (args) => {
        calls.ffmpeg++;
        const out = args[args.length - 1];
        fs.writeFileSync(out, 'work in progress');
        await new Promise(r => setTimeout(r, behaviour.delayMs));
        if (behaviour.exitCode === 0) fs.writeFileSync(out, 'remuxed');
        return { code: behaviour.exitCode, tail: behaviour.exitCode ? [`Error muxing a packet writing ${out}`] : [] };
    };
});

let n = 0;
function makeRecording({ completed = true, createFile = true } = {}) {
    const base = `Show ${++n} - 2026-09-19 19-30`;
    const file = path.join(dir, `${base}.mkv`);
    if (createFile) fs.writeFileSync(file, 'mkv-bytes');
    const row = recordings.create({ scheduled_id: n, title: `Show ${n}`, channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() });
    if (completed) recordings.finish(row.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 9, duration_sec: 3600 });
    return { id: row.id, file };
}

let server, base, token;
before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // loading it is what registers the JWT strategy
    app.use('/api/recordings', load('routes/recordings'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function get(route, { withToken = true } = {}) {
    const response = await fetch(`${base}${route}`, { headers: withToken ? { Authorization: `Bearer ${token}` } : {} });
    let body = null;
    try { body = await response.json(); } catch { /* no body */ }
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('without ?async the request still waits for the remux and answers 200 - existing clients are unchanged', async () => {
    const r = makeRecording();
    behaviour.delayMs = 120;
    const res = await get(`/api/recordings/${r.id}/playback`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { url: `/api/recordings/${r.id}/media.mp4`, container: 'mp4', durationSec: 3600 });
    assert.equal(calls.ffmpeg, 1);
});

test('?async=1 on a recording that is quick to prepare answers 200 straight away', async () => {
    const r = makeRecording();
    const res = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(res.status, 200, 'inside the grace period, so the client is not sent round again');
    assert.equal(res.body.url, `/api/recordings/${r.id}/media.mp4`);
    assert.equal(calls.ffmpeg, 1);
});

test('?async=1 on one that takes a while answers 202 preparing, and the client can keep asking until it is ready', async () => {
    const r = makeRecording();
    engine._nativeTools.startGraceMs = 30;
    behaviour.delayMs = 400;

    const first = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { status: 'preparing', retryAfterSec: 3 });
    assert.equal(first.retryAfter, '3');

    const second = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(second.status, 202, 'still working');
    assert.equal(calls.ffmpeg, 1, 'asking again does not start another remux');

    await wait(500);
    const done = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(done.status, 200);
    assert.equal(done.body.container, 'mp4');
    assert.equal(calls.ffmpeg, 1);
});

test('a recording that has been prepared before is ready immediately, with no ffmpeg at all', async () => {
    const r = makeRecording();
    await get(`/api/recordings/${r.id}/playback?async=1`);
    const before = calls.ffmpeg;
    const again = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(again.status, 200);
    assert.equal(calls.ffmpeg, before);
});

test('two clients asking at once share one remux', async () => {
    const r = makeRecording();
    engine._nativeTools.startGraceMs = 30;
    behaviour.delayMs = 300;
    const [a, b] = await Promise.all([get(`/api/recordings/${r.id}/playback?async=1`), get(`/api/recordings/${r.id}/playback?async=1`)]);
    assert.deepEqual([a.status, b.status], [202, 202]);
    assert.equal(calls.ffmpeg, 1);
});

test('a remux that fails is reported once, without paths or ffmpeg output - and asking again starts afresh', async () => {
    const r = makeRecording();
    behaviour.exitCode = 1;
    const first = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(first.status, 500);
    assert.deepEqual(first.body, { status: 'failed', reason: 'remux-failed', error: 'The server could not prepare this recording for playback' });
    assert.ok(!JSON.stringify(first.body).includes(dir) && !JSON.stringify(first.body).includes('muxing'), 'nothing internal in what a client is shown');
    assert.equal(calls.ffmpeg, 1);

    behaviour.exitCode = 0; // the cause has gone away (space freed, share back)
    const retry = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(retry.status, 200, 'the failure was reported once, not remembered against the recording');
    assert.equal(calls.ffmpeg, 2);
});

test('a recording whose file has gone missing says so, distinctly', async () => {
    const r = makeRecording({ createFile: false });
    const res = await get(`/api/recordings/${r.id}/playback?async=1`);
    assert.equal(res.status, 500);
    assert.equal(res.body.reason, 'file-missing');
    assert.equal(calls.ffmpeg, 0);
});

test('the checks that were there before still apply: unfinished 409, unknown 404, no token 401', async () => {
    const unfinished = makeRecording({ completed: false });
    assert.equal((await get(`/api/recordings/${unfinished.id}/playback?async=1`)).status, 409);
    assert.equal((await get('/api/recordings/999999/playback?async=1')).status, 404);
    const r = makeRecording();
    assert.equal((await get(`/api/recordings/${r.id}/playback?async=1`, { withToken: false })).status, 401);
});

test('/api/info advertises what a client can now rely on, as flags it can ask for', async () => {
    const info = await get('/api/info', { withToken: false });
    assert.equal(info.status, 200);
    for (const flag of ['recordingPlaybackPolling', 'scheduledWaiting', 'viewerConflict', 'epgLogoFallback', 'clientEvents']) {
        assert.equal(info.body.features[flag], true, flag);
    }
    // and the flags a client already reads are still there
    for (const flag of ['playbackResolve', 'library', 'guide', 'devicePairing', 'recordings', 'streamCoordination', 'streamTokenAuth']) {
        assert.equal(info.body.features[flag], true, flag);
    }
});
