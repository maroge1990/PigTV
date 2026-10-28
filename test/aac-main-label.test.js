const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

// 0302 (FR-9): Strong8K's FOX affiliates label their HE-AAC "AAC Main" in every ADTS header
// (captured 28 Oct, FOX [Birmingham] 1080p: fff118805407fc = profile 0, 24 kHz, 2 ch). A copy
// carries that label into the fMP4 AudioSpecificConfig and Apple refuses it (`fmt?`); the
// retry re-encoded. ffprobe calls the stream plain HE-AAC, so the probe reads the label itself
// and no client is sent a copy of anything but an AAC-LC label.
//
// Sandbox copy of the server, as in heaac-passthrough.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-aacmain-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const strategy = load('services/playbackStrategy');
const { probeCache, analyzeProbeResult, probeStream } = load('services/streamProbe');
const transcodeSession = load('services/transcodeSession');
const { TranscodeSession } = transcodeSession;
const db = load('db');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const FOX_ADTS = Buffer.from('fff118805407fc', 'hex');           // the captured header: AAC Main
const LC_ADTS = Buffer.from('fff15880541ffc', 'hex');            // the same frame labelled AAC-LC

/** One TS packet carrying the start of an audio PES (stream 0xC0) whose payload opens with `adts`. */
function audioPacket(adts, { pid = 0x101, adaptation = 0 } = {}) {
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47; pkt[1] = 0x40 | (pid >> 8); pkt[2] = pid & 0xff;
    let p = 4;
    if (adaptation) { pkt[3] = 0x30; pkt[4] = adaptation; pkt.fill(0, 5, 5 + adaptation); p = 5 + adaptation; } else pkt[3] = 0x10;
    Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]).copy(pkt, p); // PES header with a PTS
    adts.copy(pkt, p + 14);
    return pkt;
}
/** A video PES start (stream 0xE0, PID 0x100): never mistaken for audio. */
function videoPacket() {
    const pkt = audioPacket(Buffer.from('fff118805407fc', 'hex'), { pid: 0x100 });
    pkt[7] = 0xe0; // the PES stream id (header at byte 4)
    return pkt;
}

test('the ADTS label is read from the transport stream, in any chunking', () => {
    const { adtsObjectType, AdtsSniffer } = load('services/adtsProfile');
    const feed = Buffer.concat([videoPacket(), videoPacket(), audioPacket(FOX_ADTS, { adaptation: 7 }), videoPacket()]);
    assert.equal(adtsObjectType(feed), 1, 'AAC Main');
    assert.equal(adtsObjectType(Buffer.concat([videoPacket(), audioPacket(LC_ADTS)])), 2, 'AAC-LC');
    assert.equal(adtsObjectType(Buffer.concat([videoPacket(), videoPacket()])), null, 'no audio PES yet');
    const sniffer = new AdtsSniffer();
    const offset = Buffer.concat([Buffer.from([1, 2, 3]), feed]); // a read that starts mid-packet
    for (let i = 0; i < offset.length && !sniffer.done; i += 61) sniffer.push(offset.subarray(i, i + 61));
    assert.equal(sniffer.objectType, 1);
});

// ffprobe's fields for the FOX capture: it reports the decoder's view, plain HE-AAC.
const H264 = { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '60000/1001' };
const FOX_AUDIO = { codec_type: 'audio', codec_name: 'aac', profile: 'HE-AAC', channels: 2, sample_rate: '48000' };
const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const APPLE = { segmentedDelivery: true, hevc: true, fmp4: true, heaac: true };

let n = 0;
async function resolveAudio(adtsObjectType) {
    const url = `http://provider.invalid/live/u/p/aacmain-${n++}.ts`;
    const caps = { ...strategy.DEFAULT_CAPABILITIES, ...APPLE };
    const key = `${url}|${db.getUserAgent(SETTINGS) || ''}|${Object.keys(caps).filter(k => caps[k]).sort().join(',')}`;
    const raw = { streams: [H264, FOX_AUDIO], format: { format_name: 'mpegts' }, ...(adtsObjectType === undefined ? {} : { adtsObjectType }) };
    probeCache.set(key, { result: analyzeProbeResult(raw, url, caps), timestamp: Date.now() });
    const real = transcodeSession.createSession;
    const seen = {};
    transcodeSession.createSession = async (u, options) => { seen.options = options; return { id: 'stub', start: async () => {}, waitForPlaylist: async () => true }; };
    const realLog = console.log;
    console.log = () => {};
    try {
        await strategy.resolve({ url, capabilities: APPLE, settings: SETTINGS });
        const args = new TranscodeSession(url, seen.options).buildFFmpegArgs();
        return args.slice(args.indexOf('-c:a')).join(' ');
    } finally {
        console.log = realLog;
        transcodeSession.createSession = real;
    }
}

test('an AAC Main label is never copied to the Apple client: it is re-encoded to AAC-LC', async () => {
    const audio = await resolveAudio(1);
    assert.match(audio, /^-c:a aac -profile:a aac_low/, audio);
    assert.doesNotMatch(audio, /-c:a copy/);
});

test('an AAC-LC label, or a feed whose label was not read, is still copied (0116 unchanged)', async () => {
    assert.match(await resolveAudio(2), /^-c:a copy -bsf:a aac_adtstoasc/);
    assert.match(await resolveAudio(undefined), /^-c:a copy -bsf:a aac_adtstoasc/, 'a direct read sees no bytes: as before');
});

test('a probe through the shared ingest reads the label from the bytes it already pipes to ffprobe', async () => {
    // A stand-in ffprobe: drains stdin, prints the FOX fields.
    const fake = path.join(sandbox, 'fake-ffprobe.js');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify({ streams: [H264, FOX_AUDIO], format: { format_name: 'mpegts' } }))});});\n`);
    fs.chmodSync(fake, 0o755);
    const bytes = Buffer.concat([videoPacket(), audioPacket(FOX_ADTS), videoPacket()]);
    const feed = Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]);
    feed.leave = () => {};
    const raw = await probeStream('http://provider.invalid/x.ts', fake, null, 5000, { feed });
    assert.equal(raw.adtsObjectType, 1);
    const info = analyzeProbeResult(raw, 'http://provider.invalid/x.ts', { ...strategy.DEFAULT_CAPABILITIES, ...APPLE });
    assert.equal(info.audioOk, false, 'not copyable for any client');
    assert.equal(info.aacObjectType, 1);
});
