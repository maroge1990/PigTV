/**
 * R16: how late the server's own event loop runs. A perf_hooks histogram sampled from
 * start, reset every minute so the Status page can show "since start" and "last minute".
 * Cheap (a 20 ms timer in libuv) and unref'd, so it never keeps the process or a test alive.
 */
const { monitorEventLoopDelay } = require('perf_hooks');

const RESOLUTION_MS = 20;
const WINDOW_MS = 60 * 1000;

let total = null;
let windowed = null;
let lastWindow = null;
let rollTimer = null;
let windowStart = 0;

const ms = (ns) => Math.round(Math.max(0, ns / 1e6 - RESOLUTION_MS) * 10) / 10;
const snap = (h) => (h.count ? { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) } : { p50: 0, p99: 0, max: 0 });

function start() {
    if (total) return;
    total = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    windowed = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    total.enable();
    windowed.enable();
    windowStart = Date.now();
    rollTimer = setInterval(() => {
        lastWindow = snap(windowed);
        windowed.reset();
        windowStart = Date.now();
    }, WINDOW_MS);
    rollTimer.unref();
}

/** { sinceStartMs, lastMinute } in ms of lateness; lastMinute is the last full minute, else the minute so far. */
function summary() {
    start();
    return {
        sinceStart: snap(total),
        lastMinute: lastWindow || snap(windowed),
        sampledSec: Math.round((Date.now() - windowStart) / 1000)
    };
}

module.exports = { start, summary };
