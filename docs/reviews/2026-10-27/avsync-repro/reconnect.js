#!/usr/bin/env node
// Offline FR-22: a mid-packet cut and an 11+ second jump, through the real strategy,
// ingest, session, relay and HTTP playlist route. All media/results stay OUTSIDE the repo.
// node reconnect.js /path/to/fox.ts /private/tmp/reconnect-after [--baseline] [--no-player]
// For before/after, stash only the server source changes, run --baseline, restore, run again.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [sampleArg, outputArg] = process.argv.slice(2);
if (!sampleArg || !outputArg) throw new Error('Expected sample.ts and output directory outside the repo');
const repo = path.resolve(__dirname, '../../../..');
const sample = path.resolve(sampleArg), output = path.resolve(outputArg);
if (output === repo || output.startsWith(repo + path.sep)) throw new Error('Keep broadcast media outside the repository');
fs.mkdirSync(output, { recursive: true });
function run(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
    if (result.status !== 0) throw new Error(`${cmd} failed: ${(result.stderr || '').slice(-2000)}`);
    return result.stdout;
}
const packets = JSON.parse(run('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts_time,pos,flags', '-of', 'json', sample])).packets;
const first = Number(packets[0].pts_time);
const cutPacket = packets.find(p => Number(p.pts_time) >= first + 18);
const resumePacket = packets.find(p => Number(p.pts_time) >= first + 29 && p.flags.includes('K'));
if (!cutPacket || !resumePacket) throw new Error('Need a sample with at least 32 seconds and keyframes');
const data = fs.readFileSync(sample);
const cut = Number(cutPacket.pos) + 73; // deliberately inside a TS packet
let resume = Number(resumePacket.pos);
// Include the PAT preceding the resumed keyframe, as a new provider connection does.
for (let i = resume; i >= Math.max(0, resume - 188 * 3000); i -= 188) {
    if (data[i] === 0x47 && (data[i + 1] & 0x40) && (data[i + 1] & 0x1f) === 0 && data[i + 2] === 0) { resume = i; break; }
}
fs.writeFileSync(path.join(output, 'splice.ts'), Buffer.concat([data.subarray(0, cut), data.subarray(resume)]));
fs.writeFileSync(path.join(output, 'splice.json'), JSON.stringify({ cut, resume, cutTime: Number(cutPacket.pts_time) - first,
    resumeTime: Number(resumePacket.pts_time) - first, sampleBytes: data.length }, null, 2));
const env = { ...process.env, RIG_SAMPLE: sample, RIG_OUTPUT: output, RIG_CUT_BYTE: String(cut), RIG_RESUME_BYTE: String(resume),
    RIG_SECONDS: process.env.RIG_SECONDS || '48' };
if (!process.argv.includes('--no-player')) {
    const player = path.join(output, 'avsync');
    run('swiftc', ['-O', '-swift-version', '5', path.join(__dirname, 'avsync.swift'), '-o', player]);
    env.RIG_AVPLAYER = player;
}
const rig = spawnSync(process.execPath, [path.join(repo, 'scripts/relay-rig.js'), 'reconnect'],
    { env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
fs.writeFileSync(path.join(output, 'rig.log'), (rig.stdout || '') + (rig.stderr || ''));
if (rig.status !== 0) throw new Error(`Rig failed; see ${output}/rig.log`);
const durations = [], timings = [];
for (const leg of fs.readdirSync(output).filter(n => /^leg\d+$/.test(n)).sort()) {
    const dir = path.join(output, leg);
    const playlist = fs.readFileSync(path.join(dir, 'stream.m3u8'), 'utf8');
    for (const m of playlist.matchAll(/#EXTINF:([\d.]+),\n([^\n]+)/g)) {
        const duration = Number(m[1]), name = m[2]; durations.push(duration);
        const seg = path.join(dir, name);
        let input = seg;
        if (name.endsWith('.m4s')) {
            input = path.join(output, 'probe.mp4');
            fs.writeFileSync(input, Buffer.concat([fs.readFileSync(path.join(dir, 'init.mp4')), fs.readFileSync(seg)]));
        }
        const ps = JSON.parse(run('ffprobe', ['-v', 'quiet', '-show_packets', '-show_entries', 'packet=codec_type,pts_time,dts_time', '-of', 'json', input])).packets;
        const track = kind => ps.filter(p => p.codec_type === kind).map(p => Number(p.dts_time)).filter(Number.isFinite);
        const v = track('video'), a = track('audio');
        const gap = ts => ts.slice(1).reduce((max, t, i) => Math.max(max, t - ts[i]), 0);
        timings.push({ leg, name, duration, videoStart: Number(ps.find(p => p.codec_type === 'video')?.pts_time), audioStart: Number(ps.find(p => p.codec_type === 'audio')?.pts_time), maxVideoStep: gap(v), maxAudioStep: gap(a) });
    }
}
const playlist = fs.readFileSync(path.join(output, 'stream.m3u8'), 'utf8');
const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
const report = { ...result, discontinuities: (playlist.match(/#EXT-X-DISCONTINUITY\n/g) || []).length,
    maxDuration: Math.max(...durations), maxVideoStep: Math.max(...timings.map(t => t.maxVideoStep)), maxAudioStep: Math.max(...timings.map(t => t.maxAudioStep)),
    tinyRuns: durations.filter((d, i) => d < 1 && durations[i + 1] < 1).length, timings };
fs.writeFileSync(path.join(output, 'timings.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!process.argv.includes('--baseline') && (report.discontinuities !== 1 || report.connections !== 2 || report.maxDuration > 8 || report.maxVideoStep > 1 || report.maxAudioStep > 1 || report.tinyRuns)) {
    throw new Error('Reconnect timeline criteria failed; inspect timings.json and rig.log');
}
