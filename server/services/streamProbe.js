/**
 * Stream probing and playback strategy.
 *
 * Extracted from the probe route so the same decision can be made for any
 * client. A native client cannot reimplement the browser's strategy logic
 * sensibly, and should not have to: it tells the server what it can decode and
 * the server answers with something playable.
 */

const { spawn } = require('child_process');
const { redact } = require('../redact');

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

// How many of the probe's packets we look at to decide whether a feed's frame
// timing is even. 300 across all streams is roughly 150 video packets - three
// seconds at 50 fps, and far more than the signal needs (the two populations
// measured 33.8% uneven against 0.0%, with nothing in between).
const DTS_PROBE_PACKETS = 300;

// A step shorter than a quarter of the average frame period is degenerate, and
// more than one in twenty of them means the feed is uneven. Both are deliberately
// slack: they only have to separate 33.8% from 0.0%.
const DEGENERATE_FRACTION = 4;
const UNEVEN_THRESHOLD = 0.05;

/**
 * Does this feed's video arrive with even frame timing?
 *
 * The question decides whether ffmpeg should be told to ignore the source's DTS
 * (-fflags +igndts), and there is no answer that suits every feed:
 *
 *  - An EVEN feed has correct DTS. igndts throws it away, ffmpeg re-derives it
 *    from the PTS reorder buffer, and gets it wrong often enough to produce
 *    "Non-monotonic DTS" plus zero-length frames followed by double-length ones.
 *  - An UNEVEN feed arrives with a third of its steps near zero, because an
 *    upstream muxer already bumped repeated DTS by +1 rather than fixing them.
 *    Here igndts is the cure, and without it the same judder appears.
 *
 * 0085 applied igndts to every copy session, which fixed the second kind of feed
 * and broke the first. Measured on four of Mark's channels, both directions
 * reproduced, and the classification below predicted the outcome on all four.
 *
 * Note what is NOT counted: DTS that repeats or steps backwards. Those are the
 * obvious faults, and on real feeds they are already gone by the time we see the
 * stream - the provider's own muxer bumped them. The surviving evidence is the
 * near-zero step it left behind.
 *
 * @param {Array} packets  ffprobe -show_packets output
 * @returns {boolean|null} true = uneven (wants igndts), false = even, null = could not tell
 */
function classifyTimestamps(packets) {
    if (!Array.isArray(packets) || packets.length === 0) return null;

    const dts = [];
    for (const p of packets) {
        // stream_index 0 is video for every feed seen here; guard anyway, since a
        // misread would classify audio packet timing and answer confidently wrong.
        if (Number(p.stream_index) !== 0) continue;
        const d = Number(p.dts !== undefined ? p.dts : p.dts_time);
        if (Number.isFinite(d)) dts.push(d);
    }
    // Too short a run says nothing: a handful of packets at a channel join can look
    // like anything. Answering null leaves the caller on its safe default.
    if (dts.length < 20) return null;

    const steps = dts.slice(1).map((d, i) => d - dts[i]);
    // The MEAN frame period, not the most common one: when a third of the steps are
    // degenerate the mode lands on the degenerate value itself and everything then
    // compares clean against it. The mean stays anchored because the total span does.
    const mean = steps.reduce((t, s) => t + s, 0) / steps.length;
    if (!(mean > 0)) return null;

    const degenerate = steps.filter(s => s >= 0 && s < mean / DEGENERATE_FRACTION).length;
    return degenerate > steps.length * UNEVEN_THRESHOLD;
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
            // Packet timestamps, for classifyTimestamps above. Folded into THIS call
            // rather than a second ffprobe on purpose: the provider allows one
            // connection, so a separate probe would collide with this one. The packets
            // come out of bytes -probesize is already reading.
            //
            // -read_intervals bounds it. Without the bound, -show_packets on a live
            // feed never returns: the probe would hit its 15 s timeout and no channel
            // would play at all.
            '-show_packets',
            '-read_intervals', `%+#${DTS_PROBE_PACKETS}`,
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
                reject(new Error(`ffprobe exited with code ${code}: ${redact(stderr)}`));
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
 * The HLS VIDEO-RANGE an HDR feed needs, read off the video stream's transfer
 * characteristics: 'PQ' for HDR10 (smpte2084), 'HLG' for arib-std-b67, null for
 * SDR or anything unreported. Comes from the resolve probe's own -show_streams,
 * so it costs no extra provider connection.
 *
 * Why it matters: a copied HDR stream keeps its colour tagging all the way into
 * the fMP4 init segment (checked on a Sky Sports Main Event UHD capture: colr/nclx
 * with PQ + BT.2020, Main 10), yet tvOS never switched the panel to HDR. A media
 * playlist on its own carries no VIDEO-RANGE, and Apple's players treat a stream
 * without one as SDR - so an HDR session is fronted by a master playlist that says
 * so (TranscodeSession.getMasterPlaylist).
 */
function classifyVideoRange(videoStream) {
    const trc = (videoStream?.color_transfer || '').toLowerCase();
    if (trc === 'smpte2084') return 'PQ';
    if (trc === 'arib-std-b67') return 'HLG';
    return null;
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

    // A live channel arrives as an open-ended response, so ffprobe learns neither a size nor
    // a duration from it. A file served from the start (some providers do this for 24/7 or
    // on-demand "channels") reports at least one of them. Such a source ends, and it can be
    // read far faster than it plays - see paceInput in transcodeSession.
    const sizeBytes = Number(format.size);
    const seconds = Number(format.duration);
    const durationSec = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
    const finite = durationSec !== null || (Number.isFinite(sizeBytes) && sizeBytes > 0);

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
        finite: finite,
        durationSec: durationSec,
        // null when the packets could not be read or were too few to judge; the
        // callers treat that as "even", which is the majority case and the one
        // where guessing wrong is merely no better than before rather than worse.
        dtsUneven: classifyTimestamps(probeResult.packets),
        // 'PQ' / 'HLG' for an HDR feed, null otherwise - see classifyVideoRange.
        videoRange: classifyVideoRange(videoStream),
        fps: videoStream?.avg_frame_rate || null,
        subtitles: subtitles
    };
}


/**
 * The video and audio codec names /api/playback/resolve already found for this
 * URL, if that probe is still fresh - under any capability set, since the codecs
 * do not depend on who asked. Lets a caller that needs the codecs (the remux
 * route) reuse the answer instead of opening yet another connection to a
 * provider that may allow only one.
 */
function findCachedCodecs(url) {
    const prefix = `${url}|`;
    const now = Date.now();
    for (const [key, entry] of probeCache) {
        if (!key.startsWith(prefix)) continue;
        if (now - entry.timestamp >= CACHE_TTL) continue;
        const { video, audio, dtsUneven } = entry.result || {};
        // dtsUneven rides along: the remux route needs it for the same reason the
        // HLS path does, and it comes from the same probe at no extra cost.
        if (video || audio) return { video: video || null, audio: audio || null, dtsUneven: dtsUneven === true };
    }
    return null;
}

module.exports = {
    probeStream,
    analyzeProbeResult,
    classifyTimestamps,
    classifyVideoRange,
    probeCache,
    findCachedCodecs,
    CACHE_TTL,
    DTS_PROBE_PACKETS
};
