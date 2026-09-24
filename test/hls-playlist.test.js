const { test } = require('node:test');
const assert = require('node:assert/strict');

// 0126: the tuner's playlists are the server's (services/hlsPlaylist.js). ffmpeg's
// own playlist is only parsed.
const hls = require('../server/services/hlsPlaylist');

const FFMPEG_FMP4 = [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:41',
    '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.000000,', 'seg0041.m4s', '#EXTINF:3.960000,', 'seg0042.m4s', '#EXTINF:4.040000,', 'seg0043.m4s', ''
].join('\n');

test('ffmpeg\'s hls playlist is read: version, target duration, init segment, segments with their numbers', () => {
    const p = hls.parseMediaPlaylist(FFMPEG_FMP4);
    assert.equal(p.version, 7);
    assert.equal(p.targetDuration, 4);
    assert.equal(p.mediaSequence, 41);
    assert.equal(p.map, 'init.mp4');
    assert.equal(p.ended, false);
    assert.deepEqual(p.segments, [
        { name: 'seg0041.m4s', duration: 4, seq: 41 },
        { name: 'seg0042.m4s', duration: 3.96, seq: 42 },
        { name: 'seg0043.m4s', duration: 4.04, seq: 43 }
    ]);
    const ts = hls.parseMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\n/abs/dir/seg10000.ts\n#EXT-X-ENDLIST\n');
    assert.deepEqual(ts.segments, [{ name: 'seg10000.ts', duration: 4, seq: 10000 }], 'past seg9999, and only the base name');
    assert.equal(ts.ended, true);
    assert.deepEqual(hls.parseMediaPlaylist('').segments, [], 'a torn or empty read is no segments, not an error');
    assert.deepEqual(hls.parseMediaPlaylist('#EXTM3U\n#EXTINF:4.0,\n').segments, [], 'an EXTINF without its URI yet');
});

test('the rendered playlist: ffmpeg\'s header, then a date on every segment', () => {
    const t0 = Date.UTC(2026, 8, 24, 10, 0, 0);
    const { text } = hls.renderMediaPlaylist({
        segments: [
            { name: 'seg0041.m4s', duration: 4, pdt: t0, map: 'init.mp4' },
            { name: 'seg0042.m4s', duration: 3.96, pdt: t0 + 4000, map: 'init.mp4' }
        ],
        mediaSequence: 41, version: 7, targetDuration: 4
    });
    assert.equal(text, [
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:41', '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-PROGRAM-DATE-TIME:2026-09-24T10:00:00.000Z', '#EXTINF:4.000000,', 'seg0041.m4s',
        '#EXT-X-PROGRAM-DATE-TIME:2026-09-24T10:00:04.000Z', '#EXTINF:3.960000,', 'seg0042.m4s', ''
    ].join('\n'));
});

test('the target duration covers every segment and never shrinks', () => {
    const segs = [{ name: 'seg0001.ts', duration: 10.4 }, { name: 'seg0002.ts', duration: 4 }];
    assert.equal(hls.renderMediaPlaylist({ segments: segs, mediaSequence: 1 }).targetDuration, 10);
    assert.equal(hls.renderMediaPlaylist({ segments: segs.slice(1), mediaSequence: 2, targetDuration: 10 }).targetDuration, 10);
});

test('a recording\'s playlist: EVENT then VOD with ENDLIST; a new init segment and a discontinuity after a re-tune', () => {
    const segs = [
        { name: 'seg00000.m4s', duration: 4, map: 'init.mp4' },
        { name: 'seg00001.m4s', duration: 4, map: 'init-2.mp4', discontinuity: true }
    ];
    const ev = hls.renderMediaPlaylist({ segments: segs, mediaSequence: 0, version: 7, playlistType: 'EVENT' }).text;
    assert.match(ev, /#EXT-X-PLAYLIST-TYPE:EVENT\n/);
    assert.ok(!ev.includes('#EXT-X-ENDLIST'));
    assert.match(ev, /seg00000\.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-2\.mp4"\n#EXTINF:4\.000000,\nseg00001\.m4s\n$/);
    const vod = hls.renderMediaPlaylist({ segments: segs, mediaSequence: 0, version: 7, playlistType: 'VOD', endList: true }).text;
    assert.match(vod, /#EXT-X-PLAYLIST-TYPE:VOD\n/);
    assert.match(vod, /#EXT-X-ENDLIST\n$/);
});
