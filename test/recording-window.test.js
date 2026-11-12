const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Item 1: a scheduled recording's window has one owner, recordingGuideEnd.recordingWindow. The clash check and the
// hold check must read the event stop (#217) through it: a schedule that starts while another still records its
// event's overrun is shown as a clash, but is never held for it (it starts late when a slot frees).
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-window-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const guideEnd = load('services/recordingGuideEnd');
const { scheduled } = load('db/recordingsDb');

const MIN = 60000, HOUR = 3600000, MAX = 4 * HOUR;
let A;
before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                         VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Fox Footy', 1, 'ff', 'http://provider.invalid/ff.ts');
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'Fox League', 2, 'fl', 'http://provider.invalid/fl.ts');
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 1,
        maxProviderStreams: 1, sharedIngestEnabled: true });
});
after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('recordingWindow: start with the pre-buffer, floor with the post-buffer, stop with the capped event stop', () => {
    assert.equal(typeof guideEnd.recordingWindow, 'function');
    const base = { program_start: 1000 * HOUR, program_end: 1001 * HOUR };
    const w0 = guideEnd.recordingWindow(base);
    assert.deepEqual(w0, { startsAt: base.program_start, floor: base.program_end, stopsAt: base.program_end }, 'no buffers count as 0');
    const b = { ...base, pre_buffer_min: 2, post_buffer_min: 5 };
    const floor = base.program_end + 5 * MIN;
    assert.deepEqual(guideEnd.recordingWindow(b), { startsAt: base.program_start - 2 * MIN, floor, stopsAt: floor }, 'buffers');
    assert.equal(guideEnd.recordingWindow({ ...b, event_stop: floor - MIN }).stopsAt, floor, 'an event stop below the floor');
    assert.equal(guideEnd.recordingWindow({ ...b, event_stop: floor + HOUR }).stopsAt, floor + HOUR, 'an event stop above the floor');
    assert.equal(guideEnd.recordingWindow({ ...b, event_stop: floor + 9 * HOUR }).stopsAt, floor + MAX, 'capped');
    assert.equal(guideEnd.recordingWindow({ ...b, event_stop: null }).stopsAt, floor, 'a null event stop');
    for (const s of [b, { ...b, event_stop: floor + HOUR }]) {
        assert.equal(guideEnd.recordingWindow(s).floor, guideEnd.floorOf(s));
        assert.equal(guideEnd.recordingWindow(s).stopsAt, guideEnd.stopOf(s));
    }
});

function sched(item, stable, startAt, lengthMs, extra = {}) {
    const now = Date.now();
    const s = scheduled.create({ title: `Game ${startAt}`, description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stable,
        channel_name: item, channel_logo: null, program_start: startAt, program_end: startAt + lengthMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
    if (extra.event_stop) sqlite.getDb().prepare('UPDATE scheduled_recordings SET event_stop = ? WHERE id = ?').run(extra.event_stop, s.id);
    if (extra.status) scheduled.setStatus(s.id, extra.status);
    if (extra.clash_winner) sqlite.getDb().prepare('UPDATE scheduled_recordings SET clash_winner = ? WHERE id = ?').run(extra.clash_winner, s.id);
    return s;
}
const listed = async (over = {}) => new Map(engine.listScheduled({ settings: { ...(await db.settings.get()), ...over } }).map(r => [r.id, r]));

test('a schedule that starts inside another recording\'s event overrun clashes with it', async () => {
    const t0 = Date.now() + 10 * HOUR;
    const game = sched('pos_1', 'ff', t0, HOUR, { status: 'recording', event_stop: t0 + 3 * HOUR }); // guide end t0+1h, runs to t0+3h
    const next = sched('pos_2', 'fl', t0 + 2 * HOUR, HOUR);                                          // starts in the overrun
    const list = await listed();
    assert.deepEqual(list.get(game.id).conflictsWith, [next.id]);
    assert.deepEqual(list.get(next.id).conflictsWith, [game.id]);
    // Without the event stop it is finished at its guide end: no clash.
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET event_stop = NULL WHERE id = ?').run(game.id);
    assert.equal((await listed()).get(next.id).conflictsWith, undefined);
    scheduled.setStatus(game.id, 'cancelled'); scheduled.setStatus(next.id, 'cancelled');
});

test('a schedule due during a winner\'s overrun is not held for it: it waits for a free slot and starts late', async () => {
    const roomForBoth = { maxConcurrentRecordings: 2, maxProviderStreams: 2 };
    // At the cap (1), the winner still recording its overrun: the advisory list shows the clash, the hard hold does not.
    const t0 = Date.now() + 20 * HOUR;
    const winner = sched('pos_1', 'ff', t0, HOUR, { status: 'recording', event_stop: t0 + 3 * HOUR });
    const fresh = sched('pos_2', 'fl', t0 + 2 * HOUR, HOUR);
    const atCap = await listed({ maxConcurrentRecordings: 1, maxProviderStreams: 1 });
    assert.deepEqual(atCap.get(fresh.id).conflictsWith, [winner.id], 'shown as a clash');
    assert.equal(atCap.get(fresh.id).beatenBy, undefined, 'but not held by the overrun');
    // A waiting loser that names the overrunning winner as its hold: not held while the winner records ...
    const loser = sched('pos_2', 'fl', t0 + 2 * HOUR, HOUR, { status: 'waiting', clash_winner: winner.id });
    assert.equal((await listed(roomForBoth)).get(loser.id).beatenBy, undefined, 'winner still recording its overrun');
    // ... nor once the winner has completed with its event stop in the past (the guide windows no longer overlap).
    scheduled.setStatus(winner.id, 'completed');
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET event_stop = ? WHERE id = ?').run(Date.now() - MIN, winner.id);
    assert.equal((await listed(roomForBoth)).get(loser.id).beatenBy, undefined, 'winner completed');
    for (const r of [winner, fresh, loser]) scheduled.setStatus(r.id, 'cancelled');
});

test('a real overlap inside the guide window (floor) is still held hard', async () => {
    const t0 = Date.now() + 30 * HOUR;
    const winner = sched('pos_1', 'ff', t0, HOUR, { status: 'recording' });
    const clash = sched('pos_2', 'fl', t0 + 30 * MIN, HOUR);                                   // starts before the winner's guide end
    assert.deepEqual((await listed({ maxConcurrentRecordings: 1, maxProviderStreams: 1 })).get(clash.id).beatenBy, [winner.id], 'at the cap');
    const stored = sched('pos_2', 'fl', t0 + 30 * MIN, HOUR, { status: 'waiting', clash_winner: winner.id });
    assert.deepEqual((await listed({ maxConcurrentRecordings: 2, maxProviderStreams: 2 })).get(stored.id).beatenBy, [winner.id], 'the stored hold');
    for (const r of [winner, clash, stored]) scheduled.setStatus(r.id, 'cancelled');
});
