const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { redact } = require('../redact');
const { createStallWatchdog } = require('../services/stallWatchdog');
const coordinator = require('../services/streamCoordinator');

// Active remux processes, so they can be listed and killed like transcode
// sessions can. Without this registry a remuxed stream is invisible to any
// management tooling: it only ends when its client disconnects, and a client
// that went away without closing the socket leaves ffmpeg running against the
// provider indefinitely.
// lastOutputAt is null until ffmpeg has produced its first bytes.
const activeRemuxes = new Map(); // id -> { id, url, proc, startedAt, res, owner, lastOutputAt }
let remuxCounter = 0;

function listActiveRemuxes() {
    return Array.from(activeRemuxes.values()).map(r => ({
        id: r.id,
        url: r.url,
        type: 'remux',
        startTime: r.startedAt,
        owner: r.owner,
        // Time since media last flowed to the client, the same question
        // idleMs answers for an HLS session ("has anyone fetched anything
        // lately?"). It used to be time since the remux *started*, which
        // grows for a perfectly healthy stream and meant nothing.
        idleMs: Date.now() - (r.lastOutputAt ?? r.startedAt)
    }));
}

function killRemux(id) {
    const entry = activeRemuxes.get(id);
    if (!entry) return false;
    try { entry.proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    try { entry.res.end(); } catch (e) { /* already closed */ }
    activeRemuxes.delete(id);
    return true;
}

function killAllRemuxes() {
    let killed = 0;
    for (const id of [...activeRemuxes.keys()]) {
        if (killRemux(id)) killed++;
    }
    return killed;
}

// Cache of url -> { video, audio } codec names, so we only pay for the probe
// once per stream rather than on every playback start.
const codecCache = new Map();
const CODEC_CACHE_TTL = 5 * 60 * 1000;

/**
 * Detect the codec of the first audio stream.
 *
 * Needed because MPEG-TS carries AAC in ADTS framing, which MP4 cannot hold:
 * without the aac_adtstoasc bitstream filter the muxed MP4 has no usable
 * audio. That filter must NOT be applied to AC3/EAC3/MP3, so we have to know
 * what we are dealing with before building the ffmpeg command.
 *
 * Returns null if ffprobe is unavailable, times out, or fails - callers then
 * fall back to the old behaviour of not applying any audio bitstream filter.
 */
function detectCodecs(url, ffprobePath, userAgent, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!ffprobePath) return resolve(null);

        const cached = codecCache.get(url);
        if (cached && (Date.now() - cached.at) < CODEC_CACHE_TTL) {
            return resolve(cached.codec);
        }

        const args = [
            '-v', 'error',
            '-user_agent', userAgent,
            '-show_entries', 'stream=codec_name,codec_type',
            '-print_format', 'json',
            '-probesize', '2000000',
            '-analyzeduration', '2000000',
            url
        ];

        let proc;
        try {
            proc = spawn(ffprobePath, args);
        } catch (err) {
            return resolve(null);
        }

        let stdout = '';
        let settled = false;
        const finish = (codecs) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (codecs) codecCache.set(url, { codec: codecs, at: Date.now() });
            resolve(codecs);
        };

        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            finish(null);
        }, timeoutMs);

        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.on('error', () => finish(null));
        proc.on('close', (code) => {
            if (code !== 0) return finish(null);
            try {
                const streams = JSON.parse(stdout)?.streams || [];
                finish({
                    video: streams.find(s => s.codec_type === 'video')?.codec_name || null,
                    audio: streams.find(s => s.codec_type === 'audio')?.codec_name || null
                });
            } catch (err) {
                finish(null);
            }
        });
    });
}

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const ffprobePath = req.app.locals.ffprobePath;

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    // Work out what fix-ups the MP4 muxer needs for this stream
    const codecs = await detectCodecs(url, ffprobePath, userAgent);
    const audioCodec = codecs?.audio || null;
    const videoCodec = (codecs?.video || '').toLowerCase();
    const needsAdtsToAsc = audioCodec === 'aac';
    // HEVC in fMP4 must be tagged hvc1 or browsers refuse the track. Without
    // this, an HEVC channel that could be remuxed at near-zero cost falls
    // back to a full re-encode.
    const needsHvc1Tag = videoCodec.includes('hevc') || videoCodec.includes('h265');
    console.log(`[Remux] Codecs: video=${videoCodec || 'unknown'}, audio=${audioCodec || 'unknown'}` +
        `${needsAdtsToAsc ? ' (aac_adtstoasc)' : ''}${needsHvc1Tag ? ' (tag hvc1)' : ''}`);

    console.log(`[Remux] Starting remux for: ${redact(url)}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-user_agent', userAgent,
        // Standard probe size to handle complex containers (MKV) correctly
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', url,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', '0:v',
        '-map', '0:a',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // Ensure extradata is correctly extracted/converted (fixes Annex B -> AVCC issues in Firefox)
        '-bsf:v', 'dump_extra',
        // aac_adtstoasc is applied conditionally below: it is required for
        // AAC-in-MPEG-TS to survive the move into MP4, but it breaks
        // AC3/EAC3/MP3, so it is only added when the probe says the audio
        // really is AAC.
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    if (needsAdtsToAsc) {
        // Insert just before the output argument
        args.splice(args.length - 1, 0, '-bsf:a', 'aac_adtstoasc');
    }
    if (needsHvc1Tag) {
        args.splice(args.length - 1, 0, '-tag:v', 'hvc1');
    }

    console.log(`[Remux] Full command: ${ffmpegPath} ${redact(args.join(' '))}`);

    // Free the provider's connection if it is clearly free to take: an
    // abandoned stream, or this same device's own earlier one. Soft, because
    // the clients that call this route directly cannot answer a "somebody else
    // is watching" prompt - that question is asked at /api/playback/resolve.
    // Arbitration must never be the reason playback fails to start.
    const owner = coordinator.ownerKey(req.user);
    try {
        await coordinator.admitViewer({
            soft: true,
            owner,
            settings,
            activeRecordings: require('../services/recordingEngine').listActive()
        });
    } catch (err) {
        console.warn('[Remux] Stream arbitration skipped:', err.message);
    }

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Keep the tail of stderr. At -loglevel warning a fatal startup error can
    // scroll past without matching the filter below, which leaves the log
    // saying only that the client disconnected — true, but not the reason.
    const stderrTail = [];
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        for (const line of msg.split('\n')) {
            if (line.trim()) {
                stderrTail.push(line.trim());
                if (stderrTail.length > 20) stderrTail.shift();
            }
        }
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${redact(msg.trim())}`);
        }
    });

    const remuxId = `remux_${++remuxCounter}`;
    const startedAt = Date.now();
    let ffmpegExited = false;
    const entry = {
        id: remuxId,
        url,
        proc: ffmpeg,
        res,
        startedAt,
        owner,
        lastOutputAt: null
    };
    activeRemuxes.set(remuxId, entry);
    console.log(`[Remux] Started ${remuxId} (${activeRemuxes.size} active)`);

    // Bytes leaving ffmpeg are the only proof it is doing its job. This
    // listener rides alongside pipe(): when the client stops reading, pipe()
    // pauses stdout and these events stop too, which is exactly what idleMs
    // should reflect.
    ffmpeg.stdout.on('data', () => { entry.lastOutputAt = Date.now(); });

    // A dropped upstream leaves ffmpeg alive but silent, retrying forever
    // under its -reconnect flags, still holding the provider's only
    // connection. Kill it once it has produced nothing for too long.
    let lastBackpressureAt = null;
    const watchdog = createStallWatchdog({
        label: `Remux ${remuxId}`,
        getLastActivity: () => {
            // Silence because the *client* is not reading (paused tab,
            // stalled network) is not ffmpeg's fault: it is blocked writing
            // to a full pipe. Only silence with the pipe open is a stall.
            // Remembering when that was last seen means that after the client
            // resumes, ffmpeg gets a full stall window to deliver, rather than
            // being judged against output from before the pause.
            if (ffmpeg.stdout.isPaused() || res.writableNeedDrain) lastBackpressureAt = Date.now();
            return Math.max(entry.lastOutputAt ?? 0, lastBackpressureAt ?? 0) || null;
        },
        onStall: () => {
            console.error(`[Remux] Releasing stalled ${remuxId} for ${redact(url)}`);
            if (stderrTail.length) {
                console.error(`[Remux] Last ffmpeg output for ${remuxId}:`);
                stderrTail.forEach(line => console.error(`[Remux]   ${redact(line)}`));
            }
            killRemux(remuxId);
        }
    });

    // Cleanup on client disconnect.
    // req 'close' also fires when the response ends, including because ffmpeg
    // died, so check which happened first before blaming the browser.
    req.on('close', () => {
        if (!activeRemuxes.has(remuxId)) return;
        activeRemuxes.delete(remuxId);
        if (ffmpegExited) return; // exit handler already reported the cause
        const alive = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[Remux] Client disconnected after ${alive}s, killing ${remuxId}`);
        try { ffmpeg.kill('SIGKILL'); } catch (e) { /* already gone */ }
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        ffmpegExited = true;
        watchdog.stop();
        activeRemuxes.delete(remuxId);
        if (code !== null && code !== 0 && code !== 255) {
            const alive = Math.round((Date.now() - startedAt) / 1000);
            console.error(`[Remux] ${remuxId} exited with code ${code} after ${alive}s`);
            if (stderrTail.length) {
                console.error(`[Remux] Last ffmpeg output for ${remuxId}:`);
                stderrTail.forEach(line => console.error(`[Remux]   ${line}`));
            }
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
module.exports.listActiveRemuxes = listActiveRemuxes;
module.exports.killRemux = killRemux;
module.exports.killAllRemuxes = killAllRemuxes;
