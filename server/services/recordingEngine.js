/**
 * DVR Recording Engine
 *
 * A persistent, server-side scheduler + ffmpeg process manager for EPG-based
 * scheduled recordings. This is intentionally separate from transcodeSession.js:
 * that module serves short-lived per-viewer HLS sessions tied to a browser tab,
 * while this one runs independently of any client connection (recordings must
 * keep going whether or not anyone is watching, and must resume correctly
 * across container restarts as long as the schedule itself is still in the future).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sources: sourcesDb, getUserAgent } = require('../db');
const { scheduled: scheduledDb, recordings: recordingsDb } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('./xtreamApi');
const coordinator = require('./streamCoordinator');
const { formatLocalStamp } = require('./recordingNames');
const { redact } = require('../redact');
const { checkRecordingsFolder, refusalMessage, onTinyFilesystem } = require('./recordingsFolder');
const providerRouting = require('./providerRouting');
const { providerFailureIn } = require('./transcodeSession');
// Split out in the simplification build: making recordings playable (media) and what runs
// after one (post); jobs is what each is busy with. Everything is re-exported below.
const media = require('./recordingMedia');
const post = require('./recordingPost');
const jobs = require('./recordingJobs');
const { fileSizeOf, getFreeSpaceGB, compressionTargetPath, nativePlaybackTargetPath, verifiedNativeFiles } = media;
const { processCompressionQueue, processAdDetectionQueue } = post;

const TICK_INTERVAL_MS = 15 * 1000;
const STDERR_TAIL_LINES = 40;

// Provider failover for recordings (0177, multi-provider brief 2.7; default path only,
// and only with a backup provider configured). Tunable so a test need not wait them out.
const failoverTuning = {
    // An ffmpeg that ends this soon after it was started (or before it wrote anything)
    // failed to START: the next provider takes over the same recording row.
    startFailoverMs: 20 * 1000,
    // An ffmpeg that ends later has recorded something: the recording continues in a
    // new part. Not within this long of the stop time, though - that is simply the end.
    endGraceMs: 10 * 1000,
    // A recording file that has not grown for this long has stalled (the provider went
    // silent without closing the connection; ffmpeg's -reconnect can wait on it for
    // ever). Checked on the scheduler's tick, so noticed within stallMs + 15 s.
    stallMs: 30 * 1000,
    // At most this many parts per schedule.
    maxParts: 3
};

// 0207: live break detection starts once a part's file holds this much (a few seconds of
// video), enough for Comskip to find the streams in it.
const LIVE_DETECT_MIN_BYTES = 4 * 1024 * 1024;

let tickTimer = null;
let tickRunning = false;
// scheduledId -> { proc, recordingId, hardStopTimer, stderrTail: [] }
// (0177, default path: also the schedule, its provider route, which candidate and
// part this is, and whether a stop was asked for - see spawnPart.)
const active = new Map();
jobs.capturing = () => active.size; // capture outranks every recording job
// 0177: schedules whose provider died mid-recording and whose next part is waiting
// for a free connection. Still `recording`; retried every tick until the stop time.
// scheduledId -> { schedule, nextPart, lostAt, starting, waitingLogged }
const continuations = new Map();

function sanitizeForFs(str) {
    return String(str || 'Untitled')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150) || 'Untitled';
}

async function getSettings() {
    const { settings } = require('../db');
    return settings.get();
}

/**
 * The configured recordings folder, creating it if needed - but (0157) only the
 * final path segment, and only when its parent already exists. `mkdirSync`'s
 * `recursive: true` used to create every missing segment, which meant a stale
 * Docker bind mount (the share never actually attached, so the mount point is
 * simply an empty directory on the container's own filesystem) got a real
 * folder tree written straight into it - recordings then "succeeded" onto
 * ephemeral container storage, not the network share, and vanished on the next
 * restart with no error at all. Refusing to create anything above the final
 * folder turns that into a clear, immediate failure instead.
 */
async function getRecordingsRoot() {
    const settings = await getSettings();
    const root = settings.recordingsPath || '/app/recordings';
    if (!fs.existsSync(root)) {
        const parent = path.dirname(root);
        if (!fs.existsSync(parent)) {
            throw new Error(`The recordings folder's parent does not exist: ${parent}. Is the share mounted?`);
        }
        // 0160: nor inside a disconnected share's empty mount point, which exists
        // but sits on a tiny tmpfs (Unraid's /mnt/remotes).
        if (onTinyFilesystem(parent)) {
            throw new Error(`The recordings folder isn't reachable: ${root} does not exist and ${parent} is not on a real volume. Is the network share connected?`);
        }
        fs.mkdirSync(root);
    }
    return root;
}

/**
 * True when there is enough room to start or continue recording.
 * `factor` lets the mid-recording check use a lower bar than the pre-flight
 * one, so an in-progress recording is not killed the moment it dips under the
 * threshold that would have blocked a new one.
 */
function hasFreeSpace(dir, minGB, factor = 1) {
    const freeGB = getFreeSpaceGB(dir);
    if (freeGB === null) return { ok: true, freeGB: null };
    return { ok: freeGB >= (minGB * factor), freeGB };
}

function uniqueFilePath(dir, baseName, ext) {
    let candidate = path.join(dir, `${baseName}${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${baseName} (${n})${ext}`);
        n++;
    }
    return candidate;
}

/**
 * Resolve a playable stream URL for a channel, mirroring the logic used by
 * the proxy/transcode routes for M3U (SQLite-backed) and Xtream sources.
 */
/**
 * The identity of the channel a caller named, accepting the composite id the web
 * app sends and the bare one the native client does - the same forms
 * resolveStreamUrl accepts. Null when the channel is not in the playlist.
 */
function channelIdentity(sourceId, channelItemId) {
    try {
        const raw = String(channelItemId);
        const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');
        return getDb().prepare(`
            SELECT stable_id FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND (item_id = ? OR item_id = ?) LIMIT 1
        `).get(sourceId, raw, stripped)?.stable_id || null;
    } catch (e) {
        return null;   // never the reason a recording cannot be scheduled
    }
}

