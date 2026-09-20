#!/usr/bin/env node
/**
 * Playback report: turns saved `docker logs pigtv` output into a comparison of the
 * delivery paths (remux vs the opt-in HLS session), for the HLS delivery trial (blueprint §C).
 *
 *   docker logs pigtv --since 24h > pigtv-today.log
 *   node scripts/playback-report.js pigtv-today.log [more.log ...]
 *   docker logs pigtv 2>&1 | node scripts/playback-report.js          (or from stdin)
 *
 * It reads only lines the server already writes: `[Player] play-start`, `[Player] play-end`,
 * `[Playback] resolve timing`, `[Player] media-error` / `start-timeout`, and a few ffmpeg-side
 * failure messages. It changes nothing and needs no dependencies.
 *
 * Plays from a paired device (the Apple client) are reported on their own lines, marked
 * "[Apple/device]", and never count towards the web player's HLS trial criteria.
 *
 * Limits, on purpose: the log never names a channel, so "how many different channels" can't be
 * counted from it - keep that tally yourself. A play-start is paired with the nearest earlier
 * `resolve timing` line of the same kind to tell a cold play (the stream had to be probed) from
 * a warm one (the probe was cached); with one viewer that is reliable, with several it is a guess.
 */
'use strict';

const fs = require('node:fs');

// The pass criteria from the trial plan; change them here if the plan changes.
const TARGET_PLAYS_PER_PATH = 50;
const TARGET_LONG_SESSIONS = 3;
const LONG_SESSION_SEC = 3600;

// ---------------------------------------------------------------- parsing

// "transcode(hls, video copy)" -> strategy, container, video mode
const HOW = String.raw`(\S+?)\(([^,)]*)(?:, video ([^)]*))?\) hls-delivery=(on|off)`;
const PLAY_START = new RegExp(String.raw`\[Player\] play-start via ${HOW} resolve=(\S+) first-picture=(\S+)`);
const PLAY_END = new RegExp(String.raw`\[Player\] play-end via ${HOW} watched=(\S+?)s stalls=(\S+)`);
const RESOLVE_TIMING = /\[Playback\] resolve timing: (direct|remux|HLS session), probe (cached|[\d.]+s)(?:, first segment (?:after ([\d.]+)s|(NOT produced in time)))?/;
const MEDIA_ERROR = /\[Player\] media-error (\S+?)\((\S+?)\) via (\S+) path=(\S*) msg="([^"]*)"/;
const START_TIMEOUT = /\[Player\] start-timeout via (\S+)/;
// Every client event ends with who sent it: `user:<id>` for a web login, `device:<id>` for a
// paired device (the Apple client). Devices are reported separately, so their plays never
// count towards the web player's HLS trial.
const FROM = /\bfrom=(\S+)\s*$/;
const DEVICE_SUFFIX = ' [Apple/device]';
const fromDevice = (line) => { const m = FROM.exec(line); return !!m && m[1].startsWith('device:'); };

// ffmpeg / server-side failure signatures worth counting (see the blueprint's grep lines)
const SERVER_SIGNS = [
    ['Could not write header', /Could not write header/],
    ['ffmpeg produced no output', /never produced a byte/],
    ['stalled ffmpeg killed', /treating ffmpeg as stalled/],
    ['codec probe failed', /Codec probe failed/],
    ['remux refused to start', /Not starting remux/]
];

const seconds = (text) => {
    const n = parseFloat(String(text).replace(/s$/, ''));
    return Number.isFinite(n) ? n : null;
};

/** Which comparison bucket a play belongs to. */
function pathLabel(strategy, hlsDelivery) {
    if (strategy === 'remux') return 'remux';
    if (strategy === 'direct') return 'direct';
    if (strategy === 'transcode') return hlsDelivery ? 'HLS session (opt-in)' : 'transcode (server-chosen)';
    return strategy;
}

/** The element-side `strategy` in a media-error line ('hls' means hls.js was driving). */
function errorPathLabel(via, device = false) {
    // The Apple client always asks for segmented delivery, so its transcode/hls is an HLS session.
    if (device) return pathLabel(via === 'hls' ? 'transcode' : via, true) + DEVICE_SUFFIX;
    if (via === 'hls') return 'HLS session (opt-in)';
    if (via === 'transcode') return 'transcode (server-chosen)';
    return via;
}

