/**
 * #324: a provider feed that sends the same clip again and again with fresh timestamps. FOX Footy on
 * Strong8K, 14 Nov 2026: every video packet's payload equalled the one exactly 1811 packets (36.22 s)
 * earlier, audio likewise every 1129 frames, while the timestamps rose smoothly - so the stall,
 * lag and timestamp checks all took it as healthy. Read on the provider's own bytes (ingest.js),
 * payload only: the timestamps a looping provider rewrites are never hashed.
 *
 *   - Each video access unit (PES) and each audio frame (ADTS, AC-3, E-AC-3; else the PES) is hashed
 *     (two 32-bit FNV-style lanes over the elementary-stream bytes, video sampled: HEAD, STRIDE; the
 *     PES header, which carries the PTS/DTS, is skipped). The hashes of up to `capacity` units are
 *     kept per track, with their DTS (else PTS) in seconds, which only measures how long things last.
 *   - A RUN: consecutive units each equal to the unit exactly P units earlier. P is found from the
 *     last earlier unit with the same hash, and must span minPeriodSec..maxPeriodSec of media.
 *   - A video run counts once it outlasts a whole period by max(minRunSec, a quarter period), i.e. the
 *     content has been seen ~2.25 times: one clip aired twice in a row (an ad, a promo, a replay) never
 *     fires; three airings back to back can (requiredRun). And only when one period of it is a clip, not
 *     a still picture: at least
 *     minDistinct of its units distinct (a re-encoded slate repeats every group of pictures or two),
 *     at least minKeyframes key frames in it (P spans several groups of pictures), and its timestamps
 *     rise evenly across it (a provider's resend of old content with its old clock is not a loop).
 *   - Sound confirms it, or does not contradict it: with no audio, or audio repeating with the same
 *     period (within 1 s), or audio that is silence (few distinct frames) it is a loop. Audio that is
 *     live (distinct, not repeating) means a looping picture over live sound (a radio channel's
 *     background video): never a loop. Audio alone never counts.
 *
 * Detected after two periods plus max(minRunSec, a quarter period) of media (82 s for the 36 s loop). Bounded: two tracks of
 * `capacity` units (17 bytes each in typed arrays) and a Map of their hashes: at most ~1.4 MB per feed.
 * A new connection starts it afresh (`reset`): the 7 channels' reconnect resends ~19 s of old
 * content (playback.md), which must never be compared with what came before the cut.
 */
'use strict';

const TS_PACKET = 188;
const SYNC = 0x47;
const PTS_WRAP = 2 ** 33;
// Video: a unit's first HEAD bytes are hashed whole (its headers say which picture it is), then every
// STRIDE-th byte by its place in the unit (never by packet: the muxer's PCRs move packet boundaries
// between two passes of a loop), with the unit's length. Entropy-coded pictures that differ differ
// there; a repeat is equal everywhere. About a sixth of the work of hashing every byte.
const HEAD = 256;
const STRIDE = 8;
// Audio: the most of one PES assembled to be split into frames (a PES holds a few frames of ~0.2-4 kB).
const MAX_AUDIO_UNIT = 64 * 1024;
const VIDEO_TYPES = { 0x01: 'mpeg2', 0x02: 'mpeg2', 0x1b: 'h264', 0x24: 'hevc' };
const { isKeyFrame } = require('./tsKeyframes');

const tuning = {
    minRunSec: 10,       // consecutive repeated media before a run is looked at
    // A run must outlast one whole period by this much (at least minRunSec): the content seen ~2.25 times.
    // One airing followed by its copy (an ad or promo twice in a row, a replay) runs one period at most.
    beyondPeriod: 0.25,
    minPeriodSec: 5,     // shorter repeats are a still picture's group-of-pictures rhythm
    maxPeriodSec: 120,   // the longest loop looked for (memory: capacity units must cover it)
    minKeyframes: 3,     // key frames within one period
    minDistinct: 0.8,    // share of distinct video units within one period
    audioSlackSec: 1,    // audio's period may differ from video's by this much
    silentDistinct: 0.5, // audio this repetitive over the last 10 s is silence or a tone
    confirmWithinSec: 20, // a video run's audio is looked at for this long, then left alone
    capacity: 8192       // units per track: 120 s at 60 fps is 7200
};