async function resolveStreamUrl(sourceId, channelItemId, stableId = null) {
    const source = await sourcesDb.getById(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    if (source.type === 'xtream') {
        const api = xtreamApi.createFromSource(source);
        return api.buildStreamUrl(channelItemId, 'live', 'ts');
    }

    // M3U (and anything else synced into playlist_items) - stream URL lives in
    // the stored item data (see syncService.saveStreams / m3uParser).
    //
    // The client identifies a channel by its composite id (m3u_<source>_<item>),
    // which is what the EPG row carries, but playlist_items stores the bare
    // item_id. Accept either, and the fully-qualified `id` column too, so a
    // schedule stored by any of those forms still resolves.
    const db = getDb();
    const raw = String(channelItemId);
    const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');

    // The identity first when the schedule carries one: it is what the schedule is
    // FOR, and unlike the position it still means the same channel after a reorder.
    // Ordered by position so a channel listed in several categories resolves to the
    // same row every time.
    const item = (stableId && db.prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND stable_id = ?
        ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC
        LIMIT 1
    `).get(sourceId, stableId)) || db.prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live'
          AND (item_id = ? OR item_id = ? OR id = ?)
        LIMIT 1
    `).get(sourceId, raw, stripped, `${sourceId}:${stripped}`);

    if (!item) throw new Error(`Channel ${channelItemId} not found for source ${sourceId}`);

    if (item.stream_url) return item.stream_url;

    try {
        const data = JSON.parse(item.data || '{}');
        if (data.url) return data.url;
        if (data.stream_url) return data.stream_url;
    } catch (e) { /* fall through */ }

    throw new Error(`No stream URL available for channel ${channelItemId}`);
}

// ---------------------------------------------------------------------------
// Which provider a recording uses (0177, multi-provider brief 2.7; default path)
//
// The same ordered candidates a play gets (providerRouting.plan: the primary, its
// own "(Backup)" sibling unless the primary is down, then the backups in their
// Settings → Providers order). The primary candidate's stream is still found the way
// it always was (resolveStreamUrl: the schedule's channel identity first), and plan
// is asked about the playlist row that identity names now, so both agree on the
// channel. With no backup configured the route is the primary alone and every
// decision below is exactly the one made before.
// ---------------------------------------------------------------------------

/** The item_id the schedule's channel has now (its identity first, as resolveStreamUrl finds it). */
function currentItemId(source, schedule) {
    if (!source || source.type === 'xtream' || !schedule.channel_stable_id) return schedule.channel_item_id;
    try {
        const row = getDb().prepare(`
            SELECT item_id FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND stable_id = ?
            ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC
            LIMIT 1
        `).get(schedule.source_id, schedule.channel_stable_id);
        return row ? row.item_id : schedule.channel_item_id;
    } catch (e) {
        return schedule.channel_item_id;
    }
}

/**
 * { candidates: [{ providerId, providerName, role, via, url, channelKey }], primaryKey, multi }.
 * Throws what resolveStreamUrl throws (the schedule then fails, as before).
 */
async function routeFor(schedule) {
    const primaryUrl = await resolveStreamUrl(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id || null);
    const single = {
        candidates: [{ providerId: schedule.source_id, providerName: null, role: 'primary', via: 'primary', url: primaryUrl, channelKey: null }],
        primaryKey: null,
        multi: false
    };
    let plan;
    try {
        const source = await sourcesDb.getById(schedule.source_id);
        plan = await providerRouting.plan(schedule.source_id, currentItemId(source, schedule));
    } catch (e) {
        return single; // nothing to fail over to that plan can name: as before
    }
    if (!plan || !plan.backupsConfigured) return single;
    return {
        candidates: plan.candidates.map(c => (c.via === 'primary' ? { ...c, url: primaryUrl } : c)),
        primaryKey: plan.primaryKey,
        multi: true
    };
}

/** The first candidate after `from` with a free connection (canRecordFreely), or -1. */
function freeCandidate(route, settings, from = 0) {
    const recordings = listActive();
    for (let i = from; i < route.candidates.length; i++) {
        if (coordinator.canRecordFreely(route.candidates[i].providerId, settings, recordings)) return i;
    }
    return -1;
}

/**
 * The provider a due recording starts on, and the coordinator's verdict for it:
 * the first candidate with a free connection, without asking anybody; when none is
 * free, today's prompt flow on the first candidate (the 0158 timeout included).
 * With no backup configured, today's requestForRecording on the schedule's source.
 */
async function chooseProvider(schedule, settings) {
    let route;
    try {
        route = await routeFor(schedule);
    } catch (err) {
        // The channel cannot be resolved: as before, the coordinator is asked first and
        // the recording then fails in startRecording, where the resolve is tried again.
        return { route: null, index: 0, verdict: await coordinator.requestForRecording(schedule, settings, schedule.source_id) };
    }
    if (!route.multi) {
        return { route, index: 0, verdict: await coordinator.requestForRecording(schedule, settings, schedule.source_id) };
    }
    const index = freeCandidate(route, settings);
    if (index < 0) {
        return { route, index: 0, verdict: await coordinator.requestForRecording(schedule, settings, route.candidates[0].providerId) };
    }
    // Free: requestForRecording is still called, for its reclaim of abandoned streams in
    // that pool. It can only say no when the pool is one live viewer plus abandoned
    // streams at a limit above 1 - there is a free connection (canRecordFreely), so the
    // recording goes ahead without a prompt either way.
    const verdict = await coordinator.requestForRecording(schedule, settings, route.candidates[index].providerId);
    if (!verdict.allowed) coordinator.clearPrompt(schedule.id);
    if (index > 0) {
        console.log(`[Recordings] Schedule #${schedule.id} records on ${route.candidates[index].providerName}: ` +
            `${route.candidates[0].providerName} has no free connection`);
    }
    // R11: the lease on the connection (requestForRecording took it when it allowed; when it
    // said no, a connection is free all the same - canRecordFreely - so take one now).
    const lease = verdict.lease || coordinator.takeLease(route.candidates[index].providerId, 'recording', { schedule });
    return { route, index, verdict: { allowed: true, reason: verdict.allowed ? verdict.reason : 'A provider connection is free', lease } };
}

/** The provider an upcoming recording's viewer warning is about; undefined when none is needed. */
async function announceProviderFor(schedule, settings) {
    let route;
    try { route = await routeFor(schedule); } catch (e) { return schedule.source_id; }
    if (!route.multi) return schedule.source_id;
    return freeCandidate(route, settings) >= 0 ? undefined : route.candidates[0].providerId;
}

async function scheduleFromProgram({
    sourceId, channelItemId, channelName, channelLogo,
    title, description, programStart, programEnd,
    preBufferMin, postBufferMin, createdBy
}) {
    if (!sourceId || !channelItemId) throw new Error('sourceId and channelItemId are required');
    // Store the bare item_id, not the client's composite m3u_<source>_<item>
    channelItemId = String(channelItemId).replace(/^(?:m3u|xtream)_\d+_/, '');
    if (!programStart || !programEnd || programEnd <= programStart) {
        throw new Error('Valid programStart/programEnd are required');
    }

    const settings = await getSettings();
    const pre = Number.isFinite(preBufferMin) ? preBufferMin : settings.defaultPreBufferMin;
    const post = Number.isFinite(postBufferMin) ? postBufferMin : settings.defaultPostBufferMin;

    const existing = scheduledDb.findByProgram(sourceId, String(channelItemId), programStart);
    if (existing) return existing;

    return scheduledDb.create({
        title: title || 'Untitled Program',
        description: description || null,
        source_id: sourceId,
        channel_item_id: String(channelItemId),
        // What the schedule is FOR. Resolved now, while the playlist still says
        // where this channel is; by the time it records, the position may not.
        channel_stable_id: channelIdentity(sourceId, channelItemId),
        channel_name: channelName || null,
        channel_logo: channelLogo || null,
        program_start: programStart,
        program_end: programEnd,
        pre_buffer_min: pre,
        post_buffer_min: post,
        created_by: createdBy || null,
        created_at: Date.now()
    });
}

const RECENT_PROBLEMS_MS = 7 * 24 * 60 * 60 * 1000; // how long a missed/failed schedule stays visible (0156)

/**
 * The upcoming/in-progress list, same as ever, plus - only when asked - schedules
 * that ended up missed or failed whose programme ended within the last 7 days
 * (0156). Without `includeRecent` the result is exactly listUpcoming(): the plain
 * route stays byte-for-byte compatible with what the Apple client already decodes.
 */
function listScheduled({ includeRecent = false } = {}) {
    const upcoming = scheduledDb.listUpcoming();
    if (!includeRecent) return upcoming;
    const recent = scheduledDb.findRecentProblems(Date.now() - RECENT_PROBLEMS_MS);
    return [...upcoming, ...recent];
}

/**
 * scheduledDb.setStatus, plus one log line per actual status change (0156).
 *
 * `schedule` is either the row already in hand (its `.status` is trusted as
 * "before", no extra query) or a bare id (the current row is read first to
 * find it). Every path that changes a schedule's status goes through this -
 * including the `missed` paths in tick() and reconcileOnStartup(), which used
 * to set the status with no log line at all - so nothing is silent. A status
 * that does not actually change is never logged (the tick's own guard around
 * `waiting` already avoided repeating that one; this covers every other
 * caller the same way, since "before" and "after" are simply compared).
 */
function setScheduleStatus(schedule, status, extra = {}) {
    const id = (typeof schedule === 'object' && schedule !== null) ? schedule.id : schedule;
    const before = (typeof schedule === 'object' && schedule !== null) ? schedule : scheduledDb.getById(id);
    const prevStatus = before?.status;
    const updated = scheduledDb.setStatus(id, status, extra);
    if (updated && prevStatus && prevStatus !== status) {
        const title = updated.title || before?.title || 'Untitled';
        const channel = updated.channel_name || before?.channel_name || 'Unknown channel';
        const reason = extra.error ? `: ${extra.error}` : '';
        console.log(`[Recordings] Schedule #${id} "${title}" (${channel}): ${prevStatus} -> ${status}${reason}`);
    }
    return updated;
}

function listActive() {
    // 0173: each with the provider whose connection it holds, for the coordinator's
    // pools - the one it was started on, else its schedule's source.
    // 0177: a schedule waiting for a free connection to continue in its next part
    // holds no connection, so it is not listed.
    return scheduledDb.findActive().filter(row => !continuations.has(row.id)).map(row => {
        const entry = active.get(row.id);
        return { ...row, providerId: entry && entry.providerId !== undefined ? entry.providerId : (row.source_id ?? null) };
    });
}

/**
 * Stop a recording because a viewer asked for the stream.
 *
 * Finalises rather than discards: whatever was captured is kept and flagged
 * partial, so the Recordings list can explain itself. The schedule is marked
 * completed, not cancelled — it did record, just not all of it.
 */
async function stopForViewer(scheduleId) {
    const id = Number(scheduleId);
    if (!active.has(id)) return false;

    console.log(`[Recordings] Stopping recording for schedule #${id}: a viewer asked for the stream`);
    const entry = active.get(id);
    if (entry && entry.recordingId) {
        recordingsDb.markPartial(entry.recordingId, 0);
    }
    await stopRecording(id, 'completed');
    setScheduleStatus(id, 'completed', {
        error: 'Stopped early: the provider stream was needed for live viewing.'
    });
    coordinator.clearPrompt(id);
    return true;
}

/**
 * Every recording, as its rows. 0177 (additive): each part of a recording that
 * continued on another provider is its own item, with `part` and `provider_id`
 * (columns) and `provider_name` - the provider's name only, never its address.
 */
function listRecordings(userId = null) {
    const rows = recordingsDb.listAll();
    let names = new Map();
    try {
        names = new Map(getDb().prepare('SELECT id, data FROM app_sources').all().map(r => {
            let name = null;
            try { name = JSON.parse(r.data).name || null; } catch (e) { /* unnamed */ }
            return [Number(r.id), name];
        }));
    } catch (e) { /* no names: null */ }
    // 0207: this login's resume position and watched flag on every row (0 / false for none).
    const positions = userId === null || userId === undefined ? new Map() : recordingsDb.positionsFor(userId);
    return rows.map(r => ({
        ...r,
        position_sec: positions.get(r.id)?.position_sec ?? 0,
        watched: positions.get(r.id)?.watched ?? false,
        provider_name: r.provider_id === null || r.provider_id === undefined ? null : (names.get(Number(r.provider_id)) ?? null)
    }));
}

async function cancelScheduled(id) {
    const schedule = scheduledDb.getById(id);
    if (!schedule) throw new Error('Scheduled recording not found');

    if (schedule.status === 'recording' && active.has(id)) {
        await stopRecording(id, 'cancelled');
    } else if (schedule.status === 'recording' && continuations.has(id)) {
        // 0177: between parts (waiting for a free provider): nothing is running.
        continuations.delete(id);
        setScheduleStatus(schedule, 'cancelled');
    } else if (schedule.status === 'scheduled' || schedule.status === 'waiting') {
        // A waiting recording is one held back for a viewer: cancelling it must also
        // withdraw the prompt that asks that viewer to stop watching.
        setScheduleStatus(schedule, 'cancelled');
        coordinator.clearPrompt(id);
    } else if (schedule.status === 'failed' || schedule.status === 'missed') {
        // 0207: a problem listed under "Recent problems" is deleted, not cancelled (it has
        // nothing left to cancel). Its failed recordings - a part that never got going, or a
        // partial file - go with it, files and all, through deleteRecording so the file family
        // is cleared the same way; a part that completed (an earlier one of a failover) is a
        // real recording and stays.
        for (const rec of recordingsDb.listBySchedule(id)) {
            if (rec.status === 'failed') await deleteRecording(rec.id);
        }
        scheduledDb.delete(id);
        return { deleted: true };
    }
    return scheduledDb.getById(id);
}

async function deleteRecording(id) {
    const rec = recordingsDb.getById(id);
    if (!rec) throw new Error('Recording not found');

    // 0207: nor may a live break-detection run go on reading a file about to go.
    post.abortLive(id);

    // If it's still actively recording, stop it first
    for (const [scheduledId, entry] of active.entries()) {
        if (entry.recordingId === id) {
            await stopRecording(scheduledId, 'deleted');
            break;
        }
    }

    if (rec.file_path) {
        // The recording and everything derived from it. The native-playback
        // remux and, when "keep original" is on, the compressed copy sit beside
        // the .mkv under names built from it; deleting only the .mkv used to
        // orphan them on disk, unlisted and uncounted.
        // 0192: and, once preparation has replaced the .mkv with "<name>.mp4", an
        // original it kept, plus any job's temporary output.
        const native = nativePlaybackTargetPath(rec.file_path);
        const base = path.join(path.dirname(rec.file_path), path.basename(rec.file_path, path.extname(rec.file_path)));
        const compressed = compressionTargetPath(rec.file_path);
        for (const file of new Set([rec.file_path, native, `${native}.partial`, compressed, `${compressed}.partial`, `${base}.mkv`, `${base}.ts`, `${base}.mp4`])) {
            if (!fs.existsSync(file)) continue;
            try { fs.unlinkSync(file); } catch (e) {
                console.warn('[Recordings] Failed to delete file:', e.message);
            }
            verifiedNativeFiles.delete(file);
        }
    }
    recordingsDb.delete(id);
}

async function startRecording(schedule, choice = null) {
    // R11: the connection lease chooseProvider's verdict carries; startPart binds or releases it.
    const lease = choice && choice.verdict ? choice.verdict.lease || null : null;
    // 0177: tick() chose the provider (chooseProvider); anyone else gets the first candidate.
    let route = choice && choice.route;
    if (!route) {
        try {
            route = await routeFor(schedule);
        } catch (err) {
            console.error(`[Recordings] Could not resolve stream for schedule ${schedule.id}:`, err.message);
            setScheduleStatus(schedule.id, 'failed', { error: err.message });
            coordinator.releaseLease(lease);
            return;
        }
    }
    return startPart(schedule, route, choice ? choice.index : 0, 1, {
        lease,
        refuse: (msg) => setScheduleStatus(schedule.id, 'failed', { error: msg })
    });
}

/**
 * Start part `part` of a recording on candidate `index` of `route`: pre-flight the
 * folder, create its recordings row, spawn ffmpeg. Part 1 is the recording as it has
 * always been; parts 2 and 3 (0177) continue it after its provider died, in a file of
 * their own beside it ("<title - date> (part N).mkv"), with the gap noted.
 * `refuse(message)` is called when the folder check fails.
 */
async function startPart(schedule, route, index, part, opts = {}) {
    // R11: whatever happens, a lease this start was given is either bound to the running recording
    // (and released when its ffmpeg exits) or given back here - never left to expire.
    let started = false;
    try {
        started = await startPartLeased(schedule, route, index, part, opts);
    } finally {
        if (!started) coordinator.releaseLease(opts.lease);
    }
}

async function startPartLeased(schedule, route, index, part, { gapMs = 0, refuse, lease = null } = {}) {
    const settings = await getSettings();
    // A viewer that forced the stream while this start was getting ready took the lease with it:
    // the connection is theirs, so this recording waits for the next tick instead.
    if (lease && !coordinator.leaseAlive(lease)) {
        console.log(`[Recordings] Schedule #${schedule.id}: its connection was taken before it started; waiting`);
        return false;
    }
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    let root;
    try {
        root = await getRecordingsRoot();
    } catch (err) {
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${err.message}`);
        refuse(err.message);
        return false;
    }

    // Pre-flight storage check (0157: also catches an unmounted network share,
    // which reads back as a tiny filesystem rather than as missing - the case
    // that actually happened live; see recordingsFolder.js). Recordings are
    // stream copies of live TV with no size bound, so starting one on a
    // nearly full (or not really mounted) volume is a good way to take the
    // whole share down with it.
    // 0160: always checked; a minimum of 0 only switches off the low-space part
    // (checkRecordingsFolder ignores free space then), never the unmounted-share one.
    const check = checkRecordingsFolder(root, minFreeGB);
    if (!check.ok) {
        const msg = refusalMessage(check, root, minFreeGB);
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${msg}`);
        refuse(msg);
        return false;
    }

    const channelDir = path.join(root, sanitizeForFs(schedule.channel_name || 'Unknown Channel'));
    if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

    // Local time, not UTC - a 7:30pm program should read 19-30 in the filename.
    // "Local" is the process's TZ, which docker-compose.yml passes through.
    const dateStr = formatLocalStamp(schedule.program_start);
    const baseName = `${sanitizeForFs(schedule.title)} - ${dateStr}${part > 1 ? ` (part ${part})` : ''}`;
    const outputPath = uniqueFilePath(channelDir, baseName, '.ts'); // 0203: was .mkv
    const candidate = route.candidates[index];

    const recording = recordingsDb.create({
        scheduled_id: schedule.id,
        title: schedule.title,
        channel_name: schedule.channel_name,
        channel_logo: schedule.channel_logo,
        source_id: schedule.source_id,
        channel_item_id: schedule.channel_item_id,
        file_path: outputPath,
        started_at: Date.now(),
        provider_id: candidate.providerId ?? null,
        part
    });

    if (part === 1) {
        // A recording held back by a viewer starts late. Record how much of the
        // programme was already gone, so the list can say "missing the first 12
        // minutes" rather than a bare "partial".
        const intendedStart = schedule.program_start - (schedule.pre_buffer_min || 0) * 60000;
        const lateBy = Date.now() - intendedStart;
        if (lateBy > 30000) {
            recordingsDb.markPartial(recording.id, lateBy);
            console.log(`[Recordings] #${recording.id} starts ${Math.round(lateBy / 60000)} min into the programme`);
        }
    } else {
        // A continuation misses whatever went by between the parts.
        recordingsDb.markPartial(recording.id, gapMs);
    }

    coordinator.clearPrompt(schedule.id);
    setScheduleStatus(schedule.id, 'recording', { recording_id: recording.id });
    // From here the schedule's row says 'recording' and listActive() counts it: the lease stops
    // counting (it would be counted twice) and is released when the ffmpeg exits (onPartExit).
    if (lease) coordinator.bindLeaseToRecording(lease, recording.id);

    spawnPart(schedule, settings, { recordingId: recording.id, outputPath, route, index, part, lostAt: part > 1 ? Date.now() - gapMs : null, lease });
    return true;
}

