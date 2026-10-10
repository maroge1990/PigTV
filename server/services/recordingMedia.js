/**
 * Recordings, as files the Apple client can play (split out of recordingEngine.js in the
 * simplification build): the ffmpeg/ffprobe tooling, the MP4 remux, native playback on
 * demand, and the preparation queue that does it ahead of the first Play (0193, 0203).
 * recordingEngine.js re-exports everything here; it owns capture and scheduling.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { recordings: recordingsDb } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');
const jobs = require('./recordingJobs');

// The binaries, set by recordingEngine.init (server/index.js finds them); plain names until then.
const tools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
function setToolPaths({ ffmpegPath, ffprobePath } = {}) {
    if (ffmpegPath) tools.ffmpegPath = ffmpegPath;
    if (ffprobePath) tools.ffprobePath = ffprobePath;
}

/**
 * Free space on the filesystem holding `dir`, in GB. Returns null when the
 * platform or Node build cannot report it, in which case callers skip the
 * check rather than refusing to record.
 */
function getFreeSpaceGB(dir) {
    try {
        if (typeof fs.statfsSync !== 'function') return null;
        const st = fs.statfsSync(dir);
        return (st.bavail * st.bsize) / (1024 ** 3);
    } catch (err) {
        console.warn('[Recordings] Could not determine free space:', err.message);
        return null;
    }
}

function fileSizeOf(file) {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
}

function compressionTargetPath(originalPath) {
    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, path.extname(originalPath));
    return path.join(dir, `${base}.compressed.mp4`);
}

function probeDuration(filePath) {
    return new Promise((resolve) => {
        let out = '';
        let proc;
        try {
            proc = spawn(tools.ffprobePath, [
                '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', filePath
            ]);
        } catch (e) {
            return resolve(null);
        }
        proc.stdout.on('data', d => { out += d; });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const v = parseFloat(out.trim());
            resolve(Number.isFinite(v) ? v : null);
        });
    });
}

// ---------------------------------------------------------------------------
// Native playback (Apple client) support
//
// A recording is captured as a stream copy of the live MPEG-TS source into a
// .mkv container (see startRecording above) — AVPlayer has no Matroska
// demuxer at all, so /:id/stream (raw MKV, browser-only) is unusable for a
// native client regardless of the codecs inside it. This produces an
// MP4-family file the way the live pipeline does for the same problem: copy
// both streams, no re-encode, container change only.
//
// Done ahead of time since 0192 (see "Preparation ahead of the first Play"
// below): it used to wait for the first Play, which then paid for converting the
// whole file. Play still prepares on demand when the queue has not got there.
// ---------------------------------------------------------------------------

// A probe that never returns would stall the native-playback request behind it,
// and a hostile or corrupt file could make ffprobe emit without bound; both
// limits end in the same "unknown codecs" answer the caller already handles.
const PROBE_CODECS_TIMEOUT_MS = 30000;
const PROBE_CODECS_MAX_OUTPUT = 1024 * 1024;

// JSON, read by field name. The earlier `-of csv=p=0` parse assumed the columns
// came out in the order they were requested, but ffprobe prints them in its own
// order (codec_name,codec_type) and does not promise otherwise, so the swapped
// fields meant neither codec was ever recognised and the HEVC tag and MP2->AAC
// re-encode in buildNativeRemuxArgs never applied. Resolves nulls on any failure.
function probeCodecs(filePath) {
    return new Promise((resolve) => {
        const none = { video: null, audio: null };
        let out = '';
        let proc;
        let timer;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const kill = () => { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } };
        try {
            proc = spawn(tools.ffprobePath, [
                '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels',
                '-of', 'json', filePath
            ]);
        } catch (e) {
            return finish(none);
        }
        timer = setTimeout(() => { kill(); finish(none); }, PROBE_CODECS_TIMEOUT_MS);
        proc.stdout.on('data', d => {
            if (settled) return;
            out += d;
            if (out.length > PROBE_CODECS_MAX_OUTPUT) { kill(); finish(none); }
        });
        proc.on('error', () => finish(none));
        proc.on('close', () => {
            const result = { video: null, audio: null };
            try {
                const streams = JSON.parse(out).streams;
                for (const s of Array.isArray(streams) ? streams : []) {
                    if (!s || typeof s.codec_name !== 'string') continue;
                    if (s.codec_type === 'video' && !result.video) result.video = s.codec_name;
                    if (s.codec_type === 'audio' && !result.audio) {
                        result.audio = s.codec_name;
                        if (Number.isFinite(s.channels)) result.audioChannels = s.channels;
                    }
                }
            } catch (e) {
                return finish(none);
            }
            finish(result);
        });
    });
}

