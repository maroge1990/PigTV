const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const DOCTOR = path.join(__dirname, '../scripts/stream-doctor.js');
const run = (...args) => spawnSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('with no arguments it explains itself rather than doing anything', () => {
    const r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /list <search>/);
    // The warning that matters: two of the five take the provider's only stream.
    assert.match(r.stdout, /uses the provider slot/);
    assert.match(r.stdout, /nothing\s+may be playing/);
});

test('an unknown subcommand fails loudly instead of doing something surprising', () => {
    const r = run('delete-everything');
    assert.equal(r.status, 2);
});

test('classify and bench refuse a file that is not there', () => {
    for (const cmd of ['classify', 'bench']) {
        const r = run(cmd, path.join(os.tmpdir(), 'pigtv-does-not-exist.ts'));
        assert.equal(r.status, 1, cmd);
        assert.match(r.stderr, /No such file/, cmd);
    }
});

// ---- the diagnosis itself, against real files ----

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function fixtures(dir) {
    const clean = path.join(dir, 'clean.ts');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=50',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '100', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', clean], { encoding: 'utf8' }).status, 0);

    // Repeated DTS written back out through mpegts, which bumps each repeat by +1
    // rather than fixing it - the shape a real uneven feed arrives in.
    const uneven = path.join(dir, 'uneven.ts');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', clean, '-c', 'copy',
        '-bsf:v', 'setts=dts=if(eq(mod(N\\,2)\\,0)\\,PREV_OUTDTS\\,DTS)', '-f', 'mpegts', uneven],
    { encoding: 'utf8' }).status, 0);
    return { clean, uneven };
}

