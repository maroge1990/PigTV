/**
 * Segmented recordings (R3, Wave 4; approved by Mark on 16 Oct). Behind the
 * `segmentedRecordings` setting, off by default: with it off nothing here runs and a recording
 * is made exactly as before (one .ts per part on the share, recordingEngine.spawnPart).
 *
 * With it on, a new recording is captured as HLS segments in appdata
 * (/app/data/recordings-work/rec-<id>/), never on the share, which has a history of going stale:
 *
 *   e1/archive.m3u8 + a000000.ts …   what the recording ffmpeg writes (MPEG-TS, stream copy)
 *   e2/…                              the next run after a provider failover or a server restart
 *   e1/view.m3u8 + init.mp4, v….m4s   the copy the Apple TV watches, made only when asked for
 *   recording.m3u8                    every epoch's segments as one playlist, for the final remux
 *
 * One folder per ffmpeg run ("epoch") rather than appending to one playlist: each run starts
 * clean and its playlist is ffmpeg's own; the timeline continues because a later run's output
 * starts at the length recorded so far (-output_ts_offset), and the epochs are joined with
 * EXT-X-DISCONTINUITY where a player or the remux reads them.
 *
 * The archive is MPEG-TS for the reason 0203 gave: each ADTS frame keeps its own header, so a
 * channel that changes its audio at an ad break still decodes. The Apple TV cannot play HEVC from
 * MPEG-TS, so the copy it watches is fMP4, made by a second, local ffmpeg that follows the
 * archive playlist (no provider connection; it cannot disturb the capture).
 *
 * At the end the joined playlist is remuxed to the same MP4 preparation (K12) makes, checked the
 * same way (recordingMedia.checkPrepared), written straight onto the share under a temporary name
 * and renamed into place; then the work folder is deleted. A share that is down at that moment
 * gets the MP4 in the work folder instead (playable from there) and it moves when the share is
 * back. An MP4 that plays but could not be compared with the segments (checkPrepared's
 * keepOriginal) keeps them: they go beside it on the share as "<name>.ts" before the work folder
 * is deleted (DVR-1, 0227). Native code: Dispatcharr (AGPL) was read for the idea, nothing was copied.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const media = require('./recordingMedia');
const { parseMediaPlaylist, renderMediaPlaylist } = require('./hlsPlaylist');
const { checkRecordingsFolder } = require('./recordingsFolder');
const { uniqueFilePath } = require('./recordingNames');
const { recordings: recordingsDb } = require('../db/recordingsDb');
const owners = require('./recordingOwners');
const { owned, withdraw, write } = owners; // R4-D2, 0264: recordings being deleted

const SEGMENT_SEC = 4;
const MAX_FINISH_ATTEMPTS = 3;
const MOVE_RETRY_MS = 15 * 60 * 1000;

let workRootOverride = null;
/** /app/data/recordings-work: beside the database, on the appdata volume. */
function workRoot() {
    return workRootOverride || path.join(__dirname, '..', '..', 'data', 'recordings-work');
}
function _setWorkRoot(dir) { workRootOverride = dir || null; }

function workDirFor(recordingId) {
    return path.join(workRoot(), `rec-${Number(recordingId)}`);
}

/** Only a rec-<n> folder directly inside the work root is ever deleted. */
function isWorkDir(dir) {
    if (!dir) return false;
    const rel = path.relative(path.resolve(workRoot()), path.resolve(dir));
    return /^rec-\d+$/.test(rel);
}

const EPOCH_RE = /^e(\d{1,4})$/;

/** The epochs of a work folder, oldest first: [{ n, name, dir }]. */
function epochs(workDir) {
    let names = [];
    try { names = fs.readdirSync(workDir); } catch (e) { return []; }
    return names.map(name => ({ name, m: EPOCH_RE.exec(name) }))
        .filter(x => x.m)
        .map(x => ({ n: Number(x.m[1]), name: x.name, dir: path.join(workDir, x.name) }))
        .sort((a, b) => a.n - b.n);
}

function readPlaylist(file) {
    try { return parseMediaPlaylist(fs.readFileSync(file, 'utf8')); } catch (e) { return parseMediaPlaylist(''); }
}