function nativePlaybackTargetPath(originalPath) {
    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, path.extname(originalPath));
    return path.join(dir, `${base}.native.mp4`);
}

/**
 * A file already in native-compatible shape, if one exists, without doing
 * any work. Two cases already produce one: compression itself outputs an
 * MP4 (H.264/HEVC + AAC, +faststart) and, when "keep original" is off,
 * rec.file_path is updated to point straight at it. When "keep original" is
 * on, the compressed file exists on disk but rec.file_path still points at
 * the .mkv it was compressed from — checked for here so that setting
 * doesn't cause a redundant second remux of the same content.
 */
function readyNativePlaybackPath(rec) {
    const original = rec.file_path;
    if (path.extname(original).toLowerCase() === '.mp4') return original;

    // 0192 (audit R08): only once compression has finished and verified it. The
    // encode now writes under a temporary name, but a file left in place by an
    // older version's interrupted encode must not be served either.
    const compressed = compressionTargetPath(original);
    if (rec.compress_status === 'done' && fs.existsSync(compressed)) return compressed;

    return null;
}

/**
 * Resolve (remuxing on first call, reusing the result after) a
 * native-compatible MP4 for this recording. Returns the file path to serve.
 */
/**
 * The ffmpeg arguments for a stream-copy remux of a recording into an
 * AVPlayer-playable MP4. Pure, so the flag decisions can be tested.
 */
function buildNativeRemuxArgs(input, output, codecs = {}) {
    const video = (codecs.video || '').toLowerCase();
    const audio = (codecs.audio || '').toLowerCase();
    const args = ['-y', '-nostdin', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];

    // AVFoundation refuses HEVC in MP4 unless it is tagged hvc1; ffmpeg's
    // default for a stream copy is hev1. Both live pipelines already tag it.
    if (video === 'hevc' || video === 'h265') args.push('-tag:v', 'hvc1');

    // 0203: only AC-3 / E-AC-3 are copied. Everything else - every AAC flavour, MP2 - is
    // re-encoded to AAC-LC. A copied AAC track gets ONE Audio Specific Config for the whole
    // MP4, taken from its first frame, but broadcast audio changes mid-programme (HE-AAC
    // around the ad breaks, a different rate or channel count): every frame after the
    // change was then decoded with the wrong config - silent on the Apple TV, playback
    // stopping, Comskip failing (recording #5, 4 Oct). In the .mkv each ADTS frame carries
    // its own header, so decoding from it and encoding once is right whatever changes.
    // aresample=async absorbs the gaps and jumps a reconnect leaves. Audio is small: this
    // costs seconds per hour of recording. MP2 (DVB) was already re-encoded for AVPlayer.
    if (audio && audio !== 'ac3' && audio !== 'eac3') {
        const channels = Math.min(Math.max(parseInt(codecs.audioChannels, 10) || 2, 1), 6);
        args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', String(channels),
            '-b:a', channels > 2 ? '384k' : '192k', '-af', 'aresample=async=1:first_pts=0');
    }

    // -f is explicit because the output is written under a temporary name.
    args.push('-movflags', '+faststart', '-f', 'mp4', output);
    return args;
}

// 0192 (audit R08): how long an ffmpeg writing a file may go without that file
// growing before it is presumed stuck (a hung SMB read, a wedged decoder) and
// killed. Generous: +faststart's final pass rewrites the file without growing it.
const FFMPEG_STALL_MS = 10 * 60 * 1000;

/**
 * Run ffmpeg, resolving { code, tail } once it exits. With `watchFile`, it is also
 * killed if that file stops growing for `stallMs`, so one stuck job cannot hold
 * its queue (and the recording it belongs to) forever.
 */
