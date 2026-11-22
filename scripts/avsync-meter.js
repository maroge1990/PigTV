#!/usr/bin/env node
/**
 * The A/V sync meter (#267, docs/TESTING.md › A/V sync harness): reads a media file of the fake provider's
 * "TEST A/V SYNC" channel (a QuickTime recording of a device's screen with its sound, a `simctl io recordVideo` file,
 * or a segment / joined output of the server) and prints how far the sound is behind the picture, mark by mark.
 *
 *   node scripts/avsync-meter.js <file> [--corner x,y,w,h] [--events <file>] [--quiet]
 *
 * The channel flashes the picture white and beeps (1760 Hz) at every second of its own clock, both 0.1 s long, and
 * 0.3 s long every 10th second (scripts/fake-provider.js, SYNC). The meter finds:
 *   - flash onsets: the frame's mean brightness (signalstats YAVG, over the whole frame or the --corner crop)
 *     crossing half way from the dark level to the flash level, upward;
 *   - beep onsets: the 1760 Hz band's level in 5 ms windows (bandpass, astats RMS) crossing half way (in dB) from
 *     the quiet level to the beep level, upward;
 * pairs each flash with a beep (the long marks fix which second is which, so a whole-second slip is measured, not
 * folded away), and prints one line per pair `t=<s> offset_ms=<sound minus picture>`, a short summary (median, min,
 * max, worst, drift, the first time the offset leaves ±80 ms for 5 s or more) and one JSON line `AVSYNC {...}`.
 * A positive offset is sound late.
 *
 * --events <file>: one event a line, `<seconds into the file> [label]` (or mm:ss / hh:mm:ss), e.g. the times of
 * forced switches noted during a rig run; each is marked in the output with the median offset 5 s either side.
 *
 * Files only: it never runs against a URL (never against a real provider) and never prints one. Node built-ins plus
 * ffmpeg and ffprobe on the PATH.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PERIOD = 1;            // seconds between marks
const LONG_EVERY = 10;       // every 10th mark is long
const LONG_MIN_SEC = 0.2;    // a mark at least this long is a long one (0.1 short, 0.3 long)
const WINDOW = 240;          // audio samples per level reading at 48 kHz: 5 ms
const OUT_OF_STEP_MS = 80;
const OUT_OF_STEP_FOR_SEC = 5;

/** Text that came from the input (an event label, a file name), with anything address-like replaced: never printed. */
const scrub = (text) => String(text).replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<address>').replace(/\bwww\.\S+/gi, '<address>');
const isUrl = (s) => /^[a-z][a-z0-9+.-]*:/i.test(String(s)) && !/^[a-z]:[\\/]/i.test(String(s));

// ---- onsets ------------------------------------------------------------------------------------------------

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : NaN;

/**
 * Upward crossings of the half-way level in a series [{ t, v }] (sorted by t). Returns [{ t, dur, long }] or [] when
 * the series has no marks (the spread between its quiet and bright levels is under `minSpread`).
 * `dur` is how long it stays above; a mark is long when dur ≥ LONG_MIN_SEC.
 */
function onsets(series, { minSpread }) {
    if (series.length < 3) return [];
    const sorted = series.map(s => s.v).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = quantile(sorted, 0.2);
    const hi = quantile(sorted, 0.995);
    if (!(hi - lo >= minSpread)) return [];
    const threshold = lo + (hi - lo) / 2;
    // Hysteresis: after a mark the level must fall to a quarter of the way up before the next onset counts, so a
    // filter's ring-down hovering around half way is not a second beep.
    const rearm = lo + (hi - lo) / 4;
    const out = [];
    let open = null;
    let above = Number.isFinite(series[0].v) && series[0].v >= threshold; // a mark already lit at the start is not an onset
    let armed = !above;
    for (const { t, v } of series) {
        const level = Number.isFinite(v) ? v : -Infinity;
        const now = level >= threshold;
        if (level < rearm) armed = true;
        if (now && !above && armed) { open = { t }; armed = false; }
        if (!now && above && open) {
            open.dur = t - open.t;
            open.long = open.dur >= LONG_MIN_SEC;
            out.push(open);
            open = null;
        }
        above = now;
    }
    return out; // a mark still lit at the end has no known length: left out
}