const archiveOf = (epochDir) => readPlaylist(path.join(epochDir, 'archive.m3u8'));
const viewOf = (epochDir) => readPlaylist(path.join(epochDir, 'view.m3u8'));
const lengthOf = (parsed) => parsed.segments.reduce((t, s) => t + s.duration, 0);

/** Seconds recorded so far, over every epoch. */
function recordedSeconds(workDir) {
    return epochs(workDir).reduce((t, e) => t + lengthOf(archiveOf(e.dir)), 0);
}

function archiveSegmentCount(workDir) {
    return epochs(workDir).reduce((t, e) => t + archiveOf(e.dir).segments.length, 0);
}

/** A new epoch folder after the last one, and where its timeline starts. */
function nextEpoch(workDir) {
    fs.mkdirSync(workDir, { recursive: true });
    const all = epochs(workDir);
    const n = all.length ? all[all.length - 1].n + 1 : 1;
    const dir = path.join(workDir, `e${n}`);
    fs.mkdirSync(dir);
    return { n, dir, offsetSec: recordedSeconds(workDir) };
}

/**
 * The recording ffmpeg for one epoch. Input and mapping are today's (spawnPart); the output is
 * an HLS event playlist of 4 s MPEG-TS segments instead of one .ts file. make_non_negative rather
 * than make_zero: make_zero would undo -output_ts_offset (it shifts the first timestamp to 0).
 * temp_file: a segment only appears under its name once it is complete.
 */
function captureArgs({ userAgent, url, epochDir, offsetSec = 0 }) {
    return [
        '-y',
        '-user_agent', userAgent,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        '-map', '0:v?',
        '-map', '0:a?',
        '-ignore_unknown',
        '-sn', '-dn',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_non_negative',
        '-output_ts_offset', (Math.max(0, Number(offsetSec) || 0)).toFixed(3),
        '-f', 'hls',
        '-hls_time', String(SEGMENT_SEC),
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(epochDir, 'a%06d.ts'),
        path.join(epochDir, 'archive.m3u8')
    ];
}

/** Bytes written into an epoch so far (segments, the one being written, the playlist). */
function captureBytes(epochDir) {
    let total = 0;
    let names = [];
    try { names = fs.readdirSync(epochDir); } catch (e) { return 0; }
    for (const name of names) {
        if (!/^a\d+\.ts(\.tmp)?$|^archive\.m3u8$/.test(name)) continue;
        try { total += fs.statSync(path.join(epochDir, name)).size; } catch (e) { /* rotated */ }
    }
    return total;
}

/**
 * An epoch whose ffmpeg is gone (it was stopped, it died, the server restarted) is complete: a
 * graceful stop ends the playlist itself; anything else leaves it open, which a follower would
 * wait on for ever. Idempotent.
 */
function sealEpoch(epochDir) {
    const file = path.join(epochDir, 'archive.m3u8');
    try {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('#EXT-X-ENDLIST')) fs.appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}#EXT-X-ENDLIST\n`);
    } catch (e) { /* nothing was written in this epoch */ }
}

function sealAll(workDir) {
    for (const e of epochs(workDir)) sealEpoch(e.dir);
}

/** Every epoch's archive segments as one VOD playlist (recording.m3u8), for the remux. */
function stitchArchive(workDir) {
    const segments = [];
    for (const e of epochs(workDir)) {
        const parsed = archiveOf(e.dir);
        parsed.segments.forEach((s, i) => segments.push({
            name: `${e.name}/${s.name}`, duration: s.duration, discontinuity: i === 0 && segments.length > 0
        }));
    }
    const file = path.join(workDir, 'recording.m3u8');
    const { text } = renderMediaPlaylist({ segments, mediaSequence: 0, version: 3, playlistType: 'VOD', endList: true, independentSegments: true });
    fs.writeFileSync(file, text);
    return { file, segments: segments.length, durationSec: segments.reduce((t, s) => t + s.duration, 0) };
}

// ---------------------------------------------------------------------------
// The copy the Apple TV watches (made only when somebody asks to watch)
// ---------------------------------------------------------------------------

