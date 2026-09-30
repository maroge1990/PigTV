const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// 0170 (multi-provider P2): a backup provider syncs into backup_channels only. The "providers" are
// local fake HTTP servers; the Trex fixtures shape the Xtream list and the EPGenius overlay.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-backup-sync-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const { currentGuideVersion } = load('services/libraryRev');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers/trex-xtream-raw.json'), 'utf8'));
const EPGENIUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers/trex-epgenius.json'), 'utf8'));
const RAW_IDS = new Set(RAW.streams.map(s => s.stream_id));
const OVERLAY_ENTRIES = EPGENIUS.filter(e => RAW_IDS.has(Number(e.streamId))).slice(0, 40);

let fake, fakeUrl, app, server, base, adminToken, viewerToken, hits, mode;
const m3u = entries => '#EXTM3U\n' + entries.map(e =>
    `#EXTINF:-1 tvg-id="${e.tvgId ?? ''}" tvg-logo="" group-title="${e.group}",${e.name}\n${e.url}\n`).join('');
const liveUrl = id => `${fakeUrl}/live/bkuser/bkpass/${id}.ts`;
const overlayM3u = () => m3u(OVERLAY_ENTRIES.map(e => ({ ...e, url: liveUrl(e.streamId) })));

before(async () => {
    fake = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        hits.push(u.pathname + (u.searchParams.get('action') ? '?' + u.searchParams.get('action') : ''));
        const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
        if (mode.fail) { res.statusCode = 502; return res.end('bad gateway'); }
        if (u.pathname === '/player_api.php') {
            const a = u.searchParams.get('action');
            if (a === 'get_live_categories') return json(mode.cats || RAW.categories);
            if (a === 'get_live_streams') return json(mode.streams || RAW.streams);
            if (!a) return json({ user_info: { auth: 1, status: 'Active', max_connections: '1' }, server_info: {} });
            return json([]);
        }
        if (u.pathname === '/overlay.m3u') {
            if (mode.overlayFail) { res.statusCode = 500; return res.end('no'); }
            return res.end(overlayM3u());
        }
        if (u.pathname === '/list.m3u') return res.end(mode.m3u);
        res.statusCode = 404; res.end('');
    }).listen(0, '127.0.0.1');
    await once(fake, 'listening');
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;

    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(viewer);
    app = express();
    app.use(express.json());
    app.use('/api/sources', load('routes/sources'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    fake?.closeAllConnections?.(); fake?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

beforeEach(() => { hits = []; mode = {}; });

const count = (table, id) => sqlite.getDb().prepare(`SELECT COUNT(*) c FROM ${table} WHERE source_id = ?`).get(id).c;
const rows = id => sqlite.getDb().prepare('SELECT * FROM backup_channels WHERE source_id = ? ORDER BY stream_id').all(id);
const xtream = (fields = {}) => db.sources.create({ type: 'xtream', name: 'Trex', url: fakeUrl, username: 'bkuser', password: 'bkpass', ...fields });
const m3uSource = (fields = {}) => db.sources.create({ type: 'm3u', name: 'Plain', url: `${fakeUrl}/list.m3u`, ...fields });
async function get(route, token = adminToken) {
    const r = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body, text };
}
async function silently(fn) {
    const log = console.log, warn = console.warn, err = console.error;
    const seen = [];
    console.log = console.warn = console.error = (...a) => seen.push(a.join(' '));
    try { await fn(); } finally { console.log = log; console.warn = warn; console.error = err; }
    return seen;
}

test('an Xtream backup writes backup_channels and nothing the library reads', async () => {
    const s = await xtream({ role: 'backup', priority: 1 });
    const rev = currentGuideVersion();
    await silently(() => sync.syncSource(s.id));

    assert.equal(count('backup_channels', s.id), RAW.streams.length);
    assert.equal(count('playlist_items', s.id), 0);
    assert.equal(count('categories', s.id), 0);
    assert.equal(count('channel_numbers', s.id), 0);
    assert.equal(currentGuideVersion(), rev, 'the guide version does not move for a backup');
    assert.deepEqual([...new Set(hits.filter(h => h.startsWith('/player_api.php?') || h.includes('xmltv')))].sort(),
        ['/player_api.php?get_live_categories', '/player_api.php?get_live_streams'], 'no VOD, series or XMLTV');
    const one = RAW.streams.find(x => x.stream_id === 83453);
    const row = rows(s.id).find(r => r.stream_id === '83453');
    assert.equal(row.name, one.name);
    assert.equal(row.category_name, 'UK| SPORTS');
    assert.equal(row.tvg_id, 'SkySportsF1.uk');
    assert.equal(row.url_data, null, 'an Xtream backup stores no URL');
    assert.equal(row.region, null); assert.equal(row.quality, null); assert.equal(row.is_event, null);
    const status = sqlite.getDb().prepare('SELECT status FROM sync_status WHERE source_id = ?').get(s.id);
    assert.equal(status.status, 'success');
});

test('an M3U backup keeps the stream URL and the numeric stream id, with a hash for the rest', async () => {
    mode.m3u = m3u([
        { name: 'UK| SKY SPORTS F1 HD', tvgId: '', group: 'UK| SPORTS', url: liveUrl(83453) },
        { name: 'Odd feed', tvgId: 'odd.id', group: 'Misc', url: `${fakeUrl}/stream/odd.m3u8?username=u&password=p` },
    ]);
    const s = await m3uSource({ role: 'backup' });
    await silently(() => sync.syncSource(s.id));
    const r = rows(s.id);
    assert.equal(r.length, 2);
    const f1 = r.find(x => x.stream_id === '83453');
    assert.equal(f1.url_data, liveUrl(83453));
    assert.equal(f1.tvg_id, null, 'a name-derived tvg-id is not a real one');
    assert.equal(f1.category_name, 'UK| SPORTS');
    const odd = r.find(x => x.stream_id !== '83453');
    assert.match(odd.stream_id, /^u[0-9a-f]{16}$/);
    assert.equal(odd.tvg_id, 'odd.id');
    assert.equal(count('playlist_items', s.id), 0);
    assert.equal(count('categories', s.id), 0);
});

test('the overlay copies EPGenius tvg-ids onto the raw list by stream id', async () => {
    const s = await xtream({ role: 'backup', idOverlayUrl: `${fakeUrl}/overlay.m3u` });
    await silently(() => sync.syncSource(s.id));
    const all = rows(s.id);
    const withOverlay = all.filter(r => r.overlay_tvg_id);
    assert.equal(withOverlay.length, OVERLAY_ENTRIES.filter(e => e.tvgId).length);
    for (const e of OVERLAY_ENTRIES) {
        if (!e.tvgId) continue;
        assert.equal(all.find(r => r.stream_id === String(e.streamId)).overlay_tvg_id, e.tvgId);
    }
    assert.equal(all.filter(r => !r.overlay_tvg_id).length, RAW.streams.length - withOverlay.length, 'others have none');
});

test('an overlay that fails is not fatal, keeps the earlier ids and never logs the URL', async () => {
    const s = await xtream({ role: 'backup', idOverlayUrl: `${fakeUrl}/overlay.m3u?token=SECRETTOKEN` });
    await silently(() => sync.syncSource(s.id));
    const before = rows(s.id).filter(r => r.overlay_tvg_id).map(r => [r.stream_id, r.overlay_tvg_id]);
    assert.ok(before.length > 0);

    mode.overlayFail = true;
    const logs = await silently(() => sync.syncSource(s.id));
    const after = rows(s.id).filter(r => r.overlay_tvg_id).map(r => [r.stream_id, r.overlay_tvg_id]);
    assert.deepEqual(after, before);
    assert.equal(sqlite.getDb().prepare('SELECT status FROM sync_status WHERE source_id = ?').get(s.id).status, 'success');
    assert.ok(logs.some(l => /Overlay/.test(l)), 'the failure is logged');
    assert.ok(!logs.join('\n').includes('SECRETTOKEN'), 'without the URL');
});

test('a failed fetch leaves the previous rows untouched', async () => {
    const s = await xtream({ role: 'backup' });
    await silently(() => sync.syncSource(s.id));
    const before = rows(s.id);
    assert.equal(before.length, RAW.streams.length);

    mode.fail = true;
    await silently(() => sync.syncSource(s.id));
    assert.deepEqual(rows(s.id), before);
    assert.equal(sqlite.getDb().prepare('SELECT status FROM sync_status WHERE source_id = ?').get(s.id).status, 'error');

    mode = { streams: [] }; // a provider that lists nothing is a failed fetch too
    await silently(() => sync.syncSource(s.id));
    assert.deepEqual(rows(s.id), before);
});

test('a source that switches from primary to backup loses its library rows, and back', async () => {
    const s = await xtream({ role: 'primary' });
    await silently(() => sync.syncSource(s.id));
    assert.equal(count('playlist_items', s.id), RAW.streams.length);
    assert.ok(count('categories', s.id) > 0);
    assert.equal(count('backup_channels', s.id), 0);

    await db.sources.update(s.id, { role: 'backup' });
    await silently(() => sync.syncSource(s.id));
    assert.equal(count('playlist_items', s.id), 0);
    assert.equal(count('categories', s.id), 0);
    assert.equal(count('backup_channels', s.id), RAW.streams.length);

    await db.sources.update(s.id, { role: 'primary' });
    await silently(() => sync.syncSource(s.id));
    assert.equal(count('backup_channels', s.id), 0);
    assert.equal(count('playlist_items', s.id), RAW.streams.length);
});

test('with a backup present the primary, the library and the numbers are as without it', async () => {
    const primary = await xtream({ name: 'Main' });
    await silently(() => sync.syncSource(primary.id));
    const snapshot = () => ({
        items: sqlite.getDb().prepare('SELECT id, name FROM playlist_items ORDER BY id').all(),
        cats: sqlite.getDb().prepare('SELECT id FROM categories ORDER BY id').all(),
        numbers: sqlite.getDb().prepare('SELECT source_id, number FROM channel_numbers ORDER BY source_id, number').all(),
        primaryRows: count('playlist_items', primary.id)
    });
    const alone = snapshot();
    const rev = currentGuideVersion();

    const backup = await xtream({ name: 'Backup', role: 'backup' });
    await silently(() => sync.syncSource(backup.id));
    assert.deepEqual(snapshot(), alone);
    assert.equal(currentGuideVersion(), rev);
    assert.equal(count('backup_channels', primary.id), 0, 'no backup rows for the primary');

    await silently(() => sync.syncAll());
    assert.deepEqual(snapshot(), alone);
    assert.equal(count('backup_channels', backup.id), RAW.streams.length, 'Sync all still syncs the backup');
    await db.sources.delete(backup.id);
});

test('with no backup configured a primary syncs exactly as before', async () => {
    const before = count('backup_channels', 999);
    const s = await xtream({ name: 'Only' });
    await silently(() => sync.syncSource(s.id));
    assert.equal(count('playlist_items', s.id), RAW.streams.length);
    assert.equal(count('backup_channels', s.id), 0);
    assert.equal(before, 0);
    assert.ok(hits.includes('/player_api.php?get_vod_streams'), 'the VOD and series calls still happen');
    assert.ok(hits.some(h => h.startsWith('/xmltv.php')), 'and the guide');
    await db.sources.delete(s.id);
});

test('the admin search returns at most 200 rows and never url_data', async () => {
    const many = [];
    for (let i = 1; i <= 260; i++) many.push({ name: `Sky Channel ${i}`, tvgId: `sky${i}.uk`, group: 'UK| SPORTS', url: liveUrl(5000 + i) });
    mode.m3u = m3u(many);
    const s = await m3uSource({ name: 'Big', role: 'backup' });
    await silently(() => sync.syncSource(s.id));

    let r = await get(`/api/sources/${s.id}/backup-channels?limit=1000`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 200);
    assert.deepEqual(Object.keys(r.body[0]).sort(), ['category_name', 'name', 'overlay_tvg_id', 'stream_id', 'tvg_id']);
    assert.ok(!r.text.includes('bkpass') && !r.text.includes('url_data') && !r.text.includes('/live/'));

    r = await get(`/api/sources/${s.id}/backup-channels?search=channel 25&limit=5`);
    assert.equal(r.body.length, 5);
    assert.ok(r.body.every(x => /channel 25/i.test(x.name)));
    r = await get(`/api/sources/${s.id}/backup-channels?search=sky7.uk`);
    assert.deepEqual(r.body.map(x => x.tvg_id), ['sky7.uk']);
    r = await get(`/api/sources/${s.id}/backup-channels?search=%25`);
    assert.equal(r.body.length, 0, 'a % is a literal');

    assert.equal((await get(`/api/sources/${s.id}/backup-channels`, viewerToken)).status, 403);
    assert.equal((await get('/api/sources/99999/backup-channels')).status, 404);

    const list = await get('/api/sources/providers');
    assert.equal(list.body.find(x => x.id === s.id).backupChannels, 260);
});

test('the relink hook runs after a backup sync, and a missing hook is a no-op', async () => {
    const s = await xtream({ name: 'Hooked', role: 'backup' });
    await silently(() => sync.syncSource(s.id)); // no channelLinks module needed
    assert.equal(count('backup_channels', s.id), RAW.streams.length);

    const file = path.join(sandbox, 'server/services/channelLinks.js');
    const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, 'const seen = []; module.exports = { seen, relinkSource(id) { seen.push(id); } };');
    try {
        await silently(() => sync.syncSource(s.id));
        assert.deepEqual(load('services/channelLinks').seen, [s.id]);
    } finally {
        delete require.cache[file];
        if (original) fs.writeFileSync(file, original); else fs.rmSync(file);
    }
});
