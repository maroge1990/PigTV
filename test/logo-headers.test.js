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
let swapBody = null; // 0895: what /swap.bin answers now

before(async () => {
    imageServer = http.createServer((req, res) => {
        if (req.url.endsWith('.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(SVG); }
        if (req.url.endsWith('big.bin')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(BIG); }
        if (req.url.endsWith('swap.bin')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(swapBody); }
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

// #361 (0892): a logo answer says how long it is and may be kept 30 days, then revalidated by its ETag. Not
// `immutable`: the path is keyed by the upstream URL, not the bytes, so what is behind it can change.
test('every logo answer has its Content-Length and a 30-day Cache-Control; a 304 keeps the Cache-Control', async () => {
    const route = registerLogo(`${imageBase}/length.png`);
    for (const suffix of ['', '?size=full', '?size=640']) {
        const res = await fetch(`${base}${route}${suffix}`);
        assert.equal(res.status, 200, suffix);
        const body = Buffer.from(await res.arrayBuffer());
        assert.equal(res.headers.get('content-length'), String(body.length), `${suffix}: Content-Length`);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000', suffix);
        assert.doesNotMatch(res.headers.get('cache-control'), /immutable/);
        assert.deepEqual(body, PNG, suffix);
        const again = await fetch(`${base}${route}${suffix}`, { headers: { 'If-None-Match': res.headers.get('etag') } });
        assert.equal(again.status, 304, suffix);
        assert.equal(again.headers.get('cache-control'), 'public, max-age=2592000', `${suffix}: 304`);
    }
});

// #361 (0894): a stored logo is streamed from one open descriptor (its fstat is the Content-Length), never read whole
// into memory, and the descriptor closes when the client goes away mid-answer.
const BIG = Buffer.concat([PNG, Buffer.alloc(1900 * 1024, 1)]);
const openOn = (name) => {
    if (process.platform !== 'linux') return null;
    let n = 0;
    for (const fd of fs.readdirSync('/proc/self/fd')) {
        try { if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith(name)) n++; } catch { /* closed meanwhile */ }
    }
    return n;
};

test('a stored logo is streamed with its Content-Length, not read whole', async () => {
    const route = registerLogo(`${imageBase}/streamed.png`);
    assert.equal((await fetch(`${base}${route}`)).status, 200); // fetched and stored
    const calls = [];
    const spied = {};
    for (const m of ['readFile', 'readFileSync', 'createReadStream']) {
        spied[m] = fs[m];
        fs[m] = function (...a) { calls.push(m); return spied[m].apply(this, a); };
    }
    try {
        const res = await fetch(`${base}${route}`);
        const body = Buffer.from(await res.arrayBuffer());
        assert.equal(res.headers.get('content-length'), String(body.length));
        assert.deepEqual(body, PNG);
    } finally { Object.assign(fs, spied); }
    assert.ok(!calls.includes('readFile') && !calls.includes('readFileSync'), `no whole-file read (${calls.join(',')})`);
    assert.ok(calls.includes('createReadStream'), 'streamed');
});

test('a client that goes away mid-answer leaves no descriptor open', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
    const route = registerLogo(`${imageBase}/big.bin`);
    const key = route.split('/').pop();
    const first = await fetch(`${base}${route}?size=full`);
    assert.equal(first.status, 200);
    assert.equal((await first.arrayBuffer()).byteLength, BIG.length);
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve, reject) => {
            const req = http.get(`${base}${route}?size=full`, res => {
                assert.equal(res.headers['content-length'], String(BIG.length));
                res.once('data', () => { req.destroy(); resolve(); });
            });
            req.on('error', () => resolve());
            setTimeout(() => reject(new Error('no data')), 5000).unref();
        });
    }
    let open = openOn(`${key}.orig`);
    for (let t = 0; t < 40 && open > 0; t++) { await new Promise(r => setTimeout(r, 50)); open = openOn(`${key}.orig`); }
    assert.equal(open, 0, 'every descriptor on the file is closed');
});

// #361 (0895): a logo is replaced by a rename, never rewritten in place, so an answer streaming from the old file
// delivers all of its Content-Length; the next request gets the new file.
test('a logo replaced while an answer streams it: that answer is whole, the next one is the new logo', async () => {
    swapBody = Buffer.concat([PNG, Buffer.alloc(1990 * 1024, 2)]);
    const route = registerLogo(`${imageBase}/swap.bin`);
    const key = route.split('/').pop();
    assert.equal((await fetch(`${base}${route}?size=full`)).status, 200);
    const old = swapBody;

    let res;
    const chunks = [];
    await new Promise((resolve, reject) => {
        http.get(`${base}${route}?size=full`, r => {
            res = r;
            r.once('data', c => { chunks.push(c); r.pause(); resolve(); });
        }).on('error', reject);
    });
    const length = Number(res.headers['content-length']);
    assert.equal(length, old.length);

    // The logo is fetched again (a lost row state) and the upstream now has a much shorter one.
    swapBody = Buffer.concat([PNG, Buffer.alloc(100, 3)]);
    sqlite.getDb().prepare('UPDATE logo_cache SET fetched_at = NULL WHERE key = ?').run(key);
    assert.equal((await fetch(`${base}${route}`)).status, 200);

    const rest = await new Promise((resolve) => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('aborted', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(Buffer.concat(chunks)));
        res.resume();
    });
    assert.equal(rest.length, length, 'every advertised byte arrived');
    assert.deepEqual(rest, old, 'the old logo, whole');
    const next = await fetch(`${base}${route}?size=full`);
    assert.deepEqual(Buffer.from(await next.arrayBuffer()), swapBody, 'the next request gets the new logo');
    assert.equal(fs.readdirSync(path.join(sandbox, 'data', 'logos')).filter(n => n.endsWith('.tmp')).length, 0, 'no temporary file left');
});
