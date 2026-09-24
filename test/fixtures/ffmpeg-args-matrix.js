// The option sets the ffmpeg-argument equality test (test/tuner-args.test.js) runs
// through TranscodeSession.buildFFmpegArgs. ffmpeg-args-golden.json holds the
// arguments the builder produced for each of them BEFORE the tuner refactor (0126),
// generated from the 0125 code; the test proves the refactored builder still
// produces exactly those, token for token.
const URL_ = 'http://provider.invalid/live/u/p/441372.ts';

function matrix() {
    const out = [];
    const base = { userAgent: 'UA/1.0', ffmpegPath: 'ffmpeg' };
    // Stream copies: every segment type, video codec, audio shape and timing class.
    for (const segmentType of ['fmp4', 'mpegts']) {
        for (const videoCodec of ['h264', 'hevc', 'mpeg2video']) {
            for (const audio of [
                { audioCodec: 'aac', audioChannels: 2 },
                { audioCodec: 'aac', audioChannels: 2, audioProfile: 'HE-AAC', isHeAac: true },
                { audioCodec: 'aac', audioChannels: 2, audioProfile: 'HE-AAC', isHeAac: true, heaacCopy: true },
                { audioCodec: 'ac3', audioChannels: 6 },
                { audioCodec: 'eac3', audioChannels: 6, audioMode: 'copy' },
                { audioCodec: 'mp2', audioChannels: 2, audioMixPreset: 'night' },
                { audioCodec: 'aac', audioChannels: 2, audioMode: 'encode' },
                { audioCodec: 'aac', audioChannels: 2, audioMixPreset: 'passthrough' }
            ]) {
                for (const dtsUneven of [false, true]) {
                    out.push({ ...base, segmentType, videoMode: 'copy', videoCodec, dtsUneven, ...audio });
                }
            }
        }
    }
    // Pacing and seek.
    out.push({ ...base, segmentType: 'fmp4', videoMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, paceInput: true });
    out.push({ ...base, segmentType: 'mpegts', videoMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, seekOffset: 30 });
    // Encodes: every encoder and the VAAPI variants, quality and scaling options.
    for (const hwEncoder of ['software', 'nvenc', 'qsv', 'amf', 'vaapi']) {
        for (const extra of [
            {},
            { quality: 'high', maxResolution: '720p' },
            { upscaleEnabled: true, upscaleTarget: '4k', upscaleMethod: 'software' },
            { upscaleEnabled: true, upscaleTarget: '1080p', upscaleMethod: 'hardware' },
            { vaapiCpuScale: false },
            { vaapiHwDecode: false },
            { vaapiCpuScale: false, vaapiHwDecode: false }
        ]) {
            out.push({ ...base, segmentType: 'mpegts', videoMode: 'encode', hwEncoder, videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6, ...extra });
        }
    }
    return out;
}

module.exports = { URL_, matrix, SESSION_DIR: '/fixed/session-dir' };
