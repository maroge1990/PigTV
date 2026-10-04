const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0158 (Mark's decision): if a recording is due and a live viewer holds the
// provider's only stream, the viewer is asked once (the existing prompt). If
// nobody answers within recordingPromptTimeoutMin minutes of the recording
// actually becoming due (not the earlier announceUpcoming lead-time notice),
// the recording takes the stream. An explicit "Keep watching" (decline) keeps
// today's behaviour: wait for playback to stop. Sessions write under <cwd>/transcode-cache; keep that
// out of the repo, same approach as stream-coordinator.test.js.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-prompt-timeout-'));
process.chdir(scratch);

const transcodeSession = require('../server/services/transcodeSession');
const coordinator = require('../server/services/streamCoordinator');

const SETTINGS = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60, recordingPromptTimeoutMin: 3 };
let counter = 0;

/** A live (not idle) registered HLS session, as a real viewer watching now. */
async function liveSession(owner) {
    const s = await transcodeSession.createSession(`http://provider.invalid/live/${++counter}.ts`, { owner, live: true });
    s.lastAccess = Date.now();
    return s;
}

let n = 0;
function schedule(overrides = {}) {
    return { id: ++n, title: 'The Big Game', channel_name: 'Fox Sports 505', program_end: Date.now() + 3600000, post_buffer_min: 2, ...overrides };
}

/** Move a schedule's prompt as if it had become due `minutesAgo` minutes ago. */
function backdateDueSince(scheduleId, minutesAgo) {
    const entry = coordinator._prompts.get(scheduleId);
    assert.ok(entry, 'a prompt must already exist for this schedule');
    entry.dueSince = Date.now() - minutesAgo * 60000;
}

afterEach(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    coordinator._prompts.clear();
});

after(() => {
    process.chdir(os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
});

test('the first request only asks; it does not take the stream immediately', async () => {
    await liveSession('device:tv');
    const s = schedule();
    const verdict = await coordinator.requestForRecording(s, SETTINGS);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.prompted, true);
    assert.equal(transcodeSession.getAllSessions().length, 1, 'the viewer keeps their stream');
});

test('no answer within the timeout: the recording takes the stream', async () => {
    const viewer = await liveSession('device:tv');
    const s = schedule();
    await coordinator.requestForRecording(s, SETTINGS); // issues the prompt, dueSince = now

    // Still within the timeout: unchanged.
    backdateDueSince(s.id, 2);
    let verdict = await coordinator.requestForRecording(s, SETTINGS);
    assert.equal(verdict.allowed, false);
    assert.ok(transcodeSession.getSession(viewer.id), 'still within the timeout: the viewer is untouched');

    // Past it: the recording takes over.
    backdateDueSince(s.id, 4);
    verdict = await coordinator.requestForRecording(s, SETTINGS);
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /No answer/);
    assert.equal(transcodeSession.getSession(viewer.id), undefined, 'the viewer\'s stream was released');
});

test('"Keep watching" (decline) keeps today\'s behaviour: it waits, however long', async () => {
    const viewer = await liveSession('device:tv');
    const s = schedule();
    await coordinator.requestForRecording(s, SETTINGS);
    coordinator.declinePrompt(s.id);

    backdateDueSince(s.id, 10); // well past the 3-minute timeout
    const verdict = await coordinator.requestForRecording(s, SETTINGS);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'Viewer declined; waiting for playback to stop');
    assert.ok(transcodeSession.getSession(viewer.id), 'a decline is never overridden by the timeout');
});

test('the timeout counts from when the recording became due, not from an earlier announceUpcoming notice', async () => {
    await liveSession('device:tv');
    const s = schedule();

    // The early lead-time notice, well before the recording is actually due.
    coordinator.announceUpcoming(s, { ...SETTINGS, recordingPromptLeadMin: 5 });
    const announced = coordinator._prompts.get(s.id);
    assert.ok(announced, 'announceUpcoming creates the entry early');
    assert.equal(announced.dueSince, null, 'but does not start the answer-timeout clock');
    announced.issuedAt = Date.now() - 10 * 60000; // as if announced 10 minutes ago

    // The recording becomes due right now and is still blocked: this is what should
    // start the clock, not the 10-minute-old announcement.
    const verdict = await coordinator.requestForRecording(s, SETTINGS);
    assert.equal(verdict.allowed, false, 'due only just now: nowhere near the timeout yet');
    assert.ok(Date.now() - coordinator._prompts.get(s.id).dueSince < 1000);
});

test('default recordingPromptTimeoutMin is 3 when a setting is not supplied', async () => {
    await liveSession('device:tv');
    const s = schedule();
    await coordinator.requestForRecording(s, {}); // no recordingPromptTimeoutMin at all

    backdateDueSince(s.id, 2.9);
    assert.equal((await coordinator.requestForRecording(s, {})).allowed, false, 'just under 3 minutes: still waiting');

    backdateDueSince(s.id, 3.1);
    assert.equal((await coordinator.requestForRecording(s, {})).allowed, true, 'just over 3 minutes: takes the stream');
});
