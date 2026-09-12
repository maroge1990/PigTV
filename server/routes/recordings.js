const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../auth');
const recordingEngine = require('../services/recordingEngine');
const { recordings: recordingsDb } = require('../db/recordingsDb');

// NOTE: /:id/stream and /:id/download are deliberately registered BEFORE the
// requireAuth middleware. requireAuth is passport-jwt with a Bearer-header
// extractor, and a <video src> / <a href> request from the browser cannot send
// that header, so these two would always 401. The existing live-stream routes
// (/api/proxy, /api/transcode, /api/remux) are unauthenticated for the same
// reason; this keeps recordings consistent with them.

// Stream a recording for playback, with HTTP Range support for seeking
router.get('/:id/stream', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
            return res.status(404).json({ error: 'Recording file not found' });
        }

        const stat = fs.statSync(rec.file_path);
        const fileSize = stat.size;
        const range = req.headers.range;
        const contentType = 'video/x-matroska';

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
            fs.createReadStream(rec.file_path, { start, end }).pipe(res);
        } else {
            res.set({
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(rec.file_path).pipe(res);
        }
    } catch (err) {
        console.error('[Recordings] Stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Download a recording
router.get('/:id/download', (req, res) => {
    try {
        const rec = recordingsDb.getById(parseInt(req.params.id));
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
            return res.status(404).json({ error: 'Recording file not found' });
        }
        const downloadName = `${rec.title || 'recording'}${path.extname(rec.file_path)}`;
        res.download(rec.file_path, downloadName);
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
