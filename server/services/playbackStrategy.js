/**
 * Playback strategy.
 *
 * Given a stream and what a client can decode, decide the cheapest way to make
 * it playable and return something the client can hand straight to its player.
 *
 * This used to live in the browser: VideoPlayer probed, applied a set of
 * heuristics, then asked for a specific session type. That worked while there
 * was one client, but it puts the rules in the least durable place. A native
 * client would have to reimplement them, and the two would drift.
 *
 * The order of preference is always the same, cheapest first:
 *
 *   direct    the client can play the source URL as-is; we do nothing
 *   transcode an HLS session: stream copy where the client can decode the
 *             codecs, re-encode only what it cannot
 *
 * There used to be a third, "remux" - a container change piped through one
 * ffmpeg process to /api/remux - for browsers. It was retired in 0103: every
 * client now gets HLS segments, one delivery path.
 *
 * "Cheapest" is decided by what the client reports it can decode, not by what
 * we assume. Assuming a codec is unsupported costs a full re-encode of a
 * stream that would have played untouched.
 */

const { probeStream, analyzeProbeResult, probeCache, CACHE_TTL } = require('./streamProbe');
const transcodeSession = require('./transcodeSession');
const db = require('../db');

const DEFAULT_CAPABILITIES = {
    hevc: false,
    av1: false,
    ac3: false,
    eac3: false,
    flac: false,
    hls: true,      // native HLS, as Safari and AVPlayer have
    fmp4: true,     // fragmented MP4 segments

    // Once chose HLS segments over the piped /api/remux stream. Every client
    // now gets segments (0103), so it no longer changes the decision; still
    // accepted, and both clients send it.
    segmentedDelivery: false
};

/**
 * Work out how a given client should play a given stream.
 *
 * @param {object} opts
 * @param {string} opts.url           the upstream stream URL
 * @param {object} opts.capabilities  what the client can decode
 * @param {object} opts.settings      app settings
 * @param {string} opts.ffprobePath
 * @param {boolean} opts.upscale      force an encode for upscaling
 * @param {string}  opts.owner        who is asking (see streamCoordinator.ownerKey)
 * @param {boolean} opts.live         live TV, as opposed to something seekable
 * @param {boolean} opts.audioEncode  re-encode the audio rather than copying it in the HLS
 *                                    session, for a stream whose audio
 *                                    frames the client's decoder could not cope with
 * @returns {Promise<object>} a decision, including a playable URL
 */
