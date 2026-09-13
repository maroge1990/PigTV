/**
 * DVR Recording Engine
 *
 * A persistent, server-side scheduler + ffmpeg process manager for EPG-based
 * scheduled recordings. This is intentionally separate from transcodeSession.js:
 * that module serves short-lived per-viewer HLS sessions tied to a browser tab,
 * while this one runs independently of any client connection (recordings must
 * keep going whether or not anyone is watching, and must resume correctly
 * across container restarts as long as the schedule itself is still in the future).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sources: sourcesDb } = require('../db');
const { scheduled: scheduledDb, recordings: recordingsDb } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('./xtreamApi');

const TICK_INTERVAL_MS = 15 * 1000;
const STDERR_TAIL_LINES = 40;

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';
let tickTimer = null;
let tickRunning = false;
// scheduledId -> { proc, recordingId, hardStopTimer, stderrTail: [] }
const active = new Map();

function sanitizeForFs(str) {
    return String(str || 'Untitled')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'Untitled';
}

async function getSettings() {
    const { settings } = require('../db');
    return settings.get();
}

async function getRecordingsRoot() {
    const settings = await getSettings();
    const root = settings.recordingsPath || '/app/recordings';
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
    }
    return root;
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

/**
 * True when there is enough room to start or continue recording.
 * `factor` lets the mid-recording check use a lower bar than the pre-flight
 * one, so an in-progress recording is not killed the moment it dips under the
 * threshold that would have blocked a new one.
 */
function hasFreeSpace(dir, minGB, factor = 1) {
    const freeGB = getFreeSpaceGB(dir);
    if (freeGB === null) return { ok: true, freeGB: null };
    return { ok: freeGB >= (minGB * factor), freeGB };
}

function uniqueFilePath(dir, baseName, ext) {
    let candidate = path.join(dir, `${baseName}${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${baseName} (${n})${ext}`);
        n++;
    }
    return candidate;
}

/**
 * Resolve a playable stream URL for a channel, mirroring the logic used by
 * the proxy/transcode routes for M3U (SQLite-backed) and Xtream sources.
 */
