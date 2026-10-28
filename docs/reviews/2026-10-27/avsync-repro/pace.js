// node pace.js <file> <startByte> : writes the TS from startByte (aligned to 188) to stdout at its 7 Mbit/s mux rate.
const fs = require('fs');
const [file, startArg] = process.argv.slice(2);
let pos = Math.floor(Number(startArg) / 188) * 188;
const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
const RATE = 7000000 / 8, TICK = 20, t0 = Date.now(); let sent = 0;
// A 2 s head start, as a provider's connect burst (and the ingest ring) gives a session.
const burst = RATE * Number(process.env.BURST || 2);
function tick() {
    const due = burst + RATE * (Date.now() - t0) / 1000 - sent;
    if (due > 0 && pos < size) {
        const n = Math.min(Math.floor(due / 188) * 188 || 188, size - pos);
        const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, pos); pos += n; sent += n;
        if (!process.stdout.write(buf)) return process.stdout.once('drain', () => setTimeout(tick, TICK));
    }
    if (pos >= size) return process.stdout.end();
    setTimeout(tick, TICK);
}
process.stdout.on('error', () => process.exit(0));
tick();