// `${recordingId}:${epoch}` -> { proc, failures }
const followers = new Map();
const MAX_FOLLOWER_FAILURES = 3;

/**
 * The follower for one epoch: read its archive playlist from the first segment (an open one is
 * followed like a live stream until it is sealed) and write an fMP4 event playlist beside it.
 * Video copied (HEVC tagged hvc1, which AVPlayer needs); audio copied unless it is MP2, which
 * AVPlayer cannot play.
 */
function viewArgs(epochDir, codecs = {}) {
    const video = (codecs.video || '').toLowerCase();
    const audio = (codecs.audio || '').toLowerCase();
    const args = ['-nostdin', '-y', '-live_start_index', '0', '-i', path.join(epochDir, 'archive.m3u8'),
        '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
    if (video === 'hevc' || video === 'h265') args.push('-tag:v', 'hvc1');
    if (audio === 'mp2' || audio === 'mp3') args.push('-c:a', 'aac', '-b:a', '192k');
    args.push(
        '-f', 'hls',
        '-hls_time', String(SEGMENT_SEC),
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', path.join(epochDir, 'v%06d.m4s'),
        path.join(epochDir, 'view.m3u8')
    );
    return args;
}

async function startFollower(recordingId, epoch) {
    const key = `${recordingId}:${epoch.n}`;
    const first = archiveOf(epoch.dir).segments[0];
    if (!first) return false;
    const entry = followers.get(key) || { proc: null, failures: 0 };
    if (entry.proc || entry.failures >= MAX_FOLLOWER_FAILURES) return false;
    followers.set(key, entry);
    entry.proc = 'starting';
    const codecs = await media.nativeTools.codecs(path.join(epoch.dir, first.name));
    let proc;
    try {
        proc = spawn(media.tools.ffmpegPath, viewArgs(epoch.dir, codecs), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
        entry.proc = null;
        entry.failures++;
        return false;
    }
    entry.proc = proc;
    const tail = [];
    proc.stderr.on('data', d => { for (const l of String(d).split('\n')) if (l.trim()) { tail.push(l.trim()); if (tail.length > 10) tail.shift(); } });
    proc.on('error', () => { /* reported on close */ });
    proc.on('close', (code) => {
        entry.proc = null;
        if (code !== 0 && !viewOf(epoch.dir).ended) {
            entry.failures++;
            console.warn(`[Recordings] The watch copy of #${recordingId} (part ${epoch.n}) stopped (exit ${code}): ${tail.slice(-2).join(' | ')}`);
        }
    });
    return true;
}

/** Make sure every epoch that has segments has (or is getting) its watch copy. Never throws. */
async function ensureView(rec) {
    if (!rec || !rec.work_dir) return;
    for (const epoch of epochs(rec.work_dir)) {
        if (viewOf(epoch.dir).ended) continue;
        try { await startFollower(rec.id, epoch); } catch (e) { /* tried again on the next request */ }
    }
}

function stopFollowers(recordingId) {
    for (const [key, entry] of followers) {
        if (!key.startsWith(`${recordingId}:`)) continue;
        if (entry.proc && entry.proc !== 'starting') { try { entry.proc.kill('SIGKILL'); } catch (e) { /* gone */ } }
        followers.delete(key);
    }
}

/**
 * The watch copy as one playlist: the epochs in order, each with its own init segment and a
 * discontinuity before it. An event playlist may only grow at its end, so it stops at the first
 * epoch whose copy is not complete yet. Ended once the capture is over and every copy is listed.
 * Names are relative ("e1/v000000.m4s"); the route adds the token.
 */
function viewPlaylist(workDir, { captureOver = false } = {}) {
    const segments = [];
    let complete = true;
    for (const e of epochs(workDir)) {
        const archive = archiveOf(e.dir);
        if (archive.segments.length === 0 && archive.ended) continue; // an epoch that recorded nothing
        const view = viewOf(e.dir);
        view.segments.forEach((s, i) => segments.push({
            name: `${e.name}/${s.name}`, duration: s.duration, map: `${e.name}/init.mp4`,
            discontinuity: i === 0 && segments.length > 0
        }));
        if (!view.ended) { complete = false; break; }
    }
    const ended = captureOver && complete;
    const { text } = renderMediaPlaylist({
        segments, mediaSequence: 0, version: 7, targetDuration: SEGMENT_SEC + 1,
        playlistType: ended ? 'VOD' : 'EVENT', endList: ended, independentSegments: true, startOffset: 0
    });
    return { text, segments: segments.length, ended };
}

// The video's range, rate and size, read once per recording from its first archive segment (a
// local file), for the master playlist that makes the Apple TV switch to HDR and 50 Hz.
const videoInfo = new Map();
function probeVideoInfo(rec) {
    if (videoInfo.has(rec.id)) return Promise.resolve(videoInfo.get(rec.id));
    const epoch = epochs(rec.work_dir)[0];
    const first = epoch && archiveOf(epoch.dir).segments[0];
    if (!first) return Promise.resolve(null);
    return new Promise((resolve) => {
        let out = '';
        let proc;
        try {
            proc = spawn(media.tools.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
                'stream=width,height,avg_frame_rate,r_frame_rate,color_transfer', '-of', 'json', path.join(epoch.dir, first.name)]);
        } catch (e) { return resolve(null); }
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } }, 10000);
        proc.stdout.on('data', d => { out += d; });
        proc.on('error', () => { clearTimeout(timer); resolve(null); });
        proc.on('close', () => {
            clearTimeout(timer);
            let info = null;
            try {
                const { classifyVideoRange, frameRateOf } = require('./streamProbe');
                const v = (JSON.parse(out).streams || [])[0];
                if (v) info = { videoRange: classifyVideoRange(v) || 'SDR', fps: frameRateOf(v), width: v.width || null, height: v.height || null };
            } catch (e) { info = null; }
            if (info) videoInfo.set(rec.id, info);
            resolve(info);
        });
    });
}

