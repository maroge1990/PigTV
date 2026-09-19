const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AUDIO_ERROR = 'PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding: {timestamp:25066646 duration:21333 size:355 is_key_frame:1 encrypted:0}';
const VIDEO_ERROR = 'PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send video packet for decoding: {timestamp:1 size:99}';
const CHANNEL = { sourceId: 1, id: 'm3u_1_pos_9' };
const KEY = '1:m3u_1_pos_9';

// The real player script in a bare context, with a localStorage we can inspect.
function makePlayer({ message = AUDIO_ERROR, code = 3, ...state } = {}) {
    const store = new Map();
    const fetched = [];
    const context = vm.createContext({
        window: {}, URL, console: { ...console, error() {}, warn() {} },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
        fetch: async (url, opts) => { fetched.push({ url, body: JSON.parse(opts.body) }); return { status: 200, ok: true, json: async () => ({ strategy: 'remux', url: '/api/remux?x=1' }) }; }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    const plays = [];
    const reports = [];
    const player = Object.create(context.window.VideoPlayer.prototype);
    Object.assign(player, {
        video: {
            error: { code, message }, currentSrc: 'http://pigtv.local/api/remux?url=x&token=t', networkState: 2, readyState: 2,
            currentTime: 25.1, buffered: { length: 1, end: () => 25.2 }, canPlayType: () => ''
        },
        loadingSpinner: { classList: { remove() {} } },
        hls: null, currentStrategy: 'remux', currentChannel: CHANNEL, currentStreamUrl: 'http://provider.invalid/live/u/p/1.ts',
        _audioEncodeActive: false, _audioRetryKey: null, settings: {},
        getCodecCapabilities: () => ({}),
        updateTranscodeStatus() {},
        reportClientEvent: (payload) => reports.push(payload),
        play: async (...args) => { plays.push(args); },
        ...state
    });
    return { player, store, plays, reports, fetched };
}

test('an audio decode failure on a remux stream replays it once, with the audio re-encoded', async () => {
    const { player, plays, store, reports } = makePlayer();
    player.handleMediaError();
    await new Promise(r => setImmediate(r));
    assert.equal(plays.length, 1);
    // Compared as JSON: objects built inside the vm context have a different Object prototype.
    assert.equal(JSON.stringify(plays[0]), JSON.stringify([CHANNEL, 'http://provider.invalid/live/u/p/1.ts', { audioEncode: true, isRetry: true }]));
    assert.ok(JSON.parse(store.get('pigtv_audio_encode')).includes(KEY), 'and the channel is remembered');
    assert.equal(reports.length, 1, 'the original error is still reported to the server');
});

test('only an audio decode error qualifies: a video error, or a network error, is not retried', () => {
    for (const overrides of [{ message: VIDEO_ERROR }, { code: 2, message: 'network' }, { code: 4, message: 'Format error' }]) {
        const { player, plays } = makePlayer(overrides);
        player.handleMediaError();
        assert.equal(plays.length, 0, JSON.stringify(overrides));
    }
});

test('only the remux path: hls.js manages its own recovery, and a direct stream has nothing to re-encode', () => {
    for (const overrides of [{ hls: {} }, { currentStrategy: 'transcode' }, { currentStrategy: 'direct' }, { currentStrategy: null }]) {
        const { player, plays } = makePlayer(overrides);
        player.handleMediaError();
        assert.equal(plays.length, 0, JSON.stringify(Object.keys(overrides)));
    }
});

test('it can never loop: once retried for a channel, or already re-encoding, it does not retry again', () => {
    let { player, plays } = makePlayer({ _audioRetryKey: KEY });
    player.handleMediaError();
    assert.equal(plays.length, 0, 'this selection has already had its retry');

    ({ player, plays } = makePlayer({ _audioEncodeActive: true }));
    player.handleMediaError();
    assert.equal(plays.length, 0, 'this play was already re-encoding, so another is pointless');
});

test('if re-encoding did not help this channel, the memory of it is dropped', () => {
    const { player, store, plays } = makePlayer({ _audioEncodeActive: true });
    player.rememberAudioEncode(CHANNEL, true);
    assert.ok(player.needsAudioEncode(CHANNEL));
    player.handleMediaError();
    assert.equal(plays.length, 0);
    assert.equal(player.needsAudioEncode(CHANNEL), false, 'a flag that did not help must not stick');
    assert.equal(store.get('pigtv_audio_encode'), '[]');
});

test('a channel that needed it is asked for with the re-encode next time, and others are not', async () => {
    const { player, fetched } = makePlayer();
    player.rememberAudioEncode(CHANNEL, true);
    await player.resolvePlayback(CHANNEL, 'http://provider.invalid/live/u/p/1.ts');
    assert.equal(fetched[0].body.audioEncode, true);
    assert.equal(fetched[0].body.channelId, 'm3u_1_pos_9');

    await player.resolvePlayback({ sourceId: 1, id: 'm3u_1_pos_10' }, 'http://provider.invalid/live/u/p/2.ts');
    assert.equal(fetched[1].body.audioEncode, false, 'an unrelated channel is untouched');

    await player.resolvePlayback({ sourceId: 1, id: 'm3u_1_pos_10' }, 'x', { audioEncode: true });
    assert.equal(fetched[2].body.audioEncode, true, 'and it can be requested explicitly (the retry)');
});

test('the memory is bounded, tolerant of damaged storage, and can be switched off per channel', () => {
    const { player, store } = makePlayer();
    for (let i = 0; i < 250; i++) player.rememberAudioEncode({ sourceId: 1, id: `c${i}` }, true);
    assert.equal(JSON.parse(store.get('pigtv_audio_encode')).length, 200);
    assert.equal(player.needsAudioEncode({ sourceId: 1, id: 'c0' }), false, 'the oldest fell off');
    assert.equal(player.needsAudioEncode({ sourceId: 1, id: 'c249' }), true);
    player.rememberAudioEncode({ sourceId: 1, id: 'c249' }, false);
    assert.equal(player.needsAudioEncode({ sourceId: 1, id: 'c249' }), false);

    store.set('pigtv_audio_encode', '{not json');
    assert.equal(player.loadAudioEncodeChannels().length, 0);
    assert.equal(player.needsAudioEncode(CHANNEL), false);
    assert.equal(player.needsAudioEncode(null), false, 'no channel, no key, no request');
});