// ---- pairing -------------------------------------------------------------------------------------------------

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Pair flash onsets with beep onsets. Both are [{ t, long }] in seconds. The long marks come every LONG_EVERY
 * seconds on both sides, so the offset between a long flash and the nearest long beep says which beep belongs to
 * which flash even when the sound is a whole second (or more) out; without long marks the offset is only known
 * modulo the period (`ambiguous: true`). Each flash then takes the beep nearest to where the offset so far expects
 * it, within half a period; one beep pairs with one flash at most.
 * -> { pairs: [{ t, offsetMs, long }], missingBeeps: [t], missingFlashes: [t], kindMismatches, ambiguous, coarseMs }
 */
function pairOnsets(flashes, beeps, { period = PERIOD, longEvery = LONG_EVERY, start = null, end = null,
    flashStart = start, flashEnd = end, beepStart = start, beepEnd = end } = {}) {
    const F = [...flashes].sort((a, b) => a.t - b.t);
    const B = [...beeps].sort((a, b) => a.t - b.t);
    const nearest = (list, t, within, filter = () => true) => {
        let best = null;
        for (const x of list) {
            if (!filter(x)) continue;
            const d = Math.abs(x.t - t);
            if (d <= within && (!best || d < Math.abs(best.t - t))) best = x;
        }
        return best;
    };
    // Coarse offset from the long marks: each long flash and the nearest long beep within half the long period.
    const longB = B.filter(b => b.long);
    const longOffsets = [];
    for (const f of F.filter(x => x.long)) {
        const b = nearest(longB, f.t, (longEvery * period) / 2);
        if (b) longOffsets.push(b.t - f.t);
    }
    const ambiguous = longOffsets.length === 0;
    let expect = ambiguous ? 0 : median(longOffsets);
    const coarse = expect;
    const used = new Set();
    const pairs = [];
    const missingBeeps = [];
    let kindMismatches = 0;
    const mismatchAt = [];
    const missingBeepAt = [];
    for (const f of F) {
        // A long flash re-anchors on the long beep nearest the expected place (a slip of a whole second is caught here).
        let b = null;
        if (f.long && !ambiguous) {
            b = nearest(longB, f.t + expect, (longEvery * period) / 2, x => !used.has(x));
        }
        if (!b) b = nearest(B, f.t + expect, period / 2, x => !used.has(x));
        if (!b) { missingBeeps.push(f.t); missingBeepAt.push({ t: f.t, expectAt: f.t + expect, long: !!f.long }); continue; }
        used.add(b);
        if (!!b.long !== !!f.long) { kindMismatches++; mismatchAt.push(f.t); }
        const offset = b.t - f.t;
        pairs.push({ t: f.t, offsetMs: round1(offset * 1000), long: !!f.long, anchor: !!f.long && !!b.long });
        expect = offset;
    }
    const missingFlashes = B.filter(b => !used.has(b)).map(b => b.t);
    // 0905 (Codex medium): between two long-mark pairs every short mark looks alike, so a mark missing or extra there (or a
    // long mark paired with a short one) means the sound may have slipped by whole seconds and been paired with the
    // neighbouring second's flash. Such a stretch, from the long pair before it to the long pair after it, is ambiguous:
    // its pairs are marked and the verdict cannot be "in step". A mark missing only at the very start or end of the
    // file (cut by the recording) is not evidence of a slip.
    // 0906 (Codex medium): only a mark that could really have been cut by the track's edge is exempt: its expected onset
    // at or before the track's first reading (lit already, no onset seen), or the mark still lit at its last (a mark still lit at the end has no length,
    // so onsets() leaves it out). A long mark paired with a short one is always evidence.
    const markSec = (long) => (long ? 0.3 : 0.1) + 0.05;
    const cut = (onset, long, from, to) => (from !== null && from !== undefined && onset <= from) || (to !== null && to !== undefined && onset + markSec(long) > to);
    const offsetNear = (t) => {
        let best = null;
        for (const pr of pairs) if (!best || Math.abs(pr.t - t) < Math.abs(best.t - t)) best = pr;
        return best ? best.offsetMs / 1000 : coarse;
    };
    const suspects = [
        ...missingBeepAt.filter(m => !cut(m.expectAt, m.long, beepStart, beepEnd)).map(m => m.t),
        ...B.filter(b => !used.has(b)).filter(b => !cut(b.t - offsetNear(b.t), b.long, flashStart, flashEnd)).map(b => b.t),
        ...mismatchAt
    ].sort((x, y) => x - y);
    const anchors = pairs.filter(pr => pr.anchor).map(pr => pr.t);
    const ambiguousIntervals = [];
    for (const t of suspects) {
        const from = anchors.filter(a => a <= t).pop() ?? (start ?? -Infinity);
        const to = anchors.find(a => a > t) ?? (end ?? Infinity);
        const last = ambiguousIntervals[ambiguousIntervals.length - 1];
        if (last && from <= last.to) last.to = Math.max(last.to, to);
        else ambiguousIntervals.push({ from, to });
    }
    for (const pr of pairs) if (ambiguousIntervals.some(iv => pr.t > iv.from && pr.t < iv.to)) pr.ambiguous = true;
    const json = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    return { pairs, missingBeeps, missingFlashes, kindMismatches, ambiguous, coarseMs: round1(coarse * 1000),
        ambiguousIntervals: ambiguousIntervals.map(iv => ({ from: json(iv.from), to: json(iv.to) })) };
}

