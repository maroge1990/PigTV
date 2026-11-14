/**
 * Shared ingest (Wave 5, Plan B3 / R2): one reader per provider stream, shared by everyone who
 * wants that stream. The design, with the reasons for every number below, is
 * docs/SHARED-INGEST.md; behind the `sharedIngestEnabled` setting, on by default since 0290 (stored opt-outs win).
 *
 * An ingest reads the stream with a plain HTTP(S) GET (no ffmpeg in between: subscribers get the
 * provider's own bytes, timestamp quirks and all), keeps a short ring of what it read (bounded by
 * bytes AND seconds), and hands a Readable to each subscriber, starting at a join point (the newest
 * video key frame in the buffer's final 6 s, behind a copy of the PAT and PMT; else the last PAT in
 * its final 2 s). A slow subscriber is evicted rather than slowing the reader. A
 * lost connection is reconnected for up to 10 s with the subscribers kept open; after that every
 * subscriber's stream ends with `upstream-lost`. The last subscriber leaving starts a 10 s linger.
 *
 * Only MPEG-TS: anything else (an HLS playlist, an MP4, an HTML error page) is refused at start
 * and the caller uses its usual path. Keyed by (pool, URL); the URL is never logged.
 * Native: the idea is Dispatcharr's live proxy (AGPL, read, not copied).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { URL } = require('url');
const { FeedPace } = require('./feedPace');
const lagLimit = require('./feedLagLimit');
const { keyframeJoin } = require('./tsKeyframes');

const TS_PACKET = 188;
const SYNC = 0x47;
const num = (name, fallback, min) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= min ? n : fallback;
};
const tuning = {
    bufferBytes: num('PIGTV_INGEST_BUFFER_MB', 48, 4) * 1024 * 1024,
    bufferMs: num('PIGTV_INGEST_BUFFER_SEC', 20, 4) * 1000,
    slowBytes: num('PIGTV_INGEST_SLOW_MB', 16, 1) * 1024 * 1024,
    reconnectMs: num('PIGTV_INGEST_RECONNECT_MS', 10000, 1000),
    lingerMs: num('PIGTV_INGEST_LINGER_MS', 10000, 0),
    // R7 (FR-8): a feed this far behind real time, by its own clock (feedPace.js), counts as lost.
    // Below the Apple client's 30 s live offset, so a dead feed is replaced before a viewer stalls;
    // above the worst a healthy bursty feed reached live (18.3 s on Chicago, 27 Oct).
    behindMs: num('PIGTV_INGEST_BEHIND_SEC', 24, 3) * 1000,
    connectTimeoutMs: 10000,
    // I1 (0230): from the start of an ingest to its first usable MPEG-TS, whatever arrives
    // (headers alone, a trickle of fewer than three packets, redirects). A reconnect has the
    // same absolute bound in reconnectMs, counted from the loss.
    firstBytesMs: num('PIGTV_INGEST_FIRST_BYTES_MS', 10000, 1000),
    joinWindowMs: 2000,
    // #3: how far back a joiner may start, to begin on a video key frame (the longest group of
    // pictures it waits on). The buffer always holds at least this much (bytes permitting).
    joinLookbackMs: num('PIGTV_INGEST_JOIN_LOOKBACK_SEC', 6, 2) * 1000,
    backoffMs: [500, 1000, 2000, 4000]
};

const enabled = (settings) => !!settings && settings.sharedIngestEnabled === true;
const hashOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
const keyOf = (pool, url) => `${pool}|${hashOf(url)}`;

const registry = new Map(); // key -> Ingest
let nextId = 1;
const history = []; // the last few ingests that ended, for the Status page

/** Does `buf` look like MPEG-TS (sync bytes 188 apart, from some offset in the first packet)? */
function looksLikeTs(buf) {
    if (!buf || buf.length < TS_PACKET * 3) return null; // not enough to tell yet
    for (let off = 0; off < TS_PACKET; off++) {
        if (buf[off] === SYNC && buf[off + TS_PACKET] === SYNC && buf[off + 2 * TS_PACKET] === SYNC) return true;
    }
    return false;
}

