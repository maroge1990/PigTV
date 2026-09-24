// A stand-in for a tuner's ffmpeg (0126-0129 tests): node running a small script in
// the tuner's directory that writes what ffmpeg's hls muxer writes there - an init
// segment, a segment every `everyMs`, and a rolling playlist (ffmpeg.m3u8, written
// to a .tmp and renamed, as with -hls_flags temp_file). No real media.
//
// Used as tuner.hooks.spawnArgs = (t) => fakeHlsArgs({...}); the tuner then spawns
// process.execPath with these arguments (its ffmpegPath is process.execPath).

function fakeHlsScript({ ext = 'm4s', everyMs = 100, duration = 4, listSize = 30, stopAfter = Infinity, endAfter = Infinity } = {}) {
    return `
const fs = require('fs');
const ext = ${JSON.stringify(ext)};
const list = [];
let n = 0;
if (ext === 'm4s') fs.writeFileSync('init.mp4', 'init-segment');
const timer = setInterval(() => {
    if (n >= ${Number.isFinite(stopAfter) ? stopAfter : 'Infinity'}) return; // alive, silent: a stalled upstream
    const name = 'seg' + String(n).padStart(4, '0') + '.' + ext;
    fs.writeFileSync(name, 'segment-' + n + '-' + 'x'.repeat(200));
    list.push(name);
    if (list.length > ${listSize}) list.shift();
    const first = n - list.length + 1;
    let text = '#EXTM3U\\n#EXT-X-VERSION:' + (ext === 'm4s' ? 7 : 3) + '\\n#EXT-X-TARGETDURATION:${Math.round(duration)}\\n#EXT-X-MEDIA-SEQUENCE:' + first + '\\n';
    if (ext === 'm4s') text += '#EXT-X-MAP:URI="init.mp4"\\n';
    for (const l of list) text += '#EXTINF:${duration.toFixed(6)},\\n' + l + '\\n';
    n++;
    const ended = n >= ${Number.isFinite(endAfter) ? endAfter : 'Infinity'};
    if (ended) text += '#EXT-X-ENDLIST\\n';
    fs.writeFileSync('ffmpeg.m3u8.tmp', text);
    fs.renameSync('ffmpeg.m3u8.tmp', 'ffmpeg.m3u8');
    if (ended) { clearInterval(timer); process.exit(0); }
}, ${everyMs});
process.on('SIGTERM', () => process.exit(255));
`;
}

function fakeHlsArgs(opts) {
    return ['-e', fakeHlsScript(opts)];
}

module.exports = { fakeHlsScript, fakeHlsArgs };