/** Can this recording be watched from the start now (a segmented one still in appdata)? */
function isWatchable(rec) {
    return Boolean(rec && rec.work_dir && rec.status === 'recording' &&
        (rec.segment_state === 'capturing' || rec.segment_state === 'finishing') &&
        archiveSegmentCount(rec.work_dir) > 0);
}

// ---------------------------------------------------------------------------
// Finishing: one MP4 on the share
// ---------------------------------------------------------------------------

// Supplied by recordingEngine.init (the share's root and the minimum free space live there).
const deps = { recordingsRoot: async () => { throw new Error('not configured'); }, minFreeGB: async () => 10 };
function configure(d) { Object.assign(deps, d); }

let finishing = false;
const lastMoveTry = new Map();

/** The share's channel folder for this recording, or null when the share cannot take it now. */
async function shareFolder(rec) {
    let root;
    try { root = await deps.recordingsRoot(); } catch (e) { return null; }
    const check = checkRecordingsFolder(root, await deps.minFreeGB());
    if (!check.ok) return null;
    const dir = path.join(root, rec.segment_folder || 'Unknown Channel');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
    return dir;
}

async function removeWork(rec) {
    stopFollowers(rec.id);
    videoInfo.delete(rec.id);
    lastMoveTry.delete(rec.id);
    if (!isWorkDir(rec.work_dir)) return;
    try { await fsp.rm(rec.work_dir, { recursive: true, force: true }); } catch (err) {
        console.warn(`[Recordings] Could not delete the work folder of #${rec.id}: ${err.message}`);
    }
}

function completed(rec, file, extra = {}) {
    let size = null;
    try { size = fs.statSync(file).size; } catch (e) { /* reported as unknown */ }
    recordingsDb.setSegmentFields(rec.id, { file_path: file, status: 'completed', file_size_bytes: size, ...extra });
    try { recordingsDb.setAdDetectStatus(rec.id, 'pending'); } catch (e) { /* very old database */ }
}

/**
 * F1 (0242): put a finished file in place without ever replacing one that is there. link() fails
 * with EEXIST if the name is taken (atomic, unlike a check before rename), and then the next name
 * `alt(n)` is tried. Returns the path it was published at; the partial is gone.
 */
function publishNoReplace(partial, dir, first, alt) {
    for (let n = 1; ; n++) {
        const dest = path.join(dir, n === 1 ? first : alt(n));
        try { fs.linkSync(partial, dest); } catch (err) { if (err.code === 'EEXIST') continue; throw err; }
        try { fs.unlinkSync(partial); } catch (e) { /* already gone */ }
        return dest;
    }
}

