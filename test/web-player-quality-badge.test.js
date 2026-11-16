const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLivePlayer } = require('./helpers/livePlayer');

// D-67 (#265 step 2): the web player's quality badge shows the D-65 badge, the channel's measured quality and frame
// rate ("4K 50", accent for 4K) when the server measured it (C-X `measured`), else the decoded picture's height as
// before. The old badge only ever showed the decoded height ("2160p" for a 4K stream, nothing about its frame rate).
const badgeDom = (document, { controls, el }) => el('div', { id: 'player-quality-badge', className: 'quality-badge pig-amount hidden', parent: controls });

async function playing(channel, info) {
    const h = makeLivePlayer({ extraDom: badgeDom, resolve: () => ({ status: 200, body: { strategy: 'transcode', container: 'hls', videoMode: 'copy',
        url: '/api/transcode/s1/master.m3u8', sessionId: 's1', ...(info ? { info } : {}) } }) });
    await h.ready();
    h.player.play(channel, null);
    await h.clock.advance(100);
    return h.document.getElementById('player-quality-badge');
}

test('a measured channel shows its measured label and frame rate; 4K is the accent', async () => {
    const badge = await playing({ id: '1', sourceId: 1, name: 'Sky Sports F1', quality: 'HD', measured: { label: '4K', fps: 50 } }, { height: 1080 });
    assert.equal(badge.textContent, '4K 50', 'the measurement, not the decoded 1080');
    assert.ok(!badge.classList.contains('hidden'));
    assert.ok(badge.classList.contains('top'), '4K: accent');

    const other = await playing({ id: '2', sourceId: 1, name: 'Sky Sports F1 HD', measured: { label: '720', fps: 25 } }, null);
    assert.equal(other.textContent, '720 25', 'shown before any picture is decoded');
    assert.ok(!other.classList.contains('top'));
});

test('a channel never measured keeps the decoded height, as before', async () => {
    const badge = await playing({ id: '3', sourceId: 1, name: 'Seven' }, { height: 1080 });
    assert.equal(badge.textContent, '1080p');
    assert.ok(!badge.classList.contains('top'));
});

test('the badge text: label then fps, the label alone without a frame rate', async () => {
    const { VideoPlayer } = makeLivePlayer();
    assert.equal(VideoPlayer.measuredBadgeText({ label: '1080', fps: 25 }), '1080 25');
    assert.equal(VideoPlayer.measuredBadgeText({ label: 'SD', fps: null }), 'SD');
    assert.equal(VideoPlayer.measuredBadgeText(undefined), null);
});
