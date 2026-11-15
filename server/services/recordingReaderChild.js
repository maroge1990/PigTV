// #318: the child process that reads a recording's bytes on the share for playback or a download (recordingReader.js).
// Arguments: the file, the first and the last byte (inclusive). The bytes go to stdout; exit 0 once all are written, 2
// when the file cannot be read. If the share hangs, only this process waits: the server kills it once no bytes have
// come for its stall time, and no thread of the server's pool is held.
const fs = require('fs');

const [file, first, last] = process.argv.slice(2);
const start = Number(first), end = Number(last);
// Tests only: once this many bytes are out, the read waits forever (a share that hangs mid-stream).
const STALL_AFTER = Number(process.env.PIGTV_TEST_READ_STALL_AFTER) || 0;

let sent = 0;
const input = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
input.on('error', () => process.exit(2));
input.on('data', (chunk) => {
    if (STALL_AFTER && sent >= STALL_AFTER) { input.pause(); return Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    sent += chunk.length;
    if (!process.stdout.write(chunk)) {
        input.pause();
        process.stdout.once('drain', () => input.resume());
    }
});
input.on('end', () => process.stdout.end(() => process.exit(0)));
// The server went away (the response closed): nothing left to write to.
process.stdout.on('error', () => process.exit(0));
