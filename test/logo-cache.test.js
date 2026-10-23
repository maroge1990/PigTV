const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// 0112 (roadmap S1.4): a logo cache so clients fetch a channel logo from us,
// once, instead of a slow (or dead) provider URL on every guide load. Not an
// open image proxy: only a key registered via services/logoCache.js (because
// it actually appeared as a channel/EPG logo) resolves to anything.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-cache-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const { registerLogo, keyForUrl } = load('services/logoCache');

let server, base;
let imageServer, imageBase, fetchCount;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // just a plausible-looking header, not a real decodable PNG

before(async () => {
    // A tiny local "provider" so the logo route has something real to fetch,
    // and so the test can count how many times it was hit.
    fetchCount = 0;
    imageServer = http.createServer((req, res) => {
        fetchCount++;
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
    });
    imageServer.listen(0, '127.0.0.1');
    await once(imageServer, 'listening');
    imageBase = `http://127.0.0.1:${imageServer.address().port}`;

    const app = express();
    // No ffmpegPath set: exercises the "keep the original" path without
    // depending on ffmpeg being installed in the test environment.
    app.use('/api/logo', load('routes/logo'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    imageServer?.closeAllConnections?.();
    imageServer?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('an unregistered key is a 404, not a fetch of anything', async () => {
    const res = await fetch(`${base}/api/logo/0000000000000000000000000000dead`);
    assert.equal(res.status, 404);
    assert.equal(fetchCount, 0, 'an unknown key must never reach the network');
});

test('a malformed key (not our hash shape) is refused before touching the database', async () => {
    const res = await fetch(`${base}/api/logo/${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(res.status, 404);
});

test('a known key fetches the logo once, then serves it from disk on later requests', async () => {
    const url = `${imageBase}/channel-logo.png`;
    const path0 = registerLogo(url);
    const key = keyForUrl(url);
    assert.equal(path0, `/api/logo/${key}`);

    const first = await fetch(`${base}${path0}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(first.headers.get('cache-control'), 'public, max-age=604800');
    assert.ok(first.headers.get('etag'));
    const body1 = Buffer.from(await first.arrayBuffer());
    assert.ok(body1.equals(PNG_BYTES));
    assert.equal(fetchCount, 1);

    const second = await fetch(`${base}${path0}`);
    assert.equal(second.status, 200);
    assert.equal(fetchCount, 1, 'the second request must be served from disk, not fetched again');

    const row = sqlite.getDb().prepare('SELECT * FROM logo_cache WHERE key = ?').get(key);
    assert.ok(row.fetched_at, 'the row records when it was fetched');
    assert.equal(row.bytes, PNG_BYTES.length);
});

test('a matching If-None-Match answers 304', async () => {
    const url = `${imageBase}/etag-logo.png`;
    const p = registerLogo(url);

    const first = await fetch(`${base}${p}`);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const revalidated = await fetch(`${base}${p}`, { headers: { 'If-None-Match': etag } });
    assert.equal(revalidated.status, 304);
});

test('a non-image response is refused rather than cached', async () => {
    const textServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not an image</html>');
    });
    textServer.listen(0, '127.0.0.1');
    await once(textServer, 'listening');
    const textBase = `http://127.0.0.1:${textServer.address().port}`;

    const p = registerLogo(`${textBase}/not-an-image`);
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 502);

    textServer.close();
});

// ---- S6 (0249): the download's deadline covers the body; the conversion is bounded too ----------

const logoRoute = () => load('routes/logo');
for (const [label, write] of [['headers, then nothing', () => {}], ['headers and a few bytes, then nothing', (res) => res.write(PNG_BYTES)]]) {
    test(`S6: ${label} - the request answers by the deadline and the upstream connection is closed`, async () => {
        const timeouts = logoRoute().timeouts || {}; // (absent before 0249: the old code then simply never answers)
        const saved = { ...timeouts };
        timeouts.fetchMs = 500;
        let upstreamClosed = false;
        const stall = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.flushHeaders();
            write(res);
            res.on('close', () => { upstreamClosed = true; });
        });
        stall.listen(0, '127.0.0.1');
        await once(stall, 'listening');
        try {
            const p = registerLogo(`http://127.0.0.1:${stall.address().port}/stalls-${label.length}.png`);
            const started = Date.now();
            const res = await fetch(`${base}${p}`);
            assert.equal(res.status, 502);
            assert.ok(Date.now() - started < 3000, `bounded (${Date.now() - started} ms)`);
            for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise(r => setTimeout(r, 20));
            assert.ok(upstreamClosed, 'nothing is left reading the body');
        } finally {
            Object.assign(timeouts, saved);
            stall.closeAllConnections?.(); stall.close();
        }
    });
}

test('S6: a conversion whose ffmpeg never exits is killed at its deadline and the original is kept', async () => {
    const { storableLogo } = logoRoute();
    const timeouts = logoRoute().timeouts || {};
    const saved = { ...timeouts };
    timeouts.convertMs = 1500; // long enough for the script to start and say who it is
    const pidFile = path.join(sandbox, 'hung-ffmpeg.pid');
    const hung = path.join(sandbox, 'hung-ffmpeg');
    fs.writeFileSync(hung, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
    fs.chmodSync(hung, 0o755);
    // Wider than 320 px (a PNG header saying 1000 px), so a conversion is attempted.
    const wide = Buffer.alloc(64);
    PNG_BYTES.copy(wide);
    wide.write('IHDR', 12, 'latin1');
    wide.writeUInt32BE(1000, 16);
    wide.writeUInt32BE(500, 20);
    try {
        const started = Date.now();
        const out = await storableLogo(hung, wide, 'image/png');
        assert.ok(Date.now() - started < 4000, `bounded (${Date.now() - started} ms)`);
        assert.equal(out.buffer, wide, 'the original is kept');
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        await new Promise(r => setTimeout(r, 100));
        assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the ffmpeg is gone');
    } finally {
        Object.assign(timeouts, saved);
    }
});
