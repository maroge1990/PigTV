/**
 * Segmented recordings (R3, Wave 4; approved by Mark on 16 Oct). Every recording since 0494 (D-48).
 *
 * A new recording is captured as HLS segments in appdata
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
const { checkRecordingsFolderAsync } = require('./recordingsFolder');
const shareFs = require('./shareFs'); // #8
const { uniqueFilePathAsync } = require('./recordingNames');
const { recordings: recordingsDb } = require('../db/recordingsDb');
const owners = require('./recordingOwners');
const { owned, write } = owners; // R4-D2, 0264: recordings being deleted

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
// #34: the watch copy is made in parts: part 0 is view.m3u8 + init.mp4 + v000000.m4s…, a part k made after its
// follower died is viewk.m3u8 + initk.mp4 + vk-000000.m4s…, going on from the first archive piece not yet copied, so
// nothing already served is ever rewritten.
const PART_FILES = (k) => (k === 0 ? { playlist: 'view.m3u8', init: 'init.mp4', pattern: 'v%06d.m4s' }
    : { playlist: `view${k}.m3u8`, init: `init${k}.mp4`, pattern: `v${k}-%06d.m4s` });
/** The parts of an epoch's watch copy, in order: [{ k, init, parsed }]. */
function viewParts(epochDir) {
    let names = [];
    try { names = fs.readdirSync(epochDir); } catch (e) { return []; }
    return names.map(n => /^view(\d{0,3})\.m3u8$/.exec(n)).filter(Boolean).map(m => Number(m[1] || 0)).sort((a, b) => a - b)
        .map(k => ({ k, init: PART_FILES(k).init, parsed: readPlaylist(path.join(epochDir, PART_FILES(k).playlist)) }));
}
/** The epoch's whole watch copy so far: its parts' segments (each with its part), ended when the last part is. */
function viewOf(epochDir) {
    const parts = viewParts(epochDir);
    const segments = parts.flatMap(p => p.parsed.segments.map(s => ({ ...s, part: p.k, init: p.init })));
    return { segments, ended: parts.length > 0 && parts[parts.length - 1].parsed.ended, parts };
}
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
 * The input half of a recording ffmpeg's arguments, built in one place. From the provider: its
 * user agent and reconnect options, then the URL. From the shared feed (`feed` true): stdin only,
 * since the ingest does the provider-facing part (user agent, reconnect) itself.
 */
function captureInput({ url, userAgent, feed = false }) {
    if (feed) return ['-i', 'pipe:0'];
    return [
        '-user_agent', userAgent,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url
    ];
}

/**
 * The recording ffmpeg for one epoch: the input (captureInput), the mapping, and as output an HLS
 * event playlist of 4 s MPEG-TS segments. make_non_negative rather than make_zero: make_zero would
 * undo -output_ts_offset (it shifts the first timestamp to 0). temp_file: a segment only appears
 * under its name once it is complete.
 */
