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
 * - Session persistence for recovery after restart
 * - Automatic cleanup of stale sessions
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');

// Session storage
const sessions = new Map();

// Cache directory for transcoded segments
const CACHE_DIR = path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SEGMENT_DURATION = 4; // seconds per HLS segment
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

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

        this.status = 'starting';
        console.log(`[TranscodeSession ${this.id}] Starting session for: ${this.url}`);

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

        console.log(`[TranscodeSession ${this.id}] Command: ${this.options.ffmpegPath} ${args.join(' ')}`);

        try {
            this.process = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });

            this.status = 'running';
            this.timings.spawned = Date.now();

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
                            console.log(`[FFmpeg ${this.id}] ${line}`);
                            this.stderrTail.push(line.trim());
                            if (this.stderrTail.length > 20) this.stderrTail.shift();
                        }
                    });
                    stderrBuffer = lines[lines.length - 1];
                }
            });

            // Handle process exit
            this.process.on('exit', (code) => {
                if (code === 0 || code === null) {
                    console.log(`[TranscodeSession ${this.id}] FFmpeg completed successfully`);
                    this.status = 'stopped';
                } else if (code !== 255) { // 255 is often from SIGKILL
                    console.error(`[TranscodeSession ${this.id}] FFmpeg exited with code ${code}`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code}`;

                    // Hardware decode is the most likely thing to fail on an
                    // unusual driver, and it fails immediately rather than
                    // part-way through. If a session dies within a few seconds
                    // of starting, retry once with decode on the CPU before
                    // giving up, so a driver quirk degrades performance
                    // instead of breaking playback entirely.
                    const diedEarly = (Date.now() - this.startTime) < 10000;
                    if (diedEarly && this.options.vaapiHwDecode !== false && !this._triedSwDecode) {
                        this._triedSwDecode = true;
                        this.options.vaapiHwDecode = false;
                        console.warn(`[TranscodeSession ${this.id}] Retrying with software decode`);
                        this.process = null;
                        this.status = 'pending';
                        this.start().catch(err => {
                            console.error(`[TranscodeSession ${this.id}] Software decode retry failed:`, err.message);
                        });
                        return;
                    }
                }
                this.process = null;
                this.emit('exit', code);
            });

            // Handle spawn errors
            this.process.on('error', (err) => {
                console.error(`[TranscodeSession ${this.id}] FFmpeg error:`, err);
                this.status = 'error';
                this.error = err.message;
                this.emit('error', err);
            });

            // Save session metadata
            await this.persist();

        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
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

        // Input options (common)
        args.push(
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3'
        );

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
        // HE-AAC cannot be passed through to a browser (see probe.js), so it is
        // excluded from every copy path here even though it is stereo AAC.
        const audioProfile = (this.options.audioProfile || '').toLowerCase();
        const isHeAac = this.options.isHeAac === true || audioProfile.includes('he-aac');
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2 && !isHeAac;

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

        if (this.options.audioMode === 'copy' && !isHeAac) {
            // Caller (playbackStrategy) has already established via client
            // capabilities that this audio codec plays as-is and wants it
            // copied through untouched — the same guarantee a plain remux
            // gives, just inside an HLS session instead of a piped
            // response. This intentionally bypasses audioMixPreset, which
            // exists to pick a *downmix*, a question that doesn't apply
            // when nothing needs mixing in the first place.
            console.log(`[TranscodeSession ${this.id}] Audio: Copy (client capabilities confirm ${audioCodec} support)`);
            pushAudioCopy();
        } else if (audioMixPreset === 'passthrough' && !isHeAac) {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            pushAudioCopy();
        } else if (isHeAac) {
            // Re-encode to AAC-LC. Only the audio is touched, so this stays
            // cheap even when the video is being stream-copied.
            console.log(`[TranscodeSession ${this.id}] Audio: HE-AAC source -> AAC-LC (browser cannot decode HE-AAC)`);
            args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-b:a', '128k');
        } else if (audioMixPreset === 'auto' && isStereoAac) {
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
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', '0', // Keep all segments in playlist
            '-hls_flags', 'independent_segments+append_list'
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

        this.status = 'stopped';

        if (!this.process) {
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
    async waitForPlaylist(timeoutMs = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (await this.isPlaylistReady()) {
                this.timings.playlistReady = Date.now();
                return true;
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
        console.error(`[TranscodeSession ${this.id}] Playlist not ready after ${timeoutMs}ms`);
        console.error(`[TranscodeSession ${this.id}]   created -> spawned: ${since(t.created, t.spawned)}`);
        console.error(`[TranscodeSession ${this.id}]   spawned -> first ffmpeg output: ${since(t.spawned, t.firstOutput)}`);
        if (this.stderrTail.length) {
            console.error(`[TranscodeSession ${this.id}] Last ffmpeg output:`);
            this.stderrTail.forEach(line => console.error(`[TranscodeSession ${this.id}] ${line}`));
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
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        const segmentPath = path.join(this.dir, segmentName);
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Save session metadata to disk for recovery
     */
    async persist() {
        const metadata = {
            id: this.id,
            url: this.url,
            status: this.status,
            startTime: this.startTime,
            lastAccess: this.lastAccess,
            options: this.options,
            seekOffset: this.options.seekOffset
        };
        const metaPath = path.join(this.dir, 'session.json');
        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Restore a session from disk metadata
     */
    static async restore(sessionDir) {
        const metaPath = path.join(sessionDir, 'session.json');
        try {
            const data = await fs.readFile(metaPath, 'utf8');
            const metadata = JSON.parse(data);
            const session = new TranscodeSession(metadata.url, metadata.options);
            session.id = metadata.id;
            session.dir = sessionDir;
            session.playlistPath = path.join(sessionDir, 'stream.m3u8');
            session.startTime = metadata.startTime;
            session.lastAccess = metadata.lastAccess;
            session.status = 'stopped'; // Not running after restart
            return session;
        } catch (err) {
            console.error(`Failed to restore session from ${sessionDir}:`, err.message);
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
 * Get or create a session for a URL (reuses existing if still valid)
 */
async function getOrCreateSession(url, options = {}) {
    // Check for existing session with same URL
    for (const session of sessions.values()) {
        if (session.url === url && session.status === 'running') {
            session.touch();
            return session;
        }
    }
    // Create new session
    return createSession(url, options);
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
        if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            await removeSession(id);
        }
    }
}

/**
 * Recover sessions from disk after server restart
 */
async function recoverSessions() {
    try {
        await fs.access(CACHE_DIR);
        const dirs = await fs.readdir(CACHE_DIR, { withFileTypes: true });

        for (const dirent of dirs) {
            if (dirent.isDirectory()) {
                const sessionDir = path.join(CACHE_DIR, dirent.name);
                const session = await TranscodeSession.restore(sessionDir);
                if (session) {
                    sessions.set(session.id, session);
                    console.log(`[TranscodeSession] Recovered session ${session.id}`);
                }
            }
        }
    } catch (err) {
        // Cache dir doesn't exist yet, that's fine
        if (err.code !== 'ENOENT') {
            console.error('[TranscodeSession] Error recovering sessions:', err.message);
        }
    }
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
        idleMs: Date.now() - s.lastAccess
    }));
}

module.exports = {
    TranscodeSession,
    createSession,
    getSession,
    getOrCreateSession,
    removeSession,
    cleanupStaleSessions,
    recoverSessions,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION
};
