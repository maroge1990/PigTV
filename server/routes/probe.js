const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Codecs every target browser can decode without help.
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

// Codecs some browsers can decode, depending on platform support. The client
// tells us what it actually supports (via MediaSource.isTypeSupported) instead
// of us guessing, because assuming "no" here means re-encoding streams that
// would have played untouched.
const OPTIONAL_VIDEO_CODECS = {
    hevc: ['hevc', 'h265', 'hvc1', 'hev1'],
    av1: ['av1']
};
const OPTIONAL_AUDIO_CODECS = {
    ac3: ['ac3'],
    eac3: ['eac3', 'ec-3'],
    flac: ['flac']
};

function matchesAny(codec, list) {
    return list.some(c => codec.includes(c));
}

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            url
        ];

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url, clientCaps = {}) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const audioProfile = (audioStream?.profile || '').toLowerCase();

    // HE-AAC (AAC with SBR, and HE-AACv2 with PS) reports codec_name 'aac' just
    // like AAC-LC, so the profile is the only way to tell them apart. Chrome
    // answers true to isTypeSupported for the HE-AAC MIME string and then fails
    // to decode the packets: aac_adtstoasc writes an AudioSpecificConfig taken
    // from the ADTS header, which describes LC at the nominal rate, while the
    // payload is SBR at half that. The decoder rejects the first packet with
    // PIPELINE_ERROR_DECODE. Treat it as audio that needs re-encoding.
    const isHeAac = audioCodec.includes('aac') && audioProfile.includes('he-aac');
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Check codec compatibility. A codec is acceptable if every browser can
    // handle it, or if this particular client reported that it can.
    const videoIsHevc = matchesAny(videoCodec, OPTIONAL_VIDEO_CODECS.hevc);
    const videoIsAv1 = matchesAny(videoCodec, OPTIONAL_VIDEO_CODECS.av1);

    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c))
        || (videoIsHevc && clientCaps.hevc === true)
        || (videoIsAv1 && clientCaps.av1 === true);

    const audioOk = !isHeAac && (BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c))
        || (matchesAny(audioCodec, OPTIONAL_AUDIO_CODECS.ac3) && clientCaps.ac3 === true)
        || (matchesAny(audioCodec, OPTIONAL_AUDIO_CODECS.eac3) && clientCaps.eac3 === true)
        || (matchesAny(audioCodec, OPTIONAL_AUDIO_CODECS.flac) && clientCaps.flac === true));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        // Strategy hints. videoOk/audioOk say whether THIS client can decode
        // the streams as-is, which decides whether video can be stream-copied
        // (near-zero CPU) instead of re-encoded.
        videoOk: videoOk,
        audioOk: audioOk,
        audioProfile: audioStream?.profile || null,
        isHeAac: isHeAac,
        videoIsHevc: videoIsHevc,
        fps: videoStream?.avg_frame_rate || null,
        subtitles: subtitles
    };
}

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
