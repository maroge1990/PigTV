const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

// #3: a reader joining a running shared feed is handed the PAT and PMT, then the stream from the newest
// video key frame (looking back joinLookbackMs), so its copy session's ffmpeg starts sound and picture
// together; with nothing to go on, or a backlog that would end it as a slow reader, it starts at the
// last PAT in the final 2 s, as before. The opener is unchanged. 0577 joined every reader at the newest
// PAT, mid-GOP; 0578 at the PAT before the key frame, with whatever lay between them.
const ingest = require('../server/services/ingest');
const ts = require('./helpers/fakeTs');
const T = ingest.tuning;
const TUNING = { ...T };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GOP = 50; // 2 s at 25 frames a second
const FRAME_MS = 40;

// A live provider, one access unit every 40 ms from frame 0 (a key frame: a new connection starts on
// one, as the real feed does); PAT + PMT before every 5th frame (every 7th on `/offbeat`, out of step
// with the GOP). `/nopmt` sends no PMT.
const feeds = new Map(); // path -> { frame }
let server, base;
before(async () => {
    server = http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        const feed = { frame: 0 };
        feeds.set(path, feed);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const send = () => {
            const f = feed.frame;
            const parts = [];
            const sparse = path === '/sparse'; // 56 KB a frame (11 Mb/s), a PAT a second, no key frame
            if (f % (path === '/offbeat' ? 7 : sparse ? 25 : 5) === 0) { parts.push(ts.pat()); if (path !== '/nopmt') parts.push(ts.pmt()); }
            parts.push(ts.videoFrame(f, { key: !sparse && f % GOP === 0, rai: true, more: sparse ? 300 : 2 }), ts.audio());
            res.write(Buffer.concat(parts));
            feed.frame++;
        };
        send();
        const timer = setInterval(() => { if (res.destroyed) return clearInterval(timer); send(); }, FRAME_MS);
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { ingest.closeAll('test over'); Object.assign(T, TUNING); });
after(() => { server.closeAllConnections?.(); server.close(); });

async function until(cond, label, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return; await sleep(10); }
    assert.fail(`timed out waiting for: ${label}`);
}
/** Open the feed (the opener drains it) and wait until the provider is `phase` frames into a GOP, after `minFrame`. */
async function openAndWait(path, { minFrame = GOP, phase = [20, 30] } = {}) {
    const opener = await ingest.subscribe({ pool: 'j', url: `${base}${path}`, purpose: 'viewer' });
    const first = [];
    opener.on('data', d => first.push(d));
    await until(() => { const f = feeds.get(path)?.frame ?? 0; return f >= minFrame && f % GOP >= phase[0] && f % GOP <= phase[1]; }, 'mid-GOP');
    await sleep(60); // the frame just sent reaches the ingest
    return { opener, openerBytes: () => Buffer.concat(first) };
}
/** What a new reader is handed at once (the backlog), as packets. */
async function join(path) {
    return ts.readPackets((await joinRaw(path)).backlog);
}
async function joinRaw(path) {
    const sub = await ingest.subscribe({ pool: 'j', url: `${base}${path}`, purpose: 'viewer' });
    const ended = sub.endReason;
    const backlog = sub.read() || Buffer.alloc(0);
    sub.leave();
    return { backlog, ended };
}
const videoStarts = (packets) => packets.filter(p => p.frame !== null);

test('a joiner is handed the PAT and PMT, then the newest key frame; the opener still starts at its first PAT', async () => {
    const { openerBytes } = await openAndWait('/rai', { minFrame: GOP + 20 });
    const packets = await join('/rai');
    assert.deepEqual(packets.slice(0, 2).map(p => p.pid), [0, ts.PMT_PID], 'it starts with the tables');
    const frames = videoStarts(packets).map(p => p.frame);
    assert.ok(frames.length > 0, 'it was handed the buffer');
    assert.equal(packets[2].frame, frames[0], 'then a picture, nothing before it');
    assert.equal(frames[0] % GOP, 0, `its first picture is a key frame (frame ${frames[0]})`);
    assert.ok(frames.slice(1).every(f => f % GOP !== 0), `that is the newest key frame (${frames.join(',')})`);
    // The opener got what its own connection would have: from the provider's first PAT, frame 0.
    const opened = ts.readPackets(openerBytes());
    assert.equal(opened[0].pid, 0);
    assert.equal(videoStarts(opened)[0].frame, 0);
});

