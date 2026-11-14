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

// Opus #324: a run must outlast its period, so with a long period at a high frame rate the run's first units leave the
// 8,192-unit ring before it is judged (at 60 fps, any period over ~109 s); its start time and clock span are kept as
// values. A 115 s loop at 60 fps (6,900 pictures a pass, a key frame a second; its declared sound, 31.25 frames a second,
// loops with it) is found at 2 x 115 + 28.75 s.
test('a 115 s loop at 60 fps is found, although its run outlasts the ring of units', () => {
    const d = new LoopDetector();
    d.sawPmt = true; d.pmtAudioPid = 0x101; d.sound.pid = 0x101; // a PMT read whole that declares the sound
    const fps = 60;
    const pass = 115 * fps;
    let found = null;
    let sound = 0;
    for (let i = 0; i < 3 * pass && !found; i++) {
        const n = i % pass; // the picture within the clip: the same hash every pass, timestamps rising
        for (; sound / 31.25 <= i / fps; sound++) {
            const m = sound % (115 * 31.25);
            d.sound.add(Math.imul(m + 3, 0x27d4eb2d), Math.imul(m + 9, 0x165667b1), sound / 31.25, false);
        }
        d.video.add(Math.imul(n + 1, 0x9e3779b1), Math.imul(n + 7, 0x85ebca6b), i / fps, n % fps === 0);
        d.judge();
        if (d.verdict) found = { ...d.verdict, at: i / fps };
    }
    assert.ok(found, 'found');
    assert.ok(Math.abs(found.periodSec - 115) < 0.1, `period ${found.periodSec} s`);
    assert.ok(Math.abs(found.at - 258.75) < 1, `found ${found.at} s in`);
    assert.equal(found.audio, 'repeats');
});

// Opus #324: the sound was the first PES with stream id 0xbd or 0xc0-0xdf, but DVB subtitles and teletext use 0xbd too.
// One subtitle PES ahead of the programme made its real sound ignored, so a looping picture over live sound was a loop.
// The sound is now the PMT's; and a PMT's sound that sends nothing is waited for, never taken as "no sound".
test('the sound is the one the PMT declares: a subtitle PES first does not hide live sound, and quiet sound is waited for', { skip }, () => {
    const data = fs.readFileSync(feeds.loopLiveSound);
    const probe = new LoopDetector();
    probe.push(data.subarray(0, 188 * 2000));
    const pts = Math.round(probe.video.times[0] * 90000);
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47; pkt[1] = 0x40 | 0x01; pkt[2] = 0xf0; pkt[3] = 0x10; // PID 0x1f0, not in the PMT
    Buffer.from([0, 0, 1, 0xbd, 0, 0, 0x80, 0x80, 5, 0x21 | ((pts / 2 ** 29) & 0x0e), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1,
        (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1, 0x20, 0x00, 0x0f]).copy(pkt, 4);
    const sub = path.join(dir, 'subtitle-first.ts');
    fs.writeFileSync(sub, Buffer.concat([pkt, data]));
    const withSubtitle = run([sub]);
    assert.equal(withSubtitle.verdict, null, JSON.stringify(withSubtitle.verdict));
    assert.match(withSubtitle.detector.notes.join(' | '), /the sound does not/);

    // The loop with its sound packets taken out, the PMT still declaring them: waited for, not judged without sound.
    const loop = fs.readFileSync(feeds.loop);
    const audioPid = (() => { const d = new LoopDetector(); d.push(loop.subarray(0, 188 * 2000)); return d.pmtAudioPid; })();
    assert.ok(audioPid !== null, 'the PMT declares the sound');
    const kept = [];
    for (let at = 0; at + 188 <= loop.length; at += 188) if ((((loop[at + 1] & 0x1f) << 8) | loop[at + 2]) !== audioPid) kept.push(loop.subarray(at, at + 188));
    const quiet = path.join(dir, 'quiet-sound.ts');
    fs.writeFileSync(quiet, Buffer.concat(kept));
    assert.equal(run([quiet]).verdict, null);
    // Sound declared and sent, but silence: still found (the picture decides).
    const silentPicture = run([feeds.loopSilent]);
    assert.ok(silentPicture.verdict, 'a loop over silence is still found');
});

// Codex sign-off of #324: the PMT was read from its first TS packet only, then taken as complete. With a large PMT whose
// audio entry is in the continuation packet, the sound was "none" for good, and a looping picture over live sound was a
// loop. The PMT is now assembled across packets by its section_length, and used only when intact (CRC-32, lengths).
const { crc32 } = require('../server/services/feedLoop');
const withCrc = (body) => { const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body)); return Buffer.concat([body, c]); };

/**
 * The live-sound loop with every PMT rewritten: `edit(section without CRC)` returns the new section body (from table_id,
 * without CRC); `crc` false keeps a wrong one. The section goes over two packets (`pointer`: the second is itself a
 * payload-unit start whose pointer_field carries the rest of the section, then stuffing).
 */
