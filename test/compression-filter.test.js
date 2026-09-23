const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const compression = require('compression');
const { shouldCompress } = require('../server/services/compressionFilter');

// 0108: JSON (and the small set of text assets the web app serves) should be
// gzip-encoded when the client accepts it; HLS playlists, MP2T segments and
// anything requested with a Range header must never be compressed, because
// they must reach the client byte-identical. A minimal app wired up with the
// exact filter the real server uses, rather than mocking `res`, so this tests
// what compression() actually decides, not a reimplementation of it.
let server, base;

before(async () => {
    const app = express();
    app.use(compression({ filter: shouldCompress, threshold: 0 }));

    const bigJson = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `channel ${i}`.repeat(5) })) };

    app.get('/api/library/guide', (req, res) => res.json(bigJson));
    app.get('/api/transcode/:id/stream.m3u8', (req, res) => {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send('#EXTM3U\n'.repeat(200));
    });
    app.get('/api/transcode/:id/seg0001.ts', (req, res) => {
        res.setHeader('Content-Type', 'video/MP2T');
        res.send(Buffer.alloc(2000, 1));
    });
    app.get('/api/recordings/:id/media.mp4', (req, res) => {
        res.setHeader('Content-Type', 'video/mp4');
        res.send(Buffer.alloc(2000, 1));
    });
    // Same JSON route, but exercised with a Range header - must never compress.
    app.get('/api/ranged-json', (req, res) => res.json(bigJson));

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
});

test('a JSON response with Accept-Encoding gzip comes back gzip-encoded', async () => {
    const res = await fetch(`${base}/api/library/guide`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
});

test('an m3u8 playlist is never compressed, even when the client accepts gzip', async () => {
    const res = await fetch(`${base}/api/transcode/abc/stream.m3u8`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null);
});

test('an MP2T segment is never compressed', async () => {
    const res = await fetch(`${base}/api/transcode/abc/seg0001.ts`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null);
});

test('recording media (video/mp4) is never compressed', async () => {
    const res = await fetch(`${base}/api/recordings/1/media.mp4`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), null);
});

test('a request with a Range header is never compressed, even for a JSON route', async () => {
    const res = await fetch(`${base}/api/ranged-json`, {
        headers: { 'Accept-Encoding': 'gzip', 'Range': 'bytes=0-99' }
    });
    assert.equal(res.headers.get('content-encoding'), null);
});
