const express = require('express');
const router = express.Router();
const { probeStream, analyzeProbeResult, probeCache, CACHE_TTL } = require('../services/streamProbe');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 *
 * The logic lives in services/streamProbe so the playback route can share it.
 */

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    // Client-declared codec support, from MediaSource.isTypeSupported
    const clientCaps = {
        hevc: req.query.hevc === '1',
        av1: req.query.av1 === '1',
        ac3: req.query.ac3 === '1',
        eac3: req.query.eac3 === '1',
        flac: req.query.flac === '1'
    };
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    // Capabilities are part of the key: the same stream resolves differently
    // for a client that can decode HEVC than for one that cannot.
    const capKey = Object.keys(clientCaps).filter(k => clientCaps[k]).sort().join(',');
    const cacheKey = `${url}${ua ? `|${ua}` : ''}|${capKey}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Probe] Cache hit for: ${url.substring(0, 50)}...`);
        return res.json(cached.result);
    }

    console.log(`[Probe] Probing: ${url.substring(0, 80)}... ${ua ? `(UA: ${ua})` : ''}`);

    try {
        const probeResult = await probeStream(url, ffprobePath, ua);
        const analysis = analyzeProbeResult(probeResult, url, clientCaps);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        console.error('[Probe] Failed:', err.message);

        // On error, assume transcode needed to be safe
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            error: err.message
        });
    }
});

module.exports = router;
