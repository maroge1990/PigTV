const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { TranscodeSession } = require('../server/services/transcodeSession');
const { createStallWatchdog } = require('../server/services/stallWatchdog');
const ingest = require('../server/services/ingest');

// R7 (FINDINGS FR-8): the session's stall watchdog does not blame ffmpeg for a silence its shared
// feed caused - but (0283, Codex review of 0282) only while it has been handed less than the stall
// limit's worth of media since its last output: recurring bursts must not hide an ffmpeg that reads
// and writes nothing.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** A session-shaped object on TranscodeSession's own methods, with its output and feed stubbed. */
function session({ out, feed, stallMs = 4000 }) {
    const s = Object.create(TranscodeSession.prototype);
    Object.assign(s, { options: { stallMs }, feed, latestOutputAt: async () => out() });
    return s;
}

test('excused while it has been handed less than the limit\'s worth of media since its last output', async () => {
    let media = 100;
    const s = session({ out: () => 1000, feed: { mediaReceived: () => media } });
    const now = Date.now();
    assert.ok(await s.lastActivityAt() >= now, 'just after output: excused');
    media = 103;
    assert.ok(await s.lastActivityAt() >= now, '3 s of media since: still excused');
    media = 105;
    const spentAt = await s.lastActivityAt();
    assert.ok(spentAt >= now, '0284: handed 5 s at once, it has the limit again, in time, from now');
    s.outputSeen.spent[4000] -= 5000; // that time passes with nothing written
    media = 109;
    assert.equal(await s.lastActivityAt(), spentAt - 5000, 'its own silence now, and a later burst renews nothing');
    assert.equal(await session({ out: () => null, feed: { mediaReceived: () => 0 } }).lastActivityAt(), null,
        'before any output nothing is excused: the start-up grace holds');
    assert.equal(await session({ out: () => 1000, feed: null }).lastActivityAt(), 1000, 'no ingest: output only');
    assert.equal(await session({ out: () => 1000, feed: { mediaReceived: () => null } }).lastActivityAt(), 1000,
        'the ingest is reconnecting: nothing is excused');
});

// The scenario Codex built: a healthy bursty feed (3 s of media every 3 s) and an ffmpeg whose output
// stays frozen. The watchdog must fire within a bounded time.
let server, base;
before(async () => {
    server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        let at = 0;
        const pkt = (sec, n) => {
            const b = Buffer.alloc(188, 0xff);
            const pid = n % 20 === 0 ? 0 : 256;
            b[0] = 0x47; b[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff;
            if (pid === 0) { b[3] = 0x10; return b; }
            b[3] = 0x30; b[4] = 7; b[5] = 0x10;
            const base = Math.round(sec * 90000);
            b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff;
            b[8] = Math.floor(base / 512) & 0xff; b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
            return b;
        };
        // '/nopcr': MPEG-TS that never carries a PCR, sent steadily.
        if (req.url === '/nopcr') {
            const plain = (n) => { const b = Buffer.alloc(188, 0xff); b[0] = 0x47; b[1] = n % 20 === 0 ? 0x40 : 0x01; b[2] = n % 20 === 0 ? 0 : 0; b[3] = 0x10; return b; };
            let n = 0;
            const t = setInterval(() => { if (!res.destroyed) res.write(Buffer.concat(Array.from({ length: 50 }, () => plain(n++)))); }, 50);
            res.on('close', () => clearInterval(t));
            return;
        }
        const send = (sec) => { if (!res.destroyed) { res.write(Buffer.concat(Array.from({ length: sec * 100 }, (_, k) => pkt(at + k / 100, k)))); at += sec; } };
        send(3);
        const timer = setInterval(() => send(3), 3000);
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => ingest.closeAll('test over'));
after(() => server.close());

test('recurring healthy bursts do not hide a frozen ffmpeg: the watchdog fires', async () => {
    const log = console.log, warn = console.warn;
    console.log = console.warn = () => {};
    try {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/bursty`, purpose: 'viewer' });
        sub.resume();
        let frozenAt = null;
        const s = session({ out: () => frozenAt, feed: sub, stallMs: 4000 });
        const fired = [];
        const dog = createStallWatchdog({ label: 't', getLastActivity: () => s.lastActivityAt(), onStall: (q) => fired.push(q),
            stallMs: 4000, startupMs: 60000, checkIntervalMs: 100 });
        frozenAt = Date.now(); // one output, then nothing ever again
        let waited = 0;
        while (!fired.length && waited < 15000) { await sleep(200); waited += 200; }
        dog.stop();
        sub.leave();
        assert.equal(fired.length, 1, 'a reader handed media and writing nothing is stalled');
        assert.ok(waited < 12000, `within a bounded time (${waited} ms)`);
    } finally { console.log = log; console.warn = warn; }
});

// 0284 (Codex review of 0283): bytes without a PCR measure nothing, and must not excuse a frozen
// ffmpeg for ever: output alone counts, as before R7.
test('a feed with no PCR excuses nothing: the watchdog fires on frozen output', async () => {
    const log = console.log, warn = console.warn;
    console.log = console.warn = () => {};
    try {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/nopcr`, purpose: 'viewer' });
        sub.resume();
        await sleep(300);
        assert.equal(sub.mediaReceived(), null, 'unmeasured, not "nothing delivered"');
        let frozenAt = null;
        const s = session({ out: () => frozenAt, feed: sub, stallMs: 2000 });
        const fired = [];
        const dog = createStallWatchdog({ label: 't', getLastActivity: () => s.lastActivityAt(), onStall: (q) => fired.push(q),
            stallMs: 2000, startupMs: 60000, checkIntervalMs: 100 });
        frozenAt = Date.now();
        let waited = 0;
        while (!fired.length && waited < 8000) { await sleep(200); waited += 200; }
        dog.stop();
        sub.leave();
        assert.equal(fired.length, 1, 'frozen output on an unmeasured feed is stalled');
    } finally { console.log = log; console.warn = warn; }
});
