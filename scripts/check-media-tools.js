#!/usr/bin/env node
// Release + capability gate: a binary being present is not enough (hardware filters
// can silently disappear at configure time). No provider, GPU or server is opened.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = fs.readFileSync(path.join(__dirname, '../docker/media-toolchain.conf'), 'utf8');
const release = /^FFMPEG_RELEASE=([\d.]+)$/m.exec(config)[1];
const args = process.argv.slice(2);
const ffmpeg = args.find(a => a.startsWith('--ffmpeg='))?.slice(9) || 'ffmpeg';
const ffprobe = args.find(a => a.startsWith('--ffprobe='))?.slice(10) || 'ffprobe';
function query(binary, options) {
    const r = spawnSync(binary, options, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`${path.basename(binary)} failed: ${r.error?.code || r.status}`);
    return r.stdout;
}
function requireNames(text, names, label) {
    const words = new Set(text.split(/[\s,]+/));
    const missing = names.filter(n => !words.has(n));
    if (missing.length) throw new Error(`Missing ${label}: ${missing.join(', ')}`);
}
try {
    for (const [tool, binary] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
        const banner = query(binary, ['-version']).split('\n')[0];
        const version = new RegExp(`^${tool} version n?${release.replaceAll('.', '\\.')}($|[ +\\-])`);
        if (!version.test(banner)) throw new Error(`Expected ${tool} ${release}, got ${banner}`);
        console.log(banner);
    }
    const encoders = query(ffmpeg, ['-hide_banner', '-encoders']);
    const filters = query(ffmpeg, ['-hide_banner', '-filters']);
    requireNames(encoders, ['libx264', 'libx265', 'aac', 'libmp3lame'], 'software encoders');
    requireNames(query(ffmpeg, ['-hide_banner', '-decoders']), ['h264', 'hevc', 'aac', 'ac3', 'eac3'], 'decoders');
    requireNames(query(ffmpeg, ['-hide_banner', '-protocols']), ['http', 'https', 'tcp', 'udp', 'rtp'], 'protocols');
    requireNames(filters, ['scale', 'bwdif', 'yadif', 'aresample'], 'filters');
    if (args.includes('--hardware')) {
        requireNames(query(ffmpeg, ['-buildconf']), ['--enable-libvpl', '--enable-libdav1d', '--enable-libxml2', '--enable-iconv'], 'production build features');
        requireNames(query(ffmpeg, ['-hide_banner', '-decoders']), ['h264_cuvid', 'hevc_cuvid', 'libdav1d'], 'production decoders');
        requireNames(query(ffmpeg, ['-hide_banner', '-demuxers']), ['dash', 'hls', 'mov', 'mpegts'], 'production demuxers');
        requireNames(encoders, ['h264_vaapi', 'hevc_vaapi', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv'], 'hardware encoders');
        requireNames(filters, ['scale_vaapi', 'scale_cuda', 'scale_qsv', 'hwupload', 'hwdownload'], 'hardware filters');
        requireNames(query(ffmpeg, ['-hide_banner', '-protocols']), ['srt'], 'production protocols');
    }
    console.log(`Media toolchain ${release}: capabilities OK${args.includes('--hardware') ? ' (compiled hardware support; device execution still needs a GPU)' : ''}`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
