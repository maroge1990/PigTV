const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { haveFfmpeg, makeFeeds } = require('./helpers/loopFeeds');
const { LoopDetector, audioFrameLength, MAX_AUDIO_UNIT } = require('../server/services/feedLoop');

// #324: the looping-feed detector on feeds made by the real ffmpeg (helpers/loopFeeds.js): a 24 s clip looped
// with fresh timestamps is found within one period plus 10 s of media; a moving feed, still slates (short and
// long groups of pictures), a looping picture over live sound, and a resend of old content are never called a
// loop. The capture it was built from (FOX Footy, 36.22 s) is checked by scripts/feed-loop-check.js (T2).
const skip = !haveFfmpeg && 'ffmpeg with libx264 is not installed here';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-loop-'));
let feeds;
before(() => { if (!skip) feeds = makeFeeds(dir); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Feed `files` (in order) in odd-sized chunks; `between(i)` runs after file i. The verdict, and the media second it came at. */
function run(files, { between = null, detector = new LoopDetector() } = {}) {
    let first = null;
    for (const [i, file] of files.entries()) {
        const data = fs.readFileSync(file);
        for (let at = 0; at < data.length; at += 7001) {
            const verdict = detector.push(Buffer.from(data.subarray(at, at + 7001)));
            if (first === null && detector.video.count) first = detector.video.times[0];
            if (verdict) return { verdict, at: detector.video.time - first, detector };
        }
        if (between) between(i, detector);
    }
    return { verdict: null, at: null, detector };
}

// A sustained loop only (Codex #324 high): the run must outlast a whole period by max(10 s, a quarter period), so it is
// found during the third airing (2 x 24 + 10 = 58 s), never during the second.
const due = () => 2 * feeds.clipSec + Math.max(10, feeds.clipSec / 4);

test('a clip looped with fresh timestamps is a loop, found during its third airing, with its sound repeating too', { skip }, () => {
    const { verdict, at } = run([feeds.loop]);
    assert.ok(verdict, 'found');
    assert.ok(Math.abs(verdict.periodSec - feeds.clipSec) < 0.2, `period ${verdict.periodSec} s`);
    assert.equal(verdict.periodUnits, feeds.clipSec * 25, 'one unit per picture');
    assert.ok(at >= due() - 0.5 && at <= due() + 2, `found ${at.toFixed(1)} s into the feed (due ${due()} s)`);
    assert.ok(at < 3 * feeds.clipSec, 'within the third airing: three airings back to back are a loop');
    assert.ok(verdict.distinct >= 0.99 && verdict.keyframes >= feeds.clipSec - 1, JSON.stringify(verdict));
    assert.equal(verdict.audio, 'repeats');
});

test('a moving feed, a still slate and a still slate with 12 s groups of pictures are never a loop', { skip }, () => {
    for (const file of [feeds.live, feeds.slate, feeds.slateLongGop]) {
        const { verdict, detector } = run([file]);
        assert.equal(verdict, null, `${path.basename(file)}: ${JSON.stringify(verdict)} ${detector.notes.join(' | ')}`);
        assert.ok(detector.video.count >= feeds.total * 25 - 2, `${path.basename(file)}: every picture read (${detector.video.count})`);
    }
    // The long-GOP slate repeats at a long period, and is turned down as a still picture, not a clip.
    assert.match(run([feeds.slateLongGop]).detector.notes.join(' | '), /not a clip/);
});

test('a looping picture over live sound is not a loop; over silence it is', { skip }, () => {
    const live = run([feeds.loopLiveSound]);
    assert.equal(live.verdict, null, JSON.stringify(live.verdict));
    assert.match(live.detector.notes.join(' | '), /the sound does not/);
    const silent = run([feeds.loopSilent]);
    assert.ok(silent.verdict, 'found');
    assert.equal(silent.verdict.audio, 'silent');
    assert.ok(silent.at <= due() + 2, `found ${silent.at.toFixed(1)} s in`);
});

test('a resend of old content is not a loop: with its old timestamps, or after a new connection (reset)', { skip }, () => {
    // The same clip twice with the same timestamps (a backward step): the "period" spans no time.
    assert.equal(run([feeds.clip, feeds.clip]).verdict, null);
    // The clip, then the same clip twice more with fresh timestamps: on one connection that is a loop...
    assert.ok(run([feeds.clip, feeds.shifted, feeds.shifted2]).verdict, 'one connection: the repeat is seen');
    // ...but the ingest resets the detector on a reconnect, and a resend is then never compared with before.
    assert.equal(run([feeds.clip, feeds.shifted, feeds.shifted2], { between: (i, d) => { if (i === 0) d.reset(); } }).verdict, null);
});

test('one clip aired twice in a row (an ad, a promo, a replay), then other programming, is never a loop', { skip }, () => {
    const { verdict, detector } = run([feeds.twiceThenLive]);
    assert.equal(verdict, null, JSON.stringify(verdict));
    assert.ok(detector.video.count >= 4 * feeds.clipSec * 25 - 2, `all of it read (${detector.video.count} pictures)`);
    // The same two airings with nothing after them yet: still not a loop.
    assert.equal(run([feeds.clip, feeds.shifted]).verdict, null);
});

test('a lone repeat shorter than 10 s is not a loop', { skip }, () => {
    // 4 s of the clip resent (fresh timestamps) after the clip: a run of 4 s, under minRunSec.
    const clip = fs.readFileSync(feeds.clip);
    const d = new LoopDetector();
    d.push(clip);
    const shifted = fs.readFileSync(feeds.shifted);
    d.push(shifted.subarray(0, Math.floor(shifted.length / 6) - (Math.floor(shifted.length / 6) % 188)));
    assert.equal(d.verdict, null);
});

test('audio frames are split by their own headers (ADTS, AC-3, E-AC-3)', () => {
    const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x10, 0x1f, 0xfc]); // frame_length 0x80 = 128
    assert.equal(audioFrameLength(adts, 0), 128);
    const ac3 = Buffer.from([0x0b, 0x77, 0, 0, 0x14, 0x40, 0]);           // 48 kHz, frmsizecod 20 (192 kb/s): 384 words
    assert.equal(audioFrameLength(ac3, 0), 768);
    const eac3 = Buffer.from([0x0b, 0x77, 0x02, 0xff, 0, 0x80, 0]);       // bsid 16, frmsiz 0x2ff: (767+1)*2
    assert.equal(audioFrameLength(eac3, 0), 1536);
    assert.equal(audioFrameLength(Buffer.from([1, 2, 3, 4, 5, 6, 7]), 0), 0);
});