/** Least-squares slope of offset over time, in ms per minute (null with fewer than 2 pairs or no time span). */
function driftMsPerMin(pairs) {
    if (pairs.length < 2) return null;
    const n = pairs.length;
    const mt = pairs.reduce((s, p) => s + p.t, 0) / n;
    const mo = pairs.reduce((s, p) => s + p.offsetMs, 0) / n;
    let num = 0, den = 0;
    for (const p of pairs) { num += (p.t - mt) * (p.offsetMs - mo); den += (p.t - mt) ** 2; }
    return den > 0 ? round1((num / den) * 60) : null;
}

/** The first time the offset leaves ±limitMs and stays out for forSec or more (null if it never does). */
function firstOutOfStep(pairs, limitMs = OUT_OF_STEP_MS, forSec = OUT_OF_STEP_FOR_SEC) {
    let start = null;
    for (const p of pairs) {
        if (Math.abs(p.offsetMs) > limitMs) {
            if (start === null) start = p.t;
            if (p.t - start >= forSec) return round1(start);
        } else start = null;
    }
    return null;
}

/** The summary of a pairing, with events (each { t, label }) marked by the median offset 5 s before and after. */
function summarise(result, events = []) {
    const offs = result.pairs.map(p => p.offsetMs);
    const worst = offs.length ? offs.reduce((w, x) => (Math.abs(x) > Math.abs(w) ? x : w), 0) : null;
    const window = (from, to) => median(result.pairs.filter(p => p.t >= from && p.t < to).map(p => p.offsetMs));
    return {
        pairs: offs.length,
        medianMs: round1(median(offs)),
        minMs: offs.length ? offs.reduce((m, x) => (x < m ? x : m), Infinity) : null,
        maxMs: offs.length ? offs.reduce((m, x) => (x > m ? x : m), -Infinity) : null,
        worstMs: worst,
        driftMsPerMin: driftMsPerMin(result.pairs),
        firstOutOfStepSec: firstOutOfStep(result.pairs),
        missingBeeps: result.missingBeeps.length,
        missingFlashes: result.missingFlashes.length,
        kindMismatches: result.kindMismatches,
        wholeSecondAmbiguous: result.ambiguous,
        ambiguousIntervals: result.ambiguousIntervals || [],
        // In step only when every stretch is unambiguous and nothing left ±80 ms for 5 s.
        verdict: !offs.length ? 'no pairs' : result.ambiguous || (result.ambiguousIntervals || []).length ? 'ambiguous'
            : firstOutOfStep(result.pairs) !== null ? 'out of step' : 'in step',
        events: events.map(e => ({ t: e.t, label: e.label || null, beforeMs: round1(window(e.t - 5, e.t)), afterMs: round1(window(e.t, e.t + 5)) }))
    };
}

// ---- reading a file ----------------------------------------------------------------------------------------

function parseCorner(text) {
    const parts = String(text).split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0) || !parts[2] || !parts[3]) throw new Error('--corner takes x,y,w,h in pixels');
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function parseTime(text) {
    const parts = String(text).split(':').map(Number);
    if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((s, n) => s * 60 + n, 0);
}

/** An events file: `<time> [label]` a line; blank lines and # comments skipped. */
function parseEvents(text) {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const [time, ...label] = line.split(/\s+/);
        const t = parseTime(time);
        if (t === null) throw new Error('a line of the events file does not start with a time');
        out.push({ t, label: scrub(label.join(' ')) || null });
    }
    return out.sort((a, b) => a.t - b.t);
}

