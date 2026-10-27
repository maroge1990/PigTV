const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TranscodeSession } = require('../server/services/transcodeSession');

// R7 (FINDINGS FR-8): the session's stall watchdog does not blame ffmpeg for a silence its shared
// feed caused. lastActivityAt is what the watchdog reads.
const activity = (out, excuse) => TranscodeSession.prototype.lastActivityAt.call({
    latestOutputAt: async () => out,
    feedExcusedUntil: () => excuse
});

test('a pause in the shared feed moves the watchdog\'s clock; ffmpeg is judged from when bytes came back', async () => {
    assert.equal(await activity(1000, 5000), 5000, 'the feed resumed at 5000: silence before that is not ffmpeg\'s');
    assert.equal(await activity(9000, 5000), 9000, 'output after the pause is the newest activity');
    assert.equal(await activity(1000, null), 1000, 'no ingest, or it is reconnecting: output only, as before');
    assert.equal(await activity(null, 5000), null, 'before any output nothing is excused: the start-up grace holds');
});

test('feedExcusedUntil asks the subscription, and is null without one', () => {
    const call = (self) => TranscodeSession.prototype.feedExcusedUntil.call(self, 7);
    assert.equal(call({ feed: null }), null);
    assert.equal(call({ feed: { excusedUntil: (now) => now + 1 } }), 8);
});
