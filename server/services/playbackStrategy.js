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
const channelMeasurements = require('./channelMeasurements');
const { MESSAGES: FAILURE_TEXT, placeholderError } = require('./playbackErrors');
const { hasPlaceholderShape } = require('./feedPlaceholder');
const playbackHandles = require('./playbackHandles');
const playbackEvents = require('./playbackEvents');
const { stripUrls } = require('../redact');
const { providerLabel } = require('../providerLabel');
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
        return { info: cached.result, probeNote: 'cached', fromProfile: cached.fromProfile === true, probedAt: cached.probedAt || cached.timestamp,
            fullWindow: cached.fullWindow === true };
    }
    const profile = channelProfiles.get(cacheKey);
    if (profile) {
        // #240: `fullWindow` is stored beside the analysis, never handed to the client with it.
        const { fullWindow, ...info } = profile.info || {};
        probeCache.set(cacheKey, { result: info, timestamp: Date.now(), fromProfile: true, probedAt: profile.probedAt, fullWindow: fullWindow === true });
        return { info, probeNote: `profile (age ${profile.ageDays}d)`, fromProfile: true, probedAt: profile.probedAt, fullWindow: fullWindow === true };
    }
    return null;
}

/**
 * ffprobe the stream (one provider connection - or, Wave 5, none: through the shared ingest the
 * session will read, when `ingestSource` is given and the ingest takes the stream) and cache it.
 */
async function probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey, deadlineAt = null, ingestSource = null, providerId = null }) {
    const probeStartedAt = Date.now();
    let feed = null;
    if (ingestSource) {
        try {
            // Codex (#348): the resolve's deadline bounds the ingest's wait too (its own first-byte budget is 10 s).
            // The wait is cancelled at the deadline: its waiter dropped and an upstream nobody needs closed (ingest.subscribe).
            feed = await require('./ingest').subscribe({ ...ingestSource, purpose: 'probe', deadlineAt });
        } catch (err) {
            if (err.resolveDeadline) {
                console.warn(`[Playback] resolve probe on ${providerLabel(providerId)}: the shared ingest had nothing by the resolve's deadline`);
                throw deadlineSpentError();
            }
            // #371: a renewal's feed has gone: no probe of our own (it would be a connection), and no start.
            if (err.ingestJoinGone) throw err;
            // I1/PB1 (0230): the ingest was closed while it connected (a takeover released it,
            // shutdown): a cancellation - no probe of our own, no provider failure.
            if (err.ingestCancelled) throw supersededError();
            // Not MPEG-TS, a file, or refused: today's probe (which meets a refusal itself, with
            // today's C-B text and failover), and the session reads the URL too.
            console.log(`[Playback] shared ingest not used: ${stripUrls(err.message, [url])}`);
            ingestSource.refused = true;
        }
    }
    // 0174: a failover resolve bounds the probe by its deadline (never above the usual 15 s), worked out now, after the
    // ingest's wait. Codex (#348): with less than PROBE_MIN_MS of it left, no probe of our own (it could only time out).
    if (deadlineAt && deadlineAt - Date.now() < PROBE_MIN_MS) {
        if (feed) { try { feed.leave(); } catch (e) { /* gone */ } }
        console.warn(`[Playback] resolve probe on ${providerLabel(providerId)}: not started, the resolve's deadline is spent`);
        throw deadlineSpentError();
    }
    const timeout = deadlineAt ? Math.min(15000, deadlineAt - Date.now()) : undefined;
    let raw;
    try {
        raw = await probeStream(url, ffprobePath, userAgent, timeout, { feed });
    } catch (err) {
        // 0118 (C-B): ffprobe's error carries its stderr, and with it the stream's
        // (redacted) URL. The log keeps it; the client gets a fixed sentence.
        console.warn(`[Playback] resolve probe failed on ${providerLabel(providerId)}: ${probeFailureClass(err)}`);
        throw Object.assign(new Error(probeFailureMessage(err)), { status: err.status, providerReason: probeFailedForProvider(err) });
    }
    const info = analyzeProbeResult(raw, url, caps);
    const probedAt = Date.now();
    // #332: probed from the provider's placeholder (its feed ended as one, or had a short low-rate connection): the
    // slate's analysis, never kept for the channel.
    const placeholderProbe = !!feed && ((feed.endReason && feed.endReason.reason === 'placeholder') || (feed.ingest && feed.ingest.shortLowSeen === true));
    if (!placeholderProbe) probeCache.set(cacheKey, { result: info, timestamp: probedAt, probedAt });
    return { info, probeNote: seconds(Date.now() - probeStartedAt), fromProfile: false, probedAt, placeholderProbe };
}

