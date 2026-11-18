const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same approach as
// native-playback.test.js; a junction so it works on Windows without admin rights).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-waiting-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const { scheduled, initSchema } = load('db/recordingsDb');
initSchema(); // the engine does this in init(), which a test has no reason to run
const coordinator = load('services/streamCoordinator');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const { recordings, __resetInitForTests } = load('db/recordingsDb');

const inOneHour = Date.now() + 3600 * 1000;
let n = 0;
async function schedule(overrides = {}) {
    return engine.scheduleFromProgram({
        sourceId: 1, channelItemId: `pos_${++n}`, channelName: 'ABC', title: `Show ${n}`,
        programStart: inOneHour + n * 1000, programEnd: inOneHour + 1800 * 1000 + n * 1000, ...overrides
    });
}

test('#345: a recording and its schedule name the sport game they record (gameId), null when none', async () => {
    const GAME = 'nrl-401';
    const withGame = await schedule({ gameId: GAME });
    const without = await schedule();
    const mk = (s) => recordings.create({ scheduled_id: s.id, title: s.title, channel_name: 'ABC', channel_logo: null, source_id: 1, channel_item_id: 'x', file_path: '/x.ts', started_at: Date.now() });
    const r1 = mk(withGame), r2 = mk(without);
    const list = engine.listRecordings();
    assert.equal(list.find(r => r.id === r1.id).gameId, GAME);
    assert.equal(list.find(r => r.id === r2.id).gameId, null);
    const sched = engine.listScheduled();
    assert.equal(sched.find(r => r.id === withGame.id).gameId, GAME);
    assert.equal(sched.find(r => r.id === without.id).gameId, null);
    assert.ok(!('sport_game_id' in sched[0]), 'the internal column stays internal');
});

test('#345: the recording keeps its game when its schedule is dismissed; a continuation part has it too', async () => {
    const s = await schedule({ gameId: 'nrl-777' });
    const r = recordings.create({ scheduled_id: s.id, title: 'x', channel_name: 'ABC', channel_logo: null, source_id: 1, channel_item_id: 'x', file_path: '/x.ts', started_at: 1, part: 1 });
    const r2 = recordings.create({ scheduled_id: s.id, title: 'x', channel_name: 'ABC', channel_logo: null, source_id: 1, channel_item_id: 'x', file_path: '/x2.ts', started_at: 2, part: 2 });
    recordings.finish(r.id, { status: 'completed', ended_at: 3, file_size_bytes: 1, duration_sec: 2, error: null });
    scheduled.setStatus(s.id, 'failed');
    scheduled.delete(s.id); // a failed schedule dismissed from "Recent problems": the recording survives
    const list = engine.listRecordings();
    assert.equal(list.find(x => x.id === r.id).gameId, 'nrl-777');
    assert.equal(list.find(x => x.id === r2.id).gameId, 'nrl-777', 'every part');
});

test('#345: opening an existing database backfills its recordings\' game from their schedules, once, leaving the rest null', async () => {
    const { getDb } = load('db/sqlite');
    const db = getDb();
    const sch = await schedule();
    db.prepare("UPDATE scheduled_recordings SET sport_game_id = 'espn:soccer/eng.1:55' WHERE id = ?").run(sch.id);
    db.prepare("INSERT INTO recordings (id, scheduled_id, title, file_path, status) VALUES (9101, ?, 't', '/a', 'completed')").run(sch.id);
    db.prepare("INSERT INTO recordings (id, scheduled_id, title, file_path, status) VALUES (9102, NULL, 't', '/b', 'completed')").run();
    const val = (id) => db.prepare('SELECT sport_game_id g FROM recordings WHERE id = ?').get(id).g;
    assert.equal(val(9101), null, 'made before the column was filled');
    __resetInitForTests(); initSchema();
    assert.equal(val(9101), 'espn:soccer/eng.1:55');
    assert.equal(val(9102), null);
    db.prepare("UPDATE recordings SET sport_game_id = 'own' WHERE id = 9101").run();
    __resetInitForTests(); initSchema();
    assert.equal(val(9101), 'own', 'idempotent: a value already there is kept');
});
