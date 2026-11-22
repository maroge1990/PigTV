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

const CAP = 2000;
const MAX_LINE = 1000;
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function createRing({ cap = CAP, maxLine = MAX_LINE } = {}) {
    const lines = [];
    let seq = 0;
    return {
        cap, maxLine,
        push(level, args) {
            let text;
            try { text = util.format(...args); } catch { text = '[a line that could not be printed]'; }
            text = String(stripUrls(text));
            if (text.length > maxLine) text = `${text.slice(0, maxLine)}…`;
            lines.push({ seq: ++seq, at: Date.now(), level, text });
            if (lines.length > cap) lines.splice(0, lines.length - cap);
        },
        /** The kept lines after cursor `after` (a seq; 0 or none = all), oldest first. */
        since(after = 0) {
            const n = Number(after) || 0;
            return n > 0 ? lines.filter(l => l.seq > n) : lines.slice();
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

module.exports = { CAP, MAX_LINE, createRing, ring, install };
