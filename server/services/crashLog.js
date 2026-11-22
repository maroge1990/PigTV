/**
 * #44 (0896): what happens when the server crashes.
 *
 * Before this, nothing listened for 'uncaughtException' or 'unhandledRejection': Node printed the error with its
 * full, unredacted message and stack (a provider URL included, when the error quoted one) and exited 1, and nothing
 * was left to say it had happened. The behaviour stays "exit non-zero and let the container's restart policy start
 * PigTV again" (no restart delay or retry here: the container owns that), but on the way out the process now
 *
 *   1. writes ONE record, synchronously, to data/crashes.jsonl (JSON lines, append-only, the newest KEEP kept):
 *      time, build, kind, error name, the message through stripUrls() (redact() plus every URL and host removed),
 *      the top few stack frames (the "at ..." lines only, app paths made relative), uptime, and how many playback
 *      sessions and recordings were active (counts only);
 *   2. logs one redacted line;
 *   3. exits with code 1.
 *
 * The Status page reads summary(): crashes in the last 24 h and the last one's time, kind and error name (never the
 * message). A missing or corrupt file reads as the valid lines in it, so it can never stop a start.
 */
const fs = require('fs');
const path = require('path');
const { stripUrls } = require('../redact');

const KEEP = 50;
const FRAMES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const APP_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FILE = path.join(APP_ROOT, 'data', 'crashes.jsonl');

let cached = null; // { file, records } read once: the file only changes when this process is about to exit
let installed = false;

/** The valid records in the file, oldest first. Never throws. */
function read({ file = DEFAULT_FILE } = {}) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            if (rec && typeof rec === 'object' && Number.isFinite(rec.at)) out.push(rec);
        } catch { /* a torn or corrupt line is skipped */ }
    }
    return out;
}

/** Append one record (sync), then cut the file back to the newest KEEP. Never throws. */
function write(rec, { file = DEFAULT_FILE } = {}) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
        const all = read({ file });
        // Also rewritten when a corrupt line is in it, so a torn write does not linger.
        const lineCount = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        if (all.length > KEEP || lineCount !== all.length) {
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, all.slice(-KEEP).map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
            fs.renameSync(tmp, file);
        }
    } catch { /* a full or read-only disk: the exit still happens */ }
    cached = null;
}

/** Counts only, and only from modules already loaded: a crash handler must not load (or start) anything. */
function activeCounts() {
    const loaded = (rel) => require.cache[require.resolve(rel)] ? require(rel) : null;
    let sessions = 0, recordings = 0;
    try { sessions = loaded('./transcodeSession')?.getAllSessions().length || 0; } catch { /* unknown: 0 */ }
    try { recordings = loaded('./recordingEngine')?.listActive().length || 0; } catch { /* unknown: 0 */ }
    return { sessions, recordings };
}

function frames(err) {
    const stack = typeof err?.stack === 'string' ? err.stack : '';
    return stack.split('\n').map(l => l.trim()).filter(l => l.startsWith('at ')).slice(0, FRAMES)
        .map(l => stripUrls(l.split(APP_ROOT + path.sep).join('').replace(/file:\/\//g, '')).slice(0, 200));
}

function buildRecord(kind, err, { now = Date.now() } = {}) {
    const isError = err instanceof Error || (err && typeof err === 'object' && 'message' in err);
    let build = 'unknown';
    try { build = require('../version').build; } catch { /* no package.json beside a sandbox copy */ }
    return {
        at: now,
        build,
        kind,
        name: String(isError ? (err.name || 'Error') : typeof err).slice(0, 60),
        message: String(stripUrls(isError ? err.message : String(err)) || '').slice(0, 300),
        stack: frames(err),
        uptimeSec: Math.round(process.uptime()),
        active: activeCounts()
    };
}

/** Install the two handlers (once). `file` is for tests. */
function install({ file = DEFAULT_FILE } = {}) {
    if (installed) return;
    installed = true;
    let handling = false;
    const onFatal = (kind) => (err) => {
        if (handling) return;
        handling = true;
        try {
            const rec = buildRecord(kind, err);
            write(rec, { file });
            console.error(`[Crash] ${kind}: ${rec.name}: ${rec.message} (recorded in data/${path.basename(file)}; exiting so the container restarts PigTV)`);
        } catch { /* exit regardless */ }
        process.exit(1);
    };
    process.on('uncaughtException', onFatal('uncaughtException'));
    process.on('unhandledRejection', onFatal('unhandledRejection'));
}

/** For Status: { last24h, lastAt, lastName, lastKind } (no message). */
function summary({ file = DEFAULT_FILE, now = Date.now() } = {}) {
    if (!cached || cached.file !== file) cached = { file, records: read({ file }) };
    const recs = cached.records;
    const last = recs[recs.length - 1] || null;
    return {
        last24h: recs.filter(r => now - r.at >= 0 && now - r.at < DAY_MS).length,
        lastAt: last ? last.at : null,
        lastName: last ? String(last.name || 'Error').slice(0, 60) : null,
        lastKind: last ? String(last.kind || '').slice(0, 40) || null : null
    };
}

/** At start: one log line when there were crashes in the last 24 h. Never throws. */
function noteStartup({ file = DEFAULT_FILE } = {}) {
    try {
        const s = summary({ file });
        if (s.last24h) console.warn(`[Crash] Started after a crash: ${s.last24h} in the last 24 h, the last at ${new Date(s.lastAt).toISOString()} (${s.lastName}).`);
        return s;
    } catch { return null; }
}

module.exports = { KEEP, read, write, buildRecord, install, summary, noteStartup, _reset: () => { cached = null; } };
