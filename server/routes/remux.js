const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');

// Cache of url -> audio codec name, so we only pay for the probe once per
// stream rather than on every playback start.
const audioCodecCache = new Map();
const AUDIO_CODEC_CACHE_TTL = 5 * 60 * 1000;

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
function detectAudioCodec(url, ffprobePath, userAgent, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!ffprobePath) return resolve(null);

        const cached = audioCodecCache.get(url);
        if (cached && (Date.now() - cached.at) < AUDIO_CODEC_CACHE_TTL) {
            return resolve(cached.codec);
        }

        const args = [
            '-v', 'error',
            '-user_agent', userAgent,
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name',
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
        const finish = (codec) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (codec) audioCodecCache.set(url, { codec, at: Date.now() });
            resolve(codec);
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
                const parsed = JSON.parse(stdout);
                finish(parsed?.streams?.[0]?.codec_name || null);
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

    // Work out whether the audio needs the ADTS -> ASC bitstream filter
    const audioCodec = await detectAudioCodec(url, ffprobePath, userAgent);
    const needsAdtsToAsc = audioCodec === 'aac';
    console.log(`[Remux] Audio codec: ${audioCodec || 'unknown'}${needsAdtsToAsc ? ' (applying aac_adtstoasc)' : ''}`);

    console.log(`[Remux] Starting remux for: ${url}`);
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

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

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

    // Log stderr (useful for debugging)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log warnings/errors, not progress
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Remux] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
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
