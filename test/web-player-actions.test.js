const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeLivePlayer } = require('./helpers/livePlayer');
const { FakeEvent } = require('./helpers/fakeDom');

// #321 (2): the web player gains the Apple player's actions (CustomPlayer.swift: Favourite, Record, Audio & subtitles,
// Go to live, Last channel, in that order): Favourite toggles through the channel list, Record schedules the programme
// on air now through the Guide's schedule call, Last channel jumps back (button and the L / Backspace key, Live TV
// only), and an Audio button appears only when the stream has more than one audio track.
// The real VideoPlayer script, built by its constructor over the fake DOM (helpers/livePlayer).

const SEVEN = { id: '7', sourceId: 1, name: 'Seven News', tvgLogo: 'https://logos.example/7.png' };
const NINE = { id: '9', sourceId: 1, name: 'Nine' };

function actionsDom(document, { container, controls, el }) {
    const button = (id, cls = 'watch-btn') => el('button', { id, className: cls, parent: controls });
    const fav = button('btn-favourite');
    el('svg', { className: 'icon icon-fav-off', parent: fav });
    el('svg', { className: 'icon icon-fav-on hidden', parent: fav });
    button('btn-record');
    const wrapper = el('div', { id: 'player-audio-wrapper', className: 'watch-captions-wrapper hidden', parent: controls });
    el('button', { id: 'btn-audio', className: 'watch-btn', parent: wrapper });
    const menu = el('div', { id: 'player-audio-menu', className: 'watch-captions-menu hidden', parent: wrapper });
    el('div', { id: 'player-audio-list', parent: menu });
    button('btn-last-channel', 'watch-btn hidden');
}

async function harness({ page = 'live', favourites = [], programme, schedule } = {}) {
    const h = makeLivePlayer({ page, extraDom: actionsDom });
    const favs = new Set(favourites);
    const flags = { failFavourite: false };
    const toggles = [];
    const selected = [];
    const scheduled = [];
    h.context.app.channelList = {
        isFavorite: (sourceId, id) => favs.has(`${sourceId}:${id}`),
        toggleFavorite: async (sourceId, id) => { toggles.push(`${sourceId}:${id}`); if (!flags.failFavourite) { const k = `${sourceId}:${id}`; favs.has(k) ? favs.delete(k) : favs.add(k); } },
        findChannel: (sourceId, id) => [SEVEN, NINE].find(c => c.id === String(id)),
        selectChannel: (d) => { selected.push(d); h.player.play([SEVEN, NINE].find(c => c.id === d.channelId), null); }
    };
    h.context.app.epgGuide = { getCurrentProgramFor: () => (programme === undefined ? null : programme) };
    h.context.API.recordings = { schedule: async (body) => { scheduled.push(body); if (schedule) return schedule(body); return { id: 1 }; } };
    await h.ready();
    const $ = (id) => h.document.getElementById(id);
    const notice = () => h.container.querySelector('.player-notice');
    const key = (k) => { const e = new FakeEvent('keydown', { key: k, target: { closest: () => null } }); h.document.listeners.keydown.forEach(fn => fn(e)); return e; };
    return { ...h, flags, favs, toggles, selected, scheduled, $, notice, key };
}

test('the controls carry the actions in the Apple order, each a labelled button', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const bar = html.slice(html.indexOf('id="btn-stop"'), html.indexOf('<div class="watch-spacer">'));
    const order = ['btn-favourite', 'btn-record', 'btn-audio', 'btn-go-live', 'btn-last-channel'].map(id => bar.indexOf(`id="${id}"`));
    assert.ok(order.every(i => i > 0), 'all five sit between Stop and the spacer');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'Favourite, Record, Audio, Go to live, Last channel');
    for (const [id, label] of [['btn-favourite', 'Favourite'], ['btn-record', 'Record this programme'], ['btn-audio', 'Audio'], ['btn-last-channel', 'Last channel']]) {
        assert.match(html, new RegExp(`id="${id}" title="[^"]+" aria-label="${label}"`), id);
    }
    assert.match(html, /id="player-audio-wrapper"[^>]*|class="watch-captions-wrapper hidden" id="player-audio-wrapper"/, 'Audio starts hidden');
    assert.match(html, /class="watch-btn hidden" id="btn-last-channel"/, 'Last channel starts hidden');
});

test('Favourite toggles the playing channel through the channel list, and says so', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    const fav = h.$('btn-favourite');
    assert.equal(fav.getAttribute('aria-pressed'), 'false');
    assert.equal(fav.getAttribute('aria-label'), 'Favourite');
    fav.click();
    await h.clock.flush();
    assert.deepEqual(h.toggles, ['1:7']);
    assert.equal(fav.getAttribute('aria-pressed'), 'true');
    assert.equal(fav.getAttribute('aria-label'), 'Unfavourite');
    assert.equal(fav.querySelector('.icon-fav-on').classList.contains('hidden'), false);
    assert.equal(h.notice().textContent, 'Added to favourites');
    assert.equal(h.notice().getAttribute('role'), 'status');
    fav.click();
    await h.clock.flush();
    assert.equal(h.notice().textContent, 'Removed from favourites');
    assert.equal(fav.getAttribute('aria-pressed'), 'false');
    h.flags.failFavourite = true;
    fav.click();
    await h.clock.flush();
    assert.equal(h.notice().textContent, 'Could not update favourites.');
    await h.clock.advance(9000);
    assert.equal(h.notice().classList.contains('hidden'), true, 'the notice goes by itself');
});

test('the Favourite button shows the channel\'s state when it starts playing', async () => {
    const h = await harness({ favourites: ['1:9'] });
    await h.player.play(SEVEN, null);
    assert.equal(h.$('btn-favourite').getAttribute('aria-pressed'), 'false');
    await h.player.play(NINE, null);
    assert.equal(h.$('btn-favourite').getAttribute('aria-pressed'), 'true');
});

