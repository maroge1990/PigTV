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

const { probeStream, analyzeProbeResult, reanalyzeForCaps, probeCache, CACHE_TTL, parseFrameRate } = require('./streamProbe');
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
async function probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey }) {
    const probeStartedAt = Date.now();
    let raw;
    try {
        raw = await probeStream(url, ffprobePath, userAgent);
    } catch (err) {
        // 0118 (C-B): ffprobe's error carries its stderr, and with it the stream's
        // (redacted) URL. The log keeps it; the client gets a fixed sentence.
        console.warn(`[Playback] resolve probe failed: ${redact(err.message)}`);
        throw Object.assign(new Error(probeFailureMessage(err)), { status: err.status });
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

async function resolve({ url, capabilities = {}, settings, ffprobePath, upscale = false, owner = null, live = false, audioEncode = false }) {
    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);

    // Probe, with the client's capabilities folded in. The same stream
    // resolves differently for a client that can decode HEVC than one that
    // cannot, so capabilities are part of the cache key.
    const cacheKey = analysisKey(url, userAgent, caps);

    // Where the analysis comes from, cheapest first: the 5-minute in-memory cache, then
    // the channel's stored profile (0114: no ffprobe at all), then a probe. `fromProfile`
    // follows a profile through the in-memory cache, so a failed start can drop both.
    const analysis = storedAnalysis(cacheKey) || await probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey });
    const { info, probeNote, fromProfile, probedAt } = analysis;

    // 0124: how this start was served, for the admin status page's recent plays.
    // Observation only: nothing here changes what is decided.
    noteStart(owner, analysis);

    // 1. Direct play. Nothing to do — no ffmpeg, no server CPU, no added
    //    latency. Only available when the container is already something the
    //    client handles and both codecs are decodable.
    if (info.compatible && !upscale) return directDecision(url, info, probeNote);

    // 2. Everything else is an HLS session.
    const plan = sessionPlan({ info, caps, settings, userAgent, owner, live, upscale, audioEncode });
    const session = await transcodeSession.createSession(url, plan.options);

    const sessionStartedAt = Date.now();
    await session.start();

    const ready = await session.waitForPlaylist(15000);
    await afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt,
        remove: () => transcodeSession.removeSession(session.id) });

    return sessionDecision(session.id, plan, info);
}

function directDecision(url, info, probeNote) {
    console.log(`[Playback] resolve timing: direct, probe ${probeNote}`);
    // 0119 (C-D): an opaque handle, not the provider's URL (PIGTV_PLAYBACK_HANDLES=0
    // goes back to ?url=).
    return {
        strategy: 'direct',
        url: playbackHandles.handlesEnabled()
            ? `/api/proxy/stream?h=${playbackHandles.createHandle(url)}`
            : `/api/proxy/stream?url=${encodeURIComponent(url)}`,
        container: info.container,
        info,
        reason: 'Client can play the source directly'
    };
}

/**
 * How an HLS session (or a tuner) is run for this analysis and client: copy what
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
 * client's sentence. `note` is appended to the timing line (the tuner's).
 */
async function afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt, remove, note = '' }) {
    const { videoMode, videoRange, frameRate } = plan;
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

// ---------------------------------------------------------------------------
// The tuner model (PIGTV_TUNER=1, 0126; contract C-E). The same analysis, the
// same plan and the same ffmpeg arguments as resolve() above; what differs is
// who owns the ffmpeg. A viewer attaches to a tuner, and a second viewer whose
// plan produces the same arguments joins the running one. Admission (the
// coordinator) is part of this, not the route's first step, because whether a
// provider slot is needed at all depends on the plan.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{decision?: object, verdict?: object}>} `verdict` (not allowed,
 *          with the 409's conflict) or the resolve decision.
 */
async function resolveTuned({ url, capabilities = {}, settings, ffprobePath, upscale = false, owner = null, live = false,
    audioEncode = false, force = false, activeRecordings = [], onSacrifice = null }) {
    const tuner = require('./tuner');
    const coordinator = require('./streamCoordinator');
    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);
    const cacheKey = analysisKey(url, userAgent, caps);

    let admitted = null;
    const admit = async (key = null) => {
        const verdict = await coordinator.admitTuner({ force, settings, owner, key, activeRecordings, onSacrifice });
        if (!verdict.allowed) return verdict;
        admitted = verdict;
        return null;
    };

    // The analysis, never by opening a second connection to a stream a tuner is
    // already reading: cache, profile, then the running tuner's own analysis
    // re-read for this client's capabilities, and only then a probe - after the
    // coordinator has made room for it, as before.
    let analysis = storedAnalysis(cacheKey);
    if (!analysis) {
        const running = tuner.findByUrl(url);
        if (running && running.info) {
            const info = reanalyzeForCaps(running.info, url, caps);
            analysis = { info, probeNote: 'cached', fromProfile: false, probedAt: Date.now() };
            probeCache.set(cacheKey, { result: info, timestamp: Date.now(), probedAt: analysis.probedAt });
        }
    }
    if (!analysis) {
        const refused = await admit();
        if (refused) return { verdict: refused };
        analysis = await probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey });
    }
    const { info, probeNote, fromProfile, probedAt } = analysis;
    noteStart(owner, analysis);

    if (info.compatible && !upscale) {
        if (!admitted) {
            const refused = await admit();
            if (refused) return { verdict: refused };
        }
        return { decision: directDecision(url, info, probeNote) };
    }

    const plan = sessionPlan({ info, caps, settings, userAgent, owner, live, upscale, audioEncode });
    let { tuner: t, joined } = tuner.prepare(url, { ...plan.options, info });
    if (!joined && !admitted) {
        const refused = await admit(t.key);
        if (refused) return { verdict: refused };
    }
    // Admission may have waited on a release: someone else may have started the
    // very same tuner meanwhile. Checked and registered with no await in between.
    const again = tuner.findByKey(t.key);
    if (again) {
        t = again;
        joined = true;
    } else if (!joined) {
        tuner.register(t);
    }

    const viewer = tuner.addViewer(t, { owner, live });
    const startedAt = Date.now();
    if (!joined) {
        try {
            await tuner.start(t);
        } catch (err) {
            await tuner.destroyTuner(t, 'failed to start');
            throw err;
        }
    }
    const ready = await t.waitForPlaylist(15000);
    await afterStart({
        session: t, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt: startedAt,
        note: joined ? `, shared tuner ${t.id} (${t.viewers.size} viewers)` : `, tuner ${t.id}`,
        remove: async () => {
            await tuner.releaseViewer(viewer.id);
            // A tuner that never produced a segment is no use to anyone else either.
            if (t.window.length === 0) await tuner.destroyTuner(t, 'no first segment');
        }
    });
    return { decision: sessionDecision(viewer.id, plan, info) };
}

/**
 * The client's text for a failed probe (0118, C-B): ffprobe reports the same
 * "Server returned ..." / "Connection refused" lines ffmpeg does, so the same
 * classification applies; a timeout or anything else gets a fixed sentence.
 */
function probeFailureMessage(err) {
    const text = String(err && err.message || '');
    if (/Probe timeout/i.test(text)) return FAILURE_TEXT.timeout();
    const reason = transcodeSession.classifyInputFailure(text.split('\n'));
    return reason ? reason.message : FAILURE_TEXT.couldNotRead();
}

module.exports = { resolve, resolveTuned, DEFAULT_CAPABILITIES, probeFailureMessage };
