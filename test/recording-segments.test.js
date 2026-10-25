const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// R3 (Wave 4): segmented recordings in the real engine, coordinator and routing over a sandboxed
// database. ffmpeg is a node script: as a capture (-f hls) it writes MPEG-TS segments and an
// event playlist like ffmpeg's; as the watch-copy follower it writes init.mp4 and .m4s pieces.
// The remux and its checks (recordingMedia.nativeTools) are stood in for here; the real ffmpeg
// runs the same arguments in recording-segments-media.test.js.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rec-segments-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const auth = load('auth');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const routing = load('services/providerRouting');
const segments = load('services/recordingSegments');
const recordingsDbModule = load('db/recordingsDb');
const { scheduled, recordings } = recordingsDbModule;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tuning = engine._failoverTuning;
const TUNING = { ...tuning };
const workRoot = path.join(sandbox, 'data', 'recordings-work');
// The share sits one folder down, as on Unraid (/app/recordings/SERVER01_Video/Recordings): taking
// its parent away is what an unmounted share looks like (the server never creates more than the last folder).
const mount = path.join(sandbox, 'mnt');
const share = path.join(mount, 'Recordings');

// ---- fake ffmpeg -----------------------------------------------------------------
// ok    writes a segment every 60 ms; "q" ends its playlist (ffmpeg's graceful stop) and exits
//       with a provider-looking error, so a requested stop taken for a failure would show.
// dies  writes a few segments, then the connection is reset.
const behaviourFile = path.join(sandbox, 'ffmpeg-behaviour.json');
const startsFile = path.join(sandbox, 'ffmpeg-starts.log');
const behaviour = {};
const setBehaviour = (u, kind) => { behaviour[u] = kind; fs.writeFileSync(behaviourFile, JSON.stringify(behaviour)); };
const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const out = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(startsFile)}, JSON.stringify(args) + '\\n');
if (args.includes('-live_start_index')) {
  // The watch copy: one piece per archive segment, ended when the archive is.
  const dir = path.dirname(out);
  const pieces = () => {
    const text = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '';
    const n = (text.match(/^a\\d+\\.ts$/mg) || []).length;
    fs.writeFileSync(path.join(dir, 'init.mp4'), 'init');
    let pl = '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n#EXT-X-MAP:URI="init.mp4"\\n';
    for (let i = 0; i < n; i++) { const name = 'v' + String(i).padStart(6, '0') + '.m4s'; fs.writeFileSync(path.join(dir, name), 'm4s'); pl += '#EXTINF:4.000000,\\n' + name + '\\n'; }
    if (text.includes('#EXT-X-ENDLIST')) { fs.writeFileSync(out, pl + '#EXT-X-ENDLIST\\n'); process.exit(0); }
    fs.writeFileSync(out, pl);
  };
  pieces();
  setInterval(pieces, 40);
  return;
}
let map = {};
try { map = JSON.parse(fs.readFileSync(${JSON.stringify(behaviourFile)}, 'utf8')); } catch (e) {}
const kind = map[input] || 'ok';
if (args.includes('hls')) {
  const dir = path.dirname(out);
  let n = 0;
  let pl = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n';
  const segment = () => {
    const name = 'a' + String(n++).padStart(6, '0') + '.ts';
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(3000));
    pl += '#EXTINF:4.000000,\\n' + name + '\\n';
    fs.writeFileSync(out, pl);
  };
  segment();
  setInterval(segment, 60);
  process.stdin.on('data', (d) => {
    if (!String(d).includes('q')) return;
    fs.writeFileSync(out, pl + '#EXT-X-ENDLIST\\n');
    process.stderr.write('[tcp @ 0x1] Connection reset by peer\\n');
    process.exit(1);
  });
  if (kind === 'dies') setTimeout(() => {
    process.stderr.write('[tcp @ 0x1] Connection reset by peer\\nError during demuxing: Connection reset by peer\\n');
    process.exit(1);
  }, 400);
  return;
}
// Today's capture: one growing .ts file.
fs.writeFileSync(out, Buffer.alloc(4000));
setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(0); });
`);
fs.chmodSync(FFMPEG, 0o755);
const starts = () => (fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const captures = () => starts().filter(a => !a.includes('-live_start_index'));

// The remux and the preparation checks: the output is written, and as long as the input.
const remuxed = [];
engine._nativeTools.codecs = async () => ({ video: 'hevc', audio: 'aac', audioChannels: 2 });
engine._nativeTools.duration = async () => 120;
engine._nativeTools.audioErrors = async () => 0;
engine._nativeTools.ffmpeg = async (args) => {
    remuxed.push(args);
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000));
    return { code: 0, tail: [] };
};

const logLines = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logLines.push(a.join(' ')); if (process.env.DEBUG_REC_SEGMENTS) realConsole[k](...a); };

let A, B;
const url = { A: 'http://strong.invalid/live/u/p/101.ts', B: 'http://trex.invalid/live/u/p/5001.ts' };
let server, base, token;

before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Sports 505', 'Sport', 0, 1, 's101', ?)`).run(`${A.id}:pos_1`, A.id, url.A);
    fs.mkdirSync(share, { recursive: true });
    await db.settings.update({ recordingsPath: share, minFreeSpaceGB: 0, maxConcurrentRecordings: 5, segmentedRecordings: true });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: path.join(sandbox, 'no-ffprobe') });
    engine.shutdown(); // the test drives tick() itself

    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(user);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/recordings', auth.streamAuth, load('routes/recordings'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await engine.stopAllActive(3000);
    for (const s of scheduled.listUpcoming()) {
        await engine.cancelScheduled(s.id);
        scheduled.setStatus(s.id, 'cancelled');
    }
    // Whatever the test left to finish is finished (or moved) before the next one starts.
    for (let i = 0; i < 200 && recordings.findSegmentWork().length; i++) {
        await segments.processQueue(Date.now() + 3600e3);
        await sleep(25);
    }
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    routing.reset();
    Object.assign(tuning, TUNING);
    for (const k of Object.keys(behaviour)) delete behaviour[k];
    fs.writeFileSync(behaviourFile, '{}');
    try { fs.unlinkSync(startsFile); } catch { /* none */ }
    remuxed.length = 0;
    fs.mkdirSync(share, { recursive: true });
    await db.settings.update({ recordingsPath: share, segmentedRecordings: true });
});

