const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #358 (Mark, 20 Nov): a schedule linked to a game ESPN follows stops when ESPN says the game is over, with no added
// minutes, unless the request names a Finish late; a programme not linked to a game keeps the Settings padding.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-game-post-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const engine = load('services/recordingEngine');
const { initSchema } = load('db/recordingsDb');
initSchema();

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const inOneHour = Date.now() + 3600 * 1000;
let n = 0;
const schedule = (overrides = {}) => engine.scheduleFromProgram({
    sourceId: 1, channelItemId: `pos_${++n}`, channelName: 'ABC', title: `Show ${n}`,
    programStart: inOneHour + n * 60000, programEnd: inOneHour + 1800 * 1000 + n * 60000, ...overrides
});

test('#358: a game-linked schedule with no Finish late gets 0 (ESPN\'s end); Start early keeps the Settings default', async () => {
    const s = await schedule({ gameId: 'nba-401' });
    assert.equal(s.post_buffer_min, 0);
    assert.equal(s.pre_buffer_min, 1, 'the Settings default (1)');
});

test('#358: a Finish late the request names is kept for a game; a programme with no game keeps the Settings default', async () => {
    assert.equal((await schedule({ gameId: 'nba-402', postBufferMin: 7 })).post_buffer_min, 7);
    assert.equal((await schedule()).post_buffer_min, 5, 'the Settings default (5)');
    assert.equal((await schedule({ gameId: 'not a game id!' })).post_buffer_min, 5, 'an invalid gameId links nothing');
});