function captureArgs({ userAgent, url, epochDir, offsetSec = 0, feed = false }) {
    return [
        '-y',
        ...captureInput({ url, userAgent, feed }),
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
 * Video copied (HEVC tagged hvc1, which AVPlayer needs). As in the finished MP4,
 * only AC-3/E-AC-3 audio is copied; everything else is encoded as AAC-LC.
 */
function viewArgs(epochDir, codecs = {}, { part = 0, from = 0, input = 'archive.m3u8' } = {}) {
    const video = (codecs.video || '').toLowerCase();
    const audio = (codecs.audio || '').toLowerCase();
    const files = PART_FILES(part);
    const args = ['-nostdin', '-y', '-live_start_index', String(from), '-i', path.join(epochDir, input),
        '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
    if (video === 'hevc' || video === 'h265') args.push('-tag:v', 'hvc1');
    // ADTS can label HE-AAC as Main, which Apple rejects after an ASC copy.
    // Decode every AAC flavour (and unknown/late audio) instead of trusting the
    // label or a failed probe. Video and the captured archive remain unchanged.
    if (audio !== 'ac3' && audio !== 'eac3') {
        const channels = Math.min(Math.max(parseInt(codecs.audioChannels, 10) || 2, 1), 6);
        args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', String(channels),
            '-b:a', channels > 2 ? '384k' : '192k');
    }
    args.push(
        '-f', 'hls',
        '-hls_time', String(SEGMENT_SEC),
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', files.init,
        '-hls_segment_filename', path.join(epochDir, files.pattern),
        path.join(epochDir, files.playlist)
    );
    return args;
}

/** #34: the archive piece a part started at (part 0 at the first; a later one records it in viewN.from). */
function partFrom(epochDir, k) {
    if (k === 0) return 0;
    try { const n = Number(fs.readFileSync(path.join(epochDir, `view${k}.from`), 'utf8')); return Number.isInteger(n) && n >= 0 ? n : 0; }
    catch (e) { return 0; }
}

/**
 * #34: where a new part of an epoch's watch copy starts: a new part number, at the first archive piece the LAST part
 * did not finish (its start piece, plus the pieces its duration covers in full; 0471 Codex round 1, high: summing
 * every part counted re-copied overlap twice). A piece cut short at the death is copied again rather than lost.
 */
function nextPart(epochDir) {
    const view = viewOf(epochDir);
    if (!view.parts.length) return { part: 0, from: 0 };
    const last = view.parts[view.parts.length - 1];
    const covered = last.parsed.segments.reduce((t, s) => t + s.duration, 0);
    const pieces = archiveOf(epochDir).segments;
    let from = partFrom(epochDir, last.k), t = 0;
    while (from < pieces.length && t + pieces[from].duration <= covered + 0.5) { t += pieces[from].duration; from++; }
    return { part: last.k + 1, from };
}

/** #34: the restart's list of the archive's pieces from `from` on, ENDLIST once the archive has it (written whole). */
function refreshPartInput(epochDir, input, from) {
    const archive = archiveOf(epochDir);
    const rest = archive.segments.slice(from);
    const target = Math.max(1, ...rest.map(s => Math.ceil(s.duration)));
    const text = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${from}`,
        '#EXT-X-PLAYLIST-TYPE:EVENT', ...rest.flatMap(s => [`#EXTINF:${s.duration.toFixed(6)},`, s.name]),
        ...(archive.ended ? ['#EXT-X-ENDLIST'] : []), ''].join('\n');
    const file = path.join(epochDir, input);
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    return archive.ended;
}

/**
 * #34: every restart (a part after the first) reads its own list of the rest of the archive, never the archive with
 * -live_start_index: ffmpeg ignores that index on a closed playlist (measured, ffmpeg 8), and the archive can be sealed
 * between choosing and ffmpeg opening it (0471 Codex round 1, high). The list is kept up to date while the follower
 * runs (startFollower) and closed when the archive is. The part records where it started.
 */
function partInput(epochDir, plan) {
    if (plan.part === 0) return plan;
    const input = `archive-from${plan.part}.m3u8`;
    fs.writeFileSync(path.join(epochDir, `view${plan.part}.from`), String(plan.from));
    refreshPartInput(epochDir, input, plan.from);
    return { part: plan.part, from: 0, input, mirrorFrom: plan.from };
}

async function startFollower(recordingId, epoch) {
    const key = `${recordingId}:${epoch.n}`;
    const first = archiveOf(epoch.dir).segments[0];
    if (!first) return false;
    const entry = followers.get(key) || { proc: null, failures: 0 };
    if (entry.proc || entry.failures >= MAX_FOLLOWER_FAILURES) return false;
    // 0473 (#34, 0472 Codex round 2, high): nothing left to copy (the last part has every piece): ffmpeg would refuse
    // an empty list. A sealed archive's copy is ended here (ENDLIST on the last part, written by no running process);
    // an open one waits for its next piece, no failure counted.
    const ahead = nextPart(epoch.dir);
    const archive = archiveOf(epoch.dir);
    if (ahead.part > 0 && ahead.from >= archive.segments.length) {
        if (archive.ended) {
            const last = viewOf(epoch.dir).parts.pop();
            const file = path.join(epoch.dir, PART_FILES(last.k).playlist);
            try {
                const text = fs.readFileSync(file, 'utf8');
                if (!/#EXT-X-ENDLIST/.test(text)) { fs.writeFileSync(`${file}.tmp`, text.replace(/\s*$/, '\n#EXT-X-ENDLIST\n')); fs.renameSync(`${file}.tmp`, file); }
            } catch (e) { /* tried again on the next request */ }
        }
        return false;
    }
    followers.set(key, entry);
    entry.proc = 'starting';
    const codecs = await media.nativeTools.codecs(path.join(epoch.dir, first.name));
    let proc;
    try {
        var plan = partInput(epoch.dir, nextPart(epoch.dir));
        proc = spawn(media.tools.ffmpegPath, viewArgs(epoch.dir, codecs, plan), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
        entry.proc = null;
        entry.failures++;
        return false;
    }
    entry.proc = proc;
    // #34: a restart's own list follows the archive (every second) until the archive is sealed or the follower ends.
    let mirror = null;
    if (plan.input && plan.input !== 'archive.m3u8') {
        mirror = setInterval(() => {
            try { if (refreshPartInput(epoch.dir, plan.input, plan.mirrorFrom)) { clearInterval(mirror); mirror = null; } } catch (e) { /* next second */ }
        }, 1000);
        mirror.unref?.();
    }
    const tail = [];
    proc.stderr.on('data', d => { for (const l of String(d).split('\n')) if (l.trim()) { tail.push(l.trim()); if (tail.length > 10) tail.shift(); } });
    proc.on('error', () => { /* reported on close */ });
    proc.on('close', (code) => {
        entry.proc = null;
        if (mirror) { clearInterval(mirror); mirror = null; }
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
        // #34: each part has its own init; a discontinuity before each epoch and each part after the first
        view.segments.forEach((s, i) => segments.push({
            name: `${e.name}/${s.name}`, duration: s.duration, map: `${e.name}/${s.init}`,
            discontinuity: segments.length > 0 && (i === 0 || s.part !== view.segments[i - 1].part)
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

/**
 * #287: file calls on `p` from the finishing queue: on the share through shareFs (a helper process with a deadline, never
 * the event loop); in appdata (the work folder) the same calls made here. A share that misses a deadline rejects with
 * SHARE_UNRESPONSIVE: the attempt ends there and the recording keeps its state (not a failed attempt).
 */
function ioFor(p) {
    const rel = path.relative(path.resolve(workRoot()), path.resolve(p));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? shareFs.local : shareFs;
}
const unresponsive = (err) => Boolean(err && err.code === 'SHARE_UNRESPONSIVE');
const notResponding = () => Object.assign(new Error('the recordings folder is not responding'), { code: 'SHARE_UNRESPONSIVE' });
/** The size of `file`, or null when it cannot be read (reported as unknown). */
async function sizeOn(file) {
    try { const s = await ioFor(file).stat(file); return s ? s.size : null; } catch (e) { return null; }
}
/** Remove a file this job made; one that cannot be removed now stays journalled (the next attempt or the sweep). */
async function removeMade(file) {
    // An answer (removed, or nothing there) ends its journal row; no answer keeps it listed.
    try { await ioFor(file).unlink(file); owners.forget(file); } catch (e) { /* stays listed */ }
}

/** The share's channel folder for this recording ({ dir }), or { dir: null, problem } when the share cannot take it now. */
async function shareFolderCheck(rec) {
    let root;
    try { root = await deps.recordingsRoot(); } catch (e) { return { dir: null, problem: shareFs.unresponsive() ? 'unresponsive' : 'missing' }; }
    const check = await checkRecordingsFolderAsync(root, await deps.minFreeGB()); // #8: never blocks on a hung share
    if (!check.ok) return { dir: null, problem: check.problem };
    const dir = path.join(root, rec.segment_folder || 'Unknown Channel');
    try { if (!(await shareFs.exists(dir))) await shareFs.mkdir(dir); } catch (e) { return { dir: null, problem: unresponsive(e) ? 'unresponsive' : 'missing' }; }
    return { dir, problem: null };
}
const shareFolder = async (rec) => (await shareFolderCheck(rec)).dir;

async function removeWork(rec) {
    stopFollowers(rec.id);
    videoInfo.delete(rec.id);
    lastMoveTry.delete(rec.id);
    if (!isWorkDir(rec.work_dir)) return;
    try { await fsp.rm(rec.work_dir, { recursive: true, force: true }); } catch (err) {
        console.warn(`[Recordings] Could not delete the work folder of #${rec.id}: ${err.message}`);
    }
}

/** `size`: read before (sizeOn), so nothing is awaited between the last owned() check and this. */
function completed(rec, file, size, extra = {}) {
    recordingsDb.setSegmentFields(rec.id, { file_path: file, status: 'completed', file_size_bytes: size, ...extra });
    try { recordingsDb.setAdDetectStatus(rec.id, 'pending'); } catch (e) { /* very old database */ }
}

/**
 * F1 (0242): put a finished file in place without ever replacing one that is there. link() fails
 * with EEXIST if the name is taken (atomic, unlike a check before rename), and then the next name
 * `alt(n)` is tried. Returns the path it was published at; the partial is gone. The caller commits
 * the name once the database points at it (owners.committed).
 * #287: through bounded calls, and journalled BEFORE the link, with the partial's identity: a link that misses its
 * deadline may still land, and its name is then this code's to take back (owners.takeBack, the sweep). EEXIST at a name
 * that is this very file (such a late link) adopts it; another file there frees the journal row and tries the next name.
 * An errno answer that proves no link was made (NOT_LINKED) frees the row; any other (EIO, ESTALE...) keeps the row and
 * the partial (keepPartial), so a link that did happen is taken back by the next attempt; either way it is a failed
 * attempt. Only SHARE_UNRESPONSIVE (no answer in time) is a stall: row and partial kept, the attempt given back.
 */
// #287: link answers that prove no link was made; any other (EIO, ESTALE, ETIMEDOUT...) may hide one that was.
const NOT_LINKED = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EXDEV', 'EMLINK', 'ENAMETOOLONG', 'EDQUOT',
    'EOPNOTSUPP', 'ENOTSUP', 'EINVAL', 'ENOTDIR', 'ELOOP']);

async function publishNoReplace(partial, dir, first, alt, id) {
    const io = ioFor(partial);
    owners.hold(partial); // #287: never taken back while it is published
    try {
        let identity;
        try { identity = await io.identity(partial); } catch (err) { if (unresponsive(err)) err.keepPartial = true; throw err; }
        if (!identity) throw new Error('the finished file is missing');
        for (let n = 1; ; n++) {
            const dest = path.join(dir, n === 1 ? first : alt(n));
            if (owners.removalPending(dest)) continue; // #287: a removal of that name may still land: taken
            owners.hold(dest); // before it is journalled; the caller releases it once recorded (or withdrawn)
            let mine = false;
            try {
                if (!owners.published(dest, id, identity)) continue; // the journal lists that name for something else
                try {
                    await io.link(partial, dest);
                } catch (err) {
                    if (unresponsive(err)) { err.keepPartial = true; throw err; }
                    if (err.code !== 'EEXIST') {
                        // Uncertain: the name stays journalled (taken back next attempt). Not a stall: the attempt counts.
                        if (!NOT_LINKED.has(err.code)) { err.keepPartial = true; throw err; }
                        owners.forget(dest);
                        throw err;
                    }
                    let there = null;
                    try { there = await io.identity(dest); } catch (e) { if (unresponsive(e)) { e.keepPartial = true; throw e; } }
                    if (there !== identity) { owners.forget(dest); continue; }
                    // This very file: an earlier link of it that landed late. That name is its own.
                }
                try { await io.unlink(partial); owners.forget(partial); } catch (e) { /* stays listed: taken back later */ }
                mine = true;
                return dest;
            } finally {
                if (!mine) owners.release(dest);
            }
        }
    } finally {
        owners.release(partial);
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
        return await publishNoReplace(partial, dir, first, alt, rec.id);
    } catch (err) {
        if (!err.keepPartial && !unresponsive(err)) await removeMade(partial);
        throw err;
    }
}

/** F1: is `file` byte for byte this recording's segments, joined? (The only proof a file found on the share is its original.) */
async function sameBytesAsSegments(file, rec) {
    const files = segmentFiles(rec);
    let total = 0;
    for (const f of files) total += fs.statSync(f).size; // appdata
    const st = await ioFor(file).stat(file); // #287
    if (!st || st.size !== total) return false;
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
    const { dir, problem } = await shareFolderCheck(rec);
    if (!dir) {
        if (problem === 'unresponsive') throw notResponding(); // #287: a stall, not a failure
        throw new Error('the recordings folder is not usable');
    }
    const name = rec.segment_name || `Recording ${rec.id}`;
    // 0264: a writer of the recording (a deletion stops it and waits); deleted meanwhile, its copy goes.
    const done = await write(rec.id, async (signal, made) => {
        const t = await joinSegments(rec, dir, `${name}.ts`, n => `${name} (${n}).ts`, signal, made);
        const size = await sizeOn(t);
        if (!owned(rec.id)) {
            try { await owners.withdrawBounded(t, rec.id, 'recording', ioFor(t)); } finally { owners.release(t); }
            return null;
        }
        return { target: t, size };
    });
    if (!done) return;
    const { target } = done;
    try {
        completed(rec, target, done.size, { duration_sec: Math.round(stitched.durationSec), segment_state: 'done' });
        owners.committed(target);
    } finally {
        owners.release(target);
    }
    recordingsDb.setNativeStatus(rec.id, 'pending');
    await removeWork(rec);
    console.warn(`[Recordings] #${rec.id} is on the share as ${path.basename(target)} (the MP4 could not be made; it will be prepared as usual)`);
}

// #287: recordings being finished or moved in this process: never two at once for one recording, whoever calls.
const inFlight = new Set();
async function exclusive(id, work) {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try { return await work(); } finally { inFlight.delete(id); }
}

/** Remux the segments to the recording's MP4 and put it on the share (or in appdata while the share is down). */
const finishOne = (rec) => exclusive(rec.id, () => finishNow(rec));
async function finishNow(rec) {
    await owners.whenSwept(); // 0279
    const stitched = stitchArchive(rec.work_dir);
    if (stitched.segments === 0) {
        recordingsDb.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed', error: rec.error || 'Nothing was recorded.' });
        await removeWork(rec);
        return;
    }
    // #287: what an earlier attempt left on the way (a link that landed after its deadline) goes first, so this one
    // never publishes a second copy beside it.
    try { await owners.takeBack(rec.id, ioFor); } catch (err) {
        if (!unresponsive(err)) throw err;
        console.warn(`[Recordings] #${rec.id} waits: the recordings folder is not responding`);
        return;
    }
    const before = rec.segment_attempts || 0;
    if (before >= MAX_FINISH_ATTEMPTS) {
        // #287: its remux attempts are used up (the .ts that followed met a share that did not answer): only the .ts
        // delivery is tried again, never another remux.
        await deliverLastResort(rec, stitched);
        return;
    }
    recordingsDb.setSegmentFields(rec.id, { segment_attempts: before + 1 });
    try {
        await finishAttempt(rec, stitched, before + 1);
    } catch (err) {
        if (!unresponsive(err)) throw err;
        // #287: a share that stopped answering is not a failed attempt: it stays 'finishing' for the next tick.
        if (owned(rec.id)) recordingsDb.setSegmentFields(rec.id, { segment_attempts: before });
        console.warn(`[Recordings] #${rec.id} waits: the recordings folder stopped responding while its file was put there; it is tried again`);
    }
}

/** The .ts once the remux has failed MAX_FINISH_ATTEMPTS times; a share that does not answer leaves it for the next tick. */
async function deliverLastResort(rec, stitched) {
    try {
        if (!owned(rec.id)) return;
        await deliverTs(recordingsDb.getById(rec.id), stitched);
    } catch (err) {
        if (!owned(rec.id)) return; // 0264: stopped by its deletion
        if (unresponsive(err)) { // #287: tried again (the .ts only), not failed
            console.warn(`[Recordings] #${rec.id}: its MP4 could not be made; its .ts waits for the recordings folder to respond`);
            return;
        }
        recordingsDb.setSegmentFields(rec.id, { status: 'failed', segment_state: 'failed',
            error: `The recording could not be finished (${err.message}); its segments are kept in appdata.` });
    }
}

async function finishAttempt(rec, stitched, attempts) {
    const dir = await shareFolder(rec);
    const name = rec.segment_name || `Recording ${rec.id}`;
    let target = dir ? await uniqueFilePathAsync(dir, name, '.mp4', async (p) => owners.removalPending(p) || shareFs.exists(p)) : path.join(rec.work_dir, 'final.mp4');
    const io = ioFor(target);
    try { await io.unlink(`${target}.partial`); } catch (e) { if (unresponsive(e)) throw e; } // the fixed name before 0273
    const partial = owners.partialFor(target); // 0273: its own name, journalled by its writer

    const codecs = await media.nativeTools.codecs(stitched.file);
    console.log(`[Recordings] Making the MP4 of #${rec.id} from ${stitched.segments} segments -> ${dir ? target : 'the work folder (the share is not usable now)'}`);
    // 0264: the remux, its check and (#287) the publication are a writer of the recording: a deletion stops it and waits
    // until it has ended - its partial removed (a problem, or deleted meanwhile) or its MP4 published or withdrawn.
    const mp4Name = path.basename(target, '.mp4');
    const outcome = await write(rec.id, async (signal, made) => {
        made(partial);
        try {
            const result = await media.nativeTools.ffmpeg(media.buildNativeRemuxArgs(stitched.file, partial, codecs), { watchFile: partial, signal, sizeOf: io.sizeOf });
            let problem = null;
            let keep = null;
            if (result.code !== 0 || !(await io.exists(partial))) {
                problem = result.tail.slice(-3).join(' | ') || `ffmpeg exited with code ${result.code}`;
            } else {
                const check = await media.checkPrepared(stitched.file, partial, { signal });
                if (!check.ok) problem = `the MP4 failed its check: ${check.reason}`;
                // DVR-1 (0227): it plays, but could not be compared with the segments (their length or the
                // audio could not be read): the segments are its original and are kept, as preparation keeps one.
                else if (check.keepOriginal) keep = check.reason;
            }
            if (problem || !owned(rec.id)) { await removeMade(partial); return { problem }; }
            // F1: published without replacing a file that appeared at its name meanwhile.
            const published = await publishNoReplace(partial, path.dirname(target), `${mp4Name}.mp4`, n => `${mp4Name} (${n}).mp4`, rec.id);
            const size = await sizeOn(published);
            // #287: deleted while it was published (the link is awaited): that copy goes, nothing is recorded.
            if (!owned(rec.id)) {
                try { await owners.withdrawBounded(published, rec.id, 'MP4', ioFor(published)); } finally { owners.release(published); }
                return {};
            }
            return { target: published, size, keep };
        } catch (err) {
            // A stall keeps it (taken back by the next attempt); any other failure removes it before the writer ends.
            if (!err.keepPartial && !unresponsive(err)) await removeMade(partial);
            throw err;
        }
    });
    const { problem, keep } = outcome;
    if (problem && owned(rec.id)) {
        console.error(`[Recordings] Could not make the MP4 of #${rec.id} (attempt ${attempts}): ${problem}`);
        if (attempts < MAX_FINISH_ATTEMPTS) return;
        await deliverLastResort(rec, stitched); // the attempt stays counted: the remux did fail
        return;
    }
    if (!outcome.target) return; // deleted (or being deleted) meanwhile: nothing of it is left
    target = outcome.target;
    try {
        // Deleted in the moment between the writer's end and this (no call in between): withdrawn, as above.
        if (!owned(rec.id)) { await owners.withdrawBounded(target, rec.id, 'MP4', ioFor(target)); return; }
        media.verifiedNativeFiles.add(target);
        // F2 (0243): with an original to keep the row says 'moving' until that original is published,
        // so a restart mid-copy finds it in findSegmentWork() and finishes the move.
        completed(rec, target, outcome.size, { duration_sec: Math.round(stitched.durationSec), segment_state: dir && !keep ? 'done' : 'moving', segment_keep: keep });
        owners.committed(target);
    } finally {
        owners.release(target); // #287: recorded or withdrawn: takeBack may see it again
    }
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
            // 0280: never a file the clean-up sweep may still remove (owners.adoptable). #287: bounded calls.
            if (known && (await ioFor(known).exists(known)) && (await owners.adoptable(known, ioFor(known))) && await sameBytesAsSegments(known, rec)) {
                if (!owned(rec.id)) return false; // R4-D2: a file found, not published here: left alone
                recordingsDb.setSegmentFields(rec.id, { segment_original: known });
                return true;
            }
        }
        // 0264: a writer of the recording (a deletion stops it and waits).
        const published = await write(rec.id, async (signal, made) => {
            const p = await joinSegments(rec, dir, `${base}.ts`, n => `${base} (original${n > 2 ? ` ${n - 1}` : ''}).ts`, signal, made);
            // D1 (0251), R4-D2: deleted (or being deleted) while it was copied - this copy is its own, so it goes too.
            if (!owned(rec.id)) {
                try { await owners.withdrawBounded(p, rec.id, 'kept original', ioFor(p)); } finally { owners.release(p); }
                return null;
            }
            return p;
        });
        if (!published) return false;
        try {
            recordingsDb.setSegmentFields(rec.id, { segment_original: published });
            owners.committed(published);
        } finally {
            owners.release(published);
        }
        return true;
    } catch (err) {
        console.warn(`[Recordings] #${rec.id}: its original could not be put on the share yet (${err.message}); its segments stay in appdata`);
        return false;
    }
}

const inWork = (rec) => Boolean(rec.work_dir && rec.file_path && rec.file_path.startsWith(rec.work_dir + path.sep));

/** An MP4 left in appdata while the share was down goes to the share (and, DVR-1, a kept original with it). */
const moveOne = (rec) => exclusive(rec.id, () => moveNow(rec));
async function moveNow(rec) {
    await owners.whenSwept(); // 0279
    lastMoveTry.set(rec.id, Date.now());
    // #287: what an earlier attempt left on the way goes first (see finishOne).
    try { await owners.takeBack(rec.id, ioFor); } catch (err) {
        if (!unresponsive(err)) throw err;
        console.warn(`[Recordings] #${rec.id} could not move to the recordings folder yet: it is not responding`);
        return;
    }
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
                let t;
                try {
                    await pipeline(fs.createReadStream(source), fs.createWriteStream(partial, { flags: 'wx' }), { signal });
                    const copied = await ioFor(partial).stat(partial); // #287
                    if (!copied || copied.size !== fs.statSync(source).size) throw new Error('the copy is not the same size');
                    t = await publishNoReplace(partial, dir, `${name}.mp4`, n => `${name} (${n}).mp4`, rec.id); // F1
                } catch (err) {
                    // Removed while this is still its writer (#287: the call is awaited now), so a deletion waiting
                    // for it returns only once the partial is gone (0264).
                    if (!err.keepPartial && !unresponsive(err)) await removeMade(partial);
                    throw err;
                }
                if (!owned(rec.id)) {
                    try { await owners.withdrawBounded(t, rec.id, 'MP4', ioFor(t)); } finally { owners.release(t); }
                    return null;
                }
                return t;
            });
            if (!target) return;
        } catch (err) {
            console.warn(`[Recordings] #${rec.id} could not move to the recordings folder yet: ${err.message}`);
            return;
        }
        media.verifiedNativeFiles.delete(source);
        media.verifiedNativeFiles.add(target);
        try {
            recordingsDb.setSegmentFields(rec.id, { file_path: target });
            owners.committed(target);
        } finally {
            owners.release(target);
        }
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
 * #287: the share is read through bounded calls; one it does not answer ends the check, which runs again next time.
 */
async function recoverLegacyOriginals() {
    for (const rec of recordingsDb.findUnprovenOriginals()) {
        const conventional = keptOriginalPath(rec.file_path);
        const io = ioFor(conventional);
        const files = segmentFiles(rec);
        if (files.length && files.every(f => fs.existsSync(f))) { // appdata
            if ((await io.exists(conventional)) && (await owners.adoptable(conventional, io)) && await sameBytesAsSegments(conventional, rec)) {
                recordingsDb.setSegmentFields(rec.id, { segment_original: conventional });
                console.log(`[Recordings] #${rec.id}: its kept original is ${path.basename(conventional)} (the same bytes as its segments)`);
            } else {
                recordingsDb.setSegmentFields(rec.id, { segment_state: 'moving' });
                console.warn(`[Recordings] #${rec.id}: its kept original was never finished; it is copied again under its own name`);
            }
        } else if (await io.exists(conventional)) {
            console.warn(`[Recordings] #${rec.id}: ${path.basename(conventional)} beside it may be the original an earlier build kept, ` +
                'but that cannot be proven; it is left in place, also if the recording is deleted');
        }
    }
}
let legacyChecked = false;

/** One step of the queue: finish the oldest capture that has ended, else retry one waiting move. */
async function processQueue(now = Date.now()) {
    // #287: claimed before the first await, so two calls never run their bodies at once (the legacy check included).
    if (finishing) return;
    finishing = true;
    let next = null;
    try {
        await owners.whenSwept(); // 0279: never beside the start-up sweep
        if (!legacyChecked) {
            legacyChecked = true;
            try { await recoverLegacyOriginals(); } catch (err) {
                if (err.code === 'SHARE_UNRESPONSIVE') legacyChecked = false; // #287: checked again (inside this guard) once the share answers
                console.error('[Recordings] Checking kept originals failed:', err.message);
            }
        }
        const pending = recordingsDb.findSegmentWork();
        next = pending.find(r => r.segment_state === 'finishing')
            || pending.find(r => r.segment_state === 'moving' && now - (lastMoveTry.get(r.id) || 0) >= MOVE_RETRY_MS);
        if (!next) return;
        if (next.segment_state === 'finishing') await finishOne(next);
        else await moveOne(next);
    } catch (err) {
        console.error(`[Recordings] Finishing #${next ? next.id : '?'} failed:`, err.message);
    } finally {
        finishing = false;
    }
}

// I-6 (#273): the Status page polls every 5 s; free space is read from the disk at most once a minute.
const FREE_BYTES_TTL_MS = 60000;
let freeBytesCache = null;
let freeBytesNow = Date.now; // a test may replace it through _resetFreeBytes
function _resetFreeBytes(clock) { freeBytesCache = null; freeBytesNow = clock || Date.now; }
function readFreeBytes() {
    const t = freeBytesNow();
    if (freeBytesCache && t - freeBytesCache.at < FREE_BYTES_TTL_MS && t >= freeBytesCache.at) return freeBytesCache.value;
    let freeBytes = null;
    try { fs.mkdirSync(workRoot(), { recursive: true }); const st = fs.statfsSync(workRoot()); freeBytes = st.bavail * st.bsize; } catch (e) { /* unknown */ }
    freeBytesCache = { at: t, value: freeBytes };
    return freeBytes;
}

/** For the Status page: the appdata folder and what is still in it. */
function status() {
    const rows = recordingsDb.findWithWorkDir();
    const freeBytes = readFreeBytes();
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
    SEGMENT_SEC, workRoot, ioFor, workDirFor, isWorkDir, epochs, nextEpoch, captureInput, captureArgs, captureBytes,
    sealEpoch, sealAll, stitchArchive, recordedSeconds, archiveSegmentCount,
    viewArgs, _resetFreeBytes,
    _partInput: partInput,
    _refreshPartInput: refreshPartInput,
    _nextPart: nextPart, ensureView, stopFollowers, viewPlaylist, probeVideoInfo, isWatchable,
    configure, processQueue, finishOne, moveOne, removeWork, status, keptOriginalPath, recoverLegacyOriginals,
    _publishNoReplace: publishNoReplace,
    _setWorkRoot, _followers: followers
};