test('Record schedules the programme on air now with the Guide\'s call (default buffers), and says so', async () => {
    const now = Date.now();
    const footy = { title: 'Footy', description: 'Round 1', startMs: now - 600000, stopMs: now + 3000000 };
    const h = await harness({ programme: footy });
    await h.player.play(SEVEN, null);
    h.$('btn-record').click();
    await h.clock.flush();
    assert.equal(h.scheduled.length, 1);
    assert.deepEqual({ ...h.scheduled[0] }, {
        sourceId: 1, channelItemId: '7', channelName: 'Seven News', channelLogo: 'https://logos.example/7.png',
        title: 'Footy', description: 'Round 1', programStart: footy.startMs, programEnd: footy.stopMs
    });
    assert.equal(h.notice().textContent, 'Recording scheduled: Footy');
});

test('Record says a clash at once, an error in the server\'s words, and that there is nothing to record with no guide', async () => {
    const now = Date.now();
    const footy = { title: 'Footy', startMs: now - 1000, stopMs: now + 1000000 };
    let h = await harness({ programme: footy, schedule: () => ({ id: 2, conflictsWith: [{ id: 1 }] }) });
    await h.player.play(SEVEN, null);
    h.$('btn-record').click();
    await h.clock.flush();
    assert.match(h.notice().textContent, /^Recording scheduled: Footy\. It clashes with 1 other recording \(see Recordings\)/);

    h = await harness({ programme: footy, schedule: () => { throw Object.assign(new Error('The recordings folder is full.'), { status: 400 }); } });
    await h.player.play(SEVEN, null);
    h.$('btn-record').click();
    await h.clock.flush();
    assert.equal(h.notice().textContent, 'Could not schedule the recording. The recordings folder is full.', 'the server\'s own sentence, as the Guide shows it');
    assert.ok(h.notice().classList.contains('player-notice-error'));

    h = await harness();
    await h.player.play(SEVEN, null);
    h.$('btn-record').click();
    await h.clock.flush();
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.notice().textContent, 'No programme information to record.');
});

test('Last channel: hidden until there is one, then jumps back (button, L or Backspace on Live TV), and the two swap', async () => {
    const h = await harness();
    const last = h.$('btn-last-channel');
    await h.player.play(SEVEN, null);
    assert.equal(last.classList.contains('hidden'), true, 'nothing to go back to');
    assert.equal(h.key('l').defaultPrevented, false, 'the key does nothing then');
    await h.player.play(NINE, null);
    assert.equal(last.classList.contains('hidden'), false);
    assert.equal(last.getAttribute('aria-label'), 'Last channel: Seven News');
    last.click();
    await h.clock.flush();
    assert.deepEqual({ ...h.selected[0] }, { channelId: '7', sourceId: 1 }, 'selected in the list, so the list and the player agree');
    assert.equal(h.player.currentChannel, SEVEN);
    assert.equal(last.getAttribute('aria-label'), 'Last channel: Nine', 'and the two swap');
    assert.equal(h.key('l').defaultPrevented, true);
    await h.clock.flush();
    assert.equal(h.player.currentChannel, NINE);
    h.key('Backspace');
    await h.clock.flush();
    assert.equal(h.player.currentChannel, SEVEN);
});

test('a reconnect or Try again is not a channel change: Last channel stays the one before', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.player.play(NINE, null);
    await h.plays(1);
    h.fire('ended');
    await h.clock.advance(0);
    assert.equal(h.player.previousChannel(), SEVEN);
});

test('Ctrl/Cmd/Alt+L stay the browser\'s (the address bar): only a bare L is Last channel', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.player.play(NINE, null);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
        const e = new FakeEvent('keydown', { key: 'l', [mod]: true, target: { closest: () => null } });
        h.document.listeners.keydown.forEach(fn => fn(e));
        assert.equal(e.defaultPrevented, false, mod);
    }
    await h.clock.flush();
    assert.equal(h.player.currentChannel, NINE);
});

test('on another page the L key does nothing', async () => {
    const h = await harness({ page: 'guide' });
    await h.player.play(SEVEN, null);
    await h.player.play(NINE, null);
    assert.equal(h.key('l').defaultPrevented, false);
    assert.equal(h.player.currentChannel, NINE);
});

test('Audio: hidden with one track; with two, a menu that marks the playing one and switches', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    const hls = h.FakeHls.instances.at(-1);
    const wrapper = h.$('player-audio-wrapper');
    hls.audioTracks = [{ name: 'English' }];
    hls.audioTrack = 0;
    hls.emit('audioTracks');
    assert.equal(wrapper.classList.contains('hidden'), true, 'one track: no choice, no button');
    hls.audioTracks = [{ name: 'English' }, { name: '', lang: 'fr' }];
    hls.emit('audioTracks');
    assert.equal(wrapper.classList.contains('hidden'), false);
    h.$('btn-audio').click();
    assert.equal(h.$('player-audio-menu').classList.contains('hidden'), false);
    assert.equal(h.$('btn-audio').getAttribute('aria-expanded'), 'true');
    const options = h.$('player-audio-list').querySelectorAll('button');
    assert.deepEqual(options.map(o => o.textContent), ['English', 'fr']);
    assert.deepEqual(options.map(o => o.getAttribute('aria-pressed')), ['true', 'false']);
    options[1].click();
    assert.equal(hls.audioTrack, 1);
    assert.equal(h.$('player-audio-menu').classList.contains('hidden'), true, 'the menu closes');
    assert.deepEqual(h.$('player-audio-list').querySelectorAll('button').map(o => o.getAttribute('aria-pressed')), ['false', 'true']);
});
