/**
 * Issue #3: where a reader joining a running shared feed (ingest.js) should start, so the first video
 * its ffmpeg sees is decodable. A copy session copies audio from the first packet and video only from
 * the first key frame: joined at an arbitrary PAT it starts with up to a group of pictures of sound and
 * no picture, which AVPlayer never recovers from. A new connection starts on a key frame; a join now
 * does too: the newest complete PAT and PMT before the latest video key frame in the buffer, then the
 * stream from that key frame's first packet.
 *
 * 188-byte packets only, found the way ingest.js finds PATs (a sync byte, and another a packet later
 * or the end of the data). PAT -> PMT -> the first video stream; a key frame is a packet on that PID
 * that starts a PES and either carries the adaptation field's random_access_indicator or whose
 * access unit, before its first picture, holds an H.264 IDR/SPS, an HEVC IRAP/VPS/SPS, or an MPEG-2
 * sequence header. Anything not understood returns a reason and the caller keeps its old join point.
 */
'use strict';

const TS_PACKET = 188;
const SYNC = 0x47;
const VIDEO = { 0x01: 'mpeg2', 0x02: 'mpeg2', 0x1b: 'h264', 0x24: 'hevc' };

/** Call `fn(offset)` for every aligned packet in `buf`; resyncs byte by byte after damage. */
function eachPacket(buf, fn) {
    let i = 0;
    while (i + TS_PACKET <= buf.length) {
        if (buf[i] === SYNC && (i + TS_PACKET === buf.length || buf[i + TS_PACKET] === SYNC)) { fn(i); i += TS_PACKET; } else i++;
    }
}

const pidOf = (buf, i) => ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
const startsUnit = (buf, i) => (buf[i + 1] & 0x40) !== 0;

/** Offset of the packet's payload, or -1 (no payload, or an adaptation field that fills it). */
function payloadOf(buf, i) {
    const afc = (buf[i + 3] >> 4) & 3;
    if (!(afc & 1)) return -1;
    const p = afc & 2 ? i + 5 + buf[i + 4] : i + 4;
    return p < i + TS_PACKET ? p : -1;
}

/** The section a PSI packet starts (pointer field followed), bounded by the packet: { at, end } or null. */
function sectionOf(buf, i) {
    const p = payloadOf(buf, i);
    if (p < 0 || !startsUnit(buf, i)) return null;
    const at = p + 1 + buf[p];
    const limit = i + TS_PACKET;
    if (at + 3 > limit) return null;
    const length = ((buf[at + 1] & 0x0f) << 8) | buf[at + 2];
    return { at, end: Math.min(at + 3 + length - 4, limit) }; // less the CRC
}

/** The bytes of a section collected from `packets` (sectionCollector), from its table_id to its end; packets with no payload add none. */
function sectionBytes(buf, packets) {
    const parts = packets.map((i, n) => {
        const p = payloadOf(buf, i);
        if (p < 0) return buf.subarray(0, 0); // a packet its adaptation field fills
        return buf.subarray(n === 0 ? p + 1 + buf[p] : p, i + TS_PACKET);
    });
    const all = Buffer.concat(parts);
    return all.subarray(0, Math.min(all.length, 3 + (((all[1] & 0x0f) << 8) | all[2])));
}

/** The first video stream of a whole PMT section (from sectionBytes), or null. */
function videoOfPmt(sec) {
    const end = sec.length - 4; // less the CRC
    if (sec[0] !== 0x02 || end < 12) return null;
    for (let e = 12 + (((sec[10] & 0x0f) << 8) | sec[11]); e + 5 <= end; e += 5 + (((sec[e + 3] & 0x0f) << 8) | sec[e + 4])) {
        const codec = VIDEO[sec[e]];
        if (codec) return { pid: ((sec[e + 1] & 0x1f) << 8) | sec[e + 2], codec };
    }
    return null;
}

