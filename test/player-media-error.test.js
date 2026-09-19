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
    const self = {
        video, hls: null, currentStrategy: 'remux',
        loadingSpinner: { classList: { remove() {} } },
        updateTranscodeStatus: (mode, text) => statuses.push({ mode, text }),
        describeMediaError: proto.describeMediaError,
        reportClientEvent: (payload) => reports.push(payload)
    };
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
