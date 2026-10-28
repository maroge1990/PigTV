// node pace-pcr.js <file> [startByte]: writes an MPEG-TS to stdout at the pace of its own PCR clock.
// HEAD=<s> sends the first <s> seconds of media at once (a provider's connect burst).
// BURSTY=<pause s>: after the head start, holds the data back for <pause> s and then releases it, over and over,
// keeping the average at real time (as Strong8K delivered FOX [Birmingham] on 28 Oct: 4-8 s pauses every 6-8 s).
const fs = require('fs');
const [file, startArg = '0'] = process.argv.slice(2);
const data = fs.readFileSync(file);
let pos = Math.floor(Number(startArg) / 188) * 188;
while (pos < data.length && !(data[pos] === 0x47 && data[pos + 188] === 0x47)) pos++;
const HEAD = Number(process.env.HEAD || 2), PAUSE = Number(process.env.BURSTY || 0);
function pcrAt(i) {
    if (!(data[i + 3] & 0x20) || data[i + 4] < 7 || !(data[i + 5] & 0x10)) return null;
    return (data[i + 6] * 33554432 + data[i + 7] * 131072 + data[i + 8] * 512 + data[i + 9] * 2 + (data[i + 10] >> 7)) / 90000;
}
// media time of each packet, from the most recent PCR
const times = [];
let first = null, last = null;
for (let i = pos; i + 188 <= data.length; i += 188) {
    const p = pcrAt(i);
    if (p !== null) { if (first === null) first = p; last = p; }
    times.push(last === null ? 0 : last - first);
}
const t0 = Date.now();
let k = 0;
function due(mediaSec) {
    if (mediaSec <= HEAD) return 0;
    const real = mediaSec - HEAD;
    if (!PAUSE) return real * 1000;
    // released in batches: everything up to the next multiple of PAUSE seconds arrives at once
    return Math.ceil(real / PAUSE) * PAUSE * 1000;
}
process.stdout.on('error', () => process.exit(0));
(function tick() {
    const now = Date.now() - t0;
    const start = k;
    while (k < times.length && due(times[k]) <= now) k++;
    if (k > start) {
        const ok = process.stdout.write(data.subarray(pos + start * 188, pos + k * 188));
        if (!ok) return process.stdout.once('drain', () => setTimeout(tick, 10));
    }
    if (k >= times.length) return process.stdout.end();
    setTimeout(tick, 10);
})();
