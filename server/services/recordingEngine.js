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
const { sources: sourcesDb, getUserAgent } = require('../db');
const { scheduled: scheduledDb, recordings: recordingsDb } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('./xtreamApi');
const coordinator = require('./streamCoordinator');
const { formatLocalStamp } = require('./recordingNames');
const { redact } = require('../redact');
const tunerModel = require('./tuner');
const { HlsRecorder, closeOrphanPlaylist } = require('./hlsRecorder');
const { checkRecordingsFolder, refusalMessage, onTinyFilesystem } = require('./recordingsFolder');

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

/**
 * The configured recordings folder, creating it if needed - but (0157) only the
 * final path segment, and only when its parent already exists. `mkdirSync`'s
 * `recursive: true` used to create every missing segment, which meant a stale
 * Docker bind mount (the share never actually attached, so the mount point is
 * simply an empty directory on the container's own filesystem) got a real
 * folder tree written straight into it - recordings then "succeeded" onto
 * ephemeral container storage, not the network share, and vanished on the next
 * restart with no error at all. Refusing to create anything above the final
 * folder turns that into a clear, immediate failure instead.
 */
async function getRecordingsRoot() {
    const settings = await getSettings();
    const root = settings.recordingsPath || '/app/recordings';
    if (!fs.existsSync(root)) {
        const parent = path.dirname(root);
        if (!fs.existsSync(parent)) {
            throw new Error(`The recordings folder's parent does not exist: ${parent}. Is the share mounted?`);
        }
        // 0160: nor inside a disconnected share's empty mount point, which exists
        // but sits on a tiny tmpfs (Unraid's /mnt/remotes).
        if (onTinyFilesystem(parent)) {
            throw new Error(`The recordings folder isn't reachable: ${root} does not exist and ${parent} is not on a real volume. Is the network share connected?`);
        }
        fs.mkdirSync(root);
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
/**
 * The identity of the channel a caller named, accepting the composite id the web
 * app sends and the bare one the native client does - the same forms
 * resolveStreamUrl accepts. Null when the channel is not in the playlist.
 */
function channelIdentity(sourceId, channelItemId) {
    try {
        const raw = String(channelItemId);
        const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');
        return getDb().prepare(`
            SELECT stable_id FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND (item_id = ? OR item_id = ?) LIMIT 1
        `).get(sourceId, raw, stripped)?.stable_id || null;
    } catch (e) {
        return null;   // never the reason a recording cannot be scheduled
    }
}

async function resolveStreamUrl(sourceId, channelItemId, stableId = null) {
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

    // The identity first when the schedule carries one: it is what the schedule is
    // FOR, and unlike the position it still means the same channel after a reorder.
    // Ordered by position so a channel listed in several categories resolves to the
    // same row every time.
    const item = (stableId && db.prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND stable_id = ?
        ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC
        LIMIT 1
    `).get(sourceId, stableId)) || db.prepare(`
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
        // What the schedule is FOR. Resolved now, while the playlist still says
        // where this channel is; by the time it records, the position may not.
        channel_stable_id: channelIdentity(sourceId, channelItemId),
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

const RECENT_PROBLEMS_MS = 7 * 24 * 60 * 60 * 1000; // how long a missed/failed schedule stays visible (0156)

/**
 * The upcoming/in-progress list, same as ever, plus - only when asked - schedules
 * that ended up missed or failed whose programme ended within the last 7 days
 * (0156). Without `includeRecent` the result is exactly listUpcoming(): the plain
 * route stays byte-for-byte compatible with what the Apple client already decodes.
 */
function listScheduled({ includeRecent = false } = {}) {
    const upcoming = scheduledDb.listUpcoming();
    if (!includeRecent) return upcoming;
    const recent = scheduledDb.findRecentProblems(Date.now() - RECENT_PROBLEMS_MS);
    return [...upcoming, ...recent];
}

/**
 * scheduledDb.setStatus, plus one log line per actual status change (0156).
 *
 * `schedule` is either the row already in hand (its `.status` is trusted as
 * "before", no extra query) or a bare id (the current row is read first to
 * find it). Every path that changes a schedule's status goes through this -
 * including the `missed` paths in tick() and reconcileOnStartup(), which used
 * to set the status with no log line at all - so nothing is silent. A status
 * that does not actually change is never logged (the tick's own guard around
 * `waiting` already avoided repeating that one; this covers every other
 * caller the same way, since "before" and "after" are simply compared).
 */
function setScheduleStatus(schedule, status, extra = {}) {
    const id = (typeof schedule === 'object' && schedule !== null) ? schedule.id : schedule;
    const before = (typeof schedule === 'object' && schedule !== null) ? schedule : scheduledDb.getById(id);
    const prevStatus = before?.status;
    const updated = scheduledDb.setStatus(id, status, extra);
    if (updated && prevStatus && prevStatus !== status) {
        const title = updated.title || before?.title || 'Untitled';
        const channel = updated.channel_name || before?.channel_name || 'Unknown channel';
        const reason = extra.error ? `: ${extra.error}` : '';
        console.log(`[Recordings] Schedule #${id} "${title}" (${channel}): ${prevStatus} -> ${status}${reason}`);
    }
    return updated;
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

    // AVFoundation refuses HEVC in MP4 unless it is tagged hvc1 (ffmpeg's
    // default is hev1). Both live pipelines already do this; without it a
    // HEVC-compressed recording will not play on an Apple device.
    if (codec === 'hevc') args.push('-tag:v', 'hvc1');

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

// ---------------------------------------------------------------------------
// Commercial break detection
//
// Runs before compression, on the original file: detection reads the source
// frames, and re-encoded output is a worse thing to analyse. Markers are
// time-based, so they remain valid after the file is compressed provided the
// duration is unchanged, which it is.
// ---------------------------------------------------------------------------

let detecting = false;

async function detectAdsFor(rec, settings) {
    const adDetect = require('./adDetect');

    if (!(await adDetect.isAvailable())) {
        recordingsDb.setAdDetectStatus(rec.id, 'unavailable', 'Comskip is not installed in this image');
        return;
    }

    recordingsDb.setAdDetectStatus(rec.id, 'running');
    console.log(`[Recordings] Detecting commercial breaks in #${rec.id}`);

    const result = await adDetect.detect(rec.file_path, {
        iniPath: settings.comskipIniPath || undefined
    });

    if (!result.ok) {
        recordingsDb.setAdDetectStatus(rec.id, 'failed', result.error);
        console.error(`[Recordings] Break detection failed for #${rec.id}: ${result.error}`);
        return;
    }

    recordingsDb.replaceMarkers(rec.id, result.breaks);
    recordingsDb.setAdDetectStatus(rec.id, 'done');
    console.log(`[Recordings] #${rec.id}: ${result.breaks.length} break(s) marked`);
}

async function processAdDetectionQueue({ manual = false } = {}) {
    if (detecting) return;
    if (active.size > 0) return; // never compete with an active recording

    const settings = await getSettings();
    if (!manual && settings.adDetectionEnabled !== true) return;

    const pending = recordingsDb.findPendingAdDetection();
    if (pending.length === 0) return;

    detecting = true;
    try {
        await detectAdsFor(pending[0], settings);
    } catch (err) {
        console.error('[Recordings] Break detection error:', err.message);
        recordingsDb.setAdDetectStatus(pending[0].id, 'failed', err.message);
    } finally {
        detecting = false;
    }
}

async function processCompressionQueue() {
    if (compressing) return;
    if (active.size > 0) return; // never compete with an active recording
    if (detecting) return;       // detection reads the original; let it finish first

    const settings = await getSettings();

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
// On demand rather than a background queue like compression/ad-detection:
// most recordings are only ever watched once or never, so eagerly remuxing
// every completed recording would mean processing files nobody asks for.
// ---------------------------------------------------------------------------

function probeCodecs(filePath) {
    return new Promise((resolve) => {
        let out = '';
        let proc;
        try {
            proc = spawn(ffprobePath, [
                '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
                '-of', 'csv=p=0', filePath
            ]);
        } catch (e) {
            return resolve({ video: null, audio: null });
        }
        proc.stdout.on('data', d => { out += d; });
        proc.on('error', () => resolve({ video: null, audio: null }));
        proc.on('close', () => {
            const result = { video: null, audio: null };
            for (const line of out.trim().split('\n')) {
                const [type, name] = line.split(',');
                if (type === 'video' && !result.video) result.video = name;
                if (type === 'audio' && !result.audio) result.audio = name;
            }
            resolve(result);
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

    const compressed = compressionTargetPath(original);
    if (fs.existsSync(compressed)) return compressed;

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

    if (audio.includes('aac')) {
        // Same lesson as the live pipeline: raw ADTS AAC - the framing a
        // stream-copied MPEG-TS source keeps - has no Audio Specific
        // Config, which MP4-family containers require instead. Without
        // this the muxer rejects every audio packet outright.
        args.push('-bsf:a', 'aac_adtstoasc');
    } else if (audio.startsWith('mp2')) {
        // MPEG-1 Layer II is common in DVB-sourced TS and cannot be played from
        // an MP4 by AVPlayer. Audio is small, so re-encode just that track.
        args.push('-c:a', 'aac', '-b:a', '192k');
    }

    // -f is explicit because the output is written under a temporary name.
    args.push('-movflags', '+faststart', '-f', 'mp4', output);
    return args;
}

function runFfmpegCollectingTail(args) {
    return new Promise((resolve) => {
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
}

// The external processes behind native playback, behind one object so tests can
// stand in for ffmpeg/ffprobe.
const nativeTools = { ffmpeg: runFfmpegCollectingTail, codecs: probeCodecs, duration: probeDuration, startGraceMs: null };

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
    const result = await nativeTools.ffmpeg(args);

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

function listActive() {
    return scheduledDb.findActive();
}

/**
 * Stop a recording because a viewer asked for the stream.
 *
 * Finalises rather than discards: whatever was captured is kept and flagged
 * partial, so the Recordings list can explain itself. The schedule is marked
 * completed, not cancelled — it did record, just not all of it.
 */
async function stopForViewer(scheduleId) {
    const id = Number(scheduleId);
    if (!active.has(id)) return false;

    console.log(`[Recordings] Stopping recording for schedule #${id}: a viewer asked for the stream`);
    const entry = active.get(id);
    if (entry && entry.recordingId) {
        recordingsDb.markPartial(entry.recordingId, 0);
    }
    await stopRecording(id, 'completed');
    setScheduleStatus(id, 'completed', {
        error: 'Stopped early: the provider stream was needed for live viewing.'
    });
    coordinator.clearPrompt(id);
    return true;
}

function listRecordings() {
    return recordingsDb.listAll();
}

async function cancelScheduled(id) {
    const schedule = scheduledDb.getById(id);
    if (!schedule) throw new Error('Scheduled recording not found');

    if (schedule.status === 'recording' && active.has(id)) {
        await stopRecording(id, 'cancelled');
    } else if (schedule.status === 'scheduled' || schedule.status === 'waiting') {
        // A waiting recording is one held back for a viewer: cancelling it must also
        // withdraw the prompt that asks that viewer to stop watching.
        setScheduleStatus(schedule, 'cancelled');
        coordinator.clearPrompt(id);
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

    if (rec.format === 'hls' && rec.hls_dir) {
        // 0127: an HLS recording is a folder of its own (playlist, segments, the
        // joined MP4 and anything derived from it). Only ever a folder two levels
        // under the recordings root (<root>/<channel>/<recording>), so a bad row
        // can never take a channel's folder or the root with it.
        await removeRecordingFolder(rec.hls_dir);
    } else if (rec.file_path) {
        // The recording and everything derived from it. The native-playback
        // remux and, when "keep original" is on, the compressed copy sit beside
        // the .mkv under names built from it; deleting only the .mkv used to
        // orphan them on disk, unlisted and uncounted.
        const native = nativePlaybackTargetPath(rec.file_path);
        for (const file of [rec.file_path, native, `${native}.partial`, compressionTargetPath(rec.file_path)]) {
            if (!fs.existsSync(file)) continue;
            try { fs.unlinkSync(file); } catch (e) {
                console.warn('[Recordings] Failed to delete file:', e.message);
            }
            verifiedNativeFiles.delete(file);
        }
    }
    recordingsDb.delete(id);
}

async function startRecording(schedule, knownUrl = null) {
    if (tunerModel.enabled()) return startTunedRecording(schedule, knownUrl);
    let streamUrl;
    try {
        streamUrl = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id || null);
    } catch (err) {
        console.error(`[Recordings] Could not resolve stream for schedule ${schedule.id}:`, err.message);
        setScheduleStatus(schedule.id, 'failed', { error: err.message });
        return;
    }

    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    let root;
    try {
        root = await getRecordingsRoot();
    } catch (err) {
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${err.message}`);
        setScheduleStatus(schedule.id, 'failed', { error: err.message });
        return;
    }

    // Pre-flight storage check (0157: also catches an unmounted network share,
    // which reads back as a tiny filesystem rather than as missing - the case
    // that actually happened live; see recordingsFolder.js). Recordings are
    // stream copies of live TV with no size bound, so starting one on a
    // nearly full (or not really mounted) volume is a good way to take the
    // whole share down with it.
    // 0160: always checked; a minimum of 0 only switches off the low-space part
    // (checkRecordingsFolder ignores free space then), never the unmounted-share one.
    const check = checkRecordingsFolder(root, minFreeGB);
    if (!check.ok) {
        const msg = refusalMessage(check, root, minFreeGB);
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${msg}`);
        setScheduleStatus(schedule.id, 'failed', { error: msg });
        return;
    }

    const channelDir = path.join(root, sanitizeForFs(schedule.channel_name || 'Unknown Channel'));
    if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

    // Local time, not UTC - a 7:30pm program should read 19-30 in the filename.
    // "Local" is the process's TZ, which docker-compose.yml passes through.
    const dateStr = formatLocalStamp(schedule.program_start);
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

    // A recording held back by a viewer starts late. Record how much of the
    // programme was already gone, so the list can say "missing the first 12
    // minutes" rather than a bare "partial".
    const intendedStart = schedule.program_start - (schedule.pre_buffer_min || 0) * 60000;
    const lateBy = Date.now() - intendedStart;
    if (lateBy > 30000) {
        recordingsDb.markPartial(recording.id, lateBy);
        console.log(`[Recordings] #${recording.id} starts ${Math.round(lateBy / 60000)} min into the programme`);
    }

    coordinator.clearPrompt(schedule.id);
    setScheduleStatus(schedule.id, 'recording', { recording_id: recording.id });

    const args = [
        '-y',
        // The same identity playback presents (the userAgentPreset setting). A
        // provider that fingerprints the UA otherwise sees a different client
        // for recordings than for viewing, and this used to ignore the setting.
        '-user_agent', getUserAgent(settings),
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
        // 0119: ffmpeg's stderr names the input URL; stored (and listed by the API) redacted.
        error: success ? null : redact((stderrTail || []).slice(-10).join('\n')) || `ffmpeg exited with code ${exitCode}`
    });

    const scheduleExtra = success ? {} : { error: `Recording failed (exit code ${exitCode})` };
    setScheduleStatus(scheduledId, success ? 'completed' : 'failed', scheduleExtra);

    console.log(`[Recordings] Recording #${recordingId} finished (${success ? 'completed' : 'failed'}), ${fileSize} bytes`);

    if (success) {
        // Marked pending regardless of the setting; the queue checks whether
        // compression is enabled, so turning it on later picks these up.
        try {
            // Detection is queued automatically because markers have to exist
            // before you sit down to watch. Compression is not: it is only
            // worth doing for a recording you have decided to keep, which is a
            // judgement made after watching, so it waits to be asked for.
            recordingsDb.setAdDetectStatus(recordingId, 'pending');
        } catch (e) { /* columns may be missing on a very old database */ }
    }
}

async function stopRecording(scheduledId, reasonStatus = 'completed') {
    const entry = active.get(scheduledId);
    if (!entry) return;
    if (entry.kind === 'hls') {
        // Being deleted: nothing to join into an MP4.
        if (reasonStatus === 'deleted') entry.noJoin = true;
        await finalizeTunedRecording(scheduledId, entry);
        if (reasonStatus === 'cancelled') setScheduleStatus(scheduledId, 'cancelled');
        return;
    }

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
        setScheduleStatus(scheduledId, 'cancelled');
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
        if (schedule.recording_id && recordingsDb.getById(schedule.recording_id)?.format === 'hls') {
            // 0127: the segments kept so far are a recording; close its playlist.
            reconcileTunedRecording(schedule.recording_id).catch(err =>
                console.error(`[Recordings] Could not close recording #${schedule.recording_id}:`, err.message));
        } else if (schedule.recording_id) {
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
        setScheduleStatus(schedule.id, 'failed', { error: 'Server restarted while this recording was in progress.' });
    }

    const missed = scheduledDb.findMissed(Date.now());
    for (const schedule of missed) {
        setScheduleStatus(schedule.id, 'missed', { error: 'Server was not running when this recording was due.' });
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

    let root;
    try {
        root = await getRecordingsRoot();
    } catch (err) {
        // The folder health check (below) already logs this state on its own
        // timer; here there is nothing to enforce against, so skip this tick.
        return;
    }
    const space = hasFreeSpace(root, minFreeGB, 0.5);
    if (space.ok) return;

    console.error(`[Recordings] Free space critical (${space.freeGB.toFixed(1)} GB at ${root}); stopping ${active.size} in-progress recording(s). Partial files are kept.`);
    for (const scheduledId of [...active.keys()]) {
        try {
            await stopRecording(scheduledId, 'completed');
            setScheduleStatus(scheduledId, 'failed', { error: `Stopped early: only ${space.freeGB.toFixed(1)} GB free` });
        } catch (err) {
            console.error('[Recordings] Error stopping recording for low disk space:', err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Recordings from a tuner (the tuner model, PIGTV_TUNER=1, 0127)
//
// The recording holds the tuner for its channel ('rec:<scheduleId>') and an
// HlsRecorder keeps the segments of its window in its own folder:
//   <recordings root>/<channel>/<title - date>/index.m3u8, seg00000.m4s, ...
// EVENT playlist while it records, VOD once finished; then joined (stream copy,
// no re-encode) into <title - date>.mp4 in the same folder, which becomes
// file_path, so ad detection, compression, download and media.mp4 work on it
// as on any MP4. The segments stay too: they are what /index.m3u8 plays, and
// comskip needs a single file. Deleting the recording deletes the folder.
// ---------------------------------------------------------------------------

function holdKey(scheduleId) {
    return `rec:${scheduleId}`;
}

/** Where a recording's window ends (program end + post-buffer). */
function stopTimeOf(schedule) {
    return schedule.program_end + (schedule.post_buffer_min || 0) * 60000;
}

async function startTunedRecording(schedule, knownUrl) {
    let streamUrl = knownUrl;
    if (!streamUrl) {
        try {
            streamUrl = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id || null);
        } catch (err) {
            console.error(`[Recordings] Could not resolve stream for schedule ${schedule.id}:`, err.message);
            setScheduleStatus(schedule.id, 'failed', { error: err.message });
            return;
        }
    }

    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    let root;
    try {
        root = await getRecordingsRoot();
    } catch (err) {
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${err.message}`);
        setScheduleStatus(schedule.id, 'failed', { error: err.message });
        return;
    }
    // 0160: always checked; a minimum of 0 only switches off the low-space part
    // (checkRecordingsFolder ignores free space then), never the unmounted-share one.
    const check = checkRecordingsFolder(root, minFreeGB);
    if (!check.ok) {
        const msg = refusalMessage(check, root, minFreeGB);
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${msg}`);
        setScheduleStatus(schedule.id, 'failed', { error: msg });
        return;
    }

    const channelDir = path.join(root, sanitizeForFs(schedule.channel_name || 'Unknown Channel'));
    const baseName = `${sanitizeForFs(schedule.title)} - ${formatLocalStamp(schedule.program_start)}`;
    const folder = uniqueFilePath(channelDir, baseName, '');
    fs.mkdirSync(folder, { recursive: true });

    const recording = recordingsDb.create({
        scheduled_id: schedule.id,
        title: schedule.title,
        channel_name: schedule.channel_name,
        channel_logo: schedule.channel_logo,
        source_id: schedule.source_id,
        channel_item_id: schedule.channel_item_id,
        file_path: path.join(folder, 'index.m3u8'),
        started_at: Date.now()
    });
    recordingsDb.setHls(recording.id, folder);

    const intendedStart = schedule.program_start - (schedule.pre_buffer_min || 0) * 60000;
    const lateBy = Date.now() - intendedStart;

    coordinator.clearPrompt(schedule.id);
    setScheduleStatus(schedule.id, 'recording', { recording_id: recording.id });

    const recorder = new HlsRecorder({ dir: folder, from: intendedStart, to: stopTimeOf(schedule), label: `Recording #${recording.id}` });
    const entry = { kind: 'hls', proc: null, recordingId: recording.id, schedule, url: streamUrl, recorder, tuner: null, hardStopTimer: null, stderrTail: [] };
    active.set(schedule.id, entry);
    await recorder.writePlaylist(); // an (empty) EVENT playlist from the first moment

    console.log(`[Recordings] Starting recording #${recording.id} for schedule #${schedule.id}: "${schedule.title}" -> ${folder} (from a tuner)`);
    await attachTuner(schedule.id, entry, settings);

    // What the tuner already held (its window, from 0128 hours of it) may cover the
    // pre-buffer; the recording is only partial by what no tuner had.
    const firstPdt = recorder.segments.length ? recorder.segments[0].pdt : Date.now();
    const missed = firstPdt - intendedStart;
    if (lateBy > 30000 && missed > 30000) {
        recordingsDb.markPartial(recording.id, missed);
        console.log(`[Recordings] #${recording.id} starts ${Math.round(missed / 60000)} min into the programme`);
    }

    const msUntilStop = Math.max(0, stopTimeOf(schedule) - Date.now());
    entry.hardStopTimer = setTimeout(() => {
        console.log(`[Recordings] Scheduled stop time reached for schedule ${schedule.id}`);
        stopRecording(schedule.id, 'completed').catch(err =>
            console.error('[Recordings] Error stopping recording:', err.message));
    }, msUntilStop);
}

/** Hold the channel's tuner (sharing a viewer's, or starting one) and take its segments. */
async function attachTuner(scheduleId, entry, settings) {
    if (entry.attaching || entry.finalizing) return;
    entry.attaching = true;
    try {
        const playbackStrategy = require('./playbackStrategy');
        const { tuner: t, shared } = await playbackStrategy.acquireTunerForRecording({
            url: entry.url,
            settings: { ...settings, ffmpegPath },
            ffprobePath
        });
        if (entry.finalizing) return;
        tunerModel.hold(t, holdKey(scheduleId));
        entry.tuner = t;
        entry.recorder.attach(t);
        t.once('ended', () => {
            if (entry.tuner !== t) return;
            entry.tuner = null;
            // Let go of it: a dead tuner still held would count as a recording's
            // provider slot, and never be removed.
            tunerModel.unhold(t, holdKey(scheduleId)).catch(() => {});
            if (!entry.finalizing) console.warn(`[Recordings] #${entry.recordingId} lost its tuner; taking the channel up again`);
        });
        console.log(`[Recordings] #${entry.recordingId} ${shared ? 'shares' : 'started'} tuner ${t.id}`);
    } catch (err) {
        console.error(`[Recordings] #${entry.recordingId} could not take the channel: ${redact(err.message)}`);
        entry.lastError = err.message;
    } finally {
        entry.attaching = false;
    }
}

async function retuneRecordings(now = Date.now()) {
    for (const [scheduleId, entry] of active) {
        if (entry.kind !== 'hls' || entry.tuner || entry.attaching || entry.finalizing) continue;
        if (now >= stopTimeOf(entry.schedule)) continue;
        const settings = await getSettings();
        const verdict = await coordinator.requestForRecordingTuned(entry.schedule, settings, entry.url);
        if (verdict.allowed) await attachTuner(scheduleId, entry, settings);
    }
}

async function finalizeTunedRecording(scheduleId, entry) {
    if (entry.finalizing) return entry.finalizing;
    entry.finalizing = (async () => {
        if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
        const t = entry.tuner;
        // The segments ffmpeg has closed by now belong to the recording.
        if (t) await t.ingest().catch(() => {});
        await entry.recorder.finish();
        entry.tuner = null;
        await tunerModel.unhold(t, holdKey(scheduleId));
        active.delete(scheduleId);

        const recorder = entry.recorder;
        const success = recorder.segments.length > 0;
        const why = entry.lastError ? redact(entry.lastError) : 'No segments were received from the tuner';
        recordingsDb.finish(entry.recordingId, {
            status: success ? 'completed' : 'failed',
            ended_at: Date.now(),
            file_size_bytes: recorder.bytes,
            duration_sec: Math.round(recorder.durationSec()),
            error: success ? null : why
        });
        setScheduleStatus(scheduleId, success ? 'completed' : 'failed', success ? {} : { error: `Recording failed: ${why}` });
        console.log(`[Recordings] Recording #${entry.recordingId} finished (${success ? 'completed' : 'failed'}), ` +
            `${recorder.segments.length} segments, ${Math.round(recorder.durationSec())}s, ${recorder.bytes} bytes ` +
            `(${recorder.links.link} linked, ${recorder.links.copy} copied)`);
        if (success && !entry.noJoin) queueJoin(entry.recordingId);
    })();
    return entry.finalizing;
}

/** The recording's segments so far, for /playback's durationSec while it records. */
function tunedRecordingProgress(recordingId) {
    for (const entry of active.values()) {
        if (entry.kind === 'hls' && entry.recordingId === recordingId) {
            return { durationSec: Math.round(entry.recorder.durationSec()), segments: entry.recorder.segments.length };
        }
    }
    return null;
}

/**
 * A recording that has only just started may have no segment yet (its tuner is
 * still probing and starting: several seconds). Wait for the first one, up to
 * `timeoutMs`, so a client pressing Play straight away gets a playlist it can
 * play rather than an empty one (0129). Returns at once in every other case.
 */
async function waitForFirstTunedSegment(recordingId, timeoutMs = 10000) {
    let entry = null;
    for (const e of active.values()) if (e.kind === 'hls' && e.recordingId === recordingId) entry = e;
    if (!entry || entry.recorder.segments.length > 0) return;
    await new Promise((resolve) => {
        let timer = null;
        const done = () => {
            clearTimeout(timer);
            entry.recorder.off('segments', done);
            resolve();
        };
        entry.recorder.on('segments', done);
        timer = setTimeout(done, timeoutMs);
    });
}

async function reconcileTunedRecording(recordingId) {
    const rec = recordingsDb.getById(recordingId);
    const closed = rec && rec.hls_dir ? await closeOrphanPlaylist(rec.hls_dir) : null;
    recordingsDb.finish(recordingId, {
        status: closed ? 'completed' : 'failed',
        ended_at: Date.now(),
        file_size_bytes: null,
        duration_sec: closed ? Math.round(closed.durationSec) : null,
        error: 'Server restarted while this recording was in progress.'
    });
    if (closed) queueJoin(recordingId);
}

// One join at a time: a stream copy, but hours of it on the recordings disk.
let joinChain = Promise.resolve();
const joinsPending = new Set();

function queueJoin(recordingId) {
    if (joinsPending.has(recordingId)) return joinChain;
    joinsPending.add(recordingId);
    joinChain = joinChain
        .then(() => joinHlsRecording(recordingId))
        .catch(err => console.error(`[Recordings] Could not join #${recordingId} into an MP4:`, err.message))
        .finally(() => joinsPending.delete(recordingId));
    return joinChain;
}

/**
 * The finished recording's segments as one MP4 (stream copy; the same arguments
 * as the native-playback remux: hvc1 for HEVC, ASC for AAC, +faststart), for
 * download and ad detection. It becomes file_path; the HLS folder stays.
 */
async function joinHlsRecording(recordingId) {
    const rec = recordingsDb.getById(recordingId);
    if (!rec || rec.format !== 'hls' || !rec.hls_dir || rec.status !== 'completed') return;
    if (!String(rec.file_path).endsWith('.m3u8')) return; // already joined
    const index = path.join(rec.hls_dir, 'index.m3u8');
    const output = path.join(rec.hls_dir, `${path.basename(rec.hls_dir)}.mp4`);
    const partial = `${output}.partial`;
    try { fs.unlinkSync(partial); } catch (e) { /* none */ }

    const codecs = await nativeTools.codecs(index);
    const args = buildNativeRemuxArgs(index, partial, codecs);
    console.log(`[Recordings] Joining #${recordingId} into ${output}`);
    const result = await nativeTools.ffmpeg(args);
    if (result.code !== 0 || !fs.existsSync(partial)) {
        try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
        console.error(`[Recordings] Join of #${recordingId} failed:\n  ${result.tail.join('\n  ')}`);
        recordingsDb.setAdDetectStatus(recordingId, 'failed', 'The recording could not be joined into a single file');
        return;
    }
    const joined = await nativeTools.duration(partial);
    if (rec.duration_sec && joined && joined < rec.duration_sec * 0.95) {
        try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
        console.error(`[Recordings] Join of #${recordingId} is short (${Math.round(joined)}s of ${rec.duration_sec}s); keeping only the segments`);
        recordingsDb.setAdDetectStatus(recordingId, 'failed', 'The joined file was incomplete');
        return;
    }
    fs.renameSync(partial, output);
    verifiedNativeFiles.add(output);
    recordingsDb.setFilePath(recordingId, output);
    // Detection is queued the way a finished .mkv's is (finalizeRecording).
    try { recordingsDb.setAdDetectStatus(recordingId, 'pending'); } catch (e) { /* old database */ }
    console.log(`[Recordings] #${recordingId} joined (${Math.round(joined || 0)}s)`);
}

/** rm -r a recording's folder, only when it is <root>/<channel>/<recording>. */
async function removeRecordingFolder(dir) {
    const root = path.resolve(await getRecordingsRoot());
    const target = path.resolve(dir);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 2) {
        console.warn(`[Recordings] Not deleting ${target}: not a recording folder under ${root}`);
        return;
    }
    await fs.promises.rm(target, { recursive: true, force: true });
    for (const f of [...verifiedNativeFiles]) if (f.startsWith(target + path.sep)) verifiedNativeFiles.delete(f);
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

            // The tuner model (0127): which channel matters to the coordinator, since
            // a recording on a channel a tuner is already playing shares it.
            let url = null;
            if (tunerModel.enabled()) {
                try {
                    url = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id || null);
                } catch (err) {
                    console.error(`[Recordings] Could not resolve stream for schedule ${schedule.id}:`, err.message);
                    setScheduleStatus(schedule.id, 'failed', { error: err.message });
                    continue;
                }
            }

            // The provider may allow only one connection, and a viewer may be
            // using it. The coordinator decides; this loop just respects the
            // answer and tries again next tick, which is what makes a declined
            // recording start the moment playback stops.
            const verdict = tunerModel.enabled()
                ? await coordinator.requestForRecordingTuned(schedule, settings, url)
                : await coordinator.requestForRecording(schedule, settings);
            if (!verdict.allowed) {
                if (schedule.status !== 'waiting') {
                    setScheduleStatus(schedule.id, 'waiting', { error: verdict.reason });
                }
                continue;
            }

            await startRecording(schedule, url);
        }

        // A recording whose tuner went away (stalled, or its ffmpeg ended) takes
        // the channel up again as soon as the coordinator allows.
        if (tunerModel.enabled()) await retuneRecordings(now);

        // Give a viewer notice before a recording is actually due, rather than
        // at the moment it needs the stream.
        const settingsForLead = await getSettings();
        const leadMs = (settingsForLead.recordingPromptLeadMin ?? coordinator.DEFAULT_PROMPT_LEAD_MIN) * 60000;
        for (const schedule of scheduledDb.listUpcoming()) {
            if (schedule.status !== 'scheduled' && schedule.status !== 'waiting') continue;
            const startsAt = schedule.program_start - (schedule.pre_buffer_min || 0) * 60000;
            if (startsAt - now <= leadMs && startsAt > now) {
                if (tunerModel.enabled()) {
                    // No warning when the recording will share the tuner a viewer is on.
                    let url = null;
                    try { url = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id || null); } catch (e) { /* warned as before */ }
                    coordinator.announceUpcomingTuned(schedule, settingsForLead, url);
                } else {
                    coordinator.announceUpcoming(schedule, settingsForLead);
                }
            }
        }

        const missed = scheduledDb.findMissed(now);
        for (const schedule of missed) {
            // Say why it was missed. "The viewer kept watching" is actionable;
            // "the window passed" is not.
            const wasWaiting = schedule.status === 'waiting';
            setScheduleStatus(schedule.id, 'missed', {
                error: wasWaiting
                    ? 'Playback continued for the whole programme, so the provider stream was never free.'
                    : 'Recording window passed without starting.'
            });
            coordinator.clearPrompt(schedule.id);
        }

        await enforceFreeSpaceDuringRecording();

        // Fire and forget: both can outlive many ticks, and the guards inside
        // stop either starting twice. Detection runs on every finished
        // recording; compression only picks up what has been asked for, and
        // waits for detection because it reads the same file.
        processAdDetectionQueue().catch(err =>
            console.error('[Recordings] Break detection queue error:', err.message));
        processCompressionQueue().catch(err =>
            console.error('[Recordings] Compression queue error:', err.message));
    } catch (err) {
        console.error('[Recordings] Scheduler tick failed:', err);
    } finally {
        tickRunning = false;
    }
}

// ---------------------------------------------------------------------------
// Recordings folder health (0157)
//
// Checked at startup and every 15 minutes, independently of any recording
// being due - a broken share should be visible on the Status page long before
// the next scheduled recording tries to use it and fails. A warning is logged
// only when the state actually changes (never every 15 minutes for a folder
// that has been broken for days), plus one line when it recovers.
// ---------------------------------------------------------------------------

const FOLDER_HEALTH_INTERVAL_MS = 15 * 60 * 1000;
let folderHealthTimer = null;
let folderHealthState = null; // 'ok' | 'problem:<type>' | null (never checked yet)
let folderHealth = { ok: true, problem: null, freeBytes: null, totalBytes: null, root: null, checkedAt: null };

async function checkFolderHealthNow() {
    const settings = await getSettings();
    const root = settings.recordingsPath || '/app/recordings';
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    const result = checkRecordingsFolder(root, minFreeGB);
    const state = result.ok ? 'ok' : `problem:${result.problem}`;

    if (state !== folderHealthState) {
        if (result.ok) {
            if (folderHealthState !== null) console.log(`[Recordings] Recordings folder is reachable again: ${root}`);
        } else {
            console.warn(`[Recordings] ${refusalMessage(result, root, minFreeGB)}`);
        }
    }
    folderHealthState = state;
    folderHealth = { ...result, root, checkedAt: Date.now() };
    return folderHealth;
}

/** The last recordings-folder health check, for GET /api/status (0157). */
function getFolderHealth() {
    return folderHealth;
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

    checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    if (folderHealthTimer) clearInterval(folderHealthTimer);
    folderHealthTimer = setInterval(() => {
        checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    }, FOLDER_HEALTH_INTERVAL_MS);

    console.log('[Recordings] Recording engine initialized');
}

function shutdown() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (folderHealthTimer) clearInterval(folderHealthTimer);
    folderHealthTimer = null;
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
    stopForViewer,
    processCompressionQueue,
    processAdDetectionQueue,
    listRecordings,
    cancelScheduled,
    deleteRecording,
    resolveStreamUrl,
    ensureNativePlayback,
    pollNativePlayback,
    startNativePlayback,
    startNativePlaybackAndWait,
    buildNativeRemuxArgs,
    buildCompressArgs,
    tunedRecordingProgress,
    waitForFirstTunedSegment,
    queueJoin,
    tick,
    getFolderHealth,
    checkFolderHealthNow,
    getRecordingsRoot,
    // Test seam: stand-ins for the ffmpeg/ffprobe calls behind native playback.
    _nativeTools: nativeTools
};
