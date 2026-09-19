const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStallWatchdog } = require('../server/services/stallWatchdog');

// Real timers with small limits and generous margins: the behaviour under test
// is "decides after N ms of silence", not the precision of setInterval.
const FAST = { checkIntervalMs: 10, stallMs: 150, startupMs: 400 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function watch(opts) {
    const calls = [];
    const watchdog = createStallWatchdog({
        label: 'test',
        ...FAST,
        ...opts,
        onStall: (quietMs, sawOutput) => calls.push({ quietMs, sawOutput })
    });
    return { watchdog, calls };
}

test('a process that never produces output is reaped after the startup grace, not before', async () => {
    const { watchdog, calls } = watch({ getLastActivity: () => null });
    try {
        await sleep(250); // past stallMs, inside startupMs
        assert.equal(calls.length, 0, 'probing/connecting is allowed to be quiet');
        await sleep(600);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sawOutput, false);
        assert.ok(calls[0].quietMs >= FAST.startupMs);
    } finally { watchdog.stop(); }
});

test('a process that keeps producing output is never reaped', async () => {
    const { watchdog, calls } = watch({ getLastActivity: () => Date.now() });
    try {
        await sleep(700);
        assert.equal(calls.length, 0);
    } finally { watchdog.stop(); }
});

test('output followed by silence is reaped on the shorter stall limit', async () => {
    const started = Date.now();
    // Fixed timestamp just after the watchdog starts: output seen, then nothing.
    const { watchdog, calls } = watch({ getLastActivity: () => started + 30 });
    try {
        await sleep(350); // past stallMs, still inside startupMs
        assert.equal(calls.length, 1, 'once output has been seen, the startup grace no longer applies');
        assert.equal(calls[0].sawOutput, true);
    } finally { watchdog.stop(); }
});

test('activity from before the watchdog started is not mistaken for output', async () => {
    const { watchdog, calls } = watch({ getLastActivity: () => Date.now() - 60000 });
    try {
        await sleep(250);
        assert.equal(calls.length, 0, 'a stale leftover file must not shorten the startup grace');
        await sleep(600);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sawOutput, false);
    } finally { watchdog.stop(); }
});

test('a failing measurement never reaps anything', async () => {
    const { watchdog, calls } = watch({ getLastActivity: () => { throw new Error('EIO'); } });
    try {
        await sleep(700);
        assert.equal(calls.length, 0);
    } finally { watchdog.stop(); }
});

test('stop() cancels a pending decision, and onStall fires only once', async () => {
    const stopped = watch({ getLastActivity: () => null });
    stopped.watchdog.stop();
    await sleep(600);
    assert.equal(stopped.calls.length, 0);

    const once = watch({ getLastActivity: () => null });
    try {
        await sleep(900);
        assert.equal(once.calls.length, 1);
    } finally { once.watchdog.stop(); }
});

// --- HLS session path, against a real child process standing in for ffmpeg ---

// The session writes into <cwd>/transcode-cache; keep that out of the repo.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-stall-'));
process.chdir(scratch);
const transcodeSession = require('../server/services/transcodeSession');

const SILENT = 'setInterval(() => {}, 1000)';
const PRODUCING = "const fs = require('fs'); setInterval(() => fs.writeFileSync('seg0000.ts', String(Date.now())), 40)";
let fakeScript = SILENT;
// Stand in for ffmpeg: node running a script, so the real start()/exit/cleanup
// plumbing is exercised. Only the argument list is faked.
transcodeSession.TranscodeSession.prototype.buildFFmpegArgs = function () { return ['-e', fakeScript]; };

const SESSION_OPTS = {
    ffmpegPath: process.execPath,
    stallMs: 300,
    startupMs: 300,
    watchdogIntervalMs: 20
};

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a silent HLS ffmpeg is killed and its session removed from the registry', async () => {
    fakeScript = SILENT;
    const session = await transcodeSession.createSession('http://provider.invalid/live/user/pw/1.ts', SESSION_OPTS);
    await session.start();
    const pid = session.process.pid;
    assert.ok(transcodeSession.getAllSessions().some(s => s.id === session.id));

    const deadline = Date.now() + 5000;
    while (transcodeSession.getAllSessions().some(s => s.id === session.id) && Date.now() < deadline) await sleep(50);

    assert.ok(!transcodeSession.getAllSessions().some(s => s.id === session.id),
        'a stalled session must stop counting as a provider connection');
    const gone = Date.now() + 5000;
    while (alive(pid) && Date.now() < gone) await sleep(50);
    assert.equal(alive(pid), false, 'the ffmpeg process must actually be gone');
});

test('an HLS ffmpeg that keeps writing files is left alone', async () => {
    fakeScript = PRODUCING;
    const session = await transcodeSession.createSession('http://provider.invalid/live/user/pw/2.ts', SESSION_OPTS);
    await session.start();
    try {
        await sleep(1200); // four stall limits
        assert.ok(transcodeSession.getAllSessions().some(s => s.id === session.id));
        assert.equal(session.status, 'running');
    } finally {
        await transcodeSession.removeSession(session.id);
    }
});

after(() => {
    process.chdir(os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
});
