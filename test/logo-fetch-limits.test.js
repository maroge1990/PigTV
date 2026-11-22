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

// #361 (0894): a queued cold logo waits at most queueWaitMs for a slot (then 503, nothing remembered), and a queued
// fetch every requester has given up on is never started; de-duplication still holds for the ones left.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a cold logo that waits too long for a slot is a 503, not remembered, and the queue is 96 long', async () => {
    assert.equal(logoRoute.limits.queue, 96);
    assert.equal(logoRoute.limits.queueWaitMs, 8000);
    const saved = { ...logoRoute.limits };
    const savedDelay = delayMs;
    Object.assign(logoRoute.limits, { concurrent: 1, queueWaitMs: 300 });
    delayMs = 1500;
    try {
        const slow = registerLogo(`${upstreamBase}/wait/slow.png`);
        const queued = registerLogo(`${upstreamBase}/wait/queued.png`);
        const holding = get(slow);
        await sleep(50);
        const started = Date.now();
        const waited = await get(queued);
        assert.equal(waited.status, 503);
        assert.ok(Date.now() - started < 1400, 'answered when the wait ran out, not when the slot freed');
        assert.equal(hits.get('/wait/queued.png') || 0, 0, 'never fetched');
        assert.equal((await holding).status, 200);
        delayMs = 10;
        assert.equal((await get(queued)).status, 200, 'not remembered as failed');
    } finally {
        Object.assign(logoRoute.limits, saved);
        delayMs = savedDelay;
    }
});

test('a queued fetch whose requesters all went away is dropped; one requester left still shares one fetch', async () => {
    const saved = { ...logoRoute.limits };
    const savedDelay = delayMs;
    Object.assign(logoRoute.limits, { concurrent: 1 });
    delayMs = 600;
    const abortable = (route) => {
        const c = new AbortController();
        const p = fetch(`${base}${route}`, { signal: c.signal }).then(r => r.status, () => 'aborted');
        return { c, p };
    };
    try {
        const first = registerLogo(`${upstreamBase}/gone/first.png`);
        const dropped = registerLogo(`${upstreamBase}/gone/dropped.png`);
        const shared = registerLogo(`${upstreamBase}/gone/shared.png`);
        const holding = get(first);
        await sleep(50);
        const a = abortable(dropped);
        const b1 = abortable(shared);
        const b2 = get(shared);
        await sleep(100);
        a.c.abort();
        b1.c.abort();
        assert.equal(await a.p, 'aborted');
        assert.equal((await holding).status, 200);
        const kept = await b2;
        assert.equal(kept.status, 200);
        await sleep(200);
        assert.equal(hits.get('/gone/dropped.png') || 0, 0, 'nobody waited for it: never fetched');
        assert.equal(hits.get('/gone/shared.png'), 1, 'one fetch for the requester left');
    } finally {
        Object.assign(logoRoute.limits, saved);
        delayMs = savedDelay;
    }
});

// #361 (0895): a queued job whose wait has run out by the time a slot frees is refused there (503, not remembered),
// before any upstream work, even when its timer has not run yet.
test('a queued fetch past its deadline when the slot frees is a 503 and never reaches the upstream', async () => {
    const saved = { ...logoRoute.limits };
    const savedDelay = delayMs;
    const realNow = logoRoute.clock.now;
    Object.assign(logoRoute.limits, { concurrent: 1, queueWaitMs: 8000 }); // the timer will not fire in this test
    delayMs = 300;
    try {
        const holder = registerLogo(`${upstreamBase}/deadline/holder.png`);
        const late = registerLogo(`${upstreamBase}/deadline/late.png`);
        const holding = get(holder);
        await sleep(50);
        const waiting = get(late);
        await sleep(50);
        logoRoute.clock.now = () => realNow() + 60000; // its deadline is behind it when the slot frees
        assert.equal((await holding).status, 200);
        assert.equal((await waiting).status, 503);
        assert.equal(hits.get('/deadline/late.png') || 0, 0, 'never fetched');
        logoRoute.clock.now = realNow;
        delayMs = 10;
        assert.equal((await get(late)).status, 200, 'not remembered as failed');
    } finally {
        logoRoute.clock.now = realNow;
        Object.assign(logoRoute.limits, saved);
        delayMs = savedDelay;
    }
});
