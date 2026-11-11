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
let probe = null; // #273 C-3: samples isSyncingAny() from inside a running sync
const provider = http.createServer((req, res) => {
    if (probe) probe.push(['feed', sync.isSyncingAny?.()]);
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

test('a guide import that fails after its swap is not remembered: the next scheduled sync finishes it (Codex round 1, high)', async () => {
    feeds.xml = guide(102);
    const conn = d();
    const prepare = conn.prepare;
    conn.prepare = function (sql) {
        if (/INSERT INTO playlist_items/.test(sql) && /epg_channel|stream_icon, \s*stream_url, category_id, data/.test(sql)) {
            conn.prepare = prepare;
            throw new Error('disk I/O error (test)');
        }
        return prepare.call(this, sql);
    };
    const g = gen();
    try { await sync.syncAll({ ifChanged: true }); } finally { conn.prepare = prepare; }
    assert.equal(gen(), g + 1, 'the programmes were swapped in before the channel write failed');
    assert.equal(status('epg').status, 'error');
    lines = [];
    await sync.syncAll({ ifChanged: true }); // the same bytes
    assert.ok(!lines.some(l => /Guide unchanged/.test(l)), 'not skipped: the last import never finished');
    assert.equal(gen(), g + 2);
    assert.equal(status('epg').status, 'success');
});

/** Make the next statement whose SQL matches `pattern` throw, once. */
function failOnce(pattern) {
    const conn = d();
    const prepare = conn.prepare;
    conn.prepare = function (sql) {
        if (pattern.test(sql)) { conn.prepare = prepare; throw new Error('disk I/O error (test)'); }
        return prepare.call(this, sql);
    };
    return () => { conn.prepare = prepare; };
}

test('A, a failed B, then A again: the scheduled sync writes A again, for the guide and the playlist (Codex round 2, high)', async () => {
    const guideA = guide(104), listA = playlist(210);
    feeds.xml = guideA; feeds.m3u = listA;
    await sync.syncAll({ ifChanged: true }); // A is the last good one for both
    const liveChannels = () => d().prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(primary.id).n;

    // the guide: B swaps in, then its channel write fails; then A comes back
    feeds.xml = guide(105);
    let restore = failOnce(/INSERT INTO playlist_items/); // the playlist is unchanged, so this is the guide's channel write
    try { await sync.syncSource(primary.id, { ifChanged: true }); } finally { restore(); }
    assert.equal(programmes(), 4200, 'B\'s programmes went live before the failure');
    feeds.xml = guideA;
    lines = [];
    await sync.syncAll({ ifChanged: true });
    assert.ok(!lines.some(l => /Guide unchanged/.test(l)), 'A is not taken for what the rows hold');
    assert.equal(programmes(), 4160, 'A\'s guide is live again');

    // the playlist: B writes its channels, then its groups fail; then A comes back
    feeds.m3u = playlist(220);
    restore = failOnce(/INSERT INTO categories/);
    try { await sync.syncSource(primary.id, { ifChanged: true }); } finally { restore(); }
    assert.equal(liveChannels(), 220, 'B\'s channels were written before the failure');
    feeds.m3u = listA;
    lines = [];
    await sync.syncAll({ ifChanged: true });
    assert.ok(!lines.some(l => /Playlist .* unchanged/.test(l)), 'A is not taken for what the rows hold');
    assert.equal(liveChannels(), 210, 'A\'s playlist is back');
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

test('#273 C-3: isSyncingAny is true from the start of a global sync to the end of its relink, and false after, even after a failure', async () => {
    assert.equal(sync.isSyncingAny?.(), false, 'idle before');
    const links = load('services/channelLinks');
    const relinkAll = links.relinkAll;
    probe = [];
    links.relinkAll = async (...a) => { probe.push(['relink', sync.isSyncingAny?.()]); return relinkAll.apply(links, a); };
    feeds.m3u = playlist(202); // changed, so the deferred relink runs
    try {
        await sync.syncAll({ ifChanged: true });
    } finally { links.relinkAll = relinkAll; }
    const seen = probe; probe = null;
    assert.ok(seen.some(([k]) => k === 'feed') && seen.some(([k]) => k === 'relink'), JSON.stringify(seen));
    assert.ok(seen.every(([, v]) => v === true), 'busy at every sample: ' + JSON.stringify(seen));
    assert.equal(sync.isSyncingAny?.(), false, 'idle after');

    const syncSource = sync.syncSource;
    sync.syncSource = async () => { throw new Error('boom (test)'); };
    const err = console.error; console.error = () => {};
    try { await sync.syncAll({ ifChanged: true }); } finally { sync.syncSource = syncSource; console.error = err; }
    assert.equal(sync.isSyncingAny?.(), false, 'idle after a failed run');
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
