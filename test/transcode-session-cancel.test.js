const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// PB1 (22 Oct review, 0230): a session stopped or cleaned up while its start awaits (the folder,
// the shared-ingest subscription) must never spawn ffmpeg afterwards, and a subscription that
// arrives late is given straight back. The real TranscodeSession; ffmpeg is a script that logs its
// start and waits; the ingest's subscribe() is replaced by a deferred promise the test settles.
// On 0229 the late subscription spawned ffmpeg after cleanup (status 'running', nothing could stop it).
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-session-cancel-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const { TranscodeSession } = load('services/transcodeSession');
const ingest = load('services/ingest');

const startsLog = path.join(sandbox, 'starts.log');
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(startsLog)}, 'start\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`);
fs.chmodSync(FFMPEG, 0o755);
const starts = () => (fs.existsSync(startsLog) ? fs.readFileSync(startsLog, 'utf8').split('\n').filter(Boolean).length : 0);

const realSubscribe = ingest.subscribe;
let pending; // { resolve, reject } of the subscription the session is waiting for
const sessions = [];
const realLog = console.log, realWarn = console.warn;

before(() => { console.log = () => {}; console.warn = () => {}; });
afterEach(async () => {
    ingest.subscribe = realSubscribe;
    for (const s of sessions.splice(0)) {
        await s.cleanup();
        try { s.process?.kill('SIGKILL'); } catch { /* gone */ } // on old code a late spawn outlives cleanup
    }
    try { fs.unlinkSync(startsLog); } catch { /* none */ }
});
after(() => {
    console.log = realLog; console.warn = realWarn;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

function deferSubscribe() {
    ingest.subscribe = () => new Promise((resolve, reject) => { pending = { resolve, reject }; });
}
function fakeFeed() {
    const feed = new EventEmitter();
    feed.left = 0;
    feed.leave = () => { feed.left++; };
    feed.pipe = () => {};
    return feed;
}
function newSession() {
    const s = new TranscodeSession('http://provider.invalid/live/u/p/1.ts', {
        ffmpegPath: FFMPEG, ingestSource: { pool: 'primary', url: 'http://provider.invalid/live/u/p/1.ts', userAgent: 'test' }
    });
    s.buildFFmpegArgs = () => ['-i', 'pipe:0', 'out.m3u8'];
    s.startWatchdog = () => {};
    sessions.push(s);
    return s;
}
// Polled by time, not event-loop turns: the start's folder work before it subscribes took longer than
// 100 turns on CI's 2 vCPUs with every file running at once (run 40446368965, Node 22).
async function waitingForSubscription(s) {
    const deadline = Date.now() + 5000;
    while (!pending && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    assert.ok(pending, 'the start is waiting for its subscription');
}

test('PB1: cleanup while the subscription is pending - it resolves late, is given back, and nothing spawns', async () => {
    deferSubscribe(); pending = null;
    const s = newSession();
    const started = s.start();
    await waitingForSubscription(s);
    await s.cleanup();
    const feed = fakeFeed();
    pending.resolve(feed);
    await assert.rejects(started, (err) => err.superseded === true);
    assert.equal(feed.left, 1, 'the late subscription is released');
    assert.equal(s.process, null);
    assert.equal(s.status, 'stopped');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(starts(), 0, 'no ffmpeg after cleanup');
    assert.equal(fs.existsSync(s.dir), false, 'the folder is gone');
});

test('PB1: stop while the subscription is pending, then the subscription fails - no direct read of the provider', async () => {
    deferSubscribe(); pending = null;
    const s = newSession();
    const started = s.start();
    await waitingForSubscription(s);
    await s.stop();
    pending.reject(Object.assign(new Error('Shared ingest not used: HTTP 503'), { ingestRefused: true, providerReason: true }));
    await assert.rejects(started, (err) => err.superseded === true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(starts(), 0, 'not the usual direct path either');
});

test('PB1: the ingest is closed under a waiting start (a takeover released it) - a cancellation, not a direct read', async () => {
    deferSubscribe(); pending = null;
    const s = newSession();
    const started = s.start();
    await waitingForSubscription(s);
    pending.reject(Object.assign(new Error('Shared ingest closed before it started: released'), { ingestCancelled: true, providerReason: false }));
    await assert.rejects(started, (err) => err.superseded === true && !err.providerReason);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(starts(), 0);
});

test('PB1: stopped while the folder is made - nothing spawns, and a later start refuses', async () => {
    deferSubscribe(); pending = null;
    const s = newSession();
    const started = s.start();
    s.stop();
    await assert.rejects(started, (err) => err.superseded === true);
    assert.equal(pending, null, 'it never asked the ingest');
    await assert.rejects(s.start(), (err) => err.superseded === true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(starts(), 0);
});

test('PB1: the ordinary start still reads its subscription and spawns once', async () => {
    deferSubscribe(); pending = null;
    const s = newSession();
    const started = s.start();
    await waitingForSubscription(s);
    const feed = fakeFeed();
    pending.resolve(feed);
    await started;
    assert.equal(s.status, 'running');
    assert.equal(s.feed, feed);
    for (let i = 0; i < 40 && starts() === 0; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(starts(), 1);
    await s.cleanup();
    assert.equal(s.process?.exitCode !== null || s.process?.signalCode !== null, true, 'stopped by cleanup');
});
