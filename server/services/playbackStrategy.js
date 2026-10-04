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
const { MESSAGES: FAILURE_TEXT } = require('./playbackErrors');
const playbackHandles = require('./playbackHandles');
const playbackEvents = require('./playbackEvents');
const { redact } = require('../redact');
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
 * @param {number|null} opts.providerId the source whose connection the session holds (0173)
 * @returns {Promise<object>} a decision, including a playable URL
 */
// Where the seconds of a channel change go, for `docker logs | grep "resolve timing"`.
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The probe cache key: the same stream resolves differently per capability set. */
function analysisKey(url, userAgent, caps) {
    const capKey = Object.keys(caps).filter(k => caps[k]).sort().join(',');
    return `${url}|${userAgent || ''}|${capKey}`;
}

/**
 * The analysis without opening a provider connection: the 5-minute in-memory cache,
 * then the channel's stored profile (0114). Null when only a probe can answer.
 */
function storedAnalysis(cacheKey) {
    const cached = probeCache.get(cacheKey);
    const cacheFresh = !!cached && (Date.now() - cached.timestamp) < CACHE_TTL;
    if (cacheFresh) {
        return { info: cached.result, probeNote: 'cached', fromProfile: cached.fromProfile === true, probedAt: cached.probedAt || cached.timestamp };
    }
    const profile = channelProfiles.get(cacheKey);
    if (profile) {
        probeCache.set(cacheKey, { result: profile.info, timestamp: Date.now(), fromProfile: true, probedAt: profile.probedAt });
        return { info: profile.info, probeNote: `profile (age ${profile.ageDays}d)`, fromProfile: true, probedAt: profile.probedAt };
    }
    return null;
}

/** ffprobe the stream (one provider connection) and cache the analysis. */
async function probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey, deadlineAt = null }) {
    const probeStartedAt = Date.now();
    // 0174: a failover resolve bounds the probe by its deadline (never above the usual 15 s).
    const timeout = deadlineAt ? Math.max(1000, Math.min(15000, deadlineAt - probeStartedAt)) : undefined;
    let raw;
    try {
        raw = await probeStream(url, ffprobePath, userAgent, timeout);
    } catch (err) {
        // 0118 (C-B): ffprobe's error carries its stderr, and with it the stream's
        // (redacted) URL. The log keeps it; the client gets a fixed sentence.
        console.warn(`[Playback] resolve probe failed: ${redact(err.message)}`);
        throw Object.assign(new Error(probeFailureMessage(err)), { status: err.status, providerReason: probeFailedForProvider(err) });
    }
    const info = analyzeProbeResult(raw, url, caps);
    const probedAt = Date.now();
    probeCache.set(cacheKey, { result: info, timestamp: probedAt, probedAt });
    return { info, probeNote: seconds(Date.now() - probeStartedAt), fromProfile: false, probedAt };
}

/** 0124: how this start was served, for the admin status page. Observation only. */
function noteStart(owner, analysis) {
    playbackEvents.noteResolve(owner, { start: analysis.fromProfile ? 'profile' : (analysis.probeNote === 'cached' ? 'warm' : 'cold') });
}

/*
 * Failover (0174, routes/playback.js with providerRouting.js) adds three options,
 * all off by default so a plain resolve is exactly as before:
 *   refusedRetryDelaysMs  the refused-connection retries for this session (a
 *                         candidate that is not the last gets [1000], not 0143's two)
 *   deadlineAt            epoch ms by which the probe and the first segment must be done
 *   timingNote            appended to the `resolve timing` line (the provider's name)
 * A failure thrown here carries `providerReason: true` when the provider (or the
 * network to it) is what failed, which is what makes the route try the next one.
 */
async function resolve({ url, capabilities = {}, settings, ffprobePath, upscale = false, owner = null, live = false, audioEncode = false, providerId = null,
    refusedRetryDelaysMs = undefined, deadlineAt = null, timingNote = '', sessionOptions = null, lease = null }) {
    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);

    // Probe, with the client's capabilities folded in. The same stream
    // resolves differently for a client that can decode HEVC than one that
    // cannot, so capabilities are part of the cache key.
    const cacheKey = analysisKey(url, userAgent, caps);

    // Where the analysis comes from, cheapest first: the 5-minute in-memory cache, then
    // the channel's stored profile (0114: no ffprobe at all), then a probe. `fromProfile`
    // follows a profile through the in-memory cache, so a failed start can drop both.
    const analysis = storedAnalysis(cacheKey) || await probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey, deadlineAt });
    const { info, probeNote, fromProfile, probedAt } = analysis;

    // 0124: how this start was served, for the admin status page's recent plays.
    // Observation only: nothing here changes what is decided.
    noteStart(owner, analysis);

    // 1. Direct play. Nothing to do — no ffmpeg, no server CPU, no added
    //    latency. Only available when the container is already something the
    //    client handles and both codecs are decodable.
    if (info.compatible && !upscale) return directDecision(url, info, probeNote, timingNote);

    // 2. Everything else is an HLS session.
    const plan = sessionPlan({ info, caps, settings, userAgent, owner, live, upscale, audioEncode });
    // Which provider's connection the session holds (0173): the coordinator counts it in that
    // provider's pool. Set here, not in sessionPlan, which plans the ffmpeg only.
    // R11: the connection lease the caller took when it admitted this start. It is checked just
    // before the session exists (it may have been reclaimed while the probe ran: a viewer
    // arrived and took the connection a standby or warm start was holding) and bound to the
    // session the moment it is registered. A start that fails before then never reaches the
    // bind; the caller releases the lease.
    const coordinator = lease ? require('./streamCoordinator') : null;
    if (coordinator && !coordinator.leaseAlive(lease)) throw supersededError();
    let leaseLost = false;
    const session = await transcodeSession.createSession(url, {
        ...plan.options, providerId, ...(Array.isArray(refusedRetryDelaysMs) ? { refusedRetryDelaysMs } : {}),
        // 0189: extra session options from the relay (a standby is marked as one).
        ...(sessionOptions || {}),
        ...(coordinator ? { onRegistered: (s) => { leaseLost = !coordinator.bindLease(lease, s.id); } } : {})
    });
    if (leaseLost) {
        // Reclaimed in the instant between the check and the registration: give the session back.
        try { await transcodeSession.removeSession(session.id); } catch (e) { /* already gone */ }
        throw supersededError();
    }

    const sessionStartedAt = Date.now();
    await session.start();

    const ready = deadlineAt ? await session.waitForPlaylist(15000, { deadlineAt }) : await session.waitForPlaylist(15000);
    // 0180: stopped on request while it was starting (the viewer's next play replaced it,
    // a DELETE, a force): not a provider failure, so no failover, breaker, quarantine,
    // profile or health change. The route answers it with a plain SUPERSEDED error.
    if (session.stopRequested) {
        console.log(`[Playback] start superseded: session ${session.id} was stopped on request before it produced a playlist`);
        try { await transcodeSession.removeSession(session.id); } catch (e) { /* already gone */ }
        throw supersededError();
    }
    await afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt, note: timingNote,
        remove: () => transcodeSession.removeSession(session.id) });

    return sessionDecision(session.id, plan, info);
}