after(() => {
    Object.assign(console, realConsole);
    server?.closeAllConnections?.();
    server?.close();
    for (const [, f] of segments._followers) { try { f.proc?.kill?.('SIGKILL'); } catch { /* gone */ } }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
function due({ windowMs = 60000, startedAgoMs = 1000 } = {}) {
    const now = Date.now();
    return scheduled.create({ title: `Match ${++n}`, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's101',
        channel_name: 'Fox Sports 505', channel_logo: null, program_start: now - startedAgoMs, program_end: now + windowMs,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: now });
}
async function until(cond, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await engine.tick();
        await sleep(40);
    }
    assert.fail(`timed out waiting for: ${label}`);
}
const rowsOf = (scheduleId) => recordings.listBySchedule(scheduleId);
async function get(route, { auth: withAuth = 'bearer' } = {}) {
    const headers = withAuth === 'bearer' ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${base}${route}`, { headers });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* a playlist */ }
    return { status: response.status, body, type: response.headers.get('content-type') };
}

// ------------------------------------------------------------------ the switch --

test('switch off: a recording is made exactly as before (one .ts on the share, today\'s ffmpeg arguments)', async () => {
    await db.settings.update({ segmentedRecordings: false });
    const s = due();
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    assert.equal(rec.work_dir, null);
    assert.equal(rec.segment_state, null);
    assert.equal(path.dirname(path.dirname(rec.file_path)), share);
    assert.deepEqual(captures()[0], ['-y', '-user_agent', captures()[0][2], '-reconnect', '1', '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5', '-i', url.A, '-map', '0:v?', '-map', '0:a?', '-ignore_unknown', '-sn', '-dn', '-c', 'copy',
        '-avoid_negative_ts', 'make_zero', '-f', 'mpegts', rec.file_path]);
    assert.equal(engine.listRecordings().find(r => r.id === rec.id).watch_live, false);
    assert.equal(fs.existsSync(workRoot) ? fs.readdirSync(workRoot).length : 0, 0, 'nothing in appdata');
});

// ---------------------------------------------------------- recording and finishing --

test('switch on: segments in appdata under one row; watchable while recording; at the end one MP4 on the share and the work folder gone', async () => {
    const onShare = () => fs.readdirSync(share, { recursive: true }).sort();
    const before = onShare();
    const s = due({ windowMs: 1500 });
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    assert.equal(rec.work_dir, path.join(workRoot, `rec-${rec.id}`));
    assert.equal(rec.segment_state, 'capturing');
    assert.equal(rec.file_path, path.join(rec.work_dir, 'recording.m3u8'));
    assert.equal(rec.part, 1);
    const args = captures()[0];
    assert.equal(args[args.indexOf('-f') + 1], 'hls');
    assert.equal(args[args.length - 1], path.join(rec.work_dir, 'e1', 'archive.m3u8'));
    await until(() => engine.listRecordings().find(r => r.id === rec.id).watch_live === true, 'watchable');
    assert.deepEqual(onShare(), before, 'nothing on the share while recording');

    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    const done = recordings.getById(rec.id);
    assert.equal(scheduled.getById(s.id).status, 'completed');
    assert.equal(done.segment_state, 'done');
    assert.equal(done.file_path, path.join(share, 'Fox Sports 505', `${done.segment_name}.mp4`));
    assert.match(done.segment_name, /^Match \d+ - \d{4}-\d\d-\d\d \d\d-\d\d$/);
    assert.ok(fs.existsSync(done.file_path), 'the MP4 is on the share');
    assert.equal(fs.readdirSync(path.dirname(done.file_path)).filter(f => f.endsWith('.partial')).length, 0, 'renamed into place');
    // The row points at the MP4 first, then the folder goes (a crash between leaves a spare folder, never a row pointing at nothing).
    await until(() => !fs.existsSync(rec.work_dir), 'the work folder is deleted');
    assert.equal(done.native_status, 'ready', 'no second preparation');
    assert.equal(done.ad_detect_status, 'pending');
    assert.ok(done.duration_sec > 0);
    const remuxArgs = remuxed[0];
    assert.equal(remuxArgs[remuxArgs.indexOf('-i') + 1], path.join(rec.work_dir, 'recording.m3u8'), 'remuxed from every epoch\'s segments');
    const out = remuxArgs[remuxArgs.length - 1];
    assert.ok(out.startsWith(`${done.file_path}.`) && /\.\d+-[0-9a-f]{8}\.partial$/.test(out), 'written to the share under a temporary name of its own');
    assert.equal(engine.listRecordings().find(r => r.id === rec.id).watch_live, false);
});

test('the share is down at the end: the MP4 waits in appdata (playable), then moves when the share is back', async () => {
    const s = due({ windowMs: 1200 });
    await until(() => rowsOf(s.id).length === 1 && captures().length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    const away = `${mount}-away`;
    fs.renameSync(mount, away); // the share is not mounted
    try {
        await until(() => recordings.getById(rec.id).segment_state === 'moving', 'waiting to move', 10000);
        const waiting = recordings.getById(rec.id);
        assert.equal(waiting.status, 'completed', 'playable meanwhile');
        assert.equal(waiting.file_path, path.join(rec.work_dir, 'final.mp4'));
        assert.ok(fs.existsSync(waiting.file_path));
        assert.equal(scheduled.getById(s.id).status, 'completed');
        assert.deepEqual(segments.status().waitingToMove.map(r => r.id), [rec.id]);
    } finally {
        fs.renameSync(away, mount);
    }
    await segments.processQueue(Date.now()); // too soon: not retried yet
    assert.equal(recordings.getById(rec.id).segment_state, 'moving');
    await segments.processQueue(Date.now() + 16 * 60 * 1000);
    const moved = recordings.getById(rec.id);
    assert.equal(moved.segment_state, 'done');
    assert.equal(path.dirname(path.dirname(moved.file_path)), share);
    assert.ok(fs.existsSync(moved.file_path));
    assert.equal(fs.existsSync(rec.work_dir), false);
});

test('an MP4 that fails its check three times: the segments go to the share as one .ts, prepared as usual', async () => {
    const real = engine._nativeTools.duration;
    engine._nativeTools.duration = async (file) => (file.endsWith('.partial') ? 10 : 120); // the MP4 comes out short
    try {
        const s = due({ windowMs: 900 });
        await until(() => rowsOf(s.id).length === 1, 'recording');
        const [rec] = rowsOf(s.id);
        await until(() => recordings.getById(rec.id).status === 'completed', 'delivered', 15000);
        const done = recordings.getById(rec.id);
        assert.equal(remuxed.filter(args => args.includes(path.join(rec.work_dir, 'recording.m3u8'))).length, 3, 'three attempts');
        assert.equal(path.extname(done.file_path), '.ts');
        assert.ok(fs.statSync(done.file_path).size >= 3000 * 2, 'every segment joined');
        assert.equal(done.native_status, 'pending', 'preparation takes it from here');
        await until(() => !fs.existsSync(rec.work_dir), "the work folder is deleted");
    } finally {
        engine._nativeTools.duration = real;
    }
});

// --------------------------------------------- DVR-1/DVR-5: the original is never lost --

/** A segmented recording whose capture has ended (two segments of known bytes), ready for finishOne. */
function finishingRow() {
    const s = due({ windowMs: -100 });
    const rec = recordings.create({ scheduled_id: s.id, title: s.title, channel_name: s.channel_name, channel_logo: null,
        source_id: A.id, channel_item_id: 'pos_1', file_path: '', started_at: Date.now() - 60000, part: 1 });
    const workDir = segments.workDirFor(rec.id);
    fs.mkdirSync(path.join(workDir, 'e1'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'e1', 'a000000.ts'), Buffer.alloc(3000, 1));
    fs.writeFileSync(path.join(workDir, 'e1', 'a000001.ts'), Buffer.alloc(2000, 2));
    fs.writeFileSync(path.join(workDir, 'e1', 'archive.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n'
        + '#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.000000,\na000000.ts\n#EXTINF:4.000000,\na000001.ts\n#EXT-X-ENDLIST\n');
    const name = `Kept ${rec.id} - 2026-10-22 19-30`;
    recordings.setSegmentFields(rec.id, { work_dir: workDir, file_path: path.join(workDir, 'recording.m3u8'), segment_state: 'finishing',
        segment_name: name, segment_folder: 'Fox Sports 505' });
    scheduled.setStatus(s.id, 'completed', { recording_id: rec.id });
    return { rec: recordings.getById(rec.id), workDir, mp4: path.join(share, 'Fox Sports 505', `${name}.mp4`) };
}
const joined = Buffer.concat([Buffer.alloc(3000, 1), Buffer.alloc(2000, 2)]);

async function withTools(overrides, fn) {
    const saved = { ...engine._nativeTools };
    Object.assign(engine._nativeTools, overrides);
    try { return await fn(); } finally { Object.assign(engine._nativeTools, saved); }
}

for (const [label, tools] of [
    ["the segments' length cannot be read", { duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }],
    ['the audio cannot be decode-checked', { audioErrors: async (f) => (f.endsWith('.partial') ? null : 0) }]
]) {
    test(`DVR-1: ${label} - the MP4 is published and the segments are kept beside it before the work folder goes`, async () => {
        await withTools(tools, async () => {
            const { rec, workDir, mp4 } = finishingRow();
            await segments.finishOne(rec);
            const done = recordings.getById(rec.id);
            assert.equal(done.status, 'completed');
            assert.equal(done.file_path, mp4);
            assert.equal(done.segment_state, 'done');
            assert.match(done.native_error, /^Original kept: /, 'the kept state is visible');
            assert.ok(done.segment_keep);
            assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), joined, 'every segment, in order, beside the MP4');
            assert.equal(fs.existsSync(workDir), false);
            await engine.deleteRecording(rec.id);
            assert.equal(fs.existsSync(segments.keptOriginalPath(mp4)), false, 'deleting the recording deletes its kept original');
        });
    });

    test(`DVR-1: ${label} with the share down - the segments stay in appdata until they are on the share with the MP4`, async () => {
        await withTools(tools, async () => {
            const { rec, workDir, mp4 } = finishingRow();
            const away = `${mount}-away`;
            fs.renameSync(mount, away);
            try {
                await segments.finishOne(rec);
                const waiting = recordings.getById(rec.id);
                assert.equal(waiting.segment_state, 'moving');
                assert.equal(waiting.file_path, path.join(workDir, 'final.mp4'));
                assert.ok(fs.existsSync(path.join(workDir, 'e1', 'a000000.ts')), 'segments kept');
            } finally {
                fs.renameSync(away, mount);
            }
            await segments.moveOne(recordings.getById(rec.id));
            const moved = recordings.getById(rec.id);
            assert.equal(moved.segment_state, 'done');
            assert.equal(moved.file_path, mp4);
            assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), joined);
            assert.equal(fs.existsSync(workDir), false);
        });
    });
}

/** F1: the share's .ts writes fail to open (a share gone read-only), until `restore()` is called. */
function failTsWrites() {
    const real = fs.createWriteStream;
    fs.createWriteStream = function (file, ...rest) {
        if (/\.ts\.\d+-[0-9a-f]+\.partial$/.test(String(file))) {
            const { Writable } = require('node:stream');
            const w = new Writable({ write(chunk, enc, cb) { cb(); } });
            process.nextTick(() => w.destroy(Object.assign(new Error('read-only file system'), { code: 'EROFS' })));
            return w;
        }
        return real.call(this, file, ...rest);
    };
    return () => { fs.createWriteStream = real; };
}

test('DVR-1: a kept original that cannot be written keeps the segments in appdata and retries, never deleting them', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        const restore = failTsWrites();
        try { await segments.finishOne(rec); } finally { restore(); }
        let now = recordings.getById(rec.id);
        assert.equal(now.status, 'completed', 'the MP4 plays meanwhile');
        assert.equal(now.file_path, mp4);
        assert.equal(now.segment_state, 'moving');
        assert.ok(fs.existsSync(workDir), 'segments kept');
        await segments.processQueue(Date.now() + 16 * 60 * 1000);
        now = recordings.getById(rec.id);
        assert.equal(now.segment_state, 'done');
        assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), joined);
        assert.equal(fs.existsSync(workDir), false);
    });
});

test('F2: while the kept original is being copied the row waits as moving, so a restart finds and finishes it', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        const real = fs.createWriteStream;
        let seen = null;
        fs.createWriteStream = function (file, ...rest) {
            if (/\.ts\.\d+-[0-9a-f]+\.partial$/.test(String(file)) && !seen) {
                // The copy opens: this is what a restart now would find in the database.
                seen = { state: recordings.getById(rec.id).segment_state, queued: recordings.findSegmentWork().some(r => r.id === rec.id) };
                // ...and the server dies here: the copy never finishes.
                const { Writable } = require('node:stream');
                const w = new Writable({ write(c, e, cb) { cb(); } });
                process.nextTick(() => w.destroy(new Error('killed')));
                return w;
            }
            return real.call(this, file, ...rest);
        };
        try { await segments.finishOne(rec); } finally { fs.createWriteStream = real; }
        assert.deepEqual(seen, { state: 'moving', queued: true }, 'durably pending, not done');
        assert.ok(fs.existsSync(workDir));
        // After the restart the queue retries the move and only then is it done.
        await segments.processQueue(Date.now() + 16 * 60 * 1000);
        const done = recordings.getById(rec.id);
        assert.equal(done.segment_state, 'done');
        assert.deepEqual(fs.readFileSync(done.segment_original), joined);
        assert.equal(fs.existsSync(workDir), false);
        assert.equal(fs.readdirSync(path.dirname(mp4)).filter(f => f.endsWith('.partial')).length, 0, 'no partial left behind');
        await engine.deleteRecording(rec.id);
    });
});

test('F1: a file of the same name AND size that is not this recording\'s segments is never taken for its original', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        fs.mkdirSync(path.dirname(mp4), { recursive: true });
        const foreign = Buffer.alloc(joined.length, 99); // same length, other bytes
        fs.writeFileSync(segments.keptOriginalPath(mp4), foreign);
        await segments.finishOne(rec);
        const done = recordings.getById(rec.id);
        assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, 'the other file is untouched');
        assert.notEqual(done.segment_original, segments.keptOriginalPath(mp4));
        assert.deepEqual(fs.readFileSync(done.segment_original), joined, 'the real original, published under its own name');
        assert.equal(fs.existsSync(workDir), false, 'the segments go only once they are safe');
        await engine.deleteRecording(rec.id);
        assert.equal(fs.existsSync(done.segment_original), false, 'deleting the recording deletes the original it published');
        assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, '...and never the other file');
        fs.unlinkSync(segments.keptOriginalPath(mp4));
    });
});

test('F1: an identical copy left by an interrupted run is recognised by its bytes (no second copy)', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        fs.mkdirSync(path.dirname(mp4), { recursive: true });
        fs.writeFileSync(segments.keptOriginalPath(mp4), joined);
        await segments.finishOne(rec);
        assert.equal(recordings.getById(rec.id).segment_original, segments.keptOriginalPath(mp4));
        assert.deepEqual(fs.readdirSync(path.dirname(mp4)).filter(f => f.startsWith(path.basename(mp4, '.mp4')) && f.endsWith('.ts')),
            [path.basename(segments.keptOriginalPath(mp4))]);
        assert.equal(fs.existsSync(workDir), false);
        await engine.deleteRecording(rec.id);
    });
});

test('F1: a file appearing at the original\'s name while it is copied is not replaced', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, mp4 } = finishingRow();
        const real = fs.linkSync;
        let raced = false;
        fs.linkSync = function (from, to) {
            if (!raced && String(to).endsWith('.ts')) { raced = true; fs.writeFileSync(to, 'arrived meanwhile'); }
            return real.call(this, from, to);
        };
        try { await segments.finishOne(rec); } finally { fs.linkSync = real; }
        assert.ok(raced);
        assert.equal(fs.readFileSync(segments.keptOriginalPath(mp4), 'utf8'), 'arrived meanwhile');
        assert.deepEqual(fs.readFileSync(recordings.getById(rec.id).segment_original), joined);
        await engine.deleteRecording(rec.id);
        fs.unlinkSync(segments.keptOriginalPath(mp4));
    });
});

test('D1: deleting a recording whose original could not be published never deletes another file at its name', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        fs.mkdirSync(path.dirname(mp4), { recursive: true });
        const foreign = Buffer.alloc(joined.length, 99);
        fs.writeFileSync(segments.keptOriginalPath(mp4), foreign);
        const restore = failTsWrites();
        try { await segments.finishOne(rec); } finally { restore(); }
        const row = recordings.getById(rec.id);
        assert.equal(row.segment_state, 'moving');
        assert.equal(row.segment_original, null, 'nothing was published, so nothing is owned');
        await engine.deleteRecording(rec.id);
        assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, 'the other file is untouched');
        assert.equal(fs.existsSync(mp4), false, 'its own MP4 goes');
        assert.equal(fs.existsSync(workDir), false, 'and its segments');
        fs.unlinkSync(segments.keptOriginalPath(mp4));
    });
});

test('D1: deleting a recording while its original is being copied keeps the other file and leaves no copy behind', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        const folder = path.dirname(mp4);
        fs.mkdirSync(folder, { recursive: true });
        const foreign = Buffer.alloc(joined.length, 99);
        fs.writeFileSync(segments.keptOriginalPath(mp4), foreign);
        // The copy writes every byte, then waits at its end (a barrier, not a timer) while the
        // recording is deleted; only then does it close and publish.
        const real = fs.createWriteStream;
        let reached;
        const atEnd = new Promise(r => { reached = r; });
        let release;
        const gate = new Promise(r => { release = r; });
        fs.createWriteStream = function (file, ...rest) {
            if (/\.ts\.\d+-[0-9a-f]+\.partial$/.test(String(file))) {
                fs.createWriteStream = real;
                const { Writable } = require('node:stream');
                const fd = fs.openSync(file, 'wx');
                return new Writable({
                    write(chunk, enc, cb) { fs.writeSync(fd, chunk); cb(); },
                    final(cb) { reached(); gate.then(() => { fs.closeSync(fd); cb(); }); }
                });
            }
            return real.call(this, file, ...rest);
        };
        let finishing;
        try {
            finishing = segments.finishOne(rec);
            await atEnd;
        } finally { fs.createWriteStream = real; }
        assert.equal(recordings.getById(rec.id).segment_state, 'moving');
        await engine.deleteRecording(rec.id);
        release();
        await finishing;
        assert.equal(recordings.getById(rec.id), null);
        assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, 'the other file is untouched');
        assert.deepEqual(fs.readdirSync(folder).filter(f => f.startsWith(path.basename(mp4, '.mp4'))),
            [path.basename(segments.keptOriginalPath(mp4))], 'no MP4, copy or partial of the deleted recording is left');
        assert.equal(fs.existsSync(workDir), false);
        fs.unlinkSync(segments.keptOriginalPath(mp4));
    });
});

// R4-D1 (0256): 0227-0242 set 'done' before copying the kept original, so done + kept + no path proves nothing.
function legacyRow({ segmentsKept }) {
    const { rec, workDir, mp4 } = finishingRow();
    fs.mkdirSync(path.dirname(mp4), { recursive: true });
    fs.writeFileSync(mp4, 'mp4');
    recordings.setSegmentFields(rec.id, { status: 'completed', file_path: mp4, segment_state: 'done', segment_keep: 'duration unavailable', segment_original: null });
    if (!segmentsKept) fs.rmSync(workDir, { recursive: true, force: true });
    return { rec: recordings.getById(rec.id), workDir, mp4 };
}

test('R4-D1: a copy 0242 never finished (segments still in appdata) never claims another file at its name; its own original is published', async () => {
    const { rec, workDir, mp4 } = legacyRow({ segmentsKept: true });
    const foreign = Buffer.alloc(joined.length, 99); // the same size, other bytes
    fs.writeFileSync(segments.keptOriginalPath(mp4), foreign);
    await segments.recoverLegacyOriginals();
    let row = recordings.getById(rec.id);
    assert.equal(row.segment_original, null, 'not claimed');
    assert.equal(row.segment_state, 'moving', 'waits for its own copy');
    await segments.moveOne(row);
    row = recordings.getById(rec.id);
    assert.equal(row.segment_state, 'done');
    assert.notEqual(row.segment_original, segments.keptOriginalPath(mp4));
    assert.deepEqual(fs.readFileSync(row.segment_original), joined, 'its real original, under its own name');
    assert.equal(fs.existsSync(workDir), false);
    await engine.deleteRecording(rec.id);
    assert.equal(fs.existsSync(row.segment_original), false, 'its own original goes with it');
    assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, 'the other file stays');
    fs.unlinkSync(segments.keptOriginalPath(mp4));
});

test('R4-D1: a copy that finished but was never recorded (the same bytes as its segments) is claimed and deleted with it', async () => {
    const { rec, mp4 } = legacyRow({ segmentsKept: true });
    fs.writeFileSync(segments.keptOriginalPath(mp4), joined);
    await segments.recoverLegacyOriginals();
    assert.equal(recordings.getById(rec.id).segment_original, segments.keptOriginalPath(mp4));
    await engine.deleteRecording(rec.id);
    assert.equal(fs.existsSync(segments.keptOriginalPath(mp4)), false);
});

test('R4-D1: an original 0227-0241 finished (segments gone) cannot be proven: it is left in place, also on delete', async () => {
    const { rec, mp4 } = legacyRow({ segmentsKept: false });
    fs.writeFileSync(segments.keptOriginalPath(mp4), joined);
    const seen = logLines.length;
    await segments.recoverLegacyOriginals();
    assert.equal(recordings.getById(rec.id).segment_original, null);
    assert.equal(recordings.getById(rec.id).segment_state, 'done');
    assert.ok(logLines.slice(seen).some(l => l.includes(`#${rec.id}:`) && l.includes('cannot be proven')), 'reported');
    await engine.deleteRecording(rec.id);
    assert.equal(fs.existsSync(mp4), false);
    assert.ok(fs.existsSync(segments.keptOriginalPath(mp4)), 'preserved: it may be another file');
    fs.unlinkSync(segments.keptOriginalPath(mp4));
});