/** Offset of the first PAT packet start (PID 0, payload start) in `buf`, or -1. */
function firstPatOffset(buf) {
    for (let i = 0; i + TS_PACKET <= buf.length; i++) {
        if (buf[i] !== SYNC) continue;
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        if (pid !== 0 || !(buf[i + 1] & 0x40)) continue;
        if (i + TS_PACKET === buf.length || buf[i + TS_PACKET] === SYNC) return i;
    }
    return -1;
}

/** Offset of the last PAT packet start (PID 0, payload start) in `buf`, or -1. */
function lastPatOffset(buf) {
    for (let i = buf.length - TS_PACKET; i >= 0; i--) {
        if (buf[i] !== SYNC) continue;
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        if (pid !== 0 || !(buf[i + 1] & 0x40)) continue;
        // Aligned: a sync byte a packet later, or the very end of the data.
        if (i + TS_PACKET === buf.length || buf[i + TS_PACKET] === SYNC) return i;
    }
    return -1;
}

/** Offset of the first PAT packet start in `buf` that the next packet's sync byte confirms, or -1. */
function alignedPatOffset(buf) {
    for (let i = 0; i + TS_PACKET < buf.length; i++) {
        if (buf[i] !== SYNC || buf[i + TS_PACKET] !== SYNC) continue;
        if ((((buf[i + 1] & 0x1f) << 8) | buf[i + 2]) === 0 && (buf[i + 1] & 0x40)) return i;
    }
    return -1;
}

class Subscription extends Readable {
    constructor(ingest, info) {
        super({ highWaterMark: 1024 * 1024 });
        this.ingest = ingest;
        this.info = info; // { purpose, owner }
        this.joinedAt = Date.now();
        this.bytesOut = 0;
        this.endReason = null;
        this.awaitPat = false;
        this.patCarry = null;
        this.backlogBytes = 0;
    }
    _read() { /* data is pushed by the ingest; pausing only grows our queue, which eviction bounds */ }
    deliver(chunk) {
        if (this.destroyed || this.endReason) return;
        if (this.awaitPat) {
            // #309: a joiner whose backlog was too big starts at the next PAT the feed sends. A PAT
            // may be split across chunks: the last packet's worth is kept and read with the next.
            const data = this.patCarry ? Buffer.concat([this.patCarry, chunk]) : chunk;
            const at = alignedPatOffset(data);
            if (at < 0) {
                this.patCarry = Buffer.from(data.subarray(Math.max(0, data.length - TS_PACKET)));
                return;
            }
            this.awaitPat = false;
            this.patCarry = null;
            clearTimeout(this.patTimer);
            chunk = data.subarray(at);
        }
        this.bytesOut += chunk.length;
        this.push(chunk);
        // #309: the join backlog is counted apart (it is handed over before the reader can read):
        // only what is queued beyond its unread part is lag.
        const unreadBacklog = Math.max(0, this.backlogBytes - (this.bytesOut - this.readableLength));
        if (this.readableLength - unreadBacklog > tuning.slowBytes) this.finish('slow-consumer', { providerReason: false });
    }
    /**
     * Start at the next PAT the feed sends (#309). None within joinLookbackMs ends the reader with
     * `no-pat` (logged once per feed), rather than leaving it to wait with nothing.
     */
    waitForPat() {
        this.awaitPat = true;
        this.patTimer = setTimeout(() => {
            if (!this.awaitPat || this.endReason) return;
            const feed = this.ingest;
            feed.joinFallbacksLogged = feed.joinFallbacksLogged || new Set();
            if (!feed.joinFallbacksLogged.has('no-pat')) {
                feed.joinFallbacksLogged.add('no-pat');
                feed.log(`a reader waiting for a PAT is ended: none came in ${Math.round(tuning.joinLookbackMs / 1000)}s`);
            }
            this.finish('no-pat', { providerReason: false });
        }, tuning.joinLookbackMs);
        this.patTimer.unref?.();
    }
    /** The join point's backlog (at most slowBytes), handed over at once and not counted as lag. */
    deliverBacklog(parts) {
        this.backlogBytes = parts.reduce((n, p) => n + p.length, 0);
        for (const p of parts) this.deliver(p);
    }
    /** End this subscriber's stream with a reason ({ providerReason } says whose fault). */
    finish(reason, { providerReason = false } = {}) {
        if (this.endReason) return;
        clearTimeout(this.patTimer);
        this.endReason = { reason, providerReason };
        this.emit('ingest-end', this.endReason);
        this.push(null);
        this.ingest.drop(this);
    }
    /**
     * R7 (0283): seconds of media the feed has delivered over its life (feedPace.totalMedia), or null
     * while the connection is being re-made, once ended, or while this connection has shown no PCR
     * (0284, Codex review of 0283: unmeasured is not "nothing delivered"): then nothing excuses its
     * reader's silence, and output alone counts.
     */
    mediaReceived() {
        if (this.endReason || this.ingest.state !== 'live' || !this.ingest.pace.measured) return null;
        return this.ingest.pace.totalMedia;
    }
    /** The consumer is done with it. */
    leave() {
        clearTimeout(this.patTimer);
        if (!this.endReason) this.endReason = { reason: 'left', providerReason: false };
        this.ingest.drop(this);
        this.destroy();
    }
}