function parse(text) {
    const plays = [];        // { label, resolveSec, firstPictureSec, warm }
    const ends = [];         // { label, watchedSec, stalls }
    const errors = [];       // { kind, code, via, label, path, message }
    const server = Object.fromEntries(SERVER_SIGNS.map(([name]) => [name, 0]));
    let segmentTimeouts = 0;
    let lines = 0;

    // Latest un-paired `resolve timing` per kind: a play-start pairs with it, then it is spent.
    const pending = { remux: null, transcode: null, direct: null };
    const kindOf = { remux: 'remux', direct: 'direct', 'HLS session': 'transcode' };

    for (const raw of text.split(/\r?\n/)) {
        if (!raw) continue;
        lines++;
        // `docker logs -t` puts a timestamp in front of every line.
        const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '');
        let m;

        if ((m = RESOLVE_TIMING.exec(line))) {
            const kind = kindOf[m[1]];
            pending[kind] = { warm: m[2] === 'cached' };
            if (m[4]) segmentTimeouts++;
        } else if ((m = PLAY_START.exec(line))) {
            const [, strategy, , , hls, resolve, first] = m;
            const paired = pending[strategy] || null;
            if (paired) pending[strategy] = null;
            plays.push({
                label: pathLabel(strategy, hls === 'on') + (fromDevice(line) ? DEVICE_SUFFIX : ''),
                resolveSec: seconds(resolve),
                firstPictureSec: seconds(first),
                warm: paired ? paired.warm : null
            });
        } else if ((m = PLAY_END.exec(line))) {
            const [, strategy, , , hls, watched, stalls] = m;
            ends.push({ label: pathLabel(strategy, hls === 'on') + (fromDevice(line) ? DEVICE_SUFFIX : ''), watchedSec: seconds(watched), stalls: parseInt(stalls, 10) });
        } else if ((m = MEDIA_ERROR.exec(line))) {
            errors.push({ kind: 'media-error', code: m[1], via: m[3], label: errorPathLabel(m[3], fromDevice(line)), path: m[4], message: m[5] });
        } else if ((m = START_TIMEOUT.exec(line))) {
            errors.push({ kind: 'start-timeout', code: '', via: m[1], label: errorPathLabel(m[1], fromDevice(line)), path: '', message: '' });
        } else {
            for (const [name, re] of SERVER_SIGNS) if (re.test(line)) server[name]++;
        }
    }
    return { lines, plays, ends, errors, server, segmentTimeouts };
}

// ---------------------------------------------------------------- statistics