// AC-3 frame sizes in 16-bit words, by frmsizecod >> 1, for 48, 44.1 and 32 kHz (ATSC A/52 table 5.18).
const AC3_WORDS = [
    [64, 69, 96], [80, 87, 120], [96, 104, 144], [112, 121, 168], [128, 139, 192], [160, 174, 240],
    [192, 208, 288], [224, 243, 336], [256, 278, 384], [320, 348, 480], [384, 417, 576], [448, 487, 672],
    [512, 557, 768], [640, 696, 960], [768, 835, 1152], [896, 975, 1344], [1024, 1114, 1536],
    [1152, 1253, 1728], [1280, 1393, 1920]
];

/** The length of the audio frame starting at `at` in `b`, or 0 if none is recognised there. */
function audioFrameLength(b, at, len = b.length) {
    if (at + 7 > len) return 0;
    if (b[at] === 0xff && (b[at + 1] & 0xf6) === 0xf0) {                 // ADTS (AAC)
        return ((b[at + 3] & 0x03) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
    }
    if (b[at] === 0x0b && b[at + 1] === 0x77) {
        const bsid = b[at + 5] >> 3;
        if (bsid > 10) return ((((b[at + 2] & 0x07) << 8) | b[at + 3]) + 1) * 2; // E-AC-3
        const fscod = b[at + 4] >> 6;
        const code = b[at + 4] & 0x3f;
        if (fscod > 2 || code > 37) return 0;
        const words = AC3_WORDS[code >> 1][fscod];
        return 2 * (fscod === 1 ? words + (code & 1) : words);              // 44.1 kHz pads odd codes
    }
    return 0;
}

/** Seconds a run of this period must last before it is a loop: one period, and max(minRunSec, a quarter) more. */
function requiredRun(period) {
    return period + Math.max(tuning.minRunSec, tuning.beyondPeriod * period);
}

// Audio in a PMT: MPEG-1/2 audio, AAC (ADTS, LATM), AC-3, E-AC-3; or private data (0x06) carrying an AC-3, E-AC-3 or AAC
// descriptor (DVB). Private data without one (subtitles, teletext) is not sound.
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7c]);
function isAudioEntry(b, e, stop) {
    if (AUDIO_TYPES.has(b[e])) return true;
    if (b[e] !== 0x06) return false;
    const end = Math.min(stop, e + 5 + (((b[e + 3] & 0x0f) << 8) | b[e + 4]));
    for (let d = e + 5; d + 2 <= end; d += 2 + b[d + 1]) if (AUDIO_DESCRIPTORS.has(b[d])) return true;
    return false;
}

class Track {
    constructor(kind) {
        this.kind = kind;
        const n = tuning.capacity;
        this.cap = n;
        this.keys = new Float64Array(n);  // a 53-bit hash
        this.times = new Float64Array(n); // seconds (DTS, else PTS), unwrapped
        this.keyframe = new Uint8Array(n);
        this.last = new Map();            // hash -> newest index with it
        this.count = 0;
        this.period = 0;
        this.runStart = -1;
        this.runStartTime = 0;
        this.runStartSpan = 0;
        this.lastRaw = null;
        this.wraps = 0;
        this.time = 0;
        this.pid = null;
        // The unit being read.
        this.open = false;
        this.h1 = 0;
        this.h2 = 0;
        this.unitTime = 0;
        this.unitKey = false;
        this.unitBytes = 0;
        this.audio = null;                // audio: the PES's bytes, split into frames at its end
        this.audioLen = 0;
    }

    timeOf(raw) {
        if (this.lastRaw !== null) {
            const step = raw - this.lastRaw;
            if (step < -PTS_WRAP / 2) this.wraps++;
            else if (step > PTS_WRAP / 2) this.wraps--;
        }
        this.lastRaw = raw;
        return (raw + this.wraps * PTS_WRAP) / 90000;
    }

