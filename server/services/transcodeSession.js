/**
 * Transcode Session Service
 * 
 * Manages HLS transcoding sessions with segment caching for VOD seeking.
 * Each session transcodes a source URL to HLS segments on disk.
 * 
 * Key features:
 * - Session-based transcoding with unique IDs
 * - HLS segment output for seeking support
 * - Segment caching for fast access
 * - Automatic cleanup of stale sessions
 */

const { isStreamUrl, NOT_A_STREAM_URL } = require('./streamUrl');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { redact } = require('../redact');
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');
const { createStallWatchdog, STALL_TIMEOUT_MS, STARTUP_GRACE_MS } = require('./stallWatchdog');
const { parseFrameRate } = require('./streamProbe');
const { MESSAGES: FAILURE_TEXT } = require('./playbackErrors');

// Session storage
const sessions = new Map();

// Cache directory for transcoded segments
const CACHE_DIR = path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout (seekable/VOD sessions)
// A live session nobody is fetching from is an ffmpeg process pulling the
// provider's stream for no one, so it goes much sooner. Deliberately not the
// blueprint's original ~2 minutes: the coordinator already reclaims a stream
// idle for 60 s the moment anyone needs the slot, so this is housekeeping for
// the case where nobody does - and a TV left paused through a phone call is not
// abandoned. Beyond ~6 minutes the 90-segment playlist window has rolled past
// the pause point anyway, so a longer wait buys nothing.
const LIVE_SESSION_TIMEOUT_MS = (() => {
    const sec = Number.parseInt(process.env.PIGTV_LIVE_IDLE_TIMEOUT_SEC, 10);
    return (Number.isFinite(sec) && sec > 0 ? sec : 5 * 60) * 1000;
})();
const SEGMENT_DURATION = 4; // seconds per HLS segment

// ffmpeg keeps ONE timestamp offset per input and, whenever a packet's DTS jumps
// by more than -dts_delta_threshold (default 10 s), assumes a discontinuity and
// shifts the offset. Some IPTV feeds start their audio and video on clocks that
// are more than 10 s apart, so the two streams take turns "jumping": every packet
// re-triggers the correction ("timestamp discontinuity ... new offset"), thousands
// of log lines, and roughly half the audio ends up dropped. A real jump (a channel
// splice, a provider restart) is minutes or hours, so the threshold is raised well
// clear of any A/V start-up skew but still catches those. Seconds, tunable.
const DTS_DELTA_THRESHOLD_SEC = (() => {
    const sec = Number.parseFloat(process.env.PIGTV_DTS_DELTA_THRESHOLD_SEC);
    return Number.isFinite(sec) && sec > 0 ? sec : 60;
})();

// Whether igndts is decided per feed from the probe (the default, see
// buildFFmpegArgs) or applied to every copy session the way 0085 did it.
// PIGTV_DTS_AUTO=0 restores the old behaviour with a container restart rather
// than a rebuild - the rollback for this change, since a redeploy ends every
// session and is expensive to do twice.
const DTS_AUTO = !/^(0|false|no)$/i.test(process.env.PIGTV_DTS_AUTO || '');

// How many segments a live session keeps on disk before rotating the
// oldest ones out. Unbounded (the old 0) means the whole session gets
// written to the Docker image's writable layer for as long as someone
// watches - a few hours of an 8 Mbps HEVC channel in copy mode is easily
// 10+ GB, reclaimed only when the session ends or the idle sweep fires.
// 90 segments = 6 minutes of rewind at SEGMENT_DURATION=4, well past what
// live TV needs, while keeping worst case per session in the hundreds of
// MB rather than unbounded.
const HLS_LIST_SIZE = 90;
// Extra segments kept on disk beyond the playlist window before delete_segments
// removes them. AVPlayer keeps a buffer behind the live edge and, after a
// client-side pause, can re-request a segment that has just rotated out of the
// 90-entry window; without a margin that request 404s and the stream stalls.
// 12 extra (~48s at SEGMENT_DURATION=4) covers that without materially adding
// to disk use - ~102 vs 90 segments per session, still comfortably inside the
// 2 GB tmpfs.
const HLS_DELETE_THRESHOLD = 12;
// How long a running session's directory may go without any file being
// written before ffmpeg is treated as stalled (see stallWatchdog.js). Segments
// are only closed - and, for fMP4, only flushed - at keyframe boundaries, so
// keep a floor of five segment durations even if the shared timeout is tuned
// down via PIGTV_STALL_TIMEOUT_MS.
const HLS_STALL_MS = Math.max(STALL_TIMEOUT_MS, SEGMENT_DURATION * 5 * 1000);
const CLEANUP_INTERVAL_MS = 60 * 1000; // Sweep every minute (a walk over an in-memory Map)

// The provider allows one connection, and the resolve probe has only just closed
// its own when ffmpeg opens the stream. Mark's log (build 0109, 7 Flix Sydney):
// ffmpeg was refused with an HTTP 4XX in its first second, straight after the
// probe, and the channel played on the next attempt. So a refusal that early is
// retried, after a pause long enough for the provider to let go.
// 0143: twice, 1.5 s then 3 s. Mark's log (0140): a channel played 120 s, the
// player failed and re-resolved, and the provider refused the new connection
// even after the 1.5 s retry - most likely still counting the old one.
const REFUSED_RETRY_WINDOW_MS = 3000;
const REFUSED_RETRY_DELAYS_MS = [1500, 3000];

// 0144: seconds of a finite source read at full speed before real-time pacing
// starts. PIGTV_READRATE_BURST=0 goes back to plain -re. Read on every use so
// the env var can be changed in tests.
const DEFAULT_READRATE_BURST_SEC = 8;
function readrateBurstSec() {
    const raw = process.env.PIGTV_READRATE_BURST;
    if (raw === undefined || raw === '') return DEFAULT_READRATE_BURST_SEC;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 60 ? n : DEFAULT_READRATE_BURST_SEC;
}
/** The input options that pace a finite source. */
function paceArgs() {
    const burst = readrateBurstSec();
    return burst > 0 ? ['-readrate', '1', '-readrate_initial_burst', String(burst)] : ['-re'];
}

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

/**
 * TranscodeSession class
 * Manages a single transcoding session from source URL to HLS segments
 */
class TranscodeSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = url;
        this.dir = path.join(CACHE_DIR, this.id);
        this.playlistPath = path.join(this.dir, 'stream.m3u8');
        this.process = null;
        this.segments = new Map(); // segment index -> { ready: boolean, path: string }
        this.status = 'pending'; // pending | starting | running | stopped | error
        this.error = null;
        this.startTime = Date.now();
        this.lastAccess = Date.now();

        // Diagnostics for a timed-out waitForPlaylist(): which stage was
        // slow is otherwise invisible behind one generic "failed to produce
        // a playlist in time" error.
        this.timings = { created: Date.now() };
        this.stderrTail = [];

        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            userAgent: options.userAgent || 'Mozilla/5.0',
            seekOffset: options.seekOffset || 0,
            hwEncoder: options.hwEncoder || 'software',
            maxResolution: options.maxResolution || '1080p',
            quality: options.quality || 'medium',
            // Upscaling options
            upscaleEnabled: options.upscaleEnabled || false,
            upscaleMethod: options.upscaleMethod || 'hardware', // 'hardware' or 'software'
            upscaleTarget: options.upscaleTarget || '1080p',
            // 'mpegts' (universal, but cannot carry HEVC for hls.js) or
            // 'fmp4' (lets HEVC be stream-copied instead of re-encoded)
            segmentType: options.segmentType === 'fmp4' ? 'fmp4' : 'mpegts',
            // Decode on the GPU where possible. Independent of vaapiCpuScale,
            // which only concerns the scaling/upload stage.
            vaapiHwDecode: options.vaapiHwDecode !== false,
            ...options
        };
    }

    /**
     * Start the transcoding process
     */
    async start() {
        if (this.status === 'running' || this.status === 'starting') {
            return;
        }

        // Backstop behind the routes' own check (see streamUrl.js): never hand
        // ffmpeg a local file, concat: list or pipe as its input.
        if (!isStreamUrl(this.url)) {
            this.status = 'error';
            this.error = NOT_A_STREAM_URL;
            throw new Error(NOT_A_STREAM_URL);
        }

        this.status = 'starting';
        console.log(`[TranscodeSession ${this.id}] Starting session for: ${redact(this.url)}`);

        // Create session directory
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }

        // Build FFmpeg arguments for HLS output
        const args = this.buildFFmpegArgs();

        console.log(`[TranscodeSession ${this.id}] Command: ${this.options.ffmpegPath} ${redact(args.join(' '))}`);

        try {
            this.process = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });

            this.status = 'running';
            this.timings.spawned = Date.now();
            this.startWatchdog();

            // Handle stdout (should be empty for file output)
            this.process.stdout.on('data', (data) => {
                console.log(`[TranscodeSession ${this.id}] stdout: ${data}`);
            });

            // Handle stderr (FFmpeg progress/errors)
            let stderrBuffer = '';
            this.process.stderr.on('data', (data) => {
                if (!this.timings.firstOutput) this.timings.firstOutput = Date.now();
                stderrBuffer += data.toString();
                // Log periodically to avoid spam
                const lines = stderrBuffer.split('\n');
                if (lines.length > 1) {
                    lines.slice(0, -1).forEach(line => {
                        if (line.trim()) {
                            console.log(`[FFmpeg ${this.id}] ${redact(line)}`);
                            this.stderrTail.push(line.trim());
                            if (this.stderrTail.length > 20) this.stderrTail.shift();
                        }
                    });
                    stderrBuffer = lines[lines.length - 1];
                }
            });
            // ffmpeg's last words (the reason it could not open the input) may
            // arrive without a trailing newline; keep them for failureReason().
            this.process.stderr.on('end', () => {
                if (stderrBuffer.trim()) {
                    console.log(`[FFmpeg ${this.id}] ${redact(stderrBuffer)}`);
                    this.stderrTail.push(stderrBuffer.trim());
                    if (this.stderrTail.length > 20) this.stderrTail.shift();
                }
                stderrBuffer = '';
            });

            // Handle process exit. Every way ffmpeg can end must leave an honest
            // status: a session still marked 'running' with no ffmpeg behind it
            // (what an unrequested exit 255 used to leave) looks like a stream in
            // use to anything that reads the status.
            const proc = this.process;
            proc.on('exit', (code, signal) => {
                // A failed start is judged on what ffmpeg said last (see
                // failureReason and the refused-connection retry below), and
                // 'exit' can fire before its stderr has been read to the end.
                // Wait for that, briefly; a clean or requested exit does not.
                const stderr = proc.stderr;
                if (code !== 0 && this.status !== 'stopped' && stderr && !stderr.readableEnded) {
                    let decided = false;
                    const decide = () => {
                        if (decided) return;
                        decided = true;
                        clearTimeout(cap);
                        this.handleExit(code, signal);
                    };
                    const cap = setTimeout(decide, 250);
                    stderr.once('end', decide);
                    stderr.once('close', decide);
                    return;
                }
                this.handleExit(code, signal);
            });

            // Handle spawn errors
            this.process.on('error', (err) => {
                console.error(`[TranscodeSession ${this.id}] FFmpeg error:`, err);
                this.stopWatchdog();
                this.status = 'error';
                this.error = err.message;
                this.emit('error', err);
            });

        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    /**
     * ffmpeg has exited: record how, and restart it once where that can help.
     */
    handleExit(code, signal) {
        this.stopWatchdog();
        // stop() marks the session 'stopped' before it signals ffmpeg, so
        // this tells "we ended it" apart from "it ended".
        const requested = this.status === 'stopped';
        if (code === 0 || (requested && (code === null || code === 255))) {
            // 255 is ffmpeg's own exit after SIGTERM; null is SIGKILL.
            console.log(`[TranscodeSession ${this.id}] FFmpeg completed successfully`);
            this.status = 'stopped';
        } else {
            const how = code === null ? `was killed (${signal || 'signal'})` : `exited with code ${code}`;
            console.error(`[TranscodeSession ${this.id}] FFmpeg ${how}`);
            this.status = 'error';
            this.error = `FFmpeg ${how}`;

            // Hardware decode is the most likely thing to fail on an
            // unusual driver, and it fails immediately rather than
            // part-way through. If a session dies within a few seconds
            // of starting, retry once with decode on the CPU before
            // giving up, so a driver quirk degrades performance
            // instead of breaking playback entirely.
            //
            // Only when that could be the reason: an encode that really
            // did decode on the GPU, and that never produced a playlist.
            // It used to apply to every session - including stream copies,
            // which decode nothing, i.e. every live session - and it clears
            // the session folder, so a client already fetching segments
            // got 404s from a restart that could not help.
            const diedEarly = (Date.now() - this.startTime) < 10000;
            const couldBeHwDecode = this._usedVaapiDecode === true && !this.timings.playlistReady;
            if (diedEarly && couldBeHwDecode && !this._triedSwDecode) {
                this._triedSwDecode = true;
                this.options.vaapiHwDecode = false;
                console.warn(`[TranscodeSession ${this.id}] Retrying with software decode`);
                this.process = null;
                this.status = 'pending';
                // Without append_list (see the HLS output args), a
                // stale playlist or leftover segments from the
                // failed hardware-decode attempt would confuse the
                // fresh ffmpeg process rather than being silently
                // extended by it. Clearing the directory first is
                // the correct fix, not a reason to bring
                // append_list back.
                this.clearSegments()
                    .catch(err => console.warn(`[TranscodeSession ${this.id}] Could not clear stale segments before retry:`, err.message))
                    .finally(() => {
                        this.start().catch(err => {
                            console.error(`[TranscodeSession ${this.id}] Software decode retry failed:`, err.message);
                        });
                    });
                return;
            }

            // The provider refused the connection outright, within
            // ffmpeg's first seconds: most likely it had not yet let go
            // of the resolve probe's connection (it allows one). Clear
            // the folder, wait, and try once more - the same shape as
            // the software-decode retry above. Not for a 404 (the
            // channel is not there; asking again will not change that),
            // not after a playlist exists, and at most twice (0143).
            // 0174: a failover candidate that is not the last gets one retry
            // after 1 s (options.refusedRetryDelaysMs); otherwise the 0143 two.
            const refused = classifyInputFailure(this.stderrTail);
            const sinceSpawn = this.timings.spawned ? Date.now() - this.timings.spawned : Infinity;
            const refusedEarly = sinceSpawn < REFUSED_RETRY_WINDOW_MS;
            const retries = this._refusedRetries || 0;
            const delays = Array.isArray(this.options.refusedRetryDelaysMs) ? this.options.refusedRetryDelaysMs : REFUSED_RETRY_DELAYS_MS;
            if (!requested && refused && refused.retryable && refusedEarly && !this.timings.playlistReady && retries < delays.length) {
                const delay = delays[retries];
                this._refusedRetries = retries + 1;
                // waitForPlaylist's deadline moves by the time this attempt
                // used plus the wait, so the last attempt still gets the
                // resolve's full 15 s (worst case +10.5 s in all).
                this.retryAllowanceMs = (this.retryAllowanceMs || 0) + sinceSpawn + delay;
                console.warn(`[TranscodeSession ${this.id}] Provider refused the connection; retry ${retries + 1} of ${delays.length} in ${delay / 1000}s`);
                this.process = null;
                this.status = 'pending';
                // The refusal is in the log already; what the retry says is what counts now.
                this.stderrTail = [];
                this.clearSegments()
                    .catch(err => console.warn(`[TranscodeSession ${this.id}] Could not clear the folder before retry:`, err.message))
                    .then(() => new Promise(resolve => setTimeout(resolve, delay)))
                    .then(() => {
                        // Stopped or removed while we waited: nothing to retry for.
                        if (this.status !== 'pending' || this._cleanedUp) return;
                        return this.start();
                    })
                    .catch(err => {
                        console.error(`[TranscodeSession ${this.id}] Retry after refused connection failed:`, err.message);
                    });
                return;
            }
        }
        this.process = null;
        // 0174: ffmpeg ended by itself after the session had played - the
        // provider may have dropped the channel (see noteLost).
        if (!requested && this.timings.playlistReady) this.noteLost('exit');
        this.emit('exit', code);
    }

    /**
     * 0174 (multi-provider failover): a session that had produced its playlist
     * ended without anyone asking - ffmpeg exited, or the stall watchdog released
     * it. Emits 'lost' { how: 'exit' | 'stall', providerReason } once; the resolve
     * route listens (providerRouting.watchSession) and quarantines the channel on
     * that provider, so the player's own re-resolve lands on the next provider.
     * A stall counts as a provider reason; an exit only when ffmpeg's last words
     * say so (providerFailureIn). Observation only: nothing about how the session
     * ends changes.
     */
    noteLost(how) {
        if (this._lostNoted) return;
        this._lostNoted = true;
        const providerReason = how === 'stall' || !!providerFailureIn(this.stderrTail);
        try {
            this.emit('lost', { how, providerReason });
        } catch (err) {
            console.warn(`[TranscodeSession ${this.id}] A lost-session listener failed:`, err.message);
        }
    }

    /**
     * Why this session's ffmpeg could not start, in words a viewer can act on,
     * or null when ffmpeg's output says nothing more specific. Never a URL and
     * never ffmpeg's own text: see classifyInputFailure.
     */
    failureReason() {
        const reason = classifyInputFailure(this.stderrTail);
        return reason ? reason.message : null;
    }

    /** ffmpeg is gone for good without our asking (a retry pending does not count). */
    hasFailed() {
        return this.status === 'error' || (this.status === 'stopped' && !this.process);
    }

    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
        return [...this.buildSourceArgs(), ...this.buildHlsOutputArgs()];
    }

    /**
     * Everything before the HLS muxer: input, timestamps, pacing, mapping, the
     * video copy/encode and the audio decision, and the two muxer-side
     * timestamp options. Split out of buildFFmpegArgs in 0126 so a tuner
     * (services/tuner.js) runs exactly these arguments and differs only in how
     * the HLS muxer keeps its window; test/tuner-args.test.js proves
     * buildFFmpegArgs still produces the 0125 arguments token for token.
     */
    buildSourceArgs() {
        const videoMode = this.options.videoMode || 'encode';
        const isFmp4 = this.options.segmentType === 'fmp4';

        // Resolve 'auto' encoder to detected hardware, fallback to software
        let encoder = this.options.hwEncoder || 'software';
        if (encoder === 'auto') {
            const hwCaps = hwDetect.getCapabilities();
            encoder = hwCaps?.recommended || 'software';
            console.log(`[TranscodeSession ${this.id}] Auto encoder resolved to: ${encoder}`);
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
        ];

        // Add hardware acceleration input options based on encoder (only if encoding)
        if (videoMode === 'encode') {
            this.addHwAccelInputArgs(args, encoder);
        }

        // igndts has ffmpeg discard the source's DTS and derive it from PTS order
        // instead. Whether that helps depends entirely on the feed, and 0085's mistake
        // was applying it to all of them:
        //
        //  - UNEVEN feed (a third of its steps near zero, because an upstream muxer
        //    bumped repeated DTS by +1 instead of fixing them): igndts is the cure.
        //    Without it, ~1000 "Non-monotonic DTS" per minute and visible judder.
        //  - EVEN feed (correct DTS): igndts throws away a good clock and ffmpeg
        //    re-derives it imperfectly - zero-length frames followed by double-length
        //    ones, which is the judder 0085 set out to remove.
        //
        // Both were reproduced on real captures. dtsUneven comes from the resolve-time
        // probe (streamProbe.classifyTimestamps) and is null when it could not be read,
        // which lands on the even branch - the majority case.
        //
        // A re-encode makes its own timestamps, so it is left alone either way.
        const useIgnDts = videoMode === 'copy' && (DTS_AUTO ? this.options.dtsUneven === true : true);
        const inputFlags = useIgnDts ? '+genpts+discardcorrupt+igndts' : '+genpts+discardcorrupt';

        // Input options (common)
        args.push(
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-fflags', inputFlags,
            '-err_detect', 'ignore_err',
            '-dts_delta_threshold', String(DTS_DELTA_THRESHOLD_SEC),
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3'
        );

        // Pacing: read the input no faster than it plays. Only for a source that ends (see
        // paceInput in playbackStrategy). Never for a live feed, which arrives in real time
        // anyway: measured, -re on one costs seconds at start-up.
        // 0144: an initial burst first (-readrate_initial_burst, new in ffmpeg 6.1), so the
        // first segment is written at once instead of after 4 s of real time; after it, real
        // time, so the file still can't outrun the playlist window. PIGTV_READRATE_BURST=0 is
        // the old -re.
        if (this.options.paceInput === true) args.push(...paceArgs());

        args.push('-i', this.url);

        // Add seek offset if specified (as output option to avoid Range requests)
        if (this.options.seekOffset > 0) {
            args.push('-ss', String(this.options.seekOffset));
        }

        // Map streams
        args.push('-map', '0:v:0');
        args.push('-map', '0:a:0?');

        // Add video encoder and filters based on selected encoder OR copy
        if (videoMode === 'copy') {
            args.push('-c:v', 'copy');

            if (isFmp4) {
                // fMP4 wants length-prefixed samples, which is what the source
                // already has coming out of MPEG-TS via the mp4 muxer, so no
                // Annex B conversion here. The tag matters though: hls.js and
                // Safari both expect hvc1 for HEVC in fMP4.
                //
                // No dump_extra here (see 0043, where it was added, and this
                // patch, which removes it): a real tvOS session logged
                // "SEI type 1 size 80 truncated at 1", "missing picture in
                // access unit", and "[mp4] pts has no value" immediately
                // after 0043 shipped - bitstream-parser-level corruption,
                // not the muxer-side timestamp confusion 0041/0042 dealt
                // with, and playback ended almost immediately rather than
                // stuttering. dump_extra was the one new element common to
                // both the H.264 case 0043 added and the HEVC case that
                // already worked without it before - removing it restores
                // exactly what HEVC+fmp4 sent before 0043, on both codecs.
                const vc = (this.options.videoCodec || '').toLowerCase();
                if (vc.includes('hevc') || vc.includes('h265')) {
                    args.push('-tag:v', 'hvc1');
                }
            } else if (this.options.videoCodec === 'hevc' || this.options.videoCodec === 'h265') {
                // Critical for MKV/MP4 -> TS copy: AVCC/HVCC to Annex B
                args.push('-bsf:v', 'hevc_mp4toannexb');
            } else if (this.options.videoCodec === 'h264' || this.options.videoCodec === 'avc') {
                args.push('-bsf:v', 'h264_mp4toannexb');
            } else {
                args.push('-bsf:v', 'dump_extra');
            }
        } else {
            this.addVideoEncoderArgs(args, encoder);
        }

        // Audio: Apply mix preset
        const audioCodec = this.options.audioCodec?.toLowerCase() || 'unknown';
        const audioChannels = this.options.audioChannels || 0;
        const audioMixPreset = this.options.audioMixPreset || 'auto';
        // HE-AAC cannot be passed through to a browser (see streamProbe), so it is
        // excluded from every copy path here even though it is stereo AAC - unless
        // the client said it decodes HE-AAC (heaacCopy, from capability heaac: 0116),
        // in which case it is copied like any other AAC.
        const audioProfile = (this.options.audioProfile || '').toLowerCase();
        const isHeAac = this.options.isHeAac === true || audioProfile.includes('he-aac');
        const heAacBlocked = isHeAac && this.options.heaacCopy !== true;
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2 && !heAacBlocked;

        // Define pan filter presets for 5.1 -> Stereo downmix
        const AUDIO_MIX_FILTERS = {
            // ITU-R BS.775 Standard: Mathematically balanced, transparent
            itu: 'pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE',
            // Night Mode: Heavy dialogue boost, reduced bass/surrounds for quiet viewing
            night: 'pan=stereo|FL=0.5*FL+1.2*FC+0.3*BL+0.1*LFE|FR=0.5*FR+1.2*FC+0.3*BR+0.1*LFE',
            // Cinematic: Wide soundstage, immersive (original "dialogue boost" mix)
            cinematic: 'pan=stereo|FL=FC+0.80*FL+0.60*BL+0.5*LFE|FR=FC+0.80*FR+0.60*BR+0.5*LFE'
        };

        // Raw ADTS AAC — the framing MPEG-TS/live sources use — carries no
        // Audio Specific Config; MP4-family containers (fMP4/HLS-CMAF, and
        // plain MP4) require one instead, in the sample description rather
        // than per frame. Copying AAC into one without converting it first
        // makes the muxer reject every audio packet outright ("Malformed
        // AAC bitstream... Operation not permitted") rather than producing
        // a stream with no audio — it fails the whole session. MPEG-TS
        // output needs no such conversion, since it keeps ADTS framing
        // natively, so this is conditioned on isFmp4.
        //
        // All three copy branches below funnel through this so none of
        // them can independently drift out of sync with the others again.
        const pushAudioCopy = () => {
            args.push('-c:a', 'copy');
            if (isFmp4 && audioCodec.includes('aac')) {
                args.push('-bsf:a', 'aac_adtstoasc');
            }
        };

        // audioMode 'encode' is an explicit request to re-encode, e.g. after the
        // browser's decoder choked on the provider's audio frames. It must beat the
        // "smart copy" shortcuts below, which would otherwise copy a stereo AAC
        // source straight through - the very audio that failed.
        const forceEncode = this.options.audioMode === 'encode';

        if (this.options.audioMode === 'copy' && !heAacBlocked) {
            // Caller (playbackStrategy) has already established via client
            // capabilities that this audio codec plays as-is and wants it
            // copied through untouched — the same guarantee a plain remux
            // gives, just inside an HLS session instead of a piped
            // response. This intentionally bypasses audioMixPreset, which
            // exists to pick a *downmix*, a question that doesn't apply
            // when nothing needs mixing in the first place.
            console.log(`[TranscodeSession ${this.id}] Audio: Copy (client capabilities confirm ${audioCodec} support)`);
            pushAudioCopy();
        } else if (audioMixPreset === 'passthrough' && !heAacBlocked && !forceEncode) {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            pushAudioCopy();
        } else if (heAacBlocked || (isHeAac && forceEncode)) {
            // Re-encode to AAC-LC. Only the audio is touched, so this stays
            // cheap even when the video is being stream-copied.
            console.log(`[TranscodeSession ${this.id}] Audio: HE-AAC source -> AAC-LC (${heAacBlocked ? 'this client cannot decode HE-AAC' : 're-encode requested'})`);
            args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-b:a', '128k');
        } else if (audioMixPreset === 'auto' && isStereoAac && !forceEncode) {
            // Auto + Stereo AAC source: Smart copy
            console.log(`[TranscodeSession ${this.id}] Audio: Auto (Smart Copy) - Source is Stereo AAC`);
            pushAudioCopy();
        } else {
            // Transcode to AAC with selected mix preset (default to ITU for 'auto')
            const mixPreset = (audioMixPreset === 'auto') ? 'itu' : audioMixPreset;
            const panFilter = AUDIO_MIX_FILTERS[mixPreset] || AUDIO_MIX_FILTERS.itu;

            console.log(`[TranscodeSession ${this.id}] Audio: ${mixPreset.toUpperCase()} mix (${audioCodec} ${audioChannels}ch -> Stereo AAC)`);
            args.push(
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '192k',
                '-af', `${panFilter},aresample=async=1`
            );
        }

        // HLS output options
        //
        // avoid_negative_ts / max_interleave_delta: both address the source
        // clock, not anything about the segment format. Stream-copy mode
        // means ffmpeg cannot regenerate timestamps from decoded frames the
        // way a re-encode would - it can only accept or reject whatever the
        // source declares, which is why a provider with a bad clock shows
        // up here rather than as a video artifact.
        //
        // - max_interleave_delta defaults to 10s, an assumption that
        //   ffmpeg knows roughly when the input ends so it can safely
        //   buffer packets that long before writing them out in corrected
        //   order. A live, genuinely unbounded source breaks that
        //   assumption - this is a known ffmpeg live-streaming caveat, not
        //   specific to this project - and the heuristic can misfire on
        //   nearly every packet rather than occasionally, which is what a
        //   continuous "Invalid DTS ... replacing by guess" flood (as
        //   opposed to a single isolated jump) points to. 0 disables it.
        // - avoid_negative_ts make_zero normalizes a discontinuous or
        //   negative timestamp at the muxer instead of letting a raw jump
        //   from the source reach the output untouched - the isolated
        //   "timestamp discontinuity" case, distinct from the continuous
        //   one above.
        //
        // Neither can fix a source whose timestamps are simply wrong frame
        // by frame; they reduce how often that becomes a visible stutter.
        args.push(
            '-avoid_negative_ts', 'make_zero',
            '-max_interleave_delta', '0'
        );

        return args;
    }

    /**
     * The HLS muxer: 4 s segments, a 90-segment window with 12 spare, and
     * ffmpeg's own playlist (stream.m3u8) served as it is written.
     */
    buildHlsOutputArgs() {
        const isFmp4 = this.options.segmentType === 'fmp4';
        const args = [];
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', String(HLS_LIST_SIZE),
            // Keep a few segments beyond the playlist window before deleting,
            // so a client that pauses and re-requests a just-rotated segment
            // still finds it rather than getting a 404 and stalling.
            '-hls_delete_threshold', String(HLS_DELETE_THRESHOLD),
            // delete_segments: the previous unbounded list_size meant a
            // session was never reclaimed until it ended or the 30-minute
            // idle sweep fired. Rotating segments out as the list fills
            // keeps disk use bounded for the whole time someone's watching,
            // not just after.
            //
            // No append_list: it existed for the software-decode retry
            // (below), which restarts ffmpeg into the same directory after
            // a hardware-decode failure. append_list made the new process
            // try to extend the old attempt's playlist rather than start
            // clean - blending segments from a failed hw-decode attempt
            // with the new software ones in the same playlist. The retry
            // path now clears the directory itself instead, which is the
            // correct fix for that case rather than a reason to keep this.
            //
            // temp_file: ffmpeg writes each playlist update to a temp file and
            // renames it into place, so a client polling the playlist never
            // reads it half-written while segments are being rotated out. On a
            // live stream with delete_segments this is the difference between
            // an atomic swap and a torn read, and a torn playlist is the most
            // likely cause of AVPlayer stalling a few minutes into a session.
            '-hls_flags', 'independent_segments+delete_segments+temp_file'
        );

        if (isFmp4) {
            args.push(
                '-hls_segment_type', 'fmp4',
                '-hls_fmp4_init_filename', 'init.mp4',
                '-hls_segment_filename', path.join(this.dir, 'seg%04d.m4s')
            );
        } else {
            args.push(
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts')
            );
        }

        args.push(this.playlistPath);

        return args;
    }

    /**
     * Add hardware acceleration input arguments
     */
    addHwAccelInputArgs(args, encoder) {
        switch (encoder) {
            case 'nvenc':
                // NVIDIA CUDA/NVDEC hardware decoding
                args.push(
                    '-hwaccel', 'cuda',
                    '-hwaccel_output_format', 'cuda'
                );
                break;
            case 'vaapi':
                // What the software-decode retry on exit keys on (see start()).
                this._usedVaapiDecode = this.options.vaapiHwDecode !== false;
                if (this.options.vaapiCpuScale !== false && this.options.vaapiHwDecode !== false) {
                    // Decode on the GPU but let ffmpeg hand the frames back in
                    // system memory (no -hwaccel_output_format), so the filter
                    // chain can scale on the CPU and hwupload for the encoder.
                    // This avoids the VPP pipeline that is broken on this class
                    // of iGPU while still keeping decode off the CPU, which is
                    // the expensive half for HEVC.
                    args.push(
                        '-hwaccel', 'vaapi',
                        '-hwaccel_device', '/dev/dri/renderD128',
                        '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
                        '-filter_hw_device', 'va'
                    );
                } else if (this.options.vaapiCpuScale !== false) {
                    // Some Intel iGPUs expose a VAAPI encoder but not a working
                    // decode + VPP pipeline, so hardware decode into VAAPI
                    // surfaces fails before any filter runs. Decode on the CPU
                    // instead and only initialise the device for the encoder:
                    // the filter chain in addVaapiEncoderArgs scales in software
                    // and hwuploads the result.
                    args.push(
                        '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
                        '-filter_hw_device', 'va'
                    );
                } else {
                    // VAAPI hardware decoding (Linux)
                    args.push(
                        '-hwaccel', 'vaapi',
                        '-hwaccel_device', '/dev/dri/renderD128',
                        '-hwaccel_output_format', 'vaapi'
                    );
                }
                break;
            case 'qsv':
                // Intel QuickSync hardware decoding
                args.push(
                    '-hwaccel', 'qsv',
                    '-hwaccel_output_format', 'qsv'
                );
                break;
            case 'amf':
                // AMD AMF (no hwaccel input, AMF is encode-only)
                // Decode on CPU, encode on GPU
                break;
            case 'software':
            case 'auto':
            default:
                // No hardware acceleration for input
                break;
        }
    }

    /**
     * Add video encoder arguments based on selected encoder
     */
    addVideoEncoderArgs(args, encoder) {
        const resolution = this.getTargetHeight();
        const quality = this.options.quality || 'medium';

        // Live IPTV streams have irregular timestamps. Without this, ffmpeg
        // forces a constant frame rate and duplicates frames to fill the gaps
        // ("More than 1000 frames duplicated"), which wastes encoder capacity
        // and drifts further behind real time the longer the stream runs.
        args.push('-fps_mode', 'passthrough');

        // Quality presets mapping
        const qualityPresets = {
            'high': { nvenc: 18, vaapi: 18, qsv: 18, amf: 18, software: 18 },
            'medium': { nvenc: 24, vaapi: 24, qsv: 24, amf: 24, software: 23 },
            'low': { nvenc: 30, vaapi: 30, qsv: 30, amf: 30, software: 28 }
        };
        const qp = qualityPresets[quality] || qualityPresets.medium;

        switch (encoder) {
            case 'nvenc':
                this.addNvencEncoderArgs(args, resolution, qp.nvenc);
                break;
            case 'amf':
                this.addAmfEncoderArgs(args, resolution, qp.amf);
                break;
            case 'vaapi':
                this.addVaapiEncoderArgs(args, resolution, qp.vaapi);
                break;
            case 'qsv':
                this.addQsvEncoderArgs(args, resolution, qp.qsv);
                break;
            case 'software':
            case 'auto':
            default:
                this.addSoftwareEncoderArgs(args, resolution, qp.software);
                break;
        }
    }

    /**
     * Get target height based on maxResolution or upscaleTarget setting
     * When upscaling is enabled, uses the upscaleTarget resolution.
     * Otherwise, uses maxResolution to cap the output.
     */
    getTargetHeight() {
        const resolutionMap = {
            '4k': 2160,
            '1080p': 1080,
            '720p': 720,
            '480p': 480
        };

        // When upscaling is enabled, use the upscale target resolution
        if (this.options.upscaleEnabled) {
            const target = resolutionMap[this.options.upscaleTarget] || 1080;
            console.log(`[TranscodeSession ${this.id}] Upscale target height: ${target}p`);
            return target;
        }

        // Otherwise, use max resolution as the cap
        return resolutionMap[this.options.maxResolution] || 1080;
    }

    /**
     * Build scale filter string based on encoder and upscaling settings
     * @param {string} encoder - The encoder being used
     * @param {number} height - Target height
     */
    buildScaleFilter(encoder, height) {
        const useUpscale = this.options.upscaleEnabled;
        const upscaleMethod = this.options.upscaleMethod || 'hardware';

        // Log upscaling status
        if (useUpscale) {
            console.log(`[TranscodeSession ${this.id}] Upscaling: ${upscaleMethod} method to ${height}p`);
        }

        // Hardware scaling filters (for both upscale and downscale)
        if (upscaleMethod === 'hardware' || !useUpscale) {
            switch (encoder) {
                case 'nvenc':
                    // NVIDIA CUDA scaling with Lanczos
                    // Force nv12 (8-bit) output to handle 10-bit inputs (fixes "10 bit encode not supported")
                    return `scale_cuda=-2:${height}:interp_algo=lanczos:format=nv12`;
                case 'vaapi':
                    return `scale_vaapi=w=-2:h=${height}:format=nv12`;
                case 'qsv':
                    return `scale_qsv=w=-2:h=${height}:format=nv12`;
                case 'amf':
                    // AMF uses CPU decode, so use software scale
                    return useUpscale ? `scale=-2:${height}:flags=lanczos` : `scale=-2:${height}`;
                case 'software':
                default:
                    return useUpscale ? `scale=-2:${height}:flags=lanczos` : `scale=-2:${height}`;
            }
        }

        // Software Lanczos scaling (high quality, slower)
        return `scale=-2:${height}:flags=lanczos`;
    }

    /**
     * NVIDIA NVENC encoder arguments
     */
    addNvencEncoderArgs(args, height, qp) {
        // Video filter for scaling on GPU
        args.push('-vf', this.buildScaleFilter('nvenc', height));

        // NVENC encoder with quality settings
        // Using portable options that work across FFmpeg builds
        args.push(
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',           // Balanced preset (p1=fastest, p7=best)
            '-rc', 'constqp',          // Constant QP mode
            '-qp', String(qp),
            '-bf', '3'                 // B-frames for better compression
        );
    }

    /**
     * AMD AMF encoder arguments
     */
    addAmfEncoderArgs(args, height, qp) {
        // CPU decoding + software scale + AMF encode
        args.push('-vf', this.buildScaleFilter('amf', height));

        args.push(
            '-c:v', 'h264_amf',
            '-quality', 'quality',     // Quality preset
            '-rc', 'cqp',              // Constant QP
            '-qp_i', String(qp),
            '-qp_p', String(qp + 2),
            '-qp_b', String(qp + 4),
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * VAAPI encoder arguments (Linux)
     */
    addVaapiEncoderArgs(args, height, qp) {
        const cpuScale = this.options.vaapiCpuScale !== false;

        if (cpuScale) {
            // Frames are in system memory (see addHwAccelInputArgs): scale on
            // the CPU, then upload to the VAAPI device for encoding.
            //
            // min(ih,H) clamps rather than resizes: a 1080p source with a
            // 1080p cap passes straight through instead of being rescaled to
            // the same size, which on CPU-side scaling is pure wasted work.
            // Upscaling, when explicitly enabled, still needs a real resize.
            const scale = this.options.upscaleEnabled
                ? `scale=-2:${height}:flags=lanczos`
                : `scale='trunc(iw*min(1,${height}/ih)/2)*2':'min(ih,${height})'`;
            args.push('-vf', `${scale},format=nv12,hwupload`);
        } else {
            // VAAPI filter chain:
            // 1. scale_vaapi to resize on GPU
            // 2. Ensure output format is nv12 for maximum encoder compatibility
            // The format is handled automatically when using -hwaccel_output_format vaapi
            args.push('-vf', this.buildScaleFilter('vaapi', height));
        }

        // VAAPI encoder with quality setting
        // Note: -global_quality is the portable way to set quality for VAAPI
        args.push(
            '-c:v', 'h264_vaapi',
            '-profile:v', 'main',      // Use main profile for compatibility
            '-global_quality', String(qp),
            // No B-frames for live. They add reordering latency and, on Intel
            // VAAPI, cost noticeably more than they save at these bitrates.
            '-bf', '0',
            // Force a keyframe on each segment boundary so the muxer can cut
            // cleanly instead of stretching segments to the next natural IDR.
            '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_DURATION})`
        );

        if (!cpuScale) {
            // Only meaningful when the frames are still software frames at this
            // point; with hwupload the encoder input is already a VAAPI surface
            // and forcing a software pixel format conflicts with it.
            args.push('-pix_fmt', 'yuv420p');
        }
    }

    /**
     * Intel QuickSync encoder arguments
     */
    addQsvEncoderArgs(args, height, qp) {
        // Scale on QSV
        args.push('-vf', this.buildScaleFilter('qsv', height));

        args.push(
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', String(qp),
            '-look_ahead', '1',
            '-look_ahead_depth', '40',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Software encoder arguments (fallback)
     */
    addSoftwareEncoderArgs(args, height, crf) {
        // Software scaling (use Lanczos for upscaling if enabled)
        args.push('-vf', this.buildScaleFilter('software', height));

        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Fast for real-time
            '-crf', String(crf),
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility (fixes 10-bit input errors)
        );
    }

    /**
     * Stop the transcoding process, and don't resolve until it has actually
     * exited.
     *
     * The previous version fired SIGTERM/SIGKILL and returned immediately,
     * so cleanup() could delete this.dir while ffmpeg was still finishing a
     * write into it — the source of the "file not found" errors that
     * followed a stop in the supplied logs. Returning a promise here means
     * a caller that awaits stop() (cleanup() now does) is guaranteed the
     * process is gone before it does anything that assumes that.
     */
    stop() {
        if (this._stopPromise) return this._stopPromise;

        // 0180: somebody asked for this (a DELETE, a replacement, a force, shutdown);
        // ffmpeg ending because of it is not the provider's failure.
        this.stopRequested = true;
        this.status = 'stopped';
        this.stopWatchdog();

        // Also when ffmpeg has already exited and only the exit bookkeeping is
        // pending (see the 'exit' listener in start()): there is nothing to signal,
        // and waiting on an 'exit' that has been and gone would hang for 5 s.
        const proc0 = this.process;
        if (!proc0 || proc0.exitCode !== null || proc0.signalCode !== null) {
            this._stopPromise = Promise.resolve();
            return this._stopPromise;
        }

        const proc = this.process;
        console.log(`[TranscodeSession ${this.id}] Stopping FFmpeg process`);

        this._stopPromise = new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                clearTimeout(safetyTimer);
                resolve();
            };

            proc.once('exit', done);
            proc.kill('SIGTERM');

            // Force kill after 2 seconds if still running.
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
            }, 2000);

            // If 'exit' somehow never fires, don't hang the caller forever —
            // stop() should always settle.
            const safetyTimer = setTimeout(done, 5000);
        });

        return this._stopPromise;
    }

    /**
     * Update last access time (prevents cleanup)
     */
    touch() {
        this.lastAccess = Date.now();
    }

    /**
     * Epoch ms of the newest file ffmpeg has written into the session
     * directory (segments, their .tmp while being written, playlist, init
     * segment), or null if it has written nothing yet.
     *
     * File writes are the honest signal for "ffmpeg is producing media".
     * Its stderr is no use: a dead upstream makes it louder, not quieter,
     * because every reconnect attempt logs. Only ffmpeg writes here.
     */
    async latestOutputAt() {
        let names;
        try {
            names = await fs.readdir(this.dir);
        } catch {
            return null;
        }
        let latest = null;
        for (const name of names) {
            try {
                const { mtimeMs } = await fs.stat(path.join(this.dir, name));
                if (latest === null || mtimeMs > latest) latest = mtimeMs;
            } catch { /* rotated out by delete_segments between readdir and stat */ }
        }
        return latest;
    }

    startWatchdog() {
        this.stopWatchdog();
        this._watchdog = createStallWatchdog({
            label: `TranscodeSession ${this.id}`,
            getLastActivity: () => this.latestOutputAt(),
            onStall: () => this.handleStall(),
            stallMs: this.options.stallMs ?? HLS_STALL_MS,
            startupMs: this.options.startupMs ?? STARTUP_GRACE_MS,
            checkIntervalMs: this.options.watchdogIntervalMs
        });
    }

    stopWatchdog() {
        if (this._watchdog) {
            this._watchdog.stop();
            this._watchdog = null;
        }
    }

    /**
     * ffmpeg is alive but has stopped producing media. Remove the whole
     * session, not just the process: a session left in the registry still
     * counts as a provider connection to the coordinator, which is the very
     * thing being freed. The client's next playlist request 404s and it
     * re-resolves.
     */
    async handleStall() {
        console.error(`[TranscodeSession ${this.id}] Releasing stalled session for ${redact(this.url)}`);
        if (this.stderrTail.length) {
            console.error(`[TranscodeSession ${this.id}] Last ffmpeg output:`);
            this.stderrTail.forEach(line => console.error(`[TranscodeSession ${this.id}]   ${redact(line)}`));
        }
        // Drop it from the registry before waiting on ffmpeg to die, so the
        // coordinator stops counting it straight away rather than after
        // stop()'s SIGTERM/SIGKILL grace period. cleanup() is idempotent.
        sessions.delete(this.id);
        if (this.timings.playlistReady) this.noteLost('stall');
        try {
            await this.cleanup();
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Could not clean up stalled session:`, err.message);
        }
    }

    /**
     * Remove every segment and playlist file from this session's directory,
     * without removing the directory itself. Used before the software-decode
     * retry restarts ffmpeg into the same directory - the previous attempt's
     * output has to be gone, not just no longer referenced, since a fresh
     * ffmpeg process with a bounded -hls_list_size will happily reuse
     * matching segment filenames if they're still there.
     */
    async clearSegments() {
        let entries;
        try {
            entries = await fs.readdir(this.dir);
        } catch (err) {
            if (err.code === 'ENOENT') return; // nothing to clear
            throw err;
        }
        await Promise.all(entries.map(name =>
            fs.unlink(path.join(this.dir, name)).catch(() => { /* best effort */ })
        ));
    }

    /**
     * Check if playlist exists and is ready
     */
    async isPlaylistReady() {
        try {
            await fs.access(this.playlistPath);
            const content = await fs.readFile(this.playlistPath, 'utf8');
            // A playlist can be syntactically valid and still have nothing
            // to play: for fMP4 output the #EXT-X-MAP init-segment tag
            // (init.mp4) appears before any media segment does. Checking
            // for '.ts' only ever matched the MPEG-TS case, so a valid
            // fMP4 playlist (segments named seg%04d.m4s, see
            // buildFFmpegArgs) was reported "not ready" until
            // waitForPlaylist simply ran out of time — nothing about the
            // playlist itself was ever going to change that verdict.
            return content.includes('.ts') || content.includes('.m4s');
        } catch {
            return false;
        }
    }

    /**
     * Wait for playlist to be ready (with timeout)
     */
    async waitForPlaylist(timeoutMs = 10000, { deadlineAt = null } = {}) {
        const startTime = Date.now();
        // Extended only by a refused-connection retry (0143): the time the
        // refused attempt took plus the wait before the next one. A failover
        // resolve (0174) also passes a hard deadlineAt that nothing extends.
        const allowance0 = this.retryAllowanceMs || 0;
        while (Date.now() - startTime < timeoutMs + (this.retryAllowanceMs || 0) - allowance0
            && !(deadlineAt && Date.now() >= deadlineAt)) {
            if (await this.isPlaylistReady()) {
                this.timings.playlistReady = Date.now();
                return true;
            }
            // 0180: stopped on request (a replacement, a DELETE): not a failure, so no
            // "ended before producing a playlist" diagnostics; the resolve reports it.
            if (this.stopRequested) return false;
            // ffmpeg has already ended without a playlist, and nothing will
            // restart it (a pending retry leaves the status 'pending'): there is
            // nothing to wait for. Before 0113 this polled out the whole timeout
            // - 15 s of a viewer staring at a spinner for a channel the provider
            // had refused in the first second.
            if (this.hasFailed()) {
                this.timings.endedEarly = Date.now();
                this.logTimeoutDiagnostics(null);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        this.logTimeoutDiagnostics(timeoutMs);
        return false;
    }

    /**
     * Log where a timed-out session actually spent its time, plus a
     * bounded ffmpeg stderr tail. "Failed to produce a playlist in time" is
     * one message for several different failures — never spawned, spawned
     * but produced no output (provider/network stalled), or produced
     * output but never a ready playlist (the isPlaylistReady bug above was
     * found this way) — and previously none of them were distinguishable
     * without reproducing with verbose logging on.
     */
    logTimeoutDiagnostics(timeoutMs) {
        const t = this.timings;
        const since = (a, b) => (a && b) ? `${b - a}ms` : 'never';
        console.error(timeoutMs === null
            ? `[TranscodeSession ${this.id}] FFmpeg ended before producing a playlist (${this.error || this.status})`
            : `[TranscodeSession ${this.id}] Playlist not ready after ${timeoutMs}ms`);
        console.error(`[TranscodeSession ${this.id}]   created -> spawned: ${since(t.created, t.spawned)}`);
        console.error(`[TranscodeSession ${this.id}]   spawned -> first ffmpeg output: ${since(t.spawned, t.firstOutput)}`);
        if (this.stderrTail.length) {
            console.error(`[TranscodeSession ${this.id}] Last ffmpeg output:`);
            this.stderrTail.forEach(line => console.error(`[TranscodeSession ${this.id}] ${redact(line)}`));
        }
    }

    /**
     * Get the HLS playlist content
     */
    async getPlaylist() {
        this.touch();
        try {
            return await fs.readFile(this.playlistPath, 'utf8');
        } catch (err) {
            return null;
        }
    }

    /**
     * The master playlist fronting this session, or null when it has none (resolve
     * sets videoRange for an HDR copy, and 'SDR' for any other session with a usable
     * frame rate - 0100, 0115). Built in memory: it never changes during a session,
     * so nothing is written.
     */
    getMasterPlaylist() {
        if (!this.options.videoRange) return null;
        this.touch();
        return buildMasterPlaylist(this.options);
    }

    /**
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        const segmentPath = path.resolve(this.dir, segmentName);
        // Defence in depth behind the route's filename whitelist: whatever the
        // caller passes, never resolve to a file outside this session's directory.
        if (path.dirname(segmentPath) !== path.resolve(this.dir)) return null;
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Delete session directory and all segments
     */
    async cleanup() {
        // Idempotent: removeSession() and a stale-session sweep can race
        // each other onto the same session, and a second cleanup() must be
        // a no-op rather than a second concurrent rm() of a directory the
        // first call is already deleting.
        if (this._cleanedUp) return;
        this._cleanedUp = true;

        // stop() now resolves only once ffmpeg has actually exited (see
        // above), so by the time rm() runs below nothing is still writing
        // into this.dir.
        await this.stop();

        try {
            await fs.rm(this.dir, { recursive: true, force: true });
            console.log(`[TranscodeSession ${this.id}] Cleaned up session directory`);
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Failed to cleanup:`, err.message);
        }
    }
}

