const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Answering "no" to "another device is watching" must stop the play outright.
// It used to return null, which play() cannot tell apart from "this server has no
// resolve endpoint" - so it fell through to the local strategy, which starts a
// transcode session, and POST /api/transcode/session admits in SOFT mode: it
// reclaims the other viewer's stream silently, with no second prompt. Cancelling
// therefore did exactly what cancelling was meant to prevent.

const CHANNEL = { sourceId: 1, id: 'm3u_1_pos_9' };
const CONFLICT = {
    error: 'Provider stream is in use',
    conflict: {
        type: 'viewer-in-progress', streamId: 'abc123', lastActiveSec: 4,
        message: 'Another device is watching. Your provider allows one stream at a time, so watching here will stop it.'
    },
    resolution: 'Repeat this request with "force": true to stop the other stream and watch.'
};

// The real player script in a bare context. `answer` is what the person clicks;
// `unavailable` models an older server with no resolve endpoint.
function makePlayer({ answer = false, unavailable = false } = {}) {
    const resolveCalls = [];
    const context = vm.createContext({
        window: {}, URL, console: { ...console, error() {}, warn() {}, log() {} },
        localStorage: { getItem: () => null, setItem() {} },
        confirm: () => answer,
        fetch: async (url, opts) => {
            const body = JSON.parse(opts.body);
            resolveCalls.push(body);
            if (unavailable) return { status: 404, ok: false, json: async () => ({ error: 'No such API endpoint' }) };
            // The server answers 409 until the caller says force:true.
            if (!body.force) return { status: 409, ok: false, json: async () => CONFLICT };
            return { status: 200, ok: true, json: async () => ({ strategy: 'remux', url: '/api/remux?x=1' }) };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);

    const classList = () => {
        const set = new Set();
        return { set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
    };
    const overlay = classList();
    const controlsOverlay = classList();
    const loadingSpinner = classList();
    overlay.add('hidden');          // a play is starting, so the "select a channel" overlay is hidden
    loadingSpinner.add('show');

    const played = [];
    const localStrategy = [];
    const player = Object.create(context.window.VideoPlayer.prototype);
    Object.assign(player, {
        video: { canPlayType: () => '' },
        overlay: { classList: overlay }, controlsOverlay: { classList: controlsOverlay },
        loadingSpinner: { classList: loadingSpinner },
        settings: { autoTranscode: true },
        // hlsDeliveryEnabled is a prototype getter reading localStorage - left alone
        // so it answers false here, the same as a browser that has not opted in.
        getCodecCapabilities: () => ({}),
        needsAudioEncode: () => false,
        updateTranscodeStatus() {},
        beginPlayMeasurement() { this._playT0 = 1; this._playMeta = {}; },
        stop() {},
        playDecision: async (decision) => { played.push(decision); },
        // Everything below here is the local fallback path. If the cancel reaches any
        // of it, the bug is back: this is what takes the other viewer's stream.
        startTranscodeSession: async (...a) => { localStrategy.push(['session', ...a]); return '/x.m3u8'; },
        capabilityQueryString: () => { localStrategy.push(['probe']); return ''; },
    });
    return { player, played, localStrategy, resolveCalls, overlay, controlsOverlay, loadingSpinner, context };
}

test('cancelling the takeover prompt stops the play - it does not fall through to the local strategy', async () => {
    const { player, played, localStrategy, resolveCalls } = makePlayer({ answer: false });

    await player.play(CHANNEL, 'http://provider.invalid/live/u/p/1.ts');

    assert.equal(played.length, 0, 'nothing is played');
    assert.deepEqual(localStrategy, [], 'and the local fallback - which would take the stream anyway - never runs');
    assert.equal(resolveCalls.length, 1, 'the server is asked once and not re-asked with force');
    assert.equal(resolveCalls[0].force, false);
});

test('cancelling puts the screen back rather than leaving a spinner over a dead player', async () => {
    const { player, overlay, controlsOverlay, loadingSpinner } = makePlayer({ answer: false });

    await player.play(CHANNEL, 'http://provider.invalid/live/u/p/1.ts');

    assert.equal(loadingSpinner.contains('show'), false, 'the spinner is gone');
    assert.equal(overlay.contains('hidden'), false, '"select a channel" is shown again');
    assert.equal(controlsOverlay.contains('hidden'), true, 'the transport controls are hidden');
    assert.equal(player._playT0, null, 'and the half-started measurement is dropped, so no play-start is reported');
});

test('confirming still takes over, exactly as before', async () => {
    const { player, played, resolveCalls } = makePlayer({ answer: true });

    await player.play(CHANNEL, 'http://provider.invalid/live/u/p/1.ts');

    assert.equal(played.length, 1, 'the stream plays');
    assert.equal(resolveCalls.length, 2, 'asked again');
    assert.equal(resolveCalls[1].force, true, 'the second ask carries force:true');
});

test('null keeps its other meaning: an older server still falls through to the local strategy', async () => {
    const { player, context } = makePlayer({ unavailable: true });

    const decision = await player.resolvePlayback(CHANNEL, 'http://provider.invalid/live/u/p/1.ts');

    assert.equal(decision, null, 'a 404 is still null, not the cancel sentinel');
    assert.notEqual(decision, context.window.VideoPlayer.CANCELLED);
});