async function resolveStreamUrl(sourceId, channelItemId) {
    const source = await sourcesDb.getById(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    if (source.type === 'xtream') {
        const api = xtreamApi.createFromSource(source);
        return api.buildStreamUrl(channelItemId, 'live', 'ts');
    }

    // M3U (and anything else synced into playlist_items) - stream URL lives in
    // the stored item data (see syncService.saveStreams / m3uParser).
    //
    // The client identifies a channel by its composite id (m3u_<source>_<item>),
    // which is what the EPG row carries, but playlist_items stores the bare
    // item_id. Accept either, and the fully-qualified `id` column too, so a
    // schedule stored by any of those forms still resolves.
    const db = getDb();
    const raw = String(channelItemId);
    const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');

    const item = db.prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live'
          AND (item_id = ? OR item_id = ? OR id = ?)
        LIMIT 1
    `).get(sourceId, raw, stripped, `${sourceId}:${stripped}`);

    if (!item) throw new Error(`Channel ${channelItemId} not found for source ${sourceId}`);

    if (item.stream_url) return item.stream_url;

    try {
        const data = JSON.parse(item.data || '{}');
        if (data.url) return data.url;
        if (data.stream_url) return data.stream_url;
    } catch (e) { /* fall through */ }

    throw new Error(`No stream URL available for channel ${channelItemId}`);
}

async function scheduleFromProgram({
    sourceId, channelItemId, channelName, channelLogo,
    title, description, programStart, programEnd,
    preBufferMin, postBufferMin, createdBy
}) {
    if (!sourceId || !channelItemId) throw new Error('sourceId and channelItemId are required');
    // Store the bare item_id, not the client's composite m3u_<source>_<item>
    channelItemId = String(channelItemId).replace(/^(?:m3u|xtream)_\d+_/, '');
    if (!programStart || !programEnd || programEnd <= programStart) {
        throw new Error('Valid programStart/programEnd are required');
    }

    const settings = await getSettings();
    const pre = Number.isFinite(preBufferMin) ? preBufferMin : settings.defaultPreBufferMin;
    const post = Number.isFinite(postBufferMin) ? postBufferMin : settings.defaultPostBufferMin;

    const existing = scheduledDb.findByProgram(sourceId, String(channelItemId), programStart);
    if (existing) return existing;

    return scheduledDb.create({
        title: title || 'Untitled Program',
        description: description || null,
        source_id: sourceId,
        channel_item_id: String(channelItemId),
        channel_name: channelName || null,
        channel_logo: channelLogo || null,
        program_start: programStart,
        program_end: programEnd,
        pre_buffer_min: pre,
        post_buffer_min: post,
        created_by: createdBy || null,
        created_at: Date.now()
    });
}

function listScheduled() {
    return scheduledDb.listUpcoming();
}

// ---------------------------------------------------------------------------
// Post-record compression
//
// A recording is a stream copy, so its size is whatever the provider sent —
// around 4 GB/hour at typical broadcast bitrates, which is more than you want
// to keep or to push over a remote connection. Re-encoding afterwards rather
// than during means a bad encode costs you nothing: the original is only
// removed once the result has been verified.
//
// One at a time, and never while a recording is running: the GPU and the disk
// are both better spent on capture.
// ---------------------------------------------------------------------------

let compressing = false;

function compressionTargetPath(originalPath) {
    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, path.extname(originalPath));
    return path.join(dir, `${base}.compressed.mp4`);
}

/**
 * Map a target bitrate onto a constant quantiser.
 *
 * Intel VAAPI on this class of iGPU supports CQP only — asking for a bitrate
 * fails outright with "Driver does not support any RC mode compatible with
 * selected options". CQP does not target a size, so this is a rough
 * correspondence for 1080p: lower QP means better quality and a bigger file.
 */
function bitrateToQp(bitrateKbps) {
    if (bitrateKbps >= 8000) return 20;
    if (bitrateKbps >= 6000) return 22;
    if (bitrateKbps >= 4000) return 24;
    if (bitrateKbps >= 3000) return 26;
    if (bitrateKbps >= 2000) return 28;
    return 30;
}

function buildCompressArgs(input, output, settings, { forceCqp = false } = {}) {
    const codec = settings.postRecordCodec === 'hevc' ? 'hevc' : 'h264';
    const bitrate = Math.max(500, parseInt(settings.postRecordBitrateKbps, 10) || 3000);
    const useVaapi = settings.hwEncoder === 'vaapi';

    const args = ['-y', '-nostdin'];

    if (useVaapi) {
        args.push(
            '-hwaccel', 'vaapi',
            '-hwaccel_device', '/dev/dri/renderD128',
            '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
            '-filter_hw_device', 'va'
        );
    }

    args.push('-i', input, '-map', '0:v:0?', '-map', '0:a?', '-sn', '-dn');

    if (useVaapi) {
        args.push(
            '-vf', 'format=nv12,hwupload',
            '-c:v', codec === 'hevc' ? 'hevc_vaapi' : 'h264_vaapi'
        );
        if (forceCqp) {
            args.push('-rc_mode', 'CQP', '-qp', String(bitrateToQp(bitrate)));
        } else {
            args.push(
                '-b:v', `${bitrate}k`,
                '-maxrate', `${Math.round(bitrate * 1.5)}k`,
                '-bufsize', `${bitrate * 2}k`
            );
        }
    } else {
        args.push(
            '-c:v', codec === 'hevc' ? 'libx265' : 'libx264',
            '-preset', 'veryfast',
            '-b:v', `${bitrate}k`
        );
    }

    // Audio is already small; re-encode only to guarantee a browser-safe track.
    args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ac', '2');
    args.push('-movflags', '+faststart', output);
    return args;
}

function probeDuration(filePath) {
    return new Promise((resolve) => {
        let out = '';
        let proc;
        try {
            proc = spawn(ffprobePath, [
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

async function compressRecording(rec, settings) {
    const input = rec.file_path;
    const output = compressionTargetPath(input);

    if (!fs.existsSync(input)) {
        recordingsDb.setCompressStatus(rec.id, 'failed', { error: 'Original file is missing' });
        return;
    }

    const originalSize = fs.statSync(input).size;
    const sourceDuration = await probeDuration(input);

    recordingsDb.setCompressStatus(rec.id, 'running', { originalSize });
    console.log(`[Recordings] Compressing #${rec.id} (${(originalSize / 1e9).toFixed(2)} GB)`);

    const runEncode = (opts) => new Promise((resolve) => {
        const args = buildCompressArgs(input, output, settings, opts);
        let proc;
        try {
            proc = spawn(ffmpegPath, args);
        } catch (err) {
            return resolve({ code: -1, tail: [err.message] });
        }
        const tail = [];
        proc.stderr.on('data', d => {
            for (const line of d.toString().split('\n')) {
                if (line.trim()) { tail.push(line.trim()); if (tail.length > 20) tail.shift(); }
            }
        });
        proc.on('error', (err) => resolve({ code: -1, tail: [err.message] }));
        proc.on('close', (c) => resolve({ code: c, tail }));
    });

    let result = await runEncode({});

    // Some VAAPI drivers implement constant-quantiser rate control only and
    // reject a bitrate target outright. Retry once in CQP rather than leaving
    // the recording uncompressed.
    if (result.code !== 0 && result.tail.some(l => l.includes('RC mode'))) {
        console.log(`[Recordings] Encoder wants constant quality; retrying #${rec.id} in CQP`);
        try { fs.unlinkSync(output); } catch (e) { /* nothing to clean */ }
        result = await runEncode({ forceCqp: true });
    }

    const code = result.code;
    if (code !== 0 || !fs.existsSync(output)) {
        console.error(`[Recordings] Compression of #${rec.id} failed:\n  ${result.tail.join('\n  ')}`);
        try { fs.unlinkSync(output); } catch (e) { /* nothing to clean */ }
        recordingsDb.setCompressStatus(rec.id, 'failed', {
            error: result.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${code}`
        });
        return;
    }

    // Verify before trusting it. A truncated encode is worse than a large file,
    // so the original is only replaced when the result covers the same span.
    const newDuration = await probeDuration(output);
    const newSize = fs.statSync(output).size;
    const durationOk = !sourceDuration || !newDuration || (newDuration >= sourceDuration * 0.95);

    if (!durationOk || newSize < 1024) {
        try { fs.unlinkSync(output); } catch (e) { /* ignore */ }
        recordingsDb.setCompressStatus(rec.id, 'failed', {
            error: `Result failed verification (${Math.round(newDuration || 0)}s vs ${Math.round(sourceDuration || 0)}s)`
        });
        return;
    }

    if (newSize >= originalSize) {
        // Re-encoding made it bigger, which happens on already-efficient
        // sources. Keep the original and say so.
        try { fs.unlinkSync(output); } catch (e) { /* ignore */ }
        recordingsDb.setCompressStatus(rec.id, 'skipped', { error: 'Compressed file was no smaller' });
        console.log(`[Recordings] #${rec.id} left as-is; compression saved nothing`);
        return;
    }

    if (settings.postRecordKeepOriginal === true) {
        recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: originalSize });
        console.log(`[Recordings] #${rec.id} compressed alongside the original`);
        return;
    }

    try {
        fs.unlinkSync(input);
    } catch (err) {
        recordingsDb.setCompressStatus(rec.id, 'failed', { error: `Could not remove original: ${err.message}` });
        return;
    }

    recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: newSize, filePath: output });
    const saved = ((1 - newSize / originalSize) * 100).toFixed(0);
    console.log(`[Recordings] #${rec.id} compressed: ${(originalSize / 1e9).toFixed(2)} GB -> ${(newSize / 1e9).toFixed(2)} GB (${saved}% smaller)`);
}