class Ingest extends EventEmitter {
    constructor({ key, pool, url, userAgent, providerId, channel = null, providerName = null, channelKey = null }) {
        super();
        this.id = nextId++;
        this.key = key;
        this.pool = pool;
        this.url = url;
        this.userAgent = userAgent;
        this.providerId = providerId ?? null;
        // Names for the feed-lag record (feedLag.js), never the URL.
        this.channel = channel;
        this.channelKey = channelKey;
        this.lagLimit = lagLimit.open(channelKey, providerId, tuning.behindMs);
        this.learningAt = null;
        this.learningWorst = 0;
        this.providerName = providerName;
        this.state = 'connecting';
        this.chunks = [];      // { buf, at }
        this.bytes = 0;
        this.subs = new Set();
        this.bytesIn = 0;
        this.reconnects = 0;
        this.startedAt = Date.now();
        this.lastByteAt = 0;
        this.pace = new FeedPace();
        // R7 data: the worst lag over every connection (the pace resets on a reconnect), and how
        // many reconnects were for lag rather than a lost connection.
        this.worstBehind = null;
        this.lagReconnects = 0;
        this.request = null;
        this.lingerTimer = null;
        this.lostSince = null;
        this.waiters = 0; // callers awaiting `ready`: a connecting ingest is never idle
        this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
        this.ready.catch(() => { /* a caller that never awaited it */ });
        this.stallTimer = setInterval(() => this.checkStall(), 1000);
        this.stallTimer.unref?.();
    }

    /** Open the first connection (after the registry knows it, so an instant refusal unregisters it). */
    start() { this.connect(this.url, 0); }

    log(text) { console.log(`[Ingest ${this.id}] ${text}`); }

