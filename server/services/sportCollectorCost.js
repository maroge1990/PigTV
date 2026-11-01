/**
 * #29: what the score collector (sportsDashboard.createCollector) costs the server's event loop, tick by tick, for the
 * Status page and the collector's measurement (docs/evidence). Timing and sizes only: never a URL, league or payload.
 *
 *   requests    answers fetched this tick (cache hits not counted)
 *   bytes       their size
 *   parseMs     JSON.parse of them, together; maxParseMs the longest single one (one uninterrupted block of the loop)
 *   normalizeMs turning them into games; ingestMs writing the games and pruning (SQLite, synchronous)
 *   busyMs      parse + normalize + ingest: the tick's time on the event loop
 *   tickMs      the whole tick, network included (mostly waiting, off the loop)
 *
 * summary() -> { ticks, last, p95, max } over the last WINDOW ticks (an hour at one tick per 30 s).
 */
const WINDOW = 120;
const FIELDS = ['requests', 'bytes', 'parseMs', 'maxParseMs', 'normalizeMs', 'ingestMs', 'busyMs', 'tickMs'];
let ticks = [];

const round = (v) => Math.round(v * 10) / 10;

/** A fresh tick's counters, filled by the collector as it goes. */
function tick() {
    return { requests: 0, bytes: 0, parseMs: 0, maxParseMs: 0, normalizeMs: 0, ingestMs: 0, busyMs: 0, tickMs: 0 };
}
function parsed(t, bytes, ms) {
    t.requests++;
    t.bytes += bytes;
    t.parseMs += ms;
    t.maxParseMs = Math.max(t.maxParseMs, ms);
}
function record(t) {
    t.busyMs = t.parseMs + t.normalizeMs + t.ingestMs;
    ticks.push(Object.fromEntries(FIELDS.map(f => [f, round(t[f])])));
    if (ticks.length > WINDOW) ticks = ticks.slice(-WINDOW);
}
function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
}
function summary() {
    if (!ticks.length) return { ticks: 0, last: null, p95: null, max: null };
    const of = (fn) => Object.fromEntries(FIELDS.map(f => [f, fn(ticks.map(t => t[f]))]));
    return { ticks: ticks.length, last: ticks[ticks.length - 1], p95: of(v => percentile(v, 95)), max: of(v => Math.max(...v)) };
}
function reset() { ticks = []; }

module.exports = { tick, parsed, record, summary, reset, WINDOW };