test('R4-D1: reopening the database after 0242 stopped mid-copy, then deleting, keeps another file at the original\'s name', async () => {
    const { rec, mp4 } = legacyRow({ segmentsKept: true });
    const foreign = Buffer.alloc(joined.length, 99);
    fs.writeFileSync(segments.keptOriginalPath(mp4), foreign);
    recordingsDbModule.__resetInitForTests();
    recordingsDbModule.initSchema(); // what a restart does first (0251-0255 claimed "<name>.ts" here)
    await engine.deleteRecording(rec.id);
    assert.deepEqual(fs.readFileSync(segments.keptOriginalPath(mp4)), foreign, 'the other file is never deleted');
    fs.unlinkSync(segments.keptOriginalPath(mp4));
});

// ---- R4-D2 (0257): a publication racing a deletion, in both orders, on every publishing path ----

/** The next .ts copy to the share writes every byte, then waits at its end until released (a barrier). */
function holdTsCopy() {
    const real = fs.createWriteStream;
    let reached, release;
    const atEnd = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    fs.createWriteStream = function (file, ...rest) {
        if (/\.ts\.\d+-[0-9a-f]+\.partial$/.test(String(file))) {
            fs.createWriteStream = real;
            const { Writable } = require('node:stream');
            const fd = fs.openSync(file, 'wx');
            return new Writable({
                write(chunk, enc, cb) { fs.writeSync(fd, chunk); cb(); },
                final(cb) { reached(); gate.then(() => { fs.closeSync(fd); cb(); }); }
            });
        }
        return real.call(this, file, ...rest);
    };
    return { atEnd, release: () => release(), restore: () => { fs.createWriteStream = real; release(); } };
}