// Codex #324 high: an audio PES was assembled without bound, so packets that never start a new PES grew memory forever.
test('an audio PES that never ends is bounded: by its declared length, else by the unit cap, and is dropped', () => {
    const packet = (pid, start, payload, cc) => {
        const p = Buffer.alloc(188, 0xff);
        p[0] = 0x47; p[1] = (start ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10 | (cc & 0x0f);
        payload.copy(p, 4);
        return p;
    };
    const pesStart = (declared) => Buffer.from([0, 0, 1, 0xc0, declared >> 8, declared & 0xff, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, 0xff, 0xf1]);
    for (const declared of [0, 1000]) {
        const d = new LoopDetector();
        d.push(packet(0x101, true, pesStart(declared), 0));
        const body = Buffer.alloc(184, 0x55);
        let peak = 0;
        for (let n = 1; n <= 100000; n += 1000) {
            d.push(Buffer.concat(Array.from({ length: 1000 }, (_, k) => packet(0x101, false, body, n + k))));
            peak = Math.max(peak, d.sound.audio ? d.sound.audio.length : 0, d.sound.audioLen);
        }
        assert.ok(peak <= MAX_AUDIO_UNIT, `declared ${declared}: peak ${peak} bytes (cap ${MAX_AUDIO_UNIT})`);
        if (declared) assert.ok(d.sound.audioLen <= declared, `declared ${declared}: held ${d.sound.audioLen}`);
        assert.ok(d.describe().memoryBytes < 1024 * 1024, `declared ${declared}: ${d.describe().memoryBytes} bytes`);
    }
});
