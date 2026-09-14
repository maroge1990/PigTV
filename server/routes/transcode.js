const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const db = require('../db');
const transcodeSession = require('../services/transcodeSession');

/**
 * Transcode Routes
 * 
 * Direct streaming (backward compatible):
 *   GET /api/transcode?url=...
 * 
 * HLS session-based (new, supports seeking):
 *   POST /api/transcode/session        - Create new session
 *   GET  /api/transcode/:id/stream.m3u8 - Get HLS playlist
 *   GET  /api/transcode/:id/:segment.ts - Get segment file
 *   DELETE /api/transcode/:id          - Stop and cleanup session
 *   GET /api/transcode/sessions        - List all sessions (debug)
 */

// Start session cleanup interval
transcodeSession.startCleanupInterval();

/**
 * A relative URI in an HLS playlist does not inherit the query string of
 * the playlist's own URL — that's ordinary URI resolution, not a bug in
 * anything here — so a client that authenticated to fetch stream.m3u8 with
 * ?token=... arrives at every following segment and init-segment request
 * with no token at all. With requireStreamAuth on, streamAuth then rejects
 * every one of them: the playlist loads, nothing in it plays, and the
 * failure looks like a broken player rather than a missing token.
 *
 * The fix is to carry the token forward explicitly onto every URI the
 * playlist references before it leaves the server:
 *   - plain segment lines (seg0001.ts / seg0001.m4s)
 *   - the fMP4 init segment, named inside a #EXT-X-MAP:URI="..." tag
 *     rather than on its own line, so a naive "skip lines starting with #"
 *     pass would miss it
 *   - an #EXT-X-KEY:URI="..." line, if encryption is ever added — same
 *     shape as EXT-X-MAP, handled the same way, unused today
 *
 * Every other line (#EXTINF, #EXT-X-VERSION, blank lines, ...) is left
 * untouched.
 */