/**
 * Follows a stream's PAT and PMT in stream order: `add(i)` takes every packet and says whether it
 * was a table's. `pat` and `pmt` are the newest complete tables' packets, `video` the PMT's video
 * stream, read from the whole section (#309: never from a PMT still part-way), and `changing` is
 * true while a PMT that differs from the current one is part-way.
 */
function tableTracker(buf) {
    const addPat = sectionCollector(buf);
    let addPmt = sectionCollector(buf);
    const t = { pmtPid: null, pat: null, pmt: null, video: null, sawPmt: false, changing: false };
    const sameStart = (i, j) => {
        const a = sectionOf(buf, i);
        const b = sectionOf(buf, j);
        return !!a && !!b && buf.subarray(a.at, i + TS_PACKET).equals(buf.subarray(b.at, j + TS_PACKET));
    };
    t.add = (i) => {
        const pid = pidOf(buf, i);
        if (pid === 0) {
            const done = addPat(i);
            if (!done) return true;
            const next = pmtPidOf(buf, done[0]);
            if (next === null) return true;
            t.pat = done;
            if (next !== t.pmtPid) { t.pmtPid = next; t.pmt = null; t.video = null; t.changing = false; addPmt = sectionCollector(buf); }
            return true;
        }
        if (pid !== t.pmtPid) return false;
        const done = addPmt(i);
        if (done) {
            const sec = sectionBytes(buf, done);
            // current_next_indicator 0: a table announced for later, not yet in force.
            if (sec[0] === 0x02 && sec.length > 5 && (sec[5] & 0x01)) { t.pmt = done; t.video = videoOfPmt(sec); t.sawPmt = true; }
            t.changing = false;
        } else {
            const start = addPmt.pending();
            t.changing = start >= 0 && !(t.pmt && sameStart(start, t.pmt[0]));
        }
        return true;
    };
    return t;
}

/** The program's video PID and codec, from the newest complete PAT and PMT in `buf`, or a reason. */
function videoStreamOf(buf) {
    const t = tableTracker(buf);
    let video = null;
    eachPacket(buf, (i) => { if (t.add(i) && t.pmt) video = t.video; });
    if (!t.sawPmt) return { reason: 'no PMT' };
    if (!video) return { reason: 'no video stream it reads' };
    return video;
}

/** Does the elementary stream from `from` (to `end`) start a decodable picture, before its first picture? */
function startsKeyPicture(buf, from, end, codec) {
    for (let j = from; j + 3 < end; j++) {
        if (buf[j] !== 0 || buf[j + 1] !== 0 || buf[j + 2] !== 1) continue;
        const b = buf[j + 3];
        if (codec === 'h264') {
            const type = b & 0x1f;
            if (type === 5 || type === 7) return true;   // IDR, SPS
            if (type >= 1 && type <= 4) return false;    // a non-IDR picture came first
        } else if (codec === 'hevc') {
            const type = (b >> 1) & 0x3f;
            if ((type >= 16 && type <= 21) || type === 32 || type === 33) return true; // IRAP, VPS, SPS
            if (type < 32) return false;
        } else {
            if (b === 0xb3) return true;                 // sequence header
            if (b === 0x00) return false;                // picture start
        }
        j += 2;
    }
    return false;
}

/** Is the packet at `i` (on the video PID) the start of a key frame? */
function isKeyFrame(buf, i, codec) {
    if (!startsUnit(buf, i)) return false;
    const afc = (buf[i + 3] >> 4) & 3;
    if (afc & 2 && buf[i + 4] > 0 && (buf[i + 5] & 0x40)) return true; // random_access_indicator
    const p = payloadOf(buf, i);
    const end = i + TS_PACKET;
    if (p < 0 || p + 9 > end || buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) return false;
    return startsKeyPicture(buf, p + 9 + buf[p + 8], end, codec);
}