    connect(target, redirects) {
        let parsed;
        try { parsed = new URL(target); } catch (e) { return this.connectFailed('not a URL', false); }
        const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
        if (!lib) return this.connectFailed('not an http(s) stream', false);
        const req = lib.get(parsed, { headers: { 'User-Agent': this.userAgent || 'Mozilla/5.0', Accept: '*/*', Connection: 'close' } });
        this.request = req;
        let probe = Buffer.alloc(0);
        let checked = false;
        // Each connection reports its loss once, however many of end/error/close fire.
        let gone = false;
        const lost = (why) => {
            if (gone || this.closed || this.request !== req) return;
            gone = true;
            try { req.destroy(); } catch (e) { /* gone */ }
            if (!checked) this.connectFailed(why, true);
            else this.onUpstreamGone(why);
        };
        req.setTimeout(tuning.connectTimeoutMs, () => lost('no answer in time'));
        req.on('response', (res) => {
            if (this.closed || this.request !== req) { res.destroy(); return; }
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
                res.resume();
                gone = true; // this request is done; the redirect is the next one
                let next;
                try { next = new URL(res.headers.location, parsed).toString(); } catch (e) { return this.connectFailed('a bad redirect', true); }
                return this.connect(next, redirects + 1);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return lost(`HTTP ${res.statusCode}`);
            }
            // A length means a file, not live TV: it must be paced and is seekable, which a pipe
            // cannot give (docs/SHARED-INGEST.md: finite sources never use an ingest).
            if (this.state === 'connecting' && res.headers['content-length'] !== undefined) {
                gone = true;
                res.destroy();
                return this.refuse('a file with a length, not a live stream');
            }
            req.setTimeout(0);
            res.on('data', (chunk) => {
                if (this.closed || gone) return;
                if (!checked) {
                    probe = Buffer.concat([probe, chunk]);
                    const ts = looksLikeTs(probe);
                    if (ts === null) return;
                    if (ts === false) {
                        if (this.state === 'connecting') { gone = true; res.destroy(); return this.refuse('the provider did not send MPEG-TS'); }
                        return lost('the provider did not send MPEG-TS');
                    }
                    checked = true;
                    this.onConnected();
                    chunk = probe;
                }
                this.onData(chunk);
            });
            res.on('end', () => lost('the provider ended the stream'));
            res.on('error', (err) => lost(err.code || 'a read error'));
        });
        // The code only: an error's message can name the provider's host.
        req.on('error', (err) => lost(err.code || 'a connection error'));
    }

    onConnected() {
        // R7: each connection is its own baseline (a provider bursts again on a reconnect).
        this.foldWorst();
        this.pace.reset(Date.now());
        this.learningAt = Date.now();
        this.learningWorst = 0;
        if (this.state === 'connecting') {
            this.state = 'live';
            this.liveAt = Date.now();
            this.log(`reading ${hashOf(this.url)} for pool ${this.pool}`);
            this._resolveReady(this);
        } else if (this.state === 'reconnecting') {
            this.state = 'live';
            this.reconnectedAt = Date.now();
            const info = { forLag: this.reconnectingForLag === true, gapSec: (this.reconnectedAt - this.lostSince) / 1000 };
            // Drop the old connection's tail: a fresh leg must never join before this boundary,
            // even if both connections arrived inside joinWindowMs (or the cut was mid-packet).
            this.chunks = [];
            this.bytes = 0;
            this.log(`reconnected after ${Math.round(info.gapSec * 10) / 10}s`);
            for (const sub of [...this.subs]) sub.emit('reconnected', info);
            this.lostSince = null;
        }
    }

    onData(chunk) {
        const now = Date.now();
        this.bytesIn += chunk.length;
        this.lastByteAt = now;
        const wasMeasured = this.pace.measured;
        if (wasMeasured) this.learningWorst = Math.max(this.learningWorst, this.pace.observe(now));
        this.pace.onChunk(chunk, now);
        if (!wasMeasured && this.pace.measured) this.learningAt = now;
        this.chunks.push({ buf: chunk, at: now });
        this.bytes += chunk.length;
        const keepMs = Math.max(tuning.bufferMs, tuning.joinLookbackMs);
        while (this.chunks.length > 1 && (this.bytes > tuning.bufferBytes || now - this.chunks[0].at > keepMs)) {
            this.bytes -= this.chunks.shift().buf.length;
        }
        for (const sub of [...this.subs]) sub.deliver(chunk);
    }

    /** A connection that never delivered MPEG-TS: refuse the ingest at its start, else keep reconnecting. */
    connectFailed(why, providerReason) {
        if (this.closed) return;
        if (this.state === 'connecting') return this.refuse(why, providerReason);
        this.onUpstreamGone(why);
    }

    refuse(why, providerReason = false) {
        this.log(`not used: ${why}`);
        const err = Object.assign(new Error(`Shared ingest not used: ${why}`), { providerReason, ingestRefused: true });
        this._rejectReady(err);
        this.close(why, { providerReason });
    }

    /** The connection is gone after it had delivered: reconnect (backing off) for up to reconnectMs, then fail. */
    onUpstreamGone(why, forLag = false) {
        if (this.closed) return;
        if (this.state === 'live') {
            this.learn(Date.now());
            lagLimit.flush(this.lagLimit);
            this.learningAt = null;
            this.state = 'reconnecting';
            this.reconnectingForLag = forLag;
            this.lostSince = Date.now();
            this.log(`lost the stream (${why}); reconnecting`);
        }
        const elapsed = Date.now() - this.lostSince;
        if (elapsed >= tuning.reconnectMs) return this.fail(why);
        const delay = tuning.backoffMs[Math.min(this.reconnects, tuning.backoffMs.length - 1)];
        this.reconnects++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (this.closed) return;
            if (Date.now() - this.lostSince >= tuning.reconnectMs) return this.fail(why);
            this.connect(this.url, 0);
        }, Math.min(delay, Math.max(0, tuning.reconnectMs - elapsed)));
        this.retryTimer.unref?.();
    }

    checkStall() {
        const now = Date.now();
        // I1 (0230): the timeout on the request ends when its headers arrive, so these deadlines
        // are absolute. Not ready in time: refused, and every caller waiting for it settles.
        if (this.state === 'connecting') {
            if (now - this.startedAt < tuning.firstBytesMs) return;
            this.dropRequest();
            return this.refuse(`no MPEG-TS within ${Math.round(tuning.firstBytesMs / 1000)}s`, true);
        }
        // A reconnect that has headers but no MPEG-TS gives up at the same bound as one refused.
        if (this.state === 'reconnecting') {
            if (this.lostSince && now - this.lostSince >= tuning.reconnectMs) {
                this.dropRequest();
                this.fail(`no MPEG-TS again within ${Math.round(tuning.reconnectMs / 1000)}s`);
            }
            return;
        }
        if (this.state !== 'live' || !this.lastByteAt) return;
        // R7 (FR-8): judged by how far the feed has fallen behind real time, not by a pause in bytes.
        const behind = this.pace.observe(now);
        if (this.pace.measured) this.worstBehind = Math.max(this.worstBehind ?? 0, behind);
        this.learn(now, behind);
        const limitMs = this.pace.measured ? (this.lagLimit?.limitMs ?? lagLimit.baseOf(tuning.behindMs)) : tuning.behindMs;
        if (behind * 1000 > limitMs) {
            if (this.pace.measured) { this.lagReconnects++; lagLimit.lag(this.lagLimit); }
            const req = this.request;
            this.request = null; // its late events are ignored
            try { req && req.destroy(); } catch (e) { /* gone */ }
            this.onUpstreamGone(this.pace.measured ? `${Math.round(behind)}s behind real time` : `no data for ${Math.round(behind)}s`, this.pace.measured);
        }
    }

    // Called on the watchdog clock, with the peak seen between ticks (onData observes before
    // a catch-up burst). Never credit a reconnect, offline time, or a connection without PCR.
    learn(now, behind = this.pace.observe(now)) {
        if (this.state === 'live' && this.pace.measured && this.learningAt !== null) {
            lagLimit.observe(this.lagLimit, Math.max(0, now - this.learningAt), Math.max(behind, this.learningWorst), now);
        }
        this.learningAt = now;
        this.learningWorst = 0;
    }

    dropRequest() {
        const req = this.request;
        this.request = null; // its late events are ignored
        try { req && req.destroy(); } catch (e) { /* gone */ }
    }

    /** Upstream could not be had back: every subscriber ends, with the provider to blame. */
    fail(why) {
        this.log(`gave up: ${why}`);
        this.close(why, { providerReason: true, reason: 'upstream-lost' });
    }

    /**
     * A new subscriber, starting at the join point. The subscriber that opened this ingest
     * (`fromStart`) starts at the first PAT the connection brought, so it gets what a connection of
     * its own would have (nothing has been dropped yet). Any other is handed the newest complete PAT
     * and PMT before the newest video key frame of the last joinLookbackMs, then the stream from that
     * key frame's first packet (#3: a copy session's ffmpeg copies audio at once and video from a key
     * frame, and a play that starts out of step stays so on AVPlayer). If none can be found, or that
     * backlog is over the slow-consumer limit, it starts at the last PAT in the buffer's final 2 s, as
     * before; if that too is over the limit (#309: sparse PATs, a burst), at the next PAT the feed
     * sends. A backlog is handed over before the reader can read, so it is not counted as lag (#309:
     * a 25 Mb/s feed with key frames 4 s apart still joins on a key frame).
     */
    subscribe(info = {}, { fromStart = false } = {}) {
        const sub = new Subscription(this, info);
        clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
        this.subs.add(sub);
        const now = Date.now();
        if (fromStart && this.bytes === this.bytesIn) {
            if (this.chunks.length) {
                const joined = Buffer.concat(this.chunks.map(c => c.buf));
                const at = firstPatOffset(joined);
                if (at >= 0) sub.deliver(joined.subarray(at));
            }
            return sub;
        }
        const lookFrom = now - tuning.joinLookbackMs;
        const window = this.chunks.filter(c => c.at >= lookFrom).map(c => c.buf);
        if (window.length) {
            const joined = Buffer.concat(window);
            const key = keyframeJoin(joined);
            const backlog = key.at >= 0 ? key.tables.length * TS_PACKET + joined.length - key.at : 0;
            if (key.at >= 0 && backlog <= tuning.slowBytes) {
                // Copies: a subarray would keep the whole look-back window alive while the reader reads.
                sub.deliverBacklog([Buffer.concat(key.tables.map(o => joined.subarray(o, o + TS_PACKET))), Buffer.from(joined.subarray(key.at))]);
                return sub;
            }
            // Once per feed for each kind of fallback: the stream gave no key frame, or it was too far back.
            const big = key.at >= 0;
            this.joinFallbacksLogged = this.joinFallbacksLogged || new Set();
            if (!this.joinFallbacksLogged.has(big)) {
                this.joinFallbacksLogged.add(big);
                this.log(big
                    ? `a reader joined at the newest PAT: the backlog from the newest key frame (${(backlog / 1048576).toFixed(1)} MB) is over the slow-reader limit`
                    : `a reader joined at the newest PAT: ${key.reason} in the last ${Math.round(tuning.joinLookbackMs / 1000)}s`);
            }
        }
        const tailFrom = now - tuning.joinWindowMs;
        const tail = this.chunks.filter(c => c.at >= tailFrom).map(c => c.buf);
        if (tail.length) {
            const joined = Buffer.concat(tail);
            const at = lastPatOffset(joined);
            if (at >= 0 && joined.length - at <= tuning.slowBytes) sub.deliverBacklog([Buffer.from(joined.subarray(at))]);
            else if (at >= 0) {
                // #309: over the same budget (sparse PATs, a burst), handing it over would end the
                // reader here, before its consumer listens. It waits for the feed's next PAT instead.
                sub.waitForPat();
                this.joinFallbacksLogged = this.joinFallbacksLogged || new Set();
                if (!this.joinFallbacksLogged.has('wait')) {
                    this.joinFallbacksLogged.add('wait');
                    this.log(`a reader waits for the next PAT: the backlog from the newest PAT (${((joined.length - at) / 1048576).toFixed(1)} MB) is over the slow-reader limit`);
                }
            }
        }
        return sub;
    }

    drop(sub) {
        if (!this.subs.delete(sub) || this.closed) return;
        if (this.subs.size === 0) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = setTimeout(() => { if (this.subs.size === 0) this.close('nobody is watching'); }, tuning.lingerMs);
            this.lingerTimer.unref?.();
        }
    }

    /** Close the reader; subscribers still on it end with `reason`. */
    close(why, { providerReason = false, reason = 'closed' } = {}) {
        if (this.closed) return;
        // I1 (0230): callers still waiting for the first bytes settle now. Closed for the provider's
        // sake it is a refusal; otherwise (released, shutdown) it is a cancellation, which a caller
        // must not answer with a connection of its own.
        if (this.state === 'connecting') {
            this._rejectReady(Object.assign(new Error(`Shared ingest closed before it started: ${why}`),
                providerReason ? { ingestRefused: true, providerReason: true } : { ingestCancelled: true, providerReason: false }));
        }
        this.learn(Date.now());
        lagLimit.flush(this.lagLimit);
        lagLimit.release(this.lagLimit);
        this.closed = true;
        this.state = 'closed';
        clearInterval(this.stallTimer);
        clearTimeout(this.lingerTimer);
        clearTimeout(this.retryTimer);
        if (this.request) { try { this.request.destroy(); } catch (e) { /* gone */ } }
        for (const sub of [...this.subs]) sub.finish(reason, { providerReason });
        this.subs.clear();
        this.chunks = [];
        this.bytes = 0;
        if (registry.get(this.key) === this) registry.delete(this.key);
        history.unshift({ ...this.describe(), endedAt: Date.now(), why });
        history.length = Math.min(history.length, 10);
        this.emit('closed', { why, providerReason });
        this.foldWorst();
        this.log(`closed (${why}); most behind real time ${this.worstBehind === null ? 'not measured' : `${Math.round(this.worstBehind * 10) / 10}s`}`);
        if (this.worstBehind !== null && this.liveAt) {
            try {
                require('./feedLag').record({ channel: this.channel, channelKey: this.channelKey, providerId: this.providerId, providerName: this.providerName, startedAt: this.liveAt,
                    worstBehindSec: this.worstBehind, reconnects: this.reconnects, lagReconnects: this.lagReconnects, why });
            } catch (err) { console.warn(`[Ingest ${this.id}] feed lag not recorded: ${err.message}`); }
        }
    }

    /** Fold the current connection's worst lag into the ingest's (before a reset, and at the end). */
    foldWorst() {
        if (this.pace.measured) this.worstBehind = Math.max(this.worstBehind ?? 0, this.pace.maxDeficit);
    }

    describe() {
        const seconds = Math.max(1, (Date.now() - this.startedAt) / 1000);
        return {
            id: this.id, pool: this.pool, providerId: this.providerId, state: this.state,
            subscribers: [...this.subs].map(s => ({ purpose: s.info.purpose || null, backlogBytes: s.readableLength })),
            bufferBytes: this.bytes, kbps: Math.round(this.bytesIn * 8 / seconds / 1000), reconnects: this.reconnects,
            startedAt: this.startedAt,
            limitSec: (this.lagLimit?.limitMs ?? lagLimit.baseOf(tuning.behindMs)) / 1000,
            // R7: how far behind real time the feed is now, and the most it has been (Status).
            behindSec: Math.round(this.pace.deficit() * 10) / 10,
            maxBehindSec: Math.round(Math.max(this.worstBehind ?? 0, this.pace.measured ? this.pace.maxDeficit : 0) * 10) / 10
        };
    }
}