/** Run ffmpeg for one part on its candidate. Its exit decides what happens next (onPartExit). */
function spawnPart(schedule, settings, { recordingId, outputPath, route, index, part, lostAt = null, lease = null }) {
    const candidate = route.candidates[index];
    const args = [
        '-y',
        // The same identity playback presents (the userAgentPreset setting). A
        // provider that fingerprints the UA otherwise sees a different client
        // for recordings than for viewing, and this used to ignore the setting.
        '-user_agent', getUserAgent(settings),
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', candidate.url,
        // Map video and audio only (teletext, SCTE-35 and other private data
        // streams are not wanted in a recording). -ignore_unknown covers
        // anything ffmpeg cannot classify at all.
        '-map', '0:v?',
        '-map', '0:a?',
        '-ignore_unknown',
        '-sn', '-dn',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        // 0203: MPEG-TS, the provider's own framing, not Matroska. Matroska keeps ONE audio
        // config for the whole file (from the first frame), so a channel that changes its
        // audio at an ad break (HE-AAC <-> LC, rate, channels) recorded garbage audio from
        // then on - recording #5, 4 Oct; reproduced: 298 decode errors and silence. In TS each
        // ADTS frame carries its own header. TS survives being cut off just as well.
        '-f', 'mpegts',
        outputPath
    ];

    // The provider is named only when there is more than one to choose from (never its URL).
    const on = route.multi ? ` on ${candidate.providerName}` : '';
    console.log(`[Recordings] Starting recording #${recordingId} for schedule #${schedule.id}: "${schedule.title}"${on} -> ${outputPath}`);

    const proc = spawn(media.tools.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    // providerId (0173): the pool this recording's connection counts in - the
    // candidate it was started on (0177), the schedule's own source without backups.
    const now = Date.now();
    const entry = {
        proc, recordingId, stderrTail: [], hardStopTimer: null, providerId: candidate.providerId ?? null,
        schedule, route, index, part, outputPath, lostAt, lease,
        spawnedAt: now, lastSize: 0, lastGrowthAt: now, played: false,
        stopRequested: false, stalled: false
    };
    active.set(schedule.id, entry);

    proc.stderr?.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        entry.stderrTail.push(...lines);
        if (entry.stderrTail.length > STDERR_TAIL_LINES) {
            entry.stderrTail.splice(0, entry.stderrTail.length - STDERR_TAIL_LINES);
        }
    });

    proc.on('error', (err) => {
        console.error(`[Recordings] ffmpeg process error for schedule ${schedule.id}:`, err.message);
    });

    proc.on('close', (code) => {
        onPartExit(schedule, entry, code).catch(err =>
            console.error(`[Recordings] Error ending recording #${recordingId}:`, err.message));
    });

    // Hard stop at program end + post-buffer, in case something upstream never closes the connection
    const msUntilStop = Math.max(0, stopTimeOf(schedule) - Date.now());
    entry.hardStopTimer = setTimeout(() => {
        console.log(`[Recordings] Scheduled stop time reached for schedule ${schedule.id}`);
        stopRecording(schedule.id, 'completed').catch(err =>
            console.error('[Recordings] Error stopping recording:', err.message));
    }, msUntilStop);
}

