// #3: a copy session fed by a shared ingest, joined part-way through a feed, and where its first
// segment's audio and video start. The session's own arguments, read through pipe:0 the way
// stream-doctor's `bench --via-ingest` does; only 127.0.0.1 is ever contacted.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/**
 * Serve `file` once per path at the pace of `seconds` of media (bytes spread evenly over 40 ms
 * ticks), then end; a second connection to a path is refused (the feed ended).
 */
async function pacedServer(file, seconds) {
    const data = fs.readFileSync(file);
    const perTick = Math.ceil(data.length / (seconds * 1000 / 40));
    const served = new Set();
    const started = new Map(); // path -> when its first byte went out
    const server = http.createServer((req, res) => {
        if (served.has(req.url)) { res.writeHead(404); return res.end(); }
        served.add(req.url);
        started.set(req.url, Date.now());
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        let at = 0;
        const send = () => {
            if (res.destroyed) return clearInterval(timer);
            res.write(data.subarray(at, at + perTick));
            at += perTick;
            if (at >= data.length) { clearInterval(timer); res.end(); }
        };
        const timer = setInterval(send, 40);
        send();
        res.on('close', () => clearInterval(timer));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}`, started };
}

/** A copy session's arguments (fMP4 HLS, copy A/V), reading pipe:0 and writing into `outDir`. */
async function copySessionArgs(transcodeSession, outDir, codecs = { videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 }) {
    const session = await transcodeSession.createSession('http://provider.invalid/live/1.ts',
        { segmentType: 'fmp4', videoMode: 'copy', audioMode: 'copy', dtsUneven: false, ...codecs });
    const args = session.buildFFmpegArgs();
    const out = [];
    for (let i = 0; i < args.length; i++) {
        if (['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max'].includes(args[i])) { i++; continue; }
        if (args[i] === '-i') { out.push('-i', 'pipe:0'); i++; continue; }
        out.push(args[i]);
    }
    out[out.indexOf('-hls_segment_filename') + 1] = path.join(outDir, 'seg%04d.m4s');
    out[out.length - 1] = path.join(outDir, 'stream.m3u8');
    return out;
}

/** Run ffmpeg on `feed` (a Subscription) until the feed ends; resolves with its stderr. */
function runFed(feed, args, outDir) {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', args, { cwd: outDir, stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', d => { err += d; });
        proc.stdin.on('error', () => { /* exited first */ });
        feed.pipe(proc.stdin);
        proc.on('close', () => { feed.leave(); resolve(err); });
    });
}

/** The first segment's first audio and video PTS (seconds), as a player is given them (init + seg0000). */
function firstSegmentStarts(outDir) {
    const joined = path.join(outDir, 'first.mp4');
    fs.writeFileSync(joined, Buffer.concat(['init.mp4', 'seg0000.m4s'].map(f => fs.readFileSync(path.join(outDir, f)))));
    const csv = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time', '-of', 'csv=p=0', joined], { encoding: 'utf8' });
    const types = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type', '-of', 'csv=p=0', joined], { encoding: 'utf8' })
        .split(/\r?\n/).filter(Boolean).map(l => l.split(','));
    const kind = Object.fromEntries(types.map(([i, t]) => [i, t]));
    const first = {};
    for (const line of csv.split(/\r?\n/).filter(Boolean)) {
        const [index, pts] = line.split(',');
        const t = kind[index];
        const v = Number(pts);
        if (t && Number.isFinite(v) && (first[t] === undefined || v < first[t])) first[t] = v;
    }
    return { audio: first.audio ?? null, video: first.video ?? null };
}

module.exports = { pacedServer, copySessionArgs, runFed, firstSegmentStarts };
