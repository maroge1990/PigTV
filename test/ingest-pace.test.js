const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

// R7 (FINDINGS FR-8): the shared ingest judges a feed by how far it falls behind real time, by the
// feed's own clock (PCR), not by a pause in bytes. Against a fake provider over local HTTP:
//  - '/bursty' averages real time but sends 3 s of media at once, then nothing for 3 s (the
//    27 Oct captures, scaled down): healthy, so it must never be reconnected;
//  - '/trickle' never stops sending but only at half speed: it falls behind and must be.
// The old rule (no bytes for stallMs) reconnects the first and never notices the second.
const ingest = require('../server/services/ingest');
const T = ingest.tuning;
const TUNING = { ...T };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function packet(pcrSec, n) {
    const b = Buffer.alloc(188, 0xff);
    const pid = n % 20 === 0 ? 0 : 256;
    b[0] = 0x47; b[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff;
    if (pid === 0) { b[3] = 0x10; return b; }
    b[3] = 0x30; b[4] = 7; b[5] = 0x10; // adaptation field with a PCR
    const base = Math.round(pcrSec * 90000);
    b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff;
    b[8] = Math.floor(base / 512) & 0xff; b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
    return b;
}
/** `seconds` of media from `from`, a packet every 10 ms of media. */
const media = (from, seconds) => Buffer.concat(Array.from({ length: Math.round(seconds * 100) }, (_, k) => packet(from + k / 100, k)));

let server, base;
before(async () => {
    server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        let at = 0;
        const timers = [];
        const send = (s) => { if (!res.destroyed) { res.write(media(at, s)); at += s; } };
        if (req.url === '/bursty') {
            send(3);
            timers.push(setInterval(() => send(3), 3000));
        } else if (req.url === '/trickle') {
            timers.push(setInterval(() => send(0.05), 100)); // 0.5 s of media a second, never silent
        }
        res.on('close', () => timers.forEach(clearInterval));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { ingest.closeAll('test over'); Object.assign(T, TUNING); });
after(() => server.close());

const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('a bursty feed that keeps up with real time is never reconnected, though it pauses for longer than the old limit', async () => {
    Object.assign(T, { stallMs: 2000, behindMs: 5000, reconnectMs: 20000 });
    await quiet(async () => {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/bursty`, purpose: 'viewer' });
        sub.resume();
        await sleep(9500); // three pauses of 3 s
        const [i] = ingest.list();
        assert.equal(i.reconnects, 0, 'a 3 s pause in a feed that averages real time is not a loss');
        assert.equal(i.state, 'live');
        assert.ok(i.maxBehindSec >= 2 && i.maxBehindSec < 4.5, `most behind ${i.maxBehindSec}s: about the pause`);
        sub.leave();
    });
});

test('a feed that never stops sending but runs at half speed falls behind and is reconnected', async () => {
    Object.assign(T, { stallMs: 2000, behindMs: 3000, reconnectMs: 20000 });
    await quiet(async () => {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/trickle`, purpose: 'viewer' });
        sub.resume();
        let waited = 0;
        while (ingest.list()[0].reconnects === 0 && waited < 12000) { await sleep(200); waited += 200; }
        assert.ok(ingest.list()[0].reconnects >= 1, 'about 3 s behind after about 6 s at half speed');
        assert.ok(waited >= 4000, `not before it has really fallen behind (${waited} ms)`);
        sub.leave();
    });
});

test('Status shows how far behind real time each ingest is', async () => {
    await quiet(async () => {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/bursty`, purpose: 'viewer' });
        sub.resume();
        await sleep(300);
        const [i] = ingest.list();
        assert.equal(typeof i.behindSec, 'number');
        assert.equal(typeof i.maxBehindSec, 'number');
        assert.ok(i.behindSec < 1, 'just after the head start it is at its best');
        sub.leave();
    });
});

test('FR-22: every subscription sees URL-free reconnect metadata, and new joins cannot replay the old connection tail', async () => {
    Object.assign(T, { backoffMs: [20] });
    await quiet(async () => {
        const viewer = await ingest.subscribe({ pool: 'r', url: `${base}/bursty`, purpose: 'viewer' });
        const source = viewer.ingest;
        const readers = [viewer, ...['recording', 'probe', 'warm', 'standby'].map(purpose => source.subscribe({ purpose }))];
        const oldChunks = [...source.chunks];
        const events = readers.map(sub => { sub.resume(); return once(sub, 'reconnected', { signal: AbortSignal.timeout(2000) }); });
        source.dropRequest();
        source.onUpstreamGone('test lag', true);
        for (const [info] of await Promise.all(events)) {
            assert.deepEqual(Object.keys(info).sort(), ['forLag', 'gapSec']);
            assert.equal(info.forLag, true);
            assert.ok(info.gapSec >= 0);
        }
        const deadline = Date.now() + 2000;
        while (source.bytes < media(0, 3).length && Date.now() < deadline) await sleep(10);
        assert.ok(source.chunks.every(c => !oldChunks.includes(c)), 'old burst discarded even though inside the two-second join window');
        assert.equal(source.bytes, media(0, 3).length);
        readers.forEach(sub => sub.leave());
    });
});