async function processCompressionQueue({ manual = false } = {}) {
    if (compressing) return;
    if (active.size > 0) return; // never compete with an active recording

    const settings = await getSettings();
    // The automatic sweep respects the setting; an explicit request from the
    // Recordings page does not, because the user has just asked for it.
    if (!manual && settings.postRecordCompress !== true) return;

    const pending = recordingsDb.findPendingCompression();
    if (pending.length === 0) return;

    compressing = true;
    try {
        await compressRecording(pending[0], settings);
    } catch (err) {
        console.error('[Recordings] Compression error:', err.message);
        recordingsDb.setCompressStatus(pending[0].id, 'failed', { error: err.message });
    } finally {
        compressing = false;
    }
}

function listActive() {
    return scheduledDb.findActive();
}

function listRecordings() {
    return recordingsDb.listAll();
}

async function cancelScheduled(id) {
    const schedule = scheduledDb.getById(id);
    if (!schedule) throw new Error('Scheduled recording not found');

    if (schedule.status === 'recording' && active.has(id)) {
        await stopRecording(id, 'cancelled');
    } else if (schedule.status === 'scheduled') {
        scheduledDb.cancel(id);
    }
    return scheduledDb.getById(id);
}

async function deleteRecording(id) {
    const rec = recordingsDb.getById(id);
    if (!rec) throw new Error('Recording not found');

    // If it's still actively recording, stop it first
    for (const [scheduledId, entry] of active.entries()) {
        if (entry.recordingId === id) {
            await stopRecording(scheduledId, 'deleted');
            break;
        }
    }

    if (rec.file_path && fs.existsSync(rec.file_path)) {
        try { fs.unlinkSync(rec.file_path); } catch (e) {
            console.warn('[Recordings] Failed to delete file:', e.message);
        }
    }
    recordingsDb.delete(id);
}

