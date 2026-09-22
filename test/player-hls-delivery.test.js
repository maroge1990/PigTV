const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The real player script, with a clock, storage and fetch we control.
function makePlayer({ stored = {}, storageThrows = false } = {}) {
    let clock = 0;
    const requests = [];
    const store = { ...stored };
    class FakeHls {
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error', SUBTITLE_TRACKS_UPDATED: 'subtitles' };
        static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
        static isSupported() { return true; }
        constructor() { this.handlers = {}; this.recovered = 0; FakeHls.last = this; }
        on(name, fn) { this.handlers[name] = fn; }
        loadSource() {} attachMedia() {} destroy() { this.destroyed = true; }
        recoverMediaError() { this.recovered++; }
    }
    const context = vm.createContext({
        window: { Hls: FakeHls, dispatchEvent() {} }, Hls: FakeHls, URL,
        API: { withStreamToken: (u) => u }, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        document: { getElementById: () => null }, console: { ...console, warn() {}, error() {}, log() {} },
        performance: { now: () => clock },
        setTimeout: () => 0, clearTimeout() {},
        localStorage: storageThrows
            ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }
            : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ strategy: 'transcode', container: 'hls', url: '/api/transcode/abc/stream.m3u8', sessionId: 'abc' }) }; }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);

    const reports = [];
    const badge = [];
    const video = {
        currentSrc: 'blob:http://pigtv.local/6f1a', getAttribute: () => 'blob:http://pigtv.local/6f1a',
        error: null, paused: false, seeking: false, currentTime: 0, networkState: 2, readyState: 0,
        buffered: { length: 0, end() { throw new Error('none'); } },
        canPlayType: () => '',
        pause() {}, load() {}, removeAttribute() {}, set src(v) {}
    };
    const player = Object.assign(Object.create(context.window.VideoPlayer.prototype), {
        video, hls: null, currentStrategy: null, settings: {}, currentChannel: null,
        reportClientEvent: (p) => reports.push(p),
        updateTranscodeStatus: (mode, text) => badge.push({ mode, text }),
        getCodecCapabilities: () => ({ hevc: false }),
        getHlsConfig: () => ({}),
        loadingSpinner: null,
        overlay: { classList: { add() {}, remove() {} } },
        controlsOverlay: null,
        nowPlaying: { classList: { add() {}, remove() {} } },
        stopTranscodeSession() {}
    });
    return { player, video, reports, badge, requests, store, FakeHls, tick: (ms) => { clock += ms; }, now: () => clock };
}

const channel = { sourceId: 1, id: 'pos_7' };

// 0102: HLS is no longer opt-in. There is one delivery path for every device.

test('there is no toggle any more: every browser asks for HLS segments, the request the Apple client makes', async () => {
    const { player, requests } = makePlayer({ stored: {} });
    assert.equal(player.hlsDeliveryEnabled, undefined, 'the beta getter is gone');
    assert.equal(player.setHlsDelivery, undefined, 'and its setter');
    await player.resolvePlayback(channel, 'http://x/1.ts');
    assert.equal(requests[0].body.capabilities.segmentedDelivery, true);
    assert.deepEqual(Object.keys(requests[0].body.capabilities).sort(), ['fmp4', 'hevc', 'hls', 'segmentedDelivery']);
    assert.equal(requests[0].body.channelId, 'pos_7');
});

test('an old "pigtv_hls_delivery" value left in storage changes nothing', async () => {
    const { player, requests } = makePlayer({ stored: { pigtv_hls_delivery: '0' } });
    await player.resolvePlayback(channel, 'http://x/1.ts');
    assert.equal(requests[0].body.capabilities.segmentedDelivery, true);
});

test('an HLS session decision is labelled as HLS', async () => {
    for (const [videoMode, expected] of [['copy', 'HLS (video copied)'], ['encode', 'HLS (video encoded)']]) {
        const decision = { strategy: 'transcode', container: 'hls', videoMode, url: '/api/transcode/abc/stream.m3u8', sessionId: 'abc' };
        const { player, badge } = makePlayer();
        player.playHls = () => {};
        player.updateQualityBadge = player.updateNowPlaying = player.showNowPlayingOverlay = player.fetchEpgData = player.startConflictWatch = () => {};
        player.beginPlayMeasurement();
        await player.playDecision(decision, channel);
        assert.equal(badge[0].text, expected);
    }
});