/**
 * Subscribe to (pool, url): joins a live ingest, or starts one. Resolves with the Subscription
 * once the stream is confirmed MPEG-TS; rejects (`ingestRefused`) when it is not, or the provider
 * refuses the first connection - the caller then uses its usual path.
 */
async function subscribe({ pool, url, userAgent, providerId = null, purpose = null, owner = null, channel = null, providerName = null, channelKey = null }) {
    const key = keyOf(pool, url);
    let ingest = registry.get(key);
    let opened = false;
    if (!ingest || ingest.closed) {
        closeIdleInPool(pool, key); // a lingering connection in this pool would make this one a second
        ingest = new Ingest({ key, pool, url, userAgent, providerId, channel, providerName, channelKey });
        registry.set(key, ingest);
        ingest.start();
        opened = true;
    }
    ingest.waiters++;
    try { await ingest.ready; } finally { ingest.waiters--; }
    if (ingest.closed) throw Object.assign(new Error('Shared ingest not used: it closed'), { ingestRefused: true, providerReason: true });
    ingest.channel ??= channel;
    ingest.providerName ??= providerName;
    return ingest.subscribe({ purpose, owner }, { fromStart: opened });
}

/**
 * The `ingestSource` a live channel's candidate is read through, or null: the switch is off, or it
 * is not an http(s) stream. One rule for a play's first start and a relay's later legs (R7).
 */