function runFfmpegCollectingTail(args, { watchFile = null, stallMs = FFMPEG_STALL_MS } = {}) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(tools.ffmpegPath, args);
        } catch (err) {
            return resolve({ code: -1, tail: [err.message] });
        }
        const tail = [];
        let watchdog = null;
        if (watchFile) {
            let lastSize = -1;
            let lastGrowth = Date.now();
            watchdog = setInterval(() => {
                const size = fileSizeOf(watchFile);
                if (size > lastSize) { lastSize = size; lastGrowth = Date.now(); return; }
                if (Date.now() - lastGrowth < stallMs) return;
                tail.push(`Stopped: ${path.basename(watchFile)} did not grow for ${Math.round(stallMs / 1000)}s`);
                clearInterval(watchdog);
                try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
            }, Math.min(30 * 1000, stallMs));
            if (watchdog.unref) watchdog.unref();
        }
        proc.stderr.on('data', d => {
            for (const line of d.toString().split('\n')) {
                if (line.trim()) { tail.push(line.trim()); if (tail.length > 20) tail.shift(); }
            }
        });
        const done = (code) => { if (watchdog) clearInterval(watchdog); resolve({ code, tail }); };
        proc.on('error', (err) => { tail.push(err.message); done(-1); });
        proc.on('close', (c) => done(c));
    });
}

// The external processes behind native playback, behind one object so tests can
// stand in for ffmpeg/ffprobe.
/**
 * 0203: how many errors decoding a file's first audio track produces (ffmpeg -v error, one
 * line each), or null when it could not be run. Reads the whole file, so it runs once per
 * preparation; audio only, which is cheap to decode.
 */
function countAudioDecodeErrors(file) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(tools.ffmpegPath, ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'null', '-']);
        } catch (e) {
            return resolve(null);
        }
        let lines = 0;
        let rest = '';
        proc.stderr.on('data', d => {
            const parts = (rest + d).split('\n');
            rest = parts.pop();
            lines += parts.filter(l => l.trim()).length;
        });
        proc.on('error', () => resolve(null));
        proc.on('close', (code) => resolve(code === 0 || lines > 0 ? lines + (rest.trim() ? 1 : 0) : null));
    });
}

const nativeTools = { ffmpeg: runFfmpegCollectingTail, codecs: probeCodecs, duration: probeDuration, audioErrors: countAudioDecodeErrors, startGraceMs: null };

// recordingId -> Promise<path> of a remux in progress. Two requests for the
// same recording (the client's /playback and then /media.mp4, or two devices)
// share one ffmpeg instead of both writing the same file.
const nativeRemuxes = new Map();
// Sidecars already confirmed complete this run, so a Range request for a
// segment of the file does not spawn ffprobe every time.
const verifiedNativeFiles = new Set();

/**
 * Is an existing .native.mp4 a whole file? Output is now only ever produced by
 * an atomic rename, so anything this version wrote is complete. This exists for
 * files left by earlier versions, which wrote in place: a remux killed part-way
 * (container restart, SMB hiccup) left a file with no index that looked
 * finished forever. With +faststart the index is only moved to the front at the
 * very end, so an unfinished file has no readable duration.
 */
async function nativeFileIsComplete(file) {
    if (verifiedNativeFiles.has(file)) return true;
    const duration = await nativeTools.duration(file);
    if (duration && duration > 0) {
        verifiedNativeFiles.add(file);
        return true;
    }
    return false;
}

async function ensureNativePlayback(rec) {
    const ready = readyNativePlaybackPath(rec);
    if (ready) return ready;

    const input = rec.file_path;
    if (!fs.existsSync(input)) {
        throw new Error('Recording file is missing');
    }

    const output = nativePlaybackTargetPath(input);
    if (fs.existsSync(output)) {
        if (await nativeFileIsComplete(output)) return output;
        console.warn(`[Recordings] Discarding incomplete native file for #${rec.id}: ${output}`);
        try { fs.unlinkSync(output); } catch (e) { /* remade below */ }
    }

    let job = nativeRemuxes.get(rec.id);
    if (!job) {
        job = remuxForNativePlayback(rec, input, output).finally(() => nativeRemuxes.delete(rec.id));
        nativeRemuxes.set(rec.id, job);
    }
    return job;
}

// ---------------------------------------------------------------------------
// Native playback, polling flavour
//
// ensureNativePlayback() above makes the caller wait for the remux. That is fine for a
// browser but not for the Apple client: its URLSession gives up after 35 s, and a big
// recording over SMB takes longer, so it timed out while the server carried on and then
// asked again. This lets a client start the remux, go away, and ask how it is getting on.
// ---------------------------------------------------------------------------

const nativeStarts = new Map();     // recording id -> the background attempt (never rejects)
const nativeFailures = new Map();   // recording id -> { reason }, held until someone is told
const NATIVE_START_GRACE_MS = 1500;

