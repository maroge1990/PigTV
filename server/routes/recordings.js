const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { requireAuth } = require('../auth');
const recordingEngine = require('../services/recordingEngine');
const { recordings: recordingsDb } = require('../db/recordingsDb');
const segments = require('../services/recordingSegments');
const { buildMasterPlaylist } = require('../services/transcodeSession');
const { withStreamToken } = require('./transcode');

// NOTE: /:id/stream, /:id/media.mp4 and /:id/download are deliberately
// registered BEFORE the requireAuth middleware. requireAuth reads only a
// Bearer header (server/auth.js), and a <video src> / <a href> / AVURLAsset
// request cannot send that header, so these would always 401. The existing
// live-stream routes (/api/proxy, /api/transcode, /api/remux) are the same
// way; /api/recordings is wrapped in the same streamAuth middleware they use
// (see server/index.js), which accepts the token as ?token= instead and is
// always enforced (R01), so these are never open.

// Pipe a file to the response, closing the file whatever happens. A player that
// seeks abandons its range request part-way, which is ordinary and not logged;
// anything else (a read error on the share) goes to the caller's error path.
async function sendFileRange(stream, res) {
    try {
        await pipeline(stream, res);
    } catch (err) {
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.destroyed) return;
        throw err;
    }
}

// Serve a local file with HTTP Range support, for seeking. Shared by
// /:id/stream (the original .mkv) and /:id/media.mp4 (the native-playback
// remux) — the byte-range mechanics are identical, only the content type
// and which file differ. Async to avoid blocking the event loop on slow
// network shares (SMB); callers must await it.
async function serveWithRangeSupport(req, res, filePath, contentType) {
    const stat = await fsp.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        // One range (a player never asks for several; only the first is served).
        // 0138: RFC 9110 forms the old parser refused with a 416: a suffix range
        // ("bytes=-500", the last 500 bytes) and a last byte past the end of the
        // file, which means "to the end".
        const parts = range.replace(/bytes=/, '').split(',')[0].trim().split('-');
        let start, end;
        if (parts[0] === '' && parts[1]) {
            const suffix = parseInt(parts[1], 10);
            start = Math.max(0, fileSize - suffix);
            end = fileSize - 1;
            if (isNaN(suffix) || suffix <= 0) start = NaN;
        } else {
            start = parseInt(parts[0], 10);
            end = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
        }

        if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
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
        await sendFileRange(fs.createReadStream(filePath, { start, end }), res);
    } else {
        res.set({
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        });
        await sendFileRange(fs.createReadStream(filePath), res);
    }
}