    /** A new unit; `limit` is the elementary-stream bytes its PES header declares (Infinity when unbounded). */
    begin(time, key, limit = Infinity) {
        this.open = true;
        this.fresh();
        this.unitTime = time;
        this.unitKey = key;
        this.unitBytes = 0;
        this.unitLimit = limit;
        this.audioLen = 0;
    }

    fresh() {
        this.h1 = 0x811c9dc5;
        this.h2 = 0x9747b28c;
    }

    /** Every STRIDE-th byte of b[from, to), where b[from] is the unit's byte number `off`. */
    sample(b, from, to, off) {
        let h1 = this.h1;
        let h2 = this.h2;
        for (let j = from + ((STRIDE - (off % STRIDE)) % STRIDE); j < to; j += STRIDE) {
            const x = b[j];
            h1 = Math.imul(h1 ^ x, 0x01000193);
            h2 = Math.imul(h2 ^ x, 0x5bd1e995);
            h2 ^= h2 >>> 15;
        }
        this.h1 = h1;
        this.h2 = h2;
    }

    hash(b, from, to) {
        let h1 = this.h1;
        let h2 = this.h2;
        for (let j = from; j < to; j++) {
            const x = b[j];
            h1 = Math.imul(h1 ^ x, 0x01000193);
            h2 = Math.imul(h2 ^ x, 0x5bd1e995);
            h2 ^= h2 >>> 15;
        }
        this.h1 = h1;
        this.h2 = h2;
    }

    /**
     * Bytes of the unit. Video: its first HEAD bytes whole (the headers that say which picture it is),
     * then every STRIDE-th byte, counted from the unit's start so the packet boundaries (which move
     * with the muxer's PCRs) do not matter; and its length.
     */
    take(b, from, to) {
        if (!this.open || to <= from) return;
        if (this.kind === 'video') {
            const off = this.unitBytes;
            this.unitBytes += to - from;
            if (off < HEAD) {
                const whole = Math.min(to, from + HEAD - off);
                this.hash(b, from, whole);
                if (whole >= to) return;
                return this.sample(b, whole, to, HEAD);
            }
            return this.sample(b, from, to, off);
        }
        // Bounded (Codex #324 high): what the PES header declares and no more, and at most MAX_AUDIO_UNIT; a unit
        // over that (packets that never start a new PES, a broken header) is dropped, not hashed. Only the hash is lost.
        const n = Math.min(to - from, this.unitLimit - this.audioLen);
        if (n <= 0) return;
        if (this.audioLen + n > MAX_AUDIO_UNIT) {
            this.open = false;
            this.audioLen = 0;
            this.dropped = (this.dropped || 0) + 1;
            return;
        }
        if (!this.audio || this.audioLen + n > this.audio.length) {
            const grown = Buffer.alloc(Math.min(MAX_AUDIO_UNIT, Math.max(4096, (this.audioLen + n) * 2)));
            if (this.audio) this.audio.copy(grown, 0, 0, this.audioLen);
            this.audio = grown;
        }
        b.copy(this.audio, this.audioLen, from, from + n);
        this.audioLen += n;
    }

    /** The unit read so far is complete: add it (audio: each frame in it, else the whole PES). */
    end() {
        if (!this.open) return;
        this.open = false;
        if (this.kind === 'video') return this.add(this.h1, Math.imul(this.h2 ^ this.unitBytes, 0x5bd1e995), this.unitTime, this.unitKey);
        const b = this.audio;
        const len = this.audioLen;
        let at = 0;
        let frames = 0;
        while (at < len) {
            const size = audioFrameLength(b, at, len);
            if (size < 7 || at + size > len) break;
            this.fresh();
            this.hash(b, at, at + size);
            this.add(this.h1, this.h2, this.unitTime + frames * 1e-6, false);
            at += size;
            frames++;
        }
        if (frames === 0 && len > 0) {
            this.fresh();
            this.hash(b, 0, len);
            this.add(this.h1, this.h2, this.unitTime, false);
        }
    }

