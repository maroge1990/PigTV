const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Break detection after a recording finishes, with a fake Comskip standing in for the binary.
// Same sandbox as recording-prepare.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-addetect-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const adDetect = load('services/adDetect');
const db = load('db');
const { recordings } = load('db/recordingsDb');

const dir = path.join(sandbox, 'recordings');
fs.mkdirSync(dir, { recursive: true });

let procs;   // every fake Comskip started, in order
function fakeSpawn(cmd, args) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.args = args;
    const arg = (name) => (args.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
    proc.outDir = arg('output');
    // Comskip's own end: an EDL (or not) and an exit code.
    proc.exit = (edl, code = 1) => {
        if (edl !== null) fs.writeFileSync(path.join(proc.outDir, 'x.edl'), edl);
        proc.emit('close', code);
    };
    procs.push(proc);
    return proc;
}

beforeEach(async () => {
    procs = [];
    adDetect._setForTests({
        available: true,
        spawn: fakeSpawn
    });
    await db.settings.update({ adDetectionEnabled: true });
});

after(() => {
    adDetect._setForTests();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

let n = 0;
function makeRecording({ status = 'recording' } = {}) {
    const file = path.join(dir, `rec-${++n}.ts`);
    fs.writeFileSync(file, 'x'.repeat(4096));
    const row = recordings.create({ scheduled_id: 2000 + n, title: `Recording ${n}`, channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'x', file_path: file, started_at: Date.now() - 600e3 });
    if (status === 'completed') recordings.finish(row.id, { status, ended_at: Date.now(), file_size_bytes: 4096, duration_sec: 600 });
    return { id: row.id, file_path: file };
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('post-recording runs: timeout scales with the recording, never below 30 minutes, and threads are passed', async () => {
    const MIN = 30 * 60 * 1000;
    assert.equal(adDetect.postTimeoutMs(0), MIN);
    assert.equal(adDetect.postTimeoutMs(3600), MIN);            // half of 1 h is exactly 30 min
    assert.equal(adDetect.postTimeoutMs(4 * 3600), 2 * 3600 * 1000);
    assert.equal(adDetect.postTimeoutMs(null), MIN);

    const r = makeRecording({ status: 'completed' });
    const result = adDetect.detect(r.file_path, { timeoutMs: adDetect.postTimeoutMs(600) });
    for (let i = 0; i < 200 && !procs[0]; i++) await new Promise(res => setTimeout(res, 10)); // #289: the file is checked through the share helper first
    assert.ok(procs[0].args.includes('--threads=4'));
    procs[0].exit('1\t2\t0\n');
    const out = await result;
    assert.equal(out.ok, true);
    assert.equal(typeof out.elapsedSec, 'number');
});

// #322: `comskipIniPath` (an override of the bundled Comskip tuning, with no control anywhere) is retired: a stored
// path is never handed to Comskip.
test('a stored Comskip tuning path is not used: detection runs with the bundled tuning', async () => {
    const custom = path.join(sandbox, 'custom-comskip.ini');
    fs.writeFileSync(custom, '[x]\n');
    const sqlite = load('db/sqlite');
    sqlite.getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('comskipIniPath', JSON.stringify(custom));
    await db.settings.update({ adDetectionEnabled: true }); // a write: the next read sees the stored path
    const r = makeRecording({ status: 'completed' });
    recordings.setAdDetectStatus(r.id, 'pending');
    const run = load('services/recordingPost').processAdDetectionQueue({ manual: true });
    for (let i = 0; i < 200 && !procs[0]; i++) await new Promise(res => setTimeout(res, 10));
    assert.ok(procs[0], 'Comskip was started');
    assert.equal(procs[0].args.includes(`--ini=${custom}`), false);
    procs[0].exit('');
    await run;
});
