const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A real database in a sandbox: the schedule resolution is the thing under test,
// and it is a query.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-recstable-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
// resolveStreamUrl reads the source to decide Xtream vs M3U, so the sandbox needs
// one. M3U is the case that has positions to lose.
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'data/db.json'), JSON.stringify({
    sources: [{ id: 2, name: 'Test M3U', type: 'm3u', url: 'http://provider.invalid/list.m3u' }],
    settings: {}, users: []
}));
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const recordingsDb = require(path.join(sandbox, 'server/db/recordingsDb'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_505 = 'http://pro.speed8k.top/live/u/p/441360.ts';
const URL_SHOP = 'http://pro.speed8k.top/live/u/p/999999.ts';

function channel(pos, name, url, stableId, order) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, 2, ?, 'live', ?, 'Sport', NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, stable_id = excluded.stable_id
    `).run(`2:${pos}`, pos, name, JSON.stringify({ url }), order, stableId);
}

const schedule = (channelItemId, stable) => recordingsDb.scheduled.create({
    title: 'The Match', description: null, source_id: 2,
    channel_item_id: channelItemId, channel_stable_id: stable,
    channel_name: 'Fox Sports 505', channel_logo: null,
    program_start: Date.now() + 3600000, program_end: Date.now() + 7200000,
    pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: Date.now()
});

test('a schedule records which channel it is for, not only where it sat', () => {
    channel('pos_1187', 'Fox Sports 505', URL_505, 's441360', 1187);
    const row = schedule('pos_1187', 's441360');
    assert.equal(row.channel_stable_id, 's441360');
    assert.equal(row.channel_item_id, 'pos_1187');
});

test('after a reorder the schedule still resolves to the right stream', async () => {
    // The 21 Sept reorder, in the window between scheduling and recording. Before
    // this, the schedule would have resolved by position and recorded whatever had
    // moved into it - the worst form of this bug, because the evidence is a file
    // full of the wrong programme.
    channel('pos_1185', 'Fox Sports 505', URL_505, 's441360', 1185);
    channel('pos_1187', 'Shopping Channel', URL_SHOP, 's999999', 1187);

    const engine = require(path.join(sandbox, 'server/services/recordingEngine'));
    const bySchedule = await engine.resolveStreamUrl(2, 'pos_1187', 's441360');
    assert.equal(bySchedule, URL_505, 'the identity wins over the stale position');

    const byPositionOnly = await engine.resolveStreamUrl(2, 'pos_1187', null);
    assert.equal(byPositionOnly, URL_SHOP,
        'and without an identity it still resolves by position - which is the old, wrong answer');
});

test('a channel listed in several categories resolves to the same row every time', async () => {
    channel('pos_28282', 'Fox Sports 505', URL_505, 's441360', 28282);
    const engine = require(path.join(sandbox, 'server/services/recordingEngine'));
    const first = await engine.resolveStreamUrl(2, 'pos_1185', 's441360');
    const again = await engine.resolveStreamUrl(2, 'pos_28282', 's441360');
    assert.equal(first, URL_505);
    assert.equal(again, first, 'both listings give one stream, deterministically');
});

test('a schedule made before identities existed still resolves, the old way', async () => {
    const db = sqlite.getDb();
    db.prepare(`
        INSERT INTO scheduled_recordings (title, source_id, channel_item_id, program_start, program_end,
                                          pre_buffer_min, post_buffer_min, status, created_at)
        VALUES ('Old One', 2, 'pos_1185', ?, ?, 0, 0, 'scheduled', ?)
    `).run(Date.now() + 3600000, Date.now() + 7200000, Date.now());

    const engine = require(path.join(sandbox, 'server/services/recordingEngine'));
    const row = db.prepare("SELECT * FROM scheduled_recordings WHERE title = 'Old One'").get();
    assert.equal(await engine.resolveStreamUrl(2, row.channel_item_id, row.channel_stable_id || null), URL_505);
});

test('pending schedules are backfilled at startup; finished ones are left alone', () => {
    const db = sqlite.getDb();
    db.prepare(`
        INSERT INTO scheduled_recordings (title, source_id, channel_item_id, program_start, program_end,
                                          pre_buffer_min, post_buffer_min, status, created_at)
        VALUES ('Done Already', 2, 'pos_1185', 1, 2, 0, 0, 'completed', 1)
    `).run();
    // Re-run the schema step, which is what a restart does.
    recordingsDb.__resetInitForTests();
    recordingsDb.initSchema();

    const pending = db.prepare("SELECT channel_stable_id FROM scheduled_recordings WHERE title = 'Old One'").get();
    const finished = db.prepare("SELECT channel_stable_id FROM scheduled_recordings WHERE title = 'Done Already'").get();
    assert.equal(pending.channel_stable_id, 's441360', 'a pending schedule gets an identity');
    assert.equal(finished.channel_stable_id, null,
        'a finished one does not - rewriting it would be dishonest about what was recorded');
});