/** deleteRecording's work-folder removal waits until released (the deletion is then still running). */
function holdRemoveWork() {
    const real = segments.removeWork;
    let entered, release;
    const inside = new Promise(r => { entered = r; });
    const gate = new Promise(r => { release = r; });
    segments.removeWork = async (r) => { entered(); await gate; return real(r); };
    return { inside, release: () => release(), restore: () => { segments.removeWork = real; release(); } };
}

/** Everything of recording `name` left in `folder` (MP4, .ts, partials). */
const leftIn = (folder, name) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter(f => f.startsWith(name)) : []);

test('R4-D2: a kept original that finishes while the deletion is still running is removed, not recorded', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, workDir, mp4 } = finishingRow();
        const copy = holdTsCopy();
        const removal = holdRemoveWork();
        try {
            const finishing = segments.finishOne(rec);
            await copy.atEnd;
            const deleting = engine.deleteRecording(rec.id);
            await removal.inside; // the deletion awaits the work folder: the row is still there
            copy.release();
            await finishing;
            assert.equal(recordings.getById(rec.id).segment_original, null, 'the late copy did not record itself');
            removal.release();
            await deleting;
        } finally { copy.restore(); removal.restore(); }
        assert.equal(recordings.getById(rec.id), null);
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'no MP4, original or partial left');
        assert.equal(fs.existsSync(workDir), false);
    });
});

