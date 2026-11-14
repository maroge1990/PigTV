// #324: small MPEG-TS feeds made with the real ffmpeg (320x180, 25 fps, H.264 key frame every 1 s, AAC), for the
// looping-feed detector: a clip looped with fresh timestamps (`-stream_loop` with `-c copy` rebases each pass, as
// the provider did), a moving feed, still slates, a looping picture over live sound or over silence, and one pass of
// the clip a period later (a resend with fresh timestamps), and the clip aired twice then other programming. Made
// once into `dir`; callers skip without libx264.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const haveFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') === true;

const VIDEO = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-b:v', '300k'];
const AUDIO = ['-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '2'];
const moving = (sec) => ['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${sec}`];
const noise = (sec, seed) => ['-f', 'lavfi', '-i', `anoisesrc=seed=${seed}:amplitude=0.2:sample_rate=48000:duration=${sec}`];
const silence = (sec) => ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(sec)];

function ffmpeg(args) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** Make the feeds (once) and return their paths. `clipSec` is the loop's period. */
function makeFeeds(dir, { clipSec = 24, passes = 4 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const f = (name) => path.join(dir, name);
    const total = clipSec * passes;
    const feeds = {
        clip: f('clip.ts'), loop: f('loop.ts'), live: f('live.ts'), slate: f('slate.ts'), slateLongGop: f('slate-long-gop.ts'),
        loopLiveSound: f('loop-live-sound.ts'), loopSilent: f('loop-silent.ts'), clipVideo: f('clip-video.ts'), shifted: f('shifted.ts'), shifted2: f('shifted2.ts'), twiceThenLive: f('twice-then-live.ts'), clipSec, total
    };
    if (fs.existsSync(feeds.twiceThenLive)) return feeds;
    ffmpeg([...moving(clipSec), ...noise(clipSec, 1), ...VIDEO, ...AUDIO, '-f', 'mpegts', feeds.clip]);
    ffmpeg(['-stream_loop', String(passes - 1), '-i', feeds.clip, '-c', 'copy', '-f', 'mpegts', feeds.loop]);
    // The clip again as its next pass would come: the same payloads, timestamps one period later.
    ffmpeg(['-i', feeds.clip, '-c', 'copy', '-output_ts_offset', String(clipSec), '-f', 'mpegts', feeds.shifted]);
    ffmpeg(['-i', feeds.clip, '-c', 'copy', '-output_ts_offset', String(2 * clipSec), '-f', 'mpegts', feeds.shifted2]);
    ffmpeg([...moving(total), ...noise(total, 2), ...VIDEO, ...AUDIO, '-f', 'mpegts', feeds.live]);
    // The clip aired twice in a row (fresh timestamps), then other programming (the test pattern from 300 s on).
    const after = f('after.ts');
    ffmpeg(['-ss', '300', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${300 + total}`, ...noise(total, 4), '-t', String(total),
        ...VIDEO, ...AUDIO, '-output_ts_offset', String(2 * clipSec), '-f', 'mpegts', after]);
    fs.writeFileSync(feeds.twiceThenLive, Buffer.concat([feeds.clip, feeds.shifted, after].map(x => fs.readFileSync(x))));
    // A still picture (colour bars), silent: every group of pictures encodes the same.
    ffmpeg(['-f', 'lavfi', '-i', `smptebars=size=320x180:rate=25:duration=${total}`, ...silence(total), ...VIDEO, ...AUDIO, '-f', 'mpegts', feeds.slate]);
    ffmpeg(['-f', 'lavfi', '-i', `smptebars=size=320x180:rate=25:duration=${total}`, ...silence(total),
        ...VIDEO.map(a => (a === '25' ? '300' : a)), ...AUDIO, '-f', 'mpegts', feeds.slateLongGop]);
    // The clip's picture only, looped under sound that goes on (live) or is silence.
    ffmpeg([...moving(clipSec), ...VIDEO, '-an', '-f', 'mpegts', feeds.clipVideo]);
    ffmpeg(['-stream_loop', String(passes - 1), '-i', feeds.clipVideo, ...noise(total, 3), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...AUDIO,
        '-t', String(total), '-f', 'mpegts', feeds.loopLiveSound]);
    ffmpeg(['-stream_loop', String(passes - 1), '-i', feeds.clipVideo, ...silence(total), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...AUDIO,
        '-f', 'mpegts', feeds.loopSilent]);
    return feeds;
}

module.exports = { haveFfmpeg, makeFeeds };