const segmentFiles = (rec) => epochs(rec.work_dir).flatMap(e => archiveOf(e.dir).segments.map(s => path.join(e.dir, s.name)));

/**
 * Every epoch's segments, in order, joined into one MPEG-TS file published in `dir` as `first`
 * (else `alt(n)`), never over an existing file. DVR-5 (0227): one pipeline owns both ends, so a
 * share that fails to open, fills or drops mid-write rejects here (the partial is removed) instead
 * of raising an unhandled stream error, and the writer's backpressure paces the reads. F1: the
 * partial is this call's own (created exclusively under a unique name). Returns the published path.
 */
async function joinSegments(rec, dir, first, alt, signal = null, made = () => {}) {
    const partial = owners.partialFor(path.join(dir, first));
    made(partial); // 0270: named to its writer before it exists
    async function* pieces() {
        for (const file of segmentFiles(rec)) yield* fs.createReadStream(file);
    }
    try {
        await pipeline(Readable.from(pieces(), { objectMode: false }), fs.createWriteStream(partial, { flags: 'wx' }), ...(signal ? [{ signal }] : []));
        return publishNoReplace(partial, dir, first, alt);
    } catch (err) {
        try { fs.unlinkSync(partial); } catch (e) { /* none */ }
        throw err;
    }
}

/** F1: is `file` byte for byte this recording's segments, joined? (The only proof a file found on the share is its original.) */
async function sameBytesAsSegments(file, rec) {
    const files = segmentFiles(rec);
    let total = 0;
    for (const f of files) total += fs.statSync(f).size;
    if (fs.statSync(file).size !== total) return false;
    const fh = await fsp.open(file, 'r');
    try {
        let at = 0;
        for (const f of files) {
            for await (const chunk of fs.createReadStream(f)) {
                const theirs = Buffer.alloc(chunk.length);
                const { bytesRead } = await fh.read(theirs, 0, chunk.length, at);
                if (bytesRead !== chunk.length || !theirs.equals(chunk)) return false;
                at += chunk.length;
            }
        }
        return true;
    } finally {
        await fh.close();
    }
}

/** DVR-1: where the segments of a recording whose MP4 is `mp4` are kept on the share, if that name is
 *  free (F1: else "<name> (original N).ts"; the path used is in segment_original, which
 *  recordingEngine.deleteRecording removes with the recording). */
const keptOriginalPath = (mp4) => path.join(path.dirname(mp4), `${path.basename(mp4, path.extname(mp4))}.ts`);

/**
 * Last resort when the MP4 cannot be made: the segments joined into one .ts, which is what a
 * recording has always been before preparation, and preparation then takes it from there.
 */
async function deliverTs(rec, stitched) {
    const dir = await shareFolder(rec);
    if (!dir) throw new Error('the recordings folder is not usable');
    const name = rec.segment_name || `Recording ${rec.id}`;
    // 0264: a writer of the recording (a deletion stops it and waits); deleted meanwhile, its copy goes.
    const target = await write(rec.id, async (signal, made) => {
        const t = await joinSegments(rec, dir, `${name}.ts`, n => `${name} (${n}).ts`, signal, made);
        if (!owned(rec.id)) { withdraw(t, rec.id, 'recording'); return null; }
        return t;
    });
    if (!target) return;
    completed(rec, target, { duration_sec: Math.round(stitched.durationSec), segment_state: 'done' });
    recordingsDb.setNativeStatus(rec.id, 'pending');
    await removeWork(rec);
    console.warn(`[Recordings] #${rec.id} is on the share as ${path.basename(target)} (the MP4 could not be made; it will be prepared as usual)`);
}

