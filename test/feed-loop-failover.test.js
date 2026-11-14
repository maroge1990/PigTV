const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { haveFfmpeg, makeFeeds } = require('./helpers/loopFeeds');

// #324: a provider feed that loops the same clip with fresh timestamps is a feed failure. The real shared
// ingest reads an HTTP provider that serves a clip looped by ffmpeg (fresh timestamps, the same payloads);
// a real HLS session (a stand-in ffmpeg reading pipe:0) and the real relay with its hot standby on a second
// provider follow it. The loop is found on the bytes, the feed ends as lost for the provider's sake, the
// relay joins the standby on, the channel is quarantined on the looping provider, and Status's records
// say why - by the provider's name, never its address. A reconnect's resend is never compared with what
// came before it, and PIGTV_INGEST_LOOP_CHECK=0 turns the check off. Skips without ffmpeg (libx264).
const skip = !haveFfmpeg && 'ffmpeg with libx264 is not installed here';
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-feed-loop-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const ingest = load('services/ingest');
const relay = load('services/streamRelay');
const routing = load('services/providerRouting');
const strategy = load('services/playbackStrategy');
const interruptions = load('services/playbackInterruptions');
const playbackEvents = load('services/playbackEvents');
const { probeCache } = load('services/streamProbe');
const originalTuning = { ...ingest.tuning };
const realPlan = routing.plan;
const { takeLease } = coordinator;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(50); }
    assert.fail(`timed out waiting for: ${label}`);
}

