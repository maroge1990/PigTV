const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0111 (roadmap S1.3): the guide used to JSON.parse `data` for every row on
// every page just to find its tvg-id. tvg_id is now its own indexed column,
// filled at ingest. (The start-up backfill for rows older than the column went
// with D-57: every database still opened has had it.)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-tvgid-col-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const sync = require(path.join(sandbox, 'server/services/syncService'));

after(() => {
    process.chdir(os.tmpdir());
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('an M3U sync fills tvg_id at ingest', async () => {
    const source = await require(path.join(sandbox, 'server/db')).sources.create({
        type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u'
    });
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="ch9" group-title="All",Nine\nhttps://provider.invalid/9.ts\n';
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(m3u);
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    const row = sqlite.getDb().prepare(
        "SELECT tvg_id FROM playlist_items WHERE source_id = ? AND name = 'Nine'"
    ).get(source.id);
    assert.equal(row.tvg_id, 'ch9', 'tvg_id must be set by the sync itself, without needing a restart');
});

test('an Xtream sync fills tvg_id at ingest from epg_channel_id', async () => {
    await sync.saveStreams(8, 'live', [{ stream_id: 501, name: 'Five', category_id: '1', epg_channel_id: 'five.uk' }], { skipPurge: true });
    assert.equal(sqlite.getDb().prepare(`SELECT tvg_id FROM playlist_items WHERE id = '8:501'`).get().tvg_id, 'five.uk');
});