test('classify tells the two kinds of feed apart', { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-doctor-test-'));
    try {
        const { clean, uneven } = fixtures(dir);
        assert.match(run('classify', clean).stdout, /VERDICT\s+: EVEN/);
        assert.match(run('classify', uneven).stdout, /VERDICT\s+: UNEVEN/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('its verdict is the server\'s, not a second opinion', { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, () => {
    // The whole point of the tool reusing streamProbe.classifyTimestamps. If it
    // ever grows its own copy of the rule, the two drift and the diagnostic starts
    // explaining behaviour the server does not have.
    const { classifyTimestamps } = require('../server/services/streamProbe');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-doctor-agree-'));
    try {
        const { clean, uneven } = fixtures(dir);
        for (const [file, expected] of [[clean, false], [uneven, true]]) {
            const packets = JSON.parse(execFileSync('ffprobe',
                ['-v', 'error', '-print_format', 'json', '-show_packets', file],
                { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).packets;
            assert.equal(classifyTimestamps(packets), expected, path.basename(file));
            assert.match(run('classify', file).stdout, expected ? /UNEVEN/ : /EVEN/);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bench scores the server\'s own arguments and shows what each flag changes',
    { skip: !haveFfmpeg && 'ffmpeg is not installed here' }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-doctor-bench-'));
        try {
            const { uneven } = fixtures(dir);
            const out = run('bench', uneven).stdout;
            assert.match(out, /classified UNEVEN/);
            // On an uneven feed the shipping arguments must come out clean, and
            // turning the rebuild off must not: that contrast is the tool's value.
            const shipping = out.match(/as the server would run it\s+(\d+)pkt mean [\d.]+ms, (\d+) outliers/);
            const forcedOff = out.match(/force igndts off\s+(\d+)pkt mean [\d.]+ms, (\d+) outliers/);
            assert.ok(shipping && forcedOff, `both rows are reported:\n${out}`);
            assert.equal(Number(shipping[2]), 0, 'the shipping arguments give evenly timed frames');
            assert.ok(Number(forcedOff[2]) > 0, 'and removing the rebuild reproduces the fault');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

test('captured samples land on the mounted volume, not the writable layer', () => {
    // They were written to /app/samples at first - the container's writable layer,
    // which `docker compose up --force-recreate` discards. The first corpus was lost
    // to the very next deploy, before anything had been retested against it. Samples
    // are evidence and have to outlive the build they were taken on.
    // docker-compose.yml binds ./data:/app/data, so the data directory is what persists.
    const { SAMPLE_DIR, DATA_DIR } = require('../scripts/stream-doctor.js');
    assert.ok(SAMPLE_DIR.startsWith(DATA_DIR + path.sep),
        `samples must be written under the data mount, got ${SAMPLE_DIR}`);
    const compose = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');
    assert.match(compose, /\.\/data:\/app\/data/, 'and that directory is still the bind mount');
});

test('a provider URL never reaches the output, even in an error', () => {
    // capture/probecost print the URL they are about to use; redact() is the server's
    // own, so a credentialed path cannot be echoed into a terminal or a pasted log.
    const { redact } = require('../server/redact');
    const url = 'http://pro.speed8k.top/live/myuser/mypass/1239048.ts';
    const out = redact(url);
    assert.ok(!out.includes('myuser') && !out.includes('mypass'), out);
    assert.match(out, /1239048\.ts/, 'while still identifying the stream');
});

// ---- 0191: raw capture and the jump report (no ffmpeg needed) ----

const doctor = require('../scripts/stream-doctor');

test('the jump report finds a backward step per stream, the A/V start skew and the media carried', () => {
    const packets = [];
    let v = 830 * 90000, a = 830 * 90000 + 180; // audio 2 ms after video, as the raw Fox Footy capture
    for (let i = 0; i < 500; i++) { packets.push({ stream_index: 0, dts: String(v) }); v += 1800; }
    v -= 7.6 * 90000; // the provider resending 7.6 s
    for (let i = 0; i < 500; i++) { packets.push({ stream_index: 0, dts: String(v) }); v += 1800; }
    for (let i = 0; i < 300; i++) { packets.push({ stream_index: 1, dts: String(a) }); a += 1920; }
    const tl = doctor.timeline(packets, [{ index: 0, codec_type: 'video' }, { index: 1, codec_type: 'audio' }]);
    assert.equal(tl.video.jumps.length, 1);
    assert.equal(Math.round(tl.video.jumps[0].stepSec * 100) / 100, -7.58);
    assert.equal(tl.video.jumps[0].wrap, false);
    assert.equal(Math.round(tl.video.jumps[0].atSec), 10);
    assert.equal(tl.audio.jumps.length, 0);
    assert.equal(Math.round(tl.skewSec * 1000), 2);
    assert.equal(Math.round(tl.video.seconds), 20, 'the jump is not counted as media');
});

test('the jump report names a 33-bit clock wrap as normal, and ignores packets without a DTS', () => {
    const tl = doctor.timeline([
        { stream_index: 0, dts: String(2 ** 33 - 1800) }, { stream_index: 0, dts: 'N/A' }, { stream_index: 0, dts: '0' }
    ], [{ index: 0, codec_type: 'video' }]);
    assert.equal(tl.video.jumps.length, 1);
    assert.equal(tl.video.jumps[0].wrap, true);
});

test('capture reads the provider\'s raw bytes, follows a redirect and says how the connection ended', async () => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
        if (req.url === '/live/u/p/1.ts') { res.writeHead(302, { Location: '/stream/1.ts' }); return res.end(); }
        if (req.url === '/stream/1.ts') { res.writeHead(200); res.write(Buffer.alloc(188 * 100, 0x47)); return setTimeout(() => res.end(), 50); }
        if (req.url === '/forever.ts') { res.writeHead(200); res.write(Buffer.alloc(188, 0x47)); return; } // never ends
        res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-doctor-raw-'));
    try {
        const closed = await doctor.rawFetch(`${base}/live/u/p/1.ts`, 30, path.join(dir, 'a.ts'), 'test');
        assert.equal(closed.how, 'closed by the provider');
        assert.equal(closed.bytes, 18800, 'byte for byte what was sent');
        const held = await doctor.rawFetch(`${base}/forever.ts`, 1, path.join(dir, 'b.ts'), 'test');
        assert.equal(held.how, 'complete', 'still open when the time was up');
        const missing = await doctor.rawFetch(`${base}/nope.ts`, 5, path.join(dir, 'c.ts'), 'test');
        assert.equal(missing.how, 'HTTP 404');
        assert.equal(missing.bytes, 0);
    } finally {
        server.closeAllConnections();
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