/**
 * A part's ffmpeg has exited. Nothing changes unless all of these hold (0177):
 * a backup provider is configured, nobody asked it to stop (stopRecording - the stop
 * time, a cancel, a viewer taking the stream, low disk space, a delete, shutdown - sets
 * stopRequested), the stop time is not about to be reached anyway, and it ended for a
 * provider reason (its stderr says so - transcodeSession.providerFailureIn - or it
 * stalled). Then the provider is noted as failed (breaker, quarantine) and:
 *   - it had only just started (or recorded nothing): the next candidate with a free
 *     connection takes over the SAME recording row and file path;
 *   - it had been recording: this part is kept, marked partial, and the recording
 *     continues in the next part on the next free provider (up to maxParts).
 * Otherwise the part is finalised exactly as before.
 */
async function onPartExit(schedule, entry, exitCode) {
    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
    // R11: the ffmpeg is gone, so the connection its lease stood for is too. (A failover to
    // another provider below is counted by the schedule's row, which stays 'recording'.)
    coordinator.releaseLease(entry.lease);
    const now = Date.now();
    const size = fileSizeOf(entry.outputPath);
    const unrequested = !entry.stopRequested && now < stopTimeOf(schedule) - failoverTuning.endGraceMs;
    const providerReason = entry.stalled || providerFailureIn(entry.stderrTail);
    const candidate = entry.route.candidates[entry.index];

    if (!entry.route.multi || !unrequested || !providerReason) {
        finalizeRecording(schedule.id, entry.recordingId, entry.outputPath, exitCode, entry.stderrTail);
        return;
    }

    if (active.get(schedule.id) === entry) active.delete(schedule.id);
    providerRouting.noteFailure(candidate, entry.route.primaryKey);
    const how = entry.stalled ? 'stalled' : 'lost the stream';

    if (now - entry.spawnedAt < failoverTuning.startFailoverMs || size <= 1024) {
        // Start failover: the same row, the same file path. What ffmpeg wrote before
        // failing is at most a few seconds (usually just a container header, often
        // nothing), and a second writer appending to a Matroska file does not make one
        // playable file, so it is deleted and the next attempt writes the path afresh -
        // the list keeps one recording, not a stub plus the real one.
        const settings = await getSettings();
        const next = freeCandidate(entry.route, settings, entry.index + 1);
        if (next >= 0) {
            const nextCandidate = entry.route.candidates[next];
            console.warn(`[Recordings] #${entry.recordingId} ${how} on ${candidate.providerName} as it started; ` +
                `starting again on ${nextCandidate.providerName}`);
            post.abortLive(entry.recordingId); // 0207: it followed a file that is being rewritten
            try { fs.unlinkSync(entry.outputPath); } catch (e) { /* nothing was written */ }
            recordingsDb.setProvider(entry.recordingId, nextCandidate.providerId);
            spawnPart(schedule, settings, {
                recordingId: entry.recordingId, outputPath: entry.outputPath,
                route: entry.route, index: next, part: entry.part, lostAt: entry.lostAt
            });
            return;
        }
        console.warn(`[Recordings] #${entry.recordingId} ${how} on ${candidate.providerName} as it started; no other provider has a free connection`);
        if (entry.part > 1) {
            // A continuation that never got going: drop its empty row (and file) and wait
            // for another provider, as a part that could not start at all does.
            try { fs.unlinkSync(entry.outputPath); } catch (e) { /* nothing was written */ }
            recordingsDb.delete(entry.recordingId);
            waitForNextPart(schedule, entry.part, entry.lostAt ?? now);
            return;
        }
        finalizeRecording(schedule.id, entry.recordingId, entry.outputPath, exitCode, entry.stderrTail, {
            scheduleError: `Recording failed: ${candidate.providerName} did not deliver the stream, and no other provider had a free connection.`
        });
        return;
    }

    // Mid-recording: keep this part, continue in the next.
    const last = entry.part >= failoverTuning.maxParts;
    finalizeRecording(schedule.id, entry.recordingId, entry.outputPath, exitCode, entry.stderrTail, { scheduleStatus: last });
    recordingsDb.markEndedEarly(entry.recordingId, last
        ? `Stopped early: ${candidate.providerName} ${how} (part ${entry.part} of at most ${failoverTuning.maxParts}).`
        : `Stopped early: ${candidate.providerName} ${how}; the recording continues in part ${entry.part + 1}.`);
    if (last) {
        console.warn(`[Recordings] #${entry.recordingId} ${how} on ${candidate.providerName}; ` +
            `schedule #${schedule.id} already has ${entry.part} parts, so it ends here`);
        return;
    }
    console.warn(`[Recordings] #${entry.recordingId} ${how} on ${candidate.providerName}; continuing in part ${entry.part + 1}`);
    waitForNextPart(schedule, entry.part + 1, now);
}