/**
 * Session Manager
 */

/**
 * Create a new transcode session
 */
async function createSession(url, options = {}) {
    await ensureCacheDir();
    const session = new TranscodeSession(url, options);
    sessions.set(session.id, session);
    return session;
}

/**
 * Get an existing session by ID
 */
function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.touch();
    }
    return session;
}

/**
 * Stop and remove a session
 */
async function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        await session.cleanup();
        sessions.delete(sessionId);
    }
}

/**
 * Cleanup stale sessions (idle for too long)
 */
async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        const limit = session.options.live === true ? LIVE_SESSION_TIMEOUT_MS : SESSION_TIMEOUT_MS;
        if (now - session.lastAccess > limit) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            await removeSession(id);
        }
    }
}

/**
 * Delete every directory left in the cache from a previous process.
 *
 * There is no such thing as "recovering" one of these: the ffmpeg process
 * that was writing into it is gone the moment this process restarts, and a
 * client reconnecting gets a new session with a new id regardless. Without
 * this, a crash or restart mid-session left its directory behind forever -
 * nothing else ever revisits it, since cleanupStaleSessions only walks the
 * in-memory sessions Map, which starts empty on every process start.
 */
async function sweepOrphanedCache() {
    let dirs;
    try {
        dirs = await fs.readdir(CACHE_DIR, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return; // nothing to sweep
        console.error('[TranscodeSession] Error sweeping cache directory:', err.message);
        return;
    }

    const orphaned = dirs.filter(d => d.isDirectory());
    if (orphaned.length === 0) return;

    console.log(`[TranscodeSession] Sweeping ${orphaned.length} orphaned session director${orphaned.length === 1 ? 'y' : 'ies'} from a previous run`);
    await Promise.all(orphaned.map(dirent =>
        fs.rm(path.join(CACHE_DIR, dirent.name), { recursive: true, force: true })
            .catch(err => console.warn(`[TranscodeSession] Could not remove ${dirent.name}:`, err.message))
    ));
}

/**
 * Start cleanup interval
 */
let cleanupInterval = null;
function startCleanupInterval() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref(); // Don't prevent process exit
    }
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getAllSessions() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        url: s.url,
        status: s.status,
        startTime: s.startTime,
        lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess,
        owner: s.options.owner || null,
        // The provider (a source id) whose connection this session holds (0173); null when the
        // resolve named no source (a bare url), which counts against the primary's pool.
        providerId: s.options.providerId ?? null
    }));
}

