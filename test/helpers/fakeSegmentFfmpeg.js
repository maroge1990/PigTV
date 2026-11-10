// A fake ffmpeg for segmented recordings, and the stand-ins around it. Test files only.
//
// Usage (recording-segments.test.js is the worked example; load the engine from the sandbox copy):
//   const fake = createFakeSegmentFfmpeg(sandbox);                  // a node script that behaves like ffmpeg
//   engine.init({ ffmpegPath: fake.path, ffprobePath: ... });
//   const remuxed = stubNativeTools(engine);                         // the remux and checks a segmented finish needs
//   fake.setBehaviour(url, 'dies');                                  // 'ok' (default) | 'dies' | 'ends-once' | 'refuses'
//   await until(engine, () => fake.captures().length === 1, 'a capture');
//   ... afterEach: await drainSegmentQueue(segments, recordings); fake.reset(); remuxed.length = 0;
//
// As a capture (-f hls) it writes MPEG-TS segments a000000.ts... and an event playlist (archive.m3u8) like ffmpeg's;
// "q" on stdin ends the playlist and exits 1 with a provider-looking error (a requested stop taken for a failure would
// show). As the watch-copy follower (-live_start_index) it writes init.mp4 and .m4s pieces; behaviour key
// `follower: 'dies-after-3'` makes it exit 1 after three. Without -f hls it is today's single growing .ts file.

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Write the fake ffmpeg into `sandbox` and return its handle.
 *   path             the executable, for engine.init({ ffmpegPath })
 *   setBehaviour     (inputUrl, kind): 'ok' | 'dies' (reset by peer after 400 ms) | 'ends-once' (first capture ends by itself after 400 ms)
 *                    | 'refuses' (#284: exits 1 at once with an HTTP 502, writing nothing)
 *                    | 'stall' (one segment, then nothing until "q")
 *   behaviour        the url -> kind map (written through to the script; edit via setBehaviour)
 *   starts           () every argument array ffmpeg was started with, oldest first
 *   captures         () the starts that are captures (not watch-copy followers)
 *   reset            () forget behaviours, starts and the ends-once marker (call in afterEach)
 */
function createFakeSegmentFfmpeg(sandbox) {
    const behaviourFile = path.join(sandbox, 'ffmpeg-behaviour.json');
    const startsFile = path.join(sandbox, 'ffmpeg-starts.log');
    const endedMarker = path.join(sandbox, 'ffmpeg-ended-once');
    const behaviour = {};
    const setBehaviour = (u, kind) => { behaviour[u] = kind; fs.writeFileSync(behaviourFile, JSON.stringify(behaviour)); };
    const file = path.join(sandbox, 'ffmpeg-fake');
    fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const out = args[args.length - 1];
// #150: playlists are replaced whole, as ffmpeg's temp_file does (a temporary file renamed into place): a plain
// rewrite empties the file first, and a reader caught there saw no segments ("cannot be watched while it records").
const putPlaylist = (text) => { fs.writeFileSync(out + '.tmp', text); fs.renameSync(out + '.tmp', out); };
fs.appendFileSync(${JSON.stringify(startsFile)}, JSON.stringify(args) + '\\n');
if (args.includes('-live_start_index')) {
  // The watch copy: one piece per archive segment from -live_start_index, named as asked (-hls_segment_filename,
  // -hls_fmp4_init_filename), ended when the archive is. #34: behaviour "follower" = "dies-after-3" exits 1 after three.
  const dir = path.dirname(out);
  const from = Number(args[args.indexOf('-live_start_index') + 1]) || 0;
  const initName = args[args.indexOf('-hls_fmp4_init_filename') + 1];
  const segPattern = path.basename(args[args.indexOf('-hls_segment_filename') + 1]);
  let behave = {};
  try { behave = JSON.parse(fs.readFileSync(${JSON.stringify(behaviourFile)}, 'utf8')); } catch (e) {}
  let made = 0;
  const pieces = () => {
    const text = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '';
    const listed = text.match(/^a\\d+\\.ts$/mg) || [];
    const n = listed.length;
    fs.writeFileSync(path.join(dir, initName), 'init:' + initName);
    let pl = '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n#EXT-X-MAP:URI="' + initName + '"\\n';
    for (let i = 0; i < Math.max(0, n - from); i++) {
      if (behave.follower === 'dies-after-3' && i >= 3) { putPlaylist(pl); process.exit(1); }
      const name = segPattern.replace('%06d', String(i).padStart(6, '0'));
      if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), 'copy of ' + listed[from + i]);
      pl += '#EXTINF:4.000000,\\n' + name + '\\n';
    }
    if (text.includes('#EXT-X-ENDLIST')) { putPlaylist(pl + '#EXT-X-ENDLIST\\n'); process.exit(0); }
    putPlaylist(pl);
  };
  pieces();
  setInterval(pieces, 40);
  return;
}
let map = {};
try { map = JSON.parse(fs.readFileSync(${JSON.stringify(behaviourFile)}, 'utf8')); } catch (e) {}
const kind = map[input] || 'ok';
// #284: the provider refuses at the start (an HTTP 502): nothing is written.
if (kind === 'refuses') {
  process.stderr.write('[http @ 0x1] HTTP error 502 Bad Gateway\\nError opening input: Server returned 502 Bad Gateway\\n');
  process.exit(1);
}
if (args.includes('hls')) {
  const dir = path.dirname(out);
  let n = 0;
  let pl = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n';
  const segment = () => {
    const name = 'a' + String(n++).padStart(6, '0') + '.ts';
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(3000));
    pl += '#EXTINF:4.000000,\\n' + name + '\\n';
    putPlaylist(pl);
  };
  segment();
  // 'stall': one segment, then nothing (the provider went silent without closing); it still answers "q".
  if (kind === 'stall') setInterval(() => {}, 1000);
  else setInterval(segment, 60);
  process.stdin.on('data', (d) => {
    if (!String(d).includes('q')) return;
    putPlaylist(pl + '#EXT-X-ENDLIST\\n');
    process.stderr.write('[tcp @ 0x1] Connection reset by peer\\n');
    process.exit(1);
  });
  // #260: the São Paulo GP's capture ended by itself mid-race, with nothing that looks like the provider's fault.
  const endedMarker = ${JSON.stringify(endedMarker)};
  if (kind === 'ends-once' && !fs.existsSync(endedMarker)) setTimeout(() => {
    fs.writeFileSync(endedMarker, '1');
    putPlaylist(pl + '#EXT-X-ENDLIST\\n');
    process.exit(0);
  }, 400);
  if (kind === 'dies') setTimeout(() => {
    process.stderr.write('[tcp @ 0x1] Connection reset by peer\\nError during demuxing: Connection reset by peer\\n');
    process.exit(1);
  }, 400);
  return;
}
// Today's capture: one growing .ts file.
fs.writeFileSync(out, Buffer.alloc(4000));
setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(0); });
`);
    fs.chmodSync(file, 0o755);
    const starts = () => (fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const captures = () => starts().filter(a => !a.includes('-live_start_index'));
    const reset = () => {
        for (const k of Object.keys(behaviour)) delete behaviour[k];
        fs.writeFileSync(behaviourFile, '{}');
        for (const f of [startsFile, endedMarker]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    };
    return { path: file, setBehaviour, behaviour, starts, captures, reset };
}

/**
 * Stand in for the remux and the preparation checks (engine._nativeTools): codecs hevc/aac, 120 s, no audio errors, and
 * the remux writes its output (5000 bytes). Returns the array of remux argument lists, one per remux run.
 */
function stubNativeTools(engine) {
    const remuxed = [];
    engine._nativeTools.codecs = async () => ({ video: 'hevc', audio: 'aac', audioChannels: 2 });
    engine._nativeTools.duration = async () => 120;
    engine._nativeTools.audioErrors = async () => 0;
    engine._nativeTools.ffmpeg = async (args) => {
        remuxed.push(args);
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000));
        return { code: 0, tail: [] };
    };
    return remuxed;
}

/** Run the segment queue until no recording has work left (finished or moved): what a test does before the next one starts. */
async function drainSegmentQueue(segments, recordings) {
    for (let i = 0; i < 200 && recordings.findSegmentWork().length; i++) {
        await segments.processQueue(Date.now() + 3600e3);
        await sleep(25);
    }
}

/** Poll `cond` (ticking the engine each round) until true; fails the test with `label` after `ms`. */
async function until(engine, cond, label, ms = 8000) {
    const assert = require('node:assert/strict');
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await engine.tick();
        await sleep(40);
    }
    assert.fail(`timed out waiting for: ${label}`);
}

module.exports = { createFakeSegmentFfmpeg, stubNativeTools, drainSegmentQueue, until };
