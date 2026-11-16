const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #265 step 2 (D-65): a channel's measured quality, from the channel audit's results or a play's probe, newest first.
// One rule makes the label (height >= 2000 "4K", >= 1000 "1080", >= 700 "720", else "SD"; fps a whole number). The old
// code has no channel_measurements table, no services/channelMeasurements.js and no scripts/import-channel-audit.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-measurements-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.mkdirSync(path.join(sandbox, 'scripts'));
fs.copyFileSync(path.join(__dirname, '../scripts/import-channel-audit.js'), path.join(sandbox, 'scripts/import-channel-audit.js'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.PIGTV_DB_BACKUPS = '0';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const m = load('services/channelMeasurements');
const { getDb } = load('db/sqlite');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});
beforeEach(() => getDb().prepare('DELETE FROM channel_measurements').run());

const stored = () => getDb().prepare('SELECT source_id, channel_key, height, fps, kbps, measured_at, source FROM channel_measurements ORDER BY channel_key').all();
const row = (o) => JSON.stringify({ run: 'r1', tier: 4, source_id: 1, item_id: 'pos_1', stable_id: 's1', name: 'Sky Sports F1', is_hidden: 0,
    started: '2026-11-15T20:00:00.000Z', ended: '2026-11-15T20:00:30.000Z', video: { width: 1920, height: 1080, fpsAvg: 50, fpsR: 50 },
    kbps: 7800, blank: false, problems: [], error: null, ...o });

test('the label rule: height decides 4K / 1080 / 720 / SD, fps is rounded to a whole number', () => {
    assert.deepEqual([2160, 2000, 1999, 1080, 1000, 999, 720, 700, 699, 576, 480].map(m.labelFor),
        ['4K', '4K', '1080', '1080', '1080', '720', '720', '720', 'SD', 'SD', 'SD']);
    assert.equal(m.labelFor(0), null);
    assert.equal(m.labelFor(null), null);
    assert.deepEqual([25, 50, '50/1', '30000/1001', '60000/1001', 59.94, 24.9, null, '0/0'].map(m.roundFps), [25, 50, 50, 30, 60, 60, 25, null, null]);
    assert.deepEqual(m.measuredOf({ height: 2160, fps: 50 }), { label: '4K', fps: 50 });
    assert.deepEqual(m.measuredOf({ height: 576, fps: null }), { label: 'SD', fps: null });
});

test('the audit import keeps measured rows and ignores blank, failed and picture-less ones', () => {
    const text = [
        row({}),
        row({ item_id: 'pos_2', stable_id: 's2', blank: true }),
        row({ item_id: 'pos_3', stable_id: 's3', problems: ['blank'] }),
        row({ item_id: 'pos_4', stable_id: 's4', error: 'HTTP 404', video: null }),
        row({ item_id: 'pos_5', stable_id: 's5', video: null, problems: ['no-video'] }),
        row({ item_id: 'pos_6', stable_id: null, video: { width: 1280, height: 720, fpsAvg: 25 } }), // no stable_id: keyed on item_id
        'not json'
    ].join('\n');
    const r = m.importAudit(text);
    assert.deepEqual(r, { read: 7, imported: 2, skipped: 5 });
    assert.deepEqual(stored().map(s => [s.channel_key, s.height, s.fps, s.kbps, s.source]), [['pos_6', 720, 25, 7800, 'audit'], ['s1', 1080, 50, 7800, 'audit']]);
    assert.equal(stored()[1].measured_at, Date.parse('2026-11-15T20:00:30.000Z'));
});

test('the newest measurement wins: in the file, across imports and against a play', () => {
    m.importAudit([
        row({ ended: '2026-11-15T22:00:00.000Z', video: { height: 2160, fpsAvg: 50 } }),
        row({ ended: '2026-11-15T21:00:00.000Z', video: { height: 576, fpsAvg: 25 } }) // older, later in the file
    ].join('\n'));
    assert.deepEqual(m.all().get('1:s1'), { label: '4K', fps: 50 });

    // A play probed after the audit replaces it; one probed before it does not.
    assert.equal(m.recordPlay({ sourceId: 1, key: 's1' }, { height: 720, fps: '50/1' }, Date.parse('2026-11-15T21:30:00.000Z')), false);
    assert.deepEqual(m.all().get('1:s1'), { label: '4K', fps: 50 });
    assert.equal(m.recordPlay({ sourceId: 1, key: 's1' }, { height: 1080, fps: '25/1' }, Date.parse('2026-11-16T08:00:00.000Z')), true);
    assert.deepEqual(m.all().get('1:s1'), { label: '1080', fps: 25 });
    assert.equal(stored()[0].source, 'play');

    // #332: that play's probe was the placeholder's: only that measurement goes.
    m.forgetPlay({ sourceId: 1, key: 's1' }, Date.parse('2026-11-16T08:00:00.000Z'));
    assert.equal(m.all().size, 0);
});

test('applyMeasured sets `measured` only on the channels that have one, by stable id else item id', () => {
    m.record({ sourceId: 1, key: 's1', height: 1080, fps: 50, measuredAt: 1, source: 'audit' });
    m.record({ sourceId: 1, key: 'pos_9', height: 2160, fps: 25, measuredAt: 1, source: 'audit' });
    const rows = m.applyMeasured([
        { sourceId: 1, id: 'pos_1', stableId: 's1' }, { sourceId: 1, id: 'pos_9', stableId: null },
        { sourceId: 2, id: 'pos_1', stableId: 's1' }, { sourceId: 1, id: 'pos_2', stableId: 's2' }
    ]);
    assert.deepEqual(rows.map(r => r.measured), [{ label: '1080', fps: 50 }, { label: '4K', fps: 25 }, undefined, undefined]);
    assert.ok(!('measured' in rows[3]), 'never measured: no `measured` key at all');
});

test('scripts/import-channel-audit.js imports a results.jsonl into the server database', () => {
    const file = path.join(sandbox, 'results.jsonl');
    fs.writeFileSync(file, [row({}), row({ item_id: 'pos_2', stable_id: 's2', blank: true })].join('\n') + '\n');
    const r = spawnSync(process.execPath, ['scripts/import-channel-audit.js', file], { cwd: sandbox, encoding: 'utf8', env: { ...process.env, PIGTV_DB_BACKUPS: '0' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 rows read, 1 measurements kept, 1 ignored/);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(sandbox, 'data/content.db'), { readonly: true });
    try {
        assert.deepEqual(db.prepare('SELECT channel_key, height, fps FROM channel_measurements').all(), [{ channel_key: 's1', height: 1080, fps: 50 }]);
    } finally { db.close(); }
});
