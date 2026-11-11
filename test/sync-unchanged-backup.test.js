const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { sqlCount } = require('./helpers/sqlCount');

// #273 I-7: a scheduled sync skipped an unchanged M3U primary but still rewrote every backup provider's channels,
// refetched its raw rows and forced one full relink (2-3 s) per run; an Xtream primary was never skipped; and the
// shrunken-list hold (#42) protected primaries only. The real sync in a sandbox against local fake providers.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-unchanged-backup-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const streamsOf = (prefix, ids) => ids.map(i => ({ stream_id: i, name: `${prefix} ${i}`, category_id: '1',
    epg_channel_id: `${prefix}${i}.x`, stream_icon: '', tv_archive: 0 }));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// What each fake login lists. `m3uIds`: the channels the M3U backup's playlist carries; `own.bk`: all the provider has.
const state = {
    own: { main: streamsOf('Main', range(1, 100)), xb: streamsOf('Xb', range(1, 100)), bk: streamsOf('Bk', range(1, 100)) },
    m3uIds: range(1, 100)
};
const provider = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    if (u.pathname === '/player_api.php') {
        const list = state.own[u.searchParams.get('username')] || [];
        const a = u.searchParams.get('action');
        if (a === 'get_live_categories') return json([{ category_id: '1', category_name: 'News' }]);
        if (a === 'get_live_streams') return json(list);
        if (!a) return json({ user_info: { auth: 1, status: 'Active', max_connections: '1' }, server_info: {} });
        return json([]);
    }
    if (u.pathname === '/bk.m3u') {
        res.setHeader('content-type', 'audio/x-mpegurl');
        return res.end('#EXTM3U\n' + state.m3uIds.map(i =>
            `#EXTINF:-1 tvg-id="Bk${i}.x" group-title="News",Bk ${i}\nhttp://${req.headers.host}/live/bk/pw/${i}.ts\n`).join(''));
    }
    res.statusCode = 404; res.end('');
});
let main, backupM3u, backupXt, c;
const realLog = console.log, realWarn = console.warn;
let lines = [];

