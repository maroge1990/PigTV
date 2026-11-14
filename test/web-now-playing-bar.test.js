const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeLivePlayer } = require('./helpers/livePlayer');

// #321 (3): leaving Live TV keeps the stream playing out of sight (LivePage.hide()). A Now playing bar now says so on
// every other page: the channel and programme, Back to Live TV, and Stop (which gives the session back). It is a row of
// #app's column under <main>, so the page shrinks to make room rather than being covered.
// The real VideoPlayer and LivePage scripts over the fake DOM (helpers/livePlayer).

const SEVEN = { id: '7', sourceId: 1, name: 'Seven News' };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function barDom(document, { app, el }) {
    el('main', { className: 'main-content', parent: app });
    const bar = el('div', { id: 'now-playing-bar', className: 'now-playing-bar hidden', parent: app });
    el('span', { id: 'now-playing-bar-channel', parent: bar });
    el('span', { id: 'now-playing-bar-programme', parent: bar });
    el('button', { id: 'now-playing-bar-live', parent: bar });
    el('button', { id: 'now-playing-bar-stop', parent: bar });
}

async function harness() {
    const h = makeLivePlayer({ extraDom: barDom });
    const navigations = [];
    Object.assign(h.context.app, {
        player: h.player,
        navigateTo: (page) => { navigations.push(page); },
        channelList: { channels: [SEVEN], setEpgRefreshActive() {}, findChannel: () => SEVEN, selectChannel() {} },
        epgGuide: { loaded: true, ensureLoaded: async () => {}, refreshTick() {} }
    });
    vm.runInContext(read('js/pages/LivePage.js'), h.context);
    const live = new (vm.runInContext('LivePage', h.context))(h.context.app);
    await h.ready();
    const $ = (id) => h.document.getElementById(id);
    const barShowing = () => !$('now-playing-bar').classList.contains('hidden');
    // What navigateTo does around a page change: the old page's hide(), then the new page's show().
    const leaveLive = (to = 'guide') => { live.hide(); h.context.app.currentPage = to; };
    const backToLive = async () => { h.context.app.currentPage = 'live'; await live.show(); };
    return { ...h, live, navigations, $, barShowing, leaveLive, backToLive };
}

test('the bar is a row of the app\'s column under <main> (it pushes the page up), with Back to Live TV and Stop', () => {
    const html = read('index.html');
    const main = html.indexOf('</main>');
    const bar = html.indexOf('id="now-playing-bar"');
    const appEnd = html.indexOf('<!-- Context Menu Template -->');
    assert.ok(main > 0 && bar > main && bar < appEnd, 'after </main>, inside #app');
    assert.match(html, /class="now-playing-bar hidden" id="now-playing-bar" role="region" aria-label="Now playing"/);
    assert.match(html, /id="now-playing-bar-live">Back to Live TV</);
    assert.match(html, /id="now-playing-bar-stop"[^>]*aria-label="Stop \(ends the stream\)">Stop</);
    const css = read('css/player.css');
    assert.match(css, /\.now-playing-bar \{[^}]*flex: none;/, 'a flex row, not position: fixed over the page');
    assert.doesNotMatch(css.match(/\.now-playing-bar \{[^}]*\}/)[0], /position:\s*fixed/);
    assert.match(css.match(/\.now-playing-bar \{[^}]*\}/)[0], /safe-area-inset-bottom/, 'clear of the home indicator');
});

test('leaving Live TV while a channel plays shows the bar with the channel and programme; coming back hides it', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.plays(1);
    h.player.updateNowPlaying(SEVEN, { current: { title: 'Evening News', start: new Date(), stop: new Date() }, upcoming: [] });
    assert.equal(h.barShowing(), false, 'not on Live TV itself');
    h.leaveLive();
    assert.equal(h.barShowing(), true);
    assert.equal(h.$('now-playing-bar-channel').textContent, 'Seven News');
    assert.equal(h.$('now-playing-bar-programme').textContent, 'Evening News');
    assert.ok(h.document.body.classList.contains('has-now-playing-bar'), 'the notice pill keeps clear of it');
    assert.equal(h.player._playing, true, 'the stream keeps playing');
    await h.backToLive();
    assert.equal(h.barShowing(), false);
    assert.equal(h.document.body.classList.contains('has-now-playing-bar'), false);
});

test('Back to Live TV goes to Live TV; Stop gives the session back and the bar goes', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.plays(1);
    h.leaveLive('recordings');
    h.$('now-playing-bar-live').click();
    assert.deepEqual(h.navigations, ['live']);
    h.$('now-playing-bar-stop').click();
    assert.equal(h.player._playing, false);
    assert.deepEqual(h.deletes(), ['/api/transcode/s1'], 'the provider connection is given back');
    assert.equal(h.barShowing(), false);
});

test('nothing playing: no bar on other pages', async () => {
    const h = await harness();
    h.leaveLive();
    assert.equal(h.barShowing(), false);
    await h.backToLive();
    await h.player.play(SEVEN, null);
    h.player.stop();
    h.leaveLive();
    assert.equal(h.barShowing(), false, 'stopped before leaving');
});

test('away from Live TV: a reconnect says so in the bar; a play that ends for good is said where the person is', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.plays(1);
    h.leaveLive('guide');
    for (let i = 0; i < 3; i++) {
        h.fire('ended');
        await h.clock.advance(1);
        assert.equal(h.barShowing(), true, 'the bar stays through a reconnect');
        assert.equal(h.$('now-playing-bar-programme').textContent, 'Reconnecting…');
        await h.clock.advance(11000);
        await h.plays(1);
        assert.equal(h.$('now-playing-bar-programme').textContent, '', 'back to the programme (none known here)');
    }
    h.fire('ended');
    await h.clock.advance(1);
    assert.equal(h.barShowing(), false, 'out of attempts: stopped');
    assert.deepEqual(h.context.toasts.map(t => [t[0], t[1].kind]), [['The stream ended. Try again to reconnect.', 'error']]);
});

test('pagehide or sign-out (both stop the player) take the bar away', async () => {
    const h = await harness();
    await h.player.play(SEVEN, null);
    await h.plays(1);
    h.leaveLive();
    h.windowListeners.pagehide.forEach(fn => fn({ type: 'pagehide' }));
    assert.equal(h.barShowing(), false);
});