/** `frame:N pts:X pts_time:T` then `key=value` lines (ffmpeg's metadata print) -> [{ t, v }]. */
function parseMetadataPrint(text, key) {
    const out = [];
    let t = null;
    for (const line of String(text).split(/\r?\n/)) {
        const m = /pts_time:(-?[0-9.]+)/.exec(line);
        if (m) { t = Number(m[1]); continue; }
        const eq = line.indexOf('=');
        if (t !== null && eq > 0 && line.slice(0, eq) === key) {
            const raw = line.slice(eq + 1).trim();
            const v = raw === '-inf' ? -200 : Number(raw);
            out.push({ t, v: Number.isFinite(v) ? v : -200 });
            t = null;
        }
    }
    return out;
}

/** An error whose message is ours and fixed: safe to print. */
const fixed = (text) => Object.assign(new Error(text), { fixed: true });

/** Why a file or a tool failed, as a fixed phrase keyed on the error code: never the error's own text (it holds the path). */
function reasonOf(err) {
    if (err && err.fixed) return err.message;
    switch (err && err.code) {
        case 'ENOENT': return 'not found';
        case 'EACCES': case 'EPERM': return 'not readable (permission denied)';
        case 'EISDIR': return 'a folder, not a file';
        default: return 'could not be read';
    }
}

/** The last line of a tool's error output, with anything path- or address-like replaced. */
const lastLine = (stderr) => scrub(String(stderr || '').trim().split('\n').pop())
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:'"]+)+/g, '<path>').slice(0, 160);

function hasStream(file, type) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', type, '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    if (r.error) throw fixed(r.error.code === 'ENOENT' ? 'ffprobe was not found on the PATH' : 'ffprobe could not be run');
    return r.status === 0 && r.stdout.trim().length > 0;
}

