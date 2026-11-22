const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const compression = require('compression');

// #362/#361: the guide's size and speed on a production-shaped database, so a later change (batch 3) can be
// measured before and after. Test-only: it reads GET /api/library/guide as the Apple client pages it (limit=500,
// by cursor, until nextCursor is null) and prints ONE line, `GUIDE-PERF {json}`. The budgets are loose regression
// guards at about 2x the times and 1.15x the sizes measured on the WSL machine on 22 Nov 2026 (build 0886).
// Fixture build time is printed, not budgeted. A speed budget: see helpers/perf.js.
const perf = require('./helpers/perf');

// tighten in batch 3 (#361): first page under 300 KB
const BUDGET_PAGE_MS = 100;          // each page, uncompressed fetch (median of 5); measured 72 ms, 36-44 ms since 0888: wider than 2x for a slow machine
const BUDGET_PAGE_INDEX_REBUILD_MS = 130; // each page with the visible-order index built again first (0888's index, a guide change); measured 50-60 ms
const BUDGET_TOTAL_MS = 300;         // all pages, uncompressed; measured 183 ms, 82 ms since 0888
const BUDGET_PAGE_GZIP_MS = 350;     // each page with gzip on (compression time included); measured 143 ms, 108 ms since 0888
const BUDGET_TOTAL_GZIP_MS = 750;    // all pages with gzip; measured 363 ms, 262 ms since 0888
// tighten in batch 3 (#361): first page under 300 KB
const BUDGET_PAGE_RAW_BYTES = 4750000;   // each page, uncompressed; measured 4.14 MB
const BUDGET_TOTAL_RAW_BYTES = 11900000; // whole guide, uncompressed; measured 10.33 MB
// tighten in batch 3 (#361): first page under 300 KB
const BUDGET_PAGE_GZIP_BYTES = 945000;    // each page, gzip on the wire; measured 821 KB
const BUDGET_TOTAL_GZIP_BYTES = 2350000; // whole guide, gzip on the wire; measured 2.05 MB

const PLAYLIST_ROWS = 19000, VISIBLE = 1250, EPG_CHANNELS = 2500, PROGRAMMES_PER_CHANNEL = 240, CATEGORIES = 40, HIDDEN_CATEGORIES = 10;
const PAGE_LIMIT = 500, FETCHES = 5;
const MIN = 60000, HOUR = 3600000;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-perf-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const { shouldCompress } = load('services/compressionFilter');
const channelNumbers = load('services/channelNumbers');
const guideIndex = load('services/guideIndex');

let server;
after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// A repeatable pseudo-random sequence, so every run builds the same database.
let seed = 20261122;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const WORDS = ('the a of and with her his their finds discovers family detective city night morning journey secret '
    + 'brother sister mystery old new young returns after against over under between hidden lost final first season '
    + 'chef garden house island road river storm captain doctor lawyer farmer team match rival weekend holiday').split(' ');
const sentence = (min, max) => {
    const len = min + Math.floor(rnd() * (max - min));
    let s = '';
    while (s.length < len) s += (s ? ' ' : '') + WORDS[Math.floor(rnd() * WORDS.length)];
    return s.charAt(0).toUpperCase() + s.slice(1, len).replace(/\s+\S*$/, '') + '.';
};

