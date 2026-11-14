'use strict';
// Opus review of #327: Watch on a chosen channel (a details row, the menu's "Watch on…") is checked at the press as the
// game's own Watch is: never a result or a next round, and a channel without its own times is judged on the game's
// airing, never counted as always on air.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness() {
    const f = answer();
    const ars = f.games.find(g => g.id === 'ars');
    ars.channels.push({ sourceId: 1, stableId: 'nt', id: '300', name: 'No Times' }); // no start/end of its own
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {}) });
    const played = [];
    const app = { navigateTo() {}, setLocation() {},
        channelList: { channels: [{ sourceId: 1, stableId: 'nt', id: 'p3' }, { sourceId: 1, stableId: 's1', id: 'p1' }], loadSources: async () => {}, loadChannels: async () => {},
            selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    return { b, p, f, ars, played };
}

test('a channel without its own times, after the game\'s airing has ended: not on air, nothing plays', async () => {
    const h = await harness();
    h.p.received = Date.now() - 2 * H; // now is past the best channel's airing (the game's), NOW + 1 h
    assert.deepEqual(h.p.channelsOnAir(h.ars).map(c => c.name), []);
    await h.p.watch('ars', '1:nt');
    assert.deepEqual(h.played, []);
});

test('the same channel during the game\'s airing plays', async () => {
    const h = await harness();
    h.p.received = Date.now();
    h.p.front.now = NOW;
    await h.p.watch('ars', '1:nt');
    assert.deepEqual(h.played, ['p3']);
});

test('a result plays nothing on a chosen channel, as on its own Watch', async () => {
    const h = await harness();
    h.ars.status = 'finished';
    await h.p.watch('ars', '1:s1');
    assert.deepEqual(h.played, []);
    assert.equal(h.b.context.toasts.at(-1)[0], 'This game isn’t on your channels right now.');
});
