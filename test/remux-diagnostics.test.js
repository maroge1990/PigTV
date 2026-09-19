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
const { describeRemuxEnd, makeStderrLogger, makeLineBuffer } = require(path.join(sandbox, 'server/routes/remux'));

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
    for (let i = 0; i < 1000; i++) log(`Non-monotonous DTS ${i}\n`);
    assert.equal(lines.length, 4, 'three messages, then one note, then silence');
    assert.match(lines[3], /further ffmpeg messages suppressed/);
});

test('credentials in ffmpeg output are redacted, and the id may be supplied late', () => {
    const lines = [];
    let id = 'not-yet';
    const log = makeStderrLogger(() => id, (l) => lines.push(l));
    id = 'remux_9';
    log('failed to open http://provider.example/live/myuser/mypassword/1.ts\n');
    assert.ok(lines[0].startsWith('[Remux FFmpeg] remux_9: '));
    assert.ok(!lines[0].includes('mypassword'));
});

// The lines a real join-mid-keyframe produces, copied from a live server's log.
const JOIN_NOISE = [
    '[h264 @ 0x556ecb624440] non-existing SPS 0 referenced in buffering period',
    '[h264 @ 0x556ecb624440] non-existing PPS 0 referenced',
    '[h264 @ 0x556ecb624440] decode_slice_header error',
    '[h264 @ 0x556ecb624440] no frame!',
    'Last message repeated 1 times'
];

test('the decoder chatter from joining a stream mid-keyframe is counted, not logged line by line', () => {
    const lines = [];
    const log = makeStderrLogger('remux_15', (l) => lines.push(l));
    for (let i = 0; i < 8; i++) log(JOIN_NOISE.join('\n') + '\n');
    assert.equal(lines.length, 0, 'none of it reaches the log while it happens');
    log.flush();
    assert.equal(lines.length, 1, 'one summary line instead');
    assert.match(lines[0], /remux_15: 40 decoder messages while probing the stream/);
    assert.match(lines[0], /h264: non-existing PPS 0 referenced x8/);
    assert.match(lines[0], /normally just joining mid-keyframe/);
});

test("that noise no longer uses up the budget: a real problem after it is still logged", () => {
    const lines = [];
    const log = makeStderrLogger('remux_16', (l) => lines.push(l), 3);
    for (let i = 0; i < 50; i++) log(JOIN_NOISE.join('\n') + '\n');
    log('[http @ 0x1] Will reconnect at 0 in 1 second(s), error=Server returned 429.\n');
    log('[mpegts @ 0x2] PES packet size mismatch\n');
    assert.deepEqual(lines, [
        '[Remux FFmpeg] remux_16: [http @ 0x1] Will reconnect at 0 in 1 second(s), error=Server returned 429.',
        '[Remux FFmpeg] remux_16: [mpegts @ 0x2] PES packet size mismatch'
    ]);
});

test("a 'repeated N times' note counts as probe noise only when it follows some, not on its own", () => {
    const lines = [];
    const log = makeStderrLogger('remux_17', (l) => lines.push(l));
    log('Last message repeated 3 times\n');
    assert.equal(lines.length, 1, 'on its own it is an ordinary message and is logged');
});

test('flush is safe to call repeatedly and says nothing when there was nothing to say', () => {
    const lines = [];
    const log = makeStderrLogger('remux_18', (l) => lines.push(l));
    log.flush();
    log(JOIN_NOISE[1] + '\n');
    log.flush();
    log.flush();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /1 decoder messages/);
});

// ---- ffmpeg's stderr arrives in arbitrary pieces, not in lines ----

test('a line split across two reads is put back together, wherever the split falls', () => {
    const text = 'first line\n[h264 @ 0x1] non-existing PPS 0 referenced\nLast message repeated 1 times\nfinal line\n';
    const expected = ['first line', '[h264 @ 0x1] non-existing PPS 0 referenced', 'Last message repeated 1 times', 'final line'];
    for (let cut = 0; cut <= text.length; cut++) {
        const got = [];
        const feed = makeLineBuffer((l) => got.push(l));
        feed(text.slice(0, cut));
        feed(text.slice(cut));
        assert.deepEqual(got, expected, `split at ${cut}`);
    }
});

test('the log is identical however the stream is cut: no "Last mess" / "age repeated" fragments', () => {
    const stream = JOIN_NOISE.join('\n') + '\n[http @ 0x1] Will reconnect at 0 in 1 second(s), error=Server returned 429.\n';
    const run = (pieces) => {
        const lines = [];
        const log = makeStderrLogger('remux_1', (l) => lines.push(l));
        for (const piece of pieces) log(piece);
        log.end();
        return lines;
    };
    const whole = run([stream]);
    assert.equal(whole.length, 2, 'the summary and the one real message');
    for (let cut = 1; cut < stream.length; cut++) {
        assert.deepEqual(run([stream.slice(0, cut), stream.slice(cut)]), whole, `cut at ${cut}`);
    }
    // And the worst case: one byte at a time.
    assert.deepEqual(run([...stream]), whole);
});

test('a final line with no newline is held back until the process is over, then released', () => {
    const lines = [];
    const log = makeStderrLogger('remux_2', (l) => lines.push(l));
    log('[http @ 0x1] Connection reset by peer');
    assert.equal(lines.length, 0, 'it may be only the start of a line');
    log.end();
    assert.deepEqual(lines, ['[Remux FFmpeg] remux_2: [http @ 0x1] Connection reset by peer']);
});
