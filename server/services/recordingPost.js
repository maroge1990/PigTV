/**
 * After a recording: compression and commercial-break detection (split out of
 * recordingEngine.js in the simplification build). Both run one at a time, never while a
 * capture is running, and never on the recording preparation is working on.
 */
const fs = require('fs');
const { recordings: recordingsDb } = require('../db/recordingsDb');
const jobs = require('./recordingJobs');
const { tools, nativeTools, verifiedNativeFiles, compressionTargetPath } = require('./recordingMedia');

async function getSettings() {
    const { settings } = require('../db');
    return settings.get();
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
    // -f is explicit because the output is written under a temporary name.
    args.push('-movflags', '+faststart', '-f', 'mp4', output);
    return args;
}

async function compressRecording(rec, settings) {
    const input = rec.file_path;
    const output = compressionTargetPath(input);
    // 0192 (audit R08): encoded under a temporary name and renamed into place only
    // once verified. The final name is served to the Apple client as soon as it
    // exists (readyNativePlaybackPath), and ffmpeg used to write it in place, so a
    // Play during a long encode could be handed a half-written MP4.
    const partial = `${output}.partial`;

    if (!fs.existsSync(input)) {
        recordingsDb.setCompressStatus(rec.id, 'failed', { error: 'Original file is missing' });
        return;
    }
    try { fs.unlinkSync(partial); } catch (e) { /* none left by an earlier run */ }

    const originalSize = fs.statSync(input).size;
    const sourceDuration = await nativeTools.duration(input);

    recordingsDb.setCompressStatus(rec.id, 'running', { originalSize });
    console.log(`[Recordings] Compressing #${rec.id} (${(originalSize / 1e9).toFixed(2)} GB)`);

    let result = await nativeTools.ffmpeg(buildCompressArgs(input, partial, settings), { watchFile: partial });

    // Some VAAPI drivers implement constant-quantiser rate control only and
    // reject a bitrate target outright. Retry once in CQP rather than leaving
    // the recording uncompressed.
    if (result.code !== 0 && result.tail.some(l => l.includes('RC mode'))) {
        console.log(`[Recordings] Encoder wants constant quality; retrying #${rec.id} in CQP`);
        try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
        result = await nativeTools.ffmpeg(buildCompressArgs(input, partial, settings, { forceCqp: true }), { watchFile: partial });
    }

    const code = result.code;
    if (code !== 0 || !fs.existsSync(partial)) {
        console.error(`[Recordings] Compression of #${rec.id} failed:\n  ${result.tail.join('\n  ')}`);
        try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
        recordingsDb.setCompressStatus(rec.id, 'failed', {
            error: result.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${code}`
        });
        return;
    }

    // Verify before trusting it. A truncated encode is worse than a large file,
    // so the original is only replaced when the result covers the same span.
    // 0192 (audit R08): both lengths must actually be known. An unreadable length
    // used to count as a pass, and with "keep original" off that deleted the
    // original on the strength of a check that never ran.
    const newDuration = await nativeTools.duration(partial);
    const newSize = fs.statSync(partial).size;
    const verified = sourceDuration > 0 && newDuration > 0 && newDuration >= sourceDuration * 0.95;

    if (!verified || newSize < 1024) {
        try { fs.unlinkSync(partial); } catch (e) { /* ignore */ }
        const unreadable = !(sourceDuration > 0) || !(newDuration > 0);
        recordingsDb.setCompressStatus(rec.id, 'failed', {
            error: unreadable
                ? 'Result could not be verified (a length could not be read); the original is kept'
                : `Result failed verification (${Math.round(newDuration || 0)}s vs ${Math.round(sourceDuration || 0)}s)`
        });
        return;
    }

    if (newSize >= originalSize) {
        // Re-encoding made it bigger, which happens on already-efficient
        // sources. Keep the original and say so.
        try { fs.unlinkSync(partial); } catch (e) { /* ignore */ }
        recordingsDb.setCompressStatus(rec.id, 'skipped', { error: 'Compressed file was no smaller' });
        console.log(`[Recordings] #${rec.id} left as-is; compression saved nothing`);
        return;
    }

    fs.renameSync(partial, output);

    if (settings.postRecordKeepOriginal === true) {
        recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: originalSize });
        console.log(`[Recordings] #${rec.id} compressed alongside the original`);
        return;
    }

    // The row moves to the new file before the old one goes: a crash in between
    // leaves a spare original on disk, never a row pointing at nothing.
    recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: newSize, filePath: output });
    try {
        fs.unlinkSync(input);
    } catch (err) {
        console.warn(`[Recordings] #${rec.id} compressed, but the original could not be removed: ${err.message}`);
    }
    verifiedNativeFiles.delete(input);
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
    if (jobs.capturing() > 0) return; // never compete with an active recording

    const settings = await getSettings();
    if (!manual && settings.adDetectionEnabled !== true) return;

    // 0192: not the one being prepared - its .mkv is about to be replaced.
    const pending = recordingsDb.findPendingAdDetection().filter(r => r.id !== jobs.preparing);
    if (pending.length === 0) return;

    detecting = true;
    jobs.detecting = pending[0].id;
    try {
        await detectAdsFor(pending[0], settings);
    } catch (err) {
        console.error('[Recordings] Break detection error:', err.message);
        recordingsDb.setAdDetectStatus(pending[0].id, 'failed', err.message);
    } finally {
        detecting = false;
        jobs.detecting = null;
    }
}

async function processCompressionQueue() {
    if (compressing) return;
    if (jobs.capturing() > 0) return; // never compete with an active recording
    if (detecting) return;       // detection reads the original; let it finish first

    const settings = await getSettings();

    // 0192: not the one being prepared - its .mkv is about to be replaced.
    const pending = recordingsDb.findPendingCompression().filter(r => r.id !== jobs.preparing);
    if (pending.length === 0) return;

    compressing = true;
    jobs.compressing = pending[0].id;
    try {
        await compressRecording(pending[0], settings);
    } catch (err) {
        console.error('[Recordings] Compression error:', err.message);
        recordingsDb.setCompressStatus(pending[0].id, 'failed', { error: err.message });
    } finally {
        compressing = false;
        jobs.compressing = null;
    }
}

module.exports = { compressRecording, buildCompressArgs, processCompressionQueue, processAdDetectionQueue };