// ---- the stand-in tools: ffprobe answers at once; ffmpeg writes a segment per 20 kB it reads ----------
const FFPROBE = path.join(sandbox, 'ffprobe-fake');
fs.writeFileSync(FFPROBE, `#!${process.execPath}
const args = process.argv.slice(2);
const answer = () => { process.stdout.write(JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 320, height: 180, avg_frame_rate: '25/1' },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 } ], format: { format_name: 'mpegts' } })); process.exit(0); };
if (args[args.length - 1] === 'pipe:0') { let got = 0; process.stdin.on('data', d => { got += d.length; if (got > 2000) answer(); }); }
else answer();
`);
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const out = args[args.length - 1];
let got = 0, segs = 0;
const write = () => {
  fs.writeFileSync(path.join(path.dirname(out), 'seg' + String(segs).padStart(4, '0') + '.ts'), 'x');
  segs++;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < segs; i++) lines.push('#EXTINF:4.000000,', 'seg' + String(i).padStart(4, '0') + '.ts');
  fs.writeFileSync(out, lines.join('\\n') + '\\n');
};
process.stdin.on('data', d => { got += d.length; while (got > (segs + 1) * 20000) write(); });
process.stdin.on('end', () => process.exit(0));
`);
for (const f of [FFPROBE, FFMPEG]) fs.chmodSync(f, 0o755);

// ---- the providers -----------------------------------------------------------------------------------
let feeds, provider, base, gate, A, B, candA, candB;
let releaseGate = () => {};
const connections = {};
function dummyPacket(n) { // a packet with no PES (the standby's provider): nothing for the detector to judge
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47; p[1] = n % 20 === 0 ? 0x40 : 0x01; p[2] = n % 20 === 0 ? 0 : 0x00; p[3] = 0x10 | (n & 0x0f);
    return p;
}
/** Write `data` in 64 kB pieces, quickly; `pauseAt` bytes first, then wait for `wait`. */
async function serve(res, data, { pauseAt = data.length, wait = null } = {}) {
    for (let at = 0; at < data.length && !res.destroyed; at += 65536) {
        if (at >= pauseAt && wait) { await wait; wait = null; }
        res.write(data.subarray(at, at + 65536));
        await sleep(5);
    }
}

before(async () => {
    if (skip) return;
    feeds = makeFeeds(path.join(sandbox, 'feeds'));
    provider = http.createServer((req, res) => {
        connections[req.url] = (connections[req.url] || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        if (req.url === '/live.ts') {
            let n = 0;
            const timer = setInterval(() => res.write(Buffer.concat(Array.from({ length: 30 }, () => dummyPacket(n++)))), 20);
            res.on('close', () => clearInterval(timer));
            return;
        }
        if (req.url === '/loop.ts') {
            // The first ~7 s of media, then (once the test says so) the rest; the connection stays open.
            const data = fs.readFileSync(feeds.loop);
            serve(res, data, { pauseAt: Math.floor(data.length / 10), wait: gate });
            return;
        }
        if (req.url === '/resend.ts') {
            // The first connection: one pass of the clip, then the provider drops it. The reconnect: the
            // same clip twice more with fresh timestamps (a resend), and the connection stays open.
            const data = connections[req.url] === 1 ? fs.readFileSync(feeds.clip) : Buffer.concat([feeds.shifted, feeds.shifted2].map(f => fs.readFileSync(f)));
            serve(res, data).then(() => { if (connections[req.url] === 1) res.end(); });
            return;
        }
        res.end();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://a.invalid/list.m3u' });
    B = await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://b.invalid/list.m3u', role: 'backup', priority: 1 });
    await db.settings.update({ maxProviderStreams: 1, sharedIngestEnabled: true, relayEnabled: true, standbyEnabled: true });
    candA = { providerId: A.id, providerName: 'Strong8K', role: 'primary', via: 'primary', url: `${base}/loop.ts`, channelKey: 'fox-footy', channelName: 'FOX Footy' };
    channelRef.sourceId = A.id;
    candB = { providerId: B.id, providerName: 'Dream 4K', role: 'backup', via: 'backup', url: `${base}/live.ts`, channelKey: '504', channelName: 'FOX Footy' };
    routing.plan = async () => ({ candidates: [candA, candB].filter(c => !routing.isQuarantined(c.providerId, c.channelKey)), primaryKey: 'fox-footy', channelName: 'FOX Footy' });
});

afterEach(async () => {
    if (skip) return;
    await relay.closeAll();
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    coordinator._leases.clear();
    ingest.closeAll('test over');
    Object.assign(ingest.tuning, originalTuning);
    probeCache.clear();
    routing.reset();
    interruptions.reset();
    playbackEvents.reset();
});

after(() => {
    routing.plan = realPlan;
    provider?.closeAllConnections?.(); provider?.close();
    try { load('db/sqlite').getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const settingsNow = async () => ({ ...(await db.settings.get()), ffmpegPath: FFMPEG });
const channelRef = { sourceId: null, channelId: 'pos_504' }; // the source id is set once the sources exist
/** Start a play of `cand` the way the route does: through the shared ingest, watched for a provider loss. */
async function startPlay(cand, owner = 'device:tv') {
    const settings = await settingsNow();
    const decision = await strategy.resolve({ url: cand.url, capabilities: { segmentedDelivery: true }, settings, ffprobePath: FFPROBE, owner, live: true,
        providerId: cand.providerId, ingestSource: ingest.sourceFor(cand, settings, channelRef), sessionOptions: { channelName: 'FOX Footy' } });
    const session = transcodeSession.getSession(decision.sessionId);
    routing.watchSession(session, cand, 'fox-footy', 'FOX Footy');
    return { session, settings };
}
function captureLog() {
    const lines = [];
    const log = console.log, warn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => { console.log = log; console.warn = warn; } };
}

test('a provider looping a clip with fresh timestamps is found on its payloads, and the relay switches to the standby', { skip }, async () => {
    gate = new Promise(r => { releaseGate = r; });
    const out = captureLog();
    try {
        const { session: front, settings } = await startPlay(candA);
        assert.ok(front.feed, 'the session reads the shared ingest');
        const followed = relay.adopt(front, { sourceId: A.id, channelId: 'pos_504', capabilities: { segmentedDelivery: true }, settings, ffprobePath: FFPROBE,
            owner: 'device:tv', channelName: 'FOX Footy', primaryKey: 'fox-footy', candidate: candA });
        followed.standbyAt = 0;
        await until(() => followed.standbyReady(), 'the standby on Dream 4K is ready');
        assert.equal(followed.standby.candidate.providerName, 'Dream 4K');

        releaseGate(); // the provider sends the rest: the clip again, twice, with fresh timestamps
        await until(() => followed.active.candidate.providerName === 'Dream 4K', 'the relay plays the standby');

        // The feed ended as lost for the provider's sake, with the reason the ingest gave.
        assert.equal(front.feedLost.reason, 'repeating');
        assert.equal(front.feedLost.providerReason, true);
        assert.ok(Math.abs(front.feedLost.periodSec - feeds.clipSec) < 0.5, `period ${front.feedLost.periodSec} s`);
        const closed = ingest.status().recent.find(r => r.repeatingSec !== null);
        assert.ok(closed, 'the looping ingest is in Status\'s last closed');
        assert.ok(Math.abs(closed.repeatingSec - feeds.clipSec) < 0.5, `period ${closed.repeatingSec} s, the clip is ${feeds.clipSec} s`);
        assert.equal(closed.why, `Strong8K kept repeating the same ${feeds.clipSec} s clip`);
        // The relay says why, and that the standby took over (Status: Recent plays, Streams in detail).
        const reasons = playbackEvents.recent().filter(e => e.type === 'relay').map(e => e.reason);
        assert.ok(reasons.includes(`repeating: Strong8K kept repeating the same ${feeds.clipSec} s clip`), reasons.join(' | '));
        assert.ok(reasons.includes('promoted: standby on Dream 4K took over'), reasons.join(' | '));
        // The channel is quarantined on the looping provider (the next play goes elsewhere), and the
        // interruption the route records for this session is `repeating`.
        assert.equal(routing.isQuarantined(candA.providerId, candA.channelKey), true);
        // One channel's feed on a provider that is up: not counted toward the provider's breaker.
        assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'nothing toward Strong8K\'s breaker');
        assert.equal(routing.providerState(A.id), 'up');
        assert.equal(interruptions.reasonOf('exit', front), 'repeating');
        // Logged by the provider's name, never its address.
        const said = out.lines.join('\n');
        assert.match(said, new RegExp(`Strong8K is repeating the same ${feeds.clipSec}(\\.\\d)? s clip on "FOX Footy"`));
        assert.match(said, /Strong8K lost "FOX Footy" mid-play \(kept repeating the same clip\)/);
        assert.ok(!said.includes(base) && !said.includes('/loop.ts'), 'no provider URL in the log');
        assert.equal(connections['/loop.ts'], 1, 'not reconnected: the same clip would come back');
    } finally { out.restore(); releaseGate(); }
});

test('a recording whose feed repeated the same clip is held against the channel only, like a stall on its only provider', () => {
    const engine = load('services/recordingEngine');
    const entry = (extra = {}) => ({ route: { multi: true, oneProvider: false }, stalled: false, feedLost: null, ...extra });
    const repeating = { reason: 'repeating', providerReason: true, periodSec: 36.2 };
    assert.equal(engine._heldAgainst(entry({ feedLost: repeating }), { failover: true, ranLong: true }), 'channel');
    // The rules it sits beside are unchanged (#304, #288).
    assert.equal(engine._heldAgainst(entry({ feedLost: { reason: 'upstream-lost', providerReason: true } }), { failover: true, ranLong: true }), 'provider');
    assert.equal(engine._heldAgainst(entry({ stalled: true, route: { multi: true, oneProvider: true } }), { failover: true, ranLong: true }), 'channel');
    assert.equal(engine._heldAgainst(entry({ stalled: true }), { failover: true, ranLong: true }), 'provider');
    assert.equal(engine._heldAgainst(entry(), { failover: false, ranLong: false }), 'channel');
    assert.equal(engine._heldAgainst(entry(), { failover: false, ranLong: true }), null);
});

test('the route records a lost session\'s interruption with the reason its feed gave', { skip }, () => {
    const route = fs.readFileSync(path.join(sandbox, 'server/routes/playback.js'), 'utf8');
    assert.match(route, /reason: interruptions\.reasonOf\(how, played\)/);
    assert.equal(interruptions.reasonOf('exit', { feedLost: { reason: 'upstream-lost', providerReason: true } }), 'lost');
    assert.equal(interruptions.reasonOf('stall', null), 'stalled');
});

test('a reconnect that resends the clip with fresh timestamps is not compared with what came before it', { skip }, async () => {
    const out = captureLog();
    try {
        const cand = { ...candA, url: `${base}/resend.ts` };
        const feed = await ingest.subscribe({ ...ingest.sourceFor(cand, await settingsNow()), purpose: 'viewer', owner: 'device:tv' });
        feed.resume();
        await until(() => connections['/resend.ts'] === 2 && feed.ingest.state === 'live', 'the second connection');
        const size = fs.statSync(feeds.shifted).size + fs.statSync(feeds.shifted2).size;
        await until(() => feed.bytesOut >= fs.statSync(feeds.clip).size + size - 65536, 'the resend delivered');
        await sleep(200);
        assert.equal(feed.endReason, null, 'still reading');
        assert.equal(feed.ingest.looping, null);
        assert.ok(!out.lines.join('\n').includes('repeating'));
        feed.leave();
    } finally { out.restore(); }
});

test('PIGTV_INGEST_LOOP_CHECK=0: the check is off, the looping feed reads on', { skip }, async () => {
    ingest.tuning.loopCheck = false;
    gate = Promise.resolve();
    const out = captureLog();
    try {
        const feed = await ingest.subscribe({ ...ingest.sourceFor(candA, await settingsNow()), purpose: 'viewer', owner: 'device:tv' });
        feed.resume();
        await until(() => feed.bytesOut >= fs.statSync(feeds.loop).size - 65536, 'the whole loop delivered');
        await sleep(200);
        assert.equal(feed.endReason, null);
        feed.leave();
    } finally { out.restore(); }
});

// #324 (Mark's rule, D-60's spirit): only act when the channel has somewhere to go. With no other provider for it,
// or every other one quarantined or full, the looping feed plays on: the viewer and a recording on it carry on, it
// is said once in the log and on Status, and nothing is ended, quarantined or counted.
for (const [label, setUp] of [
    ['the backup is quarantined for this channel', () => routing.quarantine(B.id, '504')],
    ['the backup has no free connection', () => takeLease(B.id, 'viewer', { owner: 'device:kitchen' })]
]) test(`no other provider to go to (${label}): the looping feed plays on, said once, nothing quarantined`, { skip }, async () => {
    gate = Promise.resolve();
    setUp();
    const out = captureLog();
    const realOther = routing.otherFeedFor;
    let asked = 0;
    routing.otherFeedFor = (...a) => { asked++; return realOther(...a); };
    try {
        const source = ingest.sourceFor(candA, await settingsNow(), channelRef);
        const viewer = await ingest.subscribe({ ...source, purpose: 'viewer', owner: 'device:tv' });
        const recording = await ingest.subscribe({ ...source, purpose: 'recording' });
        viewer.resume(); recording.resume();
        const size = fs.statSync(feeds.loop).size;
        await until(() => viewer.bytesOut >= size - 65536, 'the whole loop delivered');
        // Four passes: found in the third (58 s) and asked again a period later (82 s), the same run going on.
        await until(() => out.lines.filter(l => l.includes('no other provider for this channel')).length >= 1, 'said');
        await until(() => asked >= 2, 'asked again at the next detection');
        await sleep(300);
        assert.equal(viewer.endReason, null, 'the viewer reads on');
        assert.equal(recording.endReason, null, 'the recording records on');
        assert.equal(viewer.ingest.state, 'live', 'the feed is still read');
        const said = out.lines.filter(l => l.includes('no other provider for this channel'));
        assert.equal(said.length, 1, `said once: ${said.join(' | ')}`);
        assert.match(said[0], /Strong8K is repeating the same 24(\.\d)? s clip on "FOX Footy" .*; no other provider for this channel: it plays on/);
        const shown = ingest.list().find(i => i.id === viewer.ingest.id);
        assert.equal(shown.repeatingNote, `Strong8K is repeating the same ${feeds.clipSec} s clip; no other provider for this channel`);
        assert.ok(playbackEvents.recent().some(e => e.type === 'relay' && e.reason === `repeating: ${shown.repeatingNote}`), 'on Status\'s recent plays');
        assert.equal(routing.isQuarantined(candA.providerId, candA.channelKey), false, 'not quarantined');
        assert.equal(routing._breakers.get(A.id)?.failures.length ?? 0, 0, 'nothing counted');
        assert.ok(!out.lines.join('\n').includes(base), 'no provider URL in the log');
        viewer.leave(); recording.leave();
    } finally { out.restore(); routing.otherFeedFor = realOther; }
});

// Codex #324 high: "somewhere to go" must be where the readers would really go. The relay skips a provider whose feed
// could not join this stream (`unusable`, e.g. a standby refused as incompatible); a recording goes only to its own
// route's candidates with a connection for it. With the only backup ruled out so, the looping feed plays on.
test('a looping primary whose only backup the relay found unusable (a rejected standby) plays on', { skip }, async () => {
    gate = new Promise(r => { releaseGate = r; });
    const out = captureLog();
    try {
        const { session: front, settings } = await startPlay(candA);
        const followed = relay.adopt(front, { sourceId: A.id, channelId: 'pos_504', capabilities: { segmentedDelivery: true }, settings, ffprobePath: FFPROBE,
            owner: 'device:tv', channelName: 'FOX Footy', primaryKey: 'fox-footy', candidate: candA });
        followed.unusable.add(B.id); // as when its standby was refused: "standby-incompatible"
        releaseGate();
        await until(() => out.lines.some(l => l.includes('no other provider for this channel: it plays on')), 'kept', 20000);
        await sleep(1500); // a relay tick or more
        assert.equal(front.feedLost, null, 'the feed was not ended');
        assert.equal(followed.closed, false, 'the play goes on');
        assert.equal(followed.active.session, front);
        assert.equal(routing.isQuarantined(candA.providerId, candA.channelKey), false);
    } finally { out.restore(); releaseGate(); }
});

test('a reader that would not use the other provider keeps the looping feed for everyone on it', { skip }, async () => {
    gate = Promise.resolve();
    const out = captureLog();
    try {
        const source = ingest.sourceFor(candA, await settingsNow(), channelRef);
        const viewer = await ingest.subscribe({ ...source, purpose: 'viewer', owner: 'device:tv' });
        const recording = await ingest.subscribe({ ...source, purpose: 'recording' });
        recording.loopFilter = () => false; // e.g. Dream 4K is not on its route, or has no connection for a recording
        viewer.resume(); recording.resume();
        await until(() => out.lines.some(l => l.includes('no other provider for this channel: it plays on')), 'kept', 20000);
        assert.equal(viewer.endReason, null);
        assert.equal(recording.endReason, null);
        viewer.leave(); recording.leave();
    } finally { out.restore(); }
});

test('a recording would move only to a candidate of its own multi-provider route with a connection for it', { skip }, () => {
    const engine = load('services/recordingEngine');
    const settings = { maxProviderStreams: 1, sharedIngestEnabled: true };
    const route = { multi: true, candidates: [{ ...candA }, { ...candB }] };
    assert.equal(engine._recordingWouldUse(route, candB, settings), true, 'its backup, free');
    assert.equal(engine._recordingWouldUse({ multi: false, candidates: [candA] }, candB, settings), false, 'a single-provider route');
    assert.equal(engine._recordingWouldUse({ multi: true, candidates: [candA] }, candB, settings), false, 'not on its route');
    const lease = takeLease(B.id, 'viewer', { owner: 'device:kitchen' });
    assert.equal(engine._recordingWouldUse(route, candB, settings), false, 'no connection for it');
    coordinator.releaseLease(lease);
});

// Opus #324: when every provider of a channel loops, each was "somewhere to go" for the other, so the play went back
// and forth. A (provider, channel) found repeating is remembered for an hour and is not somewhere to go.
test('two looping providers do not hand the play back and forth: one found repeating is not somewhere to go', { skip }, async () => {
    gate = Promise.resolve();
    routing.noteRepeating(B.id, '504'); // Dream 4K's feed of the channel was found looping a moment ago
    const out = captureLog();
    try {
        const feed = await ingest.subscribe({ ...ingest.sourceFor(candA, await settingsNow(), channelRef), purpose: 'viewer', owner: 'device:tv' });
        feed.resume();
        await until(() => out.lines.some(l => l.includes('no other provider for this channel: it plays on')), 'kept', 20000);
        assert.equal(feed.endReason, null, 'not handed to the other looping provider');
        assert.equal(routing.isRepeating(A.id, candA.channelKey), true, 'Strong8K\'s loop is remembered for the other side');
        assert.ok(routing.REPEATING_MS >= 60 * 60 * 1000);
        feed.leave();
    } finally { out.restore(); }
});