/**
 * Why ffmpeg could not open the provider's stream, from the tail of its stderr,
 * as { status, retryable, message } - or null when the tail shows none of the
 * failures below, and the caller keeps its generic error.
 *
 * `message` goes to the client as the resolve error, so it is built only from
 * fixed text and the HTTP status (digits, or ffmpeg's own "4XX"/"5XX" class):
 * never the URL, which carries the provider credentials, nor ffmpeg's wording.
 *
 * ffmpeg's texts (libavutil/error.c): "Server returned 400 Bad Request",
 * "401 Unauthorized (authorization failed)", "403 Forbidden (access denied)",
 * "404 Not Found", "4XX Client Error, but not one of 40{0,1,3,4}", "5XX Server
 * Error reply"; newer builds add e.g. "429 Too Many Requests". The latest match
 * wins, so after a retry the second attempt's reason is the one reported.
 */
function classifyInputFailure(lines) {
    if (!Array.isArray(lines)) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = String(lines[i]);
        const http = /Server returned ([45](?:\d\d|XX))\b/i.exec(line);
        if (http) {
            const status = http[1].toLowerCase();
            // 0118 (C-B): every text starts with one of the client's allowed prefixes
            // (services/playbackErrors.js).
            if (status === '404') {
                return { status, retryable: false, message: FAILURE_TEXT.notFound() };
            }
            if (status.startsWith('5')) {
                return { status, retryable: true, message: FAILURE_TEXT.serverError(status) };
            }
            return { status, retryable: true, message: FAILURE_TEXT.refused(status) };
        }
        if (/Connection refused/i.test(line)) {
            return { status: 'refused', retryable: false, message: FAILURE_TEXT.connectionRefused() };
        }
    }
    return null;
}

