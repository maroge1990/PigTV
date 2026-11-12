/**
 * After a recording: compression and commercial-break detection (split out of
 * recordingEngine.js in the simplification build). Both run one at a time, never while a
 * capture is running, and never on the recording preparation is working on.
 */
const { recordings: recordingsDb } = require('../db/recordingsDb');
const jobs = require('./recordingJobs');
const owners = require('./recordingOwners');
const { tools, nativeTools, verifiedNativeFiles, compressionTargetPath, ioFor } = require('./recordingMedia');

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
    // Play during a long encode could be handed a half-written MP4. 0273: the
    // temporary name is its own (recordingOwners.partialFor, journalled).
    const partial = owners.partialFor(output);

    // The share's calls are bounded: one that is not answered rejects with SHARE_UNRESPONSIVE, which ends the job here (the
    // queue puts it back to pending, to be tried again) with the original and the row untouched.
    const io = ioFor(input);
    const drop = async (file) => { try { await io.unlink(file); } catch (e) { /* none there, or left for the start-up sweep (journalled) */ } };
    if (!(await io.exists(input))) {
        recordingsDb.setCompressStatus(rec.id, 'failed', { error: 'Original file is missing' });
        return;
    }
    // Codex review of 0568: what an earlier pass journalled and never committed goes first, while it is still that very
    // file: a compressed MP4 whose rename missed its deadline and landed later, and its partial. It is encoded again
    // rather than finished from (the safer choice: the original is only ever removed after a check made in this pass).
    await owners.takeBack(rec.id, ioFor);
    if (owners.removalPending(output)) throw owners.stillRemoving(output); // before any work: tried again later
    try { await io.unlink(`${output}.partial`); } catch (e) { if (e.code === 'SHARE_UNRESPONSIVE') throw e; /* none left by an earlier run (the fixed name before 0273) */ }

    const inputStat = await io.stat(input);
    if (!inputStat) throw new Error('Original file is missing');
    const originalSize = inputStat.size;
    const sourceDuration = await nativeTools.duration(input);

    recordingsDb.setCompressStatus(rec.id, 'running', { originalSize });
    console.log(`[Recordings] Compressing #${rec.id} (${(originalSize / 1e9).toFixed(2)} GB)`);

    // R5-D1, 0264: a writer of the recording - a deletion stops it and waits; one deleted while it ran
    // (ffmpeg may open its output only after the deletion) removes what it made and publishes nothing.
    // Codex review of 0568: the check and the publication too (owners.publishByRename), so a deletion waits for the rename
    // and the row is set only while the recording is still owned.
    const outcome = await owners.write(rec.id, async (signal, made, until) => {
        made(partial);
        let r = await nativeTools.ffmpeg(buildCompressArgs(input, partial, settings), { watchFile: partial, signal, sizeOf: io.sizeOf });
        // Some VAAPI drivers implement constant-quantiser rate control only and
        // reject a bitrate target outright. Retry once in CQP rather than leaving
        // the recording uncompressed.
        if (r.code !== 0 && r.tail.some(l => l.includes('RC mode')) && !signal.aborted) {
            console.log(`[Recordings] Encoder wants constant quality; retrying #${rec.id} in CQP`);
            await drop(partial);
            r = await nativeTools.ffmpeg(buildCompressArgs(input, partial, settings, { forceCqp: true }), { watchFile: partial, signal, sizeOf: io.sizeOf });
        }
        if (!owners.owned(rec.id)) { await drop(partial); return { deleted: true }; }
        const code = r.code;
        if (code !== 0 || !(await io.exists(partial))) {
            console.error(`[Recordings] Compression of #${rec.id} failed:\n  ${r.tail.join('\n  ')}`);
            await drop(partial);
            return { status: 'failed', error: r.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${code}` };
        }

        // Verify before trusting it. A truncated encode is worse than a large file,
        // so the original is only replaced when the result covers the same span.
        // 0192 (audit R08): both lengths must actually be known. An unreadable length
        // used to count as a pass, and with "keep original" off that deleted the
        // original on the strength of a check that never ran.
        const newDuration = await nativeTools.duration(partial);
        if (!owners.owned(rec.id)) {
            await drop(partial); // removed with the recording
            return { deleted: true };
        }
        const partialStat = await io.stat(partial);
        const newSize = partialStat ? partialStat.size : 0;
        const verified = sourceDuration > 0 && newDuration > 0 && newDuration >= sourceDuration * 0.95;

        if (!verified || newSize < 1024) {
            await drop(partial);
            const unreadable = !(sourceDuration > 0) || !(newDuration > 0);
            return { status: 'failed', error: unreadable
                ? 'Result could not be verified (a length could not be read); the original is kept'
                : `Result failed verification (${Math.round(newDuration || 0)}s vs ${Math.round(sourceDuration || 0)}s)` };
        }

        if (newSize >= originalSize) {
            // Re-encoding made it bigger, which happens on already-efficient
            // sources. Keep the original and say so.
            await drop(partial);
            return { status: 'skipped', error: 'Compressed file was no smaller' };
        }

        // A rename the share does not answer may still land, so nothing is deleted: the original stays and the row is not
        // moved (the rejection reaches the queue, which tries again later; the next pass takes that copy back first).
        // The row moves to the new file before the old one goes: a crash in between
        // leaves a spare original on disk, never a row pointing at nothing.
        const mine = await owners.publishByRename(rec.id, partial, output, io, until, 'compressed MP4', () => {
            if (settings.postRecordKeepOriginal === true) recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: originalSize });
            else recordingsDb.setCompressStatus(rec.id, 'done', { fileSize: newSize, filePath: output });
        });
        if (!mine) return { deleted: true };
        if (settings.postRecordKeepOriginal !== true) {
            try {
                await io.unlink(input);
            } catch (err) {
                console.warn(`[Recordings] #${rec.id} compressed, but the original could not be removed: ${err.message}`);
            }
        }
        return { published: true, newSize };
    });
    if (outcome.deleted) return;
    if (outcome.status) {
        if (!owners.owned(rec.id)) return;
        recordingsDb.setCompressStatus(rec.id, outcome.status, { error: outcome.error });
        if (outcome.status === 'skipped') console.log(`[Recordings] #${rec.id} left as-is; compression saved nothing`);
        return;
    }

    if (settings.postRecordKeepOriginal === true) {
        console.log(`[Recordings] #${rec.id} compressed alongside the original`);
        return;
    }
    const { newSize } = outcome;
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
        iniPath: settings.comskipIniPath || undefined,
        // 0207: scaled to the recording, not a flat 30 minutes.
        timeoutMs: adDetect.postTimeoutMs(rec.duration_sec)
    });
    console.log(`[Recordings] Break detection #${rec.id} (post): ${result.elapsedSec}s elapsed for a ${Math.round(rec.duration_sec || 0)}s recording`);

    if (!owners.owned(rec.id)) return; // R5-D1: deleted while Comskip ran: no markers for it
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
    await owners.whenSwept(); // 0279: never beside the start-up sweep
    if (compressing) return; // another call started meanwhile
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
        // A share that did not answer (or a late call of an earlier pass that may still land) is not a failure: pending
        // again, so a later tick of the queue tries it (one recording per tick, each call bounded by its deadline).
        recordingsDb.setCompressStatus(pending[0].id, err.code === 'SHARE_UNRESPONSIVE' ? 'pending' : 'failed', { error: err.message });
    } finally {
        compressing = false;
        jobs.compressing = null;
    }
}

module.exports = {
    compressRecording, buildCompressArgs, processCompressionQueue, processAdDetectionQueue
};
