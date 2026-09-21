const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableChannelId, providerStreamId, summarise } = require('../server/services/stableIds');

// The real shape, from Mark's provider.
const FOX_505 = 'http://pro.speed8k.top/live/someuser/somepass/441360.ts';
const TSN = 'http://pro.speed8k.top/live/someuser/somepass/1239048.ts';

test('the provider stream id is what identifies a channel', () => {
    assert.equal(providerStreamId(FOX_505), '441360');
    assert.equal(stableChannelId(FOX_505), 's441360');
});

test('a reorder does not change it - that is the whole point', () => {
    // 21 Sept: Fox Sports 505 moved pos_1187 -> pos_1185, same channel, same URL.
    // The position changed; the identity must not.
    assert.equal(stableChannelId(FOX_505), stableChannelId(FOX_505));
    assert.notEqual(stableChannelId(FOX_505), stableChannelId(TSN));
});

test('rotating the provider credentials does not change it either', () => {
    // 0015 rejected a URL hash partly for this: the username and password are
    // in the path, so a rotation would have re-pointed every favourite at once.
    const rotated = 'http://pro.speed8k.top/live/newuser/newpass/441360.ts';
    assert.equal(stableChannelId(rotated), stableChannelId(FOX_505));
});

test('the extension is not part of the identity', () => {
    assert.equal(stableChannelId('http://h/live/u/p/441360.m3u8'), 's441360');
    assert.equal(stableChannelId('http://h/live/u/p/441360'), 's441360');
});

test('movie and series URLs work the same way', () => {
    assert.equal(stableChannelId('http://h/movie/u/p/900.mkv'), 's900');
    assert.equal(stableChannelId('http://h/series/u/p/901.mp4'), 's901');
});

test('a path that merely looks like one is not mistaken for credentials', () => {
    // A non-numeric last segment is a filename, not a provider id. Treating it
    // as one would make every `index.m3u8` on a playlist the same channel.
    assert.equal(providerStreamId('http://h/live/u/p/index.m3u8'), null);
    assert.equal(providerStreamId('http://h/news/sports/12.ts'), null, 'no live/movie/series segment');
});

test('a playlist that is not Xtream-shaped still gets an identity, from the URL', () => {
    const a = stableChannelId('http://example.test/streams/bbc-one/playlist.m3u8');
    const b = stableChannelId('http://example.test/streams/bbc-two/playlist.m3u8');
    assert.match(a, /^u[0-9a-f]{16}$/);
    assert.notEqual(a, b);
    assert.equal(a, stableChannelId('http://example.test/streams/bbc-one/playlist.m3u8'), 'and it is stable');
});

test('credentials in a query string are removed before hashing, for the same reason', () => {
    const one = 'http://example.test/stream?id=5&username=bob&password=hunter2';
    const two = 'http://example.test/stream?id=5&username=alice&password=letmein';
    assert.equal(stableChannelId(one), stableChannelId(two));
    assert.notEqual(stableChannelId(one), stableChannelId('http://example.test/stream?id=6&username=bob&password=hunter2'));
});

test('userinfo in the URL is removed too', () => {
    assert.equal(
        stableChannelId('http://bob:hunter2@example.test/streams/one.m3u8'),
        stableChannelId('http://example.test/streams/one.m3u8')
    );
});

test('a row with no URL has no identity, rather than a made-up one', () => {
    // The `##### LOCAL NETWORKS #####` header lines. They cannot be played, so
    // they cannot be favourited or recorded; inventing an id for them would
    // only create collisions between unrelated placeholders.
    for (const empty of [null, undefined, '', '   ']) {
        assert.equal(stableChannelId(empty), null, JSON.stringify(empty));
    }
});

test('a channel cross-listed twice has one identity and that is correct', () => {
    // Fox Sports 505 is listed at two positions with an identical URL. Two rows,
    // one channel - so a favourite on either is a favourite on the channel. This
    // is exactly why the identity cannot replace item_id, which must stay unique.
    assert.equal(stableChannelId(FOX_505), stableChannelId(FOX_505));
    const counts = summarise([FOX_505, FOX_505, TSN]);
    assert.deepEqual(counts, { total: 3, providerId: 3, urlHash: 0, none: 0, distinct: 2, shared: 1 });
});

test('summarise reports how a whole playlist derives, so it can be checked before anything relies on it', () => {
    const counts = summarise([FOX_505, 'http://example.test/odd/one.m3u8', '', null]);
    assert.equal(counts.total, 4);
    assert.equal(counts.providerId, 1);
    assert.equal(counts.urlHash, 1);
    assert.equal(counts.none, 2);
});
