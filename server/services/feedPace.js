/**
 * R7 (FINDINGS FR-8): how far a live feed has fallen behind real time, from the media clock it
 * carries (the MPEG-TS PCR), not from whether bytes or output happen to be arriving.
 *
 * Why. Some providers deliver in bursts: a ~35 s head start on connect, then a pause of 3-16 s
 * every few seconds, averaging exactly real time (27 Oct capture: Chicago Sports Network Plus on
 * two providers, NBC [Scranton]). "No bytes for N s" or "no segment for N s" calls a healthy
 * pause a failure, and misses a feed that trickles below real time. What a viewer feels is
 * different: the player holds a fixed distance behind the newest segment, so its buffer shrinks
 * by however much media the feed has fallen behind since it was furthest ahead.
 *
 *   ahead   = media seconds received - wall seconds since the connection opened
 *   peak    = the highest `ahead` seen, decaying slowly (PEAK_DECAY) so a provider whose clock
 *             runs a fraction slow is not eventually called behind
 *   deficit = peak - ahead now: how much of a viewer's buffer the feed has used up
 *
 * A healthy bursty feed's deficit rises during a pause and falls back with the next burst; a
 * failing one keeps rising. Media time is summed from PCR steps of 0-2 s; a larger or backward
 * step (a provider reset, a resend, a clock wrap) adds nothing, so it cannot fake a head start.
 * Before any PCR the deficit counts wall time since the last byte, the old rule.
 */
'use strict';

const TS_PACKET = 188;
const SYNC = 0x47;
const PCR_HZ = 90000;            // the 33-bit PCR base
const PCR_WRAP = 2 ** 33;
const MAX_STEP_SEC = 2;          // a PCR step above this is a discontinuity, not media
const PEAK_DECAY = 1 / 60;       // seconds of peak forgiven per second (1 s a minute)
const QUIET_MS = 1000;           // a gap in bytes longer than this is a pause

class FeedPace {
    constructor(now = Date.now()) { this.reset(now); }

    /** A new connection: a new baseline (it may burst again). */
    reset(now = Date.now()) {
        this.connectedAt = now;
        this.media = 0;
        this.pcrPid = null;
        this.lastPcr = null;
        this.peak = 0;
        this.peakAt = now;
        this.lastByteAt = now;
        this.gapEndedAt = now;
        this.maxDeficit = 0;
        this.carry = null;
    }

    /** Bytes as they arrive (any split; packets may straddle chunks). */
    onChunk(chunk, now = Date.now()) {
        this.observe(now); // the end of a pause is where its deficit peaked
        if (now - this.lastByteAt > QUIET_MS) this.gapEndedAt = now;
        this.lastByteAt = now;
        let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
        let i = 0;
        // Find packet alignment: a sync byte with another one a packet later.
        while (i < buf.length && !(buf[i] === SYNC && (i + TS_PACKET >= buf.length || buf[i + TS_PACKET] === SYNC))) i++;
        for (; i + TS_PACKET <= buf.length; i += TS_PACKET) {
            if (buf[i] !== SYNC) { // lost alignment: look for it again
                while (i < buf.length && buf[i] !== SYNC) i++;
                i -= TS_PACKET;
                continue;
            }
            const pcr = pcrOf(buf, i);
            if (pcr === null) continue;
            const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
            if (this.pcrPid === null) this.pcrPid = pid;
            if (pid !== this.pcrPid) continue;
            if (this.lastPcr !== null) {
                const step = ((pcr - this.lastPcr + PCR_WRAP) % PCR_WRAP) / PCR_HZ;
                if (step > 0 && step <= MAX_STEP_SEC) this.media += step;
            }
            this.lastPcr = pcr;
        }
        this.carry = i < buf.length ? Buffer.from(buf.subarray(i)) : null;
        this.track(now);
    }

    track(now) {
        const ahead = this.media - (now - this.connectedAt) / 1000;
        const decayed = this.peak - PEAK_DECAY * (now - this.peakAt) / 1000;
        if (ahead >= decayed) { this.peak = ahead; this.peakAt = now; }
        else { this.peak = decayed; this.peakAt = now; }
        this.observe(now);
    }

    /** The deficit now, kept as the worst seen when it is (call it on a clock, too). */
    observe(now = Date.now()) {
        const d = this.deficit(now);
        if (d > this.maxDeficit) this.maxDeficit = d;
        return d;
    }

    /** Has the feed's own clock been seen (else deficit is wall time since the last byte)? */
    get measured() { return this.lastPcr !== null; }

    /** Seconds of a viewer's buffer this feed has used up (0 while it is at its best). */
    deficit(now = Date.now()) {
        if (!this.measured) return Math.max(0, (now - this.lastByteAt) / 1000);
        const ahead = this.media - (now - this.connectedAt) / 1000;
        const peak = this.peak - PEAK_DECAY * (now - this.peakAt) / 1000;
        return Math.max(0, peak - ahead);
    }

    /** Seconds of media received ahead of real time since connecting (negative: behind). */
    ahead(now = Date.now()) { return this.media - (now - this.connectedAt) / 1000; }

    /**
     * Until when silence downstream is the feed's doing, not its reader's: now while no bytes
     * are arriving, else the moment they last resumed. A reader (ffmpeg) that has had bytes
     * since then and written nothing is the one at fault.
     */
    excusedUntil(now = Date.now()) {
        return now - this.lastByteAt > QUIET_MS ? now : this.gapEndedAt;
    }
}

/** The PCR base (90 kHz) of the packet at `i`, or null when it carries none. */
function pcrOf(buf, i) {
    if (!(buf[i + 3] & 0x20)) return null;            // no adaptation field
    if (buf[i + 4] < 7 || !(buf[i + 5] & 0x10)) return null; // too short, or no PCR flag
    return buf[i + 6] * 33554432 + buf[i + 7] * 131072 + buf[i + 8] * 512 + buf[i + 9] * 2 + (buf[i + 10] >> 7);
}

module.exports = { FeedPace, pcrOf, QUIET_MS, PEAK_DECAY };