/** Queue part `nextPart` and try to start it at once; tick() retries until the stop time. */
function waitForNextPart(schedule, nextPart, lostAt) {
    continuations.set(schedule.id, { schedule, nextPart, lostAt, starting: false, waitingLogged: false });
    return continuePart(schedule.id).catch(err =>
        console.error(`[Recordings] Could not continue schedule #${schedule.id}:`, err.message));
}

/**
 * Start a queued part on the first candidate with a free connection - the provider
 * that died is quarantined for this channel (or down), so the route leaves it out.
 * Nothing free: wait for the next tick, as a declined recording does (no prompt).
 * Past the stop time: the schedule ends with the parts it has.
 */
async function continuePart(scheduleId, now = Date.now()) {
    const cont = continuations.get(scheduleId);
    if (!cont || cont.starting) return;
    const schedule = cont.schedule;
    if (now >= stopTimeOf(schedule)) {
        continuations.delete(scheduleId);
        finishSchedule(scheduleId);
        return;
    }
    cont.starting = true;
    try {
        const settings = await getSettings();
        let route = null;
        try { route = await routeFor(schedule); } catch (e) { route = null; }
        // (Backups removed meanwhile: the route is the primary alone, tried the same way.)
        const index = route ? freeCandidate(route, settings) : -1;
        if (index < 0) {
            if (!cont.waitingLogged) {
                console.warn(`[Recordings] Schedule #${scheduleId}: part ${cont.nextPart} is waiting for a provider with a free connection`);
                cont.waitingLogged = true;
            }
            return;
        }
        if (continuations.get(scheduleId) !== cont) return; // cancelled meanwhile
        continuations.delete(scheduleId);
        await startPart(schedule, route, index, cont.nextPart, {
            gapMs: Date.now() - cont.lostAt,
            refuse: (msg) => finishSchedule(scheduleId, msg)
        });
    } finally {
        cont.starting = false;
    }
}