for (const order of ['after', 'during']) {
    test(`R4-D2: the fallback .ts that finishes ${order} the deletion is removed, not published`, async () => {
        await withTools({ ffmpeg: async () => ({ code: 1, tail: ['failed'] }) }, async () => {
            const { rec, workDir, mp4 } = finishingRow();
            recordings.setSegmentFields(rec.id, { segment_attempts: 2 }); // the last attempt: the .ts fallback
            const copy = holdTsCopy();
            const removal = order === 'during' ? holdRemoveWork() : null;
            try {
                const finishing = segments.finishOne(recordings.getById(rec.id));
                await copy.atEnd;
                const deleting = engine.deleteRecording(rec.id);
                if (removal) await removal.inside; else await deleting;
                copy.release();
                await finishing;
                if (removal) { removal.release(); await deleting; }
            } finally { copy.restore(); if (removal) removal.restore(); }
            assert.equal(recordings.getById(rec.id), null);
            assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'nothing of it on the share');
            assert.equal(fs.existsSync(workDir), false);
        });
    });
}

test('R4-D2: an MP4 moved to the share while the deletion is still running is removed, not recorded', async () => {
    const { rec, workDir, mp4 } = finishingRow();
    const away = `${mount}-away`;
    fs.renameSync(mount, away);
    try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
    assert.equal(recordings.getById(rec.id).segment_state, 'moving', 'waiting in appdata');
    // 0267: the move copies as a stream; this holds its write at the end until released.
    const realStream = fs.createWriteStream;
    let reached, release;
    const copying = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    fs.createWriteStream = function (file, ...rest) {
        if (!/\.mp4\.\d+-[0-9a-f]+\.partial$/.test(String(file))) return realStream.call(this, file, ...rest);
        fs.createWriteStream = realStream;
        const { Writable } = require('node:stream');
        const fd = fs.openSync(file, 'wx');
        return new Writable({
            write(chunk, enc, cb) { fs.writeSync(fd, chunk); cb(); },
            final(cb) { reached(); gate.then(() => { fs.closeSync(fd); cb(); }); }
        });
    };
    const held = { restore: () => { fs.createWriteStream = realStream; } };
    const removal = holdRemoveWork();
    try {
        const moving = segments.moveOne(recordings.getById(rec.id));
        await copying;
        const deleting = engine.deleteRecording(rec.id); // retired at once; it waits for the copy (0264)
        release();
        await removal.inside;
        await moving;
        assert.ok(String(recordings.getById(rec.id).file_path).startsWith(workDir), 'the late move did not record itself');
        removal.release();
        await deleting;
    } finally { held.restore(); release(); removal.restore(); }
    assert.equal(recordings.getById(rec.id), null);
    assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'no MP4 or partial on the share');
});

test('R4-D2: an MP4 whose remux ends while the deletion is still running is never published', async () => {
    const { rec, mp4 } = finishingRow();
    const realFfmpeg = engine._nativeTools.ffmpeg;
    let reached, release;
    const remuxing = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    // 0264: a deletion kills it (the signal), as it would a real ffmpeg.
    engine._nativeTools.ffmpeg = async (args, opts = {}) => {
        reached();
        await Promise.race([gate, new Promise(r => opts.signal && opts.signal.addEventListener('abort', r, { once: true }))]);
        return opts.signal && opts.signal.aborted ? { code: 255, tail: ['killed'] } : realFfmpeg(args, opts);
    };
    const removal = holdRemoveWork();
    try {
        const finishing = segments.finishOne(rec);
        await remuxing;
        const deleting = engine.deleteRecording(rec.id);
        await removal.inside; // the remux was stopped before the deletion went on
        release();
        await finishing;
        assert.notEqual(recordings.getById(rec.id).status, 'completed', 'not completed by the late remux');
        removal.release();
        await deleting;
    } finally { engine._nativeTools.ffmpeg = realFfmpeg; release(); removal.restore(); }
    assert.equal(recordings.getById(rec.id), null);
    assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), []);
});

test('DVR-1: a fully checked MP4 keeps nothing beside it', async () => {
    const { rec, workDir, mp4 } = finishingRow();
    await segments.finishOne(rec);
    const done = recordings.getById(rec.id);
    assert.equal(done.segment_keep, null);
    assert.equal(done.native_error, null);
    assert.equal(fs.existsSync(segments.keptOriginalPath(mp4)), false);
    assert.equal(fs.existsSync(workDir), false);
});

test('DVR-5: the last-resort .ts cannot be opened on the share - no uncaught error, no completed row, segments kept', async () => {
    const uncaught = [];
    const onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
        await withTools({ duration: async (f) => (f.endsWith('.partial') ? 10 : 120) }, async () => { // the MP4 comes out short
            const { rec, workDir } = finishingRow();
            // The .ts cannot be opened for writing, as on a share gone read-only.
            const restore = failTsWrites();
            try { for (let i = 0; i < 3; i++) await segments.finishOne(recordings.getById(rec.id)); } finally { restore(); }
            await sleep(50);
            const now = recordings.getById(rec.id);
            assert.equal(now.status, 'failed');
            assert.match(now.error, /segments are kept in appdata/);
            assert.ok(fs.existsSync(path.join(workDir, 'e1', 'a000001.ts')), 'segments kept');
        });
    } finally {
        process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(uncaught, []);
});

test('DVR-5: a write that fails part-way removes the partial file and keeps the segments', async () => {
    await withTools({ duration: async (f) => (f.endsWith('.partial') ? 10 : 120) }, async () => {
        const { rec, workDir } = finishingRow();
        // A segment listed in the playlist that cannot be read mid-join (the appdata disk failing).
        fs.unlinkSync(path.join(workDir, 'e1', 'a000001.ts'));
        for (let i = 0; i < 3; i++) await segments.finishOne(recordings.getById(rec.id));
        const now = recordings.getById(rec.id);
        assert.equal(now.status, 'failed');
        assert.ok(fs.existsSync(path.join(workDir, 'e1', 'a000000.ts')));
        assert.deepEqual(fs.readdirSync(path.join(share, 'Fox Sports 505')).filter(f => f.startsWith(rec.segment_name)), [], 'no partial left');
    });
});

