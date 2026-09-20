const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnSync, spawn } = require('node:child_process');

// A source that ends (a file served from the start) is read by ffmpeg at full speed. An HLS
// session keeps only a few minutes of segments, so ffmpeg races half an hour ahead of the player
// within seconds and the segment the player asks for next has already been deleted: a 404, which
// hls.js does not retry. Found in the HLS trial, on a provider URL that served a ~30-minute file.
//
// Copy the server so its relative data paths never touch real data (same approach as
// resolve-timing.test.js; a junction so it works on Windows without admin rights).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-finite-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult, probeStream } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const db = load('db');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-finite-run-'));
after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const H264_AAC = [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }];
const analyse = (format) => analyzeProbeResult({ streams: H264_AAC, format: { format_name: 'mpegts', ...format } }, 'http://p.invalid/1.ts', {});

// ---- what the probe says ----

test('a source that reports a size or a duration is finite; an open-ended one is not', () => {
    assert.equal(analyse({ size: '106893040' }).finite, true, 'a file served with a Content-Length');
    assert.equal(analyse({ size: '106893040', duration: '1200.021333' }).finite, true);
    assert.equal(analyse({ duration: '1200.02' }).finite, true);
    assert.equal(analyse({ duration: '1200.02' }).durationSec, 1200);
    assert.equal(analyse({}).finite, false, 'a live stream: ffprobe learns neither');
    assert.equal(analyse({ size: 'N/A', duration: 'N/A' }).finite, false);
    assert.equal(analyse({ size: '0' }).finite, false);
    assert.equal(analyse({}).durationSec, null);
});

// ---- the arguments ----

const URL_ = 'http://provider.invalid/live/u/p/1.ts';
const sessionArgs = async (options = {}) => (await transcodeSession.createSession(URL_, { videoMode: 'copy', ...options })).buildFFmpegArgs();

test('a paced session reads its input at real time (-re, before -i); an ordinary one does not', async () => {
    const paced = await sessionArgs({ paceInput: true });
    assert.ok(paced.includes('-re'));
    assert.ok(paced.indexOf('-re') < paced.indexOf('-i'), '-re is an input option');
    assert.ok(!(await sessionArgs()).includes('-re'), 'live feeds arrive in real time already; -re only delays their start');
    assert.ok(!(await sessionArgs({ paceInput: false })).includes('-re'));
});

// ---- resolve() decides from the probe ----

function seedProbe(url, format) {
    const caps = { ...strategy.DEFAULT_CAPABILITIES, segmentedDelivery: true };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    probeCache.set(key, { result: analyzeProbeResult({ streams: H264_AAC, format: { format_name: 'mpegts', ...format } }, url, caps), timestamp: Date.now() });
}

async function resolveWith(format, url) {
    seedProbe(url, format);
    const real = transcodeSession.createSession;
    const seen = {};
    transcodeSession.createSession = async (u, options) => { seen.options = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { await strategy.resolve({ url, capabilities: { segmentedDelivery: true }, settings: SETTINGS }); }
    finally { console.log = realLog; transcodeSession.createSession = real; }
    return { paceInput: seen.options.paceInput, line: lines.find(l => l.includes('resolve timing')) };
}

test('resolve paces the session for a source that ends, and says so in the log', async () => {
    const r = await resolveWith({ size: '106893040', duration: '1929.6' }, 'http://provider.invalid/live/u/p/finite.ts');
    assert.equal(r.paceInput, true);
    assert.match(r.line, /first segment after 0\.\ds, source ends \(32 min\) - paced to real time$/);
});

test('resolve leaves a live source alone', async () => {
    const r = await resolveWith({}, 'http://provider.invalid/live/u/p/live.ts');
    assert.equal(r.paceInput, false);
    assert.match(r.line, /first segment after 0\.\ds$/);
});

// ---- the behaviour, with real ffmpeg / ffprobe ----

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = !haveFfmpeg && 'ffmpeg is not installed here';

// A stream of 10 minutes: 150 four-second segments, well past what a session keeps (90 listed + 12 spare).
function makeSource() {
    const file = path.join(work, 'finite.ts');
    if (fs.existsSync(file)) return file;
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '600', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '48k', '-f', 'mpegts', file], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    return file;
}

// The session's own arguments, pointed at a file instead of the provider URL.
function sessionOn(args, input, outDir) {
    const a = args.slice();
    for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max']) {
        const i = a.indexOf(flag);
        if (i >= 0) a.splice(i, 2); // http-only options
    }
    a[a.indexOf(URL_)] = input;
    a[a.indexOf('-hls_segment_filename') + 1] = path.join(outDir, 'seg%04d.m4s');
    a[a.length - 1] = path.join(outDir, 'stream.m3u8');
    return a;
}

// Runs to the end of what it is given. (Not killed part-way: where ffmpeg is a launcher shim, as on
// some Windows installs, killing the shim leaves the real process running.)
function run(args, cwd) {
    return new Promise((resolve) => {
        const child = spawn('ffmpeg', args, { cwd });
        const started = Date.now();
        child.on('close', () => resolve(Date.now() - started));
    });
}
const segments = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.m4s')).sort();

test('unpaced, ffmpeg outruns the playlist window and the first segments are gone - the 404',
    { skip }, async () => {
        const input = makeSource();
        const dir = path.join(work, 'unpaced'); fs.mkdirSync(dir);
        const args = sessionOn(await sessionArgs({ segmentType: 'fmp4', audioMode: 'copy', audioCodec: 'aac', videoCodec: 'h264' }), input, dir);
        const ms = await run(args, dir);
        assert.ok(ms < 20000, `the whole 7 minutes were read in ${ms} ms`);
        assert.ok(!segments(dir).includes('seg0006.m4s'), 'the segment a player joining at the start needs is already deleted');
    });

test('paced, ffmpeg keeps to real time and the start of the stream stays available',
    { skip }, async () => {
        const input = makeSource();
        const dir = path.join(work, 'paced'); fs.mkdirSync(dir);
        const args = sessionOn(await sessionArgs({ segmentType: 'fmp4', audioMode: 'copy', audioCodec: 'aac', videoCodec: 'h264', paceInput: true }), input, dir);
        args.splice(args.length - 1, 0, '-t', '7'); // an output option: stop after 7 s of media
        const ms = await run(args, dir);
        assert.ok(ms > 5000, `7 s of media took ${ms} ms: read at real time, not all at once`);
        const have = segments(dir);
        assert.ok(have.includes('seg0000.m4s'), 'the first segment is still there');
        assert.ok(have.length <= 4, `about 7 s of media in 7 s, not minutes of it (${have.length} segments)`);
    });

// What makes the probe able to tell: a file server sends a Content-Length, which ffprobe reports as
// the format's size. (An open-ended live response has none - checked by hand against a chunked server.)
test('ffprobe reports a size for a file served over HTTP, so the probe sees it as finite',
    { skip }, async () => {
        const input = makeSource();
        const size = fs.statSync(input).size;
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'video/MP2T', 'Content-Length': size });
            fs.createReadStream(input).pipe(res);
        }).listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            const raw = await probeStream(`http://127.0.0.1:${server.address().port}/1.ts`, 'ffprobe');
            assert.equal(Number(raw.format.size), size);
            assert.equal(analyzeProbeResult(raw, 'http://127.0.0.1/1.ts', {}).finite, true);
        } finally {
            server.closeAllConnections?.();
            server.close();
        }
    });
