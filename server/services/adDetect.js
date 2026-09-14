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

let available = null; // cached: null unknown, true/false once checked

/**
 * Is Comskip present? The Dockerfile allows its build to fail, so this must
 * never be assumed.
 */
function isAvailable() {
    if (available !== null) return Promise.resolve(available);
    return new Promise((resolve) => {
        execFile('comskip', ['--help'], { timeout: 5000 }, (err) => {
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
 * Detect breaks in a file.
 *
 * @returns {Promise<{ok: boolean, breaks: Array, error?: string}>}
 */
async function detect(filePath, { iniPath, timeoutMs = 30 * 60 * 1000 } = {}) {
    if (!(await isAvailable())) {
        return { ok: false, breaks: [], error: 'Comskip is not installed in this image' };
    }
    if (!fs.existsSync(filePath)) {
        return { ok: false, breaks: [], error: 'Recording file is missing' };
    }

    // Work in a temporary directory so Comskip's several output files never
    // land beside the recording.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comskip-'));
    const args = [];

    const ini = iniPath || DEFAULT_INI;
    if (fs.existsSync(ini)) args.push(`--ini=${ini}`);
    args.push(`--output=${outDir}`, filePath);

    const result = await new Promise((resolve) => {
        let proc;
        try {
            proc = spawn('comskip', args);
        } catch (err) {
            return resolve({ code: -1, tail: [err.message] });
        }

        const tail = [];
        const keep = (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) { tail.push(line.trim()); if (tail.length > 20) tail.shift(); }
            }
        };
        proc.stdout.on('data', keep);
        proc.stderr.on('data', keep);

        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
            resolve({ code: -1, tail: [...tail, `Timed out after ${Math.round(timeoutMs / 60000)} minutes`] });
        }, timeoutMs);

        proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, tail: [err.message] }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code, tail }); });
    });

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

module.exports = { detect, isAvailable, parseEdl, DEFAULT_INI };