function rewritePmt(name, edit, { crc = true, pointer = false } = {}) {
    const data = fs.readFileSync(feeds.loopLiveSound);
    const pidOf = (at) => ((data[at + 1] & 0x1f) << 8) | data[at + 2];
    const packets = [];
    let pmtPid = null;
    for (let at = 0; at + 188 <= data.length; at += 188) {
        const pid = pidOf(at);
        if (pid === 0 && pmtPid === null) {
            const sec = at + 5 + data[at + 4];
            pmtPid = ((data[sec + 10] & 0x1f) << 8) | data[sec + 11];
        }
        if (pid !== pmtPid || !(data[at + 1] & 0x40)) { packets.push(data.subarray(at, at + 188)); continue; }
        const from = at + 5 + data[at + 4];
        const len = ((data[from + 1] & 0x0f) << 8) | data[from + 2];
        const body = edit(Buffer.from(data.subarray(from, from + 3 + len - 4)));
        const out = crc ? withCrc(body) : Buffer.concat([body, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
        const cc = data[at + 3] & 0x0f;
        const first = Buffer.alloc(188, 0xff);
        first[0] = 0x47; first[1] = 0x40 | ((pmtPid >> 8) & 0x1f); first[2] = pmtPid & 0xff; first[3] = 0x10 | cc; first[4] = 0;
        out.copy(first, 5, 0, 183);
        const second = Buffer.alloc(188, 0xff);
        const rest = out.subarray(183);
        second[0] = 0x47; second[1] = (pointer ? 0x40 : 0) | ((pmtPid >> 8) & 0x1f); second[2] = pmtPid & 0xff; second[3] = 0x10 | ((cc + 1) & 0x0f);
        if (pointer) { second[4] = rest.length; rest.copy(second, 5); } else rest.copy(second, 4);
        packets.push(first, second);
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat(packets));
    return file;
}
/** A 170-byte private descriptor in the programme info: the ES loop moves into the second packet. */
function padded(sec) {
    const pil = ((sec[10] & 0x0f) << 8) | sec[11];
    const pad = Buffer.concat([Buffer.from([0x80, 168]), Buffer.alloc(168, 0x20)]);
    const body = Buffer.concat([sec.subarray(0, 12 + pil), pad, sec.subarray(12 + pil)]);
    const length = body.length - 3 + 4;
    body[1] = (body[1] & 0xf0) | ((length >> 8) & 0x0f); body[2] = length & 0xff;
    const pil2 = pil + pad.length;
    body[10] = (body[10] & 0xf0) | ((pil2 >> 8) & 0x0f); body[11] = pil2 & 0xff;
    return body;
}
const entriesOf = (sec) => { const out = []; for (let e = 12 + (((sec[10] & 0x0f) << 8) | sec[11]); e + 5 <= sec.length; e += 5 + (((sec[e + 3] & 0x0f) << 8) | sec[e + 4])) out.push(e); return out; };

test('a PMT split over two packets, the sound in the second: a looping picture over live sound is still not a loop', { skip }, () => {
    const r = run([rewritePmt('split-pmt.ts', padded)]);
    assert.ok(r.detector.pmtAudioPid !== null, 'the sound is read from the PMT\'s second packet');
    assert.equal(r.verdict, null, JSON.stringify(r.verdict));
    assert.match(r.detector.notes.join(' | '), /the sound does not/);
});

// Codex check of 0cce183: section_length bytes collected do not prove a PMT intact. Each of these, read as it stands,
// says "no sound" (so a looping picture over live sound would be a loop); each is now ignored, the sound stays unknown,
// and nothing is judged.
test('a damaged PMT is ignored, never taken as "no sound": a wrong CRC, a corrupted length, a truncated section', { skip }, () => {
    const noAudio = (sec) => { const [, a] = entriesOf(sec); sec[a] = 0x06; sec[a + 3] &= 0xf0; sec[a + 4] = 0; return sec; }; // not sound
    const cases = {
        'bad-crc.ts': rewritePmt('bad-crc.ts', (sec) => noAudio(padded(sec)), { crc: false }),
        // The video entry's ES_info_length runs past the section: read as it stands, the audio entry is skipped.
        'bad-length.ts': rewritePmt('bad-length.ts', (sec) => { const body = padded(sec); const [v] = entriesOf(body); body[v + 3] |= 0x0f; body[v + 4] = 0xff; return body; }),
        // section_length cut two bytes into the audio entry (CRC recomputed): its entry does not fit.
        'truncated.ts': rewritePmt('truncated.ts', (sec) => {
            const body = padded(sec);
            const [, a] = entriesOf(body);
            const cut = Buffer.from(body.subarray(0, a + 2));
            const length = cut.length - 3 + 4;
            cut[1] = (cut[1] & 0xf0) | ((length >> 8) & 0x0f); cut[2] = length & 0xff;
            return cut;
        })
    };
    for (const [name, file] of Object.entries(cases)) {
        const r = run([file]);
        assert.equal(r.verdict, null, `${name}: ${JSON.stringify(r.verdict)}`);
        assert.equal(r.detector.sawPmt, false, `${name}: the damaged PMT was not used`);
        assert.match(r.detector.notes.join(' | '), /its sound is not known: not judged/, `${name}: no verdict without a PMT it can trust`);
    }
});

// Codex check of 0cce183: on a payload-unit start, the bytes before the pointer_field's target finish the section in
// progress. A PMT whose second packet is itself a unit start, its pointer_field covering the rest of the section.
test('a PMT finished by the bytes before the next packet\'s pointer_field is read', { skip }, () => {
    const r = run([rewritePmt('pointer-pmt.ts', padded, { pointer: true })]);
    assert.ok(r.detector.sawPmt, 'the PMT was read whole');
    assert.ok(r.detector.pmtAudioPid !== null, 'its sound found');
    assert.equal(r.verdict, null);
});

// Mark's decision (#324): a loop needs its sound known. A feed with no sound in its programme is not checked, and a PMT
// that changes (a PAT naming another PMT PID) forgets what the old one said until the new one is read whole and intact.
test('a looping picture with no sound in its programme is never a loop (feeds without sound are not checked)', { skip }, () => {
    const r = run([feeds.loopNoSound]);
    assert.equal(r.verdict, null, JSON.stringify(r.verdict));
    assert.equal(r.detector.pmtAudioPid, null, 'its PMT declares no sound');
    assert.match(r.detector.notes.join(' | '), /its sound is not known: not judged/);
});

test('a PAT that moves the PMT forgets the old one: a video-only PMT then a damaged replacement never fires', { skip }, () => {
    const data = fs.readFileSync(feeds.loop); // a loop whose sound repeats too: found when its PMT is read
    const sectionAt = (at) => at + 5 + data[at + 4];
    const fixCrc = (pkt, from, total) => { const c = crc32(pkt.subarray(from, from + total - 4)); pkt.writeUInt32BE(c, from + total - 4); };
    const out = [];
    let pmtPid = null, pats = 0, pmts = 0;
    for (let at = 0; at + 188 <= data.length; at += 188) {
        const pid = ((data[at + 1] & 0x1f) << 8) | data[at + 2];
        const pkt = Buffer.from(data.subarray(at, at + 188));
        if (pid === 0 && (data[at + 1] & 0x40)) {
            const sec = sectionAt(at);
            if (pmtPid === null) pmtPid = ((data[sec + 10] & 0x1f) << 8) | data[sec + 11];
            if (++pats > 3) { // from the fourth PAT on, the PMT is on 0x1fe0
                pkt[sec - at + 10] = (pkt[sec - at + 10] & 0xe0) | 0x1f; pkt[sec - at + 11] = 0xe0;
                fixCrc(pkt, sec - at, 3 + (((data[sec + 1] & 0x0f) << 8) | data[sec + 2]));
            }
        } else if (pid === pmtPid && (data[at + 1] & 0x40)) {
            const from = sectionAt(at) - at;
            const len = ((pkt[from + 1] & 0x0f) << 8) | pkt[from + 2];
            if (++pmts <= 3) {
                // The first PMTs: video only (the sound's entry dropped, lengths and CRC made right).
                const sec = pkt.subarray(from, from + 3 + len);
                const [, a] = entriesOf(sec);
                const aEnd = a + 5 + (((sec[a + 3] & 0x0f) << 8) | sec[a + 4]);
                const body = Buffer.concat([sec.subarray(0, a), sec.subarray(aEnd, 3 + len - 4)]);
                const nl = body.length - 3 + 4;
                body[1] = (body[1] & 0xf0) | ((nl >> 8) & 0x0f); body[2] = nl & 0xff;
                const whole = withCrc(body);
                pkt.fill(0xff, from); whole.copy(pkt, from);
            } else {
                // Later: on the new PID, and damaged (its CRC wrong).
                pkt[1] = (pkt[1] & 0xe0) | 0x1f; pkt[2] = 0xe0;
                pkt[from + 3 + len - 1] ^= 0xff;
            }
        }
        out.push(pkt);
    }
    const file = path.join(dir, 'pmt-moves.ts');
    fs.writeFileSync(file, Buffer.concat(out));
    const r = run([file]);
    assert.equal(r.detector.pmtPid, 0x1fe0, 'the PAT moved the PMT');
    assert.equal(r.detector.sawPmt, false, 'the damaged new PMT was never taken');
    assert.equal(r.verdict, null, JSON.stringify(r.verdict));
});

// T2, where the FOX Footy capture is at hand (PIGTV_LOOP_SAMPLE=<path to pos_1183.ts>): still a loop of 36.22 s.
const sample = process.env.PIGTV_LOOP_SAMPLE;
test('the FOX Footy capture is still a loop of 36.22 s, its sound repeating too', { skip: !(sample && fs.existsSync(sample)) && 'PIGTV_LOOP_SAMPLE is not set' }, () => {
    const r = require('../scripts/feed-loop-check').check(sample);
    assert.ok(r.verdict, 'found');
    assert.ok(Math.abs(r.verdict.periodSec - 36.22) < 0.05, `period ${r.verdict.periodSec} s`);
    assert.equal(r.verdict.audio, 'repeats');
    assert.ok(r.foundAtSec < 90, `found ${r.foundAtSec.toFixed(1)} s in`);
});
