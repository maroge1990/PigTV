const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

// Wave 5 (R2, phase 5a): the shared ingest on its own, against a fake provider over local HTTP that
// sends real-looking MPEG-TS (188-byte packets, a PAT every 20). docs/SHARED-INGEST.md has the
// design; these are its promises: one connection for any number of subscribers, the provider's own
// bytes from a PAT, reconnect then give up, eviction of a slow reader, the linger, redirects,
// MPEG-TS only, a bounded buffer. The old code has no ingest.
const ingest = require('../server/services/ingest');
const T = ingest.tuning;
const TUNING = { ...T };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function packet(pid, n) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47;
    p[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    p[3] = 0x10 | (n & 0x0f);
    p.writeUInt32BE(n, 4); // a counter, so bytes can be followed
    return p;
}
let seq = 0;
const nextPackets = (count) => Buffer.concat(Array.from({ length: count }, () => { const n = seq++; return packet(n % 20 === 0 ? 0 : 256, n); }));

// behaviour per path: 'ts' streams forever; 'html' is a web page; 'drop' sends a little then cuts
// once (then streams); 'dead' answers nothing after the first connection; 'redirect' -> /ts.
let connections = {};
let dropDone = false;
let server, base;
before(async () => {
    server = http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        connections[path] = (connections[path] || 0) + 1;
        if (path === '/redirect') { res.writeHead(302, { Location: '/ts' }); return res.end(); }
        if (path === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>' + 'x'.repeat(2000) + '</html>'); }
        if (path === '/dead' && connections[path] > 1) { req.socket.destroy(); return; }
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const timer = setInterval(() => {
            if (res.destroyed) return clearInterval(timer);
            res.write(nextPackets(40));
        }, 10);
        if ((path === '/drop' && !dropDone) || path === '/dead') {
            setTimeout(() => { dropDone = true; clearInterval(timer); req.socket.destroy(); }, 150);
        }
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
    ingest.closeAll('test over');
    Object.assign(T, TUNING);
    connections = {};
    dropDone = false;
});
after(() => { server.closeAllConnections?.(); server.close(); });

async function until(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return; await sleep(25); }
    assert.fail(`timed out waiting for: ${label}`);
}
const collect = (sub) => { const parts = []; sub.on('data', d => parts.push(d)); return () => Buffer.concat(parts); };

test('MPEG-TS only: a web page is refused, and the caller uses its usual path', async () => {
    await assert.rejects(ingest.subscribe({ pool: 'p', url: `${base}/html`, purpose: 'recording' }), (err) => err.ingestRefused === true);
    assert.equal(ingest.list().length, 0);
    await assert.rejects(ingest.subscribe({ pool: 'p', url: 'rtmp://example.invalid/x' }), (err) => err.ingestRefused === true);
});

test('two subscribers, one provider connection; each starts at a PAT with the provider\'s own bytes', async () => {
    const a = await ingest.subscribe({ pool: 'p', url: `${base}/ts`, purpose: 'recording' });
    const gotA = collect(a);
    await until(() => gotA().length > 188 * 100, 'A has data');
    const b = await ingest.subscribe({ pool: 'p', url: `${base}/ts`, purpose: 'viewer' });
    const gotB = collect(b);
    await until(() => gotB().length > 188 * 100, 'B has data');
    assert.equal(connections['/ts'], 1, 'one connection for both');
    const bufA = gotA(), bufB = gotB();
    assert.equal(bufB.length % 188, 0);
    assert.equal(bufB[0], 0x47);
    assert.equal(((bufB[1] & 0x1f) << 8) | bufB[2], 0, 'the late joiner starts at a PAT');
    // B's bytes are a run of A's: the same packets, in order, nothing re-muxed.
    const firstB = bufB.readUInt32BE(4);
    const at = bufA.indexOf(bufB.subarray(0, 188));
    assert.ok(at >= 0, `packet ${firstB} is in A's stream`);
    const common = Math.min(bufA.length - at, bufB.length);
    assert.ok(bufA.subarray(at, at + common).equals(bufB.subarray(0, common)), 'identical bytes from there');
    assert.ok(ingest.liveFor('p', `${base}/ts`), 'live: joining it needs no new connection');
    assert.equal(ingest.liveFor('other-pool', `${base}/ts`), null, 'another pool is another connection');
    a.leave(); b.leave();
});

