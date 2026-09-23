#!/usr/bin/env node
/**
 * Playback report: turns saved `docker logs pigtv` output into a summary of how channel starts and
 * plays went - time to first picture (cold and warm), stalls per hour, and failures.
 *
 *   docker logs pigtv --since 24h > pigtv-today.log
 *   node scripts/playback-report.js pigtv-today.log [more.log ...]
 *   docker logs pigtv 2>&1 | node scripts/playback-report.js          (or from stdin)
 *
 * It reads only lines the server already writes: `[Player] play-start`, `[Player] play-end`,
 * `[Playback] resolve timing`, `[Player] media-error` / `start-timeout`, and a few ffmpeg-side
 * failure messages. It changes nothing and needs no dependencies.
 *
 * Since 0103 there is one delivery path: every play that is not `direct` is an HLS session. (The
 * script was first written for the HLS-vs-remux trial, closed on 23 Sept 2026; an old log's remux
 * lines are still read, and reported under `remux`.) Plays from a paired device (the Apple
 * client) are reported on their own rows, marked "[Apple/device]".
 *
 * Limits, on purpose: the log never names a channel, so "how many different channels" can't be
 * counted from it - keep that tally yourself. A play-start is paired with the nearest earlier
 * `resolve timing` line of the same kind to tell a cold play (the stream had to be probed) from
 * a warm one (the probe was cached); with one viewer that is reliable, with several it is a guess.
 */
'use strict';

const fs = require('node:fs');

// A session this long or longer is counted as a long one.
const LONG_SESSION_SEC = 3600;

// ---------------------------------------------------------------- parsing

// "transcode(hls, video copy)" -> strategy, container, video mode
const HOW = String.raw`(\S+?)\(([^,)]*)(?:, video ([^)]*))?\) hls-delivery=(on|off)`;
const PLAY_START = new RegExp(String.raw`\[Player\] play-start via ${HOW} resolve=(\S+) first-picture=(\S+)`);
const PLAY_END = new RegExp(String.raw`\[Player\] play-end via ${HOW} watched=(\S+?)s stalls=(\S+)`);
const RESOLVE_TIMING = /\[Playback\] resolve timing: (direct|remux|HLS session), probe (cached|[\d.]+s)(?:, first segment (?:after ([\d.]+)s|(NOT produced in time)|(NOT produced - ffmpeg ended[^,]*)))?/;
const MEDIA_ERROR = /\[Player\] media-error (\S+?)\((\S+?)\) via (\S+) path=(\S*) msg="([^"]*)"/;
const START_TIMEOUT = /\[Player\] start-timeout via (\S+)/;
// Every client event ends with who sent it: `user:<id>` for a web login, `device:<id>` for a
// paired device (the Apple client). Devices are reported on their own rows.
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

const HLS = 'HLS session';

/** Which row a play belongs to. Every `transcode` is an HLS session since 0103, whatever the
 *  `hls-delivery=` flag an older client still sends. */
function pathLabel(strategy) {
    if (strategy === 'transcode' || strategy === 'hls') return HLS;
    return strategy;
}

/** The element-side `strategy` in a media-error line ('hls' means hls.js was driving). */
function errorPathLabel(via, device = false) {
    return pathLabel(via) + (device ? DEVICE_SUFFIX : '');
}

