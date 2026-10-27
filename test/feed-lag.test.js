const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// R7 data (FR-12, 27 Oct): each shared ingest's worst lag behind real time is kept in the database
// when it closes, so a later per-channel limit can be set from it. Before, the only record was the
// close line in the container log (lost on a redeploy), and that figure was reset by every
// reconnect: an ingest that reached 25 s, reconnected, and peaked at 17 s afterwards logged 17 s.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-feed-lag-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
process.env.PIGTV_DB_BACKUPS = '0';
const load = (p) => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const ingest = load('services/ingest');
const T = ingest.tuning;
const TUNING = { ...T };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function packet(pcrSec, n) {
    const b = Buffer.alloc(188, 0xff);
    const pid = n % 20 === 0 ? 0 : 256;
    b[0] = 0x47; b[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff;
    if (pid === 0) { b[3] = 0x10; return b; }
    b[3] = 0x30; b[4] = 7; b[5] = 0x10;
    const base = Math.round(pcrSec * 90000);
    b[6] = Math.floor(base / 33554432) & 0xff; b[7] = Math.floor(base / 131072) & 0xff;
    b[8] = Math.floor(base / 512) & 0xff; b[9] = Math.floor(base / 2) & 0xff; b[10] = (base % 2) << 7;
    return b;
}
const media = (from, seconds) => Buffer.concat(Array.from({ length: Math.round(seconds * 100) }, (_, k) => packet(from + k / 100, k)));

let server, base, feedLag;
before(async () => {
    feedLag = load('services/feedLag'); // on 0286 there is no such module
    server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        let at = 0;
        const timers = [];
        const send = (s) => { if (!res.destroyed) { res.write(media(at, s)); at += s; } };
        if (req.url === '/trickle') timers.push(setInterval(() => send(0.05), 100)); // half speed: falls behind
        else { send(1); timers.push(setInterval(() => send(0.1), 100)); } // real time
        res.on('close', () => timers.forEach(clearInterval));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { ingest.closeAll('test over'); Object.assign(T, TUNING); feedLag.tuning.minLiveSec = 60; sqlite.getDb().prepare('DELETE FROM feed_lag').run(); });
after(() => {
    server.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const rows = () => sqlite.getDb().prepare('SELECT * FROM feed_lag ORDER BY id').all();

test('a closed ingest leaves a row: its channel and provider by name, its worst lag over every connection, its lag reconnects', async () => {
    Object.assign(T, { behindMs: 2000, reconnectMs: 20000 });
    feedLag.tuning.minLiveSec = 0;
    await quiet(async () => {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/trickle`, purpose: 'viewer', channel: 'NBC Sports Boston', providerName: 'Strong8K', providerId: 3 });
        sub.resume();
        let waited = 0;
        while (ingest.list()[0].reconnects === 0 && waited < 12000) { await sleep(200); waited += 200; }
        assert.ok(ingest.list()[0].reconnects >= 1, 'it fell behind and was reconnected');
        await sleep(600); // a fresh connection: its own pace starts again from its head start
        assert.ok(ingest.list()[0].maxBehindSec >= 2, `Status keeps the worst across the reconnect (${ingest.list()[0].maxBehindSec}s)`);
        sub.leave();
        ingest.closeAll('test over');
    });
    const [row] = rows();
    assert.ok(row, 'a row was written');
    assert.equal(row.channel, 'NBC Sports Boston');
    assert.equal(row.provider_name, 'Strong8K');
    assert.equal(row.provider_id, 3);
    assert.ok(row.worst_behind_sec >= 2, `worst ${row.worst_behind_sec}s: the lag that caused the reconnect, not the newer connection's`);
    assert.ok(row.lag_reconnects >= 1 && row.reconnects >= row.lag_reconnects);
    assert.equal(row.why, 'test over');
    assert.ok(!JSON.stringify(row).includes('127.0.0.1'), 'never the URL');
});

test('an ingest that read for less than a minute leaves no row', async () => {
    await quiet(async () => {
        const sub = await ingest.subscribe({ pool: 'p', url: `${base}/steady`, purpose: 'viewer', channel: 'Quick zap' });
        sub.resume();
        await sleep(400);
        sub.leave();
        ingest.closeAll('test over');
    });
    assert.equal(rows().length, 0);
});

test('summary: one line per channel and provider over 30 days, worst first; older rows are pruned', () => {
    const now = Date.now();
    const at = (daysAgo, channel, provider, worst, lag = 0) => feedLag.record({ channel, providerId: provider === 'Trex' ? 7 : 3, providerName: provider,
        startedAt: now - daysAgo * 86400000 - 3600000, endedAt: now - daysAgo * 86400000, worstBehindSec: worst, reconnects: lag, lagReconnects: lag });
    feedLag.tuning.minLiveSec = 60;
    at(40, 'Chicago', 'Strong8K', 30); // outside the 30 days: pruned by the next write
    at(2, 'Chicago', 'Strong8K', 24.1);
    at(1, 'Chicago', 'Strong8K', 18.3, 1);
    at(1, 'Chicago', 'Trex', 19);
    at(0, 'NBC Sports Boston', 'Strong8K', 25, 1);
    assert.equal(rows().length, 4, 'the 40-day-old row went');
    const s = JSON.parse(JSON.stringify(feedLag.summary({ now })));
    assert.deepEqual(s.map(r => [r.channel, r.provider, r.reads, r.worstBehindSec, r.lagReconnects]), [
        ['NBC Sports Boston', 'Strong8K', 1, 25, 1],
        ['Chicago', 'Strong8K', 2, 24.1, 1],
        ['Chicago', 'Trex', 1, 19, 0]
    ]);
    assert.equal(s[1].hours, 2);
});
