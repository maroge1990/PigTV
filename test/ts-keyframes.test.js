const { test } = require('node:test');
const assert = require('node:assert/strict');

// #3: where a reader joining a running shared feed starts. It must be the newest video key frame,
// found from the stream itself (PAT -> PMT -> video PID), behind the newest complete PAT and PMT before
// it, so the joiner's ffmpeg starts video and audio together. The old code had no such parser (0577:
// the last PAT), and 0578 joined at the PAT before the key frame, which let through the sound and
// pictures between that PAT and the key frame whenever PATs are not sent at key frames.
const { keyframeJoin } = require('../server/services/tsKeyframes');
const ts = require('./helpers/fakeTs');

const GOP = 10;
/** Frames 0..count-1; a PAT and PMT before every 3rd frame (out of step with the GOP); key frames every GOP. */
function stream(count, { codec = 'h264', rai = null, kind = null, pmt = true, video = true, keys = true, from = 0, descriptor = 0 } = {}) {
    const parts = [];
    const pats = [];
    const frames = new Map(); // frame -> offset of its first packet
    let bytes = 0;
    const push = (b) => { parts.push(b); bytes += b.length; };
    for (let f = from; f < from + count; f++) {
        if (f % 3 === 0) {
            const at = bytes;
            push(ts.pat());
            if (pmt) push(ts.pmt({ codec, video, descriptor }));
            pats.push({ frame: f, offset: at, bytes: bytes - at });
        }
        frames.set(f, bytes);
        if (video) push(ts.videoFrame(f, { codec, key: keys && f % GOP === 0, rai, kind }));
        push(ts.audio());
    }
    return { buf: Buffer.concat(parts), pats, frames };
}
/** The join a reader should get: the newest key frame's first packet, behind the PAT and PMT before it. */
function expected({ pats, frames }, count, from = 0) {
    const newestKey = Math.floor((from + count - 1) / GOP) * GOP;
    const p = pats.filter(x => x.frame <= newestKey).pop();
    const tables = [];
    for (let o = p.offset; o < p.offset + p.bytes; o += 188) tables.push(o);
    return { at: frames.get(newestKey), tables };
}
/** What the joiner receives: the tables' packets, then the stream from the key frame. */
const received = (buf, r) => Buffer.concat([...r.tables.map(o => buf.subarray(o, o + 188)), buf.subarray(r.at)]);

test('PATs out of step with key frames: the joiner gets the PAT and PMT, then the newest key frame; no sound or picture from before it', () => {
    const s = stream(26, { rai: true }); // keys at 0, 10, 20; PATs at 0, 3 ... 24 (frame 18's is the one before 20)
    const r = keyframeJoin(s.buf);
    assert.deepEqual({ at: r.at, tables: r.tables }, expected(s, 26));
    const packets = ts.readPackets(received(s.buf, r));
    assert.deepEqual(packets.slice(0, 2).map(p => p.pid), [0, ts.PMT_PID], 'the tables come first');
    assert.equal(packets[2].pid, ts.VIDEO_PID);
    assert.equal(packets[2].frame, 20, 'then the key frame: nothing of frames 18 and 19, no audio from before it');
    assert.ok(packets.filter(p => p.frame !== null).every(p => p.frame >= 20));
});

test('a PMT that spans two packets is sent whole, both packets as found', () => {
    const s = stream(26, { rai: true, descriptor: 250 });
    const r = keyframeJoin(s.buf);
    assert.equal(r.tables.length, 3, 'PAT + two PMT packets');
    assert.deepEqual({ at: r.at, tables: r.tables }, expected(s, 26));
    const packets = ts.readPackets(received(s.buf, r));
    assert.deepEqual(packets.slice(0, 4).map(p => [p.pid, p.pusi]), [[0, true], [ts.PMT_PID, true], [ts.PMT_PID, false], [ts.VIDEO_PID, true]]);
    // The PMT before frame 18 lost its second packet: the newest complete PMT (before frame 15) goes
    // with the newest PAT (before 18), and the join is still at key frame 20.
    const p18 = s.pats.find(x => x.frame === 18).offset;
    const torn = Buffer.concat([s.buf.subarray(0, p18 + 2 * 188), s.buf.subarray(p18 + 3 * 188)]);
    const t = keyframeJoin(torn);
    const p15 = s.pats.find(x => x.frame === 15).offset;
    assert.equal(t.at, s.frames.get(20) - 188);
    assert.deepEqual(t.tables, [p18, p15 + 188, p15 + 376]);
});