async function resolve({ url, capabilities = {}, settings, ffprobePath, upscale = false, owner = null, live = false, audioEncode = false }) {
    // Where the seconds of a channel change go, for `docker logs | grep "resolve timing"`.
    const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);

    // Probe, with the client's capabilities folded in. The same stream
    // resolves differently for a client that can decode HEVC than one that
    // cannot, so capabilities are part of the cache key.
    const capKey = Object.keys(caps).filter(k => caps[k]).sort().join(',');
    const cacheKey = `${url}|${userAgent || ''}|${capKey}`;

    let info;
    let probeNote = 'cached';
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        info = cached.result;
    } else {
        const probeStartedAt = Date.now();
        const raw = await probeStream(url, ffprobePath, userAgent);
        info = analyzeProbeResult(raw, url, caps);
        probeCache.set(cacheKey, { result: info, timestamp: Date.now() });
        probeNote = seconds(Date.now() - probeStartedAt);
    }

    const encoded = encodeURIComponent(url);

    // 1. Direct play. Nothing to do — no ffmpeg, no server CPU, no added
    //    latency. Only available when the container is already something the
    //    client handles and both codecs are decodable.
    if (info.compatible && !upscale) {
        console.log(`[Playback] resolve timing: direct, probe ${probeNote}`);
        return {
            strategy: 'direct',
            url: `/api/proxy/stream?url=${encoded}`,
            container: info.container,
            info,
            reason: 'Client can play the source directly'
        };
    }

    // 2. Everything else is an HLS session. Copy what the client can decode
    //    (both streams when the codecs are fine, and only the container needs
    //    changing - what /api/remux used to do); re-encode only what it cannot.
    const audioNeedsWork = info.audioOk === false;
    const codecsOk = !upscale && info.videoOk && !audioNeedsWork;

    //    fmp4 segments over mpegts whenever caps.fmp4 and either the video
    //    is HEVC (hls.js cannot demux HEVC out of MPEG-TS) or this is the
    //    codecsOk case: both streams already fine. That content used to go
    //    out through /api/remux, whose own output was fmp4-family regardless
    //    of codec - MPEG-TS's much stricter
    //    real-time PTS/DTS ordering requirements are exactly what produced
    //    a continuous "Invalid DTS ... replacing by guess" flood from a
    //    native session on H.264 content that played fine over remux: the
    //    same stream, correct either way, muxed into a container the
    //    source's timestamps don't actually satisfy.
    const canCopyVideo = info.videoOk === true && !upscale;
    const videoMode = canCopyVideo ? 'copy' : 'encode';
    const segmentType = (canCopyVideo && caps.fmp4 && (info.videoIsHevc || codecsOk)) ? 'fmp4' : 'mpegts';
    // An HDR feed copied into fMP4 keeps its colour tagging, but only a master
    // playlist can tell the player so (VIDEO-RANGE) - see classifyVideoRange. Not
    // for an encode, whose output is not the source's HDR, nor for MPEG-TS.
    const videoRange = (videoMode === 'copy' && segmentType === 'fmp4' && info.videoRange) || null;

    const session = await transcodeSession.createSession(url, {
        ffmpegPath: settings.ffmpegPath,
        userAgent,
        owner,
        live,
        hwEncoder: settings.hwEncoder || 'software',
        maxResolution: settings.maxResolution || '1080p',
        quality: settings.quality || 'medium',
        audioMixPreset: settings.audioMixPreset || 'auto',
        upscaleEnabled: upscale || settings.upscaleEnabled || false,
        upscaleMethod: settings.upscaleMethod || 'hardware',
        upscaleTarget: settings.upscaleTarget || '1080p',
        vaapiCpuScale: settings.vaapiCpuScale !== false,
        vaapiHwDecode: settings.vaapiHwDecode !== false,
        segmentType,
        videoMode,
        // A source that ends is read at full speed unless told otherwise, and an HLS session
        // only keeps a few minutes of segments: ffmpeg would be half an hour ahead of the
        // player within seconds, and the player's next segment would be gone (a 404).
        paceInput: info.finite === true,
        // Whether this feed's own DTS is worth keeping - see buildFFmpegArgs.
        dtsUneven: info.dtsUneven === true,
        videoRange,
        width: info.width,
        height: info.height,
        fps: info.fps,
        audioMode: audioEncode ? 'encode' : (codecsOk ? 'copy' : undefined),
        videoCodec: info.video,
        audioCodec: info.audio,
        audioChannels: info.audioChannels,
        audioProfile: info.audioProfile,
        isHeAac: info.isHeAac
    });

    const sessionStartedAt = Date.now();
    await session.start();

    const ready = await session.waitForPlaylist(15000);
    const pacing = info.finite === true ? `, source ends${info.durationSec ? ` (${Math.round(info.durationSec / 60)} min)` : ''} - paced to real time` : '';
    // Say which way the feed was classified: otherwise the igndts decision is
    // invisible in the log and a wrong call cannot be told from an unrelated fault.
    const timing = videoMode === 'copy'
        ? `, source timing ${info.dtsUneven === true ? 'uneven - DTS rebuilt' : (info.dtsUneven === false ? 'even - DTS kept' : 'unknown - DTS kept')}`
        : '';
    const range = videoRange ? `, HDR ${videoRange} - master playlist` : '';
    console.log(`[Playback] resolve timing: HLS session, probe ${probeNote}, first segment ${ready ? `after ${seconds(Date.now() - sessionStartedAt)}` : 'NOT produced in time'}${pacing}${timing}${range}`);
    if (!ready) {
        await transcodeSession.removeSession(session.id);
        const err = new Error('Transcode failed to produce a playlist in time');
        err.info = info;
        throw err;
    }

    return {
        strategy: 'transcode',
        url: `/api/transcode/${session.id}/${videoRange ? 'master' : 'stream'}.m3u8`,
        sessionId: session.id,
        container: 'hls',
        videoMode,
        segmentType,
        info,
        reason: codecsOk
            ? 'Codecs are fine; only the container changes, into HLS segments'
            : (canCopyVideo
                ? 'Video copied; audio re-encoded for this client'
                : (upscale ? 'Upscaling requested' : 'Video cannot be decoded by this client'))
    };
}

module.exports = { resolve, DEFAULT_CAPABILITIES };
