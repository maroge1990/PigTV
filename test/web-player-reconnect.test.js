const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLivePlayer } = require('./helpers/livePlayer');

// #321 (1): the web player's lasting reconnect, on the Apple model (PlaybackModel.swift #5/#6): once a play has shown a
// picture, a stall of 35 s (the picture not moving while not paused), an end, or a fatal error is a failure; up to three
// reconnects in 10 minutes follow, after 0, 3 and 10 s, with "Reconnecting…" on screen; each re-resolves through the same
// play path (a new session, the old one given back, a session taken over by another device is not taken back); after
// that the error has a Try again button. Before #321 one retry was made, a frozen picture was never noticed, and the
// error had no Try again.
// The real VideoPlayer script, built by its constructor over the fake DOM, with its own event wiring (helpers/livePlayer).

const SEVEN = { id: '7', sourceId: 1, name: 'Seven News' };
const NINE = { id: '9', sourceId: 1, name: 'Nine' };

async function playingSeven(opts) {
    const h = makeLivePlayer(opts);
    await h.ready();
    await h.player.play(SEVEN, null);
    await h.clock.flush();
    await h.plays(2);
    return h;
}
const reconnectBox = (h) => h.container.querySelector('.player-reconnecting');
const showing = (node) => !!node && !node.classList.contains('hidden');

test('a picture frozen for 35 s while playing is a failure: Reconnecting…, the old session given back, a fresh resolve', async () => {
    const h = await playingSeven();
    assert.equal(h.resolvesMade().length, 1);
    await h.clock.advance(33000);                 // frozen 33 s: an ordinary wait
    assert.equal(h.resolvesMade().length, 1, 'not yet: under 35 s');
    assert.equal(showing(reconnectBox(h)), false);
    await h.clock.advance(3000);                  // 36 s
    assert.equal(h.resolvesMade().length, 2, 'the server is asked again');
    assert.equal(h.resolvesMade()[1].body.force, false, 'never forced: a viewer that took it over is asked first (409)');
    assert.equal(h.resolvesMade()[1].body.channelId, '7');
    assert.ok(h.requests.some(r => r.url === '/api/playback/s1/terminal-status'), 'the server is asked whether the dead session was taken over');
    assert.deepEqual(h.deletes(), ['/api/transcode/s1'], 'the dead session is given back');
    assert.equal(h.player.currentSessionId, 's2', 'the new session, never the dead one');
    assert.ok(showing(reconnectBox(h)), '"Reconnecting…" stays up until a picture is back');
    assert.match(reconnectBox(h).textContent, /Reconnecting…/);
    assert.equal(reconnectBox(h).getAttribute('role'), 'status');
    await h.plays(1);
    assert.equal(showing(reconnectBox(h)), false, 'gone once the picture is back');
});

test('a waiting player (time not moving, not paused) and the frozen frame that still says "playing" are both stalls', async () => {
    const h = await playingSeven();
    h.fire('waiting');
    await h.clock.advance(36000);
    assert.equal(h.resolvesMade().length, 2);
});

test('paused, or a hidden tab, is not a stall', async () => {
    const h = await playingSeven();
    h.video.paused = true;
    h.fire('pause');
    await h.clock.advance(120000);
    assert.equal(h.resolvesMade().length, 1, 'a pause is the viewer\'s');
    h.video.paused = false;
    h.document.hidden = true;
    await h.clock.advance(120000);
    assert.equal(h.resolvesMade().length, 1, 'a background tab is not timed');
    h.document.hidden = false;
    await h.clock.advance(36000);
    assert.equal(h.resolvesMade().length, 2, 'back in view and still frozen: now it is one');
});

test('the waits grow (0, 3, 10 s); a fourth failure in 10 minutes is the error, with Try again; Try again starts afresh', async () => {
    const h = await playingSeven();
    const fail = async () => { h.fire('ended'); await h.clock.advance(0); };

    await fail();                                 // 1st: straight away
    assert.equal(h.resolvesMade().length, 2);
    await h.plays(1);

    await fail();                                 // 2nd: after 3 s
    await h.clock.advance(2000);
    assert.equal(h.resolvesMade().length, 2, 'still waiting');
    assert.ok(showing(reconnectBox(h)), 'Reconnecting… while it waits');
    await h.clock.advance(1500);
    assert.equal(h.resolvesMade().length, 3);
    await h.plays(1);

    await fail();                                 // 3rd: after 10 s
    await h.clock.advance(9000);
    assert.equal(h.resolvesMade().length, 3);
    await h.clock.advance(1500);
    assert.equal(h.resolvesMade().length, 4);
    await h.plays(1);

    await fail();                                 // 4th in the window: the error
    await h.clock.advance(30000);
    assert.equal(h.resolvesMade().length, 4, 'no fifth resolve');
    assert.equal(h.player._playing, false);
    assert.ok(h.deletes().includes('/api/transcode/s4'), 'the last session is given back, not held while the error shows');
    assert.equal(showing(reconnectBox(h)), false);
    assert.equal(showing(h.overlay), true);
    assert.match(h.overlay.textContent, /The stream ended\. Try again to reconnect\./);
    const retry = h.overlay.querySelector('.player-retry-btn');
    assert.ok(retry, 'the error has a Try again button');
    assert.equal(retry.textContent, 'Try again');
    retry.click();
    await h.clock.flush();
    assert.equal(h.resolvesMade().length, 5, 'Try again resolves the same channel');
    await h.plays(1);
    await fail();
    assert.equal(h.resolvesMade().length, 6, 'and has a whole new budget: its first reconnect is immediate');
});