/** The PMT PID of the first program in a PAT that starts in the packet at `i`, or null. */
function pmtPidOf(buf, i) {
    const s = sectionOf(buf, i);
    if (!s || buf[s.at] !== 0x00) return null;
    for (let e = s.at + 8; e + 4 <= s.end; e += 4) {
        const program = (buf[e] << 8) | buf[e + 1];
        if (program !== 0) return ((buf[e + 2] & 0x1f) << 8) | buf[e + 3];
    }
    return null;
}

const ccOf = (buf, i) => buf[i + 3] & 0x0f;

/**
 * Collects one PSI section's packets as they come (a section may span several packets). `add(i)`
 * returns the offsets of every packet of a section it has just completed, else null. Continuity
 * counters are followed (#309): a repeated packet (the same counter again) is skipped, and a gap
 * drops the part-collected section, so a section is never completed from the wrong packets.
 */
function sectionCollector(buf) {
    let packets = null;
    let need = 0;
    let cc = -1;
    const add = (i) => {
        if (startsUnit(buf, i)) {
            const p = payloadOf(buf, i);
            if (p < 0) { packets = null; return null; }
            const at = p + 1 + buf[p];
            if (at + 3 > i + TS_PACKET) { packets = null; return null; }
            packets = [i];
            cc = ccOf(buf, i);
            need = 3 + (((buf[at + 1] & 0x0f) << 8) | buf[at + 2]) - (i + TS_PACKET - at);
        } else if (packets) {
            const afc = (buf[i + 3] >> 4) & 3;
            if (!(afc & 1)) return null;                        // no payload: the counter stays
            const next = ccOf(buf, i);
            const discontinuity = (afc & 2) && buf[i + 4] > 0 && (buf[i + 5] & 0x80);
            if (!discontinuity) {
                if (next === cc) return null;                   // a repeated packet
                if (next !== ((cc + 1) & 0x0f)) { packets = null; return null; } // a lost packet
            }
            cc = next;
            // A packet whose adaptation field fills it is kept in the replay (its counter is part of
            // the sequence a joiner's demuxer checks) but carries no section bytes.
            packets.push(i);
            const p = payloadOf(buf, i);
            if (p < 0) return null;
            need -= i + TS_PACKET - p;
        } else return null;
        if (need > 0) return null;
        const done = packets;
        packets = null;
        return done;
    };
    add.pending = () => (packets ? packets[0] : -1);
    return add;
}

/**
 * Where a joiner should start in `buf` (#3): `{ at, tables, codec }`, where `at` is the first packet
 * of the newest video key frame and `tables` the offsets of the packets that carry the most recent
 * complete PAT and PMT before it (to be sent first, as found: a joiner's demuxer needs them to read
 * the key frame). Nothing between those tables and the key frame belongs in the join: audio or
 * pictures from before the key frame would start sound before the picture. `{ at: -1, reason }`
 * when that cannot be said (the caller keeps its old join point).
 */
function keyframeJoin(buf) {
    try {
        const video = videoStreamOf(buf);
        if (video.reason) return { at: -1, reason: video.reason };
        const t = tableTracker(buf);
        let pick = null;
        let keys = 0;
        eachPacket(buf, (i) => {
            if (t.add(i)) return;
            const pid = pidOf(buf, i);
            // A key frame on the video PID of the PMT in force at this point (#309: a PMT part-way that
            // moves the video is not in force yet), and none while a different PMT is part-way.
            const current = !!t.video && pid === t.video.pid && isKeyFrame(buf, i, t.video.codec);
            if (current || (pid === video.pid && isKeyFrame(buf, i, video.codec))) keys++;
            if (current && t.pat && t.pmt && !t.changing) pick = { at: i, tables: [...t.pat, ...t.pmt], codec: t.video.codec };
        });
        if (!keys) return { at: -1, reason: 'no video key frame' };
        if (!pick) return { at: -1, reason: 'no PAT and PMT before the key frame' };
        return pick;
    } catch (err) {
        return { at: -1, reason: 'the stream could not be read' };
    }
}

module.exports = { keyframeJoin, videoStreamOf, isKeyFrame };
