const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// Wave 5 (R2, phase 5a): recordings are the shared ingest's first consumer, behind
// `sharedIngestEnabled`. The real engine, coordinator and ingest over a sandboxed database and a
// fake MPEG-TS provider on local HTTP. Every recording is segmented (D-48); ffmpeg is a script that,
// reading pipe:0, writes its stdin into its segment (so the segment is exactly the bytes it was fed).
// With the switch on: the capture reads pipe:0 with the segmented output arguments, the segment is
// the provider's own bytes, two recordings of one channel share ONE connection (even at a limit of
// 1), a different channel still waits, a stream that is not MPEG-TS falls back to its own
// connection. With it off: its own connection, no ingest.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-ingest-rec-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const ingest = load('services/ingest');
const coordinator = load('services/streamCoordinator');
const segments = load('services/recordingSegments');
const { scheduled, recordings } = load('db/recordingsDb');
const { stubNativeTools, drainSegmentQueue } = require('./helpers/fakeSegmentFfmpeg');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await engine.tick(); await sleep(50); }
    assert.fail(`timed out waiting for: ${label}`);
}

// ---- the provider: MPEG-TS packets with a running counter, a PAT every 20 ----------------
let connections = {};
const sent = {}; // path -> every byte sent on its FIRST connection
let seq = 0;
function packet(pid, n) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47; p[1] = (pid === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f); p[2] = pid & 0xff; p[3] = 0x10 | (n & 0x0f);
    p.writeUInt32BE(n, 4);
    return p;
}
let server, base;

