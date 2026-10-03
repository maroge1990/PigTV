const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// /api/proxy/stream used to collect a whole binary response into one Buffer before
// sending a byte of it: harmless for a segment, but a progressive file (VOD) sat in
// memory in full first, and a source that never ends never reached the client at all.
// A local "provider" that sends one chunk and then holds the rest back shows the
// difference: streamed, the first chunk arrives at once; buffered, it cannot.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-proxybin-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const CHUNK = Buffer.alloc(64 * 1024, 7);
const handles = require(path.join(sandbox, 'server/services/playbackHandles'));
let upstream, proxy, upstreamBase, proxyBase;
let release = () => {};
let upstreamClosed = null;

before(async () => {
    upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write(CHUNK);
        upstreamClosed = once(res, 'close');
        // The rest only comes when the test says so - or never, if the client leaves.
        release = () => { if (!res.writableEnded && !res.destroyed) res.end(CHUNK); };
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

    const app = express();
    app.use('/api/proxy', require(path.join(sandbox, 'server/routes/proxy')));
    proxy = app.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    proxyBase = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => {
    release();
    for (const s of [upstream, proxy]) { s?.closeAllConnections?.(); s?.close(); }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not happen within ${ms} ms`)), ms))]);

test('a binary response is streamed: the first bytes arrive before the upstream has finished', async () => {
    const response = await within(3000, fetch(`${proxyBase}/api/proxy/stream?h=${handles.createHandle(`${upstreamBase}/movie.mp4`)}`), 'the response headers');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    const reader = response.body.getReader();

    const first = await within(3000, reader.read(), 'the first chunk');
    assert.ok(first.value.length > 0, 'bytes arrived while the upstream was still holding the rest back');

    release();
    let total = first.value.length;
    for (let r = await reader.read(); !r.done; r = await reader.read()) total += r.value.length;
    assert.equal(total, CHUNK.length * 2, 'and nothing was lost or duplicated');
});

test('a client that goes away releases the upstream connection too', async () => {
    const controller = new AbortController();
    const response = await within(3000, fetch(`${proxyBase}/api/proxy/stream?h=${handles.createHandle(`${upstreamBase}/endless.ts`)}`,
        { signal: controller.signal }), 'the response headers');
    const reader = response.body.getReader();
    await within(3000, reader.read(), 'the first chunk');

    controller.abort();
    await within(3000, upstreamClosed, 'the upstream connection closing');
});
