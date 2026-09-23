const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0104: how an HLS session ends, when it retries, and what it will open.
// Sandbox copy of the server, as in hls-finite-source.test.js; ffmpeg is played by
// node running a one-line script, as in stall-watchdog.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-hardening-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const transcodeSession = load('services/transcodeSession');
const { isStreamUrl } = load('services/streamUrl');
const { probeStream } = load('services/streamProbe');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_ = 'http://provider.invalid/live/u/p/1.ts';

// A session whose "ffmpeg" runs `script`; `vaapi` makes it build its arguments the
// way a GPU-decoding encode does, which is what the software-decode retry keys on.
async function fakeSession(script, options = {}, { vaapi = false } = {}) {
    const s = await transcodeSession.createSession(URL_, { ffmpegPath: process.execPath, live: true, stallMs: 60000, startupMs: 60000, ...options });
    s.buildFFmpegArgs = function () {
        if (vaapi) this.addHwAccelInputArgs([], 'vaapi');
        return ['-e', script];
    };
    return s;
}
const exited = (s) => new Promise((resolve) => s.once('exit', resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Generous on purpose: CI runs every test file at once on two vCPUs (see 0101).
async function until(cond, ms = 5000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); }

// ---- how a session ends ----

test('an ffmpeg that exits 255 on its own leaves the session in error, not "running"', async () => {
    const s = await fakeSession('process.exit(255)');
    await s.start();
    await exited(s);
    assert.equal(s.status, 'error', 'it used to stay "running" with no ffmpeg behind it');
    assert.match(s.error, /exited with code 255/);
    await transcodeSession.removeSession(s.id);
});

test('an ffmpeg killed by a signal nobody sent is an error too, not "completed successfully"', { skip: process.platform === 'win32' && 'signals are POSIX' }, async () => {
    const s = await fakeSession('process.kill(process.pid, "SIGKILL")');
    await s.start();
    await exited(s);
    assert.equal(s.status, 'error');
    assert.match(s.error, /killed \(SIGKILL\)/);
    await transcodeSession.removeSession(s.id);
});

test('a session we stop is "stopped", whatever exit code ffmpeg gives on the way out', async () => {
    const s = await fakeSession('process.on("SIGTERM", () => process.exit(255)); setInterval(() => {}, 1000)');
    await s.start();
    await sleep(200);
    await s.stop();
    assert.equal(s.status, 'stopped');
    await transcodeSession.removeSession(s.id);
});

// ---- the software-decode retry ----

async function starts(s) {
    let n = 0;
    const real = s.start.bind(s);
    s.start = (...a) => { n++; return real(...a); };
    await s.start();
    return () => n;
}

test('a stream copy that dies early is not restarted: it decodes nothing, so software decode cannot help', async () => {
    const s = await fakeSession('process.exit(1)', { videoMode: 'copy' });
    const count = await starts(s);
    await exited(s);
    await sleep(1000);
    assert.equal(count(), 1, 'one start only - the old code cleared the folder and started again');
    assert.equal(s.status, 'error');
    await transcodeSession.removeSession(s.id);
});

test('an encode that really decoded on the GPU and died before any playlist gets one software-decode retry', async () => {
    const s = await fakeSession('process.exit(1)', { videoMode: 'encode', hwEncoder: 'vaapi' }, { vaapi: true });
    const count = await starts(s);
    await exited(s);
    await until(() => count() === 2);
    assert.equal(count(), 2, 'retried once');
    assert.equal(s.options.vaapiHwDecode, false, 'with decode on the CPU');
    await sleep(1000);   // the retry fails the same way; it must not be retried again
    assert.equal(count(), 2, 'and only once');
    await transcodeSession.removeSession(s.id);
});

test('not once it has produced a playlist: a client may already be fetching from that folder', async () => {
    const s = await fakeSession('process.exit(1)', { videoMode: 'encode', hwEncoder: 'vaapi' }, { vaapi: true });
    s.timings.playlistReady = Date.now();
    const count = await starts(s);
    await exited(s);
    await sleep(1000);
    assert.equal(count(), 1);
    await transcodeSession.removeSession(s.id);
});

// ---- what a session will open ----

test('only network URLs are streams', () => {
    for (const ok of ['http://p/1.ts', 'https://p/1.m3u8', 'rtmp://p/live', 'rtsp://cam/1', 'udp://239.0.0.1:1234', 'srt://p:9000']) {
        assert.equal(isStreamUrl(ok), true, ok);
    }
    for (const bad of ['file:///etc/passwd', '/app/data/db.json', 'concat:/a|/b', 'pipe:0', 'data:video/mp4;base64,AAAA',
                       'subfile,,start,0,end,0,,:/etc/passwd', '', null, undefined, 42, 'not a url']) {
        assert.equal(isStreamUrl(bad), false, String(bad));
    }
});

test('a session will not hand ffmpeg a local file, and the probe will not open one', async () => {
    const s = await transcodeSession.createSession('file:///etc/passwd', { ffmpegPath: process.execPath });
    await assert.rejects(s.start(), /network stream URLs/);
    assert.equal(s.process, null, 'nothing was spawned');
    await transcodeSession.removeSession(s.id);
    await assert.rejects(probeStream('concat:/a|/b', 'ffprobe'), /network stream URLs/);
});

test('the routes that took a URL from the caller are gone (0122): only resolve starts a session', async () => {
    // POST /api/transcode/session, /api/probe and /api/subtitle each opened a caller-supplied
    // URL; they served only the movie/series page. resolve (which checks isStreamUrl above)
    // is now the one way in.
    const app = express();
    app.use(express.json());
    app.use('/api/transcode', load('routes/transcode'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const session = await fetch(`${base}/api/transcode/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'http://provider.invalid/live/u/p/1.ts' }) });
        assert.equal(session.status, 404, 'no route answers it');
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
    for (const gone of ['routes/probe.js', 'routes/subtitle.js']) {
        assert.equal(fs.existsSync(path.join(sandbox, 'server', gone)), false, gone);
    }
});

// ---- dead code ----

test('the recovery-metadata leftovers are gone: no session.json (it held the provider URL), no restore, no getOrCreateSession', async () => {
    assert.equal(transcodeSession.getOrCreateSession, undefined);
    assert.equal(transcodeSession.TranscodeSession.restore, undefined);
    const s = await fakeSession('setTimeout(() => {}, 300)');
    await s.start();
    assert.equal(fs.existsSync(path.join(s.dir, 'session.json')), false);
    await transcodeSession.removeSession(s.id);
});