/** Run ffmpeg once over the file: the brightness series and (with sound) the beep band's level series. */
function readSeries(file, { corner = null } = {}) {
    const video = hasStream(file, 'v');
    const audio = hasStream(file, 'a');
    if (!video) throw fixed('the file has no picture (or ffprobe could not read it)');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-avsync-'));
    const vOut = path.join(work, 'v.txt');
    const aOut = path.join(work, 'a.txt');
    // In a filtergraph a path's ':' and '\' must be escaped; the temp folder is ours, but be safe anyway.
    const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
    const crop = corner ? `crop=${corner.w}:${corner.h}:${corner.x}:${corner.y},` : '';
    const graph = [`[0:v:0]${crop}scale=32:18,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=${esc(vOut)}[v]`];
    if (audio) {
        graph.push(`[0:a:0]aresample=48000,pan=mono|c0=c0,bandpass=f=1760:width_type=h:w=200,asetnsamples=n=${WINDOW}:p=0,` +
            `astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${esc(aOut)}[a]`);
    }
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-filter_complex', graph.join(';'),
        '-map', '[v]', ...(audio ? ['-map', '[a]'] : []), '-f', 'null', '-'];
    try {
        const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (r.error) throw fixed(r.error.code === 'ENOENT' ? 'ffmpeg was not found on the PATH' : 'ffmpeg could not be run');
        if (r.status !== 0) throw fixed(`ffmpeg could not read the file (${lastLine(r.stderr)})`);
        const luma = parseMetadataPrint(fs.readFileSync(vOut, 'utf8'), 'lavfi.signalstats.YAVG');
        const level = audio ? parseMetadataPrint(fs.readFileSync(aOut, 'utf8'), 'lavfi.astats.Overall.RMS_level') : null;
        return { luma, level };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** The first and last reading of a series, in one pass (a 25-minute capture has ~300,000: never spread into a call). */
function seriesBounds(series) {
    let start = null, end = null;
    for (const { t } of series) {
        if (start === null || t < start) start = t;
        if (end === null || t > end) end = t;
    }
    return { start, end };
}

/** The whole measurement of one file: { flashes, beeps, result, summary, audio }. */
function measure(file, { corner = null, events = [] } = {}) {
    const { luma, level } = readSeries(file, { corner });
    const flashes = onsets(luma, { minSpread: 20 });
    if (!level) return { audio: false, flashes, beeps: [], result: null, summary: null };
    const beeps = onsets(level, { minSpread: 12 }); // dB
    const v = seriesBounds(luma);
    const a = seriesBounds(level);
    const result = pairOnsets(flashes, beeps, { flashStart: v.start, flashEnd: v.end, beepStart: a.start, beepEnd: a.end });
    return { audio: true, flashes, beeps, result, summary: summarise(result, events) };
}

// ---- the command line --------------------------------------------------------------------------------------------

const USAGE = 'Usage: node scripts/avsync-meter.js <file> [--corner x,y,w,h] [--events <file>] [--quiet]';

function parseArgs(argv) {
    const o = { file: null, corner: null, events: null, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { o.help = true; continue; }
        if (a === '--quiet') { o.quiet = true; continue; }
        if (a === '--corner' || a === '--events') {
            if (i + 1 >= argv.length) throw new Error('--corner and --events need a value');
            if (a === '--corner') o.corner = parseCorner(argv[++i]); else o.events = argv[++i];
            continue;
        }
        // Never the argument's text: it may hold an address (--events=<URL>).
        if (a.startsWith('-')) throw new Error('Unknown option (not shown).');
        if (o.file) throw new Error('One file at a time');
        o.file = a;
    }
    return o;
}

function main(argv = process.argv.slice(2), out = console.log) {
    let o;
    try { o = parseArgs(argv); } catch (e) { out(e.message); out(USAGE); return 2; }
    if (o.help || !o.file) { out(USAGE); return o.help ? 0 : 2; }
    // Never a stream address: a real provider is never measured, and the address is never echoed.
    if (isUrl(o.file) || (o.events && isUrl(o.events))) { out('avsync-meter reads files only: never run it against a URL or a real provider.'); return 2; }
    let stat = null;
    try { stat = fs.statSync(o.file); } catch { /* reported below */ }
    if (!stat || !stat.isFile()) { out('No such file.'); return 2; }
    let events = [];
    let eventsText = null;
    try { if (o.events) eventsText = fs.readFileSync(o.events, 'utf8'); } catch (e) { out(`The events file is ${reasonOf(e)}.`); return 2; }
    try { if (eventsText !== null) events = parseEvents(eventsText); } catch (e) { out(`The events file could not be used: ${reasonOf(fixed(e.message))}.`); return 2; }
    let m;
    try { m = measure(o.file, { corner: o.corner, events }); } catch (e) { out(`avsync-meter: ${reasonOf(e)}.`); return 1; }
    const name = scrub(path.basename(o.file));
    if (!m.audio) {
        out(`${name}: no sound in this file; picture onsets only (${m.flashes.length}):`);
        if (!o.quiet) for (const f of m.flashes) out(`flash t=${f.t.toFixed(3)}${f.long ? ' long' : ''}`);
        out(`AVSYNC ${JSON.stringify({ file: name, audio: false, flashes: m.flashes.length, flashTimes: m.flashes.map(f => round1(f.t * 1000) / 1000) })}`);
        return 0;
    }
    if (!o.quiet) {
        let e = 0;
        for (const p of m.result.pairs) {
            const marks = [];
            while (e < events.length && events[e].t <= p.t) marks.push(events[e++]);
            for (const ev of marks) out(`-- event t=${ev.t.toFixed(1)}${ev.label ? ` ${ev.label}` : ''}`);
            out(`t=${p.t.toFixed(3)} offset_ms=${p.offsetMs}${p.long ? ' (long)' : ''}${p.ambiguous ? ' (ambiguous)' : ''}`);
        }
    }
    const s = m.summary;
    out(`${name}: ${s.pairs} pairs (${m.flashes.length} flashes, ${m.beeps.length} beeps); sound minus picture median ${s.medianMs} ms, ` +
        `min ${s.minMs}, max ${s.maxMs}, worst ${s.worstMs}, drift ${s.driftMsPerMin} ms/min; ` +
        (s.firstOutOfStepSec === null ? `never out of ±${OUT_OF_STEP_MS} ms for ${OUT_OF_STEP_FOR_SEC} s` : `out of ±${OUT_OF_STEP_MS} ms from t=${s.firstOutOfStepSec} s`) +
        (s.missingBeeps || s.missingFlashes ? `; unpaired: ${s.missingBeeps} flashes without a beep, ${s.missingFlashes} beeps without a flash` : '') +
        (s.wholeSecondAmbiguous ? '; no long marks paired, so a whole-second slip cannot be ruled out' : '') +
        (s.ambiguousIntervals.length ? `; ${s.ambiguousIntervals.length} stretch(es) where marks are missing or extra, so a whole-second slip cannot be ruled out there` : '') +
        `; verdict: ${s.verdict}`);
    out(`AVSYNC ${JSON.stringify({ file: name, audio: true, ...s })}`);
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { scrub, reasonOf, seriesBounds, onsets, pairOnsets, summarise, driftMsPerMin, firstOutOfStep, parseEvents, parseMetadataPrint, measure, main, isUrl };