/**
 * A schedule's recording is over (0177, parts): completed when any of its parts
 * recorded something, else failed.
 */
function finishSchedule(scheduleId, why = null) {
    const parts = recordingsDb.listBySchedule(scheduleId);
    const any = parts.some(r => r.status === 'completed');
    setScheduleStatus(scheduleId, any ? 'completed' : 'failed', any
        ? (why ? { error: `Stopped early: ${why}` } : {})
        : { error: why ? `Recording failed: ${why}` : 'Recording failed: no part recorded anything' });
}

/**
 * Finish a recording row from its file. The schedule's status follows (unless
 * `scheduleStatus` is false - 0177, a part the recording continues after): completed
 * when this part, or an earlier part of the same schedule, recorded something.
 */
function finalizeRecording(scheduledId, recordingId, outputPath, exitCode, stderrTail, { scheduleStatus = true, scheduleError = null } = {}) {
    if (active.get(scheduledId)?.recordingId === recordingId) active.delete(scheduledId);

    let fileSize = 0;
    let existedAndHasData = false;
    try {
        const stat = fs.statSync(outputPath);
        fileSize = stat.size;
        existedAndHasData = stat.size > 1024; // ignore near-empty/zero-byte failures
    } catch (e) { /* file never got created */ }

    const rec = recordingsDb.getById(recordingId);
    const startedAt = rec?.started_at || Date.now();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);

    const success = existedAndHasData; // ffmpeg often exits non-zero on a forced stop, that's fine
    recordingsDb.finish(recordingId, {
        status: success ? 'completed' : 'failed',
        ended_at: Date.now(),
        file_size_bytes: fileSize,
        duration_sec: durationSec,
        // 0119: ffmpeg's stderr names the input URL; stored (and listed by the API) redacted.
        error: success ? null : redact((stderrTail || []).slice(-10).join('\n')) || `ffmpeg exited with code ${exitCode}`
    });

    if (scheduleStatus) {
        // An earlier part (0177) counts: the schedule did record.
        const earlier = !success && recordingsDb.listBySchedule(scheduledId)
            .some(r => r.id !== recordingId && r.status === 'completed');
        const scheduleExtra = (success || earlier) ? {} : { error: scheduleError || `Recording failed (exit code ${exitCode})` };
        setScheduleStatus(scheduledId, (success || earlier) ? 'completed' : 'failed', scheduleExtra);
    }

    console.log(`[Recordings] Recording #${recordingId} finished (${success ? 'completed' : 'failed'}), ${fileSize} bytes`);

    // 0207: a live detection run that followed this capture goes on to finish the file and
    // writes the markers itself (the status stays 'running'); otherwise it is queued as ever.
    const followedLive = post.liveCaptureEnded(recordingId, success);

    if (success) {
        // Marked pending regardless of the setting; the queue checks whether
        // compression is enabled, so turning it on later picks these up.
        try {
            // Detection is queued automatically because markers have to exist
            // before you sit down to watch. Compression is not: it is only
            // worth doing for a recording you have decided to keep, which is a
            // judgement made after watching, so it waits to be asked for.
            if (!followedLive) recordingsDb.setAdDetectStatus(recordingId, 'pending');
        } catch (e) { /* columns may be missing on a very old database */ }
        // 0192 (audit R06): and prepared for the Apple client before anyone asks.
        recordingsDb.setNativeStatus(recordingId, 'pending');
    }
}

/**
 * 0177: a recording whose file has stopped growing has stalled - its provider went
 * silent without closing the connection. Only with a backup to move to (the route is
 * multi); stopped the way a stop is, but marked stalled, so onPartExit continues it on
 * the next provider. Also where a part that is recording counts as a success for its
 * provider's breaker (a half-open provider is up again).
 */
function checkRecordingStalls(now = Date.now()) {
    for (const entry of active.values()) {
        if (!entry.route || !entry.route.multi || entry.stopRequested || entry.stalled) continue;
        const size = fileSizeOf(entry.outputPath);
        if (size > entry.lastSize) {
            entry.lastSize = size;
            entry.lastGrowthAt = now;
            if (!entry.played && size > 1024) {
                entry.played = true;
                providerRouting.noteSuccess(entry.route.candidates[entry.index]);
            }
            continue;
        }
        if (now - entry.lastGrowthAt < failoverTuning.stallMs) continue;
        entry.stalled = true;
        console.warn(`[Recordings] #${entry.recordingId} has had no data for ${Math.round((now - entry.lastGrowthAt) / 1000)}s ` +
            `from ${entry.route.candidates[entry.index].providerName}; ending this part`);
        try { entry.proc.stdin?.write('q'); } catch (e) { /* killed below */ }
        const proc = entry.proc;
        // A stalled ffmpeg may be blocked reading the input and never see the "q".
        setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } } }, 5000).unref?.();
    }
}

/**
 * 0207: follow each capture with Comskip once its file has data (see recordingPost.js). Each
 * part is its own run; a part is tried again on the next tick until a run has been started
 * (detection off, Comskip missing and the cap all just mean "not now"), and never again
 * after, so a run that ended early is not restarted over a stalled file.
 */
function startLiveDetections() {
    for (const entry of active.values()) {
        if (entry.liveStarted || entry.stopRequested) continue;
        if (fileSizeOf(entry.outputPath) < LIVE_DETECT_MIN_BYTES) continue;
        post.startLiveDetection({ id: entry.recordingId, file_path: entry.outputPath },
            { stillCapturing: () => active.get(entry.schedule.id) === entry })
            .then(started => { if (started) entry.liveStarted = true; })
            .catch(err => console.error(`[Recordings] Live break detection could not start for #${entry.recordingId}:`, err.message));
    }
}

