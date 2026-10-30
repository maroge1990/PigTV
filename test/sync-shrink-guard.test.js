const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #42 (0348): a provider answering 200 with a much smaller playlist or guide (maintenance, an expired-account
// placeholder) no longer replaces the full one. The real sync in a sandbox against a local provider. On 0347 the
// playlist lost every channel past the short list and the guide was swapped for the short one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-shrink-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const playlist = (n) => ['#EXTM3U', ...Array.from({ length: n }, (_, i) =>
    [`#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${i % 5}",Channel ${i}`, `http://p.invalid/live/u/p/${1000 + i}.ts`]).flat()].join('\n');
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
/** `per` programmes on each of 40 channels, back to back, `minutes` each from an hour ago. */
const guide = (per, minutes = 30) => {
    const step = minutes * 60e3;
    const start = Date.now() - 3600e3;
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
    for (let c = 0; c < 40; c++) out.push(`<channel id="ch${c}"><display-name>Channel ${c}</display-name></channel>`);
    for (let c = 0; c < 40; c++) for (let i = 0; i < per; i++) {
        out.push(`<programme start="${fmt(start + i * step)}" stop="${fmt(start + (i + 1) * step)}" channel="ch${c}"><title>Show ${i}</title></programme>`);
    }
    out.push('</tv>');
    return out.join('\n');
};
let M3U = playlist(200);
let XML = guide(100); // 4,000 programmes reaching ~49 h ahead
const provider = http.createServer((req, res) => {
    if (req.url.startsWith('/xmltv')) { res.setHeader('content-type', 'application/xml'); return res.end(XML); }
    res.setHeader('content-type', 'audio/x-mpegurl'); res.end(M3U);
});
let source;
const realLog = console.log, realWarn = console.warn;

before(async () => {
    console.log = () => {}; console.warn = () => {};
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const base = `http://127.0.0.1:${provider.address().port}`;
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `${base}/get.php?username=u&password=p`, epgUrl: `${base}/xmltv.php` });
});
after(async () => {
    console.log = realLog; console.warn = realWarn;
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const d = () => sqlite.getDb();
const channels = () => d().prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(source.id).n;
const programmes = () => d().prepare(`SELECT COUNT(*) AS n FROM epg_programs p JOIN epg_state s ON s.source_id = p.source_id AND s.active_gen = p.gen
    WHERE p.source_id = ?`).get(source.id).n;
const status = (type) => d().prepare('SELECT status, error FROM sync_status WHERE source_id = ? AND type = ?').get(source.id, type);

test('a playlist 90% smaller is held: the 200 channels stay, and Status says why', async () => {
    await sync.syncSource(source.id);
    assert.equal(channels(), 200);
    assert.equal(programmes(), 4000);
    M3U = playlist(20);
    await sync.syncSource(source.id);
    assert.equal(channels(), 200, 'the last good list is kept');
    assert.equal(status('all').status, 'held');
    assert.match(status('all').error, /^Held: the provider's list had 20 of the usual 200 channels/);
    assert.equal(programmes(), 4000, 'the guide still synced, unchanged');
});

test('the usual size back: the sync applies as normal', async () => {
    M3U = playlist(190); // a 5% drop is an ordinary change
    await sync.syncSource(source.id);
    assert.equal(channels(), 190);
    assert.equal(status('all').status, 'success');
});

test('the admin accepts the smaller list', async () => {
    M3U = playlist(20);
    await sync.syncSource(source.id, { acceptSmaller: true });
    assert.equal(channels(), 20);
    assert.equal(status('all').status, 'success');
    // ... which is now the baseline: 20 again is no shrink.
    await sync.syncSource(source.id);
    assert.equal(status('all').status, 'success');
});

test('a guide with far fewer programmes, or reaching far less ahead, is held; accepted on request', async () => {
    XML = guide(20); // 800 programmes, ~9 h ahead
    await sync.syncSource(source.id);
    assert.equal(programmes(), 4000, 'the last good guide is kept');
    assert.equal(status('epg').status, 'held');
    assert.match(status('epg').error, /^Held: the guide had 800 programmes against 4,000 last time/);
    // The same 4,000 programmes squeezed into ~7 h instead of ~49 h: held by how far ahead it reaches.
    XML = guide(100, 5);
    await sync.syncSource(source.id);
    assert.equal(status('epg').status, 'held');
    assert.match(status('epg').error, /^Held: the guide reached \d+ h ahead against \d+ h/);
    XML = guide(100);
    await sync.syncSource(source.id);
    assert.equal(status('epg').status, 'success', 'the usual guide applies');
    XML = guide(20);
    await sync.syncSource(source.id, { acceptSmaller: true });
    assert.equal(programmes(), 800);
    assert.equal(status('epg').status, 'success');
});

test('a source synced for the first time has no baseline: nothing is held', async () => {
    const fresh = await db.sources.create({ type: 'm3u', name: 'New', url: `http://127.0.0.1:${provider.address().port}/new.m3u` });
    M3U = playlist(5);
    await sync.syncSource(fresh.id);
    assert.equal(d().prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ?`).get(fresh.id).n, 5);
});
