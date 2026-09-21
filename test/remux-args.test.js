const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-remuxargs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const { remuxFixes, buildRemuxArgs } = require(path.join(sandbox, 'server/routes/remux'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_ = 'http://provider.invalid/live/u/p/1.ts';
const UA = 'Mozilla/5.0 test';
const MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof';
const argsFor = (video, audio, extra = {}) => buildRemuxArgs(URL_, UA, remuxFixes({ video, audio, ...extra }));
const movflags = (args) => args[args.indexOf('-movflags') + 1];
const fflags = (args) => args[args.indexOf('-fflags') + 1];

test('a working H.264 + AAC stream gets exactly the arguments it always had, plus the AAC filter', () => {
    // Written out in full, from the route as it was before this argument list was
    // made a function: the flags that already work must not move.
    assert.deepEqual(argsFor('h264', 'aac'), [
        '-hide_banner', '-loglevel', 'warning',
        '-user_agent', UA, '-user_agent', UA,
        '-probesize', '5000000', '-analyzeduration', '5000000',
        // No igndts: this stream's timing was not reported uneven, so its own DTS is
        // kept. The route used to discard it for every stream - see 0088.
        '-fflags', '+genpts+discardcorrupt+nobuffer',
        '-err_detect', 'ignore_err',
        '-max_delay', '5000000',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-seekable', '0',
        '-i', URL_,
        '-map', '0:v', '-map', '0:a', '-sn', '-dn',
        '-c', 'copy',
        '-bsf:v', 'dump_extra',
        '-fps_mode', 'passthrough', '-max_muxing_queue_size', '1024',
        '-f', 'mp4', '-movflags', MOVFLAGS,
        '-bsf:a', 'aac_adtstoasc',
        '-'
    ]);
});

test('only a stream the probe called uneven has its DTS rebuilt', () => {
    // The remux route discarded every stream's DTS from the beginning. On a feed
    // with a good clock that replaces correct timestamps with worse ones, which is
    // where its "Packet duration ... out of range" lines came from.
    assert.equal(fflags(argsFor('h264', 'aac', { dtsUneven: true })), '+genpts+discardcorrupt+igndts+nobuffer');
    assert.equal(fflags(argsFor('h264', 'aac', { dtsUneven: false })), '+genpts+discardcorrupt+nobuffer');
    assert.equal(fflags(argsFor('h264', 'aac')), '+genpts+discardcorrupt+nobuffer',
        'and an unclassified stream keeps its own, rather than having it thrown away on a guess');
});

test('AC-3 and E-AC-3 hold the MP4 header back, or ffmpeg cannot write them at all', () => {
    for (const audio of ['ac3', 'eac3']) {
        assert.equal(movflags(argsFor('h264', audio)), `${MOVFLAGS}+delay_moov`, audio);
        assert.ok(!argsFor('h264', audio).includes('aac_adtstoasc'), 'and never the AAC filter, which refuses non-AAC audio');
    }
});

test('every other stream keeps the movflags it has today, so nothing that works starts later', () => {
    for (const audio of ['aac', 'mp3', 'mp2', null]) {
        assert.equal(movflags(argsFor('h264', audio)), MOVFLAGS, String(audio));
    }
    assert.equal(movflags(buildRemuxArgs(URL_, UA)), MOVFLAGS, 'no codecs known at all');
});

test('HEVC is tagged hvc1, alone and together with AC-3', () => {
    const hevc = argsFor('hevc', 'aac');
    assert.deepEqual(hevc.slice(-3), ['-tag:v', 'hvc1', '-']);
    const both = argsFor('hevc', 'ac3');
    assert.ok(both.join(' ').includes('-tag:v hvc1'));
    assert.equal(movflags(both), `${MOVFLAGS}+delay_moov`);
    assert.equal(argsFor('h265', 'aac').includes('hvc1'), true, 'h265 spelling too');
    assert.equal(argsFor('h264', 'aac').includes('hvc1'), false);
});

test('the fix-ups are decided from the probe and nothing else', () => {
    assert.deepEqual(remuxFixes({ video: 'h264', audio: 'aac' }),
        { audioCodec: 'aac', videoCodec: 'h264', encodeAudio: false, needsAdtsToAsc: true, needsHvc1Tag: false, needsDelayMoov: false, needsIgnDts: false });
    assert.deepEqual(remuxFixes({ video: 'HEVC', audio: 'eac3', dtsUneven: true }),
        { audioCodec: 'eac3', videoCodec: 'hevc', encodeAudio: false, needsAdtsToAsc: false, needsHvc1Tag: true, needsDelayMoov: true, needsIgnDts: true });
    const unknown = remuxFixes(null);
    assert.equal(unknown.needsAdtsToAsc || unknown.needsHvc1Tag || unknown.needsDelayMoov, false);
});

const encodedFor = (video, audio) => buildRemuxArgs(URL_, UA, remuxFixes({ video, audio }, { encodeAudio: true }));

test('audio re-encode: the audio becomes clean AAC-LC stereo while the video is still copied', () => {
    const args = encodedFor('h264', 'aac');
    const at = args.indexOf('-c:a');
    assert.deepEqual(args.slice(at, at + 10), ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1']);
    assert.equal(args[args.indexOf('-c') + 1], 'copy', 'video is not re-encoded');
    assert.equal(args[args.length - 1], '-');
});

test('audio re-encode: never the AAC filter (the encoder already emits raw AAC), and never delay_moov', () => {
    for (const audio of ['aac', 'ac3', 'eac3', 'mp2']) {
        const args = encodedFor('h264', audio);
        assert.ok(!args.includes('aac_adtstoasc'), `${audio}: -bsf:a aac_adtstoasc would refuse to initialise`);
        assert.equal(movflags(args), MOVFLAGS, `${audio}: AAC output needs no delayed header`);
    }
});

test('audio re-encode leaves the video fix-ups alone: HEVC is still tagged hvc1', () => {
    assert.ok(encodedFor('hevc', 'aac').join(' ').includes('-tag:v hvc1'));
});

test('without the request nothing changes: no re-encode flags appear on a normal stream', () => {
    for (const audio of ['aac', 'ac3', 'mp3', null]) assert.ok(!argsFor('h264', audio).includes('-c:a'), String(audio));
});

test('the output is always the pipe, as fragmented MP4', () => {
    for (const audio of ['aac', 'ac3', null]) {
        const args = argsFor('h264', audio);
        assert.equal(args[args.length - 1], '-');
        assert.equal(args[args.indexOf('-f') + 1], 'mp4');
    }
});
