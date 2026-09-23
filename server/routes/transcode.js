const express = require('express');
const router = express.Router();
const { redact } = require('../redact');
const transcodeSession = require('../services/transcodeSession');

/**
 * Transcode Routes
 * 
 * HLS sessions (the one delivery path; the legacy piped GET /api/transcode?url=
 * went with the remux route in 0103). Sessions are started by
 * POST /api/playback/resolve; POST /api/transcode/session, which only the
 * movie/series page used, went with it in 0122.
 *   GET  /api/transcode/:id/stream.m3u8 - Get HLS playlist
 *   GET  /api/transcode/:id/:segment.ts - Get segment file
 *   DELETE /api/transcode/:id          - Stop and cleanup session
 *   GET /api/transcode/sessions        - List all sessions (debug)
 */

// Start session cleanup interval
transcodeSession.startCleanupInterval();

// A 404 on a playlist or segment ends playback in hls.js at once (it does not retry a 4xx), yet
// used to leave nothing in the log. One line per session and file, not one per request.
const reportedMissing = new Set();
function noteMissing(sessionId, file, why) {
    const key = `${sessionId}/${file}`;
    if (reportedMissing.has(key)) return;
    if (reportedMissing.size > 500) reportedMissing.clear();
    reportedMissing.add(key);
    console.warn(`[HLS] 404 for ${file} in session ${sessionId}: ${why}`);
}

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
 * Get HLS playlist for a session
 * GET /api/transcode/:sessionId/stream.m3u8
 */
router.get('/:sessionId/stream.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const session = transcodeSession.getSession(sessionId);

    if (!session) {
        noteMissing(sessionId, 'stream.m3u8', 'the session no longer exists');
        return res.status(404).json({ error: 'Session not found' });
    }

    const playlist = await session.getPlaylist();
    if (!playlist) {
        noteMissing(sessionId, 'stream.m3u8', `the playlist is not on disk (session ${session.status})`);
        return res.status(404).json({ error: 'Playlist not ready' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(withStreamToken(playlist, req.query.token));
});

/**
 * Master playlist for a session (0100 HDR, 0115 every session with a usable frame
 * rate): one variant, stream.m3u8, plus the VIDEO-RANGE and FRAME-RATE a media
 * playlist cannot carry. Must stay above the segment route,
 * whose name allow-list would answer 404. The variant line gets ?token= like any
 * other relative URI.
 * GET /api/transcode/:sessionId/master.m3u8
 */
router.get('/:sessionId/master.m3u8', (req, res) => {
    const { sessionId } = req.params;
    const session = transcodeSession.getSession(sessionId);
    const master = session && session.getMasterPlaylist();
    if (!master) {
        noteMissing(sessionId, 'master.m3u8', session ? 'the session has no master playlist (no usable frame rate, or an HDR copy into MPEG-TS)' : 'the session no longer exists');
        return res.status(404).json({ error: 'Session not found' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(withStreamToken(master, req.query.token));
});

/**
 * Get a segment file for a session
 * GET /api/transcode/:sessionId/:segment.ts
 */
router.get('/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;

    // Exactly the names ffmpeg is told to write (see the -hls_segment_filename
    // and -hls_fmp4_init_filename args): seg%04d.ts for mpegts sessions,
    // seg%04d.m4s plus init.mp4 for fMP4 ones. Express URL-decodes params after
    // routing, so an encoded slash (..%2F..%2Fx.mp4) arrives here as a real
    // path; a suffix check alone let it reach path.join. Refuse anything that
    // is not one of those names.
    if (!/^(seg\d{4,}\.(ts|m4s)|init\.mp4)$/.test(segment)) {
        return res.status(404).json({ error: 'Invalid segment' });
    }

    const session = transcodeSession.getSession(sessionId);
    if (!session) {
        noteMissing(sessionId, segment, 'the session no longer exists');
        return res.status(404).json({ error: 'Session not found' });
    }

    const segmentPath = await session.getSegment(segment);
    if (!segmentPath) {
        noteMissing(sessionId, segment, `the file is not on disk (session ${session.status}) - already rotated out of the window, or cleared`);
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
    // Everything holding an ffmpeg process and a provider connection. Since 0103
    // that is only HLS sessions: the piped remux is gone.
    const sessions = transcodeSession.getAllSessions().map(s => ({ ...s, type: s.type || 'transcode' }));
    res.json(sessions.map(x => (x && x.url ? { ...x, url: redact(x.url) } : x)));
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

        console.log(`[Transcode] Killed ${killed} transcode session(s)`);
        res.json({ success: true, killed, transcode: killed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

