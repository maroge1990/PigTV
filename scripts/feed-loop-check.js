#!/usr/bin/env node
/**
 * #324 (T2): run the looping-feed detector (server/services/feedLoop.js) over a saved MPEG-TS sample,
 * as the shared ingest would see it, and say whether and where it calls the feed a loop.
 *
 *   node scripts/feed-loop-check.js <sample.ts> [--chunk <bytes>]
 *
 * Prints the verdict (period, run, at which second of media it was found), the detector's notes, the
 * CPU time it took per second of media and its memory. Reads a local file only; never a provider.
 */
'use strict';
const fs = require('fs');
const { LoopDetector } = require('../server/services/feedLoop');

function check(file, { chunk = 64 * 1024 } = {}) {
    const detector = new LoopDetector();
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(chunk);
    let bytes = 0;
    let cpuNs = 0n;
    let verdict = null;
    let foundAtBytes = null;
    let firstTime = null;
    let foundAtSec = null;
    try {
        for (;;) {
            const n = fs.readSync(fd, buf, 0, chunk, null);
            if (n <= 0) break;
            const piece = Buffer.from(buf.subarray(0, n)); // the ingest hands over fresh chunks
            const t0 = process.hrtime.bigint();
            verdict = detector.push(piece);
            cpuNs += process.hrtime.bigint() - t0;
            bytes += n;
            if (firstTime === null && detector.video.count) firstTime = detector.video.times[0];
            if (verdict && foundAtBytes === null) {
                foundAtBytes = bytes;
                foundAtSec = detector.video.time - firstTime;
                break;
            }
        }
    } finally { fs.closeSync(fd); }
    const mediaSec = detector.video.count ? detector.video.time - firstTime : 0;
    return { verdict, foundAtSec, foundAtBytes, bytes, mediaSec, cpuMs: Number(cpuNs) / 1e6, info: detector.describe() };
}

if (require.main === module) {
    const file = process.argv[2];
    if (!file) { console.error('usage: feed-loop-check.js <sample.ts> [--chunk <bytes>]'); process.exit(2); }
    const at = process.argv.indexOf('--chunk');
    const r = check(file, { chunk: at > 0 ? Number(process.argv[at + 1]) : undefined });
    const mbps = r.mediaSec > 0 ? (r.bytes * 8 / r.mediaSec / 1e6).toFixed(2) : '?';
    console.log(r.verdict
        ? `LOOP: period ${r.verdict.periodSec} s (${r.verdict.periodUnits} video units), run ${r.verdict.runSec} s, ` +
          `${Math.round(r.verdict.distinct * 100)}% distinct, ${r.verdict.keyframes} key frames, audio ${r.verdict.audio}; ` +
          `found ${r.foundAtSec.toFixed(1)} s into the media`
        : `no loop in ${r.mediaSec.toFixed(1)} s of media`);
    for (const n of r.info.notes) console.log(`note: ${n}`);
    console.log(`read ${(r.bytes / 1048576).toFixed(1)} MB (${mbps} Mbps) over ${r.mediaSec.toFixed(1)} s of media; ` +
        `detector CPU ${r.cpuMs.toFixed(1)} ms = ${(r.cpuMs / Math.max(1, r.mediaSec)).toFixed(2)} ms per second of media; ` +
        `memory ~${(r.info.memoryBytes / 1048576).toFixed(2)} MB`);
}

module.exports = { check };
