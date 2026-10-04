const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0171 (multi-provider P3): a relink is bucketed, not N x M. About 1,000 visible primary
// channels against a 55,000-row backup (the size of a raw Xtream list) must relink well inside
// the budget. The budget is generous so a loaded CI machine does not make it flaky; a
// nested scan would take minutes. 0203: 10 s (was 3 s; a GitHub runner measured 3.3 s and
// blocked an image publish - still an order of magnitude below what this guards against).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-channel-links-perf-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const backupChannels = load('services/backupChannels');
const rawChannels = load('services/rawChannels');
const links = load('services/channelLinks');

const STRONG8K = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers/strong8k-epgenius.json'), 'utf8'));
const TREX_RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers/trex-xtream-raw.json'), 'utf8'));

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const quiet = async fn => {
    const saved = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = saved; }
};

test('1,000 visible channels against a 55,000-row backup relink in under 10 s', async (ctx) => {
    const primary = await db.sources.create({ type: 'm3u', name: 'Primary', url: 'http://primary.invalid/list.m3u' });
    const backup = await db.sources.create({ type: 'xtream', name: 'Big', url: 'http://big.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    const d = sqlite.getDb();

    // The primary: the real Strong8K names, 1,000 identities, all visible.
    const cat = d.prepare("INSERT INTO categories (id, source_id, category_id, type, name) VALUES (?, ?, ?, 'live', ?)");
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stable_id, tvg_id, sort_order, is_hidden)
        VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, 0)`);
    const groups = [...new Set(STRONG8K.map(e => e.group))];
    d.transaction(() => {
        groups.forEach((g, i) => cat.run(`${primary.id}:${i}`, primary.id, String(i), g));
        for (let i = 0; i < 1000; i++) {
            const e = STRONG8K[i % STRONG8K.length];
            const name = i < STRONG8K.length ? e.name : `${e.name} ${i}`;
            item.run(`${primary.id}:pos_${i}`, primary.id, `pos_${i}`, name, String(groups.indexOf(e.group)), `s${900000 + i}`, e.tvgId, i);
        }
    })();

    // The backup: the raw Trex list repeated with changed ids and region prefixes, to 55,000 rows,
    // so the buckets are as crowded as a real one's (many "UK| SKY SPORTS ..." per name).
    const cats = new Map(TREX_RAW.categories.map(c => [String(c.category_id), c.category_name]));
    const prefixes = ['UK', 'AU', 'US', 'CA', 'NZ', 'FR', 'DE', 'IE', 'ES', 'IT'];
    const rows = [];
    for (let i = 0; rows.length < 55000; i++) {
        const s = TREX_RAW.streams[i % TREX_RAW.streams.length];
        const round = Math.floor(i / TREX_RAW.streams.length);
        const p = prefixes[round % prefixes.length];
        rows.push({
            streamId: String(10000000 + i), name: round ? `${p}| ${s.name.replace(/^[A-Z]{2}\| ?/, '')} ${round}` : s.name,
            categoryId: String(s.category_id), categoryName: cats.get(String(s.category_id)) || null,
            tvgId: s.epg_channel_id, logo: null, urlData: null
        });
    }
    backupChannels.replaceAll(backup.id, rows, null);
    assert.equal(backupChannels.count(backup.id), 55000);
    // 0178 (P9): the raw rows of both sides too (every primary channel has one, every backup row has one),
    // so the raw-name / raw-epg buckets are as crowded as a real pair of providers'.
    rawChannels.replaceAll(backup.id, rows.map(r => ({ streamId: r.streamId, name: r.name, epg: r.tvgId, category: r.categoryName })));
    rawChannels.replaceAll(primary.id, Array.from({ length: 1000 }, (_, i) => {
        const r = rows[i * 37];
        return { streamId: String(900000 + i), name: r.name, epg: r.tvgId, category: r.categoryName };
    }));

    let t = Date.now();
    const first = await quiet(() => links.relinkSource(backup.id));
    const firstMs = Date.now() - t;
    assert.equal(first.channels, 1000);
    assert.ok(first.backups[backup.id].auto > 0, 'it links something');
    const byMethod = d.prepare("SELECT method, COUNT(*) AS n FROM channel_links WHERE backup_source_id = ? GROUP BY method").all(backup.id);
    assert.ok(byMethod.some(m => m.method === 'raw-name' && m.n > 100), `the raw bridge is exercised: ${JSON.stringify(byMethod)}`);
    assert.ok(firstMs < 10000, `the first relink (which also fills region/quality/is_event) took ${firstMs} ms`);

    t = Date.now();
    await quiet(() => links.relinkSource(backup.id));
    const secondMs = Date.now() - t;
    assert.ok(secondMs < 10000, `a second relink took ${secondMs} ms`);
    ctx.diagnostic(`relink: 1,000 x 55,000 in ${firstMs} ms, again in ${secondMs} ms`);
});