test('PATs out of step with key frames: nothing of the feed from before the key frame reaches the joiner, no sound and no picture', async () => {
    await openAndWait('/offbeat', { minFrame: GOP + 20 }); // keys at 50, 100 ...; PATs at 49, 56 ... (PAT 98 before key 100)
    for (let i = 0; i < 3; i++) {
        const packets = await join('/offbeat');
        const first = packets.findIndex(p => p.pid === ts.VIDEO_PID);
        assert.ok(first > 0, 'it was handed a picture');
        assert.equal(packets[first].frame % GOP, 0, `the first video packet is a key frame (frame ${packets[first].frame})`);
        const before = packets.slice(0, first).map(p => p.pid);
        assert.deepEqual(before, [0, ts.PMT_PID], `only the PAT and PMT come before it (pids ${before.join(',')})`);
        await sleep(100);
    }
});

test('a key-frame backlog over the slow-reader limit takes the old join, so the reader is not ended before it can read; under it, the key frame', async () => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        await openAndWait('/rai', { minFrame: GOP + 20 });
        const keyJoin = await joinRaw('/rai'); // 20-30 frames into the GOP: about 20 KB from the key frame
        const size = keyJoin.backlog.length;
        assert.equal(videoStarts(ts.readPackets(keyJoin.backlog))[0].frame % GOP, 0, 'the key-frame join');
        // A limit just under that backlog: 0578 handed it over anyway and ended the reader at once.
        T.slowBytes = Math.floor(size * 0.9);
        const big = await joinRaw('/rai');
        assert.equal(big.ended, null, `the reader is still subscribed (ended: ${JSON.stringify(big.ended)}, backlog ${size} B, limit ${T.slowBytes} B)`);
        const packets = ts.readPackets(big.backlog);
        assert.equal(packets[0].pid, 0, 'the old join: the newest PAT in the final 2 s');
        assert.ok(packets.slice(1).every(p => p.pid !== 0), 'no other PAT after it');
        assert.ok(big.backlog.length <= T.slowBytes, `a short backlog (${big.backlog.length} B)`);
        // #309: a limit between that backlog and twice it: the key-frame join (0579 required a backlog
        // under half the limit, so 25 Mb/s with key frames over 2.7 s apart kept the old join).
        T.slowBytes = Math.floor(size * 1.5);
        const sub = await ingest.subscribe({ pool: 'j', url: `${base}/rai`, purpose: 'viewer' });
        assert.equal(sub.endReason, null);
        const backlog = sub.readableLength;
        assert.ok(backlog > T.slowBytes / 2 && backlog <= T.slowBytes, `a backlog over half the limit (${backlog} B, limit ${T.slowBytes} B)`);
        assert.equal(videoStarts(ts.readPackets(sub.read()))[0].frame % GOP, 0, 'the key-frame join');
        // The backlog is not counted as lag, but what comes after it is: a reader that never reads is
        // still ended, once it is a whole limit behind beyond the backlog.
        const sub2 = await ingest.subscribe({ pool: 'j', url: `${base}/rai`, purpose: 'viewer' });
        const first = sub2.readableLength;
        await until(() => sub2.endReason, 'the reader that never reads is ended', 10000);
        assert.equal(sub2.endReason.reason, 'slow-consumer');
        assert.ok(sub2.bytesOut > first + T.slowBytes, `ended only past the backlog and a limit (${sub2.bytesOut} B out, backlog ${first} B)`);
        assert.ok(sub2.bytesOut <= first + T.slowBytes + 64 * 1024, `and soon after (${sub2.bytesOut} B out)`);
        sub.leave();
    } finally { console.log = log; }
    const said = lines.filter(l => /joined at the newest PAT/.test(l));
    assert.equal(said.length, 1, lines.join('\n'));
    assert.match(said[0], /backlog from the newest key frame .* is over the slow-reader limit/);
    assert.doesNotMatch(said[0], /127\.0\.0\.1|http/);
});

test('the join looks back no further than joinLookbackMs: an older key frame is not used and the joiner starts at the newest PAT, as before', async () => {
    T.joinLookbackMs = 1000;
    await openAndWait('/rai', { phase: [35, 42] }); // the newest key frame is 1.4-1.7 s old
    let packets = await join('/rai');
    assert.equal(packets[0].pid, 0);
    assert.ok(packets.slice(1).every(p => p.pid !== 0), 'the newest PAT: no other PAT after it');
    // Within the default look-back the same moment gives the key frame.
    T.joinLookbackMs = TUNING.joinLookbackMs;
    packets = await join('/rai');
    assert.equal(videoStarts(packets)[0].frame % GOP, 0);
});

test('no PMT: the joiner starts at the newest PAT in the final 2 s, as before, and the feed says so once', async () => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        await openAndWait('/nopmt');
        for (let i = 0; i < 3; i++) {
            const packets = await join('/nopmt');
            assert.equal(packets[0].pid, 0);
            assert.ok(packets.slice(1).every(p => p.pid !== 0), 'the newest PAT');
            assert.ok(videoStarts(packets).length <= 5, 'at most one PAT interval of the feed');
        }
    } finally { console.log = log; }
    const said = lines.filter(l => /joined at the newest PAT: no PMT/.test(l));
    assert.equal(said.length, 1, lines.join('\n'));
    assert.doesNotMatch(said[0], /127\.0\.0\.1|http/);
});

