const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #320 (6): the clash prompts are a banner inside the player, not confirm(): same words, two buttons, the action and
// Cancel, resolving the same yes/no. Focus goes to the action, Escape cancels, a newer play or a stop cancels it.
// The real VideoPlayer script over a fake DOM (it does not prove painting, fullscreen or real focus: that is T3/T5).
const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');
const SEVEN = { id: '7', sourceId: 's1', name: 'Seven News' };

function harness({ page = 'live', responses = [] } = {}) {
    const document = createDocument();
    const container = document.createElement('div');
    container.className = 'video-container';
    document.body.appendChild(container);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const fetched = [];
    const confirms = [];
    const context = vm.createContext({
        document, navigator: {}, console: { ...console, log() {}, warn() {}, error() {} },
        confirm: (m) => { confirms.push(m); return true; },
        fetch: (url, init) => {
            fetched.push([url, init && init.body ? JSON.parse(init.body) : null]);
            const next = responses.shift() || { status: 200, body: { url: '/x', strategy: 'direct' } };
            return Promise.resolve({ ok: next.status < 400, status: next.status, json: () => Promise.resolve(next.body) });
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
    });
    context.window = context;
    context.app = { currentPage: page };
    vm.runInContext(SOURCE, context);
    const VideoPlayer = vm.runInContext('VideoPlayer', context);
    const player = Object.create(VideoPlayer.prototype);
    Object.assign(player, {
        container, settings: {}, _playGeneration: 1, currentUrl: 'u', currentChannel: SEVEN,
        video: { paused: false, canPlayType: () => '', pause() {}, load() {}, src: '' },
        overlay: document.createElement('div'), nowPlaying: { classList: { add() {}, remove() {} } },
        getCodecCapabilities: () => ({}), needsAudioEncode: () => false, updateTranscodeStatus() {},
        reportPlayEnd() {}, clearStartWatch() {}, stopTranscodeSession() {}, stopConflictWatch() {}, renderIdleOverlay() {}, updateTabTitle() {}
    });
    const banner = () => container.querySelector('.player-prompt');
    const press = (el, key) => el.dispatchEvent(new FakeEvent('keydown', { key, stopPropagation() {} }));
    return { context, VideoPlayer, player, container, document, fetched, confirms, banner, press, opener };
}

const CLASH = { status: 409, body: { conflict: { type: 'recording-in-progress', message: 'A recording is using the only stream.' } } };
const VIEWER = { status: 409, body: { conflict: { type: 'viewer-in-progress', message: 'Another device is watching.' } } };
const tick = () => new Promise(r => setImmediate(r));

test('a clash shows a banner in the player with the old words and two buttons, no confirm()', async () => {
    const { player, banner, confirms, document } = harness({ responses: [CLASH] });
    const pending = player.resolvePlayback(SEVEN, null);
    await tick();
    const b = banner();
    assert.ok(b, 'a banner is inside the player');
    assert.equal(b.getAttribute('role'), 'alertdialog');
    assert.ok(b.getAttribute('aria-label'));
    assert.equal(b.querySelector('.player-prompt-message').textContent, 'A recording is using the only stream.\n\nStop the recording and watch now?');
    const [primary, cancel] = b.querySelectorAll('button');
    assert.ok(primary.classList.contains('btn-primary') && cancel.textContent === 'Cancel');
    assert.equal(document.activeElement, primary, 'focus moves to the action');
    cancel.click();
    assert.equal(await pending, player.constructor.CANCELLED);
    assert.equal(banner(), null);
    assert.deepEqual(confirms, []);
});

test('the action takes the stream over (the retry is forced), for a recording and for another viewer', async () => {
    for (const [clash, words] of [[CLASH, 'Stop the recording and watch now?'], [VIEWER, 'Stop the other stream and watch here?']]) {
        const { player, banner, fetched } = harness({ responses: [clash] });
        const pending = player.resolvePlayback(SEVEN, null);
        await tick();
        assert.match(banner().querySelector('.player-prompt-message').textContent, new RegExp(words.replace('?', '\\?')));
        banner().querySelector('.btn-primary').click();
        const decision = await pending;
        assert.equal(decision.url, '/x');
        assert.equal(fetched.length, 2);
        assert.equal(fetched[1][1].force, true);
    }
});

test('Escape cancels the question', async () => {
    const { player, banner, press } = harness({ responses: [CLASH] });
    const pending = player.resolvePlayback(SEVEN, null);
    await tick();
    press(banner().querySelector('.btn-primary'), 'Escape');
    assert.equal(await pending, player.constructor.CANCELLED);
    assert.equal(banner(), null);
});

test('a newer play (or a stop) cancels a pending banner and that play says nothing', async () => {
    const { player, banner } = harness({ responses: [CLASH] });
    const pending = player.resolvePlayback(SEVEN, null);
    await tick();
    assert.ok(banner());
    player.stop();
    assert.equal(await pending, player.constructor.SUPERSEDED);
    assert.equal(banner(), null);
});

test('focus goes back to where it was when the question is answered', async () => {
    const { player, banner, document, opener } = harness({ responses: [CLASH] });
    const pending = player.resolvePlayback(SEVEN, null);
    await tick();
    assert.notEqual(document.activeElement, opener);
    banner().querySelector('.btn-secondary').click();
    await pending;
    assert.equal(document.activeElement, opener);
});

test('the recording-due question is the same banner: yes stops watching, no declines', async () => {
    const due = { status: 200, body: { scheduleId: 3, message: 'Football is about to record.', startsInSec: 300 } };
    const a = harness({ responses: [due] });
    let stopped = 0;
    a.player.stop = async () => { stopped++; };
    const done = a.player.checkConflict();
    await tick();
    assert.equal(a.banner().querySelector('.player-prompt-message').textContent,
        'Football is about to record.\n\nIt is due in about 5 minutes.\n\nStop watching so it can record?');
    a.banner().querySelector('.btn-primary').click();
    await done;
    assert.equal(stopped, 1);
    assert.deepEqual(a.confirms, []);

    const b = harness({ responses: [due, { status: 200, body: {} }] });
    const done2 = b.player.checkConflict();
    await tick();
    b.banner().querySelector('.btn-secondary').click();
    await done2;
    assert.ok(b.fetched.some(([url, body]) => url === '/api/playback/conflict/decline' && body.scheduleId === 3));
});

test('a recording-due question that went away because playback moved on is not a decline', async () => {
    const due = { status: 200, body: { scheduleId: 3, message: 'Football is about to record.', startsInSec: 300 } };
    const h = harness({ responses: [due] });
    const done = h.player.checkConflict();
    await tick();
    h.player.stop();
    await done;
    assert.ok(!h.fetched.some(([url]) => url === '/api/playback/conflict/decline'));
    assert.equal(h.player._promptedFor, null, 'it will be asked again');
});

test('on a page where the player is hidden the browser still asks (the person must see it)', async () => {
    const h = harness({ page: 'guide' });
    const answer = await h.player.askInPlayer({ message: 'm', confirmLabel: 'Yes' });
    assert.equal(answer, true);
    assert.deepEqual(h.confirms, ['m']);
    assert.equal(h.banner(), null);
});

test('leaving Live TV takes the recording-due banner away without declining, and the next check asks again', async () => {
    const due = { status: 200, body: { scheduleId: 3, message: 'Football is about to record.', startsInSec: 300 } };
    const h = harness({ responses: [due, due] });
    const done = h.player.checkConflict();
    await tick();
    assert.ok(h.banner());
    h.player.abandonPrompt();
    await done;
    assert.equal(h.banner(), null);
    assert.ok(!h.fetched.some(([url]) => url === '/api/playback/conflict/decline'), 'not a decline');
    assert.equal(h.player._promptedFor, null, 'asked again at the next check');
    h.context.app.currentPage = 'guide';
    await h.player.checkConflict();
    assert.equal(h.confirms.length, 1, 'the player is hidden: the browser asks');
});

test('leaving Live TV cancels a pending clash banner (resolves no)', async () => {
    const { player, banner } = harness({ responses: [CLASH] });
    const pending = player.resolvePlayback(SEVEN, null);
    await tick();
    player.abandonPrompt();
    assert.equal(await pending, player.constructor.CANCELLED);
    assert.equal(banner(), null);
});
