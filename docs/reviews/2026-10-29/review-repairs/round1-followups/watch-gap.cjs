// Offline N3 capture, before any timestamp-handling change. Usage: node <this> /tmp/output
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../../..');
const segments = require(path.join(root, 'server/services/recordingSegments'));
const out = path.resolve(process.argv[2]);
if (out === root || out.startsWith(root + path.sep)) throw Error('Keep media outside the repository');
fs.mkdirSync(out, { recursive: true });
function ff(args, label) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], { encoding: 'utf8', timeout: 60000 });
    fs.writeFileSync(path.join(out, label + '.log'), r.stderr || '');
    if (r.status !== 0) throw Error(label + ' failed: ' + r.status);
}
// One epoch, source video and audio advance together by five seconds at t=6.
// Below the MPEG-TS demuxer's default 10 s discontinuity correction threshold.
ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-vf', 'setpts=PTS+gte(T\\,6)*5/TB', '-af', 'asetpts=PTS+gte(T\\,6)*5/TB',
    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '25',
    '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(out, 'a%06d.ts'), path.join(out, 'archive.m3u8')], 'archive');
ff(segments.viewArgs(out, { video: 'h264', audio: 'aac', audioChannels: 1 }), 'watch');
function clocks(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,duration_time:stream=index,codec_type',
        '-of', 'json', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.status) throw Error('probe failed');
    const d = JSON.parse(r.stdout), result = {};
    for (const stream of d.streams) {
        const packets = d.packets.filter(p => p.stream_index === stream.index).map(p => ({ pts: +p.pts_time, duration: +p.duration_time || 0 }));
        const steps = packets.slice(1).map((p, i) => p.pts - packets[i].pts).filter(n => n > 0).sort((a, b) => a - b);
        const nominal = steps[Math.floor(steps.length / 2)];
        const jumps = [];
        for (let i = 1; i < packets.length; i++) {
            const gap = packets[i].pts - packets[i - 1].pts - nominal;
            if (Math.abs(gap) > 0.1) jumps.push({ at: packets[i].pts, gap });
        }
        result[stream.codec_type] = { first: packets[0].pts, end: packets.at(-1).pts + packets.at(-1).duration, jumps };
    }
    result.postJumpSkewSec = result.audio.jumps[0].at - result.video.jumps[0].at;
    result.startSkewSec = result.audio.first - result.video.first;
    result.endSkewSec = result.audio.end - result.video.end;
    return result;
}
const result = { archive: clocks(path.join(out, 'archive.m3u8')), watch: clocks(path.join(out, 'view.m3u8')) };
fs.writeFileSync(path.join(out, 'clocks.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
