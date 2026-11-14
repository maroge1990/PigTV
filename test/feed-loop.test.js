const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { haveFfmpeg, makeFeeds } = require('./helpers/loopFeeds');
const { LoopDetector, audioFrameLength } = require('../server/services/feedLoop');

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

test('a clip looped with fresh timestamps is a loop, found one period plus 10 s in, with its sound repeating too', { skip }, () => {
    const { verdict, at } = run([feeds.loop]);
    assert.ok(verdict, 'found');
    assert.ok(Math.abs(verdict.periodSec - feeds.clipSec) < 0.2, `period ${verdict.periodSec} s`);
    assert.equal(verdict.periodUnits, feeds.clipSec * 25, 'one unit per picture');
    assert.ok(at <= feeds.clipSec + 12, `found ${at.toFixed(1)} s into the feed`);
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
    assert.ok(silent.at <= feeds.clipSec + 12, `found ${silent.at.toFixed(1)} s in`);
});

test('a resend of old content is not a loop: with its old timestamps, or after a new connection (reset)', { skip }, () => {
    // The same clip twice with the same timestamps (a backward step): the "period" spans no time.
    assert.equal(run([feeds.clip, feeds.clip]).verdict, null);
    // The clip, then the same clip with fresh timestamps: on one connection that is a loop...
    assert.ok(run([feeds.clip, feeds.shifted]).verdict, 'one connection: the repeat is seen');
    // ...but the ingest resets the detector on a reconnect, and a resend is then never compared with before.
    assert.equal(run([feeds.clip, feeds.shifted], { between: (i, d) => d.reset() }).verdict, null);
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
