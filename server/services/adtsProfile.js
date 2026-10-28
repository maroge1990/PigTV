/**
 * FR-9 (0302): the AAC object type an MPEG-TS feed's audio declares in its ADTS headers.
 *
 * ffprobe reports a feed by what its decoder finds ("HE-AAC" once SBR is detected), not by the
 * label in the ADTS header. That label is what `-bsf:a aac_adtstoasc` copies into an fMP4
 * session's AudioSpecificConfig (object type = ADTS profile + 1), and it is what the player
 * reads. Strong8K's FOX affiliates (28 Oct) label their HE-AAC as profile 0, AAC Main, at
 * 24 kHz: Apple does not decode AAC Main, and a copy fails at once with `fmt?`
 * (CoreMediaErrorDomain 1718449215). Relabelled as AAC-LC the same segments play, so only a
 * copy of an AAC-LC label (object type 2) is safe; anything else is re-encoded.
 *
 * Plain data in, plain data out: the probe feeds it the bytes it already reads.
 */
'use strict';

const TS_PACKET = 188;
const SYNC = 0x47;
// Enough for the first audio PES of any live feed seen here (an audio frame every ~21-43 ms).
const MAX_SNIFF_BYTES = 4 * 1024 * 1024;

/**
 * The object type (1 Main, 2 LC, 3 SSR, 4 LTP) of the first ADTS frame that starts an audio
 * PES in `buf`, or null when there is none (no audio yet, not ADTS, not MPEG-TS).
 */
function adtsObjectType(buf) { return scan(buf).objectType; }

// -> { objectType, rest }: `rest` is the unread tail (a partial packet) to prepend to the next chunk.
function scan(buf) {
    if (!buf || buf.length < TS_PACKET) return { objectType: null, rest: buf || null };
    let i = 0;
    while (i + TS_PACKET <= buf.length && !(buf[i] === SYNC && (i + TS_PACKET >= buf.length || buf[i + TS_PACKET] === SYNC))) i++;
    for (; i + TS_PACKET <= buf.length; i += TS_PACKET) {
        if (buf[i] !== SYNC) return { objectType: null, rest: buf.subarray(i + 1) }; // realign on the next chunk
        const payloadStart = (buf[i + 1] & 0x40) !== 0;
        const adaptation = (buf[i + 3] >> 4) & 0x3;
        if (!payloadStart || !(adaptation & 0x1)) continue;
        let p = i + 4;
        if (adaptation & 0x2) p += 1 + buf[i + 4];
        const end = i + TS_PACKET;
        // A PES start: 00 00 01, then an audio stream id (0xC0-0xDF).
        if (p + 9 > end || buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
        const streamId = buf[p + 3];
        if (streamId < 0xC0 || streamId > 0xDF) continue;
        const h = p + 9 + buf[p + 8]; // past the PES header's optional fields
        if (h + 3 > end) continue;
        // ADTS: a 12-bit syncword, layer 0; the profile is the top two bits of the third byte.
        if (buf[h] !== 0xFF || (buf[h + 1] & 0xF6) !== 0xF0) continue;
        return { objectType: ((buf[h + 2] >> 6) & 0x3) + 1, rest: null };
    }
    return { objectType: null, rest: buf.subarray(i) };
}

/** Watches a stream's chunks until it has found the object type, or read MAX_SNIFF_BYTES. */
class AdtsSniffer {
    constructor() { this.rest = null; this.bytes = 0; this.objectType = null; this.done = false; }
    push(chunk) {
        if (this.done) return;
        this.bytes += chunk.length;
        const { objectType, rest } = scan(this.rest && this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk);
        this.rest = rest && rest.length ? Buffer.from(rest) : null;
        if (objectType !== null) { this.objectType = objectType; this.done = true; this.rest = null; }
        else if (this.bytes >= MAX_SNIFF_BYTES) { this.done = true; this.rest = null; }
    }
}

/** An AAC object type a copy may carry to every client (AAC-LC, with SBR/PS in-band). */
const copyableObjectType = (objectType) => objectType === null || objectType === undefined || objectType === 2;

module.exports = { adtsObjectType, AdtsSniffer, copyableObjectType, MAX_SNIFF_BYTES };
