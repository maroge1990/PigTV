const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0156: every status change of a scheduled recording writes one log line, and
// missed/failed schedules stay listable for 7 days via ?include=recent - both
// invisible before this build, which is exactly how schedule #3's overnight
// failure went unnoticed (blueprint.md background). Same sandbox approach as
// recordings-waiting.test.js: a real server tree, a real (temp) database.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-observability-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const { scheduled, initSchema } = load('db/recordingsDb');
initSchema();

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

/** Capture console.log lines for the duration of `fn`. */
async function capturingLogs(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
        await fn();
    } finally {
        console.log = real;
    }
    return lines;
}

test('cancelling a waiting recording logs its transition to cancelled, with no duplicate line', async () => {
    const s = await schedule({ channelName: 'Fox Sports 505', title: 'The Big Game' });
    scheduled.setStatus(s.id, 'waiting');
    const lines = await capturingLogs(() => engine.cancelScheduled(s.id));
    const matches = lines.filter(l => l.includes(`Schedule #${s.id}`) && l.includes('waiting -> cancelled'));
    assert.equal(matches.length, 1, `expected exactly one transition line, got: ${JSON.stringify(lines)}`);
    assert.ok(matches[0].includes('"The Big Game"'));
    assert.ok(matches[0].includes('(Fox Sports 505)'));
});

test('a schedule whose window passed without starting is logged scheduled -> missed (was silent)', async () => {
    const past = Date.now() - 3600 * 1000;
    const s = await schedule({
        channelName: 'Fox Sports 505', title: 'The Big Game',
        programStart: past - 1800 * 1000, programEnd: past
    });
    const lines = await capturingLogs(() => engine.tick());
    const matches = lines.filter(l => l.includes(`Schedule #${s.id}`) && l.includes('scheduled -> missed'));
    assert.equal(matches.length, 1, `expected exactly one transition line, got: ${JSON.stringify(lines)}`);
    assert.ok(matches[0].includes('Recording window passed without starting.'));
    assert.equal(scheduled.getById(s.id).status, 'missed');
});

test('a schedule already at a status is never re-logged for staying there', async () => {
    // tick() re-evaluates every 'waiting' schedule every 15s (it is the retry that makes
    // a declined recording start the moment playback stops), so the guard that only logs
    // the FIRST scheduled -> waiting transition (kept from before 0156) matters: without
    // it, "waiting" would be logged every 15s for as long as the viewer keeps watching.
    const coordinator = load('services/streamCoordinator');
    const real = coordinator.requestForRecording;
    coordinator.requestForRecording = async () => ({ allowed: false, reason: 'A viewer is using the provider stream' });
    const now = Date.now();
    const s = await schedule({ programStart: now, programEnd: now + 3600 * 1000, preBufferMin: 0 });
    try {
        const first = await capturingLogs(() => engine.tick());
        assert.ok(first.some(l => l.includes(`Schedule #${s.id}`) && l.includes('scheduled -> waiting')),
            `the first tick logs it becoming due and waiting; got: ${JSON.stringify(first)}`);
        assert.equal(scheduled.getById(s.id).status, 'waiting');

        const second = await capturingLogs(() => engine.tick());
        const repeated = second.filter(l => l.includes(`Schedule #${s.id}`) && l.includes('-> waiting'));
        assert.deepEqual(repeated, [], 'a second tick must not repeat the transition line');
    } finally {
        coordinator.requestForRecording = real;
        await engine.cancelScheduled(s.id).catch(() => {});
    }
});

test('missed and failed schedules are invisible on the plain route, and visible with include=recent for 7 days', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
    const oneDayAgo = Date.now() - 1 * 24 * 3600 * 1000;

    const recent = await schedule({ programStart: oneDayAgo - 1000, programEnd: oneDayAgo });
    scheduled.setStatus(recent.id, 'failed', { error: 'Only 0.0 GB free at /app/recordings, below the 10 GB minimum' });

    const old = await schedule({ programStart: eightDaysAgo - 1000, programEnd: eightDaysAgo });
    scheduled.setStatus(old.id, 'missed', { error: 'Recording window passed without starting.' });

    const plain = engine.listScheduled();
    assert.ok(!plain.some(x => x.id === recent.id), 'a failed schedule is not on the plain list');
    assert.ok(!plain.some(x => x.id === old.id));

    const withRecent = engine.listScheduled({ includeRecent: true });
    assert.ok(withRecent.some(x => x.id === recent.id && x.status === 'failed' && x.error), 'a recent failure is listed, with its error');
    assert.ok(!withRecent.some(x => x.id === old.id), 'an 8-day-old failure has aged out');
});

test('GET /api/recordings/scheduled stays byte-for-byte the same without include=recent', async () => {
    const before = JSON.stringify(engine.listScheduled());
    const s = await schedule();
    scheduled.setStatus(s.id, 'failed', { error: 'boom' });
    const after = JSON.stringify(engine.listScheduled());
    assert.equal(before, after, 'a failed schedule must not appear, or otherwise change the plain response');
});
