/**
 * Commercial break detection.
 *
 * Runs Comskip over a finished recording and stores the breaks it finds. It
 * marks rather than cuts, deliberately: a false positive removes programme
 * content permanently and is only discovered while watching, whereas a missed
 * advert is a mild irritation. Marking is reversible, lets the detection be
 * judged against your own channels, and leaves cutting as a later choice once
 * you trust it.
 *
 * Comskip's accuracy depends heavily on tuning to a broadcaster, so expect the
 * first results to be roughly right rather than clean.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const DEFAULT_INI = '/app/config/comskip.ini';

// 0207: threads handed to Comskip (--threads, its default is 2). The deployment host is an
// i5-9500T (6 cores) and a capture is a stream copy, which costs next to nothing, so detection
// may have most of the machine.
const COMSKIP_THREADS = 4;

// 0207: a post-recording run scales with the recording (a fixed 30 minutes is too short for
// a long one); never less than the old 30 minutes.
function postTimeoutMs(durationSec) {
    return Math.max(30 * 60 * 1000, Math.round((Number(durationSec) || 0) * 0.5 * 1000));
}

// Test seam: the process spawner (a fake Comskip) and availability.
const impl = { spawn, execFile };
function _setForTests({ spawn: s, available: a } = {}) {
    impl.spawn = s || spawn;
    available = a === undefined ? null : a;
}

let available = null; // cached: null unknown, true/false once checked

/**
 * Is Comskip present? The Dockerfile allows its build to fail, so this must
 * never be assumed.
 */
function isAvailable() {
    if (available !== null) return Promise.resolve(available);
    return new Promise((resolve) => {
        impl.execFile('comskip', ['--help'], { timeout: 5000 }, (err) => {
            // Comskip exits non-zero for --help on some builds, so presence is
            // judged by whether it could be executed at all.
            available = !(err && (err.code === 'ENOENT' || err.code === 'EACCES'));
            console.log(`[AdDetect] Comskip ${available ? 'available' : 'not available'}`);
            resolve(available);
        });
    });
}

/**
 * Parse Comskip's EDL: one break per line, start and end in seconds.
 *   12.34	145.67	0
 */
function parseEdl(text) {
    const breaks = [];
    for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const start = parseFloat(parts[0]);
        const end = parseFloat(parts[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        breaks.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
    }
    return breaks;
}

/**
 * Build a run's arguments in a fresh temporary directory (so Comskip's several output
 * files never land beside the recording).
 */
function prepareRun(filePath, iniPath, { threads = COMSKIP_THREADS } = {}) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comskip-'));
    const args = [];
    const ini = iniPath || DEFAULT_INI;
    if (fs.existsSync(ini)) {
        args.push(`--ini=${ini}`);
    }
    args.push(`--threads=${threads}`, `--output=${outDir}`, filePath);
    return { outDir, args };
}

/** Run Comskip; resolves { code, tail, timedOut } and never rejects. */
function runProcess(args, { timeoutMs = null } = {}) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = impl.spawn('comskip', args);
        } catch (err) {
            return resolve({ code: -1, tail: [err.message], timedOut: false });
        }

        const tail = [];
        const keep = (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) { tail.push(line.trim()); if (tail.length > 20) tail.shift(); }
            }
        };
        proc.stdout?.on('data', keep);
        proc.stderr?.on('data', keep);

        let timer = null;
        let done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        const arm = (ms, why) => {
            if (done) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
                finish({ code: -1, tail: [...tail, why], timedOut: true });
            }, ms);
            timer.unref?.();
        };
        if (timeoutMs) arm(timeoutMs, `Timed out after ${Math.round(timeoutMs / 60000)} minutes`);

        proc.on('error', (err) => finish({ code: -1, tail: [err.message], timedOut: false }));
        proc.on('close', (code) => finish({ code, tail, timedOut: false }));
    });
}

/** Read the EDL Comskip left in outDir and remove the directory. */
function collect(outDir, filePath, result) {
    try {
        const edlFile = fs.readdirSync(outDir).find(f => f.endsWith('.edl'));

        // Comskip returns 1 when it finds no commercials, which is a result
        // rather than a failure. Only treat it as an error when no EDL was
        // produced at all.
        if (!edlFile) {
            return {
                ok: false,
                breaks: [],
                error: result.tail.slice(-3).join(' | ') || `Comskip exited with code ${result.code}`
            };
        }

        const breaks = parseEdl(fs.readFileSync(path.join(outDir, edlFile), 'utf8'));
        console.log(`[AdDetect] Found ${breaks.length} break(s) in ${path.basename(filePath)}`);
        return { ok: true, breaks };
    } catch (err) {
        return { ok: false, breaks: [], error: err.message };
    } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
}

/**
 * Detect breaks in a finished file.
 *
 * @returns {Promise<{ok: boolean, breaks: Array, error?: string, elapsedSec: number}>}
 */
async function detect(filePath, { iniPath, timeoutMs = postTimeoutMs(0), threads = COMSKIP_THREADS } = {}) {
    if (!(await isAvailable())) {
        return { ok: false, breaks: [], error: 'Comskip is not installed in this image', elapsedSec: 0 };
    }
    if (!fs.existsSync(filePath)) {
        return { ok: false, breaks: [], error: 'Recording file is missing', elapsedSec: 0 };
    }

    const started = Date.now();
    const { outDir, args } = prepareRun(filePath, iniPath, { threads });
    const result = await runProcess(args, { timeoutMs });
    return { ...collect(outDir, filePath, result), elapsedSec: Math.round((Date.now() - started) / 1000) };
}

module.exports = {
    detect, isAvailable, parseEdl, postTimeoutMs, DEFAULT_INI, COMSKIP_THREADS, _setForTests
};