// ------------------------------------------------------------ failover and restart --

test('provider dies mid-recording with a backup: the same recording continues in a second epoch (no part 2)', async () => {
    B = B || await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    const d = sqlite.getDb();
    if (!d.prepare('SELECT 1 FROM backup_channels WHERE source_id = ?').get(B.id)) {
        d.prepare('INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, ?, ?, ?)').run(B.id, '5001', 'Trex 5001', null);
        d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
                   VALUES (?, 's101', ?, '5001', 'exact', 'auto', 1, 100, ?)`).run(A.id, B.id, Date.now());
    }
    try {
        tuning.startFailoverMs = 200;
        tuning.endGraceMs = 0;
        setBehaviour(url.A, 'dies');
        const s = due({ windowMs: 3000 });
        await until(() => captures().length === 2 && engine.listActive().some(r => r.id === s.id && r.providerId === B.id), 'continued on the backup');
        const rows = rowsOf(s.id);
        assert.equal(rows.length, 1, 'one recording, not parts');
        const rec = rows[0];
        assert.equal(rec.provider_id, B.id);
        assert.equal(rec.segment_state, 'capturing');
        assert.match(rec.error, /^Gaps: 1, \d+ s in all \(the last: the provider dropped out\)\.$/);
        assert.equal(rec.is_partial, 1);
        const second = captures()[1];
        assert.equal(second[second.length - 1], path.join(rec.work_dir, 'e2', 'archive.m3u8'), 'a new epoch in the same folder');
        assert.ok(Number(second[second.indexOf('-output_ts_offset') + 1]) > 0, 'its timeline continues after the first');
        assert.ok(fs.readFileSync(path.join(rec.work_dir, 'e1', 'archive.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'), 'the first epoch is sealed');
        await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
        assert.equal(rowsOf(s.id).length, 1);
        for (const line of logLines) assert.ok(!line.includes('/u/p/'), `a log line carries a stream address: ${line}`);
    } finally {
        await db.sources.update(B.id, { enabled: false });
    }
});

/** A schedule and a segmented row as a server that stopped mid-recording left them. */
function leftByACrash({ windowMs }) {
    const s = due({ windowMs });
    const rec = recordings.create({ scheduled_id: s.id, title: s.title, channel_name: s.channel_name, channel_logo: null,
        source_id: A.id, channel_item_id: 'pos_1', file_path: '', started_at: Date.now() - 60000, part: 1 });
    const workDir = segments.workDirFor(rec.id);
    fs.mkdirSync(path.join(workDir, 'e1'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'e1', 'a000000.ts'), Buffer.alloc(3000));
    fs.writeFileSync(path.join(workDir, 'e1', 'archive.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.000000,\na000000.ts\n');
    recordings.setSegmentFields(rec.id, { work_dir: workDir, file_path: path.join(workDir, 'recording.m3u8'), segment_state: 'capturing',
        segment_name: `${s.title} - 2026-10-16 19-30`, segment_folder: 'Fox Sports 505' });
    scheduled.setStatus(s.id, 'recording', { recording_id: rec.id });
    return { s, rec: recordings.getById(rec.id), workDir };
}

test('server restart mid-recording: the same recording continues in a new epoch, the gap noted', async () => {
    tuning.endGraceMs = 0;
    const { s, rec, workDir } = leftByACrash({ windowMs: 20000 });
    engine._reconcileOnStartup();
    assert.ok(fs.readFileSync(path.join(workDir, 'e1', 'archive.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'), 'sealed');
    assert.equal(scheduled.getById(s.id).status, 'recording', 'not failed, as it used to be');
    await until(() => captures().length === 1, 'resumed');
    const args = captures()[0];
    assert.equal(args[args.length - 1], path.join(workDir, 'e2', 'archive.m3u8'));
    assert.equal(args[args.indexOf('-output_ts_offset') + 1], '4.000');
    const now = recordings.getById(rec.id);
    assert.equal(now.segment_state, 'capturing');
    assert.match(now.error, /the server restarted/);
    assert.equal(rowsOf(s.id).length, 1);
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
});

test('DVR-4: cancelled while a resumed segmented recording awaits its shared feed - no new epoch, the feed is given back', async () => {
    const ingest = load('services/ingest');
    const real = ingest.subscribe;
    const held = {};
    ingest.subscribe = () => new Promise((resolve) => Object.assign(held, { resolve, asked: true }));
    await db.settings.update({ sharedIngestEnabled: true });
    try {
        tuning.endGraceMs = 0;
        const { s, rec, workDir } = leftByACrash({ windowMs: 20000 });
        engine._reconcileOnStartup();
        const ticking = engine.tick();
        for (let i = 0; i < 200 && !held.asked; i++) await sleep(5);
        assert.ok(held.asked, 'the continuation is waiting for its feed');
        await engine.cancelScheduled(s.id);
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
        const { PassThrough } = require('node:stream');
        const feed = new PassThrough();
        let left = 0;
        feed.leave = () => { left++; feed.destroy(); };
        held.resolve(feed);
        await ticking;
        await sleep(200);
        assert.equal(captures().length, 0, 'no new epoch');
        assert.equal(left, 1);
        assert.equal(fs.existsSync(path.join(workDir, 'e2')), false);
        assert.equal(scheduled.getById(s.id).status, 'cancelled');
        assert.notEqual(recordings.getById(rec.id).segment_state, 'capturing');
    } finally {
        ingest.subscribe = real;
        await db.settings.update({ sharedIngestEnabled: false });
    }
});

test('server restart after the recording\'s time: what it recorded becomes its MP4', async () => {
    const { s, rec } = leftByACrash({ windowMs: -100 });
    engine._reconcileOnStartup();
    assert.equal(scheduled.getById(s.id).status, 'completed');
    assert.equal(recordings.getById(rec.id).segment_state, 'finishing');
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished');
    assert.equal(captures().length, 0, 'not resumed');
});

test('deleting a segmented recording stops it and deletes its appdata folder', async () => {
    const s = due();
    await until(() => rowsOf(s.id).length === 1 && captures().length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    assert.ok(fs.existsSync(rec.work_dir));
    await engine.deleteRecording(rec.id);
    assert.equal(fs.existsSync(rec.work_dir), false);
    assert.equal(recordings.getById(rec.id), null);
    assert.equal(segments.isWorkDir(path.join(workRoot, '..')), false, 'never anything above a recording\'s own folder');
});

// --------------------------------------------------------------------------- routes --

test('watch from the start: auth, the master and media playlists (token on every URI), the pieces, and the allow-list', async () => {
    const s = due();
    await until(() => rowsOf(s.id).length === 1 && engine.listRecordings().find(r => r.scheduled_id === s.id)?.watch_live, 'watchable');
    const [rec] = rowsOf(s.id);

    assert.equal((await get(`/api/recordings/${rec.id}/watch`, { auth: 'none' })).status, 401);
    const watch = await get(`/api/recordings/${rec.id}/watch`);
    assert.equal(watch.status, 200, JSON.stringify(watch.body));
    assert.equal(watch.body.url, `/api/recordings/${rec.id}/live/master.m3u8`);
    assert.equal(watch.body.container, 'hls');
    assert.equal(watch.body.recording, true);
    assert.equal(watch.body.videoRange, 'SDR');

    assert.equal((await get(`/api/recordings/${rec.id}/live/master.m3u8`, { auth: 'none' })).status, 401);
    const master = await get(`/api/recordings/${rec.id}/live/master.m3u8?token=${token}`, { auth: 'none' });
    assert.equal(master.status, 200);
    assert.match(master.body, /#EXT-X-STREAM-INF:.*VIDEO-RANGE=SDR/);
    assert.match(master.body, new RegExp(`^stream\\.m3u8\\?token=${token}$`, 'm'));

    await until(async () => /v000000\.m4s/.test((await get(`/api/recordings/${rec.id}/live/stream.m3u8?token=${token}`, { auth: 'none' })).body), 'the watch copy');
    const media = await get(`/api/recordings/${rec.id}/live/stream.m3u8?token=${token}`, { auth: 'none' });
    assert.match(media.type, /mpegurl/);
    assert.match(media.body, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    assert.match(media.body, /#EXT-X-START:TIME-OFFSET=0\.0/);
    assert.doesNotMatch(media.body, /#EXT-X-ENDLIST/, 'still recording');
    assert.match(media.body, new RegExp(`#EXT-X-MAP:URI="e1/init\\.mp4\\?token=${token}"`));
    for (const line of media.body.split('\n').filter(l => l && !l.startsWith('#'))) assert.match(line, /^e1\/v\d{6}\.m4s\?token=/);

    const piece = await fetch(`${base}/api/recordings/${rec.id}/live/e1/v000000.m4s?token=${token}`);
    assert.equal(piece.status, 200);
    assert.equal(piece.headers.get('content-type'), 'video/MP2T');
    for (const bad of ['e1/a000000.ts', 'e1/archive.m3u8', 'x1/init.mp4', 'e1/..%2F..%2Frecording.m3u8', '..%2Fe1/init.mp4']) {
        const r = await fetch(`${base}/api/recordings/${rec.id}/live/${bad}?token=${token}`);
        assert.equal(r.status, 404, `${bad} is refused`);
    }
    assert.equal((await fetch(`${base}/api/recordings/${rec.id}/live/e1/init.mp4`)).status, 401, 'no token, no piece');

    // A recording made the usual way cannot be watched like this.
    await db.settings.update({ segmentedRecordings: false });
    const plain = due();
    await until(() => rowsOf(plain.id).length === 1, 'a plain recording');
    const no = await get(`/api/recordings/${rowsOf(plain.id)[0].id}/watch`);
    assert.equal(no.status, 409);
    assert.equal(no.body.finished, false);
    assert.equal((await get(`/api/recordings/${rowsOf(plain.id)[0].id}/live/stream.m3u8?token=${token}`, { auth: 'none' })).status, 404);

    // Finished: the playlist answers 404 and /watch says to play the recording instead.
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    const finished = await get(`/api/recordings/${rec.id}/watch`);
    assert.equal(finished.status, 409);
    assert.equal(finished.body.finished, true);
    assert.equal((await get(`/api/recordings/${rec.id}/live/stream.m3u8?token=${token}`, { auth: 'none' })).status, 404);
});

test('/api/info lists recordingWatchLive; Status shows the appdata folder', async () => {
    const info = await get('/api/info');
    assert.equal(info.body.features.recordingWatchLive, true);
    const st = segments.status();
    assert.ok(Number.isFinite(st.freeBytes));
    assert.deepEqual(Object.keys(st).sort(), ['capturing', 'failed', 'finishing', 'freeBytes', 'waitingToMove']);
});

// ---- Codex adversarial review of 0261 (25 Oct): once a deletion has returned nothing of it is being
// written or left on the share, so a restart cannot strand a late partial.

test('C2: a deletion during the MP4 remux stops ffmpeg and returns only once its partial is gone', async () => {
    const { rec, mp4 } = finishingRow();
    const realFfmpeg = engine._nativeTools.ffmpeg;
    let reached, release, killed = false;
    const remuxing = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    engine._nativeTools.ffmpeg = async (args, opts = {}) => {
        fs.writeFileSync(args.at(-1), 'first bytes'); // ffmpeg opens its output at once
        reached();
        await Promise.race([gate, new Promise(r => opts.signal && opts.signal.addEventListener('abort', r, { once: true }))]);
        if (opts.signal && opts.signal.aborted) {
            killed = true;
            await new Promise(r => setTimeout(r, 30));
            fs.appendFileSync(args.at(-1), 'last bytes'); // it writes once more as it dies
            return { code: 255, tail: ['killed'] };
        }
        return realFfmpeg(args, opts);
    };
    let finishing;
    try {
        finishing = segments.finishOne(rec);
        await remuxing;
        await engine.deleteRecording(rec.id);
        assert.equal(killed, true, 'the deletion stopped the writer');
        assert.equal(recordings.getById(rec.id), null);
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'nothing on the share when the deletion returns');
    } finally { release(); await finishing; engine._nativeTools.ffmpeg = realFfmpeg; }
});

