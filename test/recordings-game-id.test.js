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

const { recordings } = load('db/recordingsDb');

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
