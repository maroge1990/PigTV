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
 *   remux     container change only, stream copy, one ffmpeg pipe
 *   transcode re-encode something, the only expensive option
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

    // Whether this client needs an actual HLS playlist and segment files,
    // as opposed to a single piped response it reads as a byte stream.
    //
    // Deliberately separate from hls/fmp4 above, which describe codec and
    // container support, not delivery shape. A browser using hls.js or a
    // plain <video> tag is happy with the /api/remux response: one ffmpeg
    // process, stdout piped straight into the HTTP response, non-seekable,
    // no Range support. AVPlayer is not — it expects ordinary HTTP requests
    // against a playlist and its segments, and reports a piped stream as a
    // misconfigured server (AVFoundationErrorDomain -11850
    // serverIncorrectlyConfigured) rather than simply refusing to seek.
    // Native clients must opt in explicitly; nothing changes for a client
    // that doesn't set this.
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
 * @returns {Promise<object>} a decision, including a playable URL
 */
async function resolve({ url, capabilities = {}, settings, ffprobePath, upscale = false }) {
    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);

    // Probe, with the client's capabilities folded in. The same stream
    // resolves differently for a client that can decode HEVC than one that
    // cannot, so capabilities are part of the cache key.
    const capKey = Object.keys(caps).filter(k => caps[k]).sort().join(',');
    const cacheKey = `${url}|${userAgent || ''}|${capKey}`;

    let info;
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        info = cached.result;
    } else {
        const raw = await probeStream(url, ffprobePath, userAgent);
        info = analyzeProbeResult(raw, url, caps);
        probeCache.set(cacheKey, { result: info, timestamp: Date.now() });
    }

    const encoded = encodeURIComponent(url);

    // 1. Direct play. Nothing to do — no ffmpeg, no server CPU, no added
    //    latency. Only available when the container is already something the
    //    client handles and both codecs are decodable.
    if (info.compatible && !upscale) {
        return {
            strategy: 'direct',
            url: `/api/proxy/stream?url=${encoded}`,
            container: info.container,
            info,
            reason: 'Client can play the source directly'
        };
    }

    // 2. Remux. A container change with the video and audio copied through.
    //    Cheap enough to be effectively free, so it beats any encode.
    //
    //    Two delivery shapes share this "codecs are fine" case. Piped MP4
    //    (/api/remux) is the cheaper of the two — one ffmpeg process,
    //    stdout straight into the response — but it's a non-seekable
    //    single response with no Range support, which AVPlayer refuses
    //    (see segmentedDelivery above). Clients that set segmentedDelivery
    //    fall through to case 3 instead, which already has an HLS-session
    //    code path for exactly this "copy both streams" case — it just
    //    needed a way to reach it without also being asked to re-encode.
    const audioNeedsWork = info.audioOk === false;
    const codecsOk = !upscale && info.videoOk && !audioNeedsWork;

    if (codecsOk && !caps.segmentedDelivery) {
        return {
            strategy: 'remux',
            url: `/api/remux?url=${encoded}`,
            container: 'fmp4',
            info,
            reason: 'Codecs are fine; only the container needs changing'
        };
    }

    // 3. Transcode. Encode as little as possible: if the client can decode the
    //    video, copy it and fix only the audio.
    //
    //    fmp4 segments over mpegts whenever caps.fmp4 and either the video
    //    is HEVC (hls.js cannot demux HEVC out of MPEG-TS) or this is the
    //    codecsOk case: both streams already fine, only here because
    //    segmentedDelivery asked for segments instead of a pipe. Before
    //    segmentedDelivery existed this same content went out through
    //    /api/remux, whose own output is fmp4-family regardless of codec
    //    (see the container: 'fmp4' above) - MPEG-TS's much stricter
    //    real-time PTS/DTS ordering requirements are exactly what produced
    //    a continuous "Invalid DTS ... replacing by guess" flood from a
    //    native session on H.264 content that played fine over remux: the
    //    same stream, correct either way, muxed into a container the
    //    source's timestamps don't actually satisfy.
    const canCopyVideo = info.videoOk === true && !upscale;
    const videoMode = canCopyVideo ? 'copy' : 'encode';
    const segmentType = (canCopyVideo && caps.fmp4 && (info.videoIsHevc || codecsOk)) ? 'fmp4' : 'mpegts';

    const session = await transcodeSession.createSession(url, {
        ffmpegPath: settings.ffmpegPath,
        userAgent,
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
        audioMode: codecsOk ? 'copy' : undefined,
        videoCodec: info.video,
        audioCodec: info.audio,
        audioChannels: info.audioChannels,
        audioProfile: info.audioProfile,
        isHeAac: info.isHeAac
    });

    await session.start();

    const ready = await session.waitForPlaylist(15000);
    if (!ready) {
        await transcodeSession.removeSession(session.id);
        const err = new Error('Transcode failed to produce a playlist in time');
        err.info = info;
        throw err;
    }

    return {
        strategy: 'transcode',
        url: `/api/transcode/${session.id}/stream.m3u8`,
        sessionId: session.id,
        container: 'hls',
        videoMode,
        segmentType,
        info,
        reason: codecsOk
            ? 'Codecs are fine; delivered as HLS segments for this client instead of a piped stream'
            : (canCopyVideo
                ? 'Video copied; audio re-encoded for this client'
                : (upscale ? 'Upscaling requested' : 'Video cannot be decoded by this client'))
    };
}

module.exports = { resolve, DEFAULT_CAPABILITIES };