test('C2: a deletion during the last-resort .ts copy stops it and returns only once its partial is gone', async () => {
    await withTools({ ffmpeg: async () => ({ code: 1, tail: ['failed'] }) }, async () => {
        const { rec, mp4 } = finishingRow();
        recordings.setSegmentFields(rec.id, { segment_attempts: 2 }); // the last attempt: the .ts fallback
        const copy = holdTsCopy();
        let finishing;
        try {
            finishing = segments.finishOne(recordings.getById(rec.id));
            await copy.atEnd; // every byte written, the partial still open
            await engine.deleteRecording(rec.id);
            assert.equal(recordings.getById(rec.id), null);
            assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'nothing on the share when the deletion returns');
        } finally { copy.restore(); await finishing; }
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), []);
    });
});

test('D2: a deletion during the MP4\'s audio check stops the check and completes', async () => {
    const { rec, mp4 } = finishingRow();
    const realAudio = engine._nativeTools.audioErrors;
    let reached, release, aborted = false;
    const checking = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    // A decode check that never ends by itself (a share that stopped answering), unless it is stopped.
    engine._nativeTools.audioErrors = async (file, opts = {}) => {
        if (!file.endsWith('.partial')) return 0;
        reached();
        await Promise.race([gate, new Promise(r => opts.signal && opts.signal.addEventListener('abort', r, { once: true }))]);
        aborted = Boolean(opts.signal && opts.signal.aborted);
        return null;
    };
    let finishing, deleting;
    try {
        finishing = segments.finishOne(rec);
        await checking;
        deleting = engine.deleteRecording(rec.id);
        const outcome = await Promise.race([deleting.then(() => 'deleted'), new Promise(r => setTimeout(() => r('still waiting'), 5000))]);
        assert.equal(outcome, 'deleted', 'the deletion is not held by a check that cannot finish');
        assert.equal(aborted, true, 'the check was stopped');
        assert.equal(recordings.getById(rec.id), null);
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), []);
    } finally { release(); await finishing; await deleting; engine._nativeTools.audioErrors = realAudio; }
});