async function startRecording(schedule) {
    let streamUrl;
    try {
        streamUrl = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id);
    } catch (err) {
        console.error(`[Recordings] Could not resolve stream for schedule ${schedule.id}:`, err.message);
        scheduledDb.setStatus(schedule.id, 'failed', { error: err.message });
        return;
    }

    const root = await getRecordingsRoot();

    // Pre-flight storage check. Recordings are stream copies of live TV with
    // no size bound, so starting one on a nearly full volume is a good way to
    // take the whole share down with it.
    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    if (minFreeGB > 0) {
        const space = hasFreeSpace(root, minFreeGB);
        if (!space.ok) {
            const msg = `Only ${space.freeGB.toFixed(1)} GB free at ${root}, below the ${minFreeGB} GB minimum`;
            console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${msg}`);
            scheduledDb.setStatus(schedule.id, 'failed', { error: msg });
            return;
        }
    }

    const channelDir = path.join(root, sanitizeForFs(schedule.channel_name || 'Unknown Channel'));
    if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

    // Local time, not UTC - a 7:30pm program should read 19-30 in the filename.
    const start = new Date(schedule.program_start);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ` +
        `${pad(start.getHours())}-${pad(start.getMinutes())}`;
    const baseName = `${sanitizeForFs(schedule.title)} - ${dateStr}`;
    const outputPath = uniqueFilePath(channelDir, baseName, '.mkv');

    const recording = recordingsDb.create({
        scheduled_id: schedule.id,
        title: schedule.title,
        channel_name: schedule.channel_name,
        channel_logo: schedule.channel_logo,
        source_id: schedule.source_id,
        channel_item_id: schedule.channel_item_id,
        file_path: outputPath,
        started_at: Date.now()
    });

    scheduledDb.setStatus(schedule.id, 'recording', { recording_id: recording.id });

    const args = [
        '-y',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', streamUrl,
        // Map video and audio only. An IPTV MPEG-TS multiplex often carries
        // teletext, SCTE-35 and other private data streams that the matroska
        // muxer refuses, which would fail the whole recording. -ignore_unknown
        // covers anything ffmpeg cannot classify at all.
        '-map', '0:v?',
        '-map', '0:a?',
        '-ignore_unknown',
        '-sn', '-dn',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'matroska',
        outputPath
    ];

    console.log(`[Recordings] Starting recording #${recording.id} for schedule #${schedule.id}: "${schedule.title}" -> ${outputPath}`);

    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const entry = { proc, recordingId: recording.id, stderrTail: [], hardStopTimer: null };
    active.set(schedule.id, entry);

    proc.stderr?.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        entry.stderrTail.push(...lines);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) {
            entry.stderrTail.splice(0, entry.stderrTail.length - STDERR_TAIL_LINES);
        }
    });

    proc.on('error', (err) => {
        console.error(`[Recordings] ffmpeg process error for schedule ${schedule.id}:`, err.message);
    });

    proc.on('close', (code) => {
        finalizeRecording(schedule.id, recording.id, outputPath, code, entry.stderrTail);
    });

    // Hard stop at program end + post-buffer, in case something upstream never closes the connection
    const stopAt = schedule.program_end + (schedule.post_buffer_min * 60000);
    const msUntilStop = Math.max(0, stopAt - Date.now());
    entry.hardStopTimer = setTimeout(() => {
        console.log(`[Recordings] Scheduled stop time reached for schedule ${schedule.id}`);
        stopRecording(schedule.id, 'completed').catch(err =>
            console.error('[Recordings] Error stopping recording:', err.message));
    }, msUntilStop);
}

