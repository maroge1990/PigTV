/**
 * #36 (0487): where a play's start goes. The Apple client's play-start may carry `phases`, each a time in milliseconds
 * since the play began (the press), all optional (C-A, CLIENT-CONTRACT.md):
 *   resolveMs  the server's answer arrived
 *   readyMs    the player's item was ready to play (the master playlist and the first segments fetched)
 *   modeMs     the television's display-mode switch finished (tvOS only; absent when no switch was needed)
 *   frameMs    the first picture
 * From those, four steps a person can act on: the server's answer, loading the stream, the display mode and the first
 * picture. The 6 Nov audit saw 4.3-4.9 s of server answer and 0.6-11 s on the device it could not split (#36, #35).
 */
const PHASES = ['resolve', 'ready', 'mode', 'frame'];
const STEPS = [
    ['answer', 'Server answer', (p) => p.resolve],
    ['loading', 'Loading the stream', (p) => diff(p.ready, p.resolve)],
    ['mode', 'Display mode switch', (p) => (p.mode == null ? null : diff(p.mode, p.ready))],
    ['picture', 'First picture', (p) => diff(p.frame, p.mode != null && p.ready != null ? Math.max(p.mode, p.ready) : p.ready)]
];
const LIMIT_MS = 10 * 60 * 1000;

function diff(a, b) {
    if (a == null || b == null) return null;
    const d = Math.round((a - b) * 10) / 10;
    return d >= 0 ? d : null;
}

/** The client's phases as seconds (one decimal), or null when none is usable. Never throws. */
function clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const name of PHASES) {
        const v = raw[`${name}Ms`];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LIMIT_MS) out[name] = Math.round(v / 100) / 10;
    }
    return Object.keys(out).length ? out : null;
}

/** "resolve:4.3,ready:5.0,frame:5.4" for the log line ("" when none). */
function logText(phases) {
    return phases ? PHASES.filter(n => phases[n] != null).map(n => `${n}:${phases[n].toFixed(1)}`).join(',') : '';
}

/** The four steps of one play, in seconds (null where a phase is missing). */
function steps(phases) {
    const out = {};
    for (const [key, , fn] of STEPS) out[key] = phases ? fn(phases) : null;
    return out;
}

function percentile(values, p) {
    const s = values.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** Median and p90 of each step over the play-starts that carry phases (newest `max` of them). */
function summary(events, max = 50) {
    const plays = (events || []).filter(e => e && e.type === 'play-start' && e.phases).slice(0, max);
    const rows = STEPS.map(([key, label]) => {
        const values = plays.map(e => steps(e.phases)[key]).filter(v => v != null);
        return { key, label, count: values.length, median: percentile(values, 50), p90: percentile(values, 90) };
    });
    return { plays: plays.length, steps: rows };
}

module.exports = { PHASES, STEPS, clean, logText, steps, summary, percentile };