test('the browser-side strategies are gone: no remux, no legacy pipe, no probe of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');
    for (const gone of ['/api/remux', '/api/transcode?url=', '/api/probe', 'forceRemux', 'autoTranscode',
                        'startTranscodeSession', 'getRemuxUrl', 'pigtv_hls_delivery']) {
        assert.ok(!src.includes(gone), `${gone} is still in the live player`);
    }
});

// ---- recovery: the web player's answer to a failed HLS play (0102) ----

function playing() {
    const ctx = makePlayer();
    const { player } = ctx;
    const replays = [];
    player.currentChannel = channel;
    player.currentStreamUrl = 'http://provider.invalid/live/u/p/7.ts';
    player.play = (ch, url, opts) => { replays.push({ ch, url, opts }); return Promise.resolve(); };
    return { ...ctx, replays };
}

test('a fatal media error is first recovered in place, once, without asking the server', () => {
    const { player, replays, reports } = playing();
    player.playHls('http://pigtv.local/api/transcode/abc/stream.m3u8');
    const hls = player.hls;
    hls.handlers.error({}, { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
    assert.equal(hls.recovered, 1, 'hls.js rebuilds its media pipeline');
    assert.equal(hls.destroyed, undefined, 'and the session is kept');
    assert.equal(replays.length, 0);
    assert.equal(reports.length, 0, 'a recovered error is not a failure');
});

test('when that does not hold, or the error is not a media error, the server is asked again - once', () => {
    const { player, replays, reports, badge } = playing();
    player.playHls('http://pigtv.local/api/transcode/abc/stream.m3u8');
    let hls = player.hls;
    hls.handlers.error({}, { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
    hls.handlers.error({}, { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
    assert.equal(hls.destroyed, true);
    assert.equal(reports.length, 1, 'the failure is reported');
    assert.equal(replays.length, 1, 'and a fresh session is asked for');
    assert.equal(replays[0].opts.isRetry, true);
    assert.equal(replays[0].url, 'http://provider.invalid/live/u/p/7.ts');

    // The retry's session fails too - a segment 404, which hls.js never retries.
    player.playHls('http://pigtv.local/api/transcode/def/stream.m3u8');
    hls = player.hls;
    hls.handlers.error({}, { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 404 } });
    assert.equal(replays.length, 1, 'no second retry: it can never loop');
    assert.equal(badge.at(-1).mode, 'error', 'the second failure is shown');
});

test('a new selection gets its own retry', async () => {
    const ctx = makePlayer();
    const { player } = ctx;
    player.currentChannel = channel;
    player.currentStreamUrl = 'http://x/1.ts';
    player._recoveredKey = '1:pos_7';
    assert.equal(player.recoverPlayback('test'), false, 'already used for this selection');
    // play() without isRetry resets it (the stubbed network makes the play itself a no-op here).
    player.playDecision = async () => {};
    await player.play(channel, 'http://x/1.ts');
    assert.equal(player._recoveredKey, null);
});

test('the first picture is reported once per play, with how long resolve and the whole start took', async () => {
    const { player, reports, tick } = makePlayer({ stored: { pigtv_hls_delivery: '1' } });
    player.playHls = () => {};
    player.updateQualityBadge = player.updateNowPlaying = player.showNowPlayingOverlay = player.fetchEpgData = player.startConflictWatch = () => {};

    player.beginPlayMeasurement();
    tick(800);                                   // resolve took 0.8 s
    await player.playDecision({ strategy: 'transcode', container: 'hls', videoMode: 'copy', url: '/x.m3u8' }, channel);
    tick(4100);                                  // segments, buffering
    player.notePlaying();
    player.notePlaying();                        // "playing" also fires after every stall: not a second start
    assert.equal(reports.length, 1);
    assert.deepEqual({ ...reports[0] }, { event: 'play-start', strategy: 'transcode', container: 'hls', videoMode: 'copy',
        hlsDelivery: true, resolveMs: 800, totalMs: 4900 });
});

test('a play that fell back to the local path is still measured, as "local"', () => {
    const { player, reports, tick } = makePlayer();
    player.beginPlayMeasurement();
    tick(1500);
    player.notePlaying();
    assert.equal(reports[0].strategy, 'local');
    assert.equal(reports[0].resolveMs, null);
    assert.equal(reports[0].totalMs, 1500);
});

test('a "playing" event with nothing being timed reports nothing (after stop, or before any play)', () => {
    const { player, reports } = makePlayer();
    player.notePlaying();
    assert.equal(reports.length, 0);

    player.beginPlayMeasurement();
    player.stop();
    player.notePlaying();
    assert.equal(reports.length, 0, 'stop() ends the timing');
});

test('play-end reports watch time and stalls when the play is closed out - and only for a real watch', () => {
    const { player, reports, tick } = makePlayer();
    player.beginPlayMeasurement();
    player.notePlaying();
    tick(3000);
    player.stop();                               // glimpse: 3 s
    assert.deepEqual(reports.map(r => r.event), ['play-start'], 'a channel flick is not a play-end');

    reports.length = 0;
    player.beginPlayMeasurement();
    player.notePlaying();
    player._stalls = 2;
    tick(312000);
    player.stop();
    assert.deepEqual(reports.map(r => r.event), ['play-start', 'play-end']);
    assert.equal(reports[1].watchedSec, 312);
    assert.equal(reports[1].stalls, 2);
    assert.equal(reports[1].strategy, 'local');

    player.stop();                               // stopping twice does not report twice
    assert.equal(reports.length, 2);
});

test('the stop that begins the next play closes out the previous one first', () => {
    const { player, reports, tick } = makePlayer();
    player.beginPlayMeasurement();
    player.notePlaying();
    tick(60000);
    player.stop();                               // what play() does before it starts the next channel
    player.beginPlayMeasurement();
    assert.equal(reports.filter(r => r.event === 'play-end').length, 1);
    assert.equal(reports.find(r => r.event === 'play-end').watchedSec, 60);
});

test('stop() is the method the class really uses, and it does the closing-out', () => {
    // The class defines stop() twice; the later definition wins. Make sure the wiring is in the one that runs.
    const { player } = makePlayer();
    assert.match(player.stop.toString(), /reportPlayEnd/);
});

test('a fatal hls.js error is shown and reported once, without the URL or token', () => {
    const { player, reports, badge } = makePlayer();
    player.playHls('http://pigtv.local/api/transcode/abc123/stream.m3u8?token=SECRET');
    const hls = player.hls;
    const fatal = { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 404 },
        url: 'http://pigtv.local/api/transcode/abc123/stream.m3u8?token=SECRET' };
    hls.handlers.error({}, fatal);
    hls.handlers.error({}, fatal);               // hls.js can raise more than one; report the first

    assert.equal(reports.length, 1);
    const report = reports[0];
    assert.equal(report.event, 'media-error');
    assert.equal(report.codeName, 'HLS_networkError');
    assert.equal(report.message, 'manifestLoadError http 404');
    assert.equal(report.path, '/api/transcode/abc123/stream.m3u8', 'the playlist path, not the blob: URL');
    assert.equal(report.strategy, 'hls');
    assert.ok(!JSON.stringify(report).includes('SECRET'));
    assert.equal(badge.at(-1).mode, 'error');
    assert.match(badge.at(-1).text, /HLS manifestLoadError/);
    assert.equal(hls.destroyed, true, 'existing behaviour kept: the failed instance is destroyed');
});

test('a non-fatal hls.js error is left alone, as before', () => {
    const { player, reports, badge } = makePlayer();
    player.playHls('http://pigtv.local/api/transcode/abc123/stream.m3u8');
    player.hls.handlers.error({}, { fatal: false, type: 'networkError', details: 'fragLoadError' });
    assert.equal(reports.length, 0);
    assert.equal(badge.length, 0);
});