function withStreamToken(playlist, token) {
    if (!token) return playlist;
    const q = `token=${encodeURIComponent(token)}`;
    const appendToUri = (uri) => `${uri}${uri.includes('?') ? '&' : '?'}${q}`;

    return playlist
        .split('\n')
        .map(line => {
            const tagUri = line.match(/^(#EXT-X-(?:MAP|KEY):.*URI=")([^"]+)(".*)$/);
            if (tagUri) {
                return `${tagUri[1]}${appendToUri(tagUri[2])}${tagUri[3]}`;
            }
            if (!line.trim() || line.trim().startsWith('#')) return line;
            return appendToUri(line.trim());
        })
        .join('\n');
}

/**
 * Create a new transcode session
 * POST /api/transcode/session
 * Body: { url: string, seekOffset?: number }
 */
router.post('/session', async (req, res) => {
    const { url, seekOffset, videoMode, videoCodec, audioCodec, audioChannels, segmentType,
            audioProfile, isHeAac } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    try {
        const session = await transcodeSession.createSession(url, {
            ffmpegPath,
            userAgent,
            seekOffset: seekOffset || 0,
            hwEncoder: settings.hwEncoder || 'software',
            maxResolution: settings.maxResolution || '1080p',
            quality: settings.quality || 'medium',
            audioMixPreset: settings.audioMixPreset || 'auto', // Audio downmix preset
            // Upscaling options
            upscaleEnabled: settings.upscaleEnabled || false,
            upscaleMethod: settings.upscaleMethod || 'hardware',
            upscaleTarget: settings.upscaleTarget || '1080p',
            vaapiCpuScale: settings.vaapiCpuScale !== false, // CPU scale + hwupload for iGPUs with a broken VAAPI VPP pipeline
            vaapiHwDecode: settings.vaapiHwDecode !== false, // GPU decode, frames returned to system memory
            segmentType: segmentType, // 'mpegts' or 'fmp4' (fmp4 allows HEVC stream copy)
            videoMode: videoMode, // 'copy' or 'encode'
            videoCodec: videoCodec, // 'h264', 'hevc', etc.
            audioCodec: audioCodec, // 'aac', 'ac3', etc.
            audioChannels: audioChannels, // number of channels (2=stereo)
            audioProfile: audioProfile,   // e.g. 'HE-AAC' — codec_name alone cannot distinguish it
            isHeAac: isHeAac === true
        });

        await session.start();

        // Wait for playlist to be ready (first segments generated)
        const ready = await session.waitForPlaylist(15000);

        if (!ready) {
            await transcodeSession.removeSession(session.id);
            return res.status(500).json({ error: 'Transcoding failed to start', reason: 'Playlist not generated in time' });
        }

        res.json({
            sessionId: session.id,
            playlistUrl: `/api/transcode/${session.id}/stream.m3u8`,
            status: session.status
        });

    } catch (err) {
        console.error('[Transcode] Session creation failed:', err);
        res.status(500).json({ error: 'Failed to create session', details: err.message });
    }
});

/**
 * Get HLS playlist for a session
 * GET /api/transcode/:sessionId/stream.m3u8
 */
router.get('/:sessionId/stream.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const session = transcodeSession.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const playlist = await session.getPlaylist();
    if (!playlist) {
        return res.status(404).json({ error: 'Playlist not ready' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(withStreamToken(playlist, req.query.token));
});

/**
 * Get a segment file for a session
 * GET /api/transcode/:sessionId/:segment.ts
 */
router.get('/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;

    // Only handle .ts files
    // .ts for mpegts sessions, .m4s plus init.mp4 for fMP4 sessions
    if (!/\.(ts|m4s|mp4)$/.test(segment)) {
        return res.status(404).json({ error: 'Invalid segment' });
    }

    const session = transcodeSession.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const segmentPath = await session.getSegment(segment);
    if (!segmentPath) {
        return res.status(404).json({ error: 'Segment not found' });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache forever (immutable)
    res.sendFile(segmentPath);
});

/**
 * Stop and cleanup a session
 * DELETE /api/transcode/:sessionId
 */
router.delete('/:sessionId', async (req, res) => {
    // Remux streams use their own registry and their own id prefix.
    if (String(req.params.sessionId).startsWith('remux_')) {
        try {
            const ok = require('./remux').killRemux(req.params.sessionId);
            return res.json({ success: ok });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    const { sessionId } = req.params;

    try {
        await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove session', details: err.message });
    }
});

/**
 * List all active sessions (for debugging)
 * GET /api/transcode/sessions
 */
router.get('/sessions', (req, res) => {
    // Everything currently holding an ffmpeg process and a provider
    // connection, not just HLS transcode sessions. A remuxed stream is just
    // as real a consumer of the single connection the provider allows.
    const sessions = transcodeSession.getAllSessions().map(s => ({ ...s, type: s.type || 'transcode' }));
    let remuxes = [];
    try {
        remuxes = require('./remux').listActiveRemuxes();
    } catch (err) {
        console.error('[Transcode] Could not list remux processes:', err.message);
    }
    res.json([...sessions, ...remuxes]);
});

/**
 * Stop ALL active transcode sessions and kill their ffmpeg processes.
 * DELETE /api/transcode/sessions/all
 */
router.delete('/sessions/all', async (req, res) => {
    try {
        const sessions = transcodeSession.getAllSessions();
        let killed = 0;
        for (const session of sessions) {
            try {
                await transcodeSession.removeSession(session.id);
                killed++;
            } catch (err) {
                console.error(`[Transcode] Failed to kill session ${session.id}:`, err.message);
            }
        }

        // Remuxed streams hold an ffmpeg process and a provider connection
        // too, so "kill all" has to mean all of them.
        let remuxKilled = 0;
        try {
            remuxKilled = require('./remux').killAllRemuxes();
        } catch (err) {
            console.error('[Transcode] Failed to kill remux processes:', err.message);
        }

        console.log(`[Transcode] Killed ${killed} transcode session(s) and ${remuxKilled} remux stream(s)`);
        res.json({ success: true, killed: killed + remuxKilled, transcode: killed, remux: remuxKilled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Direct transcode stream (backward compatible, no seeking)
 * GET /api/transcode?url=...
 * 
 * Transcodes audio to AAC for browser compatibility while passing video through.
 * This fixes playback issues with Dolby/AC3/EAC3 audio that browsers can't decode.
 */
router.get('/', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Transcode] Starting transcoding for: ${url}`);
    console.log(`[Transcode] Using User-Agent: ${settings.userAgentPreset}`);
    console.log(`[Transcode] Using binary: ${ffmpegPath}`);

    // FFmpeg arguments for transcoding
    // Optimized for VOD content with incompatible audio (Dolby/AC3/EAC3)
    // Also works for live streams with ad stitching (Pluto TV, etc.)
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        // Faster startup - reduced probe/analyze for quicker first bytes
        '-probesize', '2000000', // 2MB (reduced from 5MB)
        '-analyzeduration', '3000000', // 3 seconds (reduced from 10s)
        // Error resilience: generate timestamps, discard corrupt packets
        '-fflags', '+genpts+discardcorrupt+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues
        '-max_delay', '2000000',
        // Reconnect settings for network drops (useful for live streams)
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '3',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', url,
        // Map only first video and audio stream (avoid subtitle streams causing issues)
        '-map', '0:v:0',
        '-map', '0:a:0?', // ? makes audio optional if not present
        // Video: passthrough (no re-encoding = fast!)
        '-c:v', 'copy',
        // Audio: Transcode to browser-compatible AAC
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        // Handle async audio/video using async filter
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        // Timestamp handling
        '-fps_mode', 'passthrough',
        '-async', '1',
        '-max_muxing_queue_size', '2048',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
        '-flush_packets', '1', // Send data immediately
        '-' // Output to stdout
    ];

    console.log(`[Transcode] Full command: ${ffmpegPath} ${args.join(' ')}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Transcode] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Collect stderr for error reporting
    let stderrBuffer = '';

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging transcoding failures)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrBuffer += msg;
        console.log(`[FFmpeg] ${msg}`);
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Transcode] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) { // 255 is often returned on kill
            console.error(`[Transcode] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Transcode] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Transcoding failed to start' });
        }
    });
});

module.exports = router;