test('E2: a deletion during the MP4\'s move to a share that stopped answering stops the copy and completes', async () => {
    const { rec, workDir, mp4 } = finishingRow();
    const away = `${mount}-away`;
    fs.renameSync(mount, away);
    try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
    assert.equal(recordings.getById(rec.id).segment_state, 'moving', 'waiting in appdata');
    // The share takes the first bytes, then the next write's callback never comes and the stream can
    // be destroyed (a write stuck in the kernel cannot be: see REPAIR-STATUS, E2 / Codex WriteStream).
    const realCopy = fs.promises.copyFile, realStream = fs.createWriteStream;
    let reached;
    const copying = new Promise(r => { reached = r; });
    fs.promises.copyFile = async (src, dest, ...a) => { // the old path: a copy that cannot be stopped
        if (!String(dest).includes('.mp4.')) return realCopy(src, dest, ...a);
        fs.writeFileSync(dest, 'first bytes'); reached(); return new Promise(() => {});
    };
    fs.createWriteStream = function (file, ...rest) {
        if (!/\.mp4\.\d+-[0-9a-f]+\.partial$/.test(String(file))) return realStream.call(this, file, ...rest);
        const { Writable } = require('node:stream');
        fs.writeFileSync(file, 'first bytes');
        reached();
        return new Writable({ write() { /* never calls back: the share stopped answering */ } });
    };
    let moving, deleting;
    try {
        moving = segments.moveOne(recordings.getById(rec.id));
        await copying;
        deleting = engine.deleteRecording(rec.id);
        const outcome = await Promise.race([deleting.then(() => 'deleted'), new Promise(r => setTimeout(() => r('still waiting'), 5000))]);
        assert.equal(outcome, 'deleted', 'the deletion is not held by a copy that cannot finish');
        assert.equal(recordings.getById(rec.id), null);
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), [], 'no MP4 or partial on the share');
        assert.equal(fs.existsSync(workDir), false);
    } finally {
        fs.promises.copyFile = realCopy; fs.createWriteStream = realStream;
        await Promise.race([Promise.all([moving, deleting]), new Promise(r => setTimeout(r, 1000))]); // the old copy never settles
    }
});

// ---- Codex reviews of 0266/0269 (26 Oct): a copy to the share stuck in a call no stop can interrupt
// (an fs.WriteStream waits for its pending write before it closes), while the recording's own files are
// local. The deletion waits a bounded time, records what that writer made, and goes on; the file is
// removed when the writer ends or at the next start.

test('H: a deletion whose share copy cannot be stopped completes after its wait, and the partial is removed later', async () => {
    const { rec, workDir, mp4 } = finishingRow();
    const away = `${mount}-away`;
    fs.renameSync(mount, away);
    try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
    assert.equal(recordings.getById(rec.id).segment_state, 'moving');
    const realStream = fs.createWriteStream, realCopy = fs.promises.copyFile;
    let reached, unstick, partial = null;
    const copying = new Promise(r => { reached = r; });
    const stuck = new Promise(r => { unstick = r; });
    const { Writable } = require('node:stream');
    const hold = (file) => { partial = String(file); fs.writeFileSync(partial, 'first bytes'); reached(); };
    fs.createWriteStream = function (file, ...rest) {
        if (!/\.mp4\.\d+-[0-9a-f]+\.partial$/.test(String(file))) return realStream.call(this, file, ...rest);
        hold(file);
        // As fs.WriteStream: its write is in flight on a share that stopped answering, and destroying it
        // waits for that write before the stream closes.
        return new Writable({ write(chunk, enc, cb) { stuck.then(() => cb()); }, destroy(err, cb) { stuck.then(() => cb(err)); } });
    };
    fs.promises.copyFile = async (src, dest, ...a) => { // the 0266 path: a copy that never ends
        if (!String(dest).includes('.mp4.')) return realCopy(src, dest, ...a);
        hold(dest); await stuck; return realCopy(src, dest, ...a);
    };
    engine._owners?._setStopWaitMs?.(200); // absent before 0270: the old code waits as it always did
    let moving, deleting;
    try {
        moving = segments.moveOne(recordings.getById(rec.id));
        await copying;
        deleting = engine.deleteRecording(rec.id);
        const outcome = await Promise.race([deleting.then(() => 'deleted'), new Promise(r => setTimeout(() => r('still waiting'), 5000))]);
        assert.equal(outcome, 'deleted', 'the deletion completes after its bounded wait');
        assert.equal(recordings.getById(rec.id), null);
        assert.equal(fs.existsSync(workDir), false);
        const pending = sqlite.getDb().prepare('SELECT path FROM recording_cleanup WHERE recording_id = ?').all(rec.id).map(x => x.path);
        assert.deepEqual(pending, [partial], 'the stuck writer\'s partial is recorded for removal');
        assert.equal(await engine._owners.sweepCleanup(), 1, 'a start-up sweep removes it');
        assert.equal(fs.existsSync(partial), false);
        unstick(); // the share answers again: the writer ends, and leaves nothing
        await moving;
        assert.deepEqual(leftIn(path.dirname(mp4), path.basename(mp4, '.mp4')), []);
        assert.equal(sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM recording_cleanup').get().n, 0);
    } finally {
        unstick(); fs.createWriteStream = realStream; fs.promises.copyFile = realCopy; engine._owners?._setStopWaitMs?.();
        await Promise.race([Promise.all([moving, deleting]), new Promise(r => setTimeout(r, 1000))]);
    }
});

// ---- Mark, 26 Oct ("fix it, carefully"; Codex review of 0274): a finished file published under its final
// name and not yet recorded in the database is still accounted for - the start-up sweep removes it unless a
// recording points at it, and never touches a file this code did not make.

const cleanupRows = () => sqlite.getDb().prepare('SELECT path FROM recording_cleanup').all().map(x => x.path);

test('P1: a server stopped between publishing an MP4 and recording it leaves nothing the next start does not remove', async () => {
    const { rec, mp4 } = finishingRow();
    const folder = path.dirname(mp4);
    fs.mkdirSync(folder, { recursive: true });
    // The state a crash right after link() leaves: the writer's journalled partial and its new final name, one file.
    let partial;
    await engine._owners.write(rec.id, async (signal, made) => {
        partial = path.join(folder, `${path.basename(mp4)}.123-abcdef01.partial`);
        made(partial);
        fs.writeFileSync(partial, 'finished MP4');
        fs.linkSync(partial, mp4);
    });
    const someoneElses = path.join(folder, 'Somebody else.mp4');
    fs.writeFileSync(someoneElses, 'not ours');
    await engine._owners.sweepCleanup(); // the next start
    assert.equal(fs.existsSync(mp4), false, 'the unrecorded MP4 is removed with its partial');
    assert.equal(fs.existsSync(partial), false);
    assert.equal(fs.existsSync(someoneElses), true, 'a file this code did not make is never touched');
    assert.deepEqual(cleanupRows(), []);
    fs.unlinkSync(someoneElses);
});

test('P2: an MP4 published when recording it in the database fails is removed at the next start; the recording is made again', async () => {
    const { rec, mp4 } = finishingRow();
    const real = recordings.setSegmentFields;
    recordings.setSegmentFields = (id, fields) => {
        if (id === rec.id && fields.status === 'completed') throw new Error('database or disk is full');
        return real.call(recordings, id, fields);
    };
    try { await segments.finishOne(rec).catch(() => {}); } finally { recordings.setSegmentFields = real; }
    assert.equal(recordings.getById(rec.id).segment_state, 'finishing', 'not recorded as finished');
    assert.ok(fs.existsSync(mp4), 'published before the failure');
    await engine._owners.sweepCleanup();
    assert.equal(fs.existsSync(mp4), false, 'an MP4 no recording points at is removed');
    assert.deepEqual(cleanupRows(), []);
    await segments.finishOne(recordings.getById(rec.id)); // the queue tries again
    assert.equal(recordings.getById(rec.id).file_path, mp4, 'made again under its own name');
});

test('P3: a finished recording\'s MP4 is never removed by the sweep, and leaves no journal rows', async () => {
    const { rec, mp4 } = finishingRow();
    await segments.finishOne(rec);
    assert.equal(recordings.getById(rec.id).file_path, mp4);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(cleanupRows(), [], 'nothing left listed once it is recorded');
    await engine._owners.sweepCleanup();
    assert.ok(fs.existsSync(mp4));
});