before(async () => {
    console.log = (...a) => { lines.push(a.join(' ')); }; console.warn = (...a) => { lines.push(a.join(' ')); };
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const base = `http://127.0.0.1:${provider.address().port}`;
    main = await db.sources.create({ type: 'xtream', name: 'Main', url: base, username: 'main', password: 'pw' });
    backupM3u = await db.sources.create({ type: 'm3u', name: 'Backup M3U', role: 'backup', url: `${base}/bk.m3u` });
    backupXt = await db.sources.create({ type: 'xtream', name: 'Backup Xt', role: 'backup', url: base, username: 'xb', password: 'pw' });
    c = sqlCount(sqlite.getDb());
});
after(async () => {
    console.log = realLog; console.warn = realWarn;
    c.restore();
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const d = () => sqlite.getDb();
// INSERT only: a primary's sync also runs a no-op DELETE of its (absent) backup rows.
const BACKUP_WRITES = /INSERT OR IGNORE INTO backup_channels/;
// INSERT only: dropLibraryRows runs a no-op DELETE for each backup; the rowids below show no row was replaced.
const MAIN_WRITES = /INSERT INTO (playlist_items|categories)/;
const mainRowids = () => d().prepare(`SELECT group_concat(rowid) AS r FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(main.id).r;
const relinks = () => lines.filter(l => l.startsWith('[Links] Relinked')).length;
const backupRows = (id) => d().prepare('SELECT COUNT(*) AS n FROM backup_channels WHERE source_id = ?').get(id).n;
const status = (id) => d().prepare(`SELECT status, error, last_sync FROM sync_status WHERE source_id = ? AND type = 'all'`).get(id);
const scheduled = () => { lines = []; c.reset(); return sync.syncAll({ retry: true, ifChanged: true }); };
function failOnce(pattern) {
    const conn = d();
    const prepare = conn.prepare;
    conn.prepare = function (sql) {
        if (pattern.test(sql)) { conn.prepare = prepare; throw new Error('disk I/O error (test)'); }
        return prepare.call(this, sql);
    };
    return () => { conn.prepare = prepare; };
}

test('a scheduled sync where nothing changed writes nothing and relinks ZERO times', async () => {
    await sync.syncAll(); // the first sync writes everything (and relinks once)
    assert.equal(backupRows(backupM3u.id), 100);
    assert.equal(backupRows(backupXt.id), 100);
    const before = { m: status(backupM3u.id).last_sync, x: status(backupXt.id).last_sync };
    const rowids = mainRowids();
    await new Promise(r => setTimeout(r, 5));

    await scheduled();
    assert.equal(mainRowids(), rowids, 'no channel row of the primary was replaced');
    assert.equal(c.runs(BACKUP_WRITES), 0, 'no backup_channels write');
    assert.equal(c.runs(MAIN_WRITES), 0, 'the Xtream primary rewrote no channel or category either');
    assert.equal(relinks(), 0, lines.join('\n'));
    assert.equal(lines.filter(l => /Backup .* unchanged/.test(l)).length, 2, lines.join('\n'));
    assert.equal(lines.filter(l => /Playlist for Main unchanged/.test(l)).length, 1, lines.join('\n'));
    for (const [s, was] of [[backupM3u, before.m], [backupXt, before.x]]) {
        assert.equal(status(s.id).status, 'success');
        assert.ok(status(s.id).last_sync > was, 'the sync row still says when it last checked');
    }
});

test('"Sync now" on an unchanged backup always writes', async () => {
    lines = []; c.reset();
    await sync.syncSource(backupXt.id);
    assert.ok(c.runs(BACKUP_WRITES) >= 100, `wrote ${c.runs(BACKUP_WRITES)}`);
    assert.equal(relinks(), 1);
});

test('a backup that changed by one channel is written and relinked; so is a changed Xtream primary', async () => {
    state.own.xb = streamsOf('Xb', range(1, 101));
    state.own.main = streamsOf('Main', range(1, 101));
    await scheduled();
    assert.equal(backupRows(backupXt.id), 101);
    assert.ok(c.runs(/INSERT OR IGNORE INTO backup_channels/) >= 101);
    assert.ok(c.runs(/INSERT INTO playlist_items/) >= 101, 'the Xtream primary wrote its channels');
    assert.equal(d().prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(main.id).n, 101);
    assert.equal(relinks(), 1, lines.join('\n'));
    await scheduled();
    assert.equal(c.runs(MAIN_WRITES) + c.runs(BACKUP_WRITES), 0, 'and now it is the last good one');
    assert.equal(relinks(), 0);
});

test('an unchanged M3U whose provider gains an unlisted channel is not skipped', async () => {
    assert.equal(backupRows(backupM3u.id), 100);
    state.own.bk = streamsOf('Bk', range(1, 101)); // the playlist still lists 1..100; the provider's own list has 101
    await scheduled();
    assert.equal(backupRows(backupM3u.id), 101, lines.join('\n'));
    assert.equal(relinks(), 1);
});

test('a failed backup import is not remembered: the next scheduled sync writes', async () => {
    state.own.xb = streamsOf('Xb', range(1, 102));
    c.reset();
    const restore = failOnce(/INSERT OR IGNORE INTO backup_channels/);
    try { await scheduled(); } finally { restore(); }
    assert.equal(status(backupXt.id).status, 'error');
    assert.equal(backupRows(backupXt.id), 101, 'the previous rows stay');
    await scheduled(); // the same feed again
    assert.equal(backupRows(backupXt.id), 102, 'written, not taken for the last good one');
    assert.equal(status(backupXt.id).status, 'success');
});

test('a backup list that shrinks past the threshold is held; acceptSmaller writes it', async () => {
    state.own.xb = streamsOf('Xb', range(1, 60));
    await scheduled();
    assert.equal(c.runs(BACKUP_WRITES), 0, 'nothing written');
    assert.equal(backupRows(backupXt.id), 102, 'the last good rows stay');
    assert.equal(status(backupXt.id).status, 'held');
    assert.match(status(backupXt.id).error, /^Held: the provider's list had 60 of the usual 102 channels/);
    assert.equal(relinks(), 0, 'nothing relinked');
    lines = []; c.reset();
    await sync.syncSource(backupXt.id, { acceptSmaller: true });
    assert.equal(backupRows(backupXt.id), 60);
    assert.equal(status(backupXt.id).status, 'success');
    assert.equal(relinks(), 1);
    await scheduled(); // 60 is the usual size now
    assert.equal(status(backupXt.id).status, 'success');
    assert.equal(c.runs(BACKUP_WRITES), 0);
});

// I-7 review: the fingerprint is remembered before the relink, and a scheduled sync of unchanged lists relinks nothing.
// A relink that failed (or a restart before a global sync's deferred relink) must still be retried by the next sync:
// a durable "relink owed" marker. The backup lists the primary's own names from here on, so the links can be counted.
const links = load('services/channelLinks');
const importFilters = load('services/importFilters');
const linked = (backupId) => d().prepare(`SELECT COUNT(*) AS n FROM channel_links WHERE backup_source_id = ?
    AND status IN ('auto', 'approved', 'manual')`).get(backupId).n;
const owed = () => d().prepare('SELECT value FROM meta WHERE key = ?').get(sync.RELINK_OWED_KEY ?? 'relink_owed');
function failRelinkOnce(name) {
    const real = links[name];
    links[name] = async () => { links[name] = real; throw new Error('SQLITE_BUSY (test)'); };
    return () => { links[name] = real; };
}

test('I-7: a global relink that failed after the backup changed is retried by the next scheduled sync, once', async () => {
    state.own.xb = streamsOf('Main', range(1, 101)); // the primary's 101 channels, under the same names
    const restore = failRelinkOnce('relinkAll');
    try { await scheduled(); } finally { restore(); }
    assert.equal(backupRows(backupXt.id), 101, 'the backup was written');
    assert.equal(linked(backupXt.id), 0, 'its relink failed: no link yet');
    await scheduled(); // nothing changed since
    assert.equal(relinks(), 1, lines.join('\n'));
    assert.equal(linked(backupXt.id), 101, 'every primary channel has its backup');
    assert.equal(owed(), undefined, 'nothing owed any more');
    await scheduled();
    assert.equal(relinks(), 0, 'paid: the saving of 0561 stays');
});

test('I-7: a single-source scheduled sync of a backup retries its own failed relink', async () => {
    state.own.main = streamsOf('Main', range(1, 102));
    await sync.syncSource(main.id); // the primary gains channel 102 (relinked: the backup has no partner yet)
    state.own.xb = streamsOf('Main', range(1, 102));
    lines = [];
    const restore = failRelinkOnce('relinkSource');
    try { await sync.syncSource(backupXt.id, { ifChanged: true }); } finally { restore(); }
    assert.equal(backupRows(backupXt.id), 102);
    assert.equal(linked(backupXt.id), 101, 'its relink failed: channel 102 has no backup');
    assert.equal(relinks(), 0);
    lines = [];
    await sync.syncSource(backupXt.id, { ifChanged: true }); // unchanged
    assert.ok(lines.some(l => /Backup Backup Xt unchanged/.test(l)), lines.join('\n'));
    assert.equal(relinks(), 1, lines.join('\n'));
    assert.equal(linked(backupXt.id), 102);
    lines = [];
    await sync.syncSource(backupXt.id, { ifChanged: true });
    assert.equal(relinks(), 0);
});

test('I-7: a restart between the backup\'s write and the deferred relink is repaired by the next scheduled sync', async () => {
    state.own.main = streamsOf('Main', range(1, 103));
    await sync.syncSource(main.id);
    state.own.xb = streamsOf('Main', range(1, 103));
    sync.relink = async () => {}; // the server stops before the relink: it neither runs nor pays
    try { await scheduled(); } finally { delete sync.relink; }
    assert.equal(backupRows(backupXt.id), 103);
    assert.equal(linked(backupXt.id), 102);
    await scheduled();
    assert.equal(relinks(), 1, lines.join('\n'));
    assert.equal(linked(backupXt.id), 103);
    await scheduled();
    assert.equal(relinks(), 0);
});

test('I-7: a changed Xtream primary whose relink failed is relinked by the next scheduled sync', async () => {
    state.own.xb = streamsOf('Main', range(1, 104)); // the backup has 104 first
    await sync.syncSource(backupXt.id);
    state.own.main = streamsOf('Main', range(1, 104));
    const restore = failRelinkOnce('relinkAll');
    try { await scheduled(); } finally { restore(); }
    assert.equal(linked(backupXt.id), 103, 'the primary\'s channel 104 is not linked yet');
    await scheduled();
    assert.equal(relinks(), 1, lines.join('\n'));
    assert.equal(linked(backupXt.id), 104);
    await scheduled();
    assert.equal(relinks(), 0);
});

test('I-7: an Xtream sync reads the groups never imported once: the set hashed is the set written', async () => {
    const real = importFilters.excludedFor;
    let calls = 0;
    importFilters.excludedFor = async (...a) => { if (Number(a[0]) === main.id) calls++; return real.apply(importFilters, a); };
    try { await sync.syncSource(main.id); } finally { importFilters.excludedFor = real; }
    assert.equal(calls, 1);
});

test('I-7: a change in how rows are derived (the fingerprint version) rewrites an otherwise unchanged list', async () => {
    await scheduled();
    assert.equal(c.runs(MAIN_WRITES) + c.runs(BACKUP_WRITES), 0, 'unchanged');
    const was = sync.resultFingerprintVersion;
    sync.resultFingerprintVersion = (was ?? 1) + 1;
    try {
        await scheduled();
        assert.ok(c.runs(BACKUP_WRITES) >= 104, `backup wrote ${c.runs(BACKUP_WRITES)}`);
        assert.ok(c.runs(/INSERT INTO playlist_items/) >= 104, 'the Xtream primary wrote its channels');
    } finally { sync.resultFingerprintVersion = was; }
    await scheduled(); // back to the build's version: written once more, then settled
    await scheduled();
    assert.equal(c.runs(MAIN_WRITES) + c.runs(BACKUP_WRITES), 0);
});

test('I-7: a backup that became a primary forgets its size: back as a backup, a smaller list is not held', async () => {
    sync.dropBackupRows(backupXt.id);
    assert.equal(d().prepare('SELECT value FROM meta WHERE key = ?').get(`backup_lines:${backupXt.id}`), undefined);
    state.own.xb = streamsOf('Main', range(1, 60));
    await sync.syncSource(backupXt.id, { ifChanged: true });
    assert.equal(status(backupXt.id).status, 'success', status(backupXt.id).error || '');
    assert.equal(backupRows(backupXt.id), 60);
});

test('I-7: a changed M3U primary whose relink failed is relinked by the next scheduled sync of it', async () => {
    const base = `http://127.0.0.1:${provider.address().port}`;
    const p = await db.sources.create({ type: 'm3u', name: 'Main M3U', url: `${base}/bk.m3u` });
    lines = [];
    const restore = failRelinkOnce('relinkAll');
    try { await sync.syncSource(p.id, { ifChanged: true }); } finally { restore(); }
    assert.ok(owed(), 'a relink is owed');
    lines = [];
    await sync.syncSource(p.id, { ifChanged: true }); // the same bytes
    assert.ok(lines.some(l => /Playlist for Main M3U unchanged/.test(l)), lines.join('\n'));
    assert.equal(relinks(), 1, lines.join('\n'));
    assert.equal(owed(), undefined);
    lines = [];
    await sync.syncSource(p.id, { ifChanged: true });
    assert.equal(relinks(), 0);
});
