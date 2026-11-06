const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #237: a scheduled sync rewrote the whole guide (495,000 programmes on production) and relinked once per source every
// run, though the feeds rarely change, and logged ~1,050 lines a day. The real sync in a sandbox against a local
// provider that serves the same playlist and guide twice, with and without an ETag.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-unchanged-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
delete process.env.PIGTV_DEBUG_SYNC;
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const playlist = (n, host = 'p') => ['#EXTM3U', ...Array.from({ length: n }, (_, i) =>
    [`#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${i % 5}",Channel ${i}`, `http://${host}.invalid/live/u/p/${1000 + i}.ts`]).flat()].join('\n');
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const start = Math.floor(Date.now() / 3600e3) * 3600e3 - 3600e3;
const guide = (per) => {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
    for (let c = 0; c < 40; c++) out.push(`<channel id="ch${c}"><display-name>Channel ${c}</display-name></channel>`);
    for (let c = 0; c < 40; c++) for (let i = 0; i < per; i++) {
        out.push(`<programme start="${fmt(start + i * 1800e3)}" stop="${fmt(start + (i + 1) * 1800e3)}" channel="ch${c}"><title>Show ${i}</title></programme>`);
    }
    out.push('</tv>');
    return out.join('\n');
};
const feeds = { m3u: playlist(200), xml: guide(100), backup: playlist(150, 'b'), etag: null };
const hits = { m3u: 0, xml: 0, notModified: 0 };
const provider = http.createServer((req, res) => {
    const isGuide = req.url.startsWith('/xmltv');
    const isBackup = req.url.startsWith('/backup');
    if (isGuide) hits.xml++;
    else if (req.url.startsWith('/get.php')) hits.m3u++; // not the account check (player_api.php) after a sync
    const body = isGuide ? feeds.xml : isBackup ? feeds.backup : feeds.m3u;
    if (feeds.etag && !isBackup) {
        const tag = `"${isGuide ? 'g' : 'p'}-${body.length}"`;
        res.setHeader('etag', tag);
        if (req.headers['if-none-match'] === tag) { hits.notModified++; res.statusCode = 304; return res.end(); }
    }
    res.setHeader('content-type', isGuide ? 'application/xml' : 'audio/x-mpegurl');
    res.end(body);
});
let primary;
let base;
const realLog = console.log, realWarn = console.warn;
let lines = [];

before(async () => {
    console.log = (...a) => { lines.push(a.join(' ')); }; console.warn = () => {};
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;
    primary = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `${base}/get.php?username=u&password=p`, epgUrl: `${base}/xmltv.php` });
});
after(async () => {
    console.log = realLog; console.warn = realWarn;
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const d = () => sqlite.getDb();
const gen = () => d().prepare('SELECT active_gen AS g FROM epg_state WHERE source_id = ?').get(primary.id)?.g;
const programmes = () => d().prepare(`SELECT COUNT(*) AS n FROM epg_live WHERE source_id = ?`).get(primary.id).n;
const channelRowids = () => d().prepare(`SELECT group_concat(rowid) AS r FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(primary.id).r;
const status = (type) => d().prepare('SELECT status, last_sync FROM sync_status WHERE source_id = ? AND type = ?').get(primary.id, type);
const libraryRev = () => d().prepare(`SELECT value FROM meta WHERE key = 'library_rev'`).get()?.value;

test('the same guide and playlist again on a scheduled sync: one fetch each, nothing rewritten', async () => {
    await sync.syncSource(primary.id); // the first sync writes everything
    const before = { gen: gen(), rows: channelRowids(), rev: libraryRev(), epg: status('epg').last_sync };
    assert.equal(programmes(), 4000);
    hits.m3u = hits.xml = 0; lines = [];
    await new Promise(r => setTimeout(r, 5));
    await sync.syncAll({ ifChanged: true });
    assert.deepEqual([hits.m3u, hits.xml], [1, 1], 'each feed fetched once');
    assert.equal(gen(), before.gen, 'the guide was not written as a new generation');
    assert.equal(programmes(), 4000);
    assert.equal(channelRowids(), before.rows, 'no channel row was rewritten');
    assert.equal(libraryRev(), before.rev, 'clients are not told the library moved');
    assert.equal(status('epg').status, 'success');
    assert.ok(status('epg').last_sync > before.epg, 'the sync row still says when it last checked');
    assert.equal(lines.filter(l => /unchanged/.test(l)).length, 2, lines.join('\n'));
    assert.ok(!lines.some(l => /Saved \d+ programmes|Removed \d+ superseded/.test(l)), lines.join('\n'));
});

test('a changed guide is written; "Sync now" always writes', async () => {
    const g = gen();
    feeds.xml = guide(101);
    await sync.syncAll({ ifChanged: true });
    assert.equal(gen(), g + 1, 'new bytes: a new generation');
    assert.equal(programmes(), 4040);
    await sync.syncSource(primary.id); // "Sync now": same bytes, full sync anyway
    assert.equal(gen(), g + 2);
});

test('with an ETag the second scheduled sync is a 304: nothing downloaded, nothing written', async () => {
    feeds.etag = true;
    await sync.syncSource(primary.id); // stores the ETags
    const g = gen();
    hits.notModified = 0; lines = [];
    await sync.syncAll({ ifChanged: true });
    assert.equal(hits.notModified, 2, 'both feeds asked with If-None-Match and answered 304');
    assert.equal(gen(), g);
    assert.equal(lines.filter(l => /not modified/.test(l)).length, 2, lines.join('\n'));
    feeds.etag = null;
});

test('a guide whose rows are gone is fetched in full, whatever its fingerprint says', async () => {
    const g = gen();
    d().prepare('DELETE FROM epg_programs WHERE source_id = ?').run(primary.id);
    await sync.syncAll({ ifChanged: true });
    assert.equal(gen(), g + 1);
    assert.equal(programmes(), 4040);
});

test('a global sync with two backups relinks once, after the last source', async () => {
    await db.sources.create({ type: 'm3u', name: 'Backup A', role: 'backup', url: `${base}/backup/a.m3u` });
    await db.sources.create({ type: 'm3u', name: 'Backup B', role: 'backup', url: `${base}/backup/b.m3u` });
    feeds.m3u = playlist(201); // the primary changed too, so it would relink on its own
    lines = [];
    await sync.syncAll({ ifChanged: true });
    const relinks = lines.filter(l => l.startsWith('[Links] Relinked'));
    assert.equal(relinks.length, 1, lines.join('\n'));
    assert.ok(lines.lastIndexOf(relinks[0]) > lines.findIndex(l => /Backup B: \d+ channels/.test(l)), 'after the last backup');
});

test('no heap readings or "so far" lines without PIGTV_DEBUG_SYNC', async () => {
    feeds.xml = guide(120); feeds.m3u = playlist(5000);
    lines = [];
    await sync.syncSource(primary.id);
    assert.ok(!lines.some(l => /\[Sync\] Memory:|so far\.\.\./.test(l)), lines.filter(l => /Memory|so far/.test(l)).join('\n'));
    process.env.PIGTV_DEBUG_SYNC = '1';
    lines = [];
    try { await sync.syncSource(primary.id); } finally { delete process.env.PIGTV_DEBUG_SYNC; }
    assert.ok(lines.some(l => /\[Sync\] Memory:/.test(l)));
});