const sorted = (values) => values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
const median = (values) => {
    const s = sorted(values);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** Nearest-rank percentile. */
const percentile = (values, p) => {
    const s = sorted(values);
    if (!s.length) return null;
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const max = (values) => { const s = sorted(values); return s.length ? s[s.length - 1] : null; };

function summarise(parsed) {
    const byPath = new Map();
    const bucket = (label) => {
        if (!byPath.has(label)) byPath.set(label, { label, plays: [], ends: [], errors: [] });
        return byPath.get(label);
    };
    parsed.plays.forEach(p => bucket(p.label).plays.push(p));
    parsed.ends.forEach(e => bucket(e.label).ends.push(e));
    parsed.errors.forEach(e => bucket(e.label).errors.push(e));

    const paths = [...byPath.values()].map(b => {
        const first = b.plays.map(p => p.firstPictureSec);
        const cold = b.plays.filter(p => p.warm === false).map(p => p.firstPictureSec);
        const warm = b.plays.filter(p => p.warm === true).map(p => p.firstPictureSec);
        const watched = b.ends.reduce((sum, e) => sum + (e.watchedSec || 0), 0);
        const stalls = b.ends.reduce((sum, e) => sum + (Number.isFinite(e.stalls) ? e.stalls : 0), 0);
        return {
            label: b.label,
            plays: b.plays.length,
            firstPicture: { median: median(first), p90: percentile(first, 90), max: max(first) },
            cold: { n: cold.length, median: median(cold) },
            warm: { n: warm.length, median: median(warm) },
            sessions: b.ends.length,
            watchedSec: watched,
            stalls,
            stallsPerHour: watched >= 600 ? stalls / (watched / 3600) : null, // too little watching to say
            longSessions: b.ends.filter(e => (e.watchedSec || 0) >= LONG_SESSION_SEC).length,
            longestSec: max(b.ends.map(e => e.watchedSec)),
            errors: b.errors
        };
    });
    // Compared paths first, in a stable order.
    const order = ['remux', 'HLS session (opt-in)'];
    paths.sort((a, b) => {
        const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
    });
    return paths;
}

// ---------------------------------------------------------------- output

const fmt = (n, digits = 1) => (n == null ? '  -' : n.toFixed(digits));
const pad = (text, width) => String(text).padEnd(width);
const padL = (text, width) => String(text).padStart(width);
const duration = (sec) => {
    if (sec == null) return '-';
    if (sec < 90) return `${Math.round(sec)}s`;
    if (sec < 5400) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
};

function report(parsed) {
    const paths = summarise(parsed);
    const out = [];
    out.push(`PigTV playback report - ${parsed.lines} log lines, ${parsed.plays.length} plays started, ${parsed.ends.length} watched for 10 s or more`);
    out.push('');

    if (!paths.length) {
        out.push('No play-start / play-end lines found. Is this a docker log from build 0075 or later, and was');
        out.push('the HLS Delivery (beta) toggle used? (`docker logs pigtv | grep play-start` should show lines.)');
        return out.join('\n');
    }

    out.push('Time to first picture (seconds; lower is faster, but stability comes first)');
    out.push(`${pad('path', 28)}${padL('plays', 6)}${padL('median', 8)}${padL('p90', 7)}${padL('max', 7)}   ${padL('cold', 11)}${padL('warm', 11)}`);
    for (const p of paths) {
        const cold = p.cold.n ? `${fmt(p.cold.median)} (n=${p.cold.n})` : '-';
        const warm = p.warm.n ? `${fmt(p.warm.median)} (n=${p.warm.n})` : '-';
        out.push(`${pad(p.label, 28)}${padL(p.plays, 6)}${padL(fmt(p.firstPicture.median), 8)}${padL(fmt(p.firstPicture.p90), 7)}${padL(fmt(p.firstPicture.max), 7)}   ${padL(cold, 11)}${padL(warm, 11)}`);
    }
    out.push('  cold = the stream had to be probed first; warm = the probe was cached (within 5 minutes of a previous play)');
    out.push('');

    out.push('How the plays went once they started (only plays watched for 10 s or more are counted)');
    out.push(`${pad('path', 28)}${padL('watched', 8)}${padL('total', 8)}${padL('stalls', 8)}${padL('per hour', 10)}${padL('longest', 9)}${padL(`>=${LONG_SESSION_SEC / 3600}h`, 6)}`);
    for (const p of paths) {
        const perHour = p.stallsPerHour == null ? 'n/a' : p.stallsPerHour.toFixed(1);
        out.push(`${pad(p.label, 28)}${padL(p.sessions, 8)}${padL(duration(p.watchedSec), 8)}${padL(p.stalls, 8)}${padL(perHour, 10)}${padL(duration(p.longestSec), 9)}${padL(p.longSessions, 6)}`);
    }
    out.push('  per hour is shown only once a path has 10 minutes or more of watching behind it');
    out.push('');

    out.push('Failures the player reported');
    const anyErrors = paths.some(p => p.errors.length);
    if (!anyErrors) out.push('  none');
    for (const p of paths) {
        if (!p.errors.length) continue;
        const counts = {};
        p.errors.forEach(e => { const k = e.kind === 'start-timeout' ? 'start-timeout' : e.code; counts[k] = (counts[k] || 0) + 1; });
        out.push(`  ${p.label}: ${Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(', ')}`);
    }
    out.push('Failures on the server side');
    const serverFailures = Object.entries(parsed.server).filter(([, n]) => n);
    if (parsed.segmentTimeouts) serverFailures.push(['HLS first segment not produced in time', parsed.segmentTimeouts]);
    if (!serverFailures.length) out.push('  none');
    serverFailures.forEach(([name, n]) => out.push(`  ${name}: ${n}`));
    out.push('');

    // The pass criteria from the trial plan.
    const remux = paths.find(p => p.label === 'remux');
    const hls = paths.find(p => p.label === 'HLS session (opt-in)');
    out.push('Against the trial criteria');
    const tick = (ok) => (ok ? '[ok]  ' : '[    ]');
    for (const p of [remux, hls]) {
        if (!p) continue;
        out.push(`  ${tick(p.plays >= TARGET_PLAYS_PER_PATH)} ${p.label}: ${p.plays} plays (aim for ${TARGET_PLAYS_PER_PATH}+)`);
    }
    if (hls) {
        out.push(`  ${tick(hls.longSessions >= TARGET_LONG_SESSIONS)} HLS sessions of ${LONG_SESSION_SEC / 3600}h or more: ${hls.longSessions} (aim for ${TARGET_LONG_SESSIONS}+)`);
        const hlsErrors = hls.errors.length + parsed.segmentTimeouts;
        out.push(`  ${tick(hlsErrors === 0)} failures that happen on HLS: ${hlsErrors}${hlsErrors ? ' - each needs an explanation, or to fail on remux too' : ''}`);
        if (remux && hls.stallsPerHour != null && remux.stallsPerHour != null) {
            out.push(`  ${tick(hls.stallsPerHour <= remux.stallsPerHour)} stalls per hour: HLS ${hls.stallsPerHour.toFixed(1)} vs remux ${remux.stallsPerHour.toFixed(1)} (HLS should be no worse)`);
        } else {
            out.push('  [    ] stalls per hour: not enough watching on both paths yet to compare');
        }
    } else {
        out.push('  [    ] no HLS-session plays in this log - was the toggle on for the browser you used?');
    }
    out.push('  Also by hand: no leftover ffmpeg after stopping, the provider slot frees, /app/transcode-cache does not grow,');
    out.push('  and 10+ different channels tried (the log never names a channel, so that tally is yours).');

    // Each HLS-side failure, verbatim enough to act on.
    if (hls && hls.errors.length) {
        out.push('');
        out.push('HLS failures in detail');
        hls.errors.slice(0, 20).forEach(e => out.push(`  ${e.kind} ${e.code} ${e.path} ${e.message}`.trimEnd()));
        if (hls.errors.length > 20) out.push(`  ... and ${hls.errors.length - 20} more`);
    }
    return out.join('\n');
}

module.exports = { parse, summarise, report, median, percentile, pathLabel };

if (require.main === module) {
    const files = process.argv.slice(2);
    const text = files.length
        ? files.map(f => fs.readFileSync(f, 'utf8')).join('\n')
        : fs.readFileSync(0, 'utf8');
    console.log(report(parse(text)));
}