    at(i) { return i % this.cap; }

    add(h1, h2, time, key) {
        const hash = (h1 >>> 0) * 2097152 + (h2 >>> 11);
        const i = this.count++;
        const slot = i % this.cap;
        if (i >= this.cap) {
            const old = this.keys[slot];
            if (this.last.get(old) === i - this.cap) this.last.delete(old);
        }
        this.keys[slot] = hash;
        this.times[slot] = time;
        this.keyframe[slot] = key ? 1 : 0;
        this.time = time;
        const p = this.period;
        if (!(p && this.keys[(i - p) % this.cap] === hash)) {
            // The run (if any) is broken: look for a new period from this unit's last twin.
            this.period = 0;
            this.runStart = i;
            // Kept as values (Opus #324): a run outlasts its period, so these slots leave the ring before it is judged.
            this.runStartTime = time;
            this.runStartSpan = 0;
            this.judged = null;
            const prev = this.last.get(hash);
            if (prev !== undefined) {
                const span = time - this.times[prev % this.cap];
                if (span >= tuning.minPeriodSec && span <= tuning.maxPeriodSec) { this.period = i - prev; this.runStartSpan = span; }
            }
        }
        this.last.set(hash, i);
    }

    /** Seconds of the current run, 0 when there is none. */
    runSec() {
        if (!this.period) return 0;
        return this.time - this.runStartTime;
    }

    /** Seconds of one period, measured at the newest unit. */
    periodSec() {
        const i = this.count - 1;
        return this.period ? this.time - this.times[(i - this.period) % this.cap] : 0;
    }

    /** Share of distinct units among the newest `n`. */
    distinct(n) {
        const end = this.count;
        const from = Math.max(0, end - Math.min(n, this.cap));
        if (end <= from) return 1;
        const seen = new Set();
        for (let i = from; i < end; i++) seen.add(this.keys[i % this.cap]);
        return seen.size / (end - from);
    }

    keyframesIn(n) {
        let k = 0;
        for (let i = Math.max(0, this.count - n); i < this.count; i++) k += this.keyframe[i % this.cap];
        return k;
    }

    /** Units within the newest `sec` seconds. */
    unitsWithin(sec) {
        let n = 0;
        for (let i = this.count - 1; i >= 0 && i >= this.count - this.cap; i--) {
            if (this.time - this.times[i % this.cap] > sec) break;
            n++;
        }
        return n;
    }

    memoryBytes() {
        return this.keys.byteLength + this.times.byteLength + this.keyframe.byteLength + this.last.size * 40 + (this.audio ? this.audio.length : 0);
    }
}

class LoopDetector {
    constructor() { this.reset(); }

    /** A new connection: nothing before it is compared with what follows. */
    reset() {
        this.carry = Buffer.alloc(TS_PACKET);
        this.carryLen = 0;
        this.pmtPid = null;
        this.codec = null;
        this.sawPmt = false;
        this.pmtAudioPid = null; // the programme's sound, as its PMT declares it (Opus #324)
        this.video = new Track('video');
        this.sound = new Track('audio');
        this.verdict = null;
        this.notes = [];
    }

    /** Bytes as they arrive (any split). Returns the verdict once a loop is found, else null. */
    push(chunk) {
        // Read on after a verdict: while the caller decides, the run goes on (rearm looks at it again).
        let i = 0;
        if (this.carryLen) {
            const need = TS_PACKET - this.carryLen;
            if (chunk.length < need) {
                chunk.copy(this.carry, this.carryLen);
                this.carryLen += chunk.length;
                return null;
            }
            chunk.copy(this.carry, this.carryLen, 0, need);
            this.carryLen = 0;
            if (this.carry[0] === SYNC) this.packet(this.carry, 0);
            i = need;
        }
        const n = chunk.length;
        while (i < n) {
            if (chunk[i] !== SYNC) { i++; continue; }
            if (i + TS_PACKET > n) break;
            this.packet(chunk, i);
            i += TS_PACKET;
        }
        if (i < n) {
            chunk.copy(this.carry, 0, i, n);
            this.carryLen = n - i;
        }
        return this.verdict;
    }