/** Remux the segments to the recording's MP4 and put it on the share (or in appdata while the share is down). */
async function finishOne(rec) {
    const stitched = stitchArchive(rec.work_dir);
    if (stitched.segments === 0) {
        recordingsDb.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed', error: rec.error || 'Nothing was recorded.' });
        await removeWork(rec);
        return;
    }
    const attempts = (rec.segment_attempts || 0) + 1;
    recordingsDb.setSegmentFields(rec.id, { segment_attempts: attempts });

    const dir = await shareFolder(rec);
    let target = dir ? uniqueFilePath(dir, rec.segment_name || `Recording ${rec.id}`, '.mp4') : path.join(rec.work_dir, 'final.mp4');
    try { fs.unlinkSync(`${target}.partial`); } catch (e) { /* none (the fixed name before 0273) */ }
    const partial = owners.partialFor(target); // 0273: its own name, journalled by its writer

    const codecs = await media.nativeTools.codecs(stitched.file);
    console.log(`[Recordings] Making the MP4 of #${rec.id} from ${stitched.segments} segments -> ${dir ? target : 'the work folder (the share is not usable now)'}`);
    // 0264: the remux and its check are a writer of the recording: a deletion stops it and waits until
    // its partial is gone.
    const { problem, keep } = await write(rec.id, async (signal, made) => {
        made(partial);
        const result = await media.nativeTools.ffmpeg(media.buildNativeRemuxArgs(stitched.file, partial, codecs), { watchFile: partial, signal });
        let problem = null;
        let keep = null;
        if (result.code !== 0 || !fs.existsSync(partial)) {
            problem = result.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${result.code}`;
        } else {
            const check = await media.checkPrepared(stitched.file, partial, { signal });
            if (!check.ok) problem = `the MP4 failed its check: ${check.reason}`;
            // DVR-1 (0227): it plays, but could not be compared with the segments (their length or the
            // audio could not be read): the segments are its original and are kept, as preparation keeps one.
            else if (check.keepOriginal) keep = check.reason;
        }
        if (!owned(rec.id)) { try { fs.unlinkSync(partial); } catch (e) { /* none */ } }
        return { problem, keep };
    });
    if (!owned(rec.id)) { // deleted (or being deleted) meanwhile
        try { fs.unlinkSync(partial); } catch (e) { /* none */ }
        return;
    }
    if (problem) {
        try { fs.unlinkSync(partial); } catch (e) { /* none */ }
        console.error(`[Recordings] Could not make the MP4 of #${rec.id} (attempt ${attempts}): ${problem}`);
        if (attempts < MAX_FINISH_ATTEMPTS) return;
        try {
            if (!owned(rec.id)) return;
            await deliverTs(recordingsDb.getById(rec.id), stitched);
        } catch (err) {
            if (!owned(rec.id)) return; // 0264: stopped by its deletion
            recordingsDb.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed',
                error: `The recording could not be finished (${err.message}); its segments are kept in appdata.` });
        }
        return;
    }

    // F1: published without replacing a file that appeared at its name meanwhile.
    const mp4Name = path.basename(target, '.mp4');
    target = publishNoReplace(partial, path.dirname(target), `${mp4Name}.mp4`, n => `${mp4Name} (${n}).mp4`);
    media.verifiedNativeFiles.add(target);
    // F2 (0243): with an original to keep the row says 'moving' until that original is published,
    // so a restart mid-copy finds it in findSegmentWork() and finishes the move.
    completed(rec, target, { duration_sec: Math.round(stitched.durationSec), segment_state: dir && !keep ? 'done' : 'moving', segment_keep: keep });
    recordingsDb.setNativeStatus(rec.id, 'ready', keep ? { error: `Original kept: ${keep}` } : undefined);
    recordingsDb.setNativeVersion(rec.id, media.NATIVE_VERSION);
    if (dir && keep) {
        // The work folder goes only once its segments are safely beside the MP4; until then the
        // recording waits like one whose share is down, and the move retries the copy.
        if (await keepOriginal(recordingsDb.getById(rec.id), dir)) {
            recordingsDb.setSegmentFields(rec.id, { segment_state: 'done' });
            await removeWork(rec);
        } else {
            lastMoveTry.set(rec.id, Date.now());
        }
        console.warn(`[Recordings] #${rec.id} is finished: ${target}, but its original is kept: ${keep}`);
    } else if (dir) {
        await removeWork(rec);
        console.log(`[Recordings] #${rec.id} is finished: ${target}`);
    } else {
        lastMoveTry.set(rec.id, Date.now());
        console.warn(`[Recordings] #${rec.id} is finished but waits in appdata: the recordings folder is not usable`);
    }
}

