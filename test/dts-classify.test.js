const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTimestamps, analyzeProbeResult } = require('../server/services/streamProbe');

// Shapes taken from real captures off Mark's provider (60 s each, 90 kHz):
//   pos_463  TSN                 59.94 fps, every step ~1500 ticks      -> even
//   pos_328  Sky Sports UHD      50 fps,    every step 1800 ticks       -> even
//   pos_1187 Fox Sports 505      50 fps, a third of steps ~1 tick then
//                                a double - an upstream muxer bumped
//                                repeated DTS instead of fixing them    -> uneven
const packets = (dts, streamIndex = 0) => dts.map(d => ({ stream_index: streamIndex, dts: String(d) }));

function evenFeed(n = 200, step = 1800) {
    return packets(Array.from({ length: n }, (_, i) => i * step));
}

// Two frames share a timestamp, so the muxer that wrote this bumped the second by
// one tick: steps go 1799, 1, 1799, 1, ... averaging out to the real frame period.
function unevenFeed(n = 200, step = 1800) {
    const out = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
        out.push(i % 2 === 0 ? t : t + 1);
        if (i % 2 === 1) t += step * 2;
    }
    return packets(out);
}

test('a feed with even frame timing is left alone - its DTS is worth keeping', () => {
    assert.equal(classifyTimestamps(evenFeed()), false);
    assert.equal(classifyTimestamps(evenFeed(200, 1500)), false, '59.94 fps');
    assert.equal(classifyTimestamps(evenFeed(200, 3000)), false, '30 fps');
});

test('a feed whose repeated DTS was bumped upstream is flagged uneven', () => {
    assert.equal(classifyTimestamps(unevenFeed()), true);
});

test('the two populations are separated by a wide margin, not a fine threshold', () => {
    // Real measurements were 33.8% uneven against 0.0%. Anything in that gap must
    // land the same way, or the threshold is tuned to one capture rather than to
    // the fault.
    const withFraction = (fraction) => {
        const out = [];
        let t = 0;
        for (let i = 0; i < 300; i++) {
            const degenerate = (i % Math.round(1 / fraction)) === 0;
            out.push(t);
            t += degenerate ? 1 : 1800;
        }
        return packets(out);
    };
    assert.equal(classifyTimestamps(withFraction(0.33)), true, '33% degenerate - uneven');
    assert.equal(classifyTimestamps(withFraction(0.25)), true, '25% - still uneven');
    assert.equal(classifyTimestamps(evenFeed(300)), false, '0% - even');
});

test('it will not guess: too few packets, no packets, or no video packets all answer null', () => {
    assert.equal(classifyTimestamps([]), null, 'none');
    assert.equal(classifyTimestamps(undefined), null, 'probe returned no packets key at all');
    assert.equal(classifyTimestamps(null), null);
    assert.equal(classifyTimestamps(evenFeed(5)), null, 'a handful at a channel join says nothing');
    assert.equal(classifyTimestamps(packets([0, 1800, 3600], 1)), null, 'audio only');
});

test('non-numeric and missing DTS are skipped rather than read as zero', () => {
    // N/A parsed as a number would be NaN; counted as 0 it would look like a
    // degenerate step and flag a clean feed as uneven.
    const withGaps = evenFeed(200).map((p, i) => (i % 10 === 0 ? { ...p, dts: 'N/A' } : p));
    assert.equal(classifyTimestamps(withGaps), false);
});

test('analyzeProbeResult carries the verdict, and says null when it could not tell', () => {
    const base = {
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
            { codec_type: 'audio', codec_name: 'aac', channels: 2 }],
        format: { format_name: 'mpegts' }
    };
    assert.equal(analyzeProbeResult({ ...base, packets: unevenFeed() }, 'http://x/y.ts', {}).dtsUneven, true);
    assert.equal(analyzeProbeResult({ ...base, packets: evenFeed() }, 'http://x/y.ts', {}).dtsUneven, false);
    assert.equal(analyzeProbeResult(base, 'http://x/y.ts', {}).dtsUneven, null, 'an older probe with no packets');
});