    packet(b, i) {
        const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
        const unitStart = (b[i + 1] & 0x40) !== 0;
        const afc = (b[i + 3] >> 4) & 3;
        if (!(afc & 1)) return;
        const p = afc & 2 ? i + 5 + b[i + 4] : i + 4;
        const end = i + TS_PACKET;
        if (p >= end) return;
        if (pid === 0) { if (unitStart) this.readPat(b, p, end); return; }
        if (pid === this.pmtPid) { if (unitStart) this.readPmt(b, p, end); return; }
        let track = pid === this.video.pid ? this.video : pid === this.sound.pid ? this.sound : null;
        if (unitStart) {
            if (p + 9 > end || b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) return;
            const sid = b[p + 3];
            if (!track) {
                // The first video PES stream by stream id. The sound is the PMT's (readPmt): 0xbd is also DVB
                // subtitles and teletext. Before any PMT, only an MPEG audio stream id (0xc0-0xdf) is taken as sound.
                if (sid >= 0xe0 && sid <= 0xef && this.video.pid === null) { track = this.video; track.pid = pid; }
                else if (sid >= 0xc0 && sid <= 0xdf && this.sound.pid === null && !this.sawPmt) { track = this.sound; track.pid = pid; }
                else return;
            }
            track.end();
            if (track.kind === 'video') this.judge();
            const flags = b[p + 7];
            const es = p + 9 + b[p + 8];
            let raw = null;
            const ts = (flags & 0xc0) === 0xc0 ? p + 14 : (flags & 0x80) ? p + 9 : -1;
            if (ts >= 0 && ts + 5 <= end) {
                raw = (b[ts] & 0x0e) * 536870912 + b[ts + 1] * 4194304 + (b[ts + 2] >> 1) * 32768 + b[ts + 3] * 128 + (b[ts + 4] >> 1);
            }
            const time = raw === null ? track.time : track.timeOf(raw);
            const key = track.kind === 'video' && (
                (afc & 2 && b[i + 4] > 0 && (b[i + 5] & 0x40) !== 0) || (!!this.codec && isKeyFrame(b, i, this.codec)));
            const declared = (b[p + 4] << 8) | b[p + 5]; // PES_packet_length: 0 is unbounded (video)
            track.begin(time, key, declared ? Math.max(0, declared - 3 - b[p + 8]) : Infinity);
            if (es < end) track.take(b, es, end);
            return;
        }
        if (track) track.take(b, p, end);
    }

    readPat(b, p, end) {
        const at = p + 1 + b[p];
        if (at + 8 > end || b[at] !== 0x00) return;
        const length = ((b[at + 1] & 0x0f) << 8) | b[at + 2];
        const stop = Math.min(at + 3 + length - 4, end);
        for (let e = at + 8; e + 4 <= stop; e += 4) {
            if (((b[e] << 8) | b[e + 1]) !== 0) { this.pmtPid = ((b[e + 2] & 0x1f) << 8) | b[e + 3]; return; }
        }
    }

    readPmt(b, p, end) {
        const at = p + 1 + b[p];
        if (at + 12 > end || b[at] !== 0x02) return;
        const length = ((b[at + 1] & 0x0f) << 8) | b[at + 2];
        const stop = Math.min(at + 3 + length - 4, end);
        let video = null;
        let audio = null;
        for (let e = at + 12 + (((b[at + 10] & 0x0f) << 8) | b[at + 11]); e + 5 <= stop; e += 5 + (((b[e + 3] & 0x0f) << 8) | b[e + 4])) {
            const pid = ((b[e + 1] & 0x1f) << 8) | b[e + 2];
            if (!video && VIDEO_TYPES[b[e]]) video = VIDEO_TYPES[b[e]];
            else if (audio === null && isAudioEntry(b, e, stop)) audio = pid;
        }
        this.sawPmt = true;
        if (video) this.codec = video;
        this.pmtAudioPid = audio;
        // The sound followed is the PMT's: a stream taken before it (or before a PMT change) is dropped.
        if (this.sound.pid !== audio) {
            this.sound = new Track('audio');
            this.sound.pid = audio;
        }
    }