/** The resolve was overtaken (0180): its session was stopped on request, or the owner asked again. */
const SUPERSEDED_MESSAGE = 'Playback was replaced by a newer request';
function supersededError() {
    return Object.assign(new Error(SUPERSEDED_MESSAGE), { superseded: true, status: 499 });
}

function directDecision(url, info, probeNote, note = '') {
    console.log(`[Playback] resolve timing: direct, probe ${probeNote}${note}`);
    // 0119 (C-D): an opaque handle, not the provider's URL.
    return {
        strategy: 'direct',
        url: `/api/proxy/stream?h=${playbackHandles.createHandle(url)}`,
        container: info.container,
        info,
        reason: 'Client can play the source directly'
    };
}

/**
 * How an HLS session is run for this analysis and client: copy what
 * the client can decode, re-encode only what it cannot. Returns the session
 * options plus the decisions the log and the response report.
 */
function sessionPlan({ info, caps, settings, userAgent, owner, live, upscale, audioEncode }) {
    //    Copy what the client can decode (both streams when the codecs are fine, and only the container needs
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

    const options = {
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
    };
    return { options, videoMode, segmentType, videoRange, frameRate, codecsOk, canCopyVideo, upscale };
}

/**
 * The first segment is there or it is not: log the start (`resolve timing`), keep
 * or drop the channel profile, and on a failure remove the session and throw the
 * client's sentence. `note` is appended to the timing line.
 */
async function afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt, remove, note = '' }) {
    const { videoMode, videoRange, frameRate } = plan;
    // 0144: after an initial burst, unless PIGTV_READRATE_BURST=0 (plain -re).
    const paceNote = () => { const b = transcodeSession.readrateBurstSec(); return b > 0 ? ` after an initial ${b}s burst` : ''; };
    const pacing = info.finite === true ? `, source ends${info.durationSec ? ` (${Math.round(info.durationSec / 60)} min)` : ''} - paced to real time${paceNote()}` : '';
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
    console.log(`[Playback] resolve timing: HLS session, probe ${probeNote}, first segment ${firstSegment}${pacing}${timing}${range}${note}`);
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
        await remove();
        // 0118 (C-B): no clue from ffmpeg - it either ended (the stream could not be
        // opened) or never produced a segment in time (the provider did not respond).
        const err = new Error(failure || (ended ? FAILURE_TEXT.couldNotOpen() : FAILURE_TEXT.timeout()));
        err.info = info;
        // 0174: the provider's fault (failover may try the next one) when ffmpeg said
        // so, or when nothing came in time; an unexplained exit (an encoder, GPU or
        // argument error) is not.
        err.providerReason = ended ? transcodeSession.providerFailureIn(session.stderrTail || []) : true;
        throw err;
    }
}

function sessionDecision(sessionId, plan, info) {
    const { videoRange, videoMode, segmentType, codecsOk, canCopyVideo, upscale } = plan;
    return {
        strategy: 'transcode',
        url: `/api/transcode/${sessionId}/${videoRange ? 'master' : 'stream'}.m3u8`,
        sessionId,
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

/**
 * The client's text for a failed probe (0118, C-B): ffprobe reports the same
 * "Server returned ..." / "Connection refused" lines ffmpeg does, so the same
 * classification applies; a timeout or anything else gets a fixed sentence.
 */
/**
 * 0174: did ffprobe fail on the provider's stream (a timeout, or ffprobe ran and
 * could not read it) rather than locally (ffprobe missing, unparsable output)?
 */
function probeFailedForProvider(err) {
    const text = String(err && err.message || '');
    return /Probe timeout/i.test(text) || /^ffprobe exited with code/i.test(text);
}

function probeFailureMessage(err) {
    const text = String(err && err.message || '');
    if (/Probe timeout/i.test(text)) return FAILURE_TEXT.timeout();
    const reason = transcodeSession.classifyInputFailure(text.split('\n'));
    return reason ? reason.message : FAILURE_TEXT.couldNotRead();
}

module.exports = { supersededError, SUPERSEDED_MESSAGE, resolve, DEFAULT_CAPABILITIES, probeFailureMessage };
