const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createFakeSegmentFfmpeg, stubNativeTools, drainSegmentQueue, until: untilWith } = require('./helpers/fakeSegmentFfmpeg');

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

const fake = createFakeSegmentFfmpeg(sandbox);
const FFMPEG = fake.path;
const { setBehaviour, starts, captures } = fake;
const remuxed = stubNativeTools(engine); // the remux and the preparation checks are stood in for

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
    await db.settings.update({ recordingsPath: share, minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
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
    await drainSegmentQueue(segments, recordings);
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    for (const id of [...coordinator._prompts.keys()]) coordinator.clearPrompt(id);
    routing.reset();
    Object.assign(tuning, TUNING);
    fake.reset();
    remuxed.length = 0;
    fs.mkdirSync(share, { recursive: true });
    await db.settings.update({ recordingsPath: share });
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
const until = (cond, label, ms) => untilWith(engine, cond, label, ms);
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

test('the capture arguments of a segmented recording are exactly these (a refactor must leave them identical)', async () => {
    const s = due();
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    const epoch = path.join(rec.work_dir, 'e1');
    const ua = captures()[0][2];
    assert.deepEqual(captures()[0], ['-y', '-user_agent', ua, '-reconnect', '1', '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5', '-i', url.A, '-map', '0:v?', '-map', '0:a?', '-ignore_unknown', '-sn', '-dn', '-c', 'copy',
        '-avoid_negative_ts', 'make_non_negative', '-output_ts_offset', '0.000', '-f', 'hls', '-hls_time', '4',
        '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'mpegts', '-hls_segment_filename', path.join(epoch, 'a%06d.ts'), path.join(epoch, 'archive.m3u8')]);
});

test('0508: a capture\'s input is built in one place: from the provider, or from the shared feed on stdin', () => {
    assert.deepEqual(segments.captureInput({ url: 'http://p.example/live/1.ts', userAgent: 'UA/1' }),
        ['-user_agent', 'UA/1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', 'http://p.example/live/1.ts']);
    assert.deepEqual(segments.captureInput({ url: 'http://p.example/live/1.ts', userAgent: 'UA/1', feed: true }), ['-i', 'pipe:0']);
});

test('0508: a capture from the shared feed never carries the provider URL, its user agent or a reconnect option', () => {
    const url = 'http://p.example/live/1.ts';
    const args = segments.captureArgs({ userAgent: 'UA/1', url, epochDir: '/tmp/e1', offsetSec: 8, feed: true });
    assert.ok(!args.some(a => a.startsWith('-reconnect') || a === '-user_agent' || a === 'UA/1' || a.includes(url)), args.join(' '));
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
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
        // #287: the link goes through shareFs (off the event loop); the file arrives just before it.
        const shareFs = load('services/shareFs');
        const real = shareFs.link;
        let raced = false;
        shareFs.link = (from, to, ...rest) => {
            if (!raced && String(to).endsWith('.ts')) { raced = true; fs.writeFileSync(to, 'arrived meanwhile'); }
            return real(from, to, ...rest);
        };
        try { await segments.finishOne(rec); } finally { shareFs.link = real; }
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
        const deleting = engine.deleteRecording(rec.id); // it waits for the copy (0264)
        // #141/#149: retired once the share has answered its check, before anything else of the deletion.
        const owners = load('services/recordingOwners');
        for (let i = 0; i < 100 && owners.owned(rec.id); i++) await new Promise(r => setTimeout(r, 10));
        assert.equal(owners.owned(rec.id), false, 'retired before the copy ends');
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

// #284: a recording on a multi-provider route whose providers all refuse at the start started a new capture back to back,
// with no pause, up to 20 times. Each provider now gets one immediate try (one pass round the route the run of short
// captures started on); after that a short capture waits for the next tick, as on a single-provider route.
url.C = 'http://third.invalid/live/u/p/7001.ts';
url.Bx = 'http://trex.invalid/live/u/p/5001.ts';
let C;
/** Strong8K (primary) with two backups, Trex then Third, both linked to the channel; disabled again by the returned function. */
async function threeProviders() {
    B = B || await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    C = C || await db.sources.create({ type: 'xtream', name: 'Third', url: 'http://third.invalid', username: 'u', password: 'p', role: 'backup', priority: 2 });
    const d = sqlite.getDb();
    for (const [src, stream, name] of [[B, '5001', 'Trex 5001'], [C, '7001', 'Third 7001']]) {
        await db.sources.update(src.id, { enabled: true });
        if (d.prepare('SELECT 1 FROM backup_channels WHERE source_id = ?').get(src.id)) continue;
        d.prepare('INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, ?, ?, ?)').run(src.id, stream, name, null);
        d.prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
                   VALUES (?, 's101', ?, ?, 'exact', 'auto', 1, 100, ?)`).run(A.id, src.id, stream, Date.now());
    }
    return async () => { await db.sources.update(B.id, { enabled: false }); await db.sources.update(C.id, { enabled: false }); };
}
const inputs = () => captures().map(a => a[a.indexOf('-i') + 1]);
/** Poll without ticking (a tick would start the next capture itself). */
async function settle(cond, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(40); }
    assert.fail(`timed out waiting for: ${label}`);
}
/** Its capture has ended and the next waits for a tick: nothing active for the schedule. */
const waiting = (id) => !engine.listActive().some(r => r.id === id);

/** Every provider fails each capture early; returns the schedule after the cap, having checked the pace on the way. */
async function failingEverywhere(kind) {
    tuning.endGraceMs = 0;
    for (const u of [url.A, url.Bx, url.C]) setBehaviour(u, kind);
    const s = due({ windowMs: 120000 });
    await engine.tick(); // starts it
    await settle(() => captures().length >= 3 && waiting(s.id), 'one capture per provider');
    await sleep(1200);
    assert.deepEqual(inputs(), [url.A, url.Bx, url.C], 'one immediate try per provider, in the route\'s order, then no more until a tick');
    // Then one capture per tick, up to the cap (20 continuations: 21 captures in all).
    for (let n = 4; n <= 21; n++) {
        await engine.tick();
        await settle(() => captures().length >= n && (waiting(s.id) || scheduled.getById(s.id).status !== 'recording'), `capture ${n}`);
        await sleep(n === 21 ? 1200 : 300);
        assert.equal(captures().length, n, `tick ${n - 3} started one capture, not more`);
    }
    await engine.tick();
    await sleep(300);
    assert.equal(captures().length, 21, 'none after the cap');
    return s;
}

test('#284: every provider of a multi-provider route refuses at the start: one immediate try each, then one per tick; failed at the cap', async () => {
    const done = await threeProviders();
    try {
        const s = await failingEverywhere('refuses');
        logLines.push(`#284 order: ${inputs().map(u => u.split('/')[2]).join(', ')}`);
        assert.deepEqual(inputs().slice(3), Array(18).fill(url.A), 'with every provider quarantined the route falls back to the primary');
        const rec = rowsOf(s.id)[0];
        assert.equal(rowsOf(s.id).length, 1, 'one recording');
        await settle(() => recordings.getById(rec.id).status === 'failed', 'failed at the cap');
        assert.equal(scheduled.getById(s.id).status, 'failed');
        assert.match(scheduled.getById(s.id).error, /^Recording failed/);
        assert.ok(logLines.some(l => l.includes(`#${rec.id} ended early`) && l.includes('has been continued 20 times; it ends here')), 'the cap is logged');
    } finally { await done(); }
});

test('#284: the same pause when each provider drops after writing a segment; completed with its segments at the cap', async () => {
    const done = await threeProviders();
    try {
        const s = await failingEverywhere('dies');
        const rec = rowsOf(s.id)[0];
        assert.equal(rowsOf(s.id).length, 1, 'one recording');
        await until(() => recordings.getById(rec.id).status === 'completed', 'completed with its segments', 15000);
        assert.equal(scheduled.getById(s.id).status, 'completed');
    } finally { await done(); }
});

test('#284: a capture that ran a minute or more and then lost its provider fails over at once (no tick)', async () => {
    const done = await threeProviders();
    const realNow = Date.now;
    try {
        tuning.endGraceMs = 0;
        setBehaviour(url.A, 'dies'); // drops after 400 ms; the clock below says it ran over a minute
        const s = due({ windowMs: 600000 });
        await engine.tick();
        await settle(() => captures().length === 1, 'the first capture');
        const shift = 61 * 1000;
        Date.now = () => realNow() + shift;
        await settle(() => captures().length === 2, 'continued at once on the next provider');
        assert.deepEqual(inputs(), [url.A, url.Bx]);
        await engine.cancelScheduled(s.id);
    } finally { Date.now = realNow; await done(); }
});

test('#284: a single-provider route that refuses at the start waits for the next tick each time (unchanged)', async () => {
    tuning.endGraceMs = 0;
    setBehaviour(url.A, 'refuses');
    const s = due({ windowMs: 60000 });
    await engine.tick();
    await settle(() => captures().length === 1 && waiting(s.id), 'the first capture ended');
    await sleep(1200);
    assert.equal(captures().length, 1, 'not continued at once');
    await engine.tick();
    await settle(() => captures().length === 2, 'continued on the tick');
    assert.deepEqual(inputs(), [url.A, url.A]);
    await engine.cancelScheduled(s.id);
});

// #260 (0499): on 8 Nov the São Paulo GP's capture ended 37 minutes into the race, during a guide sync, with no provider
// error and no backup provider configured. The recording was completed with what it had; nothing said why.
test('0499: a capture that ends early for no provider reason, with one provider: the same recording continues, and why is logged', async () => {
    tuning.endGraceMs = 0;
    setBehaviour(url.A, 'ends-once');
    const s = due({ windowMs: 20000 });
    await until(() => captures().length === 2, 'continued after the capture ended');
    const rows = rowsOf(s.id);
    assert.equal(rows.length, 1, 'one recording');
    const rec = rows[0];
    assert.equal(scheduled.getById(s.id).status, 'recording', 'not completed');
    assert.equal(rec.segment_state, 'capturing');
    const second = captures()[1];
    assert.equal(second[second.length - 1], path.join(rec.work_dir, 'e2', 'archive.m3u8'), 'a new epoch of the same recording');
    assert.match(rec.error, /^Gaps: 1, \d+ s in all \(the last: the capture ended \(ffmpeg exit 0\)\)\.$/);
    assert.ok(logLines.some(l => l.includes(`#${rec.id} ended early (ffmpeg exit 0); it continues in the same recording`)), 'why it ended is logged');
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    assert.equal(captures().length, 2, 'a requested stop is not continued');
});

// #274 (D-10): the stall check skipped every route without a backup, so a single-provider capture whose provider went
// silent without closing sat there until the hard stop. Now every part has its own watchdog; with one provider a stall
// ends the part and 0499's continuation resumes it on the same provider.
test('#274: a single-provider capture that goes silent is noticed, ended, and continues in a new epoch on the same provider', async () => {
    tuning.endGraceMs = 0;
    tuning.stallMs = 1500;
    setBehaviour(url.A, 'stall');
    const s = due({ windowMs: 60000 });
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1, 'recording');
    assert.equal(engine._stallWatchCount(), 1, 'its part is watched');
    setBehaviour(url.A, 'ok'); // the next run (the fake reads this when it starts) is healthy
    await until(() => captures().length === 2 && engine.listActive().some(r => r.id === s.id), 'continued after the stall', 15000);
    const rows = rowsOf(s.id);
    assert.equal(rows.length, 1, 'one recording');
    const rec = recordings.getById(rows[0].id);
    assert.equal(rec.segment_state, 'capturing');
    assert.equal(scheduled.getById(s.id).status, 'recording');
    assert.deepEqual(inputs(), [url.A, url.A], 'the same provider');
    assert.equal(captures()[1][captures()[1].length - 1], path.join(rec.work_dir, 'e2', 'archive.m3u8'), 'a new epoch of the same recording');
    assert.match(rec.error, /^Gaps: 1, \d+ s in all \(the last: the capture ended \(no data; .*\)\)\.$/);
    assert.ok(logLines.some(l => new RegExp(`#${rec.id} has had no data for \\d+s; ending this part`).test(l)), 'the stall is logged (no provider name with one)');
    assert.equal(routing.snapshot().providers.find(p => p.id === A.id).recentFailures, 1, 'the stall counts toward the provider\'s breaker');
    assert.equal(engine._stallWatchCount(), 1, 'one watchdog: the first part\'s went with it');
    // The first part's watchdog cannot act on the second: two more stall windows pass and it records on.
    const stallLines = logLines.filter(l => /has had no data/.test(l)).length;
    await sleep(2 * tuning.stallMs + 1000);
    assert.equal(captures().length, 2, 'no further run');
    assert.ok(engine.listActive().some(r => r.id === s.id), 'the second part still records');
    assert.equal(logLines.filter(l => /has had no data/.test(l)).length, stallLines, 'no further stall');
    await engine.cancelScheduled(s.id);
    assert.equal(engine._stallWatchCount(), 0, 'a cancel leaves no watchdog');
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
});

test('#274: a stalled part that ignores "q" is killed; asked to stop meanwhile, it is not continued', async () => {
    tuning.endGraceMs = 0;
    tuning.stallMs = 1000;
    setBehaviour(url.A, 'stall-deaf');
    const s = due({ windowMs: 60000 });
    await until(() => captures().length === 1 && rowsOf(s.id).length === 1, 'recording');
    const rec = rowsOf(s.id)[0];
    await settle(() => logLines.some(l => l.includes(`#${rec.id} has had no data`)), 'the stall noticed', 10000);
    assert.equal(engine._stallWatchCount(), 0, 'the watchdog has done its work');
    // Still running (it ignores "q"): the cancel arrives before the stall's kill, so the exit is a requested stop.
    assert.ok(engine.listActive().some(r => r.id === s.id), 'not exited yet');
    await engine.cancelScheduled(s.id);
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
    await sleep(1200);
    await engine.tick();
    assert.equal(captures().length, 1, 'a stop that was asked for is never continued');
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished with what it had', 10000);
});

test('#274: a delete or a container stop leaves no watchdog for the part', async () => {
    tuning.endGraceMs = 0;
    const s = due({ windowMs: 60000 });
    await until(() => engine.listActive().some(r => r.id === s.id), 'recording');
    assert.equal(engine._stallWatchCount(), 1);
    await engine.stopAllActive(3000, { forRestart: true });
    assert.equal(engine._stallWatchCount(), 0, 'left to resume: no watchdog');
    engine._reconcileOnStartup();
    await until(() => captures().length === 2 && engine.listActive().some(r => r.id === s.id), 'resumed');
    assert.equal(engine._stallWatchCount(), 1, 'the resumed part has its own');
    await engine.deleteRecording(rowsOf(s.id)[0].id);
    assert.equal(engine._stallWatchCount(), 0, 'a delete leaves none');
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

// 0490: on 7 Nov the weekly appdata backup stopped the container (SIGTERM) 6 minutes into a 3-hour F1
// recording. The shutdown finished it as complete, so the restart 7 minutes later had nothing to resume.
test('0490: a container stop before the end leaves the recording to resume at the next start, not finished', async () => {
    tuning.endGraceMs = 0;
    const s = due({ windowMs: 20000 });
    await until(() => engine.listActive().some(r => r.id === s.id) && captures().length === 1, 'recording');
    const rec = rowsOf(s.id)[0];
    await until(() => fs.existsSync(path.join(rec.work_dir, 'e1', 'archive.m3u8')), 'a segment written');
    await engine.stopAllActive(3000, { forRestart: true });
    assert.equal(scheduled.getById(s.id).status, 'recording', 'not completed by the shutdown');
    assert.equal(recordings.getById(rec.id).segment_state, 'capturing');
    assert.ok(fs.readFileSync(path.join(rec.work_dir, 'e1', 'archive.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'), 'its epoch is sealed');
    engine._reconcileOnStartup(); // the next start
    await until(() => captures().length === 2, 'resumed');
    const args = captures()[1];
    assert.equal(args[args.length - 1], path.join(rec.work_dir, 'e2', 'archive.m3u8'), 'a new epoch of the same recording');
    assert.match(recordings.getById(rec.id).error, /the server restarted/);
    assert.equal(rowsOf(s.id).length, 1);
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    assert.match(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8'), /stopAllActive\([^)]*forRestart: true/,
        'the SIGTERM handler asks for it');
});

// 0490 Codex round 1 (medium): a cancel and a shutdown at once. Neither order may leave the recording capturing for ever.
test('0490: a cancel already stopping it when the container stops: it is finished, not left to resume', async () => {
    tuning.endGraceMs = 0;
    const s = due({ windowMs: 20000 });
    await until(() => engine.listActive().some(r => r.id === s.id), 'recording');
    const rec = rowsOf(s.id)[0];
    await until(() => fs.existsSync(path.join(rec.work_dir, 'e1', 'archive.m3u8')), 'a segment written');
    await Promise.all([engine.cancelScheduled(s.id), engine.stopAllActive(3000, { forRestart: true })]);
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
    assert.notEqual(recordings.getById(rec.id).segment_state, 'capturing');
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
});

test('0490: cancelled after the container stop left it to resume: it is finished, not stranded', async () => {
    tuning.endGraceMs = 0;
    const s = due({ windowMs: 20000 });
    await until(() => engine.listActive().some(r => r.id === s.id), 'recording');
    const rec = rowsOf(s.id)[0];
    await until(() => fs.existsSync(path.join(rec.work_dir, 'e1', 'archive.m3u8')), 'a segment written');
    await engine.stopAllActive(3000, { forRestart: true });
    assert.equal(recordings.getById(rec.id).segment_state, 'capturing');
    await engine.cancelScheduled(s.id);
    assert.equal(scheduled.getById(s.id).status, 'cancelled');
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
});

test('0490: a container stop after the recording\'s time finishes it as before', async () => {
    tuning.endGraceMs = 0;
    const s = due({ windowMs: 1500 });
    await until(() => engine.listActive().some(r => r.id === s.id), 'recording');
    const rec = rowsOf(s.id)[0];
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_end = ?, post_buffer_min = 0 WHERE id = ?').run(Date.now() - 1000, s.id);
    await engine.stopAllActive(3000, { forRestart: true });
    assert.equal(scheduled.getById(s.id).status, 'completed');
    assert.equal(recordings.getById(rec.id).segment_state, 'finishing');
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

// #217 (0440 Codex round 1, high): a restart decided from the stored stop alone, so a sport recording whose last
// extension had just expired was finished while the score feed still said its game was on.
test('#217: server restart after a stored extension has expired, its game still live: it resumes', async () => {
    tuning.endGraceMs = 0;
    const { s, rec } = leftByACrash({ windowMs: -60000 });
    const now = Date.now();
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET sport_game_id = ?, event_stop = ? WHERE id = ?').run('espn:afl:restart', now - 1000, s.id);
    load('services/sportsDashboard').store().ingest([{ id: 'espn:afl:restart', league: 'AFL', title: 'Collingwood v Carlton', start: now - 60 * 60000,
        end: null, session: null, circuit: null, format: null, competitors: [],
        snapshot: { state: 'live', progress: {}, scores: null, situation: null } }], now);
    engine._reconcileOnStartup();
    assert.equal(scheduled.getById(s.id).status, 'recording', 'resumed, not finished');
    assert.notEqual(recordings.getById(rec.id).segment_state, 'finishing');
    await until(() => captures().length === 1, 'resumed in a new epoch');
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
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

// #17 (Mark, 4 Nov: "Copy from the start"): the watch copy started only on the first /watch and read the archive from
// its first segment, about 25x real time (measured: 15 min of 720p in 37 s on 4 cores), so "Play from live" on a game
// two hours in would land minutes behind. Every segmented recording now keeps its watch copy running while it captures.
test('#17: a segmented recording keeps its watch copy running from the start, without anyone watching', async () => {
    const s = due();
    await until(() => rowsOf(s.id).length === 1 && captures().length === 1, 'recording');
    const [rec] = rowsOf(s.id);
    await until(() => starts().some(a => a.includes('-live_start_index') && a.includes(path.join(rec.work_dir, 'e1', 'archive.m3u8'))),
        'its watch copy, with no request');
    await until(() => segments.viewPlaylist(rec.work_dir).segments > 0, 'the copy has pieces');
    await engine.cancelScheduled(s.id);
    await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
});

// #17 (0456 Codex round 1, medium): the tick awaited each watch copy's start, whose codec probe can take 30 s on a bad
// first segment: no other recording started (and no free-space stop ran) meanwhile. The copies start beside the tick.
test('#17: a watch copy whose codec probe hangs never holds up the next recording', async () => {
    const real = engine._nativeTools.codecs;
    let release;
    engine._nativeTools.codecs = () => new Promise(r => { release = () => r({ video: 'h264', audio: 'aac', audioChannels: 2 }); });
    try {
        const first = due();
        await until(() => rowsOf(first.id).length === 1 && captures().length === 1, 'the first recording');
        engine.tick(); // its watch copy's probe now hangs (not awaited: on the old code it never returns)
        await sleep(100);
        const second = due();
        await until(() => rowsOf(second.id).length === 1 && captures().length === 2, 'the second recording starts anyway');
        await engine.cancelScheduled(first.id);
        await engine.cancelScheduled(second.id);
    } finally {
        engine._nativeTools.codecs = real;
        release?.();
    }
    await until(() => !engine.listActive().length, 'both finished', 10000);
});

// #34 (AUD-PB-6): a watch copy whose ffmpeg died was started again with -y from the archive's first piece, rewriting
// view.m3u8 and the pieces already served (a shrinking EVENT playlist, which AVPlayer refuses). A restart now goes on
// from the first piece not yet copied, into a part of its own behind a discontinuity: what was served never changes.
test('#34: a watch copy that dies goes on from where it stopped; the served playlist only grows and its pieces never change', async () => {
    setBehaviour('follower', 'dies-after-3');
    try {
        const s = due();
        await until(() => rowsOf(s.id).length === 1 && captures().length === 1, 'recording');
        const [rec] = rowsOf(s.id);
        const seen = [];
        const served = new Map();
        await until(() => {
            const pl = segments.viewPlaylist(rec.work_dir).text;
            const names = pl.split('\n').filter(l => l && !l.startsWith('#'));
            seen.push(names);
            for (const n of names) {
                const body = fs.readFileSync(path.join(rec.work_dir, n), 'utf8');
                if (served.has(n)) assert.equal(body, served.get(n), `${n} never rewritten`);
                served.set(n, body);
            }
            return names.length >= 7 && /#EXT-X-DISCONTINUITY/.test(pl);
        }, 'the copy goes on past its first death', 10000);
        for (let i = 1; i < seen.length; i++) assert.deepEqual(seen[i].slice(0, seen[i - 1].length), seen[i - 1], 'the playlist only grows');
        const pl = segments.viewPlaylist(rec.work_dir).text;
        assert.match(pl, /#EXT-X-MAP:URI="e1\/init1\.mp4"/, 'the restarted part has its own init');
        assert.equal(fs.readFileSync(path.join(rec.work_dir, 'e1', 'v1-000000.m4s'), 'utf8'), 'copy of a000003.ts', 'it goes on from the fourth piece');
        await engine.cancelScheduled(s.id);
        await until(() => recordings.getById(rec.id).status === 'completed', 'finished', 10000);
    } finally { setBehaviour('follower', 'ok'); }
});

// #34: ffmpeg ignores -live_start_index on a closed playlist (measured with ffmpeg 8: a sealed 225-piece archive was
// copied whole from piece 200), so a part that starts after the archive is sealed reads its own list of the rest.
test('#34: a part started on a sealed archive reads a playlist of the pieces still to copy, closed', () => {
    const dir = fs.mkdtempSync(path.join(sandbox, 'part-'));
    const archive = (ended) => fs.writeFileSync(path.join(dir, 'archive.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n'
        + [0, 1, 2, 3, 4].map(i => `#EXTINF:4.000000,\na00000${i}.ts\n`).join('') + (ended ? '#EXT-X-ENDLIST\n' : ''));
    archive(true);
    const plan = segments._partInput(dir, { part: 1, from: 3 });
    assert.deepEqual(plan, { part: 1, from: 0, input: 'archive-from1.m3u8', mirrorFrom: 3 });
    const text = fs.readFileSync(path.join(dir, plan.input), 'utf8');
    assert.deepEqual(text.split('\n').filter(l => l && !l.startsWith('#')), ['a000003.ts', 'a000004.ts']);
    assert.match(text, /#EXT-X-ENDLIST/);
    const args = segments.viewArgs(dir, {}, plan);
    assert.equal(args[args.indexOf('-i') + 1], path.join(dir, 'archive-from1.m3u8'));
    assert.equal(args[args.length - 1], path.join(dir, 'view1.m3u8'));
});

// #34 (0471 Codex round 1, two highs): coverage was summed over every part, counting re-copied overlap as new, so a
// second partial death skipped footage; and a restart chose between the archive and a list of the rest when it
// started, so an archive sealed in between was copied whole. Each part now records where it started, and every
// restart reads its own list of the rest, kept up to date while the archive grows and closed when it is.
test('#34: two partial deaths in a row: each restart starts at the first piece the last part has not finished', () => {
    const dir = fs.mkdtempSync(path.join(sandbox, 'parts-'));
    const pieces = (n) => [...Array(n)].map((_, i) => `#EXTINF:4.000000,\na${String(i).padStart(6, '0')}.ts\n`).join('');
    fs.writeFileSync(path.join(dir, 'archive.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' + pieces(10));
    const part = (k, from, durations) => {
        fs.writeFileSync(path.join(dir, k ? `view${k}.m3u8` : 'view.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n'
            + durations.map((d, i) => `#EXTINF:${d.toFixed(6)},\nv${k ? `${k}-` : ''}${String(i).padStart(6, '0')}.m4s\n`).join(''));
        if (k) fs.writeFileSync(path.join(dir, `view${k}.from`), String(from));
    };
    part(0, 0, [4, 3]); // [0, 7): died inside piece 1
    assert.deepEqual(segments._nextPart(dir), { part: 1, from: 1 });
    part(1, 1, [4, 3]); // [4, 11): died inside piece 2
    assert.deepEqual(segments._nextPart(dir), { part: 2, from: 2 }, 'from piece 2 (8 s), never 3 (12 s)');
});

test('#34: a restart reads its own list of the rest, kept growing with the archive and closed when it is', () => {
    const dir = fs.mkdtempSync(path.join(sandbox, 'mirror-'));
    const write = (n, ended) => fs.writeFileSync(path.join(dir, 'archive.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n'
        + [...Array(n)].map((_, i) => `#EXTINF:4.000000,\na${String(i).padStart(6, '0')}.ts\n`).join('') + (ended ? '#EXT-X-ENDLIST\n' : ''));
    write(5, false);
    const plan = segments._partInput(dir, { part: 1, from: 3 });
    assert.deepEqual(plan, { part: 1, from: 0, input: 'archive-from1.m3u8', mirrorFrom: 3 }, 'open or sealed: its own list');
    const names = () => fs.readFileSync(path.join(dir, plan.input), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(names(), ['a000003.ts', 'a000004.ts']);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, plan.input), 'utf8'), /ENDLIST/, 'open: followed like a live list');
    write(7, true); // grows, then is sealed
    segments._refreshPartInput(dir, plan.input, 3);
    assert.deepEqual(names(), ['a000003.ts', 'a000004.ts', 'a000005.ts', 'a000006.ts']);
    assert.match(fs.readFileSync(path.join(dir, plan.input), 'utf8'), /#EXT-X-ENDLIST/);
    assert.equal(fs.readFileSync(path.join(dir, 'view1.from'), 'utf8'), '3', 'the part records where it started');
});

// #34 (0472 Codex round 2, high): a copy that died after its last piece, its archive then sealed, was restarted on an
// empty list, which ffmpeg refuses: the copy never ended and later epochs never showed. Nothing is left to copy: a
// sealed archive's copy is ended there without ffmpeg; an open one waits for its next piece (no failure counted).
test('#34: a copy that died after the last piece ends without ffmpeg once the archive is sealed; open, it waits', async () => {
    const work = fs.mkdtempSync(path.join(sandbox, 'whole-'));
    const e1 = path.join(work, 'e1'), e2 = path.join(work, 'e2');
    fs.mkdirSync(e1); fs.mkdirSync(e2);
    const list = (n, ended, prefix = 'a', ext = 'ts') => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n'
        + [...Array(n)].map((_, i) => `#EXTINF:4.000000,\n${prefix}${String(i).padStart(6, '0')}.${ext}\n`).join('') + (ended ? '#EXT-X-ENDLIST\n' : '');
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(e1, `a00000${i}.ts`), 'a'); fs.writeFileSync(path.join(e1, `v00000${i}.m4s`), 'v'); }
    fs.writeFileSync(path.join(e1, 'view.m3u8'), list(3, false, 'v', 'm4s')); // every piece copied, then the follower died
    fs.writeFileSync(path.join(e2, 'archive.m3u8'), list(1, true)); fs.writeFileSync(path.join(e2, 'a000000.ts'), 'a');
    fs.writeFileSync(path.join(e2, 'view.m3u8'), list(1, true, 'v', 'm4s')); fs.writeFileSync(path.join(e2, 'v000000.m4s'), 'v');
    const before = starts().length;
    fs.writeFileSync(path.join(e1, 'archive.m3u8'), list(3, false));
    await segments.ensureView({ id: 777001, work_dir: work });
    await sleep(300);
    assert.equal(starts().length, before, 'open, nothing left to copy: no ffmpeg (it waits for the next piece)');
    assert.ok(!segments._followers.get('777001:1')?.failures, 'no failure counted');
    fs.writeFileSync(path.join(e1, 'archive.m3u8'), list(3, true)); // sealed
    await segments.ensureView({ id: 777001, work_dir: work });
    await sleep(300);
    assert.equal(starts().length, before, 'sealed: still no ffmpeg on an empty list');
    const view = segments.viewPlaylist(work, { captureOver: true });
    assert.equal(view.ended, true, 'the copy is ended');
    assert.equal(view.segments, 4, 'and the next epoch shows');
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
    // (an old-style row, written directly: one .ts file on the share, no work folder, still marked recording)
    const plain = due();
    const plainFile = path.join(share, 'Match', 'Match.ts');
    fs.mkdirSync(path.dirname(plainFile), { recursive: true });
    fs.writeFileSync(plainFile, Buffer.alloc(4000));
    const old = recordings.create({ scheduled_id: plain.id, title: plain.title, channel_name: plain.channel_name, channel_logo: null,
        source_id: A.id, channel_item_id: 'pos_1', file_path: plainFile, started_at: Date.now() - 1000, part: 1 });
    assert.equal(old.work_dir, null);
    const no = await get(`/api/recordings/${old.id}/watch`);
    assert.equal(no.status, 409);
    assert.equal(no.body.finished, false);
    assert.equal((await get(`/api/recordings/${old.id}/live/stream.m3u8?token=${token}`, { auth: 'none' })).status, 404);
    recordings.setSegmentFields(old.id, { status: 'completed', ended_at: Date.now() });

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

test('#287: a move whose copy fails leaves neither its partial nor its journal row, before the move returns', async () => {
    const { rec, mp4 } = finishingRow();
    const away = `${mount}-away`;
    fs.renameSync(mount, away);
    try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
    assert.equal(recordings.getById(rec.id).segment_state, 'moving');
    const shareFs = load('services/shareFs');
    const realStat = shareFs.stat;
    const realUnlink = shareFs.unlink;
    // The copy comes out the wrong size; the share is slow to answer the removal of its partial (well past the writer's end).
    shareFs.stat = async (f, ...r) => (String(f).endsWith('.partial') ? { size: 1, mtimeMs: 0 } : realStat(f, ...r));
    shareFs.unlink = async (f, ...r) => { if (String(f).endsWith('.partial')) await sleep(1000); return realUnlink(f, ...r); };
    try {
        await segments.moveOne(recordings.getById(rec.id));
    } finally {
        shareFs.stat = realStat;
        shareFs.unlink = realUnlink;
    }
    const folder = path.dirname(mp4);
    assert.deepEqual(fs.readdirSync(folder).filter(n => n.startsWith(path.basename(mp4))), [], 'its partial is gone');
    await sleep(100);
    assert.deepEqual(cleanupRows().filter(p => p.startsWith(mp4)), [], 'and so is its journal row');
    assert.equal(recordings.getById(rec.id).segment_state, 'moving', 'it waits for the next move');
    await engine.deleteRecording(rec.id);
});

test('#287: a deletion while a failed MP4\'s partial is being removed returns only once it is gone, and leaves no journal row', async () => {
    const { rec, mp4 } = finishingRow();
    const shareFs = load('services/shareFs');
    const realUnlink = shareFs.unlink;
    let unlinking;
    const atUnlink = new Promise(r => { unlinking = r; });
    // The share is slow to answer the removal of the partial (1 s).
    shareFs.unlink = async (f, ...r) => {
        if (/\.mp4\.\d+-[0-9a-f]+\.partial$/.test(String(f))) { unlinking(); await sleep(1000); }
        return realUnlink(f, ...r);
    };
    let left = null;
    try {
        await withTools({ ffmpeg: async (args) => { fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000)); return { code: 1, tail: ['broken output'] }; } }, async () => {
            const finishing = segments.finishOne(recordings.getById(rec.id)).catch(() => {});
            await atUnlink; // the remux failed; its partial is being removed
            await engine.deleteRecording(rec.id);
            left = fs.readdirSync(path.dirname(mp4)).filter(n => n.startsWith(path.basename(mp4)));
            await finishing;
        });
    } finally {
        shareFs.unlink = realUnlink;
    }
    assert.deepEqual(left, [], 'the deletion returned only once the partial was gone');
    await sleep(100);
    assert.deepEqual(cleanupRows().filter(p => p.startsWith(mp4)), [], 'no journal row is left');
    assert.equal(recordings.getById(rec.id), null);
});

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

// ---- Codex review of 0276 (26 Oct): the sweep removes only the very file it journalled, and keeps its
// record until every name of that file is gone.

test('Q1: a journalled final file that something else has since replaced at that name is left alone', async () => {
    const { rec, mp4 } = finishingRow();
    const real = recordings.setSegmentFields;
    recordings.setSegmentFields = (id, fields) => {
        if (id === rec.id && fields.status === 'completed') throw new Error('database or disk is full');
        return real.call(recordings, id, fields);
    };
    try { await segments.finishOne(rec).catch(() => {}); } finally { recordings.setSegmentFields = real; }
    assert.ok(fs.existsSync(mp4));
    fs.unlinkSync(mp4);
    fs.writeFileSync(mp4, 'somebody else\'s file, put there since'); // a different file at the journalled name
    await engine._owners.sweepCleanup();
    assert.equal(fs.readFileSync(mp4, 'utf8'), 'somebody else\'s file, put there since', 'not the file it journalled: kept');
    assert.deepEqual(cleanupRows(), [], 'and no longer listed');
    fs.unlinkSync(mp4);
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});

test('Q2: a final name the sweep cannot remove keeps its partial listed, and the next start removes both', async () => {
    const { rec, mp4 } = finishingRow();
    const folder = path.dirname(mp4);
    fs.mkdirSync(folder, { recursive: true });
    let partial;
    await engine._owners.write(rec.id, async (signal, made) => {
        partial = path.join(folder, `${path.basename(mp4)}.123-abcdef02.partial`);
        made(partial);
        fs.writeFileSync(partial, 'finished MP4');
        fs.linkSync(partial, mp4); // stopped right after the link
    });
    const realUnlink = fs.promises.unlink;
    fs.promises.unlink = async (p, ...a) => { if (p === mp4) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return realUnlink(p, ...a); };
    try { await engine._owners.sweepCleanup(); } finally { fs.promises.unlink = realUnlink; }
    assert.ok(fs.existsSync(mp4), 'its removal failed');
    assert.ok(fs.existsSync(partial) && cleanupRows().includes(partial), 'so the partial stays listed - the way back to it');
    await engine._owners.sweepCleanup(); // the next start
    assert.equal(fs.existsSync(mp4), false);
    assert.equal(fs.existsSync(partial), false);
    assert.deepEqual(cleanupRows(), []);
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});

test('Q3: a second name the sweep cannot even inspect keeps the partial listed, and the next start removes both', async () => {
    const { rec, mp4 } = finishingRow();
    const folder = path.dirname(mp4);
    fs.mkdirSync(folder, { recursive: true });
    let partial;
    await engine._owners.write(rec.id, async (signal, made) => {
        partial = path.join(folder, `${path.basename(mp4)}.123-abcdef03.partial`);
        made(partial);
        fs.writeFileSync(partial, 'finished MP4');
        fs.linkSync(partial, mp4); // stopped right after the link
    });
    const realStat = fs.promises.stat;
    fs.promises.stat = async (p, ...a) => { if (p === mp4) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return realStat(p, ...a); };
    try { await engine._owners.sweepCleanup(); } finally { fs.promises.stat = realStat; }
    assert.ok(fs.existsSync(partial) && cleanupRows().includes(partial), 'the partial stays listed');
    await engine._owners.sweepCleanup(); // the next start
    assert.equal(fs.existsSync(mp4), false);
    assert.equal(fs.existsSync(partial), false);
    assert.deepEqual(cleanupRows(), []);
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});

// ---- Codex review of the whole journal (26 Oct): the start-up sweep runs before any queue touches a
// recording, the partial stays listed whenever it cannot be inspected, and a failed rollback keeps it.

test('R1: recovery never adopts a kept original the start-up sweep is about to remove - the queues wait for the sweep', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, mp4 } = finishingRow();
        const away = `${mount}-away`;
        fs.renameSync(mount, away);
        try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
        assert.equal(recordings.getById(rec.id).segment_state, 'moving');
        // A previous run published this original and stopped before recording it: journalled, unrecorded.
        const ts = segments.keptOriginalPath(mp4);
        fs.mkdirSync(path.dirname(ts), { recursive: true });
        fs.writeFileSync(ts, joined);
        engine._owners.published(ts, rec.id, load('services/shareFsWorker').identityOfStat(fs.statSync(ts, { bigint: true }))); // #287: with its identity
        // The sweep is held while it inspects that file (a slow share at start-up).
        const realStat = fs.promises.stat;
        let reached, release;
        const inspecting = new Promise(r => { reached = r; });
        const gate = new Promise(r => { release = r; });
        fs.promises.stat = async (p, ...a) => { if (p === ts) { reached(); await gate; } return realStat(p, ...a); };
        let sweeping, moving;
        try {
            sweeping = engine._owners.sweepCleanup();
            await inspecting;
            moving = segments.moveOne(recordings.getById(rec.id)); // the queue, started at once by init()
            await new Promise(r => setTimeout(r, 100));
        } finally { release(); fs.promises.stat = realStat; }
        await sweeping;
        await moving;
        const done = recordings.getById(rec.id);
        assert.equal(done.segment_state, 'done');
        assert.ok(done.segment_original && fs.existsSync(done.segment_original), 'the recording\'s kept original is on the share');
        assert.deepEqual(fs.readFileSync(done.segment_original), joined);
        await engine.deleteRecording(rec.id);
    });
});

test('R2: a partial the sweep cannot inspect stays listed with its other name, and the next start removes both', async () => {
    const { rec, mp4 } = finishingRow();
    const folder = path.dirname(mp4);
    fs.mkdirSync(folder, { recursive: true });
    let partial;
    await engine._owners.write(rec.id, async (signal, made) => {
        partial = path.join(folder, `${path.basename(mp4)}.123-abcdef04.partial`);
        made(partial);
        fs.writeFileSync(partial, 'finished MP4');
        fs.linkSync(partial, mp4); // stopped right after the link
    });
    const realStat = fs.promises.stat;
    fs.promises.stat = async (p, ...a) => { if (p === partial) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return realStat(p, ...a); };
    try { await engine._owners.sweepCleanup(); } finally { fs.promises.stat = realStat; }
    assert.ok(fs.existsSync(partial) && cleanupRows().includes(partial), 'the partial stays listed');
    assert.ok(fs.existsSync(mp4));
    await engine._owners.sweepCleanup();
    assert.equal(fs.existsSync(mp4), false);
    assert.equal(fs.existsSync(partial), false);
    assert.deepEqual(cleanupRows(), []);
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});

// #287: the finishing queue never runs two finishes of one recording at once. Two of them interleaved let one attempt's
// take-back remove the other's MP4 between its link and its row (the recording lost: completed, no file, no segments).
test('#287: two queue runs at once (one held by the legacy check on a slow share) finish a recording once, and it keeps its MP4', async () => {
    // An unproven kept original from an old build, so the first run awaits the share in the legacy check.
    const s = due({ windowMs: -100 });
    const legacy = recordings.create({ scheduled_id: s.id, title: 'legacy', channel_name: 'x', channel_logo: null,
        source_id: A.id, channel_item_id: 'pos_1', file_path: '', started_at: Date.now() - 60000, part: 1 });
    sqlite.getDb().prepare(`UPDATE recordings SET status = 'completed', file_path = ?, segment_state = 'done', segment_keep = 'x', segment_original = NULL WHERE id = ?`)
        .run(path.join(share, 'Fox Sports 505', 'legacy.mp4'), legacy.id);
    const { rec } = finishingRow();
    const shareFs = load('services/shareFs');
    const realExists = shareFs.exists;
    const realStat = shareFs.stat;
    // A fresh queue (its legacy check not yet run), as at start.
    const modPath = require.resolve(path.join(sandbox, 'server', 'services/recordingSegments'));
    const cached = require.cache[modPath];
    delete require.cache[modPath];
    const queue = require(modPath);
    require.cache[modPath] = cached;
    queue.configure({ recordingsRoot: async () => share, minFreeGB: async () => 0 });
    let running = 0;
    let most = 0;
    let remuxes = 0;
    const settled = [];
    try {
        shareFs.exists = async (f, ...r) => { if (String(f).includes('legacy')) await sleep(500); return realExists(f, ...r); };
        shareFs.stat = async (f, ...r) => { if (String(f).endsWith('.mp4')) await sleep(500); return realStat(f, ...r); };
        await withTools({ ffmpeg: async (args) => {
            remuxes++;
            running++;
            most = Math.max(most, running);
            await sleep(2000); // a remux well past the legacy check's 500 ms
            fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000));
            running--;
            return { code: 0, tail: [] };
        } }, () => Promise.all([queue.processQueue().then(() => settled.push('first')), queue.processQueue().then(() => settled.push('second'))]));
    } finally {
        shareFs.exists = realExists;
        shareFs.stat = realStat;
    }
    assert.equal(most, 1, 'never two finishes of one recording at once');
    assert.deepEqual(settled, ['second', 'first'], 'the second run returned at once: the first had the queue');
    const row = recordings.getById(rec.id);
    assert.equal(row.segment_state, 'done');
    assert.ok(fs.existsSync(row.file_path), `its MP4 is there: ${row.file_path}`);
    assert.equal(remuxes, 1);
    recordings.setSegmentFields(legacy.id, { segment_state: 'failed', segment_keep: null });
    await engine.deleteRecording(rec.id);
});

test('#287: finishOne called twice at once for one recording runs once', async () => {
    const { rec } = finishingRow();
    let remuxes = 0;
    await withTools({ ffmpeg: async (args) => {
        remuxes++;
        await sleep(1000);
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000));
        return { code: 0, tail: [] };
    } }, () => Promise.all([segments.finishOne(rec), segments.finishOne(rec)]));
    assert.equal(remuxes, 1, 'one remux');
    const row = recordings.getById(rec.id);
    assert.equal(row.segment_state, 'done');
    assert.ok(fs.existsSync(row.file_path));
    assert.deepEqual(fs.readdirSync(path.dirname(row.file_path)).filter(n => n.startsWith(row.segment_name)), [path.basename(row.file_path)], 'one copy');
    await engine.deleteRecording(rec.id);
});

// #287 (N1): a link the share refuses with an errno is a failed attempt, not a stall: three remuxes, then the .ts, then
// 'failed' with the segments kept - never a remux every tick.
for (const [code, kept] of [['EOPNOTSUPP', false], ['EIO', true]]) {
    test(`#287: a share whose link always answers ${code} uses up the attempts and ends failed, its segments kept`, async () => {
        const shareFs = load('services/shareFs');
        const realLink = shareFs.link;
        shareFs.link = async () => { throw Object.assign(new Error(code), { code }); };
        const { rec, workDir, mp4 } = finishingRow();
        let remuxes = 0;
        const journal = () => sqlite.getDb().prepare('SELECT path FROM recording_cleanup WHERE recording_id = ? AND kind = \'published\'').all(rec.id).map(r => r.path);
        try {
            await withTools({ ffmpeg: async (args) => { remuxes++; fs.writeFileSync(args[args.length - 1], Buffer.alloc(5000)); return { code: 0, tail: [] }; } }, async () => {
                // As processQueue does: a failed attempt rejects, and is logged.
                await segments.finishOne(recordings.getById(rec.id)).catch(() => {});
                assert.equal(recordings.getById(rec.id).segment_attempts, 1, 'the attempt counts');
                assert.deepEqual(journal(), kept ? [mp4] : [], kept ? 'the name it may have made stays journalled' : 'no link was made: not journalled');
                for (let i = 0; i < 5; i++) await segments.finishOne(recordings.getById(rec.id)).catch(() => {});
            });
        } finally { shareFs.link = realLink; }
        const row = recordings.getById(rec.id);
        assert.equal(remuxes, 3, 'three remuxes, no more');
        assert.equal(row.segment_state, 'failed');
        assert.equal(row.status, 'failed');
        assert.ok(fs.existsSync(workDir), 'its segments are kept in appdata');
        assert.deepEqual(fs.readdirSync(path.dirname(mp4)).filter(n => n.startsWith(row.segment_name) && !n.endsWith('.partial')), [], 'nothing published');
    });
}

// #287 (Codex round 1): a start-up sweep that has read an old name's identity and is slow to unlink it must never remove
// the recording a later attempt publishes at that name (the queue goes on after the sweep's bounded wait).
test('#287: a sweep still removing an old name never removes the recording published there since', async () => {
    const { rec, mp4 } = finishingRow();
    fs.mkdirSync(path.dirname(mp4), { recursive: true });
    fs.writeFileSync(mp4, 'an earlier attempt, never recorded');
    engine._owners.published(mp4, rec.id, load('services/shareFsWorker').identityOfStat(fs.statSync(mp4, { bigint: true })));
    const realUnlink = fs.promises.unlink;
    let reached, resume;
    const atUnlink = new Promise(r => { reached = r; });
    const gate = new Promise(r => { resume = r; });
    fs.promises.unlink = async (p, ...a) => { if (p === mp4) { reached(); await gate; } return realUnlink(p, ...a); };
    engine._owners._setSweepWaitMs(1000);
    let sweeping;
    try {
        sweeping = engine._owners.sweepCleanup(); // checks that file's identity, then waits at its unlink
        await atUnlink;
        await segments.finishOne(recordings.getById(rec.id)); // after the bounded wait: take-back, remux, publish
    } finally {
        resume();
        await sweeping;
        fs.promises.unlink = realUnlink;
        engine._owners._setSweepWaitMs();
    }
    const row = recordings.getById(rec.id);
    assert.equal(row.segment_state, 'done');
    assert.ok(fs.existsSync(row.file_path), `its MP4 survives the late sweep: ${row.file_path}`);
    assert.equal(fs.statSync(row.file_path).size, 5000);
    assert.equal(fs.existsSync(mp4) && row.file_path !== mp4, false, 'the earlier attempt is gone');
    await engine.deleteRecording(rec.id);
});

// ---- Codex review of 0279 (26 Oct): exact inode comparison, and a stuck sweep never stalls the queues
// nor lets recovery adopt a file it may still remove.

test('S1: two files whose inode numbers differ only beyond 2^53 are never taken for one file', async () => {
    const { rec, mp4 } = finishingRow();
    const folder = path.dirname(mp4);
    fs.mkdirSync(folder, { recursive: true });
    let partial;
    await engine._owners.write(rec.id, async (signal, made) => {
        partial = path.join(folder, `${path.basename(mp4)}.123-abcdef05.partial`);
        made(partial);
        fs.writeFileSync(partial, 'a partial with a second name somewhere');
    });
    const unrelated = path.join(folder, 'Unrelated.mp4');
    fs.writeFileSync(unrelated, 'not ours');
    const realStat = fs.promises.stat;
    const fake = { [partial]: 9007199254740992n, [unrelated]: 9007199254740993n }; // equal as doubles
    fs.promises.stat = async (p, opts) => {
        if (!(p in fake)) return realStat(p, opts);
        const big = { dev: 1n, ino: fake[p], nlink: 2n };
        return opts && opts.bigint ? big : { dev: 1, ino: Number(big.ino), nlink: 2 };
    };
    try { await engine._owners.sweepCleanup(); } finally { fs.promises.stat = realStat; }
    assert.equal(fs.existsSync(unrelated), true, 'a different file is never removed');
    fs.unlinkSync(unrelated);
    await engine._owners.sweepCleanup();
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});

test('S2: a sweep stuck on the share holds the queues for a bounded time only, and recovery never adopts what it may remove', async () => {
    await withTools({ duration: async (f) => (f.endsWith('recording.m3u8') ? null : 120) }, async () => {
        const { rec, mp4 } = finishingRow();
        const away = `${mount}-away`;
        fs.renameSync(mount, away);
        try { await segments.finishOne(rec); } finally { fs.renameSync(away, mount); }
        const ts = segments.keptOriginalPath(mp4);
        fs.mkdirSync(path.dirname(ts), { recursive: true });
        fs.writeFileSync(ts, joined); // published by a run that stopped before recording it
        const journalled = load('services/shareFsWorker').identityOfStat(fs.statSync(ts, { bigint: true }));
        engine._owners.published(ts, rec.id, journalled); // #287: with its identity
        const realStat = fs.promises.stat;
        let unstick;
        const stuck = new Promise(r => { unstick = r; });
        fs.promises.stat = async (p, ...a) => { if (p === ts) await stuck; return realStat(p, ...a); };
        engine._owners._setSweepWaitMs?.(200);
        let sweeping, moving;
        try {
            sweeping = engine._owners.sweepCleanup(); // never ends while the share is stuck
            moving = segments.moveOne(recordings.getById(rec.id));
            const outcome = await Promise.race([moving.then(() => 'moved'), new Promise(r => setTimeout(() => r('still waiting'), 5000))]);
            assert.equal(outcome, 'moved', 'the queue goes on after its bounded wait');
            const done = recordings.getById(rec.id);
            // #287: the move takes that file back first (it is still the journalled one), so the name may be reused by a
            // copy of its own: the file at it is not the journalled one.
            const at = load('services/shareFsWorker').identityOfStat(fs.statSync(done.segment_original, { bigint: true }));
            assert.notEqual(at, journalled, 'the file the sweep may still remove is not adopted');
            assert.ok(done.segment_original && fs.existsSync(done.segment_original));
        } finally { unstick(); fs.promises.stat = realStat; engine._owners._setSweepWaitMs?.(); }
        await sweeping;
        const done = recordings.getById(rec.id);
        assert.ok(fs.existsSync(done.segment_original), 'its own original survives the late sweep');
        assert.deepEqual(fs.readFileSync(done.segment_original), joined);
        await engine.deleteRecording(rec.id);
    });
});

test('Q1b: a replacement that reuses the journalled file\'s inode number (as Linux does) is still left alone', async () => {
    const { rec, mp4 } = finishingRow();
    const real = recordings.setSegmentFields;
    recordings.setSegmentFields = (id, fields) => {
        if (id === rec.id && fields.status === 'completed') throw new Error('database or disk is full');
        return real.call(recordings, id, fields);
    };
    try { await segments.finishOne(rec).catch(() => {}); } finally { recordings.setSegmentFields = real; }
    const ours = fs.statSync(mp4, { bigint: true });
    fs.unlinkSync(mp4);
    fs.writeFileSync(mp4, 'a new file that the filesystem gave the same inode number');
    const realStat = fs.promises.stat;
    // The filesystem reuses the freed inode: same device and inode, but a different file.
    fs.promises.stat = async (p, opts) => {
        const st = await realStat(p, opts);
        if (p !== mp4 || !(opts && opts.bigint)) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: ours.dev, ino: ours.ino });
    };
    try { await engine._owners.sweepCleanup(); } finally { fs.promises.stat = realStat; }
    assert.equal(fs.readFileSync(mp4, 'utf8'), 'a new file that the filesystem gave the same inode number', 'kept');
    assert.deepEqual(cleanupRows(), []);
    fs.unlinkSync(mp4);
    recordings.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed' });
});
