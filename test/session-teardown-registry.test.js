const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #350: a session ended by a stall or a timestamp loop left the session registry before ffmpeg had exited, so the
// coordinator stopped counting a provider connection that was still open (one-connection providers: a second stream
// admitted beside it). Every ending now leaves the registry only after the one shared teardown has awaited ffmpeg's exit,
// and once a teardown has started ffmpeg's late stderr no longer starts a timestamp-loop ending of its own.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-teardown-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const ts = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const sqlite = load('db/sqlite');

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const RECONNECT = '[http @ 0x1] Will reconnect at 90799524 in 0 second(s), error=Input/output error.';
const AUDIO_JUMP = '[aist#0:1/aac @ 0x2] timestamp discontinuity (stream id=257): -140478, new offset= -91889983655';
const tick = () => new Promise(r => setImmediate(r));

// The HLS routes, as a player polls them (no auth: a test app).
const express = require('express');
const { once } = require('node:events');
let hls = null;
async function hlsBase() {
    if (hls) return hls.base;
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', deviceId: 'tv' }; next(); });
    app.use('/api/transcode', load('routes/transcode'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    hls = { server, base: `http://127.0.0.1:${server.address().port}/api/transcode` };
    return hls.base;
}
after(() => { hls?.server.closeAllConnections?.(); hls?.server.close(); ts.stopCleanupInterval?.(); });

/** A registered live session that has played, whose ffmpeg takes its time to exit (`exit()` lets it). */
async function playing() {
    const s = await ts.createSession('http://provider.invalid/live/u/p/1.ts', { live: true, segmentType: 'fmp4', videoMode: 'copy', providerId: 1, owner: 'device:tv' });
    s.timings.playlistReady = Date.now();
    s.retainDir = true;
    const ctl = { stops: 0, exit: null };
    s.stop = () => { ctl.stops++; return new Promise((resolve) => { ctl.exit = resolve; }); };
    const lost = [];
    s.on('lost', (info) => lost.push(info));
    return { s, ctl, lost, counted: () => coordinator.activeStreams().some(x => x.id === s.id) };
}
async function untilStopping(ctl) {
    for (let i = 0; i < 200 && !ctl.exit; i++) await tick();
    assert.ok(ctl.exit, 'the teardown is waiting on ffmpeg');
}
function timestampLoop(s, t0 = Date.now()) {
    s.noteStderrLine(RECONNECT, t0);
    for (let i = 0; i < ts.TS_LOOP_LINES; i++) s.noteStderrLine(AUDIO_JUMP, t0 + 100 + i * 10);
}

test('a stalled session stays counted until ffmpeg has exited', async () => {
    const { s, ctl, lost, counted } = await playing();
    const ending = s.handleStall();
    await untilStopping(ctl);
    assert.deepEqual(lost.map(l => l.how), ['stall'], 'the player is told at once');
    assert.equal(counted(), true, 'its provider connection is still open: still counted');
    ctl.exit();
    await ending;
    assert.equal(counted(), false);
});

test('a session ended by a timestamp loop stays counted until ffmpeg has exited', async () => {
    const { s, ctl, lost, counted } = await playing();
    timestampLoop(s);
    await untilStopping(ctl);
    assert.deepEqual(lost.map(l => l.how), ['timestamps']);
    assert.equal(counted(), true);
    ctl.exit();
    for (let i = 0; i < 50 && counted(); i++) await tick();
    assert.equal(counted(), false);
});

test('once a teardown has started, ffmpeg\'s late timestamp warnings start no ending of their own', async () => {
    const { s, ctl, lost, counted } = await playing();
    const removing = ts.removeSession(s.id); // a replacement play: the session is being stopped
    await untilStopping(ctl);
    timestampLoop(s); // stderr still flowing while ffmpeg stops
    await tick();
    assert.deepEqual(lost, [], 'no loss for a session being stopped');
    assert.equal(counted(), true, 'nothing took it out of the registry early');
    assert.equal(ctl.stops, 1);
    ctl.exit();
    await removing;
    assert.equal(counted(), false);
});

test('a session that is ending answers its playlist as gone at once, while the coordinator still counts it until ffmpeg exits', async () => {
    const base = await hlsBase();
    for (const end of ['stall', 'timestamps']) {
        const { s, ctl, counted } = await playing();
        fs.mkdirSync(s.dir, { recursive: true });
        fs.writeFileSync(path.join(s.dir, 'stream.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0000.ts\n');
        fs.writeFileSync(path.join(s.dir, 'seg0000.ts'), Buffer.alloc(188));
        assert.equal((await fetch(`${base}/${s.id}/stream.m3u8`)).status, 200, 'playing: served');
        const ending = end === 'stall' ? s.handleStall() : (timestampLoop(s), null);
        await untilStopping(ctl);
        assert.equal(counted(), true, `${end}: still counted for admission`);
        assert.equal((await fetch(`${base}/${s.id}/stream.m3u8`)).status, 404, `${end}: the player is sent to recover now`);
        assert.equal((await fetch(`${base}/${s.id}/seg0000.ts`)).status, 404, `${end}: its segments too`);
        ctl.exit();
        if (ending) await ending;
        for (let i = 0; i < 50 && counted(); i++) await tick();
        assert.equal(counted(), false);
    }
});