    note(text) { if (this.notes.length < 20) this.notes.push(text); }

    /** After each video unit: has the current run become a loop? */
    judge() {
        if (this.verdict) return;
        const v = this.video;
        const run = v.runSec();
        if (run < tuning.minRunSec) return;
        if (v.judged === undefined || v.judged === null) {
            const period = v.periodSec();
            const distinct = v.distinct(v.period);
            const keyframes = v.keyframesIn(v.period);
            // The clock across the run: one period ago at its start and now must be the same span.
            const even = Math.abs(v.runStartSpan - period) <= 1;
            v.judged = { period, distinct, keyframes, even, ok: distinct >= tuning.minDistinct && keyframes >= tuning.minKeyframes && even && period >= tuning.minPeriodSec };
            if (!v.judged.ok) {
                this.note(`video repeats every ${period.toFixed(1)} s for ${run.toFixed(1)} s but is not a clip ` +
                    `(${Math.round(distinct * 100)}% distinct, ${keyframes} key frames, clock ${even ? 'even' : 'uneven'})`);
            }
        }
        const j = v.judged;
        if (!j.ok || j.settled) return;
        // A sustained loop only (Codex #324 high): the run outlasts a whole period, then (rearm) one more each time.
        const need = j.askAt ?? requiredRun(j.period);
        if (run < need) return;
        const sound = this.soundVerdict(j.period, run, need);
        if (sound === null) return; // not yet: look again at the next unit
        if (sound === false) return;
        this.verdict = { periodSec: Math.round(j.period * 100) / 100, periodUnits: v.period, runSec: Math.round(run * 10) / 10,
            distinct: Math.round(j.distinct * 1000) / 1000, keyframes: j.keyframes, audio: sound };
    }

    /** 'repeats' | 'silent' | 'none' to confirm, false when the sound is live, null to wait. */
    soundVerdict(period, run, need) {
        const a = this.sound;
        const v = this.video;
        const settle = (value) => { v.judged.settled = true; return value; };
        if (!a.count || Math.abs(v.time - a.time) > 5) {
            // No sound in the programme: the picture decides. Sound declared but quiet: wait for it, and after the
            // confirmation window leave the run alone (Opus #324: never take a quiet sound PID as "no sound").
            if (this.pmtAudioPid === null) return 'none';
            if (run >= need + tuning.confirmWithinSec) {
                this.note(`video repeats every ${period.toFixed(1)} s but the declared sound sent nothing: not judged`);
                return settle(false);
            }
            return null;
        }
        if (a.period && Math.abs(a.periodSec() - period) <= tuning.audioSlackSec && a.runSec() >= tuning.minRunSec / 2) return 'repeats';
        if (Math.floor(run) === v.judged.lastLook) return null; // at most once per second of media
        v.judged.lastLook = Math.floor(run);
        if (a.distinct(a.unitsWithin(10)) < tuning.silentDistinct) return 'silent';
        if (run >= need + tuning.confirmWithinSec) {
            this.note(`video repeats every ${period.toFixed(1)} s but the sound does not: not a loop`);
            return settle(false);
        }
        return null;
    }

    /**
     * The verdict was not acted on (#324: no other provider for the channel): look again once the same run has
     * gone on for one more period, without starting the run afresh.
     */
    rearm() {
        if (!this.verdict) return;
        const v = this.video;
        if (v.judged) v.judged.askAt = v.runSec() + Math.max(v.judged.period, tuning.minRunSec);
        this.verdict = null;
    }

    describe() {
        return { verdict: this.verdict, notes: this.notes.slice(), memoryBytes: this.video.memoryBytes() + this.sound.memoryBytes() };
    }
}

module.exports = { LoopDetector, tuning, audioFrameLength, requiredRun, MAX_AUDIO_UNIT };
