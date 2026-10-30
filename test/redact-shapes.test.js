const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../server/redact');
const { XtreamApi } = require('../server/services/xtreamApi');

// redact() against every URL shape a provider login can appear in: the Xtream
// path forms (with and without an extension, and the short form without a type
// segment), timeshift, query parameters and userinfo. Each row keeps what
// identifies the stream (host, type, id) and loses the login.
const USER = 'acct9921';
const PASS = 'Pw7xq44';

const SHAPES = [
    ['live with extension', `http://h.example:8080/live/${USER}/${PASS}/123.ts`, '/live/***/***/123.ts'],
    ['live m3u8', `http://h.example/live/${USER}/${PASS}/123.m3u8`, '/live/***/***/123.m3u8'],
    ['live without extension', `http://h.example/live/${USER}/${PASS}/123`, '/live/***/***/123'],
    ['movie', `http://h.example/movie/${USER}/${PASS}/77.mkv`, '/movie/***/***/77.mkv'],
    ['series without extension', `http://h.example/series/${USER}/${PASS}/88`, '/series/***/***/88'],
    ['short form', `http://h.example:8080/${USER}/${PASS}/123`, 'http://h.example:8080/***/***/123'],
    ['short form with extension', `https://h.example/${USER}/${PASS}/123.ts`, 'https://h.example/***/***/123.ts'],
    ['timeshift path', `http://h.example/timeshift/${USER}/${PASS}/60/2026-10-30:20-00/123.ts`, '/timeshift/***/***/60/'],
    ['player_api query', `http://h.example/player_api.php?username=${USER}&password=${PASS}&action=get_live_streams`, 'action=get_live_streams'],
    ['xmltv query', `http://h.example/xmltv.php?username=${USER}&password=${PASS}`, 'xmltv.php?username=***&password=***'],
    ['get.php playlist', `http://h.example/get.php?username=${USER}&password=${PASS}&type=m3u_plus&output=ts`, 'type=m3u_plus'],
    ['timeshift.php query', `http://h.example/streaming/timeshift.php?username=${USER}&password=${PASS}&stream=123`, 'stream=123'],
    ['user query parameter', `http://h.example/list.m3u?user=${USER}&pass=${PASS}`, 'list.m3u?user=***&pass=***'],
    ['userinfo', `http://${USER}:${PASS}@h.example/stream.ts`, '//***:***@h.example'],
    ['inside an ffmpeg command line', `ffmpeg -i "http://h.example/live/${USER}/${PASS}/123" -c copy`, '/live/***/***/123"']
];

for (const [name, input, kept] of SHAPES) {
    test(`redact removes the login from the ${name} URL shape`, () => {
        const out = redact(input);
        assert.ok(!out.includes(USER), `${name}: username left in ${out}`);
        assert.ok(!out.includes(PASS), `${name}: password left in ${out}`);
        assert.ok(out.includes(kept), `${name}: expected "${kept}" in ${out}`);
    });
}

test('redact covers every URL the Xtream client builds', () => {
    const api = new XtreamApi('http://h.example:8080/', USER, PASS);
    const urls = [
        api.buildApiUrl(null),
        api.buildApiUrl('get_live_streams', { category_id: 4 }),
        api.buildStreamUrl(123, 'live', 'ts'),
        api.buildStreamUrl(123, 'live', 'm3u8'),
        api.buildStreamUrl(77, 'vod', 'mkv'),
        api.buildStreamUrl(88, 'series', 'mp4'),
        api.getXmltvUrl()
    ];
    for (const url of urls) {
        const out = redact(url);
        assert.ok(!out.includes(USER) && !out.includes(PASS), `left in ${out}`);
    }
});

test('redact leaves ordinary server paths and text alone', () => {
    for (const plain of [
        '/api/recordings/123',
        'http://192.168.1.235:3000/api/recordings/123/stream',
        'GET /api/transcode/abc123/seg00012.ts',
        'http://h.example/live/news/sports/',
        'Sync finished: 1200 channels in 3 categories'
    ]) {
        assert.equal(redact(plain), plain);
    }
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
});
