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

const inOneHour = Date.now() + 3600 * 1000;
let n = 0;
async function schedule(overrides = {}) {
    return engine.scheduleFromProgram({
        sourceId: 1, channelItemId: `pos_${++n}`, channelName: 'ABC', title: `Show ${n}`,
        programStart: inOneHour + n * 1000, programEnd: inOneHour + 1800 * 1000 + n * 1000, ...overrides
    });
}

test('a recording held back for a viewer is still listed as upcoming', async () => {
    const s = await schedule();
    scheduled.setStatus(s.id, 'waiting', { error: 'A viewer is using the provider stream' });
    const listed = engine.listScheduled().find(x => x.id === s.id);
    assert.ok(listed, 'it must not vanish from the list the moment it starts waiting');
    assert.equal(listed.status, 'waiting');
});

test('every state a person would call upcoming or in progress is listed; finished ones are not', async () => {
    const statuses = ['scheduled', 'waiting', 'recording', 'cancelled', 'missed', 'failed', 'completed'];
    const made = {};
    for (const status of statuses) {
        const s = await schedule();
        if (status !== 'scheduled') scheduled.setStatus(s.id, status);
        made[status] = s.id;
    }
    const listedIds = new Set(engine.listScheduled().map(x => x.id));
    for (const status of ['scheduled', 'waiting', 'recording']) assert.ok(listedIds.has(made[status]), `${status} is listed`);
    for (const status of ['cancelled', 'missed', 'failed', 'completed']) assert.ok(!listedIds.has(made[status]), `${status} is not`);
});

test('a waiting recording can be cancelled - it used to come back unchanged, so the cancel silently did nothing', async () => {
    const s = await schedule();
    scheduled.setStatus(s.id, 'waiting');
    const result = await engine.cancelScheduled(s.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
    assert.ok(!engine.listScheduled().some(x => x.id === s.id), 'and it leaves the list');
});

test('cancelling withdraws the prompt that asks the viewer to stop watching', async () => {
    // A prompt only exists while a viewer holds the provider stream, which is awkward to fake, so
    // watch for the call that removes it: a viewer must not be asked to stop for a recording that
    // no longer exists (the client polls for exactly this prompt).
    const cleared = [];
    const realClear = coordinator.clearPrompt;
    coordinator.clearPrompt = (id) => { cleared.push(Number(id)); return realClear(id); };
    try {
        const waiting = await schedule();
        scheduled.setStatus(waiting.id, 'waiting');
        await engine.cancelScheduled(waiting.id);
        assert.deepEqual(cleared, [waiting.id]);

        const finished = await schedule();
        scheduled.setStatus(finished.id, 'completed');
        await engine.cancelScheduled(finished.id);
        assert.deepEqual(cleared, [waiting.id], 'nothing to withdraw for one that was already over');
    } finally { coordinator.clearPrompt = realClear; }
});

test('scheduling the same programme again returns the one that is waiting, not a duplicate', async () => {
    const first = await schedule({ channelItemId: 'pos_dup', programStart: inOneHour + 99_000, programEnd: inOneHour + 1_900_000 });
    scheduled.setStatus(first.id, 'waiting');
    const again = await schedule({ channelItemId: 'pos_dup', programStart: inOneHour + 99_000, programEnd: inOneHour + 1_900_000 });
    assert.equal(again.id, first.id);
});

test('cancelling one that has already finished or been cancelled changes nothing', async () => {
    const s = await schedule();
    scheduled.setStatus(s.id, 'completed');
    assert.equal((await engine.cancelScheduled(s.id)).status, 'completed');
});
