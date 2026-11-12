const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

// #3: a reader joining a running shared feed starts at the last PAT before the newest video key frame
// (looking back joinLookbackMs), so its copy session's ffmpeg starts sound and picture together;
// with nothing to go on it starts at the last PAT in the final 2 s, as before. The opener is unchanged.
// The old code joined every reader at the newest PAT, mid-GOP, and kept no more than bufferMs.
const ingest = require('../server/services/ingest');
const ts = require('./helpers/fakeTs');
const T = ingest.tuning;
const TUNING = { ...T };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GOP = 50; // 2 s at 25 frames a second
const FRAME_MS = 40;

// A live provider, one access unit every 40 ms from frame 0 (a key frame: a new connection starts on
// one, as the real feed does); PAT + PMT before every 5th frame. `/nopmt` sends no PMT.
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
            if (f % 5 === 0) { parts.push(ts.pat()); if (path !== '/nopmt') parts.push(ts.pmt()); }
            parts.push(ts.videoFrame(f, { key: f % GOP === 0, rai: true }), ts.audio());
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
    const sub = await ingest.subscribe({ pool: 'j', url: `${base}${path}`, purpose: 'viewer' });
    const backlog = sub.read() || Buffer.alloc(0);
    sub.leave();
    return ts.readPackets(backlog);
}
const videoStarts = (packets) => packets.filter(p => p.frame !== null);

test('a joiner starts at the PAT before the newest key frame, with that key frame as its first picture; the opener still starts at its first PAT', async () => {
    const { openerBytes } = await openAndWait('/rai', { minFrame: GOP + 20 });
    const packets = await join('/rai');
    assert.equal(packets[0].pid, 0, 'it starts at a PAT');
    const frames = videoStarts(packets).map(p => p.frame);
    assert.ok(frames.length > 0, 'it was handed the buffer');
    assert.equal(frames[0] % GOP, 0, `its first picture is a key frame (frame ${frames[0]})`);
    assert.ok(frames.slice(1).every(f => f % GOP !== 0), `that is the newest key frame (${frames.join(',')})`);
    assert.ok(packets.slice(1, packets.findIndex(p => p.frame !== null)).every(p => p.pid !== ts.AUDIO_PID),
        'no sound before the first picture beyond what follows that PAT');
    // The opener got what its own connection would have: from the provider's first PAT, frame 0.
    const opened = ts.readPackets(openerBytes());
    assert.equal(opened[0].pid, 0);
    assert.equal(videoStarts(opened)[0].frame, 0);
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
