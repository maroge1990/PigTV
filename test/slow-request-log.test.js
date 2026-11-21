const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { slowRequestLog, thresholdFrom, EXCLUDED_ROUTES } = require('../server/services/slowRequestLog');

// #362: one `slow request: <METHOD> <route pattern> <status> <ms> ms <bytes> bytes` line per slow request; the pattern,
// never the URL (a query string can hold a token and a path parameter a session id). The clock is injected: a handler
// advances it, so nothing here depends on real timing.
async function run(opts, mount) {
    const lines = [];
    let clock = 0;
    const app = express();
    app.use(slowRequestLog({ now: () => clock, log: l => lines.push(l), ...opts }));
    mount(app, ms => { clock += ms; });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return { lines, base, close: () => { server.closeAllConnections?.(); server.close(); } };
}

function routes(app, tick) {
    const r = express.Router();
    r.get('/:sessionId/pause', (req, res) => { tick(1500); res.json({ ok: true }); });
    r.get('/:sessionId/fast', (req, res) => { tick(10); res.json({ ok: true }); });
    app.use('/api/playback', r);
    const t = express.Router();
    t.get('/:sessionId/:segment', (req, res) => { tick(5000); res.send('x'.repeat(100)); });
    app.use('/api/transcode', t);
    app.get('/api/guide', (req, res) => { tick(2500); res.json({ big: 'y'.repeat(1000) }); });
}

async function hit(base, p) {
    const r = await fetch(base + p, { headers: { 'Accept-Encoding': 'identity' } });
    await r.text();
    await new Promise(resolve => setTimeout(resolve, 50)); // the 'finish' event follows the last byte
}

test('a slow request logs one line in the exact format, with the pattern and never the URL', async () => {
    const s = await run({ threshold: 1000 }, routes);
    try {
        await hit(s.base, '/api/playback/SECRET2/pause?token=SECRET');
        assert.deepEqual(s.lines, ['slow request: GET /api/playback/:sessionId/pause 200 1500 ms 11 bytes']);
        await hit(s.base, '/api/guide?limit=500&token=SECRET');
        assert.equal(s.lines.length, 2);
        assert.match(s.lines[1], /^slow request: GET \/api\/guide 200 2500 ms 1010 bytes$/);
        assert.ok(!s.lines.join('\n').includes('SECRET'), 'no token or id in any line');
    } finally { s.close(); }
});

test('an unmatched request logs (unmatched), with no URL', async () => {
    const s = await run({ threshold: 1000 }, (app, tick) => app.use((req, res) => { tick(3000); res.status(404).json({}); }));
    try {
        await hit(s.base, '/nowhere/SECRET2?token=SECRET');
        assert.match(s.lines[0], /^slow request: GET \(unmatched\) 404 3000 ms \d+ bytes$/);
        assert.ok(!s.lines[0].includes('SECRET'));
    } finally { s.close(); }
});

test('a fast request logs nothing', async () => {
    const s = await run({ threshold: 1000 }, routes);
    try {
        await hit(s.base, '/api/playback/SECRET2/fast');
        assert.deepEqual(s.lines, []);
    } finally { s.close(); }
});

test('a threshold of 0 turns it off', async () => {
    const s = await run({ threshold: 0 }, routes);
    try {
        await hit(s.base, '/api/guide');
        assert.deepEqual(s.lines, []);
    } finally { s.close(); }
    assert.equal(thresholdFrom('0'), 0);
    assert.equal(thresholdFrom(undefined), 1000);
    assert.equal(thresholdFrom('nonsense'), 1000);
    assert.equal(thresholdFrom('250'), 250);
});

test('a streaming route is slow by design and logs nothing', async () => {
    const s = await run({ threshold: 1000 }, routes);
    try {
        await hit(s.base, '/api/transcode/SECRET2/seg0001.ts?token=SECRET');
        assert.deepEqual(s.lines, []);
    } finally { s.close(); }
    for (const r of ['/api/proxy/stream', '/api/recordings/:id/media.mp4', '/api/recordings/:id/download']) assert.ok(EXCLUDED_ROUTES.has(r), r);
});

test('server/index.js mounts it before the routes', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/index.js'), 'utf8');
    const at = src.indexOf("require('./services/slowRequestLog')");
    assert.ok(at > 0 && at < src.indexOf("app.use('/api/auth'"));
});