test('#309: a fallback backlog over the budget is not handed over (it would end the reader inside subscribe); the reader starts at the next PAT', async () => {
    // 0579: no key frame, so the old join from the newest PAT in the final 2 s, with no byte budget:
    // 20 frames since a PAT here, about 1.1 MB, against a 1 MiB limit ended the reader as a slow
    // consumer before the session could listen for it, and the play ended with no reason.
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        await openAndWait('/sparse', { phase: [20, 23] }); // 20-23 frames after a PAT (one every 25)
        T.slowBytes = 1024 * 1024;
        const sub = await ingest.subscribe({ pool: 'j', url: `${base}/sparse`, purpose: 'viewer' });
        assert.equal(sub.endReason, null, `the reader is still subscribed (ended: ${JSON.stringify(sub.endReason)})`);
        assert.ok(sub.readableLength <= T.slowBytes / 2, `nothing over the budget was handed over (${sub.readableLength} B)`);
        const got = [];
        sub.on('data', d => got.push(d));
        await until(() => Buffer.concat(got).length >= 188 * 4, 'the next PAT and what follows');
        const packets = ts.readPackets(Buffer.concat(got));
        assert.deepEqual([packets[0].pid, packets[0].pusi, packets[1].pid], [0, true, ts.PMT_PID], 'it starts at a PAT, then the PMT');
        assert.equal(sub.endReason, null);
        sub.leave();
    } finally { console.log = log; }
    const said = lines.filter(l => /waits for the next PAT/.test(l));
    assert.equal(said.length, 1, lines.join('\n'));
    assert.doesNotMatch(said[0], /127\.0\.0\.1|http/);
});

/** A reader of a live feed that only this test delivers to (the feed's own data does not reach it). */
async function detachedReader(path) {
    await openAndWait(path);
    const feed = [...ingest._registry.values()].find(i => !i.closed);
    const sub = feed.subscribe({ purpose: 'viewer' });
    feed.subs.delete(sub);
    sub.read();
    return sub;
}

test('#309 review: a reader waiting for a PAT finds one split across chunks, and is not fooled by a stray sync byte at a chunk\'s end', async () => {
    // 0579 + #309 item 1 scanned each chunk alone: a PAT split across two chunks was never found, and
    // with every PAT split the reader was handed nothing at all on a healthy feed (Codex review).
    const sub = await detachedReader('/rai');
    sub.awaitPat = true;
    // First a video packet whose payload holds what looks like a PAT header, cut 188 bytes after it.
    const fake = ts.videoFrame(900, { more: 0 });
    fake.set([0x47, 0x40, 0x00, 0x10], 100);
    const parts = [ts.audio(), fake, ts.audio()];
    for (let n = 0; n < 20; n++) parts.push(ts.pat(), ts.pmt(), ts.videoFrame(1000 + n, { key: n % 5 === 0, rai: true }), ts.audio());
    const stream = Buffer.concat(parts);
    // Then every PAT cut in two: chunk boundaries 100 bytes into each.
    const cuts = [188 + 100 + 188, ...ts.readPackets(stream).filter(p => p.pid === 0).map(p => p.offset + 100)];
    let from = 0;
    for (const cut of [...cuts, stream.length]) { sub.deliver(stream.subarray(from, cut)); from = cut; }
    assert.ok(sub.bytesOut > 0, 'it was handed the feed');
    const got = sub.read();
    const packets = ts.readPackets(got);
    assert.deepEqual([packets[0].pid, packets[0].pusi, packets[1].pid], [0, true, ts.PMT_PID], 'it starts at a whole PAT, then the PMT');
    assert.equal(got.length % 188, 0, 'whole packets from there');
    sub.leave();
});

test('the buffer keeps the look-back window even when bufferMs is shorter, and no more than that', async () => {
    T.bufferMs = 500;
    T.joinLookbackMs = 3000;
    await openAndWait('/rai', { minFrame: 100, phase: [20, 30] }); // 4 s in
    const feed = [...ingest._registry.values()].find(i => !i.closed);
    const oldest = Date.now() - feed.chunks[0].at;
    assert.ok(oldest >= 2500, `it holds about the look-back (${oldest} ms)`);
    assert.ok(oldest <= 3000 + 1000, `and no more (${oldest} ms)`);
    const packets = await join('/rai');
    assert.equal(videoStarts(packets)[0].frame % GOP, 0, 'a key frame 0.8-1.2 s back is found');
});