test('without random_access_indicator: H.264 by NAL type (AUD then SPS, AUD then IDR); a non-IDR picture is not a key frame', () => {
    for (const kind of ['key', 'idr']) {
        const s = stream(25, { kind });
        assert.equal(keyframeJoin(s.buf).at, expected(s, 25).at, kind === 'key' ? 'AUD + SPS' : 'AUD + IDR');
    }
    // Every frame's first NAL after the AUD an IDR: each is a key frame, the newest wins.
    const idr = [];
    for (let f = 0; f < 7; f++) { idr.push(ts.pat(), ts.pmt(), ts.videoFrame(f, { key: true, kind: 'idr' }), ts.audio()); }
    const buf = Buffer.concat(idr);
    const packets = ts.readPackets(buf);
    assert.equal(keyframeJoin(buf).at, packets.filter(p => p.frame === 6)[0].offset);
    // The same frames, all plain pictures (RAI field present but clear): no key frame.
    const plain = stream(25, { keys: false, rai: true });
    assert.deepEqual(keyframeJoin(plain.buf), { at: -1, reason: 'no video key frame' });
});

test('HEVC: IRAP found by NAL type after the AUD; MPEG-2: the sequence header', () => {
    for (const codec of ['hevc', 'mpeg2']) {
        const s = stream(24, { codec });
        const r = keyframeJoin(s.buf);
        assert.equal(r.at, expected(s, 24).at, codec);
        assert.equal(r.codec, codec);
    }
});

test('nothing to go on - no PMT, no video stream, no key frame, no tables before it - says why and gives no join point', () => {
    assert.deepEqual(keyframeJoin(stream(20, { pmt: false }).buf), { at: -1, reason: 'no PMT' });
    assert.deepEqual(keyframeJoin(stream(20, { video: false }).buf), { at: -1, reason: 'no video stream it reads' });
    assert.deepEqual(keyframeJoin(stream(20, { keys: false }).buf), { at: -1, reason: 'no video key frame' });
    // Frames 10..12 only: the key frame at 10 comes before the first PAT (at 12).
    const s = stream(3, { from: 10, rai: true });
    assert.deepEqual(keyframeJoin(s.buf), { at: -1, reason: 'no PAT and PMT before the key frame' });
    assert.equal(keyframeJoin(Buffer.alloc(0)).at, -1);
    assert.equal(keyframeJoin(Buffer.alloc(4000, 0x47)).at, -1, 'noise');
});

test('a window that starts mid-packet (chunks split anywhere) still finds the packets', () => {
    const s = stream(26, { from: 1 });
    const cut = 97;
    const r = keyframeJoin(s.buf.subarray(cut));
    const want = expected(s, 26, 1);
    assert.equal(r.at, want.at - cut);
    assert.deepEqual(r.tables, want.tables.map(o => o - cut));
});

test('#309: a repeated packet of a three-packet PMT is skipped, not counted toward the section; a lost one drops it', () => {
    // 0579 counted payload bytes without the continuity counter: P1 P2 P2 completed the section
    // without P3, and the joiner was sent a corrupt PMT (P3 never sent), so it waited for a repeat.
    const pmt = ts.pmt({ descriptor: 400 });
    assert.equal(pmt.length, 3 * 188, 'the PMT spans three packets');
    const [p1, p2, p3] = [0, 1, 2].map(n => pmt.subarray(n * 188, (n + 1) * 188));
    const tail = [ts.videoFrame(0, { key: true, rai: true }), ts.audio(), ts.videoFrame(1), ts.audio()];
    const buf = Buffer.concat([ts.pat(), p1, p2, p2, p3, ...tail]);
    const r = keyframeJoin(buf);
    assert.equal(r.at, 5 * 188, 'the key frame after the tables');
    assert.deepEqual(r.tables, [0, 188, 2 * 188, 4 * 188], 'PAT, P1, P2, P3: the repeat is not sent, the last packet is');
    // P2 lost: P1 and P3 are not a section, whatever their byte count.
    const lost = Buffer.concat([ts.pat(), p1, p3, ...tail]);
    assert.equal(keyframeJoin(lost).at, -1);
});
