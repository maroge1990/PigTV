const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the real web player script in a bare context, as browser.test.js does.
function loadPlayer(extra = {}) {
    const context = vm.createContext({ window: {}, console: { ...console, error() {} }, URL, ...extra });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    return context.window.VideoPlayer.prototype;
}

// A stand-in <video> that has failed.
function failedVideo(overrides = {}) {
    return {
        error: { code: 3, message: 'PIPELINE_ERROR_DECODE: video decode error' },
        // What the remux URL really looks like: the provider's address AND login sit in ?url=, the session token in ?token=.
        currentSrc: 'http://pigtv.local:3000/api/remux?url=http%3A%2F%2Fprovider.example%2Flive%2Fmyuser%2Fmypassword%2F12345.ts&token=eyJsecrettoken',
        // A playing element has its src attribute set; getAttribute follows currentSrc unless a test says otherwise.
        getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
        networkState: 2, readyState: 1, currentTime: 9.96,
        buffered: { length: 1, end: () => 9.87 },
        ...overrides
    };
}

test('a media error is described without the provider address, login or session token', () => {
    const proto = loadPlayer();
    const described = proto.describeMediaError.call({ hls: null, currentStrategy: 'remux' }, failedVideo());
    assert.equal(described.codeName, 'MEDIA_ERR_DECODE');
    assert.equal(described.code, 3);
    assert.equal(described.strategy, 'remux');
    assert.equal(described.path, '/api/remux', 'only the path survives');
    assert.equal(described.currentTime, 10);
    assert.equal(described.bufferedEnd, 9.9);
    const everything = JSON.stringify(described);
    for (const secret of ['provider.example', 'myuser', 'mypassword', 'secrettoken', 'token=', 'url=']) {
        assert.ok(!everything.includes(secret), `${secret} must not appear in what is logged or sent`);
    }
});

test('the strategy is hls when hls.js is driving the element, and local when the server did not choose', () => {
    const proto = loadPlayer();
    assert.equal(proto.describeMediaError.call({ hls: {}, currentStrategy: 'transcode' }, failedVideo()).strategy, 'hls');
    assert.equal(proto.describeMediaError.call({ hls: null, currentStrategy: null }, failedVideo()).strategy, 'local');
});

test('a long browser message is bounded, and an element with no buffered data reports zero', () => {
    const proto = loadPlayer();
    const described = proto.describeMediaError.call({}, failedVideo({
        error: { code: 4, message: 'x'.repeat(5000) }, buffered: { length: 0, end() { throw new Error('none'); } }
    }));
    assert.equal(described.message.length, 200);
    assert.equal(described.codeName, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
    assert.equal(described.bufferedEnd, 0);
});

function harness(video) {
    const reports = [];
    const statuses = [];
    const proto = loadPlayer();
    // Inherit the real methods: handleMediaError calls several of its siblings.
    const self = Object.assign(Object.create(proto), {
        video, hls: null, currentStrategy: 'remux',
        currentChannel: { sourceId: 1, id: 'c1' }, currentStreamUrl: 'http://provider.invalid/1.ts',
        loadingSpinner: { classList: { remove() {} } },
        updateTranscodeStatus: (mode, text) => statuses.push({ mode, text }),
        reportClientEvent: (payload) => reports.push(payload)
    });
    return { proto, self, reports, statuses };
}

test('a real failure is shown to the user and reported once, not on every repeat', () => {
    const { proto, self, reports, statuses } = harness(failedVideo());
    proto.handleMediaError.call(self);
    proto.handleMediaError.call(self); // the element can fire more than once for one source
    assert.equal(reports.length, 1);
    assert.equal(reports[0].event, 'media-error');
    assert.equal(reports[0].path, '/api/remux');
    assert.deepEqual(statuses[0], { mode: 'error', text: 'Playback error (MEDIA_ERR_DECODE)' });

    self.video.currentSrc += '&retry=1'; // a new attempt is a new report
    proto.handleMediaError.call(self);
    assert.equal(reports.length, 2);
});

test('clearing the source is not a failure: changing channel must not raise an error', () => {
    for (const cleared of [{ currentSrc: '' }, { error: null }]) {
        const { proto, self, reports, statuses } = harness(failedVideo(cleared));
        proto.handleMediaError.call(self);
        assert.equal(reports.length, 0);
        assert.equal(statuses.length, 0);
    }
});

// What Chrome really does: stop() sets src = '' and the element raises code 4
// "Empty src attribute" while currentSrc STILL holds the previous stream's URL.
// The first version of the handler only checked currentSrc, so it reported every
// channel change as a playback failure (and showed a red badge).
const CLEARED_BY_CHROME = () => ({
    error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Empty src attribute' },
    getAttribute: (name) => (name === 'src' ? '' : null),
    networkState: 3, readyState: 0, currentTime: 0, buffered: { length: 0, end() { throw new Error('none'); } }
});

test("Chrome's own 'Empty src attribute' error, with the old URL still in currentSrc, is ignored", () => {
    const { proto, self, reports, statuses } = harness(failedVideo(CLEARED_BY_CHROME()));
    assert.ok(self.video.currentSrc.includes('/api/remux'), 'the fixture reproduces the trap: currentSrc is still the old URL');
    proto.handleMediaError.call(self);
    assert.equal(reports.length, 0, 'nothing is reported to the server log');
    assert.equal(statuses.length, 0, 'and no red badge appears');
});

test('the message alone is enough, even if the attribute is somehow still set', () => {
    const { proto, self, reports } = harness(failedVideo({ error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Empty src attribute' } }));
    proto.handleMediaError.call(self);
    assert.equal(reports.length, 0);
});

test('a genuine failure right after a channel change is still reported (the guard is not a blanket mute)', () => {
    const { proto, self, reports } = harness(failedVideo());
    proto.handleMediaError.call(self);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].codeName, 'MEDIA_ERR_DECODE');
    // ...and an unsupported-format error is a real failure too, unlike the cleared-source one.
    const other = harness(failedVideo({ error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' } }));
    other.proto.handleMediaError.call(other.self);
    assert.equal(other.reports.length, 1);
    assert.equal(other.reports[0].codeName, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
});

test('while hls.js is driving, the badge is left to it, but the error is still recorded', () => {
    const { proto, self, reports, statuses } = harness(failedVideo());
    self.hls = {};
    proto.handleMediaError.call(self);
    assert.equal(statuses.length, 0, 'hls.js recovers from many of these itself');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].strategy, 'hls');
});

test('reporting never throws into playback, even with no network', () => {
    const proto = loadPlayer({ API: { streamFetch: () => { throw new Error('offline'); } } });
    assert.doesNotThrow(() => proto.reportClientEvent.call({}, { event: 'media-error' }));
    const rejecting = loadPlayer({ API: { streamFetch: () => Promise.reject(new Error('offline')) } });
    assert.doesNotThrow(() => rejecting.reportClientEvent.call({}, { event: 'media-error' }));
});
