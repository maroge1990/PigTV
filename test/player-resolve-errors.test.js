const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #60 (AUD-WEB-5): the web player threw the server's resolve error away (`if (!res.ok) return null`), asked again
// for every failure, and showed one generic sentence; a 401 (the web sign-in lasts 24 h) looked the same. Now the
// server's sentence (C-B) is shown, a channel that is not available is not asked for again, and a 401 goes to sign-in.
function playerWith(answer) {
    const calls = [];
    const location = { href: '/' };
    const storage = { authToken: 'tok' };
    const context = vm.createContext({
        window: { Hls: null, location }, URL, console: { ...console, warn() {}, error() {}, log() {} },
        setTimeout: () => 0, clearTimeout: () => {}, confirm: () => false, Symbol, Promise, JSON,
        localStorage: { getItem: (k) => storage[k] ?? null, removeItem: (k) => { delete storage[k]; } },
        fetch: async (url, init) => { calls.push(url); const r = answer(calls.length); return { ok: r.status < 300, status: r.status, json: async () => r.body }; }
    });
    context.window.location = location;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    const errors = [];
    const player = Object.assign(Object.create(context.window.VideoPlayer.prototype), {
        video: { canPlayType: () => '' }, settings: {}, _playGeneration: 1,
        getCodecCapabilities: () => ({}), needsAudioEncode: () => false,
        showError: (m) => errors.push(m), loadingSpinner: null, updateTranscodeStatus() {}, releaseSession() {},
        channelKey: () => '1:pos_1', currentChannel: { sourceId: 1, id: 'pos_1' }, currentStreamUrl: null
    });
    return { player, calls, errors, location, storage, VideoPlayer: context.window.VideoPlayer };
}

test('#60: the server\'s sentence is kept; a channel that is not available is not asked for again', async () => {
    const { player, VideoPlayer } = playerWith(() => ({ status: 404, body: { error: 'This channel is not available. It may have been removed from the playlist; a playlist sync may help.' } }));
    const r = await player.resolvePlayback({ sourceId: 1, id: 'pos_1' }, null, { generation: 1 });
    assert.ok(r && r.failed, 'a failure the player can read');
    assert.match(r.message, /^This channel is not available/);
    assert.equal(r.retry, false, 'never asked again');
    assert.equal(VideoPlayer.retryable(503), true);
});

test('#60: a 401 sends the browser to sign-in', async () => {
    const { player, location, storage, VideoPlayer } = playerWith(() => ({ status: 401, body: { error: 'Invalid token' } }));
    const r = await player.resolvePlayback({ sourceId: 1, id: 'pos_1' }, null, { generation: 1 });
    assert.equal(r, VideoPlayer.SIGNED_OUT);
    assert.equal(location.href, '/login.html');
    assert.equal(storage.authToken, undefined);
});
