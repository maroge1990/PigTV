/**
 * Shared ingest (Wave 5, Plan B3 / R2): one reader per provider stream, shared by everyone who
 * wants that stream. The design, with the reasons for every number below, is
 * docs/SHARED-INGEST.md; behind the `sharedIngestEnabled` setting, off by default.
 *
 * An ingest reads the stream with a plain HTTP(S) GET (no ffmpeg in between: subscribers get the
 * provider's own bytes, timestamp quirks and all), keeps a short ring of what it read (bounded by
 * bytes AND seconds), and hands a Readable to each subscriber, starting at a join point (the last
 * PAT in the buffer's final 2 s). A slow subscriber is evicted rather than slowing the reader. A
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
    stallMs: num('PIGTV_INGEST_STALL_MS', 15000, 2000),
    connectTimeoutMs: 10000,
    // I1 (0230): from the start of an ingest to its first usable MPEG-TS, whatever arrives
    // (headers alone, a trickle of fewer than three packets, redirects). A reconnect has the
    // same absolute bound in reconnectMs, counted from the loss.
    firstBytesMs: num('PIGTV_INGEST_FIRST_BYTES_MS', 10000, 1000),
    joinWindowMs: 2000,
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

class Subscription extends Readable {
    constructor(ingest, info) {
        super({ highWaterMark: 1024 * 1024 });
        this.ingest = ingest;
        this.info = info; // { purpose, owner }
        this.joinedAt = Date.now();
        this.bytesOut = 0;
        this.endReason = null;
    }
    _read() { /* data is pushed by the ingest; pausing only grows our queue, which eviction bounds */ }
    deliver(chunk) {
        if (this.destroyed || this.endReason) return;
        this.bytesOut += chunk.length;
        this.push(chunk);
        if (this.readableLength > tuning.slowBytes) this.finish('slow-consumer', { providerReason: false });
    }
    /** End this subscriber's stream with a reason ({ providerReason } says whose fault). */
    finish(reason, { providerReason = false } = {}) {
        if (this.endReason) return;
        this.endReason = { reason, providerReason };
        this.emit('ingest-end', this.endReason);
        this.push(null);
        this.ingest.drop(this);
    }
    /** The consumer is done with it. */
    leave() {
        if (!this.endReason) this.endReason = { reason: 'left', providerReason: false };
        this.ingest.drop(this);
        this.destroy();
    }
}

class Ingest extends EventEmitter {
    constructor({ key, pool, url, userAgent, providerId }) {
        super();
        this.id = nextId++;
        this.key = key;
        this.pool = pool;
        this.url = url;
        this.userAgent = userAgent;
        this.providerId = providerId ?? null;
        this.state = 'connecting';
        this.chunks = [];      // { buf, at }
        this.bytes = 0;
        this.subs = new Set();
        this.bytesIn = 0;
        this.reconnects = 0;
        this.startedAt = Date.now();
        this.lastByteAt = 0;
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
        if (this.state === 'connecting') {
            this.state = 'live';
            this.log(`reading ${hashOf(this.url)} for pool ${this.pool}`);
            this._resolveReady(this);
        } else if (this.state === 'reconnecting') {
            this.state = 'live';
            this.log(`reconnected after ${Math.round((Date.now() - this.lostSince) / 100) / 10}s`);
            this.lostSince = null;
        }
    }

    onData(chunk) {
        const now = Date.now();
        this.bytesIn += chunk.length;
        this.lastByteAt = now;
        this.chunks.push({ buf: chunk, at: now });
        this.bytes += chunk.length;
        while (this.chunks.length > 1 && (this.bytes > tuning.bufferBytes || now - this.chunks[0].at > tuning.bufferMs)) {
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
    onUpstreamGone(why) {
        if (this.closed) return;
        if (this.state === 'live') {
            this.state = 'reconnecting';
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
        if (Date.now() - this.lastByteAt > tuning.stallMs) {
            const req = this.request;
            this.request = null; // its late events are ignored
            try { req && req.destroy(); } catch (e) { /* gone */ }
            this.onUpstreamGone(`no data for ${Math.round(tuning.stallMs / 1000)}s`);
        }
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
     * A new subscriber, starting at the join point: the last PAT in the buffer's final 2 s, or -
     * for the subscriber that opened this ingest (`fromStart`) - the first PAT the connection
     * brought, so it gets what a connection of its own would have (nothing has been dropped yet).
     */
    subscribe(info = {}, { fromStart = false } = {}) {
        const sub = new Subscription(this, info);
        clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
        this.subs.add(sub);
        const opener = fromStart && this.bytes === this.bytesIn;
        const tailFrom = Date.now() - tuning.joinWindowMs;
        const tail = this.chunks.filter(c => opener || c.at >= tailFrom).map(c => c.buf);
        if (tail.length) {
            const joined = Buffer.concat(tail);
            const at = opener ? firstPatOffset(joined) : lastPatOffset(joined);
            if (at >= 0) sub.deliver(joined.subarray(at));
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
        this.log(`closed (${why})`);
    }

    describe() {
        const seconds = Math.max(1, (Date.now() - this.startedAt) / 1000);
        return {
            id: this.id, pool: this.pool, providerId: this.providerId, state: this.state,
            subscribers: [...this.subs].map(s => ({ purpose: s.info.purpose || null, backlogBytes: s.readableLength })),
            bufferBytes: this.bytes, kbps: Math.round(this.bytesIn * 8 / seconds / 1000), reconnects: this.reconnects,
            startedAt: this.startedAt
        };
    }
}

/**
 * Subscribe to (pool, url): joins a live ingest, or starts one. Resolves with the Subscription
 * once the stream is confirmed MPEG-TS; rejects (`ingestRefused`) when it is not, or the provider
 * refuses the first connection - the caller then uses its usual path.
 */
async function subscribe({ pool, url, userAgent, providerId = null, purpose = null, owner = null }) {
    const key = keyOf(pool, url);
    let ingest = registry.get(key);
    let opened = false;
    if (!ingest || ingest.closed) {
        closeIdleInPool(pool, key); // a lingering connection in this pool would make this one a second
        ingest = new Ingest({ key, pool, url, userAgent, providerId });
        registry.set(key, ingest);
        ingest.start();
        opened = true;
    }
    ingest.waiters++;
    try { await ingest.ready; } finally { ingest.waiters--; }
    if (ingest.closed) throw Object.assign(new Error('Shared ingest not used: it closed'), { ingestRefused: true, providerReason: true });
    return ingest.subscribe({ purpose, owner }, { fromStart: opened });
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

module.exports = { enabled, subscribe, liveFor, idleInPool, closeIdleInPool, closeKey, list, status, closeAll, keyOf, looksLikeTs, firstPatOffset, lastPatOffset, tuning, _registry: registry };