async function stopRecording(scheduledId, reasonStatus = 'completed') {
    const entry = active.get(scheduledId);
    if (!entry) return;
    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
    // Asked for (0177): an exit that follows is never a provider failure to fail over from.
    entry.stopRequested = true;

    await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        entry.proc.once('close', done);

        try {
            // Graceful stop: ffmpeg treats "q" on stdin as a request to finish
            // the output file cleanly (flushes the last packets; an older .mkv got its trailer).
            entry.proc.stdin?.write('q');
        } catch (e) {
            try { entry.proc.kill('SIGINT'); } catch (e2) { /* ignore */ }
        }

        setTimeout(() => {
            if (!resolved) {
                try { entry.proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
        }, 8000);

        setTimeout(done, 9000); // safety net so callers never hang forever
    });

    // The proc's 'close' handler registered in spawnPart (onPartExit ->
    // finalizeRecording, synchronously for a requested stop) runs before the listener above, since it was registered first - by now the
    // recordings row and scheduled_recordings row already reflect completed/failed
    // based on whether a usable file was written. For an explicit cancel, override
    // the schedule's final status to 'cancelled' (the recording row itself stays
    // 'completed' if a usable file exists - a partial recording is still valid).
    if (reasonStatus === 'cancelled') {
        setScheduleStatus(scheduledId, 'cancelled');
    }
}

/**
 * Called once at startup. Any schedule left in status 'recording' means the
 * server process that owned its ffmpeg child is gone (container restarted,
 * crashed, etc). We can't resume the child process, so mark it interrupted -
 * the partial file (if any) is left on disk for the user to keep or delete.
 */
function reconcileOnStartup() {
    const orphans = scheduledDb.findOrphanedRecording();
    for (const schedule of orphans) {
        console.warn(`[Recordings] Schedule #${schedule.id} was mid-recording when the server last stopped; marking as failed (partial file, if any, was left on disk).`);
        if (schedule.recording_id && recordingsDb.getById(schedule.recording_id)?.status === 'recording') {
            // 0177: only a part still marked as recording. One between parts (its
            // provider died and the next had not started) is already finished, and so
            // is every earlier part: they are kept as they are.
            const rec = recordingsDb.getById(schedule.recording_id);
            let fileSize = null;
            try { if (rec?.file_path) fileSize = fs.statSync(rec.file_path).size; } catch (e) { /* ignore */ }
            recordingsDb.finish(schedule.recording_id, {
                status: (fileSize && fileSize > 1024) ? 'completed' : 'failed',
                ended_at: Date.now(),
                file_size_bytes: fileSize,
                duration_sec: null,
                error: 'Server restarted while this recording was in progress.'
            });
        }
        setScheduleStatus(schedule.id, 'failed', { error: 'Server restarted while this recording was in progress.' });
    }

    const missed = scheduledDb.findMissed(Date.now());
    for (const schedule of missed) {
        setScheduleStatus(schedule.id, 'missed', { error: 'Server was not running when this recording was due.' });
    }

    // 0207: a live detection run did not survive the restart. A recording it was following
    // goes through the queue like any other; one that never completed has nothing to analyse.
    try {
        getDb().prepare(`UPDATE recordings SET ad_detect_status = CASE WHEN status = 'completed' THEN 'pending' ELSE NULL END,
            ad_detect_error = NULL WHERE ad_detect_status = 'running'`).run();
    } catch (e) { /* columns may be missing on a very old database */ }
}

/**
 * 0192: jobs cut short by the last stop go back in their queues. An interrupted
 * encode's output is removed (older versions wrote it in place, so the final name
 * may hold a truncated file), and the library recorded before preparation existed
 * is queued for it.
 */
function reconcileJobsOnStartup() {
    for (const rec of recordingsDb.requeueInterrupted()) {
        if (!rec.file_path) continue;
        const target = compressionTargetPath(rec.file_path);
        for (const file of [target, `${target}.partial`]) {
            try { fs.unlinkSync(file); console.warn(`[Recordings] Removed ${path.basename(file)}, left by an interrupted compression`); } catch (e) { /* none */ }
        }
    }
    // 0203: an MP4 made the old way (audio copied, never decode-checked) beside an .mkv that
    // still exists is made again; one whose .mkv is already gone can only be left as it is.
    for (const rec of recordingsDb.findOldPreparedWithOriginal()) {
        const native = nativePlaybackTargetPath(rec.file_path);
        try { fs.unlinkSync(native); } catch (e) { /* not there: prepared from compression, or never made */ }
        verifiedNativeFiles.delete(native);
        recordingsDb.setNativeStatus(rec.id, 'pending');
        console.log(`[Recordings] #${rec.id} will be prepared again (its audio is re-encoded since 0203)`);
    }
    if (media.isPrepareQueueOn()) {
        const queued = recordingsDb.queueNativeBackfill();
        if (queued) console.log(`[Recordings] ${queued} earlier recording(s) queued to be prepared for the Apple client`);
    }
}

/**
 * Stop in-progress recordings if the volume is running out of room. Uses half
 * the configured minimum as the floor, so a recording that started legitimately
 * is only killed when space is genuinely critical. The partial file is kept.
 */
async function enforceFreeSpaceDuringRecording() {
    if (active.size === 0) return;

    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    if (minFreeGB <= 0) return;

    let root;
    try {
        root = await getRecordingsRoot();
    } catch (err) {
        // The folder health check (below) already logs this state on its own
        // timer; here there is nothing to enforce against, so skip this tick.
        return;
    }
    const space = hasFreeSpace(root, minFreeGB, 0.5);
    if (space.ok) return;

    console.error(`[Recordings] Free space critical (${space.freeGB.toFixed(1)} GB at ${root}); stopping ${active.size} in-progress recording(s). Partial files are kept.`);
    for (const scheduledId of [...active.keys()]) {
        try {
            await stopRecording(scheduledId, 'completed');
            setScheduleStatus(scheduledId, 'failed', { error: `Stopped early: only ${space.freeGB.toFixed(1)} GB free` });
        } catch (err) {
            console.error('[Recordings] Error stopping recording for low disk space:', err.message);
        }
    }
}

/** Where a recording's window ends (program end + post-buffer). */
function stopTimeOf(schedule) {
    return schedule.program_end + (schedule.post_buffer_min || 0) * 60000;
}

