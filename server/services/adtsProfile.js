/**
 * FR-9 (0302): the AAC object type each audio track of an MPEG-TS feed declares in its ADTS headers.
 *
 * ffprobe reports a feed by what its decoder finds ("HE-AAC" once SBR is detected), not by the
 * label in the ADTS header. That label is what `-bsf:a aac_adtstoasc` copies into an fMP4
 * session's AudioSpecificConfig (object type = ADTS profile + 1), and it is what the player
 * reads. Strong8K's FOX affiliates (28 Oct) label their HE-AAC as profile 0, AAC Main, at
 * 24 kHz: Apple does not decode AAC Main, and a copy fails at once with `fmt?`
 * (CoreMediaErrorDomain 1718449215). Relabelled as AAC-LC the same segments play, so only a
 * copy of an AAC-LC label (object type 2) is safe; anything else is re-encoded.
 *
 * Labels are kept per PID (Codex review of 0302): the caller picks the track the session maps,
 * which need not be the first audio PID to arrive. The start of each PES is reassembled across
 * TS packets until its header and the first ADTS bytes are in hand, since a packetizer may split
 * either; a continuity-counter break drops what was gathered rather than guess.
 *
 * Plain data in, plain data out: the probe feeds it the bytes it already reads.
 */
'use strict';

const TS_PACKET = 188;
const SYNC = 0x47;
// Enough for the first audio PES of every track of any live feed seen here.
const MAX_SNIFF_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 9 + 255 + 3; // the longest PES header plus the three ADTS bytes needed

/** The object type in a PES start (`head`): a number, null (not ADTS audio: settled), or undefined (need more bytes). */
function labelOf(head) {
    if (head.length < 4) return undefined;
    if (head[0] !== 0 || head[1] !== 0 || head[2] !== 1) return null;
    if (head[3] < 0xC0 || head[3] > 0xDF) return null; // not an audio stream id
    if (head.length < 9) return undefined;
    const h = 9 + head[8]; // past the PES header's optional fields
    if (head.length < h + 3) return undefined;
    // ADTS: a 12-bit syncword, layer 0; the profile is the top two bits of the third byte.
    if (head[h] !== 0xFF || (head[h + 1] & 0xF6) !== 0xF0) return null;
    return ((head[h + 2] >> 6) & 0x3) + 1;
}

/** Reads TS packets as they come and keeps the first ADTS object type seen on each PID. */
class AdtsSniffer {
    constructor() {
        this.rest = null;        // a partial packet carried into the next chunk
        this.bytes = 0;
        this.types = new Map();  // PID -> object type (1 Main, 2 LC, 3 SSR, 4 LTP)
        this.pending = new Map(); // PID -> { head: Buffer, cc }
        this.settled = new Set(); // PIDs whose first PES was not ADTS audio
        this.done = false;
    }

    push(chunk) {
        if (this.done) return;
        this.bytes += chunk.length;
        const buf = this.rest && this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
        let i = 0;
        while (i + TS_PACKET <= buf.length && !(buf[i] === SYNC && (i + TS_PACKET >= buf.length || buf[i + TS_PACKET] === SYNC))) i++;
        for (; i + TS_PACKET <= buf.length; i += TS_PACKET) {
            if (buf[i] !== SYNC) { // lost alignment: drop partial PES starts, find the sync again
                this.pending.clear();
                const next = buf.indexOf(SYNC, i + 1);
                if (next < 0) { i = buf.length; break; }
                i = next - TS_PACKET;
                continue;
            }
            this.packet(buf, i);
        }
        this.rest = i < buf.length ? Buffer.from(buf.subarray(i)) : null;
        if (this.bytes >= MAX_SNIFF_BYTES) this.finish();
    }

    packet(buf, i) {
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        if (this.types.has(pid) || this.settled.has(pid)) return;
        const start = (buf[i + 1] & 0x40) !== 0;
        const adaptation = (buf[i + 3] >> 4) & 0x3;
        const cc = buf[i + 3] & 0xf;
        if (!(adaptation & 0x1)) return; // no payload (and the counter does not advance)
        let p = i + 4;
        if (adaptation & 0x2) p += 1 + buf[i + 4];
        const end = i + TS_PACKET;
        if (p > end) return;
        const payload = buf.subarray(p, end);
        let entry = this.pending.get(pid);
        if (start) entry = { head: Buffer.alloc(0), cc };
        else if (!entry) return; // a continuation of a PES whose start we never saw
        else if (cc !== ((entry.cc + 1) & 0xf)) { this.pending.delete(pid); return; } // a gap: what we hold may be wrong
        else entry.cc = cc;
        entry.head = Buffer.concat([entry.head, payload]).subarray(0, HEAD_BYTES);
        const label = labelOf(entry.head);
        if (label === undefined) { this.pending.set(pid, entry); return; }
        this.pending.delete(pid);
        if (label === null) this.settled.add(pid);
        else this.types.set(pid, label);
    }

    finish() { this.done = true; this.rest = null; this.pending.clear(); }

    /** The object type of `pid`, or - with no PID - of the first audio track found; null when unread. */
    objectTypeFor(pid = null) {
        if (pid !== null && pid !== undefined) return this.types.get(pid) ?? null;
        return this.types.size ? this.types.values().next().value : null;
    }
}

/** Every audio PID's object type in `buf`, as a Map. */
function adtsObjectTypes(buf) {
    const s = new AdtsSniffer();
    if (buf && buf.length) s.push(buf);
    return s.types;
}

/** The object type of `pid` in `buf` (or of the first audio track found), or null. */
function adtsObjectType(buf, pid = null) {
    const s = new AdtsSniffer();
    if (buf && buf.length) s.push(buf);
    return s.objectTypeFor(pid);
}

/** An AAC object type a copy may carry to every client (AAC-LC, with SBR/PS in-band). */
const copyableObjectType = (objectType) => objectType === null || objectType === undefined || objectType === 2;

module.exports = { adtsObjectType, adtsObjectTypes, AdtsSniffer, copyableObjectType, MAX_SNIFF_BYTES };
