const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../auth');
const recordingEngine = require('../services/recordingEngine');
const { recordings: recordingsDb } = require('../db/recordingsDb');

// NOTE: /:id/stream, /:id/media.mp4 and /:id/download are deliberately
// registered BEFORE the requireAuth middleware. requireAuth reads only a
// Bearer header (server/auth.js), and a <video src> / <a href> / AVURLAsset
// request cannot send that header, so these would always 401. The existing
// live-stream routes (/api/proxy, /api/transcode, /api/remux) are the same
// way; /api/recordings is wrapped in the same streamAuth middleware they use
// (see server/index.js), which accepts the token as ?token= instead — opt-in
// enforcement via the requireStreamAuth setting, same as those.

// Serve a local file with HTTP Range support, for seeking. Shared by
// /:id/stream (the original .mkv) and /:id/media.mp4 (the native-playback
// remux) — the byte-range mechanics are identical, only the content type
// and which file differ.
function serveWithRangeSupport(req, res, filePath, contentType) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
            res.set('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }

        res.status(206);
        res.set({
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.set({
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
    }
}

// ---------------------------------------------------------------------------
// HLS recordings (the tuner model, PIGTV_TUNER=1, 0127; contract C-E). The same
// auth as media.mp4: registered before requireAuth, behind the streamAuth the
// whole router is mounted with (bearer or ?token=), and the token is carried onto
// every URI the playlist references. An EVENT playlist while it records, VOD
// (#EXT-X-ENDLIST) once finished; the client plays it directly.
// ---------------------------------------------------------------------------

/** The HLS recording with this id, or null (any other recording is not HLS). */
function hlsRecording(id) {
    const rec = recordingsDb.getById(parseInt(id));
    return rec && rec.format === 'hls' && rec.hls_dir ? rec : null;
}

// Exactly the names the recorder writes (hlsRecorder.js).
const HLS_RECORDING_FILE = /^\/(\d+)\/(seg\d{4,}\.(?:ts|m4s)|init(?:-\d+)?\.mp4)$/;

// Not an HLS recording: with the tuner off, whatever answered before still does
// (an HLS recording made while it was on keeps playing after it is turned off).
const notHls = (res, next) => (require('../services/tuner').enabled()
    ? res.status(404).json({ error: 'Recording not found' })
    : next());

router.get('/:id/index.m3u8', async (req, res, next) => {
    try {
        const rec = hlsRecording(req.params.id);
        if (!rec) return notHls(res, next);
        // Just started, no segment yet: hold the answer until there is one (0129).
        if (rec.status === 'recording') await recordingEngine.waitForFirstTunedSegment(rec.id);
        let playlist;
        try {
            playlist = fs.readFileSync(path.join(rec.hls_dir, 'index.m3u8'), 'utf8');
        } catch (e) {
            return res.status(404).json({ error: 'Recording playlist not found' });
        }
        const { withStreamToken } = require('./transcode');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(withStreamToken(playlist, req.query.token));
    } catch (err) {
        console.error('[Recordings] Playlist error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

router.get(HLS_RECORDING_FILE, (req, res, next) => {
    const rec = hlsRecording(req.params[0]);
    if (!rec) return notHls(res, next);
    const file = path.join(rec.hls_dir, req.params[1]);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Segment not found' });
    // As the live segments: fMP4 too goes out as video/MP2T (blueprint §4).
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    // Express 5 (0137): send ignores paths through a dot-folder by default; the
    // file names are allow-listed above, and a folder may be dotted.
    res.sendFile(file, { dotfiles: 'allow' });
});

// Stream a recording for playback, with HTTP Range support for seeking
router.get('/:id/stream', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (rec && rec.format === 'hls' && String(rec.file_path).endsWith('.m3u8')) {
            return res.status(409).json({ error: 'Recording is not ready as a single file yet' });
        }
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        serveWithRangeSupport(req, res, rec.file_path, rec.format === 'hls' ? 'video/mp4' : 'video/x-matroska');
    } catch (err) {
        console.error('[Recordings] Stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Native-client playback: an H.264/HEVC + AAC/AC-3 MP4 remux of the
// recording (see recordingEngine.ensureNativePlayback), for a player with
// no Matroska demuxer — real Range support, since a finished recording is
// a complete, seekable file, unlike a live stream. Resolved via
// /:id/playback below; served here directly too so a client that already
// has the URL cached doesn't need a resolve round-trip on every play.
router.get('/:id/media.mp4', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        if (rec.status !== 'completed' || (rec.format === 'hls' && String(rec.file_path).endsWith('.m3u8'))) {
            return res.status(409).json({ error: 'Recording is not finished yet' });
        }

        const filePath = await recordingEngine.ensureNativePlayback(rec);
        serveWithRangeSupport(req, res, filePath, 'video/mp4');
    } catch (err) {
        console.error('[Recordings] Native media error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Download a recording
router.get('/:id/download', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (rec && rec.format === 'hls' && String(rec.file_path).endsWith('.m3u8')) {
            return res.status(409).json({ error: 'Recording is not ready as a single file yet' });
        }
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        const downloadName = `${rec.title || 'recording'}${path.extname(rec.file_path)}`;
        res.download(rec.file_path, downloadName, { dotfiles: 'allow' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Everything below this line requires a valid JWT.
router.use(requireAuth);

// --- Scheduling -------------------------------------------------------

// Schedule a recording from an EPG program
router.post('/schedule', async (req, res) => {
    try {
        const {
            sourceId, channelItemId, channelName, channelLogo,
            title, description, programStart, programEnd,
            preBufferMin, postBufferMin
        } = req.body;

        if (!sourceId || !channelItemId || !programStart || !programEnd) {
            return res.status(400).json({ error: 'sourceId, channelItemId, programStart and programEnd are required' });
        }

        const schedule = await recordingEngine.scheduleFromProgram({
            sourceId: parseInt(sourceId),
            channelItemId,
            channelName,
            channelLogo,
            title,
            description,
            programStart: Number(programStart),
            programEnd: Number(programEnd),
            preBufferMin: preBufferMin !== undefined ? Number(preBufferMin) : undefined,
            postBufferMin: postBufferMin !== undefined ? Number(postBufferMin) : undefined,
            createdBy: req.user?.id
        });

        res.status(201).json(schedule);
    } catch (err) {
        console.error('[Recordings] Schedule error:', err);
        res.status(500).json({ error: err.message });
    }
});

// In-progress recordings only. Polled by the UI to warn about stream
// contention, so it is deliberately cheap.
router.get('/active', (req, res) => {
    try {
        res.json(recordingEngine.listActive());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List upcoming / in-progress scheduled recordings
router.get('/scheduled', (req, res) => {
    try {
        res.json(recordingEngine.listScheduled());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel (or stop, if currently recording) a scheduled recording
router.delete('/scheduled/:id', async (req, res) => {
    try {
        const result = await recordingEngine.cancelScheduled(parseInt(req.params.id));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Recorded files -----------------------------------------------------

// List all recordings (completed / recording / failed)
router.get('/', (req, res) => {
    try {
        res.json(recordingEngine.listRecordings());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Resolve how a client should play this recording. Native clients have no
// Matroska demuxer, so the plain answer for those is always the same shape
// live playback already uses: a URL, a container, and (here) a duration —
// which /:id/media.mp4 above then actually serves, remuxing on first
// request via recordingEngine.ensureNativePlayback. Kept as its own
// endpoint (rather than just handing out the media URL directly) so a
// client always has something to resolve against, the same as
// /api/playback/resolve for live channels, and so the remux — the only
// part of this with a real, if usually small, cost — is triggered
// explicitly rather than on a bare page load that never plays anything.
router.get('/:id/playback', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        // 0127 (C-E): an HLS recording plays at once, finished or still recording.
        if (rec.format === 'hls' && rec.hls_dir && (rec.status === 'completed' || rec.status === 'recording')) {
            const inProgress = rec.status === 'recording';
            // 0129: Play pressed the moment it started - answer once there is something to play.
            if (inProgress) await recordingEngine.waitForFirstTunedSegment(rec.id);
            const progress = inProgress ? recordingEngine.tunedRecordingProgress(rec.id) : null;
            return res.json({
                url: `/api/recordings/${rec.id}/index.m3u8`,
                container: 'hls',
                durationSec: inProgress ? (progress ? progress.durationSec : 0) : (rec.duration_sec || null),
                inProgress
            });
        }
        if (rec.status !== 'completed') {
            return res.status(409).json({ error: 'Recording is not finished yet' });
        }

        if (req.query.async === '1') {
            // Polling flavour, for a client that cannot wait out a long remux (the Apple
            // client's requests time out after 35 s). Ready -> 200 as below; still working
            // -> 202 and ask again; failed -> 500 once, and asking again starts afresh.
            let status = recordingEngine.pollNativePlayback(rec);
            if (status.state === 'idle') status = await recordingEngine.startNativePlaybackAndWait(rec);
            if (status.state === 'failed') {
                return res.status(500).json({
                    status: 'failed',
                    reason: status.reason,
                    error: 'The server could not prepare this recording for playback'
                });
            }
            if (status.state !== 'ready') {
                res.set('Retry-After', '3');
                return res.status(202).json({ status: 'preparing', retryAfterSec: 3 });
            }
        } else {
            // Resolving here as well as serving lazily in /media.mp4 means the
            // first real playback request doesn't also pay for the remux.
            await recordingEngine.ensureNativePlayback(rec);
        }

        res.json({
            url: `/api/recordings/${rec.id}/media.mp4`,
            container: 'mp4',
            durationSec: rec.duration_sec || null
        });
    } catch (err) {
        console.error('[Recordings] Playback resolve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Commercial breaks found in a recording, for a player to skip.
router.get('/:id/markers', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        res.json({
            status: rec.ad_detect_status || null,
            error: rec.ad_detect_error || null,
            markers: recordingsDb.getMarkers(rec.id).map(m => ({
                id: m.id,
                startMs: m.start_ms,
                endMs: m.end_ms,
                type: m.type,
                source: m.source
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Detect (or re-detect) commercial breaks now.
router.post('/:id/detect-ads', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        if (rec.status !== 'completed') {
            return res.status(400).json({ error: 'Only completed recordings can be analysed' });
        }
        if (rec.ad_detect_status === 'running') {
            return res.status(409).json({ error: 'Already analysing' });
        }

        recordingsDb.setAdDetectStatus(rec.id, 'pending', null);
        recordingEngine.processAdDetectionQueue({ manual: true }).catch(err =>
            console.error('[Recordings] Break detection error:', err.message));

        res.json({ success: true, queued: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Discard the detected breaks for a recording, when detection got it wrong.
router.delete('/:id/markers', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        recordingsDb.deleteMarkers(rec.id);
        recordingsDb.setAdDetectStatus(rec.id, null, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Queue a completed recording for compression, or run it now.
// Automatic compression only marks recordings finished after the feature was
// enabled, so anything already on disk needs an explicit nudge.
router.post('/:id/compress', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        if (rec.status !== 'completed') {
            return res.status(400).json({ error: 'Only completed recordings can be compressed' });
        }
        if (rec.compress_status === 'running') {
            return res.status(409).json({ error: 'Already compressing' });
        }

        recordingsDb.setCompressStatus(rec.id, 'pending', { error: null });
        // Kick the queue rather than waiting up to 15s for the next tick.
        recordingEngine.processCompressionQueue().catch(err =>
            console.error('[Recordings] Compression error:', err.message));

        res.json({ success: true, queued: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a recording (stops it first if still in progress) and its file
router.delete('/:id', async (req, res) => {
    try {
        await recordingEngine.deleteRecording(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
