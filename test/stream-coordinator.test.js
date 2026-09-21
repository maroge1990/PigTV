const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sessions write under <cwd>/transcode-cache; keep that out of the repo. (These
// sessions are registered but never started, so nothing is actually written.)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-coord-'));
process.chdir(scratch);

// Stand in for the remux registry so the test needs no database or ffmpeg.
const remuxStub = { streams: [], killed: [] };
const remuxPath = require.resolve('../server/routes/remux');
require.cache[remuxPath] = {
    id: remuxPath, filename: remuxPath, loaded: true,
    exports: {
        listActiveRemuxes: () => remuxStub.streams,
        killRemux: (id) => {
            remuxStub.killed.push(id);
            remuxStub.streams = remuxStub.streams.filter(r => r.id !== id);
            return true;
        }
    }
};

const transcodeSession = require('../server/services/transcodeSession');
const coordinator = require('../server/services/streamCoordinator');

const ONE_STREAM = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60 };
let counter = 0;

// A registered HLS session, as if a client had started it `idleSec` seconds ago
// and not fetched anything since.
async function session(owner, idleSec, opts = {}) {
    const s = await transcodeSession.createSession(`http://provider.invalid/live/${++counter}.ts`, { owner, live: true, ...opts });
    s.lastAccess = Date.now() - idleSec * 1000;
    return s;
}

const recording = { id: 7, title: 'The News', channel_name: 'ABC', program_end: Date.now() + 3600000, post_buffer_min: 2 };

afterEach(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    remuxStub.streams = [];
    remuxStub.killed = [];
});

after(() => {
    process.chdir(os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
});

test('ownerKey: a paired device is its own owner, a login is the user, anonymous is nobody', () => {
    assert.equal(coordinator.ownerKey({ id: 1, deviceId: 'tv' }), 'device:tv');
    assert.equal(coordinator.ownerKey({ id: 1, deviceId: null }), 'user:1');
    assert.notEqual(coordinator.ownerKey({ id: 1, deviceId: 'tv' }), coordinator.ownerKey({ id: 1, deviceId: 'ipad' }));
    assert.equal(coordinator.ownerKey(undefined), null);
    assert.equal(coordinator.ownerKey({}), null);
});

test('nothing is arbitrated while the provider has a free connection', async () => {
    assert.deepEqual(coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a' }), { allowed: true, release: [] });

    await session('device:b', 2);
    const two = coordinator.requestForViewer({ settings: { ...ONE_STREAM, maxProviderStreams: 2 }, owner: 'device:a' });
    assert.equal(two.allowed, true);
    assert.deepEqual(two.release, [], 'a second connection is allowed, so nobody is stopped');
});

test('an abandoned stream is reclaimed silently, whoever owned it', async () => {
    const stale = await session('device:b', 90);
    const verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => r.stream.id), [stale.id]);
});

test('a device replaces its own earlier stream without being asked', async () => {
    const mine = await session('device:a', 2);
    const verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => r.stream.id), [mine.id]);
});

test('another device that is really watching is put to the caller as a question', async () => {
    const theirs = await session('device:b', 5);
    const verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a' });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.conflict.type, 'viewer-in-progress');
    assert.equal(verdict.conflict.streamId, theirs.id);
    assert.match(verdict.conflict.message, /Another device is watching/);
    assert.deepEqual(verdict.release, [], 'nothing is stopped until the caller agrees');
});

test('force takes the slot from the other viewer', async () => {
    const theirs = await session('device:b', 5);
    const verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a', force: true });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => r.stream.id), [theirs.id]);
});

test('a caller who is not identified never owns anything', async () => {
    await session(null, 2);
    const verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: null });
    assert.equal(verdict.allowed, false, 'two anonymous streams must not be assumed to be the same viewer');
});

test('soft mode reclaims what is free but never refuses', async () => {
    const stale = await session('device:b', 90);
    let verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a', soft: true });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(r => r.stream.id), [stale.id]);

    await transcodeSession.removeSession(stale.id);
    await session('device:c', 5);
    verdict = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a', soft: true });
    assert.equal(verdict.allowed, true, 'the legacy entry points proceed as they always have');
    assert.deepEqual(verdict.release, []);
});

test('a recording in progress is still reported, and force still sacrifices it', () => {
    const asked = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a', activeRecordings: [recording] });
    assert.equal(asked.allowed, false);
    assert.equal(asked.conflict.type, 'recording-in-progress');
    assert.equal(asked.conflict.scheduleId, 7);

    const forced = coordinator.requestForViewer({ settings: ONE_STREAM, owner: 'device:a', activeRecordings: [recording], force: true });
    assert.equal(forced.allowed, true);
    assert.deepEqual(forced.sacrificed, [7]);
});

test('admitViewer stops the streams it says must go, HLS and remux alike', async () => {
    const hls = await session('device:b', 90);
    remuxStub.streams = [{ id: 'remux_1', url: 'http://provider.invalid/x.ts', idleMs: 90000, startTime: Date.now() - 100000, owner: 'device:c' }];

    const verdict = await coordinator.admitViewer({ settings: { ...ONE_STREAM, maxProviderStreams: 1 }, owner: 'device:a' });
    assert.equal(verdict.allowed, true);
    // Limit 1 with two abandoned streams open: both have to go to make room.
    assert.ok(!transcodeSession.getAllSessions().some(s => s.id === hls.id), 'the abandoned HLS session is gone');
    assert.deepEqual(remuxStub.killed, ['remux_1'], 'the abandoned remux was killed through the remux registry');
});

test('admitViewer leaves everything running when the caller is refused', async () => {
    const theirs = await session('device:b', 5);
    const verdict = await coordinator.admitViewer({ settings: ONE_STREAM, owner: 'device:a' });
    assert.equal(verdict.allowed, false);
    assert.ok(transcodeSession.getAllSessions().some(s => s.id === theirs.id));
});

test('a remux is now judged by when media last flowed, not assumed busy', () => {
    remuxStub.streams = [{ id: 'remux_9', url: 'http://provider.invalid/y.ts', idleMs: 90000, startTime: 0, owner: 'user:1' }];
    const [remux] = coordinator.activeStreams();
    assert.equal(remux.type, 'remux');
    assert.equal(remux.idleMs, 90000, 'the coordinator used to hard-code 0 here');
    assert.equal(remux.owner, 'user:1');
});

test('live sessions are swept on the live timeout, seekable ones on the longer one', async () => {
    const live = await session('device:a', 6 * 60);                      // 6 min idle, live
    const seekable = await session('device:b', 10 * 60, { live: false }); // 10 min idle, not live
    const fresh = await session('device:c', 30);                          // live, recently used
    await transcodeSession.cleanupStaleSessions();
    const ids = transcodeSession.getAllSessions().map(s => s.id);
    assert.ok(!ids.includes(live.id), 'an idle live session goes after the live timeout');
    assert.ok(ids.includes(seekable.id), 'a seekable session keeps the 30 minute allowance');
    assert.ok(ids.includes(fresh.id));
});