// ---- ffmpeg: a segmented capture (-f hls) like ffmpeg's; from pipe:0 every byte of stdin goes into its segment ----
const argsLog = path.join(sandbox, 'ffmpeg-args.log');
const stallFlag = path.join(sandbox, 'ffmpeg-stall'); // while it exists, the fake reads nothing: its input queues up
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const out = args[args.length - 1];
const dir = path.dirname(out);
const putPlaylist = (text) => { fs.writeFileSync(out + '.tmp', text); fs.renameSync(out + '.tmp', out); };
// The watch copy (-live_start_index) is not a capture: it idles until it is stopped.
if (args.includes('-live_start_index')) { setInterval(() => {}, 1000); return; }
let pl = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n';
if (args[args.indexOf('-i') + 1] === 'pipe:0') {
  // The shared feed: its bytes, exactly as fed, in one segment; the end of input ends the capture (exit 0).
  const file = fs.createWriteStream(path.join(dir, 'a000000.ts'));
  let listed = false;
  const stall = ${JSON.stringify(stallFlag)};
  const reading = () => { if (fs.existsSync(stall)) { process.stdin.pause(); setTimeout(reading, 50); } else process.stdin.resume(); };
  process.stdin.on('data', (d) => {
    file.write(d);
    if (!listed) { listed = true; pl += '#EXTINF:4.000000,\\na000000.ts\\n'; putPlaylist(pl); }
    if (fs.existsSync(stall)) reading();
  });
  process.stdin.on('end', () => file.end(() => { putPlaylist(pl + '#EXT-X-ENDLIST\\n'); process.exit(0); }));
} else {
  // Its own connection: a segment every 60 ms; "q" ends it.
  let n = 0;
  const segment = () => {
    const name = 'a' + String(n++).padStart(6, '0') + '.ts';
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(3000));
    pl += '#EXTINF:4.000000,\\n' + name + '\\n';
    putPlaylist(pl);
  };
  segment();
  setInterval(segment, 60);
  process.stdin.on('data', (d) => { if (String(d).includes('q')) { putPlaylist(pl + '#EXT-X-ENDLIST\\n'); process.exit(0); } });
}
`);
fs.chmodSync(FFMPEG, 0o755);
const captures = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    .filter(a => !a.includes('-live_start_index')); // not the watch copy

let A;
before(async () => {
    server = http.createServer((req, res) => {
        const p = req.url;
        connections[p] = (connections[p] || 0) + 1;
        if (p.startsWith('/html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>' + 'x'.repeat(4000)); }
        if (p.startsWith('/dies') && connections[p] > 1) { req.socket.destroy(); return; } // gone for good
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const first = connections[p] === 1;
        if (first) sent[p] = [];
        const timer = setInterval(() => {
            const chunk = Buffer.concat(Array.from({ length: 30 }, () => { const n = seq++; return packet(n % 20 === 0 ? 0 : 256, n); }));
            if (first) sent[p].push(chunk);
            res.write(chunk);
        }, 20);
        if (p.startsWith('/dies')) setTimeout(() => { clearInterval(timer); req.socket.destroy(); }, 400);
        // #274: its first connection goes silent after 400 ms and stays open; a reconnect is healthy.
        if (p.startsWith('/quiet') && first) setTimeout(() => clearInterval(timer), 400);
        res.on('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    item.run(`${A.id}:pos_1`, A.id, 'pos_1', 'Fox Footy', 1, 'ff', `${base}/ff.ts`);
    item.run(`${A.id}:pos_2`, A.id, 'pos_2', 'Fox League', 2, 'fl', `${base}/fl.ts`);
    item.run(`${A.id}:pos_3`, A.id, 'pos_3', 'Odd', 3, 'odd', `${base}/html`);
    item.run(`${A.id}:pos_4`, A.id, 'pos_4', 'Shaky', 4, 'shaky', `${base}/dies.ts`);
    item.run(`${A.id}:pos_5`, A.id, 'pos_5', 'Quiet', 5, 'quiet', `${base}/quiet.ts`);
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5,
        maxProviderStreams: 1, sharedIngestEnabled: true });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown();
    stubNativeTools(engine); // the remux and its checks at the end of a recording are stood in for
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) { await engine.cancelScheduled(s.id); scheduled.setStatus(s.id, 'cancelled'); }
    await drainSegmentQueue(segments, recordings); // what a test left to finish is finished before the next
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    ingest.closeAll('test over');
    connections = {};
    try { fs.unlinkSync(argsLog); } catch { /* none */ }
    await db.settings.update({ sharedIngestEnabled: true });
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function due(item = 'pos_1', stable = 'ff', windowMs = 60000) {
    const now = Date.now();
    return scheduled.create({ title: `Show ${++n}`, description: null, source_id: A.id, channel_item_id: item, channel_stable_id: stable,
        channel_name: item, channel_logo: null, program_start: now - 1000, program_end: now + windowMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
const rowOf = (s) => recordings.listBySchedule(s.id)[0];
/** The segment the fake writes the feed into, for the recording's epoch `e` (1: its first run). */
const segmentOf = (s, e = 1) => (rowOf(s)?.work_dir ? path.join(rowOf(s).work_dir, `e${e}`, 'a000000.ts') : '');
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
/** The MP4 is made right after a capture ends (and the work folder removed): held while a test reads the segments. */
async function holdingTheMp4(work) {
    const realQueue = segments.processQueue;
    segments.processQueue = async () => {};
    try { return await work(); } finally { segments.processQueue = realQueue; }
}

test('switch on: the capture reads pipe:0 with the segmented output arguments, exactly these, and the segment is the provider\'s own bytes', async () => {
    const s = due();
    await until(() => captures().length === 1 && sizeOf(segmentOf(s)) > 20000, 'recording');
    const epoch = path.join(rowOf(s).work_dir, 'e1');
    // The URL form, less the provider-facing input options (the ingest connects and reconnects): pinned whole, so a
    // refactor of the capture arguments is provably identical (recording-segments.test.js pins the URL form).
    assert.deepEqual(captures()[0], ['-y', '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?', '-ignore_unknown', '-sn', '-dn', '-c', 'copy',
        '-avoid_negative_ts', 'make_non_negative', '-output_ts_offset', '0.000', '-f', 'hls', '-hls_time', '4',
        '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'mpegts', '-hls_segment_filename', path.join(epoch, 'a%06d.ts'), path.join(epoch, 'archive.m3u8')]);
    const segment = await holdingTheMp4(async () => {
        await engine.cancelScheduled(s.id);
        await until(() => rowOf(s).segment_state === 'finishing', 'the capture ended by end of input');
        return fs.readFileSync(segmentOf(s));
    });
    assert.equal(segment.length % 188, 0);
    const provider = Buffer.concat(sent['/ff.ts']);
    assert.ok(provider.indexOf(segment.subarray(0, 188 * 50)) >= 0, 'the segment\'s bytes are the provider\'s, in order');
    assert.ok(provider.indexOf(segment.subarray(-188 * 50)) >= 0, 'to its end');
    assert.equal(((segment[1] & 0x1f) << 8) | segment[2], 0, 'it starts at a PAT');
    assert.equal(connections['/ff.ts'], 1);
    await until(() => rowOf(s).status === 'completed', 'its MP4 made');
});

test('two recordings of one channel share one connection, even at a limit of 1; a different channel is another connection', async () => {
    const one = due();
    await until(() => recordings.listBySchedule(one.id)[0]?.status === 'recording', 'first');
    const two = due();
    await until(() => recordings.listBySchedule(two.id)[0]?.status === 'recording', 'second, on the same ingest');
    assert.equal(connections['/ff.ts'], 1, 'one provider connection for both');
    const active = engine.listActive().filter(r => r.ingestKey);
    assert.equal(active.length, 2);
    assert.equal(active[0].ingestKey, active[1].ingestKey);
    assert.equal(coordinator.canRecordFreely(A.id, await db.settings.get()), false, 'the connection is in use');
    // Without a backup provider, recordings do not count against each other (maxConcurrentRecordings
    // does that, as today): a different channel records too, on its own connection and ingest.
    const other = due('pos_2', 'fl');
    await until(() => recordings.listBySchedule(other.id)[0]?.status === 'recording', 'the other channel');
    assert.equal(connections['/fl.ts'], 1, 'its own connection');
    const keys = new Set(engine.listActive().map(r => r.ingestKey));
    assert.equal(keys.size, 2, 'its own ingest');
    assert.equal(connections['/ff.ts'], 1, 'still one for the shared channel');
});

test('a stream that is not MPEG-TS falls back to its own connection', async () => {
    const s = due('pos_3', 'odd');
    await until(() => captures().length === 1, 'started');
    const args = captures()[0];
    assert.equal(args[args.indexOf('-i') + 1], `${base}/html`, 'its own connection');
    assert.ok(args.includes('-reconnect'));
    await engine.cancelScheduled(s.id);
});

test('switch off: its own connection, no ingest', async () => {
    await db.settings.update({ sharedIngestEnabled: false });
    const s = due();
    await until(() => captures().length === 1, 'started');
    const args = captures()[0];
    assert.equal(args[args.indexOf('-i') + 1], `${base}/ff.ts`);
    assert.deepEqual(ingest.list(), []);
    await engine.cancelScheduled(s.id);
});

test('the pool counts recordings on one ingest as one connection', async () => {
    const settings = { ...(await db.settings.get()), maxProviderStreams: 2 };
    const row = (id, ingestKey) => ({ id, source_id: A.id, providerId: A.id, ...(ingestKey ? { ingestKey } : {}) });
    // C-2: the coordinator's one recordings source, set to these rows for the test, the engine's again after.
    const withRows = (rows) => { coordinator.setRecordingsSource(() => rows); return coordinator.canRecordFreely(A.id, settings); };
    try {
        assert.equal(withRows([row(1, 'k'), row(2, 'k')]), true, 'two on one ingest: one of two connections used');
        assert.equal(withRows([row(1, 'k'), row(2, 'j')]), false, 'two ingests: both used');
        assert.equal(withRows([row(1), row(2)]), false, 'without an ingest, as today');
    } finally { coordinator.setRecordingsSource(engine.listActive); }
});

test('a provider that dies for good: the ingest gives up, the recording goes on in the same row on its own connection, and what it captured is kept', async () => {
    ingest.tuning.reconnectMs = 1500;
    try {
        const s = due('pos_4', 'shaky');
        await until(() => sizeOf(segmentOf(s)) > 1024, 'some data');
        const rec = rowOf(s);
        // 0499 (#260): a capture that ends early continues in a second run of the same recording; with the shared feed
        // gone for good it connects by itself (a provider that keeps failing is retried up to 20 times).
        await until(() => captures().length === 2, 'its second run', 15000);
        assert.ok(connections['/dies.ts'] >= 2, 'the ingest tried to reconnect');
        assert.deepEqual(ingest.list(), [], 'and gave up');
        const second = captures()[1];
        assert.equal(second[second.indexOf('-i') + 1], `${base}/dies.ts`, 'its own connection');
        assert.equal(second[second.length - 1], path.join(rec.work_dir, 'e2', 'archive.m3u8'), 'into the same recording');
        assert.deepEqual(recordings.listBySchedule(s.id).map(r => r.id), [rec.id], 'one row');
        await holdingTheMp4(async () => {
            await engine.cancelScheduled(s.id);
            await until(() => !engine.listActive().some(r => r.id === s.id), 'nothing captures');
            assert.equal(recordings.getById(rec.id).segment_state, 'finishing', 'not lost: it waits for its MP4');
            assert.ok(sizeOf(segmentOf(s, 1)) > 1024, 'what the shared feed gave is kept');
        });
        await until(() => recordings.getById(rec.id).status === 'completed', 'finished with it');
        assert.equal(recordings.getById(rec.id).segment_state, 'done');
    } finally {
        ingest.tuning.reconnectMs = 10000;
    }
});

// #274 (D-10): every recording's part is watched for a stall now, with one provider too. A silent shared feed is the
// ingest's to judge (it reconnects, or ends the feed, which ends the part once): the recording's watchdog acting on the
// same silence would end the part and then, its resume joining the same ingest, the next one as well.
test('#274: a single-provider recording on a silent shared feed is left to the ingest, which reconnects; the part goes on', async () => {
    const tuning = engine._failoverTuning;
    const saved = { ...tuning };
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warned.push(a.join(' ')); realWarn(...a); };
    const behindMs = ingest.tuning.behindMs;
    tuning.stallMs = 1000; // far shorter than the ingest's own rule below
    ingest.tuning.behindMs = 3000;
    try {
        const s = due('pos_5', 'quiet');
        await until(() => sizeOf(segmentOf(s)) > 1024, 'some data');
        await until(() => connections['/quiet.ts'] >= 2, 'the ingest reconnected', 15000);
        const at = sizeOf(segmentOf(s));
        await until(() => sizeOf(segmentOf(s)) > at, 'the same part grows again');
        assert.equal(captures().length, 1, 'one run: the part was not ended for the feed\'s silence');
        assert.ok(!warned.some(l => /has had no data/.test(l)), 'no stall of the recording');
        assert.equal(engine._stallWatchCount(), 1, 'still watched');
        await engine.cancelScheduled(s.id);
    } finally {
        Object.assign(tuning, saved);
        ingest.tuning.behindMs = behindMs;
        console.warn = realWarn;
    }
});

test('#274: a single-provider recording whose ffmpeg stops reading a shared feed that still delivers is ended and continued', async () => {
    const tuning = engine._failoverTuning;
    const saved = { ...tuning };
    tuning.stallMs = 1000;
    tuning.endGraceMs = 0;
    try {
        const s = due();
        await until(() => sizeOf(segmentOf(s)) > 1024, 'some data');
        fs.writeFileSync(stallFlag, '1'); // ffmpeg reads nothing more: its segment stops growing while the feed delivers
        try {
            await until(() => captures().length === 2, 'continued after the stall', 15000);
        } finally {
            fs.unlinkSync(stallFlag);
        }
        assert.match(recordings.getById(rowOf(s).id).error || '', /^Gaps: 1, .*no data/);
        assert.equal(recordings.listBySchedule(s.id).length, 1, 'one recording');
        await engine.cancelScheduled(s.id);
    } finally {
        Object.assign(tuning, saved);
    }
});

test('a feed that ends hands ffmpeg every byte it had queued before stdin closes', async () => {
    const s = due();
    await until(() => engine.listActive().some(r => r.id === s.id && r.ingestKey), 'on the ingest');
    await until(() => sizeOf(segmentOf(s)) > 50000, 'some data');
    const [live] = ingest.list();
    const reader = ingest._registry.values().next().value;
    const [feed] = reader.subs; // the recording's subscription
    const segment = await holdingTheMp4(async () => {
        // ffmpeg falls behind (0224: what is queued when the feed ends must still reach it), then the feed ends.
        fs.writeFileSync(stallFlag, '1');
        try {
            await sleep(1000);
            assert.ok(feed.readableLength > 0, 'bytes are queued for ffmpeg');
            reader.close('test: upstream gone', { providerReason: true, reason: 'upstream-lost' });
        } finally {
            fs.unlinkSync(stallFlag);
        }
        // Its first run's ffmpeg ends with its input (the recording then goes on in a second run).
        await until(() => fs.readFileSync(path.join(rowOf(s).work_dir, 'e1', 'archive.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'), 'the first run ended');
        const bytes = fs.readFileSync(segmentOf(s));
        await engine.cancelScheduled(s.id);
        return bytes;
    });
    assert.equal(segment.length, feed.bytesOut, 'every byte the feed was given reached ffmpeg');
    assert.equal(segment.length % 188, 0, 'whole packets: nothing cut mid-stream');
    assert.ok(live.subscribers.length >= 1);
    await until(() => rowOf(s).status === 'completed', 'its MP4 made');
});

// ---- DVR-4 (0232): a start that awaits its feed can be overtaken, and must then start nothing ----

/** ingest.subscribe held until the test settles it; the start is then waiting inside tick(). */
function holdSubscribe() {
    const real = ingest.subscribe;
    const held = {};
    ingest.subscribe = () => new Promise((resolve, reject) => { Object.assign(held, { resolve, reject, asked: true }); });
    held.restore = () => { ingest.subscribe = real; };
    return held;
}
function fakeFeed() {
    const { PassThrough } = require('node:stream');
    const feed = new PassThrough();
    feed.left = 0;
    feed.leave = () => { feed.left++; feed.destroy(); };
    return feed;
}
async function startsWaiting(s, held) {
    const ticking = engine.tick();
    for (let i = 0; i < 200 && !held.asked; i++) await sleep(5);
    assert.ok(held.asked, 'the start is waiting for its feed');
    return { ticking };
}

test('DVR-4: cancelled while its feed is awaited - no ffmpeg, the feed is given back, the cancel stands', async () => {
    const held = holdSubscribe();
    try {
        const s = due();
        const { ticking } = await startsWaiting(s, held);
        await engine.cancelScheduled(s.id);
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
        const feed = fakeFeed();
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0, 'no capture started');
        assert.equal(feed.left, 1, 'the late subscription is released');
        assert.equal(scheduled.getById(s.id).status, 'cancelled', 'not overwritten with recording');
        assert.equal(recordings.listBySchedule(s.id).length, 0, 'no recording row');
        assert.ok(!engine.listActive().some(r => r.id === s.id));
        assert.equal([...coordinator._leases.values()].filter(l => l.scheduleId === s.id).length, 0, 'its lease is released');
    } finally {
        held.restore();
    }
});

test('DVR-4: a viewer takes the connection while the feed is awaited - the recording waits, it does not start', async () => {
    const held = holdSubscribe();
    try {
        const s = due();
        const { ticking } = await startsWaiting(s, held);
        // A forced viewer took the lease (admitViewer releases an unbound recording lease it sacrifices).
        for (const l of coordinator._leases.values()) if (l.scheduleId === s.id) coordinator.releaseLease(l);
        const feed = fakeFeed();
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0);
        assert.equal(feed.left, 1);
        assert.notEqual(scheduled.getById(s.id).status, 'recording');
        assert.equal(recordings.listBySchedule(s.id).length, 0);
    } finally {
        held.restore();
    }
});

// 0445 (Codex 0444 round 1, high): "Change recording" (editScheduled) while a start awaits its feed. The tick started
// from its snapshot of the due row; the start must re-read the row's times and who wins its clashes.
test('0445: start-early cut while the feed is awaited, so the start is in the future - no capture, the feed and lease are given back', async () => {
    const held = holdSubscribe();
    try {
        const now = Date.now();
        const s = scheduled.create({ title: `Show ${++n}`, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 'ff',
            channel_name: 'pos_1', channel_logo: null, program_start: now + 2 * 60000, program_end: now + 60 * 60000,
            pre_buffer_min: 5, post_buffer_min: 0, created_by: 1, created_at: now }); // due: starts 3 min ago with 5 min early
        const { ticking } = await startsWaiting(s, held);
        const edit = engine.editScheduled(s.id, { pre: 0, post: null });
        assert.ok(edit.row, 'the edit is taken');
        const feed = fakeFeed();
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0, 'no capture started');
        assert.equal(feed.left, 1, 'the feed is given back');
        assert.equal(scheduled.getById(s.id).status, 'scheduled', 'still scheduled, for its new start');
        assert.equal(recordings.listBySchedule(s.id).length, 0, 'no recording row');
        assert.equal([...coordinator._leases.values()].filter(l => l.scheduleId === s.id).length, 0, 'its lease is released');
    } finally {
        held.restore();
    }
});

test('0445: finish-late made longer while the feed is awaited, so it now loses a clash - it waits for the winner instead', async () => {
    await db.settings.update({ maxConcurrentRecordings: 1 });
    const held = holdSubscribe();
    try {
        const now = Date.now();
        // The winner: another channel, made first, starting after this one's current end.
        const w = scheduled.create({ title: 'The winner', description: null, source_id: A.id, channel_item_id: 'pos_2', channel_stable_id: 'fl',
            channel_name: 'pos_2', channel_logo: null, program_start: now + 10 * 60000, program_end: now + 60 * 60000,
            pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now - 60000 });
        const s = due('pos_1', 'ff', 5 * 60000); // ends in 5 min: no clash yet
        const { ticking } = await startsWaiting(s, held);
        assert.ok(engine.editScheduled(s.id, { pre: null, post: 20 }).row, 'the edit is taken'); // now ends after w starts
        const feed = fakeFeed();
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0, 'no capture started');
        assert.equal(feed.left, 1, 'the feed is given back');
        const row = scheduled.getById(s.id);
        assert.equal(row.status, 'waiting');
        assert.equal(row.clash_winner, w.id, 'waiting for the winner');
        assert.match(row.error, /^Clashes with “The winner”/);
        assert.equal([...coordinator._leases.values()].filter(l => l.scheduleId === s.id).length, 0, 'its lease is released');
        scheduled.setStatus(w.id, 'cancelled');
    } finally {
        held.restore();
        await db.settings.update({ maxConcurrentRecordings: 5 });
    }
});

test('DVR-4: shutdown while the feed is awaited - nothing starts after stopAllActive', async () => {
    const held = holdSubscribe();
    try {
        const s = due();
        const { ticking } = await startsWaiting(s, held);
        await engine.stopAllActive(1000);
        const feed = fakeFeed();
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0);
        assert.equal(feed.left, 1);
        assert.notEqual(scheduled.getById(s.id).status, 'recording');
    } finally {
        held.restore();
    }
});