function buildFixture(source, now) {
    const d = sqlite.getDb();
    const cat = d.prepare("INSERT INTO categories (id, source_id, category_id, type, name, is_hidden, sort_order) VALUES (?, ?, ?, 'live', ?, ?, ?)");
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_icon, stream_url, sort_order, data, stable_id, tvg_id, is_hidden)
        VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, gen, categories, flags, data)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
    d.transaction(() => {
        for (let c = 0; c < CATEGORIES; c++) cat.run(`${source.id}:${c}`, source.id, String(c), `Category ${c}`, c >= CATEGORIES - HIDDEN_CATEGORIES ? 1 : 0, c);
        // 19,000 rows, 1,250 visible: the rest are hidden themselves or sit in a hidden category.
        for (let i = 0; i < PLAYLIST_ROWS; i++) {
            const visible = i < VISIBLE;
            const category = visible ? i % (CATEGORIES - HIDDEN_CATEGORIES) : (i % 2 ? CATEGORIES - HIDDEN_CATEGORIES + (i % HIDDEN_CATEGORIES) : i % (CATEGORIES - HIDDEN_CATEGORIES));
            const data = JSON.stringify({ stream_id: i, name: `Channel ${i}`, stream_icon: `http://provider.invalid/logos/${i}.png`, epg_channel_id: `ch${i}.invalid`, category_id: String(category) });
            item.run(`${source.id}:${i}`, source.id, String(i), `Channel ${String(i).padStart(5, '0')} HD`, String(category),
                `http://provider.invalid/logos/${i}.png`, `http://provider.invalid/live/u/p/${i}.ts`, null, data, `s${100000 + i}`, `ch${i}.invalid`, visible || i % 2 === 0 && category < CATEGORIES - HIDDEN_CATEGORIES ? (visible ? 0 : 1) : 0);
        }
        // 2,500 guide channels (the 1,250 visible and 1,250 others) x 240 programmes of 20 to 80 minutes from
        // 12 h before now: about 29 programmes per channel in the next 24 h and 600,000 rows in all. Through
        // the same insert the sync uses (syncService.loadEpgFile), generation 0 = the live one.
        for (let c = 0; c < EPG_CHANNELS; c++) {
            let t = now - 12 * HOUR - Math.floor(rnd() * 40) * MIN;
            for (let p = 0; p < PROGRAMMES_PER_CHANNEL; p++) {
                const len = (20 + Math.floor(rnd() * 13) * 5) * MIN;
                const desc = rnd() < 0.6 ? sentence(150, 300) : null;
                const data = {};
                if (rnd() < 0.3) data.sub = sentence(15, 40).slice(0, -1);
                if (rnd() < 0.3) data.ep = `S${1 + Math.floor(rnd() * 9)}E${1 + Math.floor(rnd() * 20)}`;
                if (rnd() < 0.15) data.img = `http://provider.invalid/art/${c}/${p}.jpg`;
                prog.run(`ch${c}.invalid`, source.id, t, t + len, sentence(10, 30).slice(0, -1), desc,
                    rnd() < 0.2 ? JSON.stringify(['Entertainment']) : null, rnd() < 0.1 ? 4 : null, Object.keys(data).length ? JSON.stringify(data) : null);
                t += len;
            }
        }
    })();
    d.exec('ANALYZE');
    channelNumbers.assignChannelNumbers();
}

const agent = new http.Agent({ keepAlive: true });
// One GET with the encoding under our control (fetch would decompress and hide the wire size).
function get(base, route, token, gzip) {
    return new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const req = http.get(base + route, { agent, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': gzip ? 'gzip' : 'identity' } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: body.length, status: res.statusCode, encoding: res.headers['content-encoding'] || null, body });
            });
        });
        req.on('error', reject);
    });
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r1 = n => Math.round(n * 10) / 10;

