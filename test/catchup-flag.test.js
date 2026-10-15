const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plan B1 (0216): whether a provider offers catch-up is kept from the raw list the sync already
// fetches (Xtream tv_archive / tv_archive_duration), and summarised for the Status page. On 0215
// the flag was dropped: provider_raw_channels had no column for it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-catchup-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const raw = load('services/rawChannels');

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('tv_archive becomes archive days (1 when no duration, 0 when off) and is stored', () => {
    assert.deepEqual([
        raw.archiveDaysOf({ tv_archive: 1, tv_archive_duration: '7' }),
        raw.archiveDaysOf({ tv_archive: '1' }),
        raw.archiveDaysOf({ tv_archive: 0, tv_archive_duration: 7 }),
        raw.archiveDaysOf({})
    ], [7, 1, 0, 0]);

    const rows = raw.toRows([{ category_id: '1', category_name: 'Sport' }], [
        { stream_id: 501, name: 'Fox Cricket', category_id: '1', tv_archive: 1, tv_archive_duration: 3 },
        { stream_id: 502, name: 'Fox Footy', category_id: '1', tv_archive: 0 },
        { stream_id: 503, name: 'Kayo 1', category_id: '1', tv_archive: 1, tv_archive_duration: 7 }
    ]);
    raw.replaceAll(9, rows);
    const [summary] = raw.archiveSummary();
    assert.deepEqual([summary.sourceId, summary.streams, summary.withArchive, summary.maxDays], [9, 3, 2, 7]);
});

test('the Status route reports it by provider name', () => {
    const src = fs.readFileSync(path.join(sandbox, 'server/routes/status.js'), 'utf8');
    assert.match(src, /catchup:[\s\S]{0,200}archiveSummary\(\)/);
});
