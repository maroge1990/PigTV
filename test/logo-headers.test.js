const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// Logo responses are images only: every answer from /api/logo carries
// X-Content-Type-Options: nosniff and a Content-Security-Policy that allows no
// scripts, frames or connections, so a logo (an SVG especially) opened on its
// own is shown as an image and nothing more. The bytes are unchanged.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-headers-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
const cwd = process.cwd();
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const { registerLogo } = load('services/logoCache');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let server, base, imageServer, imageBase;

before(async () => {
    imageServer = http.createServer((req, res) => {
        if (req.url.endsWith('.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(SVG); }
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
    });
    imageServer.listen(0, '127.0.0.1');
    await once(imageServer, 'listening');
    imageBase = `http://127.0.0.1:${imageServer.address().port}`;

    const app = express();
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
    process.chdir(cwd);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

function assertImageOnly(res, label) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/, `${label}: ${csp}`);
    assert.match(csp, /\bsandbox\b/, `${label}: ${csp}`);
    assert.doesNotMatch(csp, /script-src/, `${label}: ${csp}`);
}

test('an SVG logo is served with nosniff and a restrictive Content-Security-Policy, bytes unchanged', async () => {
    const route = registerLogo(`${imageBase}/channel.svg`);
    for (const suffix of ['', '?size=full', '?size=640']) {
        const res = await fetch(`${base}${route}${suffix}`);
        assert.equal(res.status, 200, suffix);
        assert.equal(res.headers.get('content-type'), 'image/svg+xml', suffix);
        assertImageOnly(res, `svg${suffix}`);
        assert.equal(await res.text(), SVG, suffix);
    }
});

test('a raster logo, a 304 and a 404 carry the same headers', async () => {
    const route = registerLogo(`${imageBase}/channel.png`);
    const first = await fetch(`${base}${route}`);
    assert.equal(first.status, 200);
    assertImageOnly(first, 'png');
    await first.arrayBuffer();

    const again = await fetch(`${base}${route}`, { headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(again.status, 304);
    assertImageOnly(again, '304');

    const missing = await fetch(`${base}/api/logo/0000000000000000000000000000dead`);
    assert.equal(missing.status, 404);
    assertImageOnly(missing, '404');
    await missing.arrayBuffer();
});