function parse(text) {
    const plays = [];        // { label, resolveSec, firstPictureSec, warm }
    const ends = [];         // { label, watchedSec, stalls }
    const errors = [];       // { kind, code, via, label, path, message }
    const server = Object.fromEntries(SERVER_SIGNS.map(([name]) => [name, 0]));
    let segmentTimeouts = 0;
    let startFailures = 0;
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
            if (m[5]) startFailures++;
        } else if ((m = PLAY_START.exec(line))) {
            const [, strategy, , , , resolve, first] = m;
            const paired = pending[strategy] || null;
            if (paired) pending[strategy] = null;
            plays.push({
                label: pathLabel(strategy) + (fromDevice(line) ? DEVICE_SUFFIX : ''),
                resolveSec: seconds(resolve),
                firstPictureSec: seconds(first),
                warm: paired ? paired.warm : null
            });
        } else if ((m = PLAY_END.exec(line))) {
            const [, strategy, , , , watched, stalls] = m;
            ends.push({ label: pathLabel(strategy) + (fromDevice(line) ? DEVICE_SUFFIX : ''), watchedSec: seconds(watched), stalls: parseInt(stalls, 10) });
        } else if ((m = MEDIA_ERROR.exec(line))) {
            errors.push({ kind: 'media-error', code: m[1], via: m[3], label: errorPathLabel(m[3], fromDevice(line)), path: m[4], message: m[5] });
        } else if ((m = START_TIMEOUT.exec(line))) {
            errors.push({ kind: 'start-timeout', code: '', via: m[1], label: errorPathLabel(m[1], fromDevice(line)), path: '', message: '' });
        } else {
            for (const [name, re] of SERVER_SIGNS) if (re.test(line)) server[name]++;
        }
    }
    return { lines, plays, ends, errors, server, segmentTimeouts, startFailures };
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
            cold: { n: cold.length, median: median(cold), p90: percentile(cold, 90) },
            warm: { n: warm.length, median: median(warm), p90: percentile(warm, 90) },
            sessions: b.ends.length,
            watchedSec: watched,
            stalls,
            stallsPerHour: watched >= 600 ? stalls / (watched / 3600) : null, // too little watching to say
            longSessions: b.ends.filter(e => (e.watchedSec || 0) >= LONG_SESSION_SEC).length,
            longestSec: max(b.ends.map(e => e.watchedSec)),
            errors: b.errors
        };
    });
    // The HLS session (every non-direct play) first, then the rest in a stable order.
    const order = [HLS, `${HLS}${DEVICE_SUFFIX}`];
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
        out.push('No play-start / play-end lines found. Is this a docker log from build 0075 or later?');
        out.push('(`docker logs pigtv | grep play-start` should show lines.)');
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
    if (parsed.startFailures) serverFailures.push(['HLS session ended before its first segment (e.g. the provider refused it)', parsed.startFailures]);
    if (!serverFailures.length) out.push('  none');
    serverFailures.forEach(([name, n]) => out.push(`  ${name}: ${n}`));
    out.push('');

    // The short version, one line per row: what to look at first.
    out.push('Summary');
    const firstPic = (x) => (x.n ? `median ${fmt(x.median)}s / p90 ${fmt(x.p90)}s (n=${x.n})` : '-');
    for (const p of paths) {
        const perHour = p.stallsPerHour == null ? 'n/a (under 10 min watched)' : `${p.stallsPerHour.toFixed(1)}/h`;
        out.push(`  ${p.label}: ${p.plays} plays; first picture cold ${firstPic(p.cold)}, warm ${firstPic(p.warm)}; stalls ${perHour}; player failures ${p.errors.length}`);
    }
    const serverTotal = Object.values(parsed.server).reduce((t, n) => t + n, 0) + parsed.segmentTimeouts + parsed.startFailures;
    out.push(`  server-side failures: ${serverTotal}`);
    out.push('  By hand: 10+ different channels over a day (the log never names a channel, so that tally is yours).');

    // Each failure, verbatim enough to act on.
    const failed = paths.filter(p => p.errors.length);
    if (failed.length) {
        out.push('');
        out.push('Failures in detail');
        for (const p of failed) {
            p.errors.slice(0, 20).forEach(e => out.push(`  ${p.label}: ${e.kind} ${e.code} ${e.path} ${e.message}`.trimEnd()));
            if (p.errors.length > 20) out.push(`  ${p.label}: ... and ${p.errors.length - 20} more`);
        }
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
