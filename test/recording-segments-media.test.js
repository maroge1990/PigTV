const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

// R3 (Wave 4): segmented recordings with the REAL ffmpeg - the server's own argument builders
// (recordingSegments.captureArgs / viewArgs, recordingMedia.buildNativeRemuxArgs) against a local
// sample served over HTTP like a provider. A capture killed mid-way, a second run that continues
// the timeline, the Apple TV's watch copy of both, and the final MP4 checked the way preparation
// checks it. Skips without ffmpeg. HEVC where supported; HE-AAC comes from the synthetic fixture on every OS.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const encoders = hasFfmpeg ? spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout : '';
const hevc = /libx265/.test(encoders);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-segments-media-'));
const segments = require('../server/services/recordingSegments');
const media = require('../server/services/recordingMedia');
const { parseMediaPlaylist } = require('../server/services/hlsPlaylist');
segments._setWorkRoot(path.join(sandbox, 'work'));

const sample = path.join(sandbox, 'sample.ts');
let server;
let base;
let throttle = 0; // ms between 32 KB chunks; 0 = as fast as possible

function probe(file, entries) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' });
    return JSON.parse(r.stdout || '{}');
}
const run = (args) => new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, err }));
});
const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
};

before(async () => {
    if (!hasFfmpeg) return;
    // 12 s, 50 fps, HDR10-tagged; HEVC Main 10 where libx265 exists, else H.264. HE-AAC from the same looped synthetic fixture on every OS.
    const video = hevc
        ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
            '-x265-params', 'keyint=50:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc'];
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=50',
        '-stream_loop', '-1', '-i', path.join(__dirname, 'fixtures/synthetic-heaac.aac'), '-t', '12',
        ...video, '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
        '-c:a', 'copy', '-f', 'mpegts', sample]);
    assert.equal(made.status, 0, String(made.stderr));
    assert.equal(probe(sample, 'stream=color_transfer').streams[0].color_transfer, 'smpte2084', 'the sample is HDR-tagged');
    assert.equal(probe(sample, 'stream=profile').streams[1].profile, 'HE-AAC', 'Linux also exercises real HE-AAC');
    server = http.createServer(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const data = fs.readFileSync(sample);
        for (let i = 0; i < data.length && !res.destroyed; i += 32 * 1024) {
            res.write(data.subarray(i, i + 32 * 1024));
            if (throttle) await new Promise(r => setTimeout(r, throttle));
        }
        res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/live/1.ts`;
});

// AAC-LC from TS needs ADTS -> ASC when copied into fMP4. The HE-AAC fixture
// above alone misses the muxer failure seen in recording #202 (29 Oct).
test('AAC-LC watch copy plays the available archive and follows its growth before capture ends', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const workDir = segments.workDirFor(902);
    const epoch = segments.nextEpoch(workDir);
    const sampleLC = path.join(sandbox, 'lc.ts');
    const made = await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '24',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', sampleLC]);
    assert.equal(made.code, 0, made.err);
    assert.equal(probe(sampleLC, 'stream=profile').streams[1].profile, 'LC');
    // Only remove HTTP input options for the local-file capture; keep the actual
    // archive muxer and watch-copy builders. Publish the first half, then append.
    const capture = segments.captureArgs({ userAgent: 'test', url: sampleLC, epochDir: epoch.dir });
    capture.splice(1, capture.indexOf('-i') - 1);
    const captured = await run(capture);
    assert.equal(captured.code, 0, captured.err);
    const file = path.join(epoch.dir, 'archive.m3u8');
    const full = fs.readFileSync(file, 'utf8').replace('#EXT-X-ENDLIST\n', '');
    const split = full.indexOf('#EXTINF:', full.indexOf('a000002.ts') + 'a000002.ts'.length);
    assert.ok(split > 0);
    fs.writeFileSync(file, full.slice(0, split));
    const rec = { id: 902, work_dir: workDir };
    try {
        await segments.ensureView(rec);
        const follower = segments._followers.get('902:1');
        assert.ok(await until(() => !follower.proc || segments.viewPlaylist(workDir).segments >= 2));
        assert.ok(follower.proc, 'the follower must stay alive while capture is open');
        const initial = segments.viewPlaylist(workDir);
        assert.ok(initial.segments >= 2, 'several playable segments, not an aborted 0.08 s fragment');
        assert.equal(initial.ended, false);
        fs.writeFileSync(file, full);
        assert.ok(await until(() => segments.viewPlaylist(workDir).segments > initial.segments), 'new archive segments reach the viewer');
        assert.ok(follower.proc, 'still following before the recording ends');
        fs.appendFileSync(file, '#EXT-X-ENDLIST\n');
        assert.ok(await until(() => segments.viewPlaylist(workDir, { captureOver: true }).ended));
        const watched = probe(path.join(epoch.dir, 'view.m3u8'), 'format=duration:stream=codec_name');
        assert.ok(Number(watched.format.duration) >= 23, 'the full recording survives the remux');
        assert.ok(watched.streams.some(s => s.codec_name === 'aac'));
    } finally {
        segments.stopFollowers(902);
    }
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    for (const [, f] of segments._followers) { try { f.proc?.kill?.('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a capture killed mid-way, then a second run: one timeline, a watch copy of both, one MP4 that passes the preparation check', { skip: !hasFfmpeg && 'no ffmpeg' }, async (t) => {
    const workDir = segments.workDirFor(901);
    const rec = { id: 901, work_dir: workDir };

    // Epoch 1: the provider sends slowly; the server dies (SIGKILL) once a few segments exist.
    throttle = 25;
    const e1 = segments.nextEpoch(workDir);
    assert.equal(e1.offsetSec, 0);
    const p1 = spawn('ffmpeg', segments.captureArgs({ userAgent: 'test', url: base, epochDir: e1.dir, offsetSec: e1.offsetSec }), { stdio: ['pipe', 'ignore', 'ignore'] });
    assert.ok(await until(() => parseMediaPlaylist(fs.existsSync(path.join(e1.dir, 'archive.m3u8')) ? fs.readFileSync(path.join(e1.dir, 'archive.m3u8'), 'utf8') : '').segments.length >= 2),
        'epoch 1 wrote segments');
    p1.kill('SIGKILL');
    await once(p1, 'close');
    const open = parseMediaPlaylist(fs.readFileSync(path.join(e1.dir, 'archive.m3u8'), 'utf8'));
    assert.equal(open.ended, false, 'a killed capture leaves its playlist open');
    segments.sealEpoch(e1.dir);
    segments.sealEpoch(e1.dir);
    const sealed = fs.readFileSync(path.join(e1.dir, 'archive.m3u8'), 'utf8');
    assert.equal(sealed.match(/#EXT-X-ENDLIST/g).length, 1, 'sealed once, however often it is asked');
    const e1Seconds = segments.recordedSeconds(workDir);
    assert.ok(e1Seconds >= 4, `epoch 1 recorded ${e1Seconds}s`);

    // Epoch 2: the next run continues the timeline where epoch 1 stopped. Its watch copy follows it
    // while it is still being written.
    throttle = 5;
    const e2 = segments.nextEpoch(workDir);
    assert.equal(e2.n, 2);
    assert.ok(Math.abs(e2.offsetSec - e1Seconds) < 0.001);
    const p2 = spawn('ffmpeg', segments.captureArgs({ userAgent: 'test', url: base, epochDir: e2.dir, offsetSec: e2.offsetSec }), { stdio: ['pipe', 'ignore', 'ignore'] });
    const p2closed = new Promise(resolve => p2.on('close', resolve)); // watched from the start: it may end before we look
    assert.ok(await until(() => segments.archiveSegmentCount(workDir) > open.segments.length), 'epoch 2 wrote a segment');
    await segments.ensureView(rec);
    const r2 = await p2closed;
    assert.equal(r2, 0, 'epoch 2 ran to the end of the input');

    const firstOf = (dir) => path.join(dir, parseMediaPlaylist(fs.readFileSync(path.join(dir, 'archive.m3u8'), 'utf8')).segments[0].name);
    const start1 = Number(probe(firstOf(e1.dir), 'format=start_time').format.start_time);
    const start2 = Number(probe(firstOf(e2.dir), 'format=start_time').format.start_time);
    assert.ok(Math.abs((start2 - start1) - e1Seconds) < 0.2, `epoch 2 starts where epoch 1 ended (${start1} -> ${start2}, ${e1Seconds}s recorded)`);

    // The watch copy: both epochs, each with its own init segment, a discontinuity between them.
    await segments.ensureView(rec);
    assert.ok(await until(() => segments.viewPlaylist(workDir, { captureOver: true }).ended, 30000), 'the watch copy of both epochs completes');
    const view = segments.viewPlaylist(workDir, { captureOver: true }).text;
    assert.equal((view.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
    assert.deepEqual(view.match(/#EXT-X-MAP:URI="[^"]+"/g), ['#EXT-X-MAP:URI="e1/init.mp4"', '#EXT-X-MAP:URI="e2/init.mp4"']);
    assert.match(view, /#EXT-X-START:TIME-OFFSET=0\.0/, 'a player starts at the beginning, not at the live end');
    assert.match(view, /#EXT-X-ENDLIST/);
    const init = probe(path.join(e1.dir, 'init.mp4'), 'stream=codec_name,codec_tag_string,color_transfer');
    const v = init.streams.find(s => s.codec_name === 'hevc' || s.codec_name === 'h264');
    if (hevc) assert.equal(v.codec_tag_string, 'hvc1', 'HEVC is tagged hvc1, which AVPlayer needs');
    assert.ok(init.streams.some(s => s.codec_name === 'aac'), 'audio in the watch copy');
    const liveView = segments.viewPlaylist(workDir, { captureOver: false }).text;
    assert.doesNotMatch(liveView, /#EXT-X-ENDLIST/, 'while recording the playlist stays open');
    assert.match(liveView, /#EXT-X-PLAYLIST-TYPE:EVENT/);

    // The MP4, made and checked the way preparation (K12) makes and checks one.
    const stitched = segments.stitchArchive(workDir);
    assert.ok(Math.abs(stitched.durationSec - segments.recordedSeconds(workDir)) < 0.001);
    const out = path.join(sandbox, 'final.mp4');
    const codecs = await media.probeCodecs(stitched.file);
    const remux = await run(media.buildNativeRemuxArgs(stitched.file, out, codecs));
    assert.equal(remux.code, 0, remux.err);
    const check = await media.checkPrepared(stitched.file, out);
    assert.equal(check.ok, true, check.reason);
    assert.equal(check.keepOriginal, false, check.reason);
    const final = probe(out, 'format=duration:stream=codec_name,codec_tag_string,color_transfer,avg_frame_rate,r_frame_rate');
    assert.ok(Math.abs(Number(final.format.duration) - stitched.durationSec) / stitched.durationSec < 0.05,
        `the MP4 is as long as both epochs (${final.format.duration}s of ${stitched.durationSec}s)`);
    const fv = final.streams.find(s => s.codec_name === 'hevc' || s.codec_name === 'h264');
    assert.equal(fv.color_transfer, 'smpte2084', 'HDR tagging survives');
    assert.equal(fv.r_frame_rate, '50/1', '50 fps survives');
    const [num, den] = fv.avg_frame_rate.split('/').map(Number);
    assert.ok(Math.abs(num / den - 50) < 0.5, `no frames lost or doubled at the join (average ${fv.avg_frame_rate})`);
    if (hevc) assert.equal(fv.codec_tag_string, 'hvc1');
});

// M1/L1: reproduce FOX's ADTS profile-0 label independently of FFmpeg's encoder.
// ffprobe still decodes this as HE-AAC, but a copied ASC advertises AAC Main.
for (const unknown of [false, true]) test(`review ${unknown ? 'L1 unknown probe' : 'M1 profile-0'}: watch audio has an Apple-safe LC config`, { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const dir = path.join(sandbox, unknown ? 'unknown-watch' : 'main-watch');
    fs.mkdirSync(dir);
    const adts = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-heaac.aac')));
    for (let p = 0; p + 7 <= adts.length;) {
        assert.equal(adts[p], 255);
        const length = ((adts[p + 3] & 3) << 11) | (adts[p + 4] << 3) | (adts[p + 5] >> 5);
        adts[p + 2] &= 63; // profile 0 (object type 1), payload unchanged
        p += length;
    }
    const input = path.join(dir, 'main.aac'); fs.writeFileSync(input, adts);
    const made = await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-stream_loop', '-1', '-i', input, '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
        '-c:a', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(dir, 'a%06d.ts'), path.join(dir, 'archive.m3u8')]);
    assert.equal(made.code, 0, made.err);
    const { adtsObjectType } = require('../server/services/adtsProfile');
    assert.equal(adtsObjectType(fs.readFileSync(path.join(dir, 'a000000.ts'))), 1, 'not an LC-labelled generated fixture');
    const codecs = unknown ? {} : await media.probeCodecs(path.join(dir, 'a000000.ts'));
    if (!unknown) assert.equal(codecs.audio, 'aac');
    const watched = await run(segments.viewArgs(dir, codecs));
    assert.equal(watched.code, 0, watched.err);
    const asc = file => {
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,extradata', '-show_data', '-of', 'json', file], { encoding: 'utf8' });
        const audio = JSON.parse(r.stdout).streams.find(s => s.codec_name === 'aac');
        return parseInt(/00000000:\s+([0-9a-f]{2})/i.exec(audio.extradata)[1], 16) >> 3;
    };
    assert.equal(asc(path.join(dir, 'init.mp4')), 2, 'Apple must see AAC-LC, not the source Main label');
    const final = path.join(dir, 'final.mp4');
    const finished = await run(media.buildNativeRemuxArgs(path.join(dir, 'archive.m3u8'), final, codecs));
    assert.equal(finished.code, 0, finished.err);
    assert.equal(asc(final), 2, 'finished recording has the same safe policy');
});
