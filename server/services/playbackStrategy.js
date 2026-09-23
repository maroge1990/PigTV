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

const { probeStream, analyzeProbeResult, probeCache, CACHE_TTL, parseFrameRate } = require('./streamProbe');
const transcodeSession = require('./transcodeSession');
const channelProfiles = require('./channelProfiles');
const db = require('../db');

const DEFAULT_CAPABILITIES = {
    hevc: false,
    av1: false,
    ac3: false,
    eac3: false,
    flac: false,
    // HE-AAC (AAC with SBR/PS). Off by default: Chrome says it can and then fails
    // on the first packet (see streamProbe). AVPlayer decodes it natively; a client
    // that sends heaac: true gets it copied instead of re-encoded to AAC-LC (0116).
    heaac: false,
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

    // Where the analysis comes from, cheapest first: the 5-minute in-memory cache, then
    // the channel's stored profile (0114: no ffprobe at all), then a probe. `fromProfile`
    // follows a profile through the in-memory cache, so a failed start can drop both.
    let info;
    let probeNote = 'cached';
    let fromProfile = false;
    let probedAt = null;
    const cached = probeCache.get(cacheKey);
    const cacheFresh = !!cached && (Date.now() - cached.timestamp) < CACHE_TTL;
    const profile = cacheFresh ? null : channelProfiles.get(cacheKey);
    if (cacheFresh) {
        info = cached.result;
        fromProfile = cached.fromProfile === true;
        probedAt = cached.probedAt || cached.timestamp;
    } else if (profile) {
        info = profile.info;
        fromProfile = true;
        probedAt = profile.probedAt;
        probeCache.set(cacheKey, { result: info, timestamp: Date.now(), fromProfile: true, probedAt });
        probeNote = `profile (age ${profile.ageDays}d)`;
    } else {
        const probeStartedAt = Date.now();
        const raw = await probeStream(url, ffprobePath, userAgent);
        info = analyzeProbeResult(raw, url, caps);
        probedAt = Date.now();
        probeCache.set(cacheKey, { result: info, timestamp: probedAt, probedAt });
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
    // The master playlist (VIDEO-RANGE, FRAME-RATE) a session is handed out through.
    //  - An HDR feed copied into fMP4 keeps its colour tagging, but only a master
    //    playlist can tell the player so - see classifyVideoRange (0100).
    //  - Every other session with a usable frame rate gets one too, as SDR (0115):
    //    Match Frame Rate on the Apple TV reads FRAME-RATE from it. An encode is SDR
    //    whatever the source was.
    //  - An HDR feed copied into MPEG-TS gets none, as before: declaring it SDR would
    //    be a lie, and 0100 only verified the HDR tagging through fMP4.
    const hdrCopy = videoMode === 'copy' && !!info.videoRange;
    const frameRate = parseFrameRate(info.fps);
    let videoRange = null;
    if (hdrCopy && segmentType === 'fmp4') videoRange = info.videoRange;
    else if (!hdrCopy && frameRate !== null) videoRange = 'SDR';

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
        // RESOLUTION in the master playlist: the source's, which is only the output's
        // when the video is copied (an encode may scale it).
        width: videoMode === 'copy' ? info.width : 0,
        height: videoMode === 'copy' ? info.height : 0,
        fps: info.fps,
        audioMode: audioEncode ? 'encode' : (codecsOk ? 'copy' : undefined),
        videoCodec: info.video,
        audioCodec: info.audio,
        audioChannels: info.audioChannels,
        audioProfile: info.audioProfile,
        isHeAac: info.isHeAac,
        // This client decodes HE-AAC, so the session may copy it (0116).
        heaacCopy: caps.heaac === true
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
    const range = videoRange === 'SDR'
        ? `, master playlist (SDR, ${frameRate.toFixed(3)} fps)`
        : (videoRange ? `, HDR ${videoRange} - master playlist` : '');
    // Why it failed, when ffmpeg said (0113): a short, fixed sentence for the client,
    // never the URL or ffmpeg's own words - see transcodeSession.classifyInputFailure.
    const failure = !ready && typeof session.failureReason === 'function' ? session.failureReason() : null;
    const failureStatus = failure ? (transcodeSession.classifyInputFailure(session.stderrTail) || {}).status : null;
    const ended = !ready && session.timings && session.timings.endedEarly;
    const firstSegment = ready
        ? `after ${seconds(Date.now() - sessionStartedAt)}`
        : (ended
            ? `NOT produced - ffmpeg ended after ${seconds(session.timings.endedEarly - sessionStartedAt)}${failureStatus ? ` (provider ${failureStatus === 'refused' ? 'refused the connection' : `HTTP ${failureStatus}`})` : ''}`
            : 'NOT produced in time');
    console.log(`[Playback] resolve timing: HLS session, probe ${probeNote}, first segment ${firstSegment}${pacing}${timing}${range}`);
    if (ready) {
        // It played from this analysis: keep it for the next play (a fresh probe), or
        // note that it still works (a profile). Written only now, so an analysis that
        // never produced a picture is never reused.
        if (fromProfile) channelProfiles.markOk(cacheKey);
        else channelProfiles.save(cacheKey, info, probedAt);
    } else if (fromProfile) {
        // The feed may have changed under its profile: probe afresh next time, not from
        // the in-memory copy of the same analysis either.
        channelProfiles.remove(cacheKey);
        probeCache.delete(cacheKey);
    }
    if (!ready) {
        await transcodeSession.removeSession(session.id);
        const err = new Error(failure || 'Transcode failed to produce a playlist in time');
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