/**
 * DVR-1: the kept segments onto the share beside the MP4; true when they are there. F1 (0242): a
 * file is accepted as the original only when it is the one this recording published
 * (segment_original) or is byte for byte its segments - a file of the same name and size is not
 * proof. Otherwise the segments are written to a file of their own, published without replacing
 * anything (an occupied name gets "<name> (original N).ts"), and its path is recorded.
 */
async function keepOriginal(rec, dir) {
    const base = path.basename(rec.file_path, path.extname(rec.file_path));
    try {
        for (const known of [rec.segment_original, keptOriginalPath(path.join(dir, path.basename(rec.file_path)))]) {
            if (known && fs.existsSync(known) && await sameBytesAsSegments(known, rec)) {
                if (!owned(rec.id)) return false; // R4-D2: a file found, not published here: left alone
                recordingsDb.setSegmentFields(rec.id, { segment_original: known });
                return true;
            }
        }
        // 0264: a writer of the recording (a deletion stops it and waits).
        const published = await write(rec.id, async (signal, made) => {
            const p = await joinSegments(rec, dir, `${base}.ts`, n => `${base} (original${n > 2 ? ` ${n - 1}` : ''}).ts`, signal, made);
            // D1 (0251), R4-D2: deleted (or being deleted) while it was copied - this copy is its own, so it goes too.
            if (!owned(rec.id)) { withdraw(p, rec.id, 'kept original'); return null; }
            return p;
        });
        if (!published) return false;
        recordingsDb.setSegmentFields(rec.id, { segment_original: published });
        return true;
    } catch (err) {
        console.warn(`[Recordings] #${rec.id}: its original could not be put on the share yet (${err.message}); its segments stay in appdata`);
        return false;
    }
}

const inWork = (rec) => Boolean(rec.work_dir && rec.file_path && rec.file_path.startsWith(rec.work_dir + path.sep));

/** An MP4 left in appdata while the share was down goes to the share (and, DVR-1, a kept original with it). */
async function moveOne(rec) {
    lastMoveTry.set(rec.id, Date.now());
    const dir = await shareFolder(rec);
    if (!dir) return;
    if (inWork(rec)) {
        const source = rec.file_path;
        const name = rec.segment_name || `Recording ${rec.id}`;
        const partial = owners.partialFor(path.join(dir, `${name}.mp4`));
        let target;
        try {
            // 0264: a writer of the recording; a deletion stops it and waits. 0267 (Codex review of
            // 0266): copied as a stream with the writer's signal, so a deletion stops it between
            // chunks (copyFile runs to the end). A single write stuck in the kernel on a share that
            // stopped answering cannot be interrupted in-process - nor can the deletion's own
            // unlinks on that share (see docs/reviews/2026-10-25/repair/REPAIR-STATUS.md).
            target = await write(rec.id, async (signal, made) => {
                if (signal.aborted) return null;
                made(partial);
                await pipeline(fs.createReadStream(source), fs.createWriteStream(partial, { flags: 'wx' }), { signal });
                if (fs.statSync(partial).size !== fs.statSync(source).size) throw new Error('the copy is not the same size');
                const t = publishNoReplace(partial, dir, `${name}.mp4`, n => `${name} (${n}).mp4`); // F1
                if (!owned(rec.id)) { withdraw(t, rec.id, 'MP4'); return null; }
                return t;
            });
            if (!target) return;
        } catch (err) {
            try { fs.unlinkSync(partial); } catch (e) { /* none */ }
            console.warn(`[Recordings] #${rec.id} could not move to the recordings folder yet: ${err.message}`);
            return;
        }
        media.verifiedNativeFiles.delete(source);
        media.verifiedNativeFiles.add(target);
        recordingsDb.setSegmentFields(rec.id, { file_path: target });
        rec = recordingsDb.getById(rec.id);
    }
    // Never delete the segments of a recording whose MP4 could not be fully checked until they
    // are on the share; otherwise it stays 'moving' and is retried.
    if (rec.segment_keep && !(await keepOriginal(rec, path.dirname(rec.file_path)))) return;
    recordingsDb.setSegmentFields(rec.id, { segment_state: 'done' });
    await removeWork(rec);
    console.log(`[Recordings] #${rec.id} moved to the recordings folder: ${rec.file_path}`);
}