/** The shortest probe worth starting against the resolve's deadline (below a candidate's guaranteed MIN_START_MS). */
const PROBE_MIN_MS = 500;

/** Codex (#348): the resolve's deadline was reached before the probe could run: the provider did not answer in time. */
function deadlineSpentError() {
    return Object.assign(new Error(FAILURE_TEXT.timeout()), { providerReason: true }); // as a probe timeout's (no status: 500)
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
async function resolve({ url, capabilities = {}, settings, ffprobePath, owner = null, live = false, audioEncode = false, providerId = null,
    refusedRetryDelaysMs = undefined, deadlineAt = null, timingNote = '', sessionOptions = null, lease = null, ingestSource = null, measure = null,
    liveChannel = null }) {
    const caps = { ...DEFAULT_CAPABILITIES, ...capabilities };
    const userAgent = db.getUserAgent(settings);

    // Probe, with the client's capabilities folded in. The same stream
    // resolves differently for a client that can decode HEVC than one that
    // cannot, so capabilities are part of the cache key.
    const cacheKey = analysisKey(url, userAgent, caps);

    // Where the analysis comes from, cheapest first: the 5-minute in-memory cache, then
    // the channel's stored profile (0114: no ffprobe at all), then a probe. `fromProfile`
    // follows a profile through the in-memory cache, so a failed start can drop both.
    // Wave 5 (phase 5b): a live channel play with the shared ingest on (`ingestSource`, from the
    // route) probes through it and its session reads it; one provider connection for both.
    const analysis = storedAnalysis(cacheKey) || await probedAnalysis({ url, ffprobePath, userAgent, caps, cacheKey, deadlineAt, ingestSource, providerId });
    const { info, probeNote, fromProfile, probedAt } = analysis;

    // #348: a live channel's candidate answered with the provider's placeholder file: never started (no session, no
    // provider connection beyond the probe), its analysis not kept, and the walk tries the next candidate.
    if (liveChannel && isPlaceholderFile(info)) {
        dropPlaceholderAnalysis({ cacheKey, fromProfile, probedAt, measure });
        try { require('./providerRouting').notePlaceholder(liveChannel.providerId, liveChannel.channelKey); } catch (e) { /* observation only */ }
        console.warn(`[Playback] ${providerLabel(providerId)} answers this channel with a file` +
            `${info.durationSec ? ` of ${Math.round(info.durationSec / 60)} min` : ''} (${info.width}x${info.height} at ${info.fps ?? '?'} fps, probe ${probeNote}): ` +
            'the provider\'s placeholder, not the channel');
        throw placeholderError();
    }

    // 0124: how this start was served, for the admin status page's recent plays.
    // Observation only: nothing here changes what is decided.
    noteStart(owner, analysis);

    // 1. Direct play. Nothing to do — no ffmpeg, no server CPU, no added
    //    latency. Only available when the container is already something the
    //    client handles and both codecs are decodable.
    if (info.compatible) return directDecision(url, info, probeNote, timingNote);

    // #371 (Codex): a relay's renewal reads its pinned feed or nothing: a session that would not read it (a finite
    // analysis, cached by another resolve) is never created, so no ffmpeg reads the provider's address for it.
    if (ingestSource && ingestSource.joinOnly != null && (ingestSource.refused || info.finite === true)) {
        throw Object.assign(new Error('Shared ingest not used: a renewal\'s session would not read its feed'), { ingestJoinGone: true, providerReason: false });
    }

    // 2. Everything else is an HLS session.
    const plan = sessionPlan({ info, caps, settings, userAgent, owner, live, audioEncode, fromProfile, fullWindow: analysis.fullWindow === true });
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
        // Wave 5: not for a source that ends (paced, seekable), nor once the ingest refused the stream.
        // The names go too (0287's feed_lag): a play from a cached analysis or a profile has no probe, so its session opens the ingest.
        ...(ingestSource && !ingestSource.refused && info.finite !== true ? { ingestSource: { pool: ingestSource.pool, url: ingestSource.url, userAgent: ingestSource.userAgent, providerId: ingestSource.providerId,
            channelKey: ingestSource.channelKey ?? null, channel: ingestSource.channel ?? null, providerName: ingestSource.providerName ?? null,
            ...(ingestSource.joinOnly != null ? { joinOnly: ingestSource.joinOnly } : {}) } } : {}),
        // Codex (#348): the session's own ingest wait (no probe went first) ends at the resolve's deadline.
        ...(deadlineAt ? { startDeadlineAt: deadlineAt } : {}),
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
    try {
        await session.start();
    } catch (err) {
        if (err.ingestJoinGone) {
            // #371: the renewal's feed went before its session read it: the session goes, nothing else is opened.
            try { await transcodeSession.removeSession(session.id); } catch (e) { /* already gone */ }
            throw err;
        }
        if (!err.resolveDeadline) throw err;
        // Codex (#348): the shared ingest had nothing by the deadline: a failed start for a provider reason; the
        // registered session goes (after its teardown) before the walk gives the lease back.
        console.warn(`[Playback] resolve on ${providerLabel(providerId)}: the shared ingest had nothing by the resolve's deadline`);
        try { await transcodeSession.removeSession(session.id); } catch (e) { /* already gone */ }
        throw deadlineSpentError();
    }

    const ready = deadlineAt ? await session.waitForPlaylist(15000, { deadlineAt }) : await session.waitForPlaylist(15000);
    // 0180: stopped on request while it was starting (the viewer's next play replaced it,
    // a DELETE, a force): not a provider failure, so no failover, breaker, quarantine,
    // profile or health change. The route answers it with a plain SUPERSEDED error.
    if (session.stopRequested || (session.plannedRestart && !ready)) {
        console.log(`[Playback] start superseded: session ${session.id} was stopped on request before it produced a playlist`);
        try { await transcodeSession.removeSession(session.id); } catch (e) { /* already gone */ }
        throw supersededError();
    }
    await afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt, note: timingNote, measure,
        placeholderProbe: analysis.placeholderProbe === true || placeholderNoted(ingestSource),
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
function sessionPlan({ info, caps, settings, userAgent, owner, live, audioEncode, fromProfile = false, fullWindow = false }) {
    //    Copy what the client can decode (both streams when the codecs are fine, and only the container needs
    //    changing - what /api/remux used to do); re-encode only what it cannot.
    const audioNeedsWork = info.audioOk === false;
    const codecsOk = info.videoOk && !audioNeedsWork;

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
    const canCopyVideo = info.videoOk === true;
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
        // #322: resolution, quality and audio mix are the session's fixed values, not settings.
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
        // #348: the source has the provider's placeholder's shape (the blank check judges a feed-less play by it).
        placeholderShape: hasPlaceholderShape({ width: info.width, height: info.height, fps: info.fps }),
        audioMode: audioEncode ? 'encode' : (codecsOk ? 'copy' : undefined),
        videoCodec: info.video,
        audioCodec: info.audio,
        audioChannels: info.audioChannels,
        audioProfile: info.audioProfile,
        isHeAac: info.isHeAac,
        // FR-9 (0302): an AAC label no client decodes as a copy (AAC Main on FOX): re-encode.
        aacLabelBlocked: info.aacLabelBlocked === true,
        // This client decodes HE-AAC, so the session may copy it (0116).
        heaacCopy: caps.heaac === true,
        // #240: ffmpeg's own analysis is shortened for a channel whose stored profile already says what
        // it carries, unless that profile is marked as needing the full window (`fullWindow`, kept when
        // a short-window start failed and the full one played).
        analysisWindow: fromProfile && !fullWindow ? 'short' : 'full'
    };
    return { options, videoMode, segmentType, videoRange, frameRate, codecsOk, canCopyVideo };
}

/**
 * The first segment is there or it is not: log the start (`resolve timing`), keep
 * or drop the channel profile, and on a failure remove the session and throw the
 * client's sentence. `note` is appended to the timing line.
 */
async function afterStart({ session, ready, info, plan, probeNote, fromProfile, probedAt, cacheKey, sessionStartedAt, remove, note = '', placeholderProbe = false, measure = null }) {
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
    // #240: which analysis window ffmpeg ran with (a profile's start is short unless its profile says otherwise).
    const windowNote = plan.options && plan.options.analysisWindow === 'short'
        ? (session.analysisWindowFellBack === true ? ', analysis window full after the short one failed' : ', analysis window short')
        : '';
    console.log(`[Playback] resolve timing: HLS session, probe ${probeNote}, first segment ${firstSegment}${windowNote}${pacing}${timing}${range}${note}`);
    // #332: a feed that was (or may be) the provider's placeholder: its probe is the slate's, never the channel's.
    const placeholder = placeholderProbe || placeholderSuspect(session);
    if (ready && !placeholder) {
        // It played from this analysis: keep it for the next play (a fresh probe), or
        // note that it still works (a profile). Written only now, so an analysis that
        // never produced a picture is never reused.
        // #265 step 2 (D-65): the channel's measured quality, from the analysis it played from (a channel play on
        // its primary provider only: `measure` is { sourceId, key }); the newest measurement wins.
        if (measure) channelMeasurements.recordPlay(measure, info, probedAt);
        if (fromProfile && session.analysisWindowFellBack === true) {
            // #240: the short analysis window failed and the full one played: this channel keeps the full
            // window from now on (the analysis itself held, so the profile and its age stay).
            channelProfiles.save(cacheKey, { ...info, fullWindow: true }, probedAt);
            const cached = probeCache.get(cacheKey);
            if (cached && cached.fromProfile) cached.fullWindow = true;
            if (measure && typeof session.once === 'function') {
                session.once('placeholder', () => channelMeasurements.forgetPlay(measure, probedAt));
            }
        } else if (fromProfile) {
            channelProfiles.markOk(cacheKey);
            // #332: found to be the placeholder later: the measurement this play kept goes (the profile stays, as a
            // start that failed on the placeholder keeps it); only the one with this probe's time.
            if (measure && typeof session.once === 'function') {
                session.once('placeholder', () => channelMeasurements.forgetPlay(measure, probedAt));
            }
        } else {
            channelProfiles.save(cacheKey, info, probedAt);
            // #332: the placeholder found later (the feed ends as one, or a blank verdict is one): this analysis was
            // probed from it, so neither the profile nor the in-memory copy is kept (nor its measurement).
            if (typeof session.once === 'function') {
                session.once('placeholder', () => {
                    channelProfiles.remove(cacheKey); probeCache.delete(cacheKey);
                    if (measure) channelMeasurements.forgetPlay(measure, probedAt);
                });
            }
        }
    } else if (placeholder && !fromProfile) {
        // #332: the probe was the slate's: not kept in memory either (it was cached when it was taken).
        probeCache.delete(cacheKey);
    } else if (fromProfile && !placeholder) {
        // (#332: a start that failed on the placeholder says nothing about the channel's profile: it is kept.)
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
        // #332: the shared feed was ended as the provider's placeholder: the provider's too (the next candidate is tried).
        err.providerReason = ended ? (transcodeSession.providerFailureIn(session.stderrTail || []) || session.feedLost?.reason === 'placeholder') : true;
        throw err;
    }
}

/** #348: the longest file a live channel's answer can be and still be taken for the provider's placeholder file. */
const PLACEHOLDER_FILE_MAX_SEC = 15 * 60;

/**
 * #348: is this analysis of a live channel's stream the provider's placeholder file? A source whose media ends (by the
 * probe: a duration or size; for HLS a duration) that has the placeholder's shape (1920x1080 at 30 fps) or
 * lasts at most PLACEHOLDER_FILE_MAX_SEC (the provider's is 10 min; #333). A long real-rate file is not.
 */
function isPlaceholderFile(info) {
    if (!info) return false;
    // Codex (high): the media must end, by the probe's own reading. The ingest's `finite` comes from a Content-Length, which
    // for HLS is the manifest's while its media is open-ended: never evidence on its own.
    if (info.finite !== true) return false;
    // An HLS answer ends only when its playlist has a duration (a VOD list); a size is the manifest's.
    if (/hls|applehttp/i.test(String(info.container || '')) && !(Number(info.durationSec) > 0)) return false;
    if (hasPlaceholderShape({ width: info.width, height: info.height, fps: info.fps })) return true;
    return Number(info.durationSec) > 0 && Number(info.durationSec) <= PLACEHOLDER_FILE_MAX_SEC;
}

/** #348: the placeholder file's analysis is the slate's, never the channel's: no profile, cached probe or measurement. */
function dropPlaceholderAnalysis({ cacheKey, fromProfile, probedAt, measure }) {
    probeCache.delete(cacheKey);
    if (fromProfile) {
        channelProfiles.remove(cacheKey);
        // A play that kept the profile also kept its measurement, with the profile's probe time.
        if (measure) channelMeasurements.forgetPlay(measure, probedAt);
    }
}

/** #332: was this candidate's feed found sending the placeholder (providerRouting, 3 min)? */
function placeholderNoted(ingestSource) {
    if (!ingestSource || ingestSource.providerId === null || ingestSource.providerId === undefined || ingestSource.channelKey == null) return false;
    try { return require('./providerRouting').isPlaceholder(ingestSource.providerId, ingestSource.channelKey); } catch (e) { return false; }
}

/**
 * #332: was this session's shared feed the provider's placeholder, or may it have been (a short low-rate connection
 * so far)? Its probe is then the slate's, not the channel's: never kept as a profile.
 */
function placeholderSuspect(session) {
    if (!session) return false;
    if (session.feedLost && session.feedLost.reason === 'placeholder') return true;
    const ingest = session.feed && session.feed.ingest;
    return !!ingest && (ingest.shortLowSeen === true || !!ingest.placeholder);
}

function sessionDecision(sessionId, plan, info) {
    const { videoRange, videoMode, segmentType, codecsOk, canCopyVideo } = plan;
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
                : 'Video cannot be decoded by this client')
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

/**
 * #307: a fixed class for a failed probe's log line. ffprobe's own text can carry a bare host
 * ("Failed to resolve hostname x", "Connection to tcp://x:80 failed"), which no URL pattern catches.
 */
function probeFailureClass(err) {
    const text = String(err && err.message || '');
    if (/Probe timeout|timed out/i.test(text)) return 'timed out';
    if (/resolve hostname|Name or service not known|nodename nor servname|getaddrinfo/i.test(text)) return 'could not resolve the host';
    if (/refused/i.test(text)) return 'connection refused';
    const http = /\b(?:Server returned |HTTP error )?([45]\d\d)\b(?=.*(?:Server returned|HTTP error))|Server returned ([45]\d\d|[45]XX)/i.exec(text);
    if (http) return `HTTP ${(http[1] || http[2]).replace(/XX$/i, 'xx')}`;
    return 'probe failed';
}

function probeFailureMessage(err) {
    const text = String(err && err.message || '');
    if (/Probe timeout/i.test(text)) return FAILURE_TEXT.timeout();
    const reason = transcodeSession.classifyInputFailure(text.split('\n'));
    return reason ? reason.message : FAILURE_TEXT.couldNotRead();
}

module.exports = { supersededError, SUPERSEDED_MESSAGE, resolve, DEFAULT_CAPABILITIES, probeFailureMessage, placeholderSuspect, isPlaceholderFile, PLACEHOLDER_FILE_MAX_SEC };
