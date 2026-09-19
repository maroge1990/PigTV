const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-remuxdiag-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const { describeRemuxEnd, makeStderrLogger } = require(path.join(sandbox, 'server/routes/remux'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const T0 = 1_000_000;

test('a remux that never produced a byte says so, which is what a silent failure needs', () => {
    const line = describeRemuxEnd({ id: 'remux_3', startedAt: T0, now: T0 + 13000 });
    assert.equal(line, '[Remux] Client disconnected after 13s (ffmpeg had produced no output yet), killing remux_3');
});

test('one that did play reports how much, and how long it took to start', () => {
    const line = describeRemuxEnd({ id: 'remux_4', startedAt: T0, now: T0 + 90000, bytes: 5.5 * 1048576, firstOutputAt: T0 + 8100 });
    assert.equal(line, '[Remux] Client disconnected after 90s (sent 5.5 MB, first output after 8.1s), killing remux_4');
    assert.match(describeRemuxEnd({ id: 'r', startedAt: T0, now: T0 + 3000, bytes: 2048, firstOutputAt: T0 + 1000 }), /sent 2 KB, first output after 1.0s/);
});

test('the line still starts the way it always did, so an existing grep for it keeps working', () => {
    assert.ok(describeRemuxEnd({ id: 'remux_1', startedAt: T0, now: T0 + 3000 }).startsWith('[Remux] Client disconnected after 3s'));
});

test('every ffmpeg message is logged, tagged with the remux it belongs to', () => {
    const lines = [];
    const log = makeStderrLogger('remux_2', (l) => lines.push(l));
    log('[http @ 0x1] Will reconnect at 0 in 1 second(s), error=Server returned 429.\n[mpegts @ 0x2] PES packet size mismatch\n');
    assert.deepEqual(lines, [
        '[Remux FFmpeg] remux_2: [http @ 0x1] Will reconnect at 0 in 1 second(s), error=Server returned 429.',
        '[Remux FFmpeg] remux_2: [mpegts @ 0x2] PES packet size mismatch'
    ], 'a message with no "error" or "Warning" in it used to be dropped');
});

test('a message repeated for as long as a stream plays cannot flood the log', () => {
    const lines = [];
    const log = makeStderrLogger('remux_5', (l) => lines.push(l), 3);
    for (let i = 0; i < 1000; i++) log(`Non-monotonous DTS ${i}`);
    assert.equal(lines.length, 4, 'three messages, then one note, then silence');
    assert.match(lines[3], /further ffmpeg messages suppressed/);
});

test('credentials in ffmpeg output are redacted, and the id may be supplied late', () => {
    const lines = [];
    let id = 'not-yet';
    const log = makeStderrLogger(() => id, (l) => lines.push(l));
    id = 'remux_9';
    log('failed to open http://provider.example/live/myuser/mypassword/1.ts');
    assert.ok(lines[0].startsWith('[Remux FFmpeg] remux_9: '));
    assert.ok(!lines[0].includes('mypassword'));
});
