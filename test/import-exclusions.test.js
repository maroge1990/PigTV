const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// R8 (Plan B, pilot, 0217): live groups a sync never imports. The real M3U sync in a sandbox
// against a local playlist. On 0216 every group was imported whatever the setting.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-import-excl-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const filters = load('services/importFilters');

const M3U = ['#EXTM3U',
    '#EXTINF:-1 tvg-id="bbc.uk" group-title="News",BBC News', 'http://p.invalid/live/u/p/101.ts',
    '#EXTINF:-1 tvg-id="x1" group-title="Adult",Adult 1', 'http://p.invalid/live/u/p/201.ts',
    '#EXTINF:-1 tvg-id="x2" group-title="Adult",Adult 2', 'http://p.invalid/live/u/p/202.ts',
    '#EXTINF:-1 tvg-id="fox.au" group-title="Sport",Fox Cricket', 'http://p.invalid/live/u/p/501.ts',
    '#EXTINF:-1 tvg-id="v1" group-title="VOD in live",Film 1', 'http://p.invalid/live/u/p/901.ts'
].join('\n');
const playlist = http.createServer((req, res) => { res.setHeader('content-type', 'audio/x-mpegurl'); res.end(M3U); });
let source;
const realLog = console.log;

before(async () => {
    console.log = () => {};
    playlist.listen(0, '127.0.0.1'); await once(playlist, 'listening');
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `http://127.0.0.1:${playlist.address().port}/get.php?username=u&password=p` });
});
after(async () => {
    console.log = realLog;
    playlist.closeAllConnections(); await new Promise(r => playlist.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const rows = () => sqlite.getDb().prepare(`SELECT item_id, name, category_id FROM playlist_items WHERE source_id = ? AND type = 'live' ORDER BY sort_order`).all(source.id);
const idOf = (name) => rows().find(r => r.name === name)?.item_id;

test('excluded groups are skipped at the next sync; every other channel keeps its id; it is reversible', async () => {
    await sync.syncM3u(source);
    assert.equal(rows().length, 5);
    const before = { bbc: idOf('BBC News'), fox: idOf('Fox Cricket'), film: idOf('Film 1') };

    assert.deepEqual(await filters.setExcluded(source.id, ['Adult', 'VOD in live']), { ok: true });
    await sync.syncM3u(source);
    assert.deepEqual(rows().map(r => r.name), ['BBC News', 'Fox Cricket']);
    assert.equal(idOf('Fox Cricket'), before.fox, 'positions are counted over skipped lines too');
    assert.equal(idOf('BBC News'), before.bbc);

    const overview = await filters.overview(source.id);
    const adult = overview.find(g => g.id === 'Adult');
    assert.deepEqual([adult.excluded, adult.imported, adult.skippedAtLastSync], [true, 0, 2], 'still listed, so it can be undone');

    assert.deepEqual(await filters.setExcluded(source.id, []), { ok: true });
    await sync.syncM3u(source);
    assert.equal(rows().length, 5);
    assert.equal(idOf('Film 1'), before.film, 'back with the same id');
});

test('a group with a favourite or a scheduled recording cannot be excluded', async () => {
    const d = sqlite.getDb();
    const fox = rows().find(r => r.name === 'Fox Cricket');
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type) VALUES (1, ?, ?, 'channel')`).run(source.id, fox.item_id);
    const r = await filters.setExcluded(source.id, ['Sport']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.blocked.map(b => b.id), ['Sport']);
    assert.match(r.blocked[0].reason, /favourite/);
    assert.deepEqual([...await filters.excludedFor(source.id)], [], 'nothing saved');
});

test('the generic settings write cannot set the list (only the guarded route)', () => {
    const route = fs.readFileSync(path.join(sandbox, 'server/routes/settings.js'), 'utf8');
    assert.match(route, /delete updates\.importExclusions/);
});