function finalizeRecording(scheduledId, recordingId, outputPath, exitCode, stderrTail) {
    active.delete(scheduledId);

    let fileSize = 0;
    let existedAndHasData = false;
    try {
        const stat = fs.statSync(outputPath);
        fileSize = stat.size;
        existedAndHasData = stat.size > 1024; // ignore near-empty/zero-byte failures
    } catch (e) { /* file never got created */ }

    const rec = recordingsDb.getById(recordingId);
    const startedAt = rec?.started_at || Date.now();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);

    const success = existedAndHasData; // ffmpeg often exits non-zero on a forced stop, that's fine
    recordingsDb.finish(recordingId, {
        status: success ? 'completed' : 'failed',
        ended_at: Date.now(),
        file_size_bytes: fileSize,
        duration_sec: durationSec,
        error: success ? null : (stderrTail || []).slice(-10).join('\n') || `ffmpeg exited with code ${exitCode}`
    });

    const scheduleExtra = success ? {} : { error: `Recording failed (exit code ${exitCode})` };
    scheduledDb.setStatus(scheduledId, success ? 'completed' : 'failed', scheduleExtra);

    console.log(`[Recordings] Recording #${recordingId} finished (${success ? 'completed' : 'failed'}), ${fileSize} bytes`);

    if (success) {
        // Marked pending regardless of the setting; the queue checks whether
        // compression is enabled, so turning it on later picks these up.
        try {
            recordingsDb.setCompressStatus(recordingId, 'pending');
        } catch (e) { /* column may be missing on a very old database */ }
    }
}

async function stopRecording(scheduledId, reasonStatus = 'completed') {
    const entry = active.get(scheduledId);
    if (!entry) return;

    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);

    await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        entry.proc.once('close', done);

        try {
            // Graceful stop: ffmpeg treats "q" on stdin as a request to finish
            // the output file cleanly (writes a valid mkv trailer).
            entry.proc.stdin?.write('q');
        } catch (e) {
            try { entry.proc.kill('SIGINT'); } catch (e2) { /* ignore */ }
        }

        setTimeout(() => {
            if (!resolved) {
                try { entry.proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
        }, 8000);

        setTimeout(done, 9000); // safety net so callers never hang forever
    });

    // The proc's 'close' handler registered in startRecording (finalizeRecording)
    // runs before the listener above, since it was registered first - by now the
    // recordings row and scheduled_recordings row already reflect completed/failed
    // based on whether a usable file was written. For an explicit cancel, override
    // the schedule's final status to 'cancelled' (the recording row itself stays
    // 'completed' if a usable file exists - a partial recording is still valid).
    if (reasonStatus === 'cancelled') {
        scheduledDb.setStatus(scheduledId, 'cancelled');
    }
}

/**
 * Called once at startup. Any schedule left in status 'recording' means the
 * server process that owned its ffmpeg child is gone (container restarted,
 * crashed, etc). We can't resume the child process, so mark it interrupted -
 * the partial file (if any) is left on disk for the user to keep or delete.
 */
function reconcileOnStartup() {
    const orphans = scheduledDb.findOrphanedRecording();
    for (const schedule of orphans) {
        console.warn(`[Recordings] Schedule #${schedule.id} was mid-recording when the server last stopped; marking as failed (partial file, if any, was left on disk).`);
        if (schedule.recording_id) {
            const rec = recordingsDb.getById(schedule.recording_id);
            let fileSize = null;
            try { if (rec?.file_path) fileSize = fs.statSync(rec.file_path).size; } catch (e) { /* ignore */ }
            recordingsDb.finish(schedule.recording_id, {
                status: (fileSize && fileSize > 1024) ? 'completed' : 'failed',
                ended_at: Date.now(),
                file_size_bytes: fileSize,
                duration_sec: null,
                error: 'Server restarted while this recording was in progress.'
            });
        }
        scheduledDb.setStatus(schedule.id, 'failed', { error: 'Server restarted while this recording was in progress.' });
    }

    const missed = scheduledDb.findMissed(Date.now());
    for (const schedule of missed) {
        scheduledDb.setStatus(schedule.id, 'missed', { error: 'Server was not running when this recording was due.' });
    }
}