/**
 * Where preparing this recording for the Apple client stands:
 *   { state: 'ready' }                        the file can be served now
 *   { state: 'preparing' }                    a remux is running
 *   { state: 'failed', reason }               the last attempt failed - reported once, then forgotten,
 *                                             so asking again after being told starts a fresh attempt
 *   { state: 'idle' }                         nothing has been started
 */
function pollNativePlayback(rec) {
    if (readyNativePlaybackPath(rec) || verifiedNativeFiles.has(nativePlaybackTargetPath(rec.file_path))) {
        return { state: 'ready' };
    }
    if (nativeStarts.has(rec.id) || nativeRemuxes.has(rec.id)) return { state: 'preparing' };
    const failure = nativeFailures.get(rec.id);
    if (failure) {
        nativeFailures.delete(rec.id);
        return { state: 'failed', reason: failure.reason };
    }
    return { state: 'idle' };
}

/**
 * Begin preparing the recording in the background and return at once (or after a moment,
 * see startNativePlaybackAndWait). Concurrent callers share one attempt.
 */
function startNativePlayback(rec) {
    let attempt = nativeStarts.get(rec.id);
    if (!attempt) {
        attempt = ensureNativePlayback(rec).then(
            () => { nativeFailures.delete(rec.id); },
            (err) => {
                // Detail belongs in the log, not in what a client is shown.
                console.error(`[Recordings] Could not prepare #${rec.id} for native playback: ${err.message}`);
                nativeFailures.set(rec.id, { reason: err.message === 'Recording file is missing' ? 'file-missing' : 'remux-failed' });
            }
        ).finally(() => nativeStarts.delete(rec.id));
        nativeStarts.set(rec.id, attempt);
    }
    return attempt;
}

/**
 * Start (if nothing is running) and give it a short moment. A file that only needs its
 * checking - the usual case once a recording has been prepared before - is done inside the
 * grace period, so the caller can answer "ready" instead of sending a client round again.
 */