function sourceFor(candidate, settings) {
    if (!enabled(settings) || !candidate || !/^https?:/i.test(String(candidate.url || ''))) return null;
    const pool = require('./streamCoordinator').poolOf(candidate.providerId);
    return { pool, url: candidate.url, userAgent: require('../db').getUserAgent(settings), providerId: candidate.providerId ?? null,
        key: keyOf(pool, candidate.url), channelKey: candidate.channelKey ?? null, channel: candidate.channelName ?? null, providerName: candidate.providerName ?? null };
}

/** A live ingest for (pool, url), or null - joining one needs no new provider connection. */
function liveFor(pool, url) {
    const ingest = registry.get(keyOf(pool, url));
    return ingest && !ingest.closed && ingest.state !== 'connecting' ? ingest : null;
}

/** Ingests in `pool` with nobody reading them (lingering): connections nobody needs. */
function idleInPool(pool) {
    return [...registry.values()].filter(i => !i.closed && i.pool === pool && i.subs.size === 0 && i.waiters === 0);
}

/** Ingests in `pool` read only by a relay's renewal pins (its session retired while backups are tried): still a connection. */
function pinnedInPool(pool) {
    return [...registry.values()].filter(i => !i.closed && i.pool === pool && i.subs && i.subs.size > 0
        && [...i.subs].every(s => s.info && s.info.purpose === 'renewal-pin'));
}

/** Does the ingest with this key hold a connection in `pool` now (open, past connecting)? */
function holdsConnection(key, pool) {
    return [...registry.values()].some(i => !i.closed && i.key === key && i.pool === pool && i.state !== 'connecting');
}

/** Close the idle ingests of a pool (another connection is about to be opened there), except `keepKey`. */
function closeIdleInPool(pool, keepKey = null) {
    for (const i of idleInPool(pool)) if (i.key !== keepKey) i.close('its connection is needed');
}

/** Close one ingest by key, now (no linger). */
function closeKey(key, why = 'released') {
    const i = registry.get(key);
    if (i) i.close(why);
}

function list() { return [...registry.values()].filter(i => !i.closed).map(i => i.describe()); }
function status() { return { ingests: list(), recent: history.slice(0, 5) }; }
function closeAll(why = 'shutdown') { for (const i of [...registry.values()]) i.close(why); }

module.exports = { enabled, sourceFor, subscribe, liveFor, idleInPool, pinnedInPool, holdsConnection, closeIdleInPool, closeKey, list, status, closeAll, keyOf, looksLikeTs, firstPatOffset, lastPatOffset, tuning,
    _registry: registry }; // _registry: a test seam only (tests plant and inspect ingests); no module reads it
