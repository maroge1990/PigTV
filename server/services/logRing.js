/**
 * #45 (0898): the last lines the server logged, kept in memory for the admin "Server log" panel (GET /api/status/logs),
 * so a fault can be read from the web app instead of `docker logs`.
 *
 * There is no logger in the server: every line is a console.log/info/warn/error/debug call. install() wraps those five
 * methods once: each call goes to the original method with the same arguments (stdout and stderr are unchanged), and a
 * copy is formatted as console formats it, passed through stripUrls() (redact() plus every URL, bare IPv4 address and
 * known host removed) and only then cut to MAX_LINE characters and kept. So the ring never holds a login, and a cut
 * can never leave half of one behind. CAP lines are kept, oldest dropped first: at most about CAP x MAX_LINE characters
 * (2,000 x 1,000, a few MB at worst; typical lines are ~150 characters). A restart empties it.
 */
const util = require('util');
const { stripUrls } = require('../redact');

// Review of 0898 (high), defence in depth: a line that quotes a request (JSON, headers, an inspected object) is masked too.
// An Error is kept as its name, message and top frames only: never its enumerable extras (body, config, headers, request).
const SECRET_KEY = '(?:password|passwd|pass|pwd|access_token|refresh_token|token|secret|authorization|set-cookie|cookie|api[_-]?key|apikey|x-api-key)';
// key, optional quote, : or =, then a quoted value or a run up to a separator.
const KEY_VALUE = new RegExp(`((?<![\\w-])["']?${SECRET_KEY}["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|[^\\s,;&}\\]]+)`, 'gi');
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const FRAMES = 5;

// A header written as text ("Cookie: a=1; b=2"): the whole rest of the line.
const HEADER_LINE = /((?<![\w-])(?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*)(?!["'])[^\r\n]*/gi;

function maskText(text) {
    return String(text).replace(HEADER_LINE, '$1***').replace(AUTH_SCHEME, '$1 ***').replace(KEY_VALUE, '$1***');
}

const KEY_RE = new RegExp(`^${SECRET_KEY}$`, 'i');
function safeError(err) {
    const head = `${err.name || 'Error'}: ${err.message}`;
    const frames = typeof err.stack === 'string' ? err.stack.split('\n').filter(l => /^\s+at /.test(l)).slice(0, FRAMES) : [];
    return [head, ...frames].join('\n');
}
/** A copy of a logged value with credential keys masked and Errors reduced to safeError(); plain objects and arrays only. */
function scrub(value, depth = 0) {
    if (value instanceof Error) return safeError(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 4) return '[…]';
    if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value; // a Map, Buffer, class instance: inspected, then masked as text
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = KEY_RE.test(k) ? '***' : scrub(v, depth + 1);
    return out;
}

const CAP = 2000;
// Review of 0898: names this process's ring, so a browser holding a cursor from before a restart can tell.
const GENERATION = require('crypto').randomBytes(6).toString('hex');
const MAX_LINE = 1000;
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function createRing({ cap = CAP, maxLine = MAX_LINE } = {}) {
    const lines = [];
    let seq = 0;
    return {
        cap, maxLine,
        push(level, args) {
            let text;
            try { text = util.format(...args.map(a => scrub(a))); } catch { text = '[a line that could not be printed]'; }
            text = maskText(stripUrls(text));
            if (text.length > maxLine) text = `${text.slice(0, maxLine)}…`;
            lines.push({ seq: ++seq, at: Date.now(), level, text });
            if (lines.length > cap) lines.splice(0, lines.length - cap);
        },
        /** The kept lines after cursor `after` (a seq; 0 or none = all), oldest first. */
        since(after = 0) {
            const n = Number(after) || 0;
            // Review of 0898: a cursor past the newest line is from another process (a restart): the whole ring.
            return n > 0 && n <= seq ? lines.filter(l => l.seq > n) : lines.slice();
        },
        last: () => seq
    };
}

let shared = null;
/** The ring install() feeds (created on first use). */
const ring = () => (shared ||= createRing());

/** Wrap the console methods once. Returns the ring. */
function install() {
    const r = ring();
    if (install.done) return r;
    install.done = true;
    for (const level of LEVELS) {
        const original = console[level];
        if (typeof original !== 'function') continue;
        console[level] = function (...args) {
            try { r.push(level, args); } catch { /* the ring must never stop a log line */ }
            return original.apply(this, args);
        };
    }
    return r;
}

module.exports = { CAP, MAX_LINE, GENERATION, createRing, ring, install, maskText };
