const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #106 (0349): playlist, guide and Xtream API downloads have an overall deadline and send the configured User-Agent.
// On 0348 a provider trickling its playlist held the sync for as long as it kept trickling (only undici's 300 s idle
// timeout applied), and every download carried Node's own agent. Deadlines are shortened here; the real ones are minutes.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-fetch-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const m3u = load('services/m3uParser');
const epg = load('services/epgParser');
const xtream = load('services/xtreamApi');
let timeouts = null;
try { timeouts = load('services/providerFetch').TIMEOUTS; } catch { /* 0348 has no providerFetch */ }

const agents = [];
const trickles = new Set();
const server = http.createServer((req, res) => {
    agents.push([req.url.split('?')[0], req.headers['user-agent']]);
    if (req.url.startsWith('/slow')) {
        // A playlist that never finishes: one line every 100 ms.
        res.setHeader('content-type', 'audio/x-mpegurl');
        res.write('#EXTM3U\n');
        const t = setInterval(() => res.write(`#EXTINF:-1 group-title="G",C\nhttp://p.invalid/live/u/p/${Date.now()}.ts\n`), 100);
        trickles.add(t);
        res.on('close', () => { clearInterval(t); trickles.delete(t); });
        return;
    }
    if (req.url.startsWith('/xmltv')) { res.setHeader('content-type', 'application/xml'); return res.end('<tv></tv>'); }
    if (req.url.startsWith('/player_api.php')) { res.setHeader('content-type', 'application/json'); return res.end('[]'); }
    res.setHeader('content-type', 'audio/x-mpegurl'); res.end('#EXTM3U\n#EXTINF:-1 group-title="G",A\nhttp://p.invalid/live/u/p/1.ts\n');
});
let base;
before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => {
    for (const t of trickles) clearInterval(t);
    server.closeAllConnections(); await new Promise(r => server.close(r));
    try { load('db/sqlite').getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a playlist that never finishes downloading gives up at its deadline', async () => {
    if (timeouts) timeouts.playlist = 800;
    const started = Date.now();
    const outcome = await Promise.race([
        (async () => { for await (const batch of m3u.fetchAndParseStreaming(`${base}/slow.m3u`)) { void batch; } return 'finished'; })()
            .catch(err => `failed: ${err.name}`),
        new Promise(r => setTimeout(() => r('still downloading after 5 s'), 5000))
    ]);
    assert.match(outcome, /^failed: (TimeoutError|AbortError)/);
    assert.ok(Date.now() - started < 4000);
});

test('playlist, guide and Xtream API downloads send the configured User-Agent', async () => {
    await db.settings.update({ userAgentPreset: 'tivimate' });
    agents.length = 0;
    for await (const batch of m3u.fetchAndParseStreaming(`${base}/get.m3u`)) { void batch; }
    for await (const batch of epg.fetchAndParseStreaming(`${base}/xmltv.php`)) { void batch; }
    await xtream.createFromSource({ url: base, username: 'u', password: 'p' }).getLiveCategories();
    assert.deepEqual(agents.map(a => a[1]), ['TiviMate/4.7.0', 'TiviMate/4.7.0', 'TiviMate/4.7.0'], JSON.stringify(agents.map(a => a[0])));
});