// Stream a recording for playback, with HTTP Range support for seeking
router.get('/:id/stream', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec || !rec.file_path) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        // R3: a segmented recording has no single file until its MP4 is made (watch it from the start instead).
        if (rec.status === 'recording' && rec.work_dir) {
            return res.status(409).json({ error: 'Recording is not finished yet' });
        }
        try {
            await fsp.access(rec.file_path, fs.constants.F_OK);
        } catch (e) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        // 0192: once prepared (audit R06) the recording itself is an MP4.
        const isMp4 = path.extname(rec.file_path).toLowerCase() === '.mp4';
        const ext = path.extname(rec.file_path).toLowerCase();
        await serveWithRangeSupport(req, res, rec.file_path, isMp4 ? 'video/mp4' : ext === '.ts' ? 'video/mp2t' : 'video/x-matroska');
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
        if (rec.status !== 'completed') {
            return res.status(409).json({ error: 'Recording is not finished yet' });
        }

        const filePath = await recordingEngine.ensureNativePlayback(rec);
        await serveWithRangeSupport(req, res, filePath, 'video/mp4');
    } catch (err) {
        console.error('[Recordings] Native media error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// --- Watch from the start while recording (R3) -------------------------
// A segmented recording in progress, as HLS: a one-variant master playlist (VIDEO-RANGE and
// FRAME-RATE, so the Apple TV switches to HDR and 50 Hz), the media playlist of its fMP4 watch
// copy, and that copy's files. Token on every URI (withStreamToken), names allow-listed, never a
// path. 404 once the recording is finished: the client plays its MP4 from then on.

function watchableRecording(req) {
    const rec = recordingsDb.getById(parseInt(req.params.id));
    return segments.isWatchable(rec) ? rec : null;
}

router.get('/:id/live/master.m3u8', async (req, res) => {
    const rec = watchableRecording(req);
    if (!rec) return res.status(404).json({ error: 'Not being recorded' });
    const info = (await segments.probeVideoInfo(rec)) || { videoRange: 'SDR', fps: null, width: null, height: null };
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(withStreamToken(buildMasterPlaylist(info), req.query.token));
});

router.get('/:id/live/stream.m3u8', async (req, res) => {
    const rec = watchableRecording(req);
    if (!rec) return res.status(404).json({ error: 'Not being recorded' });
    await segments.ensureView(rec); // after a restart the watch copy starts again here
    const { text } = segments.viewPlaylist(rec.work_dir, { captureOver: rec.segment_state !== 'capturing' });
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(withStreamToken(text, req.query.token));
});

router.get('/:id/live/:epoch/:file', async (req, res) => {
    const { epoch, file } = req.params;
    if (!/^e\d{1,4}$/.test(epoch) || !/^(init\.mp4|v\d{6,}\.m4s)$/.test(file)) {
        return res.status(404).json({ error: 'Invalid segment' });
    }
    const rec = watchableRecording(req);
    if (!rec) return res.status(404).json({ error: 'Not being recorded' });
    const filePath = path.join(rec.work_dir, epoch, file);
    try { await fsp.access(filePath, fs.constants.F_OK); } catch (e) { return res.status(404).json({ error: 'Segment not found' }); }
    // As the live routes serve them (proven on the Apple TV); see blueprint §3 "HLS file names".
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // a written segment never changes
    res.sendFile(filePath, { dotfiles: 'allow' });
});

// Download a recording
router.get('/:id/download', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec || !rec.file_path) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        try {
            await fsp.access(rec.file_path, fs.constants.F_OK);
        } catch (e) {
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
        // R6: the artwork's address stays on the server (the other lists give /api/logo/<key>).
        res.json(recordingEngine.listActive().map(({ image_url, ...row }) => row));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List upcoming / in-progress scheduled recordings. `?include=recent` (0156) also
// lists schedules that ended up missed or failed in the last 7 days, each with
// its status and error - otherwise identical to the plain response, so an older
// Apple client decoding this route unchanged sees no difference.
router.get('/scheduled', (req, res) => {
    try {
        const includeRecent = req.query.include === 'recent';
        res.json(recordingEngine.listScheduled({ includeRecent }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel (or stop, if currently recording) a scheduled recording. 0207: for a failed or
// missed one (the "Recent problems" list) this deletes it instead, with its failed
// recordings and their files, and answers { deleted: true }.
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
        res.json(recordingEngine.listRecordings(req.user?.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Resume position (0207), per login ------------------------------------
// req.user.id is the login's user id for a browser token and for a paired device's token
// alike (a device token names the user who approved the pairing), so a TV and a phone on one
// login share a position.

const NOT_STARTED = { position_sec: 0, watched: false, updated_at: null };

router.get('/:id/position', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        res.json(recordingsDb.getPosition(rec.id, req.user.id) || NOT_STARTED);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Last write wins. `watched` is worked out here unless the client forces it: finished means
// within the last 10 minutes or 5% of the recording, whichever is less (a 4 h film is done
// with 10 minutes left, a 30 min programme only inside the last 90 s).
router.put('/:id/position', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        const { position_sec: position, watched: forced } = req.body || {};
        if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
            return res.status(400).json({ error: 'position_sec must be a number, 0 or more' });
        }
        if (forced !== undefined && typeof forced !== 'boolean') {
            return res.status(400).json({ error: 'watched must be true or false' });
        }
        const duration = Number(rec.duration_sec) || 0;
        const watched = forced !== undefined
            ? forced
            : duration > 0 && (duration - position) <= Math.min(600, 0.05 * duration);
        res.json(recordingsDb.setPosition(rec.id, req.user.id, position, watched));
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

// R3: how to watch a recording from the start while it is still being recorded. 200 with the
// master playlist's URL once the first piece of the watch copy exists; 202 while it is being
// made (ask again); 409 when this recording cannot be watched this way (not segmented, or
// finished: play it with /:id/playback).
router.get('/:id/watch', async (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec) return res.status(404).json({ error: 'Recording not found' });
        if (!segments.isWatchable(rec)) {
            return res.status(409).json({
                error: rec.status === 'completed' ? 'Recording is finished: play it instead' : 'This recording cannot be watched while it records',
                finished: rec.status === 'completed'
            });
        }
        await segments.ensureView(rec);
        const deadline = Date.now() + 4000;
        let view = segments.viewPlaylist(rec.work_dir);
        while (view.segments === 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 250));
            view = segments.viewPlaylist(rec.work_dir);
        }
        if (view.segments === 0) {
            res.set('Retry-After', '2');
            return res.status(202).json({ status: 'preparing', retryAfterSec: 2 });
        }
        const info = (await segments.probeVideoInfo(rec)) || {};
        res.json({
            url: `/api/recordings/${rec.id}/live/master.m3u8`,
            container: 'hls',
            recording: rec.segment_state === 'capturing',
            videoRange: info.videoRange || 'SDR',
            fps: info.fps || null,
            durationSec: Math.round(segments.recordedSeconds(rec.work_dir))
        });
    } catch (err) {
        console.error('[Recordings] Watch error:', err.message);
        res.status(500).json({ error: 'Could not start watching this recording' });
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

// --- Recording rules (R5) ------------------------------------------------
// Any signed-in user, as scheduling is. A rule makes ordinary schedules (rule_id on the row).

router.get('/rules', (req, res) => {
    try {
        res.json(require('../services/recordingRules').list());
    } catch (err) {
        console.error('[Rules] list failed:', err.message);
        res.status(500).json({ error: 'Could not list the recording rules' });
    }
});

router.post('/rules', async (req, res) => {
    try {
        const rules = require('../services/recordingRules');
        const result = rules.create(req.body || {}, req.user?.id ?? null);
        if (result.error) return res.status(400).json({ error: result.error });
        // Acted on at once, so the answer can say what it scheduled.
        const made = await rules.evaluate();
        res.status(result.existing ? 200 : 201).json({
            ...rules.get(result.rule.id),
            scheduled: made.filter(m => m.ruleId === result.rule.id).length
        });
    } catch (err) {
        console.error('[Rules] create failed:', err.message);
        res.status(500).json({ error: 'Could not add the recording rule' });
    }
});

router.put('/rules/:ruleId', async (req, res) => {
    try {
        const rules = require('../services/recordingRules');
        const result = rules.update(parseInt(req.params.ruleId, 10), req.body || {});
        if (!result) return res.status(404).json({ error: 'Rule not found' });
        if (result.error) return res.status(400).json({ error: result.error });
        if (result.rule.enabled) await rules.evaluate();
        res.json(rules.get(result.rule.id));
    } catch (err) {
        console.error('[Rules] update failed:', err.message);
        res.status(500).json({ error: 'Could not change the recording rule' });
    }
});

router.delete('/rules/:ruleId', (req, res) => {
    try {
        const result = require('../services/recordingRules').remove(parseInt(req.params.ruleId, 10));
        if (!result) return res.status(404).json({ error: 'Rule not found' });
        res.json({ success: true, cancelled: result.cancelled });
    } catch (err) {
        console.error('[Rules] delete failed:', err.message);
        res.status(500).json({ error: 'Could not delete the recording rule' });
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