async function startNativePlaybackAndWait(rec, graceMs = nativeTools.startGraceMs ?? NATIVE_START_GRACE_MS) {
    const attempt = startNativePlayback(rec);
    let timer;
    await Promise.race([attempt, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
    return pollNativePlayback(rec);
}

async function remuxForNativePlayback(rec, input, output) {
    // Written under a temporary name and renamed into place, so the final name
    // only ever refers to a finished file. Anything already at the temporary
    // name is debris from a remux that was killed; no other remux of this
    // recording can be running (see nativeRemuxes).
    const partial = `${output}.partial`;
    try { fs.unlinkSync(partial); } catch (e) { /* none */ }

    const codecs = await nativeTools.codecs(input);
    const args = buildNativeRemuxArgs(input, partial, codecs);

    console.log(`[Recordings] Remuxing #${rec.id} for native playback -> ${output}`);
    const result = await nativeTools.ffmpeg(args, { watchFile: partial });

    if (result.code !== 0 || !fs.existsSync(partial)) {
        try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
        console.error(`[Recordings] Native remux of #${rec.id} failed:\n  ${result.tail.join('\n  ')}`);
        throw new Error(result.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${result.code}`);
    }

    fs.renameSync(partial, output);
    verifiedNativeFiles.add(output);
    console.log(`[Recordings] #${rec.id} ready for native playback`);
    return output;
}

// ---------------------------------------------------------------------------
// Preparation ahead of the first Play (0192, audit R06)
//
// The remux above used to wait for someone to press Play, so the first viewing of
// a fresh recording paid for converting the whole file (a minute or more over
// SMB). Every finished recording is now queued for it as soon as it completes, and
// the library recorded before this version is worked through behind it.
//
// Once the MP4 is checked against the original (same length, a video track, an
// audio track if the original had one) it becomes the recording: renamed to
// "<name>.mp4" beside the capture, the row pointed at it, and the capture (.ts since 0203,
// .mkv before) deleted. The capture itself is what survives being cut off -
// and an original whose length cannot be read (an interrupted capture has no
// duration in its header) is kept rather than deleted on an unverifiable check.
//
// One at a time. A running recording outranks it: while one is capturing, only
// recordings finished in the last day are prepared (they are the ones about to be
// watched), and the backlog waits. Play still prepares on demand at once, sharing
// the same remux (nativeRemuxes) if the queue already started it.
//
// ---------------------------------------------------------------------------

const NATIVE_MAX_ATTEMPTS = 3;
// 0203: preparations made before this (copied audio, no decode check) are redone where the .mkv is still there.
const NATIVE_VERSION = 2;
const NATIVE_FRESH_MS = 24 * 60 * 60 * 1000;
let preparingNative = false;

// Test seam only: a test whose fake ffmpeg counts every start turns the queue off.
let prepareQueueOn = true;
function _setPrepareQueue(on) { prepareQueueOn = on !== false; }

/** Where a recording's MP4 lives once it has replaced the .mkv: "<name>.mp4" beside it. */
function preparedTargetPath(originalPath) {
    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, path.extname(originalPath));
    return path.join(dir, `${base}.mp4`);
}

/**
 * Does `prepared` stand in for `original`? Same length (within 5%), a video track,
 * and audio if the original has audio. { ok, keepOriginal, reason }: keepOriginal
 * means it plays but could not be checked against the original, so the original
 * stays.
 */
async function checkPrepared(original, prepared) {
    const [srcDuration, outDuration, srcCodecs, outCodecs] = await Promise.all([
        nativeTools.duration(original), nativeTools.duration(prepared),
        nativeTools.codecs(original), nativeTools.codecs(prepared)
    ]);
    if (!(outDuration > 0)) return { ok: false, reason: 'the prepared file has no readable length' };
    if (!outCodecs.video) return { ok: false, reason: 'the prepared file has no video' };
    if (srcCodecs.audio && !outCodecs.audio) return { ok: false, reason: 'the prepared file lost the audio' };
    if (!(srcDuration > 0)) return { ok: true, keepOriginal: true, reason: "the original's length could not be read" };
    if (outDuration < srcDuration * 0.95) {
        return { ok: false, reason: `the prepared file is short (${Math.round(outDuration)}s of ${Math.round(srcDuration)}s)` };
    }
    // 0203: and it must actually DECODE as well as the original. Length and track checks
    // passed recording #5 (4 Oct) whose copied HE-AAC audio failed from ~3 minutes on, and
    // its .mkv was deleted. Relative, because broadcast audio has the odd glitch of its own.
    if (outCodecs.audio) {
        const [srcErrors, outErrors] = await Promise.all([nativeTools.audioErrors(original), nativeTools.audioErrors(prepared)]);
        if (outErrors === null || srcErrors === null) {
            return { ok: true, keepOriginal: true, reason: 'the audio could not be decode-checked' };
        }
        if (outErrors > srcErrors + 5) {
            return { ok: false, reason: `the prepared file's audio does not decode (${outErrors} errors, the original ${srcErrors})` };
        }
    }
    return { ok: true, keepOriginal: false };
}

/**
 * Make `prepared` the recording: rename it to "<name>.mp4", point the row at it,
 * then delete the original. The row moves before the original goes, so a crash in
 * between leaves a spare .mkv, never a row pointing at nothing; a restart finds
 * "<name>.mp4" already there and finishes the job.
 */
function adoptPrepared(rec, prepared) {
    const original = rec.file_path;
    let target = preparedTargetPath(original);
    if (prepared !== target) {
        if (fs.existsSync(target)) {
            // Not ours (a stray file of the same name): leave it, keep the .native.mp4 name.
            target = prepared;
        } else {
            fs.renameSync(prepared, target);
            verifiedNativeFiles.delete(prepared);
        }
    }
    verifiedNativeFiles.add(target);
    const size = fileSizeOf(target);
    getDb().prepare('UPDATE recordings SET file_path = ?, file_size_bytes = ? WHERE id = ?').run(target, size || null, rec.id);
    recordingsDb.setNativeStatus(rec.id, 'ready');
    recordingsDb.setNativeVersion(rec.id, NATIVE_VERSION);
    try {
        fs.unlinkSync(original);
        console.log(`[Recordings] #${rec.id} is now ${path.basename(target)}; the .mkv it was made from is deleted`);
    } catch (err) {
        console.warn(`[Recordings] #${rec.id} is now ${path.basename(target)}, but ${path.basename(original)} could not be deleted: ${err.message}`);
    }
    verifiedNativeFiles.delete(original);
}

/** One recording through preparation. Never throws: the outcome is in its row. */
async function prepareRecording(rec) {
    const original = rec.file_path;
    if (!original || !fs.existsSync(original)) {
        // Possibly a crash after the rename and the row update but before the delete.
        recordingsDb.setNativeStatus(rec.id, 'failed', { error: 'Recording file is missing' });
        return;
    }
    // Already playable as it is (compressed, or recorded before as MP4): nothing to make.
    if (path.extname(original).toLowerCase() === '.mp4') {
        recordingsDb.setNativeStatus(rec.id, 'ready');
        recordingsDb.setNativeVersion(rec.id, NATIVE_VERSION);
        return;
    }

    recordingsDb.setNativeStatus(rec.id, 'preparing', { attempt: true });
    try {
        // A restart between the rename and the row update leaves "<name>.mp4" made
        // already; anything else at that name is checked like any other result.
        const leftover = preparedTargetPath(original);
        let prepared = fs.existsSync(leftover) && await nativeFileIsComplete(leftover) ? leftover : null;
        if (!prepared) {
            const free = getFreeSpaceGB(path.dirname(original));
            const needGB = fileSizeOf(original) / (1024 ** 3) * 1.05;
            if (free !== null && free < needGB + 1) {
                throw new Error(`Not enough free space to prepare it (${free.toFixed(1)} GB free, ${needGB.toFixed(1)} GB needed)`);
            }
            prepared = await ensureNativePlayback(rec);
        }
        // Compression already made a playable MP4 beside it ("keep original"): it is
        // served from there and the original is compression's to keep.
        if (prepared !== nativePlaybackTargetPath(original) && prepared !== leftover) {
            recordingsDb.setNativeStatus(rec.id, 'ready');
            recordingsDb.setNativeVersion(rec.id, NATIVE_VERSION);
            return;
        }

        const check = await checkPrepared(original, prepared);
        if (!check.ok) {
            // Not served as if it were the recording: a later Play remuxes afresh.
            try { fs.unlinkSync(prepared); } catch (e) { /* already gone */ }
            verifiedNativeFiles.delete(prepared);
            throw new Error(`Prepared file failed its check: ${check.reason}`);
        }
        if (check.keepOriginal) {
            console.warn(`[Recordings] #${rec.id} is ready, but its original is kept: ${check.reason}`);
            recordingsDb.setNativeStatus(rec.id, 'ready', { error: `Original kept: ${check.reason}` });
            recordingsDb.setNativeVersion(rec.id, NATIVE_VERSION);
            return;
        }
        adoptPrepared(recordingsDb.getById(rec.id) || rec, prepared);
    } catch (err) {
        const attempts = (recordingsDb.getById(rec.id)?.native_attempts) || 0;
        const giveUp = attempts >= NATIVE_MAX_ATTEMPTS || err.message === 'Recording file is missing';
        console.error(`[Recordings] Could not prepare #${rec.id} (attempt ${attempts}): ${err.message}`);
        recordingsDb.setNativeStatus(rec.id, giveUp ? 'failed' : 'pending', { error: err.message });
    }
}

/** The next waiting recording, if any may be prepared now; see the section comment. */
async function processNativeQueue(now = Date.now()) {
    if (preparingNative || !prepareQueueOn) return;
    const pending = recordingsDb.findPendingNative()
        // Never touch files another job is reading; it is picked up afterwards.
        .filter(r => r.id !== jobs.compressing && r.id !== jobs.detecting && !jobs.liveDetecting.has(r.id)) // 0207: nor one live detection is still reading
        // Capture first: with a recording running only fresh ones go ahead.
        .filter(r => jobs.capturing() === 0 || (r.ended_at && now - r.ended_at < NATIVE_FRESH_MS));
    if (pending.length === 0) return;

    preparingNative = true;
    jobs.preparing = pending[0].id;
    try {
        await prepareRecording(pending[0]);
    } finally {
        preparingNative = false;
        jobs.preparing = null;
    }
}

/** R16: the preparation queue for the Status page: counts by state and the recording being prepared now. */
function nativeQueueStatus() {
    const summary = recordingsDb.nativeQueueSummary();
    let current = null;
    if (jobs.preparing !== null) {
        const rec = recordingsDb.getById(jobs.preparing);
        current = { id: jobs.preparing, title: rec?.title || null };
    }
    return { ...summary, current, enabled: prepareQueueOn };
}

module.exports = {
    tools, setToolPaths,
    fileSizeOf, getFreeSpaceGB, compressionTargetPath, nativePlaybackTargetPath, preparedTargetPath,
    probeCodecs, probeDuration, buildNativeRemuxArgs, runFfmpegCollectingTail, nativeTools, verifiedNativeFiles,
    ensureNativePlayback, pollNativePlayback, startNativePlayback, startNativePlaybackAndWait,
    prepareRecording, processNativeQueue, nativeQueueStatus,
    NATIVE_VERSION, _setPrepareQueue, isPrepareQueueOn: () => prepareQueueOn
};