// 0174: what else in ffmpeg's last words means the provider (or the network to
// it) failed, beyond classifyInputFailure's HTTP statuses and refused connections.
const NETWORK_FAILURE_RE = /Connection timed out|Operation timed out|Connection reset by peer|Network is unreachable|No route to host|Failed to resolve hostname|Name or service not known|Input\/output error|I\/O error|Invalid data found when processing input|End of file/i;

/**
 * True when ffmpeg's stderr tail says the input failed for a provider reason
 * (multi-provider failover, 0174): an HTTP 4xx/5xx or refused connection
 * (classifyInputFailure), or a network error reading the stream. False for
 * everything else - an encoder, GPU or argument error is not the provider's.
 */
function providerFailureIn(lines) {
    if (!Array.isArray(lines)) return false;
    if (classifyInputFailure(lines)) return true;
    return lines.some(line => NETWORK_FAILURE_RE.test(String(line)));
}

/**
 * A one-variant master playlist whose only job is to carry VIDEO-RANGE and
 * FRAME-RATE, which a media playlist cannot. Without VIDEO-RANGE Apple's players
 * treat the stream as SDR and never switch the display to HDR, however the segments
 * themselves are tagged (0100); without FRAME-RATE, Match Frame Rate has nothing to
 * match, and a 25/50 fps channel plays on a 60 Hz display mode (0115).
 *
 * CODECS is left out on purpose. A wrong CODECS string makes AVPlayer refuse the
 * variant outright, and the exact one (HEVC tier, constraint flags, and whichever
 * audio codec the session ends up sending) is not known from the probe. Without it
 * the player reads the codecs from the init segment, as it does for stream.m3u8
 * today. BANDWIDTH is required by the spec and only an estimate here: with one
 * variant there is nothing for the player to choose between.
 */