/**
 * R4-D1 (0256): rows that 0227-0242 marked 'done' with a kept original but no path for it. Both
 * builds set 'done' BEFORE copying the original, so the row alone proves nothing:
 *   - its segments are still in appdata: the copy may never have finished. A "<name>.ts" that is
 *     byte for byte those segments is its original (claimed); otherwise it goes back to 'moving',
 *     and the queue publishes an original of its own (keepOriginal) - the file at that name is not
 *     touched;
 *   - its segments are gone: 0227-0241 finished the copy, but they also accepted a same-size file
 *     already at that name, so ownership cannot be shown. Nothing is claimed: the file is left in
 *     place, also when the recording is deleted, and logged.
 */
async function recoverLegacyOriginals() {
    for (const rec of recordingsDb.findUnprovenOriginals()) {
        const conventional = keptOriginalPath(rec.file_path);
        const files = segmentFiles(rec);
        if (files.length && files.every(f => fs.existsSync(f))) {
            if (fs.existsSync(conventional) && await sameBytesAsSegments(conventional, rec)) {
                recordingsDb.setSegmentFields(rec.id, { segment_original: conventional });
                console.log(`[Recordings] #${rec.id}: its kept original is ${path.basename(conventional)} (the same bytes as its segments)`);
            } else {
                recordingsDb.setSegmentFields(rec.id, { segment_state: 'moving' });
                console.warn(`[Recordings] #${rec.id}: its kept original was never finished; it is copied again under its own name`);
            }
        } else if (fs.existsSync(conventional)) {
            console.warn(`[Recordings] #${rec.id}: ${path.basename(conventional)} beside it may be the original an earlier build kept, ` +
                'but that cannot be proven; it is left in place, also if the recording is deleted');
        }
    }
}
let legacyChecked = false;

/** One step of the queue: finish the oldest capture that has ended, else retry one waiting move. */
async function processQueue(now = Date.now()) {
    if (finishing) return;
    if (!legacyChecked) {
        legacyChecked = true;
        try { await recoverLegacyOriginals(); } catch (err) { console.error('[Recordings] Checking kept originals failed:', err.message); }
    }
    const pending = recordingsDb.findSegmentWork();
    const next = pending.find(r => r.segment_state === 'finishing')
        || pending.find(r => r.segment_state === 'moving' && now - (lastMoveTry.get(r.id) || 0) >= MOVE_RETRY_MS);
    if (!next) return;
    finishing = true;
    try {
        if (next.segment_state === 'finishing') await finishOne(next);
        else await moveOne(next);
    } catch (err) {
        console.error(`[Recordings] Finishing #${next.id} failed:`, err.message);
    } finally {
        finishing = false;
    }
}

/** For the Status page: the appdata folder and what is still in it. */
function status() {
    const rows = recordingsDb.findWithWorkDir();
    let freeBytes = null;
    try { fs.mkdirSync(workRoot(), { recursive: true }); const st = fs.statfsSync(workRoot()); freeBytes = st.bavail * st.bsize; } catch (e) { /* unknown */ }
    const pick = (state) => rows.filter(r => r.segment_state === state).map(r => ({ id: r.id, title: r.title }));
    return {
        freeBytes,
        capturing: pick('capturing'),
        finishing: pick('finishing'),
        waitingToMove: pick('moving'),
        failed: pick('failed')
    };
}

module.exports = {
    SEGMENT_SEC, workRoot, workDirFor, isWorkDir, epochs, nextEpoch, captureArgs, captureBytes,
    sealEpoch, sealAll, stitchArchive, recordedSeconds, archiveSegmentCount,
    viewArgs, ensureView, stopFollowers, viewPlaylist, probeVideoInfo, isWatchable,
    configure, processQueue, finishOne, moveOne, removeWork, status, keptOriginalPath, recoverLegacyOriginals,
    _setWorkRoot, _followers: followers
};