test('guide paging on a production-shaped database: GUIDE-PERF', { ...perf, timeout: 180000 }, async (ctx) => {
    const t0 = Date.now();
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    const token = auth.generateToken({ ...user, id: 1 });
    const source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const now = Date.now();
    buildFixture(source, now);
    const d = sqlite.getDb();
    assert.equal(d.prepare('SELECT COUNT(*) n FROM playlist_items').get().n, PLAYLIST_ROWS);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM epg_live').get().n, EPG_CHANNELS * PROGRAMMES_PER_CHANNEL, 'epg_live sees every guide row');

    // As server/index.js mounts it: gzip for JSON through shouldCompress, then the real library router and its auth.
    const app = express();
    app.use(compression({ filter: shouldCompress }));
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/library', load('routes/library'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const buildMs = Date.now() - t0;

    // The pages the Apple client fetches: limit=500 by cursor until nextCursor is null, the 24 h window from `now`.
    const window = `start=${now}&end=${now + 24 * HOUR}`;
    const routes = [];
    let cursor = null, total = null;
    do {
        const route = `/api/library/guide?limit=${PAGE_LIMIT}&${window}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await get(base, route, token, false);
        assert.equal(res.status, 200);
        const json = JSON.parse(res.body.toString());
        total = json.total;
        routes.push({ route, channels: json.channels.length, programmes: json.channels.reduce((n, c) => n + c.programmes.length, 0) });
        cursor = json.nextCursor;
    } while (cursor && routes.length < 20);
    assert.equal(total, VISIBLE);
    assert.equal(routes.reduce((n, r) => n + r.channels, 0), VISIBLE, 'every visible channel is paged');
    assert.ok(routes.every(r => r.programmes > 0));

    const pages = [];
    for (const { route, channels, programmes } of routes) {
        await get(base, route, token, false); await get(base, route, token, true); // warm-up
        const raw = [], zipped = [];
        let rawBytes = 0, gzipBytes = 0;
        for (let i = 0; i < FETCHES; i++) {
            const a = await get(base, route, token, false);
            const b = await get(base, route, token, true);
            assert.equal(a.encoding, null);
            assert.equal(b.encoding, 'gzip', 'gzip is honoured on the wire');
            raw.push(a.ms); zipped.push(b.ms); rawBytes = a.bytes; gzipBytes = b.bytes;
        }
        // `indexRebuildMs`: the same page with the index of the visible order built again first (the first page after
        // a guide or lineup change, 0888/0894).
        const rebuilt = [];
        for (let i = 0; i < FETCHES; i++) {
            guideIndex.invalidate();
            rebuilt.push((await get(base, route, token, false)).ms);
        }
        pages.push({ ms: r1(median(raw)), gzipMs: r1(median(zipped)), indexRebuildMs: r1(median(rebuilt)), rawBytes, gzipBytes, channels, programmes });
    }
    const sum = k => pages.reduce((n, p) => n + p[k], 0);
    const out = { pages: pages.length };
    pages.forEach((p, i) => { out[`page${i + 1}`] = p; });
    out.total = { ms: r1(sum('ms')), gzipMs: r1(sum('gzipMs')), indexRebuildMs: r1(sum('indexRebuildMs')), rawBytes: sum('rawBytes'), gzipBytes: sum('gzipBytes'), programmes: sum('programmes') };
    out.buildMs = buildMs;
    console.log(`GUIDE-PERF ${JSON.stringify(out)}`);
    ctx.diagnostic(`fixture built in ${buildMs} ms`);

    for (const [i, p] of pages.entries()) {
        assert.ok(p.ms <= BUDGET_PAGE_MS, `page ${i + 1} took ${p.ms} ms (budget ${BUDGET_PAGE_MS})`);
        assert.ok(p.indexRebuildMs <= BUDGET_PAGE_INDEX_REBUILD_MS, `page ${i + 1} took ${p.indexRebuildMs} ms with the index rebuilt (budget ${BUDGET_PAGE_INDEX_REBUILD_MS})`);
        assert.ok(p.gzipMs <= BUDGET_PAGE_GZIP_MS, `page ${i + 1} took ${p.gzipMs} ms with gzip (budget ${BUDGET_PAGE_GZIP_MS})`);
        assert.ok(p.rawBytes <= BUDGET_PAGE_RAW_BYTES, `page ${i + 1} is ${p.rawBytes} raw bytes (budget ${BUDGET_PAGE_RAW_BYTES})`);
        assert.ok(p.gzipBytes <= BUDGET_PAGE_GZIP_BYTES, `page ${i + 1} is ${p.gzipBytes} gzip bytes (budget ${BUDGET_PAGE_GZIP_BYTES})`);
    }
    assert.ok(out.total.ms <= BUDGET_TOTAL_MS, `the whole guide took ${out.total.ms} ms (budget ${BUDGET_TOTAL_MS})`);
    assert.ok(out.total.gzipMs <= BUDGET_TOTAL_GZIP_MS, `the whole guide took ${out.total.gzipMs} ms with gzip (budget ${BUDGET_TOTAL_GZIP_MS})`);
    assert.ok(out.total.rawBytes <= BUDGET_TOTAL_RAW_BYTES, `the whole guide is ${out.total.rawBytes} raw bytes (budget ${BUDGET_TOTAL_RAW_BYTES})`);
    assert.ok(out.total.gzipBytes <= BUDGET_TOTAL_GZIP_BYTES, `the whole guide is ${out.total.gzipBytes} gzip bytes (budget ${BUDGET_TOTAL_GZIP_BYTES})`);
});