function buildMasterPlaylist({ videoRange, width, height, fps }) {
    const attrs = [`BANDWIDTH=${height >= 2000 ? 25000000 : 8000000}`];
    if (width > 0 && height > 0) attrs.push(`RESOLUTION=${width}x${height}`);
    const rate = parseFrameRate(fps);
    if (rate !== null) attrs.push(`FRAME-RATE=${rate.toFixed(3)}`);
    attrs.push(`VIDEO-RANGE=${videoRange}`);
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXT-X-STREAM-INF:${attrs.join(',')}`,
        'stream.m3u8',
        ''
    ].join('\n');
}

module.exports = {
    TranscodeSession,
    buildMasterPlaylist,
    classifyInputFailure,
    providerFailureIn,
    REFUSED_RETRY_DELAYS_MS,
    paceArgs,
    readrateBurstSec,
    createSession,
    getSession,
    removeSession,
    cleanupStaleSessions,
    sweepOrphanedCache,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION,
    DTS_DELTA_THRESHOLD_SEC,
    // For the tuner (0126), which keeps the same window and idle rules.
    HLS_LIST_SIZE,
    HLS_DELETE_THRESHOLD,
    HLS_STALL_MS,
    LIVE_SESSION_TIMEOUT_MS,
    SESSION_TIMEOUT_MS,
    CLEANUP_INTERVAL_MS,
    ensureCacheDir
};