test('a dropped connection is reconnected and the subscribers carry on', async () => {
    const sub = await ingest.subscribe({ pool: 'p', url: `${base}/drop` });
    const got = collect(sub);
    let ended = false;
    sub.on('ingest-end', () => { ended = true; });
    await until(() => connections['/drop'] === 2 && ingest.list()[0]?.state === 'live', 'reconnected');
    assert.equal(ended, false);
    const before = got().length;
    await until(() => got().length > before, 'bytes flow again');
    assert.equal(ingest.list()[0].reconnects, 1);
    sub.leave();
});

test('a provider that cannot be had back: every subscriber ends with upstream-lost, the provider to blame', async () => {
    T.reconnectMs = 1500;
    const sub = await ingest.subscribe({ pool: 'p', url: `${base}/dead` });
    collect(sub);
    const [end] = await once(sub, 'ingest-end');
    assert.deepEqual(end, { reason: 'upstream-lost', providerReason: true });
    assert.ok(connections['/dead'] >= 2, 'it tried again first');
    assert.equal(ingest.list().length, 0);
    assert.equal(ingest.status().recent[0].state, 'closed');
});

test('a subscriber that does not read is evicted; the others are not slowed', async () => {
    T.slowBytes = 64 * 1024;
    const reader = await ingest.subscribe({ pool: 'p', url: `${base}/ts` });
    const got = collect(reader);
    const idle = await ingest.subscribe({ pool: 'p', url: `${base}/ts` });
    idle.pause();
    const [end] = await once(idle, 'ingest-end');
    assert.deepEqual(end, { reason: 'slow-consumer', providerReason: false });
    const n = got().length;
    await until(() => got().length > n, 'the reader still gets bytes');
    reader.leave();
});

test('the last subscriber leaving lingers; a rejoin in time reuses the connection, then it closes', async () => {
    T.lingerMs = 2000;
    const first = await ingest.subscribe({ pool: 'p', url: `${base}/ts` });
    first.leave();
    await sleep(200);
    const again = await ingest.subscribe({ pool: 'p', url: `${base}/ts` });
    assert.equal(connections['/ts'], 1, 'rejoined within the linger');
    again.leave();
    await sleep(500);
    assert.equal(ingest.list().length, 1, 'still lingering');
    await until(() => ingest.list().length === 0, 'closed after the linger');
});

test('a redirect is followed; the buffer stays under its byte cap', async () => {
    T.bufferBytes = 100 * 1024;
    const sub = await ingest.subscribe({ pool: 'p', url: `${base}/redirect` });
    const got = collect(sub);
    await until(() => got().length > 200 * 1024, 'past the cap');
    assert.equal(connections['/ts'], 1);
    const [state] = ingest.list();
    assert.ok(state.bufferBytes <= 100 * 1024 + 40 * 188, `buffer ${state.bufferBytes} bytes`);
    assert.ok(state.kbps > 0);
    sub.leave();
});

test('the subscriber that opened the ingest gets everything its connection brought, from the first PAT', async () => {
    const sub = await ingest.subscribe({ pool: 'p', url: `${base}/ts` });
    const got = collect(sub);
    await until(() => got().length > 188 * 200, 'data');
    const first = got();
    assert.equal(((first[1] & 0x1f) << 8) | first[2], 0, 'a PAT');
    // The provider's first PAT on this connection is within its first 20 packets.
    assert.ok(first.readUInt32BE(4) % 20 === 0);
    sub.leave();
});
