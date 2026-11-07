const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #36 (0487): a play-start may carry where the start went (`phases`, ms since the press: resolve, ready, mode, frame;
// all optional). The server logs and keeps them, Status shows the median and p90 of each step, and playback-report.js
// reads them from the log. The 6 Nov audit could not split 0.6-11 s of the device's share of a start.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-startphases-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_DB_BACKUPS = '0';
const cwd = process.cwd();
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const auth = load('auth');
const router = load('routes/playback');
const playbackEvents = load('services/playbackEvents');
const startPhases = load('services/startPhases');

let server, base, token;
const logged = [];
const realLog = console.log;
before(async () => {
    token = auth.generateToken(await load('db').users.create({ username: 'owner', role: 'admin' }));
    const app = express(); app.use(express.json()); app.use('/api/playback', router);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    console.log = (...a) => { logged.push(a.join(' ')); };
});
after(() => {
    console.log = realLog;
    server?.closeAllConnections?.(); server?.close();
    process.chdir(cwd);
    try { load('db/sqlite').getDb().close(); } catch { /* closed */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* the OS temp cleaner */ }
});
const post = (body) => fetch(`${base}/api/playback/client-event`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const start = (extra = {}) => ({ event: 'play-start', strategy: 'transcode', container: 'hls', resolveMs: 4300, totalMs: 5400, ...extra });

test('the phases are logged on the play-start line and kept with the play', async () => {
    playbackEvents.reset(); logged.length = 0;
    const r = await post(start({ phases: { resolveMs: 4300, readyMs: 4950, modeMs: 5200, frameMs: 5410 } }));
    assert.equal(r.status, 204);
    const line = logged.find(l => l.includes('[Player] play-start'));
    assert.match(line, / phases=resolve:4\.3,ready:5\.0,mode:5\.2,frame:5\.4$/);
    assert.deepEqual(playbackEvents.recent()[0].phases, { resolve: 4.3, ready: 5, mode: 5.2, frame: 5.4 });
});

test('an older client (no phases) and nonsense phases change nothing', async () => {
    playbackEvents.reset(); logged.length = 0;
    await post(start());
    await post(start({ phases: { resolveMs: 'soon', readyMs: -5, frameMs: 1e12, extraMs: 3, 'http://x': 1 } }));
    for (const line of logged.filter(l => l.includes('[Player] play-start'))) assert.doesNotMatch(line, /phases=/);
    assert.ok(playbackEvents.recent().every(e => e.phases === null));
});

test('the steps: server answer, loading the stream, display mode, first picture; median and p90 over the plays', () => {
    assert.deepEqual(startPhases.steps({ resolve: 4.3, ready: 5.0, mode: 5.2, frame: 5.4 }),
        { answer: 4.3, loading: 0.7, mode: 0.2, picture: 0.2 });
    assert.deepEqual(startPhases.steps({ resolve: 4.3, ready: 5.0, frame: 15.9 }), { answer: 4.3, loading: 0.7, mode: null, picture: 10.9 });
    const events = [4.3, 4.5, 4.9].map((r, i) => ({ type: 'play-start', phases: { resolve: r, ready: r + 0.5, frame: r + 1 + i } }));
    const s = startPhases.summary([...events, { type: 'play-end' }, { type: 'play-start', phases: null }]);
    assert.equal(s.plays, 3);
    const answer = s.steps.find(x => x.key === 'answer');
    assert.deepEqual([answer.median, answer.p90, answer.count], [4.5, 4.9, 3]);
    assert.equal(s.steps.find(x => x.key === 'mode').count, 0, 'no switch reported: no mode step');
});

test('playback-report.js reads the phases from the log and prints the steps', () => {
    const report = require('../scripts/playback-report.js');
    const log = [
        '[Playback] resolve timing: HLS session, probe profile (age 4d), first segment after 4.2s',
        '[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.3s first-picture=5.4s from=device:1 origin=sport-front phases=resolve:4.3,ready:5.0,mode:5.2,frame:5.4',
        '[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.9s first-picture=15.9s from=device:1 phases=resolve:4.9,ready:5.6,mode:15.5,frame:15.9'
    ].join('\n');
    const parsed = report.parse(log);
    assert.deepEqual(parsed.plays[0].phases, { resolve: 4.3, ready: 5, mode: 5.2, frame: 5.4 });
    const text = report.report(parsed);
    assert.match(text, /Where a start goes, by step .* 2 plays that sent their phases/);
    assert.match(text, /Display mode switch\s+0\.2 \/ 9\.9/);
});
