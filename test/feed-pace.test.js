const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FeedPace, pcrOf } = require('../server/services/feedPace');

// R7 (FINDINGS FR-8): synthetic MPEG-TS, one PCR-carrying packet per media step.
function packet(pcrSec, pid = 256) {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = (pid >> 8) & 0x1f; b[2] = pid & 0xff;
    b[3] = 0x30;          // adaptation field + payload
    b[4] = 7; b[5] = 0x10; // PCR flag
    const base = Math.round(pcrSec * 90000) % 2 ** 33;
    b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff;
    b[8] = Math.floor(base / 512) & 0xff; b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
    return b;
}
/** `seconds` of media from `fromSec`, one PCR every 0.1 s. */
const media = (fromSec, seconds) => Buffer.concat(Array.from({ length: Math.round(seconds * 10) + 1 }, (_, k) => packet(fromSec + k / 10)));

test('PCR is read from the adaptation field, and only there', () => {
    assert.equal(pcrOf(packet(12.5), 0), 12.5 * 90000);
    const plain = packet(1); plain[3] = 0x10; // payload only
    assert.equal(pcrOf(plain, 0), null);
});

test('a bursty feed that averages real time: the deficit rises in a pause and comes back', () => {
    const t0 = 1_000_000;
    const p = new FeedPace(t0);
    p.onChunk(media(0, 35), t0 + 100);           // the head start a provider sends on connect
    assert.ok(p.measured);
    assert.ok(Math.abs(p.ahead(t0 + 100) - 34.9) < 0.2);
    assert.equal(Math.round(p.deficit(t0 + 100)), 0);
    // A 16 s pause: the deficit is the pause, not "no data" from the very first second.
    assert.ok(Math.abs(p.deficit(t0 + 16_100) - 16) < 0.3);
    // The next burst brings it back.
    p.onChunk(media(35, 16), t0 + 16_200);
    assert.ok(p.deficit(t0 + 16_200) < 0.5);
    assert.ok(Math.abs(p.maxDeficit - 16.1) < 0.3, 'the worst is kept: the pause, seen as it ended');
});

test('a feed that trickles below real time keeps falling behind, though bytes never stop', () => {
    const t0 = 2_000_000;
    const p = new FeedPace(t0);
    let m = 0;
    for (let s = 1; s <= 40; s++) { p.onChunk(media(m, 0.5), t0 + s * 1000); m += 0.5; } // half speed
    assert.ok(p.deficit(t0 + 40_000) > 18, 'about 20 s behind after 40 s at half speed');
});

test('a backward or huge PCR step (a resend, a reset) adds no media', () => {
    const t0 = 3_000_000;
    const p = new FeedPace(t0);
    p.onChunk(media(100, 10), t0 + 100);
    const before = p.media;
    p.onChunk(media(50, 1), t0 + 200);    // backwards
    p.onChunk(media(5000, 1), t0 + 300);  // a jump
    assert.ok(p.media - before < 2.5, 'only the steps inside each run count');
});

test('packets split across chunks are reassembled', () => {
    const t0 = 4_000_000;
    const whole = media(0, 5);
    const a = new FeedPace(t0), b = new FeedPace(t0);
    a.onChunk(whole, t0 + 10);
    for (let i = 0; i < whole.length; i += 100) b.onChunk(whole.subarray(i, i + 100), t0 + 10);
    assert.ok(Math.abs(a.media - b.media) < 1e-9);
    assert.ok(a.media > 4.9);
});

test('0283: totalMedia counts every connection\'s media; a reconnect resets the pace but not the total', () => {
    const t0 = 5_000_000;
    const p = new FeedPace(t0);
    p.onChunk(media(0, 5), t0 + 100);
    p.reset(t0 + 6000);
    p.onChunk(media(900, 3), t0 + 6100);
    assert.ok(Math.abs(p.totalMedia - 8) < 0.3, `${p.totalMedia}`);
    assert.ok(p.media < 3.1, 'the pace starts again');
});

test('0283 (Codex review of 0282): an upstream that moves its PCR to another PID mid-connection is followed', () => {
    const t0 = 7_000_000;
    const p = new FeedPace(t0);
    // Real time throughout: one second of media a second, PID 256 for 10 s, then PID 257.
    for (let s = 0; s < 30; s++) {
        const pid = s < 10 ? 256 : 257;
        p.onChunk(Buffer.concat(Array.from({ length: 10 }, (_, k) => packet(1000 + s + k / 10, pid))), t0 + s * 1000);
    }
    assert.ok(p.deficit(t0 + 29_000) < 3, `still keeping up after the change (deficit ${p.deficit(t0 + 29_000).toFixed(1)} s)`);
    // Two programmes' PCRs interleaved: the first one followed stays followed.
    const q = new FeedPace(t0);
    for (let s = 0; s < 10; s++) {
        q.onChunk(Buffer.concat(Array.from({ length: 10 }, (_, k) => Buffer.concat([packet(s + k / 10, 256), packet(5000 + s + k / 10, 300)]))), t0 + s * 1000);
    }
    assert.equal(q.pcrPid, 256);
});

test('before any PCR the deficit is the old rule, seconds since the last byte', () => {
    const t0 = 6_000_000;
    const p = new FeedPace(t0);
    p.onChunk(Buffer.alloc(188 * 3, 0x47), t0 + 1000);
    assert.equal(p.measured, false);
    assert.equal(p.deficit(t0 + 4000), 3);
});
