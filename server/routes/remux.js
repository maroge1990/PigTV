const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { redact } = require('../redact');
const { createStallWatchdog } = require('../services/stallWatchdog');
const coordinator = require('../services/streamCoordinator');
const streamProbe = require('../services/streamProbe');

// Active remux processes, so they can be listed and killed like transcode
// sessions can. Without this registry a remuxed stream is invisible to any
// management tooling: it only ends when its client disconnects, and a client
// that went away without closing the socket leaves ffmpeg running against the
// provider indefinitely.
// lastOutputAt is null until ffmpeg has produced its first bytes.
const activeRemuxes = new Map(); // id -> { id, url, proc, startedAt, res, owner, lastOutputAt }
let remuxCounter = 0;

function listActiveRemuxes() {
    return Array.from(activeRemuxes.values()).map(r => ({
        id: r.id,
        url: r.url,
        type: 'remux',
        startTime: r.startedAt,
        owner: r.owner,
        // Time since media last flowed to the client, the same question
        // idleMs answers for an HLS session ("has anyone fetched anything
        // lately?"). It used to be time since the remux *started*, which
        // grows for a perfectly healthy stream and meant nothing.
        idleMs: Date.now() - (r.lastOutputAt ?? r.startedAt)
    }));
}

function killRemux(id) {
    const entry = activeRemuxes.get(id);
    if (!entry) return false;
    try { entry.proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    try { entry.res.end(); } catch (e) { /* already closed */ }
    activeRemuxes.delete(id);
    return true;
}

function killAllRemuxes() {
    let killed = 0;
    for (const id of [...activeRemuxes.keys()]) {
        if (killRemux(id)) killed++;
    }
    return killed;
}

// Cache of url -> { video, audio } codec names, so we only pay for the probe
// once per stream rather than on every playback start.
const codecCache = new Map();
const CODEC_CACHE_TTL = 5 * 60 * 1000;

/**
 * Detect the codec of the first audio stream.
 *
 * Needed because MPEG-TS carries AAC in ADTS framing, which MP4 cannot hold:
 * without the aac_adtstoasc bitstream filter the muxed MP4 has no usable
 * audio. That filter must NOT be applied to AC3/EAC3/MP3, so we have to know
 * what we are dealing with before building the ffmpeg command.
 *
 * Returns null if ffprobe is unavailable, times out, or fails - callers then
 * fall back to the old behaviour of not applying any audio bitstream filter.
 */
function detectCodecs(url, ffprobePath, userAgent, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!ffprobePath) return resolve(null);

        const cached = codecCache.get(url);
        if (cached && (Date.now() - cached.at) < CODEC_CACHE_TTL) {
            return resolve(cached.codec);
        }

        const args = [
            '-v', 'error',
            '-user_agent', userAgent,
            '-show_entries', 'stream=codec_name,codec_type',
            '-print_format', 'json',
            '-probesize', '2000000',
            '-analyzeduration', '2000000',
            url
        ];

        let proc;
        try {
            proc = spawn(ffprobePath, args);
        } catch (err) {
            return resolve(null);
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        // A null result used to be silent, which made "the probe failed" look
        // identical to "the stream has no audio". Say which it was.
        const fail = (why) => {
            console.warn(`[Remux] Codec probe failed for ${redact(url)}: ${redact(why)}`);
            finish(null);
        };
        const finish = (codecs) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (codecs) codecCache.set(url, { codec: codecs, at: Date.now() });
            resolve(codecs);
        };

        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            fail(`no answer within ${timeoutMs} ms`);
        }, timeoutMs);

        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-300); });
        proc.on('error', (err) => fail(err.message));
        proc.on('close', (code) => {
            if (code !== 0) return fail(`ffprobe exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
            try {
                const streams = JSON.parse(stdout)?.streams || [];
                finish({
                    video: streams.find(s => s.codec_type === 'video')?.codec_name || null,
                    audio: streams.find(s => s.codec_type === 'audio')?.codec_name || null
                });
            } catch (err) {
                fail(`unreadable ffprobe output (${err.message})`);
            }
        });
    });
}

/**
 * One line saying how a remux ended and, above all, whether anything was ever
 * sent. "Client disconnected after 13s" alone cannot tell a stream that played for
 * thirteen seconds from one that never produced a byte - and a live channel with
 * widely spaced keyframes, or a provider slow to answer, looks exactly like the
 * second: the browser waits in silence, then gives up, with no error anywhere.
 */
function describeRemuxEnd({ id, startedAt, now, bytes = 0, firstOutputAt = null }) {
    const alive = Math.round((now - startedAt) / 1000);
    const sent = bytes > 0
        ? `sent ${bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'}, ` +
          `first output after ${((firstOutputAt - startedAt) / 1000).toFixed(1)}s`
        : 'ffmpeg had produced no output yet';
    return `[Remux] Client disconnected after ${alive}s (${sent}), killing ${id}`;
}

// A message from one of ffmpeg's *decoders*: "[h264 @ 0x55...] non-existing PPS 0 ...".
// A remux copies streams and never decodes, but ffmpeg does decode the first frames
// while it probes the input, and joining a live stream in the middle of a keyframe
// interval makes the video decoder complain - a burst of "non-existing SPS/PPS",
// "decode_slice_header error", "no frame!" - until the next keyframe arrives.
// That is normal, stops on its own once the probe ends, and used to fill the whole
// message budget, leaving no room for a reconnect or a timestamp problem later.
const PROBE_DECODER_MESSAGE = /^\[(h264|hevc|mpeg2video|mpeg4|aac|aac_latm|ac3|eac3|mp2|mp3)\b[^\]]*\]\s*/;
const REPEAT_NOTE = /^Last message repeated (\d+) times?$/;

/**
 * A process's stderr arrives in arbitrary pieces, not in lines: one read can end
 * halfway through "Last message repeated 1 times". Treating each piece as a line
 * put fragments in the log ("Last mess" / "age repeated 1 times"). This holds the
 * unfinished last line back until the rest of it arrives; end() releases whatever
 * is left.
 */
function makeLineBuffer(onLine) {
    let pending = '';
    const feed = (chunk) => {
        pending += String(chunk);
        const parts = pending.split(/\r\n|\n|\r/);
        pending = parts.pop();
        for (const part of parts) onLine(part);
    };
    feed.end = () => {
        if (!pending) return;
        const rest = pending;
        pending = '';
        onLine(rest);
    };
    return feed;
}

/**
 * Logs ffmpeg's own messages for a remux. It used to log only the ones that
 * happened to contain "error" or "Warning", which hid the rest - reconnect
 * attempts, timestamp complaints, a stream that starts late. At the warning
 * loglevel everything ffmpeg says is worth reading, so log it all, but only the
 * first few per remux: a damaged stream can otherwise repeat one message for as
 * long as it plays.
 *
 * Decoder chatter from the probe phase is counted rather than logged, and flush()
 * turns it into one line (called when the probe finishes, i.e. at first output).
 * end() is for when the process is over: it also releases a last unfinished line.
 */
function makeStderrLogger(id, log = console.log, cap = 25, redactor = redact) {
    let logged = 0;
    const kinds = new Map(); // "h264: non-existing PPS 0 referenced" -> count
    let probeTotal = 0;
    let lastWasProbe = false;
    const nameOf = () => (typeof id === 'function' ? id() : id); // a getter: the id may not exist yet when this is created

    const handleLine = (line) => {
        const text = line.trim();
        if (!text) return;

        const decoder = PROBE_DECODER_MESSAGE.exec(text);
        if (decoder) {
            const kind = `${decoder[1]}: ${text.slice(decoder[0].length).replace(/\s+/g, ' ')}`;
            kinds.set(kind, (kinds.get(kind) || 0) + 1);
            probeTotal++;
            lastWasProbe = true;
            return;
        }
        const repeat = REPEAT_NOTE.exec(text);
        if (repeat && lastWasProbe) { // ffmpeg's own "repeated N times" for one of those messages
            probeTotal += Number(repeat[1]);
            return;
        }
        lastWasProbe = false;

        const name = nameOf();
        if (logged < cap) log(`[Remux FFmpeg] ${name}: ${redactor(text)}`);
        else if (logged === cap) log(`[Remux FFmpeg] ${name}: (further ffmpeg messages suppressed)`);
        logged++;
    };
    const logger = makeLineBuffer(handleLine);

    logger.flush = () => {
        if (!probeTotal) return;
        const top = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
        const shown = top.slice(0, 3).map(([kind, n]) => `${kind} x${n}`).join('; ');
        const more = top.length > 3 ? `; +${top.length - 3} other kinds` : '';
        log(`[Remux FFmpeg] ${nameOf()}: ${probeTotal} decoder messages while probing the stream - ` +
            `normally just joining mid-keyframe (${redactor(shown)}${more})`);
        kinds.clear();
        probeTotal = 0;
        lastWasProbe = false;
    };
    const releaseRest = logger.end;
    logger.end = () => { releaseRest(); logger.flush(); };
    return logger;
}

/**
 * Which fix-ups the MP4 muxer needs for a stream with these codecs.
 */
function remuxFixes(codecs, { encodeAudio = false } = {}) {
    const audioCodec = codecs?.audio || null;
    const videoCodec = (codecs?.video || '').toLowerCase();
    return {
        audioCodec,
        videoCodec,
        // Re-encode the audio to clean AAC-LC stereo instead of copying it. A copy
        // hands the browser exactly the frames the provider sent, and a damaged one
        // (packet loss on the feed) makes Chrome's decoder abort the whole element
        // ("Failed to send audio packet for decoding"); the ffmpeg decoder in a
        // re-encode conceals it. Video is still copied, so this costs a sliver of
        // CPU. Asked for by the player after such a failure (?audio=encode).
        encodeAudio,
        // aac_adtstoasc is required for AAC-in-MPEG-TS to survive the move into
        // MP4, but it refuses to initialise on any other audio, so it is only
        // added when the probe says the audio really is AAC - and not at all
        // when the audio is being re-encoded, whose output is already raw AAC.
        needsAdtsToAsc: audioCodec === 'aac' && !encodeAudio,
        // HEVC in fMP4 must be tagged hvc1 or browsers refuse the track. Without
        // this, an HEVC channel that could be remuxed at near-zero cost falls
        // back to a full re-encode.
        needsHvc1Tag: videoCodec.includes('hevc') || videoCodec.includes('h265'),
        // AC-3 and E-AC-3 cannot be written into an MP4 whose header is emitted
        // up front (empty_moov): ffmpeg needs to see the first frames to fill in
        // the codec's own header box, and stops with "Cannot write moov atom
        // before AC3 packets". delay_moov holds the header back until the first
        // fragment. Only for these codecs: it delays the start of every stream
        // by up to a keyframe interval, so the ones that work today are left as
        // they are.
        needsDelayMoov: (audioCodec === 'ac3' || audioCodec === 'eac3') && !encodeAudio
    };
}

/**
 * The ffmpeg arguments for a stream-copy remux to fragmented MP4 on stdout.
 * Pure, so the flag decisions can be tested without ffmpeg.
 */
function buildRemuxArgs(url, userAgent, fixes = {}) {
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        '-user_agent', userAgent,
        // Standard probe size to handle complex containers (MKV) correctly
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', url,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', '0:v',
        '-map', '0:a',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // Ensure extradata is correctly extracted/converted (fixes Annex B -> AVCC issues in Firefox)
        '-bsf:v', 'dump_extra',
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', fixes.needsDelayMoov
            ? 'frag_keyframe+empty_moov+default_base_moof+delay_moov'
            : 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    if (fixes.needsAdtsToAsc) {
        // Insert just before the output argument
        args.splice(args.length - 1, 0, '-bsf:a', 'aac_adtstoasc');
    }
    if (fixes.encodeAudio) {
        // Same settings the HLS session uses to normalise audio.
        args.splice(args.length - 1, 0, '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1');
    }
    if (fixes.needsHvc1Tag) {
        args.splice(args.length - 1, 0, '-tag:v', 'hvc1');
    }
    return args;
}

/**
 * Work out the stream's codecs, which the remux cannot start without: MPEG-TS
 * carries AAC in ADTS framing, and MP4 rejects every audio packet of it unless
 * ffmpeg is told to apply aac_adtstoasc - while that same filter refuses to
 * initialise on non-AAC audio. There is no safe guess, so a remux started
 * without knowing produces nothing but a muxer error.
 *
 * Sources, cheapest first: what /api/playback/resolve just learned (free - no new
 * connection to a provider that may allow only one), then ffprobe, then ffprobe
 * once more after a pause, because a provider that has just closed one
 * connection often refuses the next for a moment.
 *
 * Returns { codecs, source } or { codecs: null, why }. Dependencies are
 * injectable for tests.
 */
async function identifyCodecs(url, ffprobePath, userAgent, {
    detect = detectCodecs,
    cached = streamProbe.findCachedCodecs,
    wait = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    retryDelayMs = 1500
} = {}) {
    if (!ffprobePath) return { codecs: null, why: 'ffprobe is not available' };

    const known = cached(url);
    if (known) return { codecs: known, source: 'playback probe' };

    for (let attempt = 1; attempt <= 2; attempt++) {
        const codecs = await detect(url, ffprobePath, userAgent);
        if (codecs) return { codecs, source: attempt === 1 ? 'ffprobe' : 'ffprobe (retry)' };
        if (attempt === 1) await wait(retryDelayMs);
    }
    return { codecs: null, why: 'ffprobe could not read the stream' };
}

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const ffprobePath = req.app.locals.ffprobePath;

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    // Work out what fix-ups the MP4 muxer needs for this stream
    const found = await identifyCodecs(url, ffprobePath, userAgent);
    const codecs = found.codecs;
    if (!codecs && ffprobePath) {
        // Starting anyway would just hand the client a stream that dies on its
        // first audio packet ("Malformed AAC bitstream"). Say so instead; the
        // provider has usually let go of the previous connection by the retry.
        console.error(`[Remux] Not starting remux for ${redact(url)}: ${found.why}`);
        res.set('Retry-After', '2');
        return res.status(503).json({ error: 'Could not identify the stream. The provider may be refusing a second connection; try again.' });
    }
    if (found.source) console.log(`[Remux] Codecs from ${found.source}`);
    const fixes = remuxFixes(codecs, { encodeAudio: req.query.audio === 'encode' });
    console.log(`[Remux] Codecs: video=${fixes.videoCodec || 'unknown'}, audio=${fixes.audioCodec || 'unknown'}` +
        `${fixes.needsAdtsToAsc ? ' (aac_adtstoasc)' : ''}${fixes.needsHvc1Tag ? ' (tag hvc1)' : ''}` +
        `${fixes.needsDelayMoov ? ' (delay_moov)' : ''}${fixes.encodeAudio ? ' (audio re-encode)' : ''}`);

    console.log(`[Remux] Starting remux for: ${redact(url)}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    const args = buildRemuxArgs(url, userAgent, fixes);

    console.log(`[Remux] Full command: ${ffmpegPath} ${redact(args.join(' '))}`);

    // Free the provider's connection if it is clearly free to take: an
    // abandoned stream, or this same device's own earlier one. Soft, because
    // the clients that call this route directly cannot answer a "somebody else
    // is watching" prompt - that question is asked at /api/playback/resolve.
    // Arbitration must never be the reason playback fails to start.
    const owner = coordinator.ownerKey(req.user);
    try {
        await coordinator.admitViewer({
            soft: true,
            owner,
            settings,
            activeRecordings: require('../services/recordingEngine').listActive()
        });
    } catch (err) {
        console.warn('[Remux] Stream arbitration skipped:', err.message);
    }

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Refers to remuxId, which is assigned just below; it is only called later.
    const logStderr = makeStderrLogger(() => remuxId);

    // Keep the tail of stderr. At -loglevel warning a fatal startup error can
    // scroll past without matching the filter below, which leaves the log
    // saying only that the client disconnected — true, but not the reason.
    const stderrTail = [];
    const tailLines = makeLineBuffer((line) => {
        if (line.trim()) {
            stderrTail.push(line.trim());
            if (stderrTail.length > 20) stderrTail.shift();
        }
    });
    ffmpeg.stderr.on('data', (data) => {
        tailLines(data);
        logStderr(data);
    });

    const remuxId = `remux_${++remuxCounter}`;
    const startedAt = Date.now();
    let ffmpegExited = false;
    const entry = {
        id: remuxId,
        url,
        proc: ffmpeg,
        res,
        startedAt,
        owner,
        lastOutputAt: null,
        firstOutputAt: null,
        bytes: 0
    };
    activeRemuxes.set(remuxId, entry);
    console.log(`[Remux] Started ${remuxId} (${activeRemuxes.size} active)`);

    // Bytes leaving ffmpeg are the only proof it is doing its job. This
    // listener rides alongside pipe(): when the client stops reading, pipe()
    // pauses stdout and these events stop too, which is exactly what idleMs
    // should reflect.
    ffmpeg.stdout.on('data', (chunk) => {
        entry.lastOutputAt = Date.now();
        entry.bytes += chunk.length;
        if (entry.firstOutputAt === null) {
            entry.firstOutputAt = entry.lastOutputAt;
            console.log(`[Remux] ${remuxId} first output after ${((entry.firstOutputAt - startedAt) / 1000).toFixed(1)}s`);
            logStderr.flush(); // the probe is over; summarise its decoder chatter
        }
    });

    // A dropped upstream leaves ffmpeg alive but silent, retrying forever
    // under its -reconnect flags, still holding the provider's only
    // connection. Kill it once it has produced nothing for too long.
    let lastBackpressureAt = null;
    const watchdog = createStallWatchdog({
        label: `Remux ${remuxId}`,
        getLastActivity: () => {
            // Silence because the *client* is not reading (paused tab,
            // stalled network) is not ffmpeg's fault: it is blocked writing
            // to a full pipe. Only silence with the pipe open is a stall.
            // Remembering when that was last seen means that after the client
            // resumes, ffmpeg gets a full stall window to deliver, rather than
            // being judged against output from before the pause.
            if (ffmpeg.stdout.isPaused() || res.writableNeedDrain) lastBackpressureAt = Date.now();
            return Math.max(entry.lastOutputAt ?? 0, lastBackpressureAt ?? 0) || null;
        },
        onStall: () => {
            console.error(`[Remux] Releasing stalled ${remuxId} for ${redact(url)}`);
            if (stderrTail.length) {
                console.error(`[Remux] Last ffmpeg output for ${remuxId}:`);
                stderrTail.forEach(line => console.error(`[Remux]   ${redact(line)}`));
            }
            killRemux(remuxId);
        }
    });

    // Cleanup on client disconnect.
    // req 'close' also fires when the response ends, including because ffmpeg
    // died, so check which happened first before blaming the browser.
    req.on('close', () => {
        if (!activeRemuxes.has(remuxId)) return;
        activeRemuxes.delete(remuxId);
        if (ffmpegExited) return; // exit handler already reported the cause
        logStderr.end();
        console.log(describeRemuxEnd({ id: remuxId, startedAt, now: Date.now(), bytes: entry.bytes, firstOutputAt: entry.firstOutputAt }));
        try { ffmpeg.kill('SIGKILL'); } catch (e) { /* already gone */ }
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        ffmpegExited = true;
        logStderr.end();
        tailLines.end();
        watchdog.stop();
        activeRemuxes.delete(remuxId);
        if (code !== null && code !== 0 && code !== 255) {
            const alive = Math.round((Date.now() - startedAt) / 1000);
            console.error(`[Remux] ${remuxId} exited with code ${code} after ${alive}s`);
            if (stderrTail.length) {
                console.error(`[Remux] Last ffmpeg output for ${remuxId}:`);
                stderrTail.forEach(line => console.error(`[Remux]   ${line}`));
            }
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
module.exports.identifyCodecs = identifyCodecs;
module.exports.remuxFixes = remuxFixes;
module.exports.describeRemuxEnd = describeRemuxEnd;
module.exports.makeStderrLogger = makeStderrLogger;
module.exports.makeLineBuffer = makeLineBuffer;
module.exports.buildRemuxArgs = buildRemuxArgs;
module.exports.listActiveRemuxes = listActiveRemuxes;
module.exports.killRemux = killRemux;
module.exports.killAllRemuxes = killAllRemuxes;