async function tick() {
    // Guard against overlap: if a previous tick is still resolving stream
    // URLs / spawning ffmpeg when the next interval fires, skip this one
    // rather than risk double-starting the same schedule.
    if (tickRunning) return;
    tickRunning = true;
    try {
        const now = Date.now();

        const due = scheduledDb.findDueToStart(now);
        for (const schedule of due) {
            // Skip if its window already fully passed (findMissed handles the log/status)
            if (schedule.program_end + (schedule.post_buffer_min * 60000) < now) continue;
            if (active.has(schedule.id)) continue;

            const settings = await getSettings();
            if (active.size >= (settings.maxConcurrentRecordings || 2)) {
                console.warn(`[Recordings] Max concurrent recordings reached, delaying schedule #${schedule.id}`);
                continue;
            }

            // The provider may allow only one connection, and a viewer may be
            // using it. The coordinator decides; this loop just respects the
            // answer and tries again next tick, which is what makes a declined
            // recording start the moment playback stops.
            // 0177: with backups, the first provider with a free connection is
            // used without asking; the prompt is only for when every one is busy.
            const choice = await chooseProvider(schedule, settings);
            const verdict = choice.verdict;
            if (!verdict.allowed) {
                if (schedule.status !== 'waiting') {
                    setScheduleStatus(schedule.id, 'waiting', { error: verdict.reason });
                }
                continue;
            }

            await startRecording(schedule, choice);
        }

        // 0177: a part whose provider died and that waits for a free one, and
        // recordings whose file has stopped growing (default path, with backups).
        for (const scheduleId of [...continuations.keys()]) await continuePart(scheduleId, now);
        checkRecordingStalls(now);
        startLiveDetections();

        // Give a viewer notice before a recording is actually due, rather than
        // at the moment it needs the stream.
        const settingsForLead = await getSettings();
        const leadMs = (settingsForLead.recordingPromptLeadMin ?? coordinator.DEFAULT_PROMPT_LEAD_MIN) * 60000;
        for (const schedule of scheduledDb.listUpcoming()) {
            if (schedule.status !== 'scheduled' && schedule.status !== 'waiting') continue;
            const startsAt = schedule.program_start - (schedule.pre_buffer_min || 0) * 60000;
            if (startsAt - now <= leadMs && startsAt > now) {
                // 0177: no warning when a provider has a free connection for it.
                const providerId = await announceProviderFor(schedule, settingsForLead);
                if (providerId !== undefined) coordinator.announceUpcoming(schedule, settingsForLead, providerId);
            }
        }

        const missed = scheduledDb.findMissed(now);
        for (const schedule of missed) {
            // Say why it was missed. "The viewer kept watching" is actionable;
            // "the window passed" is not.
            const wasWaiting = schedule.status === 'waiting';
            setScheduleStatus(schedule.id, 'missed', {
                error: wasWaiting
                    ? 'Playback continued for the whole programme, so the provider stream was never free.'
                    : 'Recording window passed without starting.'
            });
            coordinator.clearPrompt(schedule.id);
        }

        await enforceFreeSpaceDuringRecording();

        // Fire and forget: both can outlive many ticks, and the guards inside
        // stop either starting twice. Detection runs on every finished
        // recording; compression only picks up what has been asked for, and
        // waits for detection because it reads the same file.
        processAdDetectionQueue().catch(err =>
            console.error('[Recordings] Break detection queue error:', err.message));
        processCompressionQueue().catch(err =>
            console.error('[Recordings] Compression queue error:', err.message));
        media.processNativeQueue().catch(err =>
            console.error('[Recordings] Preparation queue error:', err.message));
    } catch (err) {
        console.error('[Recordings] Scheduler tick failed:', err);
    } finally {
        tickRunning = false;
    }
}

// ---------------------------------------------------------------------------
// Recordings folder health (0157)
//
// Checked at startup and every 15 minutes, independently of any recording
// being due - a broken share should be visible on the Status page long before
// the next scheduled recording tries to use it and fails. A warning is logged
// only when the state actually changes (never every 15 minutes for a folder
// that has been broken for days), plus one line when it recovers.
// ---------------------------------------------------------------------------

const FOLDER_HEALTH_INTERVAL_MS = 15 * 60 * 1000;
let folderHealthTimer = null;
let folderHealthState = null; // 'ok' | 'problem:<type>' | null (never checked yet)
let folderHealth = { ok: true, problem: null, freeBytes: null, totalBytes: null, root: null, checkedAt: null };

async function checkFolderHealthNow() {
    const settings = await getSettings();
    const root = settings.recordingsPath || '/app/recordings';
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    const result = checkRecordingsFolder(root, minFreeGB);
    const state = result.ok ? 'ok' : `problem:${result.problem}`;

    if (state !== folderHealthState) {
        if (result.ok) {
            if (folderHealthState !== null) console.log(`[Recordings] Recordings folder is reachable again: ${root}`);
        } else {
            console.warn(`[Recordings] ${refusalMessage(result, root, minFreeGB)}`);
        }
    }
    folderHealthState = state;
    folderHealth = { ...result, root, checkedAt: Date.now() };
    return folderHealth;
}

/** The last recordings-folder health check, for GET /api/status (0157). */
function getFolderHealth() {
    return folderHealth;
}

function init({ ffmpegPath, ffprobePath } = {}) {
    media.setToolPaths({ ffmpegPath, ffprobePath });

    const { initSchema } = require('../db/recordingsDb');
    initSchema();

    reconcileOnStartup();
    reconcileJobsOnStartup();

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    tick(); // run once immediately

    checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    if (folderHealthTimer) clearInterval(folderHealthTimer);
    folderHealthTimer = setInterval(() => {
        checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    }, FOLDER_HEALTH_INTERVAL_MS);

    console.log('[Recordings] Recording engine initialized');
}

function shutdown() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (folderHealthTimer) clearInterval(folderHealthTimer);
    folderHealthTimer = null;
}

/**
 * Best-effort graceful stop of every in-progress recording, so the .mkv gets
 * a proper trailer written instead of being left truncated. Called from the
 * container's SIGTERM handler, which only has a limited grace period before
 * the process is killed outright - so this doesn't wait as long as a normal
 * stopRecording() call.
 */
async function stopAllActive(timeoutMs = 6000) {
    const scheduledIds = [...active.keys()];
    await Promise.all(scheduledIds.map(id =>
        Promise.race([
            stopRecording(id, 'completed'),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]).catch(() => {})
    ));
}

module.exports = {
    init,
    shutdown,
    stopAllActive,
    scheduleFromProgram,
    listScheduled,
    listActive,
    stopForViewer,
    listRecordings,
    cancelScheduled,
    deleteRecording,
    resolveStreamUrl,
    tick,
    getFolderHealth,
    checkFolderHealthNow,
    getRecordingsRoot,
    // After a recording (recordingPost.js)
    processCompressionQueue,
    processAdDetectionQueue,
    buildCompressArgs: post.buildCompressArgs,
    // Playable files (recordingMedia.js)
    processNativeQueue: media.processNativeQueue,
    nativeQueueStatus: media.nativeQueueStatus,
    ensureNativePlayback: media.ensureNativePlayback,
    pollNativePlayback: media.pollNativePlayback,
    startNativePlayback: media.startNativePlayback,
    startNativePlaybackAndWait: media.startNativePlaybackAndWait,
    buildNativeRemuxArgs: media.buildNativeRemuxArgs,
    probeCodecs: media.probeCodecs,
    // Test seams: stand-ins for ffmpeg/ffprobe (the same object recordingMedia uses), one job
    // each without the queues' timing, and the failover timings (0177).
    _nativeTools: media.nativeTools,
    _compressRecording: post.compressRecording,
    _prepareRecording: media.prepareRecording,
    _setPrepareQueue: media._setPrepareQueue,
    _reconcileJobsOnStartup: reconcileJobsOnStartup,
    _failoverTuning: failoverTuning
};