/**
 * Stop in-progress recordings if the volume is running out of room. Uses half
 * the configured minimum as the floor, so a recording that started legitimately
 * is only killed when space is genuinely critical. The partial file is kept.
 */
async function enforceFreeSpaceDuringRecording() {
    if (active.size === 0) return;

    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    if (minFreeGB <= 0) return;

    const root = await getRecordingsRoot();
    const space = hasFreeSpace(root, minFreeGB, 0.5);
    if (space.ok) return;

    console.error(`[Recordings] Free space critical (${space.freeGB.toFixed(1)} GB at ${root}); stopping ${active.size} in-progress recording(s). Partial files are kept.`);
    for (const scheduledId of [...active.keys()]) {
        try {
            await stopRecording(scheduledId, 'completed');
            scheduledDb.setStatus(scheduledId, 'failed', { error: `Stopped early: only ${space.freeGB.toFixed(1)} GB free` });
        } catch (err) {
            console.error('[Recordings] Error stopping recording for low disk space:', err.message);
        }
    }
}

async function tick() {
    // Guard against overlap: if a previous tick is still resolving stream
    // URLs / spawning ffmpeg when the next interval fires, skip this one
    // rather than risk double-starting the same schedule.
    if (tickRunning) return;
    tickRunning = true;
    try {
        const now = Date.now();

        const due = scheduledDb.findDueToStart(now);
        for (const schedule of due) {
            // Skip if its window already fully passed (findMissed handles the log/status)
            if (schedule.program_end + (schedule.post_buffer_min * 60000) < now) continue;
            if (active.has(schedule.id)) continue;

            const settings = await getSettings();
            if (active.size >= (settings.maxConcurrentRecordings || 2)) {
                console.warn(`[Recordings] Max concurrent recordings reached, delaying schedule #${schedule.id}`);
                continue;
            }
            await startRecording(schedule);
        }

        const missed = scheduledDb.findMissed(now);
        for (const schedule of missed) {
            scheduledDb.setStatus(schedule.id, 'missed', { error: 'Recording window passed without starting.' });
        }

        await enforceFreeSpaceDuringRecording();

        // Fire and forget: compression can outlive many ticks, and the guard
        // inside stops it from starting twice.
        processCompressionQueue().catch(err =>
            console.error('[Recordings] Compression queue error:', err.message));
    } catch (err) {
        console.error('[Recordings] Scheduler tick failed:', err);
    } finally {
        tickRunning = false;
    }
}

function init({ ffmpegPath: fp, ffprobePath: pp } = {}) {
    if (fp) ffmpegPath = fp;
    if (pp) ffprobePath = pp;

    const { initSchema } = require('../db/recordingsDb');
    initSchema();

    reconcileOnStartup();

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    tick(); // run once immediately

    console.log('[Recordings] Recording engine initialized');
}

function shutdown() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
}

/**
 * Best-effort graceful stop of every in-progress recording, so the .mkv gets
 * a proper trailer written instead of being left truncated. Called from the
 * container's SIGTERM handler, which only has a limited grace period before
 * the process is killed outright - so this doesn't wait as long as a normal
 * stopRecording() call.
 */
async function stopAllActive(timeoutMs = 6000) {
    const scheduledIds = [...active.keys()];
    await Promise.all(scheduledIds.map(id =>
        Promise.race([
            stopRecording(id, 'completed'),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]).catch(() => {})
    ));
}

module.exports = {
    init,
    shutdown,
    stopAllActive,
    scheduleFromProgram,
    listScheduled,
    listActive,
    processCompressionQueue,
    listRecordings,
    cancelScheduled,
    deleteRecording,
    resolveStreamUrl
};
