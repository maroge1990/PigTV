const { test } = require('node:test');
const assert = require('node:assert/strict');

// #3: where a reader joining a running shared feed starts. It must be the last PAT at or before the
// newest video key frame, found from the stream itself (PAT -> PMT -> video PID), so the joiner's
// ffmpeg starts video and audio together. The old code had no such parser: it joined at the last PAT.
const { keyframeJoinOffset } = require('../server/services/tsKeyframes');
const ts = require('./helpers/fakeTs');

const GOP = 10;
/** Frames 0..count-1; a PAT and PMT before every 3rd frame; key frames every GOP. */
function stream(count, { codec = 'h264', rai = null, kind = null, pmt = true, video = true, keys = true, from = 0 } = {}) {
    const parts = [];
    const pats = [];
    let bytes = 0;
    const push = (b) => { parts.push(b); bytes += b.length; };
    for (let f = from; f < from + count; f++) {
        if (f % 3 === 0) { pats.push({ frame: f, offset: bytes }); push(ts.pat()); if (pmt) push(ts.pmt({ codec, video })); }
        if (video) push(ts.videoFrame(f, { codec, key: keys && f % GOP === 0, rai, kind }));
        push(ts.audio());
    }
    return { buf: Buffer.concat(parts), pats };
}
/** The PAT a joiner should start at: the last one at or before the newest key frame. */
function expected(pats, count, from = 0) {
    const newestKey = Math.floor((from + count - 1) / GOP) * GOP;
    return pats.filter(p => p.frame <= newestKey).pop().offset;
}

test('random_access_indicator: the joiner starts at the PAT before the newest key frame, not at the newest PAT', () => {
    const { buf, pats } = stream(26, { rai: true }); // keys at 0, 10, 20; PATs at 0, 3 ... 24
    const r = keyframeJoinOffset(buf);
    assert.equal(r.at, expected(pats, 26));
    assert.equal(r.at, pats.find(p => p.frame === 18).offset, 'the PAT before frame 20');
    assert.notEqual(r.at, pats[pats.length - 1].offset);
});

test('without random_access_indicator: H.264 by NAL type (AUD then SPS, AUD then IDR); a non-IDR picture is not a key frame', () => {
    for (const kind of ['key', 'idr']) {
        const { buf, pats } = stream(25, { kind });
        assert.equal(keyframeJoinOffset(buf).at, expected(pats, 25), kind === 'key' ? 'AUD + SPS' : 'AUD + IDR');
    }
    // Every frame's first NAL after the AUD an IDR: each is a key frame, the newest wins.
    const idr = [];
    for (let f = 0; f < 7; f++) { idr.push(ts.pat(), ts.pmt(), ts.videoFrame(f, { key: true, kind: 'idr' }), ts.audio()); }
    const buf = Buffer.concat(idr);
    const lastPat = ts.readPackets(buf).filter(p => p.pid === 0).pop().offset;
    assert.equal(keyframeJoinOffset(buf).at, lastPat);
    // The same frames, all plain pictures (RAI field present but clear): no key frame.
    const plain = stream(25, { keys: false, rai: true });
    assert.deepEqual(keyframeJoinOffset(plain.buf), { at: -1, reason: 'no video key frame' });
});

test('HEVC: IRAP found by NAL type after the AUD; MPEG-2: the sequence header', () => {
    for (const codec of ['hevc', 'mpeg2']) {
        const { buf, pats } = stream(24, { codec });
        const r = keyframeJoinOffset(buf);
        assert.equal(r.at, expected(pats, 24), codec);
        assert.equal(r.codec, codec);
    }
});

test('nothing to go on - no PMT, no video stream, no key frame - says why and gives no join point', () => {
    assert.deepEqual(keyframeJoinOffset(stream(20, { pmt: false }).buf), { at: -1, reason: 'no PMT' });
    assert.deepEqual(keyframeJoinOffset(stream(20, { video: false }).buf), { at: -1, reason: 'no video stream it reads' });
    assert.deepEqual(keyframeJoinOffset(stream(20, { keys: false }).buf), { at: -1, reason: 'no video key frame' });
    assert.equal(keyframeJoinOffset(Buffer.alloc(0)).at, -1);
    assert.equal(keyframeJoinOffset(Buffer.alloc(4000, 0x47)).at, -1, 'noise');
});

test('a window that starts mid-packet (chunks split anywhere) still finds the packets', () => {
    const { buf, pats } = stream(26, { from: 1 });
    const cut = 97;
    const r = keyframeJoinOffset(buf.subarray(cut));
    assert.equal(r.at, expected(pats, 26, 1) - cut);
});
