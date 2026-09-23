const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0119 (roadmap S2.1 / P1-4, contract C-D): a `direct` resolve used to answer
// `/api/proxy/stream?url=<the provider's URL, credentials and all>`. It now
// answers `?h=<32 hex>`, an in-memory handle the proxy maps back to the URL.
// On the old code the resolve JSON carries the provider URL and the proxy
// answers `?h=` with 400 "URL required".
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-handles-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const recordingEngine = load('services/recordingEngine');
const db = load('db');
recordingEngine.listActive = () => [];

const STREAM = 'http://provider.invalid/live/user/pass/441367.m3u8';
const BODY = Buffer.alloc(32 * 1024, 9);
let upstream, upstreamBase, server, base, token;

before(async () => {
    upstream = http.createServer((req, res) => {
        if (req.url === '/live/index.m3u8') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttp://127.0.0.1:1/other/seg2.ts\n');
        }
        if (req.url.endsWith('/404.ts')) { res.writeHead(404); return res.end('nope'); }
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(BODY);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

    token = jwt.sign({ id: 1, username: 'owner', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const app = express();
    app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/proxy', load('routes/proxy'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    for (const s of [upstream, server]) { s?.closeAllConnections?.(); s?.close(); }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function primeDirectProbe(url, capabilities) {
    const { probeCache, analyzeProbeResult } = load('services/streamProbe');
    const settings = await db.settings.get();
    const caps = { ...strategy.DEFAULT_CAPABILITIES, ...capabilities };
    const raw = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
                            { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
                  format: { format_name: 'hls' } };
    const info = analyzeProbeResult(raw, url, caps);
    assert.equal(info.compatible, true, 'fixture: a source the client can play directly');
    const key = `${url}|${db.getUserAgent(settings) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: info, timestamp: Date.now() });
}

test('/api/info advertises playbackHandles', async () => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.features.playbackHandles, true);
});

test('a direct resolve returns ?h=<32 hex> and no provider URL anywhere in the JSON', async () => {
    const capabilities = { segmentedDelivery: true };
    await primeDirectProbe(STREAM, capabilities);
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: STREAM, capabilities })
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const decision = JSON.parse(text);
    assert.equal(decision.strategy, 'direct');
    assert.match(decision.url, /^\/api\/proxy\/stream\?h=[0-9a-f]{32}$/);
    for (const leak of ['provider.invalid', '441367', 'user/pass', 'url=', '://']) {
        assert.ok(!text.includes(leak), `the resolve JSON must not contain "${leak}": ${text}`);
    }
    // And the handle leads back to the stream.
    const h = new URL(decision.url, base).searchParams.get('h');
    assert.equal(load('services/playbackHandles').resolveHandle(h), STREAM);
});

test('an unknown, malformed or expired handle is a 404', async () => {
    const handles = load('services/playbackHandles');
    const expired = handles.createHandle(`${upstreamBase}/expired.ts`, Date.now() - handles.TTL_MS - 1000);
    for (const h of ['0123456789abcdef0123456789abcdef', 'not-a-handle', '', expired]) {
        const r = await fetch(`${base}/api/proxy/stream?h=${encodeURIComponent(h)}`);
        assert.equal(r.status, 404, `handle "${h}"`);
        assert.match((await r.json()).error, /Unknown or expired playback handle/);
    }
});

test('a known handle streams the upstream it stands for', async () => {
    const h = load('services/playbackHandles').createHandle(`${upstreamBase}/live/1.ts`);
    const r = await fetch(`${base}/api/proxy/stream?h=${h}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp2t');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY);
});

test('a manifest reached through a handle hands out handles, not the upstream addresses', async () => {
    const h = load('services/playbackHandles').createHandle(`${upstreamBase}/live/index.m3u8`);
    const manifest = await (await fetch(`${base}/api/proxy/stream?h=${h}&token=abc`)).text();
    assert.ok(!manifest.includes(upstreamBase) && !manifest.includes('127.0.0.1:1/'), manifest);
    const uris = manifest.split('\n').filter(l => l && !l.startsWith('#'));
    assert.equal(uris.length, 2);
    for (const u of uris) assert.match(u, /\/api\/proxy\/stream\?h=[0-9a-f]{32}&token=abc$/);
    // The first segment's handle plays.
    const seg = await fetch(uris[0]);
    assert.equal(seg.status, 200);
    assert.deepEqual(Buffer.from(await seg.arrayBuffer()), BODY);
});

test('?url= still works for the web\'s legacy callers', async () => {
    const r = await fetch(`${base}/api/proxy/stream?url=${encodeURIComponent(`${upstreamBase}/live/2.ts`)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY);
});

test('the registry: 32 hex, one handle per live URL, 12 h expiry, bounded size', () => {
    const handles = load('services/playbackHandles');
    handles.clearHandles();
    const a = handles.createHandle('http://x.invalid/a.ts');
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(handles.createHandle('http://x.invalid/a.ts'), a, 'the same URL reuses its handle');
    assert.notEqual(handles.createHandle('http://x.invalid/b.ts'), a);
    assert.equal(handles.TTL_MS, 12 * 60 * 60 * 1000);
    assert.equal(handles.resolveHandle(a, Date.now() + handles.TTL_MS + 1), null, 'expired after 12 h');
    assert.equal(handles.resolveHandle(a), null, 'and gone for good');

    handles.clearHandles();
    const first = handles.createHandle('http://x.invalid/0.ts');
    for (let i = 1; i <= handles.MAX_HANDLES; i++) handles.createHandle(`http://x.invalid/${i}.ts`);
    assert.equal(handles.handleCount(), handles.MAX_HANDLES, 'never more than the bound');
    assert.equal(handles.resolveHandle(first), null, 'the least recently used went first');
});

test('PIGTV_PLAYBACK_HANDLES=0 goes back to ?url= and drops the flag', async () => {
    process.env.PIGTV_PLAYBACK_HANDLES = '0';
    try {
        const info = await (await fetch(`${base}/api/info`)).json();
        assert.equal(info.features.playbackHandles, undefined);
        const capabilities = { segmentedDelivery: true };
        await primeDirectProbe(STREAM, capabilities);
        const decision = await strategy.resolve({ url: STREAM, capabilities, settings: await db.settings.get() });
        assert.match(decision.url, /^\/api\/proxy\/stream\?url=/);
    } finally {
        delete process.env.PIGTV_PLAYBACK_HANDLES;
    }
});

test('the proxy\'s log lines pass the provider URL through redact()', async () => {
    const h = load('services/playbackHandles').createHandle(`${upstreamBase}/live/secretuser/secretpass/404.ts`);
    const lines = [];
    const realError = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try {
        const r = await fetch(`${base}/api/proxy/stream?h=${h}`);
        assert.equal(r.status, 404);
    } finally { console.error = realError; }
    const upstreamLine = lines.find(l => l.includes('Upstream error'));
    assert.ok(upstreamLine, lines.join('\n'));
    assert.ok(!/secretuser|secretpass/.test(upstreamLine), `credentials in the log: ${upstreamLine}`);
    assert.match(upstreamLine, /\/live\/\*\*\*\/\*\*\*\/404\.ts/);
});