test('the window is 10 minutes: failures spread out over hours keep reconnecting', async () => {
    const h = await playingSeven();
    for (let i = 0; i < 6; i++) {
        h.fire('ended');
        await h.clock.advance(11000);
        await h.plays(1);
        h.video.paused = true;                    // the hours between: watched, not timed here
        await h.clock.advance(11 * 60000);
        h.video.paused = false;
    }
    assert.equal(h.resolvesMade().length, 7);
    assert.equal(h.player._playing, true);
});

test('a session taken over by another device is not taken back: the player stops and says so', async () => {
    const h = await playingSeven({ terminal: (sid) => (sid === 's1' ? 'taken-over' : 'none') });
    await h.clock.advance(36000);
    assert.equal(h.resolvesMade().length, 1, 'no new resolve');
    assert.equal(h.player._playing, false);
    assert.equal(showing(reconnectBox(h)), false);
    assert.match(h.overlay.textContent, /Playback moved to another device\./);
    assert.equal(h.overlay.querySelector('.player-retry-btn'), null, 'no Try again that would take it straight back (as Apple)');
    assert.ok(h.deletes().includes('/api/transcode/s1'), 'released all the same');
});

test('a fatal hls.js error after the picture is a failure too (the 404 a stopped session gives), every time, not once', async () => {
    const h = await playingSeven();
    for (const n of [2, 3]) {
        h.FakeHls.instances.at(-1).emit('error', { fatal: true, type: 'networkError', details: 'levelLoadError', response: { code: 404 } });
        await h.clock.advance(3500);
        assert.equal(h.resolvesMade().length, n);
        assert.equal(h.player.currentSessionId, `s${n}`);
        await h.plays(1);
    }
});

test('Stop, a newer channel, or pagehide while a reconnect waits: the reconnect is cancelled', async () => {
    for (const how of ['stop', 'newer', 'pagehide']) {
        const h = await playingSeven();
        h.fire('ended');                          // 1st reconnect, immediate
        await h.clock.advance(0);
        await h.plays(1);
        h.fire('ended');                          // 2nd waits 3 s
        await h.clock.advance(0);
        assert.equal(h.resolvesMade().length, 2);
        if (how === 'stop') h.player.stop();
        if (how === 'newer') await h.player.play(NINE, null);
        if (how === 'pagehide') h.windowListeners.pagehide.forEach(fn => fn({ type: 'pagehide' }));
        assert.equal(showing(reconnectBox(h)), false, `${how}: Reconnecting… goes`);
        await h.clock.advance(20000);
        const channels = h.resolvesMade().map(r => r.body.channelId);
        assert.deepEqual(channels, how === 'newer' ? ['7', '7', '9'] : ['7', '7'], `${how}: no reconnect of the old play`);
    }
});

test('a reconnect whose resolve fails for a passing reason tries again within the budget; a lasting one is shown at once', async () => {
    let n = 0;
    const h = await playingSeven({ resolve: (i) => {
        n = i;
        if (i === 1 || i === 3) return { status: 200, body: { strategy: 'transcode', container: 'hls', url: `/api/transcode/s${i}/master.m3u8`, sessionId: `s${i}` } };
        if (i === 2) return { status: 503, body: { error: 'The provider did not respond.' } };
        return { status: 404, body: { error: 'This channel is not available.' } };
    } });
    h.fire('ended');
    await h.clock.advance(0);                     // 1st: the resolve fails (503) ...
    await h.clock.advance(3500);                  // ... and is tried again after the 2nd wait
    assert.equal(n, 3);
    assert.equal(h.player.currentSessionId, 's3');
    await h.plays(1);
    h.fire('ended');
    await h.clock.advance(11000);                 // 3rd: 404, not available: no more tries
    assert.equal(n, 4);
    await h.clock.advance(60000);
    assert.equal(n, 4);
    assert.match(h.overlay.textContent, /^The stream ended\. This channel is not available\./);
    assert.ok(h.overlay.querySelector('.player-retry-btn'));
});

test('before any picture: one retry, as before (0102), then the error now has Try again', async () => {
    const h = makeLivePlayer();
    await h.ready();
    await h.player.play(SEVEN, null);
    await h.clock.advance(60000);                 // autoplay refused: paused, nothing timed
    assert.equal(h.resolvesMade().length, 1);
    h.FakeHls.instances.at(-1).emit('manifest');  // it plays, but no picture ever comes
    await h.clock.advance(36000);
    assert.equal(h.resolvesMade().length, 2, 'one retry, straight away');
    h.FakeHls.instances.at(-1).emit('manifest');
    await h.clock.advance(36000);
    assert.equal(h.resolvesMade().length, 2, 'never a loop');
    assert.match(h.overlay.textContent, /could not start playing/);
    assert.ok(h.overlay.querySelector('.player-retry-btn'));
    assert.deepEqual(h.deletes(), ['/api/transcode/s1', '/api/transcode/s2'], 'neither session is held');
});
