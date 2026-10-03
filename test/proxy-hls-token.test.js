const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// Real proxy router in front of a local "provider" serving an HLS manifest.
// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-hlsproxy-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const MANIFEST = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    "#EXT-X-MAP:URI='init.mp4'",
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXTINF:4.0,',
    'http://other.invalid/abs/seg2.ts',
    ''
].join('\n');

const handles = require(path.join(sandbox, 'server/services/playbackHandles'));
let upstream, proxy, upstreamBase, proxyBase;

before(async () => {
    upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(MANIFEST);
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
    for (const s of [upstream, proxy]) { s?.closeAllConnections?.(); s?.close(); }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function fetchManifest(query = '') {
    // The proxy takes opaque handles only (R01): mint one for the manifest, as a direct resolve does.
    const url = `${proxyBase}/api/proxy/stream?h=${handles.createHandle(`${upstreamBase}/live/index.m3u8`)}${query}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return (await response.text()).split('\n');
}

// Every rewritten reference in the manifest: segment lines and URI="..." attributes.
const references = (lines) => [
    ...lines.filter(l => l && !l.startsWith('#')),
    ...lines.flatMap(l => [...l.matchAll(/URI=["']([^"']+)["']/g)].map(m => m[1]))
];

test('with a token, every rewritten segment, key and init URI carries it', async () => {
    const refs = references(await fetchManifest('&token=tok-123'));
    assert.equal(refs.length, 4, 'segment, absolute segment, key and init map are all rewritten');
    for (const ref of refs) {
        assert.match(ref, /\/api\/proxy\/stream\?h=[0-9a-f]{32}&/, `${ref} goes back through the proxy`);
        assert.ok(ref.endsWith('&token=tok-123'), `${ref} must carry the token or the player is refused on its first segment`);
    }
});

test('the token is URL-encoded so it cannot break out of the query', async () => {
    const refs = references(await fetchManifest(`&token=${encodeURIComponent('a+b/c=d&e')}`));
    for (const ref of refs) {
        assert.ok(ref.endsWith('&token=a%2Bb%2Fc%3Dd%26e'), ref);
    }
});

test('without a token nothing is appended', async () => {
    const refs = references(await fetchManifest());
    assert.equal(refs.length, 4);
    for (const ref of refs) assert.ok(!ref.includes('token='), ref);
});

test('the rewritten URIs still point at the right upstream files', async () => {
    const refs = references(await fetchManifest('&token=t'));
    const targets = refs.map(r => handles.resolveHandle(new URL(r).searchParams.get('h')));
    assert.deepEqual(targets.sort(), [
        `${upstreamBase}/live/init.mp4`,
        `${upstreamBase}/live/key.bin`,
        `${upstreamBase}/live/seg1.ts`,
        'http://other.invalid/abs/seg2.ts'
    ]);
});
