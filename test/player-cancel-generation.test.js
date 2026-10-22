const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// PB5 (22 Oct review, 0235): the web player's resolve belongs to one play(). stop() and a newer
// play() move a generation on (and abort the request): a late answer is then applied to nothing,
// no takeover prompt is shown for it, no forced retry is sent, and a session the server started
// for it is given back. The real VideoPlayer script, its real play() and stop(), with the DOM,
// media element and fetch stubbed. On 0234 the stop-then-late-success case played the old channel.

function makePlayer({ confirmAnswer = () => true, honourAbort = true } = {}) {
    const requests = [];   // { channelId, force, settle(status, body), signal }
    const deletes = [];
    const prompts = [];
    const context = vm.createContext({
        window: {}, URL, AbortController, console: { ...console, error() {}, warn() {}, log() {} },
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: () => null },
        confirm: (text) => { prompts.push(text); return confirmAnswer(); },
        fetch: (url, opts = {}) => {
            if (opts.method === 'DELETE') { deletes.push(url); return Promise.resolve({ ok: true, status: 200 }); }
            if (url !== '/api/playback/resolve') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            const body = JSON.parse(opts.body);
            return new Promise((resolve, reject) => {
                const entry = { channelId: body.channelId, force: body.force, signal: opts.signal,
                    settle: (status, json) => resolve({ status, ok: status >= 200 && status < 300, json: async () => json }) };
                if (honourAbort && opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                requests.push(entry);
            });
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    const cls = () => ({ add() {}, remove() {}, contains: () => false });
    const played = [];
    const player = Object.create(context.window.VideoPlayer.prototype);
    Object.assign(player, {
        video: { canPlayType: () => '', pause() {}, load() {}, src: '' },
        overlay: { classList: cls() }, controlsOverlay: { classList: cls() }, loadingSpinner: { classList: cls() },
        nowPlaying: { classList: cls() },
        settings: {},
        getCodecCapabilities: () => ({}),
        showError() {}, needsAudioEncode: () => false, updateTranscodeStatus() {},
        beginPlayMeasurement() {}, clearStartWatch() {}, reportPlayEnd() {}, stopConflictWatch() {},
        recoverPlayback: () => false,
        playDecision: async (decision, channel) => { played.push(channel.id); player.currentSessionId = decision.sessionId; }
    });
    return { player, requests, deletes, prompts, played };
}
const decision = (sid) => ({ strategy: 'transcode', url: `/api/transcode/${sid}/master.m3u8`, sessionId: sid });
const tick = () => new Promise(r => setImmediate(r));
const channel = (id) => ({ sourceId: 1, id });

test('PB5: stop while the resolve is pending - the request is aborted and nothing plays', async () => {
    const { player, requests, played } = makePlayer();
    const pending = player.play(channel('A'), null);
    await tick();
    player.stop();
    assert.equal(requests[0].signal.aborted, true, 'the request is aborted');
    await pending;
    assert.deepEqual(played, []);
});

test('PB5: stop while pending, and the answer arrives anyway - it is not played and its session is given back', async () => {
    const { player, requests, deletes, played } = makePlayer({ honourAbort: false });
    const pending = player.play(channel('A'), null);
    await tick();
    player.stop();
    requests[0].settle(200, decision('late-session'));
    await pending;
    assert.deepEqual(played, [], 'stop means stop');
    assert.deepEqual(deletes, ['/api/transcode/late-session'], 'the session the server started for it is released');
});

test('PB5: answers out of order - the newer selection keeps the screen; the older answer is released, not played', async () => {
    const { player, requests, deletes, played } = makePlayer({ honourAbort: false });
    const first = player.play(channel('A'), null);
    await tick();
    const second = player.play(channel('B'), null);
    await tick();
    requests[1].settle(200, decision('b-session'));
    await second;
    requests[0].settle(200, decision('a-session'));
    await first;
    assert.deepEqual(played, ['B']);
    assert.ok(deletes.includes('/api/transcode/a-session'));
    assert.ok(!deletes.includes('/api/transcode/b-session'), 'the newer session is untouched');
});

test('PB5: a stale 409 asks nothing and takes nothing over', async () => {
    const { player, requests, prompts, played } = makePlayer({ honourAbort: false });
    const first = player.play(channel('A'), null);
    await tick();
    const second = player.play(channel('B'), null);
    await tick();
    requests[0].settle(409, { conflict: { type: 'viewer-in-progress', message: 'Another device is watching.' } });
    await first;
    assert.deepEqual(prompts, [], 'no question about a channel nobody is waiting for');
    assert.equal(requests.filter(r => r.force).length, 0, 'no forced retry');
    requests[1].settle(200, decision('b-session'));
    await second;
    assert.deepEqual(played, ['B']);
});

test('PB5: stopped while the takeover question is up - "yes" then takes nothing over', async () => {
    let player;
    const made = makePlayer({ confirmAnswer: () => { player.stop(); return true; } });
    player = made.player;
    const pending = player.play(channel('A'), null);
    await tick();
    made.requests[0].settle(409, { conflict: { type: 'recording-in-progress', message: 'A recording is using the stream.' } });
    await pending;
    assert.equal(made.prompts.length, 1);
    assert.equal(made.requests.filter(r => r.force).length, 0, 'the forced request is never sent');
    assert.deepEqual(made.played, []);
});

test('PB5: the ordinary play still plays (its own stop does not invalidate it), and so does an answered takeover', async () => {
    const { player, requests, played, deletes } = makePlayer();
    const pending = player.play(channel('A'), null);
    await tick();
    requests[0].settle(409, { conflict: { type: 'viewer-in-progress', message: 'Another device is watching.' } });
    await tick(); await tick();
    assert.equal(requests[1].force, true);
    requests[1].settle(200, decision('a-session'));
    await pending;
    assert.deepEqual(played, ['A']);
    assert.deepEqual(deletes, []);
});
