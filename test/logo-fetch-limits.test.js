const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// #361 (0891): a guide page names hundreds of cold logos at once. Requests for one logo share one upstream fetch,
// upstream fetches are capped (6 at once, the rest queued), and a logo whose fetch failed is not fetched again for
// 5 minutes. A fake upstream counts what it is asked.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-limits-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
const cwd = process.cwd();
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const { registerLogo } = load('services/logoCache');
const logoRoute = load('routes/logo');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
let server, base, upstream, upstreamBase;
const hits = new Map();
let current = 0, peak = 0, delayMs = 100;
const failing = new Set();

before(async () => {
    upstream = http.createServer((req, res) => {
        hits.set(req.url, (hits.get(req.url) || 0) + 1);
        current++; peak = Math.max(peak, current);
        setTimeout(() => {
            current--;
            if (failing.has(req.url)) { res.writeHead(500); return res.end(); }
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(PNG);
        }, delayMs);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

    const app = express();
    app.use('/api/logo', logoRoute);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { hits.clear(); peak = 0; logoRoute._resetFetches(); });

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    upstream?.closeAllConnections?.();
    upstream?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(cwd);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

const get = async (route) => { const r = await fetch(`${base}${route}`); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };

test('20 requests at once for one cold logo make one upstream fetch, and all get the logo', async () => {
    const route = registerLogo(`${upstreamBase}/one.png`);
    const answers = await Promise.all(Array.from({ length: 20 }, () => get(route)));
    assert.deepEqual(answers.map(a => a.status), Array(20).fill(200));
    for (const a of answers) assert.deepEqual(a.body, PNG);
    assert.equal(hits.get('/one.png'), 1, 'one upstream fetch');
});

test('50 distinct cold logos never have more than 6 upstream fetches at once, and all arrive', async () => {
    assert.equal(logoRoute.limits.concurrent, 6);
    const routes = Array.from({ length: 50 }, (_, i) => registerLogo(`${upstreamBase}/many/${i}.png`));
    const answers = await Promise.all(routes.map(get));
    assert.deepEqual(answers.map(a => a.status), Array(50).fill(200));
    assert.equal(hits.size, 50);
    assert.ok(peak <= 6, `peak ${peak} upstream fetches at once`);
    assert.ok(peak >= 2, `the fetches still overlap (peak ${peak})`);
});

test('a logo that failed is not fetched again inside the window, and is after it', async () => {
    const saved = logoRoute.limits.failMs;
    logoRoute.limits.failMs = 1500;
    try {
        failing.add('/broken.png');
        const route = registerLogo(`${upstreamBase}/broken.png`);
        assert.equal((await get(route)).status, 502);
        assert.equal(hits.get('/broken.png'), 1);
        const again = await Promise.all([get(route), get(route), get(`${route}?size=full`)]);
        assert.deepEqual(again.map(a => a.status), [502, 502, 502]);
        assert.equal(hits.get('/broken.png'), 1, 'not asked again inside the window');
        failing.delete('/broken.png');
        await new Promise(r => setTimeout(r, 1600));
        const later = await get(route);
        assert.equal(later.status, 200);
        assert.equal(hits.get('/broken.png'), 2, 'asked again after the window');
        assert.deepEqual(later.body, PNG);
    } finally {
        logoRoute.limits.failMs = saved;
        failing.clear();
    }
});

test('with the queue full a further cold logo is a 503 and is not remembered as failed', async () => {
    const saved = { ...logoRoute.limits };
    Object.assign(logoRoute.limits, { concurrent: 1, queue: 1 });
    try {
        const routes = [0, 1, 2].map(i => registerLogo(`${upstreamBase}/queue/${i}.png`));
        const answers = await Promise.all(routes.map(get));
        assert.deepEqual(answers.map(a => a.status).sort(), [200, 200, 503]);
        const busy = routes[answers.findIndex(a => a.status === 503)];
        assert.equal((await get(busy)).status, 200, 'tried again at once: nothing was remembered');
    } finally {
        Object.assign(logoRoute.limits, saved);
    }
});
