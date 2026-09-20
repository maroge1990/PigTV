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
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
        static isSupported() { return true; }
        constructor() { this.handlers = {}; FakeHls.last = this; }
        on(name, fn) { this.handlers[name] = fn; }
        loadSource() {} attachMedia() {} destroy() { this.destroyed = true; }
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
        fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ strategy: 'remux', url: '/api/remux?x=1' }) }; }
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

test('HLS delivery is off by default, and a browser that blocks storage is simply off', () => {
    assert.equal(makePlayer().player.hlsDeliveryEnabled, false);
    assert.equal(makePlayer({ storageThrows: true }).player.hlsDeliveryEnabled, false);
    assert.equal(makePlayer({ stored: { pigtv_hls_delivery: '1' } }).player.hlsDeliveryEnabled, true);
    assert.equal(makePlayer({ stored: { pigtv_hls_delivery: 'true' } }).player.hlsDeliveryEnabled, false, 'only the exact "1" the toggle writes');
});

test('the toggle is remembered per browser, and turning it off forgets it', () => {
    const { player, store } = makePlayer();
    player.setHlsDelivery(true);
    assert.equal(store.pigtv_hls_delivery, '1');
    assert.equal(player.hlsDeliveryEnabled, true);
    player.setHlsDelivery(false);
    assert.ok(!('pigtv_hls_delivery' in store));
    assert.equal(player.hlsDeliveryEnabled, false);
    assert.doesNotThrow(() => makePlayer({ storageThrows: true }).player.setHlsDelivery(true));
});

test('resolve asks for segmented delivery only when opted in - otherwise the request is exactly what it was', async () => {
    const off = makePlayer();
    await off.player.resolvePlayback(channel, 'http://x/1.ts');
    assert.ok(!('segmentedDelivery' in off.requests[0].body.capabilities), 'the default request is unchanged');
    assert.deepEqual(Object.keys(off.requests[0].body.capabilities).sort(), ['fmp4', 'hevc', 'hls']);

    const on = makePlayer({ stored: { pigtv_hls_delivery: '1' } });
    await on.player.resolvePlayback(channel, 'http://x/1.ts');
    assert.equal(on.requests[0].body.capabilities.segmentedDelivery, true);
    assert.equal(on.requests[0].body.channelId, 'pos_7', 'everything else about the request is the same');
});

test('an HLS session decision is labelled as HLS when opted in, and keeps its old label when not', async () => {
    const decision = { strategy: 'transcode', container: 'hls', videoMode: 'copy', url: '/api/transcode/abc/stream.m3u8', sessionId: 'abc' };
    for (const [stored, expected] of [[{ pigtv_hls_delivery: '1' }, 'HLS (video copied)'], [{}, 'Transcoding (Audio)']]) {
        const { player, badge } = makePlayer({ stored });
        player.playHls = () => {};
        player.updateQualityBadge = player.updateNowPlaying = player.showNowPlayingOverlay = player.fetchEpgData = player.startConflictWatch = () => {};
        player.beginPlayMeasurement();
        await player.playDecision(decision, channel);
        assert.equal(badge[0].text, expected);
    }
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
    const { player, reports, badge } = makePlayer({ stored: { pigtv_hls_delivery: '1' } });
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
