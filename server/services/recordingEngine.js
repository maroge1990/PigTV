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
const coordinator = require('./streamCoordinator');
const { formatLocalStamp, sanitizeForFs } = require('./recordingNames');
const { redact } = require('../redact');
const { checkRecordingsFolder, checkRecordingsFolderAsync, refusalMessage, TINY_FS_BYTES } = require('./recordingsFolder');
const shareFs = require('./shareFs'); // #8: file calls on the recordings share, off the event loop
const providerRouting = require('./providerRouting');
const { bareChannelId } = require('./channelIds');
const { providerFailureIn } = require('./transcodeSession');
// Split out in the simplification build: making recordings playable (media) and what runs
// after one (post); jobs is what each is busy with. Everything is re-exported below.
const media = require('./recordingMedia');
const post = require('./recordingPost');
const jobs = require('./recordingJobs');
const segments = require('./recordingSegments'); // R3: segmented recordings
const owners = require('./recordingOwners'); // R5-D1: recordings being deleted, for every job
const { recordingWindow } = require('./recordingGuideEnd');
const ingest = require('./ingest'); // Wave 5: shared ingest (docs/SHARED-INGEST.md)
const { createStallWatchdog } = require('./stallWatchdog');
const { getFreeSpaceGB, compressionTargetPath, nativePlaybackTargetPath, verifiedNativeFiles } = media;
const { processCompressionQueue, processAdDetectionQueue } = post;

const TICK_INTERVAL_MS = 15 * 1000;
const STDERR_TAIL_LINES = 40;

// Provider failover for recordings (0177, multi-provider brief 2.7). Tunable so a test need
// not wait them out.
const failoverTuning = {
    // An ffmpeg that ends early continues the same recording (onSegmentExit); not within this
    // long of the stop time, though - that is simply the end.
    endGraceMs: 10 * 1000,
    // A recording file that has not grown for this long has stalled (the provider went
    // silent without closing the connection; ffmpeg's -reconnect can wait on it for
    // ever). #274 (D-10): each part has its own watchdog (watchForStall), sampling every
    // min(stallCheckMs, stallMs), so noticed within stallMs + 5 s (the tick's check took up to + 15 s).
    stallMs: 30 * 1000,
    // The size read is a few stats in the part's epoch folder in appdata (never the share; captureGrowth),
    // whatever the recording's length.
    stallCheckMs: 5 * 1000,
    // #260 (0499): an epoch that ran at least this long before it ended is continued at once, a shorter one on
    // the next tick (#288: however many times, until the stop time).
    resumeAtOnceAfterMs: 60 * 1000,
    // #288 (Mark, 14 Nov; Opus L4): an outage (nothing grown since the recording last grew) is retried as usual for
    // backoffAfterMs, then at most once per backoffEveryMs, until its stop time or a part grows again.
    backoffAfterMs: 10 * 60 * 1000,
    backoffEveryMs: 60 * 1000
};

let tickTimer = null;
let tickRunning = false;
// scheduledId -> { proc, recordingId, hardStopTimer, stderrTail: [] }
// (0177: also the schedule, its provider route, which candidate this is, and whether a
// stop was asked for - see spawnPart.)
const active = new Map();
jobs.capturing = () => active.size; // capture outranks every recording job
// 0177: schedules whose provider died mid-recording and whose next part is waiting
// for a free connection. Still `recording`; retried every tick until the stop time.
// scheduledId -> { schedule, nextPart, lostAt, starting, waitingLogged } (lostAt: when the recording last grew, #302)
const continuations = new Map();
// #274 (D-10): the live stall watchdogs, one per running part (a count for tests: _stallWatchCount).
const stallWatchdogs = new Set();

// The settings the last tick read, for callers that cannot wait for them (#12's clash list).
let knownSettings = null;

async function getSettings() {
    const { settings } = require('../db');
    knownSettings = await settings.get();
    return knownSettings;
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
    // #8: through shareFs, so a hung share is an error here, not a frozen server.
    try {
        if (!(await shareFs.exists(root))) {
            const parent = path.dirname(root);
            if (!(await shareFs.exists(parent))) {
                throw new Error(`The recordings folder's parent does not exist: ${parent}. Is the share mounted?`);
            }
            // 0160: nor inside a disconnected share's empty mount point, which exists
            // but sits on a tiny tmpfs (Unraid's /mnt/remotes).
            const fsInfo = await shareFs.statfs(parent).catch(e => { if (e.code === 'SHARE_UNRESPONSIVE') throw e; return null; });
            if (fsInfo && fsInfo.totalBytes < TINY_FS_BYTES) {
                throw new Error(`The recordings folder isn't reachable: ${root} does not exist and ${parent} is not on a real volume. Is the network share connected?`);
            }
            await shareFs.mkdir(root);
        }
    } catch (err) {
        if (err.code === 'SHARE_UNRESPONSIVE') throw new Error(`The recordings folder is not responding: ${root}. Is the network share's server up?`);
        throw err;
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

/**
 * The identity (stable_id) of the channel a caller named, accepting the composite id the web app sends and the
 * bare one the native client does. Null when the channel is not in the playlist or has no identity, and on any
 * error: never the reason a recording cannot be scheduled. The lookup is providerRouting's (D-6, #274).
 */
function channelIdentity(sourceId, channelItemId) {
    return providerRouting.channelIdentity(sourceId, channelItemId)?.stableId || null;
}

/**
 * A schedule's stream address: providerRouting.streamUrlFor (D-6, #274), the same resolve a play makes, with
 * the schedule's identity (DVR-2: on M3U, that identity only) and `buildUnlistedXtream` - a recording scheduled
 * earlier is still attempted on Xtream when a sync has dropped its stream id from the list.
 * Throws plain Errors with the texts a failed schedule has always shown (its `error`).
 */
async function resolveStreamUrl(sourceId, channelItemId, stableId = null) {
    try {
        return await providerRouting.streamUrlFor({ sourceId, channelId: channelItemId, stableId, buildUnlistedXtream: true });
    } catch (err) {
        if (err && err.unresolved === providerRouting.UNRESOLVED.source) throw new Error(`Source ${sourceId} not found`);
        if (err && err.unresolved === providerRouting.UNRESOLVED.channel) throw new Error(`Channel ${channelItemId} not found for source ${sourceId}`);
        if (err && err.unresolved === providerRouting.UNRESOLVED.url) throw new Error(`No stream URL available for channel ${channelItemId}`);
        throw err;
    }
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
// decision below is exactly the one made before. #288: one difference - with every candidate held back (quarantined
// or down), a recording gets all of them, the one that failed longest ago first, where a play gets the primary alone.
// ---------------------------------------------------------------------------

/**
 * The item_id the schedule's channel has now (by its identity, as resolveStreamUrl finds it), or
 * null when the identity is no longer in the playlist (DVR-2: never its old, possibly reused, position).
 */
function currentItemId(source, schedule) {
    if (!source || source.type === 'xtream' || !schedule.channel_stable_id) return schedule.channel_item_id;
    const row = providerRouting.channelRow(schedule.source_id, null, schedule.channel_stable_id);
    return row ? row.item_id : null;
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
        const itemId = currentItemId(source, schedule);
        if (itemId === null) return single; // its channel has gone: resolveStreamUrl has refused it already
        // #288: with every candidate held back, all of them in turn (the one that failed longest ago first), not the primary alone.
        plan = await providerRouting.plan(schedule.source_id, itemId, Date.now(), { keepTrying: true });
    } catch (e) {
        return single; // nothing to fail over to that plan can name: as before
    }
    if (!plan || !plan.backupsConfigured) return single;
    return {
        candidates: plan.candidates.map(c => (c.via === 'primary' ? { ...c, url: primaryUrl } : c)),
        primaryKey: plan.primaryKey,
        multi: true,
        // #304 (Opus M1): backups exist, but this channel has none of its own (no link to another provider).
        oneProvider: plan.channelProviders <= 1
    };
}

/** The first candidate after `from` with a free connection (canRecordFreely), or -1. */
function freeCandidate(route, settings, from = 0) {
    for (let i = from; i < route.candidates.length; i++) {
        // Wave 5: a stream already being read by a shared ingest costs no connection to join.
        if (ingest.enabled(settings) && liveIngestFor(route.candidates[i])) return i;
        if (coordinator.canRecordFreely(route.candidates[i].providerId, settings)) return i;
    }
    return -1;
}

function ingestKeyOf(candidate) {
    try { return ingest.keyOf(coordinator.poolOf(candidate.providerId), candidate.url); } catch (e) { return null; }
}

function liveIngestFor(candidate) {
    try { return ingest.liveFor(coordinator.poolOf(candidate.providerId), candidate.url); } catch (e) { return null; }
}

/**
 * Wave 5 (phase 5a, behind `sharedIngestEnabled`): a subscription to the shared ingest of this
 * candidate's stream, or null for today's path (the switch is off, or the ingest was refused:
 * not MPEG-TS, or the first connection failed - the usual path then meets the same answer).
 */
async function feedFor(settings, candidate) {
    if (!ingest.enabled(settings) || !candidate || !/^https?:/i.test(String(candidate.url || ''))) return null;
    try {
        return await ingest.subscribe({ pool: coordinator.poolOf(candidate.providerId), url: candidate.url, channelKey: candidate.channelKey ?? null,
            userAgent: getUserAgent(settings), providerId: candidate.providerId ?? null, purpose: 'recording',
            channel: candidate.channelName ?? null, providerName: candidate.providerName ?? null });
    } catch (err) {
        console.warn(`[Recordings] Shared ingest not used for this recording: ${redact(err.message)}`);
        return null;
    }
}

/** End a capture gracefully: "q" on stdin, or (on a shared feed, where stdin is the data) end of input. */
function askToStop(entry) {
    if (entry.feed) {
        try { entry.feed.unpipe(entry.proc.stdin); } catch (e) { /* already */ }
        try { entry.proc.stdin?.end(); } catch (e) { /* gone */ }
        entry.feed.leave();
        return;
    }
    entry.proc.stdin?.write('q');
}

/**
 * The provider a due recording starts on, and the coordinator's verdict for it:
 * the first candidate with a free connection, without asking anybody; when none is
 * free, today's prompt flow on the first candidate (the 0158 timeout included).
 * With no backup configured, today's requestForRecording on the schedule's source.
 */
async function chooseProvider(schedule, settings, joinKey = null) {
    let route;
    try {
        route = await routeFor(schedule);
    } catch (err) {
        // The channel cannot be resolved: as before, the coordinator is asked first and
        // the recording then fails in startRecording, where the resolve is tried again.
        return { route: null, index: 0, verdict: await coordinator.requestForRecording(schedule, settings, schedule.source_id) };
    }
    // Wave 5: a channel already being read by a shared ingest (somebody is watching it, or it
    // is recording already) is recorded from it: no connection, so nobody is asked anything.
    if (ingest.enabled(settings)) {
        // #137: a recording that may only join a running recording's ingest gets that candidate, not the first live one.
        const promised = joinKey ? route.candidates.findIndex(c => liveIngestFor(c) && ingestKeyOf(c) === joinKey) : -1;
        const joinAt = promised >= 0 ? promised : route.candidates.findIndex(c => liveIngestFor(c));
        if (joinAt >= 0) return { route, index: joinAt, verdict: { allowed: true, reason: 'It joins a shared connection already open', lease: null } };
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

/**
 * R6: the programme's image as the guide gives it (epg_programs.data.img, kept since 0220's
 * sync), found by the channel's guide id and the programme's start. Null when there is none.
 */
function programmeImage(sourceId, channelItemId, programStart) {
    try {
        const db = getDb();
        const raw = bareChannelId(channelItemId);
        const row = db.prepare(`SELECT item_id, stable_id, tvg_id, data FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND (item_id = ? OR stable_id = ?) LIMIT 1`).get(sourceId, raw, raw);
        if (!row) return null;
        const tvgId = require('./epgMapping').rowTvgId(sourceId, row);
        if (!tvgId) return null;
        const prog = db.prepare(`SELECT data FROM epg_live WHERE channel_id = ? AND start_time BETWEEN ? AND ?
            ORDER BY ABS(start_time - ?) LIMIT 1`).get(tvgId, programStart - 60000, programStart + 60000, programStart);
        const img = prog && prog.data ? JSON.parse(prog.data).img : null;
        return typeof img === 'string' && /^https?:\/\//i.test(img) ? img : null;
    } catch (e) {
        return null; // artwork never stops a schedule
    }
}

/** R6: a row as the API lists it: `image` is /api/logo/<key> (never the URL itself), or null. */
/** A channel logo as clients get it: through the logo cache (/api/logo/<key>), or null when it cannot be registered. */
function channelLogo(url) {
    if (!url) return null;
    try { return require('./logoCache').registerLogo(url); } catch (e) { return null; }
}
/** A schedule or recording row's channel logo through the logo cache (rows stored before it went through it too). */
function withChannelLogo(row) {
    return row && 'channel_logo' in row ? { ...row, channel_logo: channelLogo(row.channel_logo) } : row;
}

// Every schedule and recording row a route answers with goes through this (listed, scheduled, a duplicate, cancelled,
// chosen, active): `image` in place of the stored image_url, the channel logo through the logo cache.
function withImage(row) {
    if (!row) return row;
    // #217: a schedule's link to its game and its event stop stay internal (C-M lists `endsWith`/`overrun` instead).
    const { image_url: url, sport_game_id: _game, event_stop: _stop, ...rest } = withChannelLogo(row);
    let image = null;
    try { image = url ? require('./logoCache').registerLogo(url) : null; } catch (e) { image = null; }
    return { ...rest, image };
}

async function scheduleFromProgram({
    sourceId, channelItemId, channelName, channelLogo: channelLogoUrl,
    title, description, programStart, programEnd,
    preBufferMin, postBufferMin, createdBy, exclude = null, gameId = null
}) {
    if (!sourceId || !channelItemId) throw new Error('sourceId and channelItemId are required');
    // Store the bare item_id, not the client's composite m3u_<source>_<item>
    channelItemId = bareChannelId(channelItemId);
    if (!programStart || !programEnd || programEnd <= programStart) {
        throw new Error('Valid programStart/programEnd are required');
    }

    const settings = await getSettings();
    const pre = Number.isFinite(preBufferMin) ? preBufferMin : settings.defaultPreBufferMin;
    const post = Number.isFinite(postBufferMin) ? postBufferMin : settings.defaultPostBufferMin;

    // One schedule per programme - unless the caller says that one is not this programme's
    // (`exclude`: recordingRules, another episode's schedule in the same slot; 0269).
    const existing = scheduledDb.findByProgram(sourceId, String(channelItemId), programStart);
    if (existing && !(exclude && exclude.has(existing.id))) return linkGame(existing, gameId);

    const created = scheduledDb.create({
        title: title || 'Untitled Program',
        description: description || null,
        source_id: sourceId,
        channel_item_id: String(channelItemId),
        // What the schedule is FOR. Resolved now, while the playlist still says
        // where this channel is; by the time it records, the position may not.
        channel_stable_id: channelIdentity(sourceId, channelItemId),
        channel_name: channelName || null,
        channel_logo: channelLogo(channelLogoUrl),
        program_start: programStart,
        program_end: programEnd,
        pre_buffer_min: pre,
        post_buffer_min: post,
        created_by: createdBy || null,
        created_at: Date.now()
    });
    // R6: the programme's artwork, when the guide has it.
    const image = programmeImage(sourceId, channelItemId, programStart);
    if (image) {
        getDb().prepare('UPDATE scheduled_recordings SET image_url = ? WHERE id = ?').run(image, created.id);
        return linkGame(scheduledDb.getById(created.id), gameId);
    }
    return linkGame(created, gameId);
}

/** #217: a schedule made for a fixture game (`gameId`) records until that game ends (recordingGuideEnd.eventStop). */
const GAME_ID_RE = /^[\x21-\x7e]{1,200}$/; // a collector id ("espn:soccer/eng.1:123", "aflw:…"): printable, no spaces
function linkGame(schedule, gameId) {
    if (!schedule || schedule.sport_game_id || typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) return schedule;
    getDb().prepare('UPDATE scheduled_recordings SET sport_game_id = ? WHERE id = ? AND sport_game_id IS NULL').run(gameId, schedule.id);
    return scheduledDb.getById(schedule.id);
}

const RECENT_PROBLEMS_MS = 7 * 24 * 60 * 60 * 1000; // how long a missed/failed schedule stays visible (0156)

/**
 * The upcoming/in-progress list, same as ever, plus - only when asked - schedules
 * that ended up missed or failed whose programme ended within the last 7 days
 * (0156). Without `includeRecent` the result is exactly listUpcoming(): the plain
 * route stays byte-for-byte compatible with what the Apple client already decodes.
 */
// #12: why a due recording waits for the recording slot, and why it was missed if it never got one.
const SLOT_REASON = 'Another recording is using the recording slot.';
const SLOT_MISSED = 'Other recordings used every recording slot for the whole programme (Settings → Recordings: simultaneous recordings).';

/** One provider connection per recorded channel (D-28): a schedule's channel, for sharing and clashes. */
function channelKeyOf(schedule) {
    return `${schedule.source_id}:${schedule.channel_stable_id || schedule.channel_item_id}`;
}

/** #12: how many provider connections the active recordings hold (recordings on one shared ingest are one). */
function recordingConnections() {
    const keys = new Set();
    let own = 0;
    for (const entry of active.values()) {
        if (entry.ingestKey) keys.add(entry.ingestKey); else own++;
    }
    return keys.size + own;
}

/**
 * #12, #133: the ingest key of an active recording this schedule would join: a candidate of its resolved route has a
 * live shared ingest that a running recording reads, so recording it costs no connection. null otherwise (sharing
 * off, nothing recording, the channel's URL changed since, or it cannot be resolved).
 */
async function sharedRecordingKey(schedule, settings) {
    if (!ingest.enabled(settings)) return null;
    const keys = new Set([...active.values()].map(entry => entry.ingestKey).filter(Boolean));
    if (!keys.size) return null;
    let route;
    try { route = await routeFor(schedule); } catch (e) { return null; }
    for (const candidate of route.candidates) {
        if (!liveIngestFor(candidate)) continue;
        const key = ingestKeyOf(candidate);
        if (keys.has(key)) return key;
    }
    return null;
}

/** #12: recordings that can run at once (the cap). */
function recordingSlots(settings) {
    return settings.maxConcurrentRecordings || 2;
}

const CLASH_LIST_MAX = 10; // ids per schedule in conflictsWith

/**
 * #12 (D-42: the recording scheduled first wins): which of two clashing schedules keeps the connection. A recording
 * already running keeps it (the rule never stops one); then a schedule someone chose (the latest choice first); then
 * the one scheduled first. -1 when a outranks b.
 */
function outranks(a, b) {
    const key = (r) => [r.status === 'recording' ? 0 : 1, r.chosen_at ? 0 : 1, -(r.chosen_at || 0), r.created_at || 0, r.id];
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

/**
 * #12 (D-28: clashes are shown when scheduling, never silent): for each schedule, up to CLASH_LIST_MAX ids of the
 * others it clashes with; and (D-42, `beatenBy`) for each that loses a clash, the ids of those that win it: at an
 * overloaded moment the connections are given out in rank order (outranks, by each connection's best schedule), and
 * every schedule on a connection that does not fit is beaten by those given one. Each schedule needs a connection (its channel's, shared by that channel's schedules when
 * recordings share an ingest; its own when they do not, #135); at a moment when more connections are wanted than the
 * cap, or than a provider pool's limit for the schedules on it (#136: a backup is not counted, so this may warn when
 * a backup could have helped), every schedule then wanted lists those on other connections. One sweep over the
 * windows' boundaries (#134), padding included. The advisory list counts a sport event's overrun (`stopsAt`); `hard`
 * stops at the guide end plus padding (`floor`), so a schedule due during another's overrun waits for a free slot and
 * starts late, as before 0567 (D-42's "a loser never records the part after the winner" is for clashes seen when scheduling).
 */
function clashOutcome(rows, settings, { hard = false } = {}) {
    const sharing = ingest.enabled(settings);
    // 0411 (0410 Codex round 1, high): a hold must be certain, so only the recording limit decides who waits (`hard`),
    // as it alone decides starts between recordings: a backup may carry what the primary has no room for, and the
    // coordinator does not count recordings against a provider's limit. The advisory list stays cautious (#136).
    const poolsBind = !hard;
    const keyOf = new Map(rows.map(r => [r.id, sharing ? channelKeyOf(r) : `own:${r.id}`]));
    const poolOfKey = new Map();
    const limitOf = new Map();
    for (const r of rows) {
        let pool = 'primary';
        try { pool = coordinator.poolOf(r.source_id); } catch (e) { /* one pool */ }
        poolOfKey.set(keyOf.get(r.id), pool);
        if (!limitOf.has(pool)) {
            let limit = Infinity;
            try { if (poolsBind) limit = coordinator.providerLimit(r.source_id, settings); } catch (e) { /* unknown: the cap alone */ }
            limitOf.set(pool, Math.max(1, limit));
        }
    }
    const cap = recordingSlots(settings);
    const overloaded = (counts) => {
        if (counts.size > cap) return true;
        const perPool = new Map();
        for (const key of counts.keys()) {
            const pool = poolOfKey.get(key);
            const n = (perPool.get(pool) || 0) + 1;
            if (n > limitOf.get(pool)) return true;
            perPool.set(pool, n);
        }
        return false;
    };
    const events = [];
    for (const r of rows) {
        const w = recordingWindow(r);
        const start = w.startsAt, end = hard ? w.floor : w.stopsAt; // an overrun is shown as a clash, never held on (see above)
        if (end > start) events.push([start, 1, r], [end, 0, r]);
    }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // a window ending as another starts does not overlap it
    // Live schedules grouped by the connection they need: a row is only ever compared with other groups (#138).
    const byKey = new Map();
    const found = new Map();
    const beaten = new Map();
    const bestOf = new Map(); // a connection's best schedule now; dropped when it leaves, found again when asked
    const best = (key) => {
        if (!bestOf.has(key)) { let top = null; for (const r of byKey.get(key)) if (!top || outranks(r, top) < 0) top = r; bestOf.set(key, top); }
        return bestOf.get(key);
    };
    for (let i = 0; i < events.length;) {
        const t = events[i][0];
        for (; i < events.length && events[i][0] === t; i++) {
            const [, starts, r] = events[i];
            const key = keyOf.get(r.id);
            if (starts) {
                if (!byKey.has(key)) byKey.set(key, new Set());
                byKey.get(key).add(r);
                if (bestOf.has(key) && outranks(r, bestOf.get(key)) < 0) bestOf.set(key, r);
                continue;
            }
            const group = byKey.get(key);
            group.delete(r);
            if (bestOf.get(key) === r) bestOf.delete(key);
            if (!group.size) byKey.delete(key);
        }
        if (byKey.size < 2 || !overloaded(byKey)) continue;
        // Each group lists the first CLASH_LIST_MAX schedules of the other groups once, and every member shares it.
        const firstOf = new Map([...byKey].map(([key, group]) => {
            const ids = [];
            for (const r of group) { ids.push(r.id); if (ids.length >= CLASH_LIST_MAX) break; }
            return [key, ids];
        }));
        for (const [key, group] of byKey) {
            const others = [];
            for (const [other, ids] of firstOf) {
                if (other === key) continue;
                for (const id of ids) { others.push(id); if (others.length >= CLASH_LIST_MAX) break; }
                if (others.length >= CLASH_LIST_MAX) break;
            }
            for (const r of group) {
                const ids = found.get(r.id) || new Set();
                if (ids.size >= CLASH_LIST_MAX) continue;
                for (const id of others) { ids.add(id); if (ids.size >= CLASH_LIST_MAX) break; }
                found.set(r.id, ids);
            }
        }
        // D-42: connections in rank order while they fit; the rest are beaten by those that got one.
        const admitted = new Map();
        for (const key of [...byKey.keys()].sort((a, b) => outranks(best(a), best(b)))) {
            admitted.set(key, byKey.get(key));
            if (!overloaded(admitted)) continue;
            admitted.delete(key);
            const winners = [...admitted.keys()].map(k => best(k).id).slice(0, CLASH_LIST_MAX);
            for (const r of byKey.get(key)) {
                const ids = beaten.get(r.id) || new Set();
                for (const id of winners) if (ids.size < CLASH_LIST_MAX) ids.add(id);
                beaten.set(r.id, ids);
            }
        }
    }
    const sorted = (map) => new Map([...map].filter(([, ids]) => ids.size).map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)]));
    return { conflicts: sorted(found), beatenBy: sorted(beaten) };
}

/**
 * #12 (D-42): choose a schedule over the ones it clashes with ("Record this one instead"). Only one that has not
 * started; a running recording is never stopped by a choice. -> the schedule as listed, or null (unknown or started).
 */
function chooseScheduled(id, settings = null) {
    const row = scheduledDb.getById(id);
    if (!row || !['scheduled', 'waiting'].includes(row.status)) return null;
    scheduledDb.choose(id);
    choiceEpoch++; // 0411: a start already under way re-checks that it still wins (startStillWanted)
    if (row.status === 'waiting' && String(row.error || '').startsWith(CLASH_PREFIX)) setScheduleStatus(id, 'scheduled', { error: null });
    console.log(`[Recordings] Schedule #${id} "${row.title}": chosen over its clashes`);
    return listScheduled({ settings }).find(r => r.id === id) || null;
}

/**
 * #217 (C-M, additive): each listed schedule's `endsWith` ("event" | "guide") and, while it records past its guide end
 * because its event is still on, `overrun: true`. The internal columns are not listed. The score catalog is read once,
 * only when a row has no stored link to try the join on.
 */
function withEndView(rows) {
    let catalog = null;
    if (rows.some(r => !r.sport_game_id)) {
        try { catalog = require('./sportsDashboard').store().catalog(); } catch (e) { catalog = null; }
    }
    const guideEnd = require('./recordingGuideEnd');
    const now = Date.now();
    return (r) => {
        return { ...r, ...guideEnd.endView(r, catalog, now) }; // the internal columns go in withImage
    };
}

function listScheduled({ includeRecent = false, settings = null } = {}) {
    // R6 (additive): `image` in place of image_url, the only change to these rows.
    // #12 (C-M, additive): `conflictsWith` lists the schedules this one clashes with, when there are any.
    // #12 (D-42, additive): `beatenBy` lists those that win its clashes: this one waits for them (clashReason).
    const rows = scheduledDb.listUpcoming();
    const known = settings || knownSettings || {};
    const found = clashOutcome(rows, known).conflicts;
    const beatenBy = holds(rows, known);
    const upcoming = rows.map(r => found.has(r.id) || beatenBy.has(r.id)
        ? { ...r, conflictsWith: found.get(r.id) || beatenBy.get(r.id), ...(beatenBy.has(r.id) ? { beatenBy: beatenBy.get(r.id) } : {}) } : r)
        .map(withEndView(rows)).map(withImage);
    if (!includeRecent) return upcoming;
    const problems = scheduledDb.findRecentProblems(Date.now() - RECENT_PROBLEMS_MS);
    const recent = problems.map(withEndView(problems)).map(withImage);
    return [...upcoming, ...recent];
}

/**
 * #49 (0444): "Change recording": a schedule's start-early / finish-late minutes. `pre`/`post` are whole minutes or
 * null (unchanged); the caller has validated them. Start and stop are never stored: every reader works them out from
 * program_start/program_end and these two columns (findDueToStart, stopTimeOf with its event stop and 4 h cap), so
 * changing the columns is the whole edit. Not started (`scheduled`, `waiting`): both may change. Recording: only `post`,
 * and the hard stop is re-armed from the database (armHardStop), as when the guide moves an end. A change that puts the
 * stop at or before now is refused (stopping now is the Stop action's job). A rule's schedule keeps its `rule_id`.
 * Returns { row } (as listed) or { status, error }.
 */
function editScheduled(id, { pre = null, post = null } = {}, { now = Date.now(), settings = null } = {}) {
    const schedule = scheduledDb.getById(id);
    if (!schedule || !['scheduled', 'waiting', 'recording'].includes(schedule.status)) {
        return { status: 404, error: 'No upcoming or running schedule with that id' };
    }
    if (schedule.status === 'recording' && pre !== null) {
        return { status: 409, error: 'This recording has started, so it cannot start earlier or later.' };
    }
    const next = { ...schedule, ...(pre !== null ? { pre_buffer_min: pre } : {}), ...(post !== null ? { post_buffer_min: post } : {}) };
    if (post !== null && stopTimeOf(next) <= now) {
        return { status: 409, error: 'That would end the recording now. Use Stop instead.' };
    }
    getDb().prepare('UPDATE scheduled_recordings SET pre_buffer_min = ?, post_buffer_min = ? WHERE id = ?')
        .run(next.pre_buffer_min, next.post_buffer_min, id);
    choiceEpoch++; // 0445 (Codex 0444 round 1, high): new times can change who wins a clash; a start under way re-checks
    console.log(`[Recordings] Schedule #${id} "${schedule.title}": start early ${next.pre_buffer_min} min, finish late ${next.post_buffer_min} min`);
    const entry = active.get(id);
    if (schedule.status === 'recording' && entry && !entry.stopRequested) armHardStop(id, entry);
    const row = listScheduled({ settings }).find(r => r.id === id) || withImage(scheduledDb.getById(id));
    return { row };
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
    // #305: a schedule that waited keeps no reason once it records (unless the caller gives one).
    if (status === 'recording') extra = { error: null, clash_winner: null, ...extra };
    const updated = scheduledDb.setStatus(id, status, extra);
    if (updated && prevStatus && prevStatus !== status) {
        const title = updated.title || before?.title || 'Untitled';
        const channel = updated.channel_name || before?.channel_name || 'Unknown channel';
        const reason = extra.error ? `: ${extra.error}` : '';
        console.log(`[Recordings] Schedule #${id} "${title}" (${channel}): ${prevStatus} -> ${status}${reason}`);
        if (status === 'failed') {
            try { require('./notify').recordingFailed(updated || before, extra.error); } catch (e) { /* best-effort (R11) */ }
        }
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
        return { ...row, providerId: entry && entry.providerId !== undefined ? entry.providerId : (row.source_id ?? null),
            ...(entry && entry.ingestKey ? { ingestKey: entry.ingestKey } : {}) }; // Wave 5: one connection per shared ingest
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
        // I-4 (#273): the sources' one parsed list (db.sources.listParsed); an unreadable row is unnamed.
        names = new Map(require('../db').sources.listParsed().map(s => [Number(s.id), s.name || null]));
    } catch (e) { /* no names: null */ }
    // 0207: this login's resume position and watched flag on every row (0 / false for none).
    const positions = userId === null || userId === undefined ? new Map() : recordingsDb.positionsFor(userId);
    return rows.map(withImage).map(r => ({
        ...r,
        // R3: an in-progress segmented recording can be played from the start (GET /:id/watch).
        watch_live: segments.isWatchable(r),
        position_sec: positions.get(r.id)?.position_sec ?? 0,
        watched: positions.get(r.id)?.watched ?? false,
        provider_name: r.provider_id === null || r.provider_id === undefined ? null : (names.get(Number(r.provider_id)) ?? null)
    }));
}

// DVR-4 (0232): bumped by stopAllActive (shutdown); a start that began before it does not spawn.
let stopAllGeneration = 0;
/** #220: a recording or schedule that is not there: the route answers 404 (the text stays, C-M). */
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

async function cancelScheduled(id) {
    const schedule = scheduledDb.getById(id);
    if (!schedule) throw notFound('Scheduled recording not found');

    if (schedule.status === 'recording' && active.has(id)) {
        await stopRecording(id, 'cancelled');
    } else if (schedule.status === 'recording' && continuations.has(id)) {
        // 0177: between parts (waiting for a free provider): nothing is running.
        const cont = continuations.get(id);
        continuations.delete(id);
        // R3: what a segmented one recorded so far is still made into its MP4.
        if (cont.resume) endSegmentCapture(id, cont.resume.recordingId);
        setScheduleStatus(scheduledDb.getById(id) || schedule, 'cancelled');
    } else if (schedule.status === 'recording' && schedule.recording_id &&
               recordingsDb.getById(schedule.recording_id)?.segment_state === 'capturing') {
        // 0490 Codex round 1 (medium): a segmented one the shutdown left to resume (nothing runs for it now):
        // what it recorded is still made into its MP4, as for one between epochs.
        endSegmentCapture(id, schedule.recording_id);
        setScheduleStatus(scheduledDb.getById(id) || schedule, 'cancelled');
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
    return withImage(scheduledDb.getById(id));
}

/**
 * #151: one deletion per recording at a time: a second request for it joins the first (two
 * interleaving file loops could remove a name a new recording was given in between).
 */
const deleting = new Map(); // recording id -> its deletion
function deleteRecording(id) {
    if (deleting.has(id)) return deleting.get(id);
    const run = deleteRecordingOnce(id).finally(() => deleting.delete(id));
    deleting.set(id, run);
    return run;
}

async function deleteRecordingOnce(id) {
    let rec = recordingsDb.getById(id);
    if (!rec) throw notFound('Recording not found');
    // #141: a share that is not answering refuses the deletion before anything of it is retired,
    // stopped or removed (its files would stay behind, unlisted, under a recording that is gone).
    // #149: before retire(), which cannot be undone: a refused deletion leaves the recording as it
    // was, its jobs still its own. What one of them published meanwhile is the row read again here.
    const first = rec.file_path || rec.segment_original;
    if (first) {
        try { await shareFs.identity(first); } catch (err) {
            if (err.code === 'SHARE_UNRESPONSIVE') throw new Error('The recordings folder is not responding, so the recording was not deleted. Try again once it is back.');
        }
        rec = recordingsDb.getById(id);
        if (!rec) throw notFound('Recording not found');
    }
    // R4-D2 (0257), R5-D1: from here, before any await, nothing being published for it - by any
    // job - may record itself or stay.
    owners.retire(id);

    // 0264: every writer of it is stopped, and has ended and removed what it made, before anything of
    // it is removed: nothing is written for it once this deletion has completed.
    await owners.stopWriters(id);

    // If it's still actively recording, stop it first
    for (const [scheduledId, entry] of active.entries()) {
        if (entry.recordingId === id) {
            await stopRecording(scheduledId, 'deleted');
            break;
        }
    }
    // R3: a segmented one waiting to continue is not resumed, and its appdata folder goes.
    // #285: its schedule ends as deleting it while it captures does (endSegmentCapture: completed with segments,
    // failed without), not by finishSchedule, which counts only completed rows (this one is 'recording').
    for (const [scheduledId, cont] of continuations.entries()) {
        if (cont.resume && cont.resume.recordingId === id) {
            continuations.delete(scheduledId);
            endSegmentCapture(scheduledId, id);
        }
    }
    if (rec.work_dir) await segments.removeWork(rec);
    // What the row says now (a publication that finished before the retirement may have moved it on).
    rec = recordingsDb.getById(id) || rec;
    // F1 (0242): a segmented recording's kept original, wherever it was published.
    const files = rec.segment_original ? [rec.segment_original] : [];
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
        // D1 (0251): a segmented recording's "<name>.ts" may be another file; the original it owns
        // is only ever segment_original (listed above; R4-D1: never inferred from an older row).
        const ownTs = !rec.segment_name;
        files.push(rec.file_path, native, `${native}.partial`, compressed, `${compressed}.partial`, `${base}.mkv`, ...(ownTs ? [`${base}.ts`] : []), `${base}.mp4`);
    }
    // #141: through shareFs. A file the share stops answering on is listed (as the file it was) and
    // removed once the share answers again; the deletion goes on.
    const left = [];
    const anotherRecords = getDb().prepare('SELECT 1 FROM recordings WHERE (file_path = ? OR segment_original = ?) AND id != ? LIMIT 1');
    for (const file of new Set(files)) {
        // #151: a name in this one's family that another recording points at is that recording's.
        if (anotherRecords.get(file, file, id)) continue;
        let identity = null;
        try {
            identity = await shareFs.identity(file);
            if (identity === null) continue;
            await shareFs.unlink(file);
        } catch (err) {
            if (err.code === 'SHARE_UNRESPONSIVE') left.push({ path: file, identity });
            else console.warn('[Recordings] Failed to delete file:', err.message);
        }
        verifiedNativeFiles.delete(file);
    }
    recordingsDb.delete(id);
    // After the row: a file still listed as a recording's is never removed (recordingOwners.retryDeleted).
    if (left.length) {
        owners.deferRemoval(left, id);
        console.warn(`[Recordings] #${id}: the recordings folder stopped answering; ${left.length} file(s) will be removed once it answers again`);
    }
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
    return startPart(schedule, route, choice ? choice.index : 0, {
        lease,
        mustJoin: choice ? choice.mustJoin || null : null,
        epoch: choice ? choice.epoch : undefined,
        refuse: (msg) => setScheduleStatus(schedule.id, 'failed', { error: msg })
    });
}

/**
 * Start a recording on candidate `index` of `route`: pre-flight the folder, create its
 * recordings row, spawn ffmpeg (startSegmented). `refuse(message)` is called when the
 * folder check fails.
 */
async function startPart(schedule, route, index, opts = {}) {
    // R11: whatever happens, a lease this start was given is either bound to the running recording
    // (and released when its ffmpeg exits) or given back here - never left to expire.
    let started = false;
    try {
        started = await startPartLeased(schedule, route, index, opts);
    } finally {
        if (!started) coordinator.releaseLease(opts.lease);
    }
}

/**
 * DVR-4 (0232): is a start that has been awaiting (settings, the folder, the shared feed) still
 * wanted? Not after the schedule was cancelled or deleted, its connection taken by a viewer, or
 * stopAllActive (shutdown) - and never for a schedule that is already running.
 */
function startStillWanted(schedule, owner) {
    const { lease, generation } = owner;
    if (generation !== stopAllGeneration) return false;
    // 0411 (0410 Codex round 1, high): someone chose another schedule while this one was starting: go on only if it
    // still wins (waiting again otherwise, with the winner named).
    if (owner.epoch !== undefined && owner.epoch !== choiceEpoch) {
        const winner = holderOf(schedule.id, knownSettings || {});
        if (winner) {
            console.log(`[Recordings] Schedule #${schedule.id}: another schedule was chosen while it started; waiting`);
            waitForSlot(schedule, clashReason(winner), winner.id);
            return false;
        }
        owner.epoch = choiceEpoch;
    }
    if (lease && !coordinator.leaseAlive(lease)) {
        console.log(`[Recordings] Schedule #${schedule.id}: its connection was taken before it started; waiting`);
        return false;
    }
    if (active.has(schedule.id)) return false;
    const now = scheduledDb.getById(schedule.id);
    if (!now || (now.status !== 'scheduled' && now.status !== 'waiting')) return false;
    // 0445 (Codex 0444 round 1, high): its start-early was cut while it got ready (editScheduled), so it is not due yet.
    if (recordingWindow(now).startsAt > Date.now()) {
        console.log(`[Recordings] Schedule #${schedule.id}: its start moved later while it got ready; not started yet`);
        return false;
    }
    return true;
}

/** DVR-4: an abandoned start gives back the feed it was handed (the caller releases its lease). */
/**
 * #133: a start let past the recording slot because it joins a running recording's ingest must get exactly that
 * feed; otherwise it would open a connection of its own, so it goes back to waiting for the slot.
 */
function joinedAsPromised(schedule, owner, feed, candidate) {
    if (!owner.mustJoin) return true;
    if (feed && ingestKeyOf(candidate) === owner.mustJoin) return true;
    if (feed) { try { feed.leave(); } catch (e) { /* gone */ } }
    waitForSlot(schedule);
    return false;
}

function waitForSlot(schedule, reason = SLOT_REASON, winnerId = null) {
    const now = scheduledDb.getById(schedule.id) || schedule;
    if (now.status !== 'waiting' || now.error !== reason || (now.clash_winner ?? null) !== winnerId) {
        setScheduleStatus(now, 'waiting', { error: reason, clash_winner: winnerId });
    }
}

/** #12 (D-42): why a schedule that loses its clash waits, naming the one that wins it. */
function clashReason(winner) {
    const how = winner.status === 'recording' ? 'which is recording' : winner.status === 'completed' ? 'which recorded instead'
        : winner.chosen_at ? 'which was chosen instead' : 'which was scheduled first';
    return `Clashes with “${winner.title || 'another recording'}”, ${how}.`;
}
const CLASH_PREFIX = 'Clashes with ';
let choiceEpoch = 0;

/**
 * 0411 (0410 Codex round 1, high): the schedules each one waits for, by id: those that win its clash now (clashOutcome,
 * `hard`), else the winner it already lost to (`clash_winner`), for as long as that one holds: until it is cancelled,
 * deleted or never started (missed), or their windows no longer overlap. A winner that recorded or failed keeps the
 * hold, so a loser never records the part after the winner (D-42: it waits until someone chooses it). The overlap is
 * judged to `floor`, not an overrun (`stopsAt`): a schedule due during a winner's overtime is not held for it and starts late.
 */
function holds(rows, settings) {
    const out = new Map(clashOutcome(rows, settings, { hard: true }).beatenBy);
    const windowOf = (r) => { const w = recordingWindow(r); return [w.startsAt, w.floor]; };
    for (const r of rows) {
        if (out.has(r.id) || !r.clash_winner || r.status !== 'waiting') continue;
        const w = scheduledDb.getById(r.clash_winner);
        if (!w || ['cancelled', 'missed'].includes(w.status)) continue;
        // 0412: never a hold back on one this schedule now beats (two waiting on each other would both be missed)
        if ((out.get(w.id) || []).includes(r.id)) continue;
        const [a0, a1] = windowOf(r), [b0, b1] = windowOf(w);
        if (a0 < b1 && b0 < a1) out.set(r.id, [w.id]);
    }
    return out;
}
/** The schedule `id` waits for now, or null. */
function holderOf(id, settings) {
    const winner = (holds(scheduledDb.listUpcoming(), settings).get(id) || [])[0];
    return winner ? scheduledDb.getById(winner) : null;
}

function abandonStart(schedule, feed) {
    if (feed) { try { feed.leave(); } catch (e) { /* gone */ } }
    console.log(`[Recordings] Schedule #${schedule.id}: not started (cancelled, taken or shutting down while it got ready)`);
    return false;
}

async function startPartLeased(schedule, route, index, { refuse, lease = null, mustJoin = null, epoch } = {}) {
    const owner = { lease, generation: stopAllGeneration, mustJoin, epoch };
    const settings = await getSettings();
    // A viewer that forced the stream while this start was getting ready took the lease with it:
    // the connection is theirs, so this recording waits for the next tick instead.
    if (!startStillWanted(schedule, owner)) return false;
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    // R3: every recording is segmented (a segmented one is resumed, never given a part 2).
    return startSegmented(schedule, settings, route, index, { refuse, lease, minFreeGB, owner });
}

/** How much of the recording was missed before it started (a viewer held it back). */
function noteLateStart(schedule, recordingId) {
    const intendedStart = recordingWindow(schedule).startsAt;
    const lateBy = Date.now() - intendedStart;
    if (lateBy > 30000) {
        recordingsDb.markPartial(recordingId, lateBy);
        console.log(`[Recordings] #${recordingId} starts ${Math.round(lateBy / 60000)} min into the programme`);
    }
}

/**
 * R3: start a segmented recording. Segments go to appdata, so it is the appdata folder that must
 * be usable and have room; the share is only needed at the end (a share that is down now is
 * logged, and the MP4 waits for it). One recordings row for the whole recording.
 */
async function startSegmented(schedule, settings, route, index, { refuse, lease, minFreeGB, owner }) {
    try { fs.mkdirSync(segments.workRoot(), { recursive: true }); } catch (e) { /* reported by the check */ }
    const check = checkRecordingsFolder(segments.workRoot(), minFreeGB);
    if (!check.ok) {
        const msg = refusalMessage(check, segments.workRoot(), minFreeGB);
        console.error(`[Recordings] Refusing to start schedule ${schedule.id}: ${msg}`);
        refuse(msg);
        return false;
    }
    try {
        const root = await getRecordingsRoot();
        const share = await checkRecordingsFolderAsync(root, minFreeGB); // #8
        if (!share.ok) console.warn(`[Recordings] Schedule #${schedule.id} records into appdata; ${refusalMessage(share, root, minFreeGB)} (the MP4 waits until it is usable)`);
    } catch (err) {
        console.warn(`[Recordings] Schedule #${schedule.id} records into appdata; ${err.message} (the MP4 waits until it is usable)`);
    }

    const candidate = route.candidates[index];
    if (!startStillWanted(schedule, owner)) return false;
    const feed = await feedFor(settings, candidate); // Wave 5
    if (!startStillWanted(schedule, owner)) return abandonStart(schedule, feed);
    if (!joinedAsPromised(schedule, owner, feed, candidate)) return false;
    const recording = recordingsDb.create({
        scheduled_id: schedule.id,
        title: schedule.title,
        channel_name: schedule.channel_name,
        channel_logo: schedule.channel_logo,
        source_id: schedule.source_id,
        channel_item_id: schedule.channel_item_id,
        file_path: '',
        started_at: Date.now(),
        provider_id: candidate.providerId ?? null,
        part: 1
    });
    const workDir = segments.workDirFor(recording.id);
    recordingsDb.setSegmentFields(recording.id, {
        image_url: schedule.image_url || null, // R6
        work_dir: workDir,
        file_path: path.join(workDir, 'recording.m3u8'),
        segment_state: 'capturing',
        segment_name: `${sanitizeForFs(schedule.title)} - ${formatLocalStamp(schedule.program_start)}`,
        segment_folder: sanitizeForFs(schedule.channel_name || 'Unknown Channel')
    });
    noteLateStart(schedule, recording.id);

    coordinator.clearPrompt(schedule.id);
    setScheduleStatus(schedule.id, 'recording', { recording_id: recording.id });
    if (lease) coordinator.bindLeaseToRecording(lease, recording.id);
    spawnSegment(schedule, settings, { recordingId: recording.id, workDir, route, index, lease, resumes: 0, feed });
    return true;
}

/** R3: one epoch of a segmented recording (its first run, or a run after a failover or restart). */
function spawnSegment(schedule, settings, { recordingId, workDir, route, index, lease = null, resumes = 0, shortRun = null, feed = null, outageSince = null }) {
    const epoch = segments.nextEpoch(workDir);
    spawnPart(schedule, settings, {
        recordingId, outputPath: epoch.dir, route, index, lease, feed,
        segmented: { workDir, epoch: epoch.n, offsetSec: epoch.offsetSec, resumes, shortRun, outageSince }
    });
}

/**
 * How much a capture has written: its current epoch's segments (R3), in appdata (#8: local). Asked every stallCheckMs
 * of every part, so through captureGrowth (a few stats, whatever the epoch's length; 0576 review M2), not the
 * readdir + stat of every segment captureBytes does. entry.growth is its memory of the epoch's final segments.
 */
async function captureSize(entry) {
    if (!entry.growth) entry.growth = {};
    return segments.captureGrowth(entry.outputPath, entry.growth);
}

/** Run ffmpeg for one part on its candidate. Its exit decides what happens next (onPartExit). */
function spawnPart(schedule, settings, { recordingId, outputPath, route, index, lease = null, segmented = null, feed = null }) {
    const candidate = route.candidates[index];
    // Wave 5: with a shared feed the capture reads it on stdin (recordingSegments.captureInput).
    const args = segments.captureArgs({
        userAgent: getUserAgent(settings), url: candidate.url, epochDir: outputPath, offsetSec: segmented.offsetSec, feed: !!feed
    });

    // The provider is named only when there is more than one to choose from (never its URL).
    const on = route.multi ? ` on ${candidate.providerName}` : '';
    const into = `segments in appdata (part ${segmented.epoch})`;
    console.log(`[Recordings] Starting recording #${recordingId} for schedule #${schedule.id}: "${schedule.title}"${on}${feed ? ' (shared ingest)' : ''} -> ${into}`);

    const proc = spawn(media.tools.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    // providerId (0173): the pool this recording's connection counts in - the
    // candidate it was started on (0177), the schedule's own source without backups.
    const now = Date.now();
    const entry = {
        proc, recordingId, stderrTail: [], hardStopTimer: null, providerId: candidate.providerId ?? null,
        schedule, route, index, outputPath, lease, segmented,
        spawnedAt: now, lastSize: 0, lastGrowthAt: now, played: false,
        stopRequested: false, stalled: false,
        // Wave 5: the shared feed it reads (null: its own connection), and why that feed ended.
        feed, ingestKey: feed ? ingest.keyOf(feed.ingest.pool, candidate.url) : null, feedLost: null,
        // #274: what the feed had handed over when the capture last grew (here: when the part started); captureActivity.
        feedBytesAtGrowth: feed ? feed.bytesOut : null
    };
    active.set(schedule.id, entry);
    watchForStall(entry);
    if (feed) {
        proc.stdin.on('error', () => { /* ffmpeg exited first */ });
        // Why the feed ended; its queued bytes still drain, and pipe() then ends stdin.
        feed.on('ingest-end', (why) => { entry.feedLost = why; });
        feed.pipe(proc.stdin);
        proc.on('close', () => feed.leave());
    }

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
        // #146: kept, so a stop can wait for the capture's exit handling (onPartExit).
        entry.exited = onPartExit(schedule, entry, code).catch(err =>
            console.error(`[Recordings] Error ending recording #${recordingId}:`, err.message));
    });

    // Hard stop at program end + post-buffer, in case something upstream never closes the connection
    armHardStop(schedule.id, entry);
}

/**
 * The one-shot stop at the schedule's end (+ post-buffer). R4: the end can move after the
 * recording started (the guide said the game ran over), so the deadline is read from the
 * database when the timer is armed and again when it fires; a later end re-arms it instead of
 * stopping. followGuide() re-arms it at once when it moves an end.
 */
function armHardStop(scheduleId, entry) {
    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
    const msUntilStop = Math.max(0, currentStopTime(scheduleId) - Date.now());
    entry.hardStopTimer = setTimeout(() => {
        entry.hardStopTimer = null;
        followEvent(scheduleId); // #217: a sport event still on keeps it recording
        if (currentStopTime(scheduleId) > Date.now() + 1000) { armHardStop(scheduleId, entry); return; }
        console.log(`[Recordings] Scheduled stop time reached for schedule ${scheduleId}`);
        stopRecording(scheduleId, 'completed').catch(err =>
            console.error('[Recordings] Error stopping recording:', err.message));
    }, msUntilStop);
}

/** The stop time as the database has it now (R4: it can move while recording). */
function currentStopTime(scheduleOrId) {
    const id = typeof scheduleOrId === 'object' ? scheduleOrId.id : scheduleOrId;
    const fresh = scheduledDb.getById(id);
    return stopTimeOf(fresh || (typeof scheduleOrId === 'object' ? scheduleOrId : { program_end: 0 }));
}

/** A capture's ffmpeg has exited: its lease goes, and onSegmentExit decides what happens next. */
async function onPartExit(schedule, entry, exitCode) {
    stopStallWatch(entry);
    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
    // R11: the ffmpeg is gone, so the connection its lease stood for is too. (A failover to
    // another provider below is counted by the schedule's row, which stays 'recording'.)
    coordinator.releaseLease(entry.lease);
    return onSegmentExit(schedule, entry, exitCode);
}

// #288 (Mark, 14 Nov): no cap on how often one recording starts a new epoch. With every provider down it keeps trying,
// paced (at once after a minute's run or #284's one try per provider, else on the next tick; after backoffAfterMs of an
// outage at most once per backoffEveryMs), until its stop time
// (continuePart ends it there); `resumes` only counts them for the log.
// #260 (0499): how long an epoch must have run to be continued at once is failoverTuning.resumeAtOnceAfterMs (1 min).

/** #260 (0499): why a capture ended, for the log: the feed's reason, the exit, ffmpeg's last line (redacted). */
function captureEndWhy(entry, exitCode) {
    const parts = [];
    if (entry.stalled) parts.push('no data');
    if (entry.feedLost?.reason) parts.push(`the shared feed ended: ${entry.feedLost.reason}`);
    parts.push(exitCode === null || exitCode === undefined ? 'ffmpeg was stopped' : `ffmpeg exit ${exitCode}`);
    const last = (entry.stderrTail || []).filter(l => l.trim()).slice(-1)[0];
    if (last) parts.push(`"${redact(last.trim()).slice(0, 160)}"`);
    return parts.join('; ');
}

/**
 * R3: an epoch's ffmpeg has exited. Not asked for and before the end (#260, 0499: for any reason, with or without a
 * backup provider), the recording goes on in a new epoch of the same folder and row - after a start failure too, since
 * nothing is deleted and the next run simply appends - until its stop time, however many times (#288). Otherwise the
 * capture is over and the MP4 is made.
 */
async function onSegmentExit(schedule, entry, exitCode) {
    segments.sealEpoch(entry.outputPath);
    if (active.get(schedule.id) === entry) active.delete(schedule.id);
    const now = Date.now();
    // 0490: the server is stopping (a container stop, a backup, an update) before the recording's
    // end: its row stays 'capturing' and its schedule 'recording', so the next start resumes it in a
    // new epoch (resumeSegmentedOnStartup), the gap noted, instead of finishing it here as complete.
    if (entry.leaveForRestart) {
        console.log(`[Recordings] #${entry.recordingId}: the server is stopping; it continues in the same recording when the server is back`);
        return;
    }
    const unrequested = !entry.stopRequested && now < currentStopTime(schedule) - failoverTuning.endGraceMs;
    const providerReason = entry.stalled || providerFailureIn(entry.stderrTail) || entry.feedLost?.providerReason === true;
    // #260 (0499): why this capture ended, always logged (the São Paulo GP's said nothing).
    const why = captureEndWhy(entry, exitCode);
    if (unrequested) {
        // #260 (0499): any early end continues the same recording (a new epoch, the gap noted), not only a provider's
        // failure with a backup configured: one provider is tried again. It starts again at once after a provider's failure
        // on a multi-provider route (as before) or a capture that had run a minute; one that ended sooner waits for the
        // next tick, so a capture that keeps ending cannot spin.
        const failover = entry.route.multi && providerReason;
        const ranLong = now - entry.spawnedAt >= failoverTuning.resumeAtOnceAfterMs;
        // #284: short captures that failed over in a row, and the candidate count of the route the run started on: each
        // provider gets one immediate try (one pass round that route), then a short capture waits for the tick.
        const prior = entry.segmented.shortRun;
        const shortRun = failover && !ranLong
            ? { count: (prior?.count || 0) + 1, of: prior?.of || entry.route.candidates.length }
            : null;
        const atOnce = ranLong || (shortRun && shortRun.count < shortRun.of);
        const candidate = entry.route.candidates[entry.index];
        // #304 (Mark, 14 Nov): only a failure on a channel with more than one provider is held against its provider here.
        // A stall on a channel's only provider stays out of its breaker (no "down" on Status, no providerDown notice),
        // also when backups exist but this channel has no link to one (Opus M1): it is only quarantined, so a sibling feed
        // of the same provider is tried next. A play's failed connections still count (routes/playback.js, streamRelay.js).
        if (failover && entry.route.oneProvider) providerRouting.quarantine(candidate?.providerId, candidate?.channelKey);
        else if (failover) providerRouting.noteFailure(candidate, entry.route.primaryKey);
        // #288 (Opus M2): a short run on a multi route that ended without a provider reason (an "account expired" page,
        // a crash) is quarantined too, without a breaker count, so the next try goes to the next provider instead of
        // this one for the rest of the window. A run that lasted a minute is retried where it was, as before.
        else if (entry.route.multi && !ranLong) providerRouting.quarantine(candidate?.providerId, candidate?.channelKey);
        console.warn(`[Recordings] #${entry.recordingId} ended early (${why})` +
            (entry.route.multi && candidate?.providerName ? ` on ${candidate.providerName}` : '') +
            '; it continues in the same recording' + (entry.segmented.resumes ? ` (continued ${entry.segmented.resumes} times so far)` : ''));
        // #302: the gap runs from the part's last growth (its spawn when it never grew), not from its exit: a stall is
        // noticed stallMs after the last growth, and a shared feed may spend its reconnect before it ends the part, and
        // that silent time is inside the part. A chain of parts that never grow then adds up to the whole silent span,
        // each gap ending where the next begins (at a part's spawn).
        // #302 (Opus L3): a part that wrote nothing is still the same outage, so its gap adds to the current one's total
        // instead of counting another ("Gaps: 1, N s" for one outage, however many tries it took).
        // #288 (Opus L4): the outage runs from the recording's last growth; a part that grew starts a new one (the pace
        // goes back to normal), one that wrote nothing carries it on. continuePart backs off on a long one.
        const grew = segments.epochSegmentCount(entry.outputPath) > 0;
        const lostAt = Math.min(now, entry.lastGrowthAt ?? entry.spawnedAt ?? now);
        continuations.set(schedule.id, {
            schedule, nextPart: 1, lostAt, starting: false, waitingLogged: false,
            newGap: grew,
            outageSince: grew ? lostAt : (entry.segmented.outageSince ?? lostAt), lastTryAt: entry.spawnedAt ?? now,
            resume: { recordingId: entry.recordingId, workDir: entry.segmented.workDir, resumes: entry.segmented.resumes + 1, shortRun,
                why: failover ? 'the provider dropped out' : `the capture ended (${why})` }
        });
        if (!atOnce) return;
        return continuePart(schedule.id).catch(err =>
            console.error(`[Recordings] Could not continue schedule #${schedule.id}:`, err.message));
    }
    endSegmentCapture(schedule.id, entry.recordingId, { exitCode, stderrTail: entry.stderrTail });
}

/**
 * R3: the capture of a segmented recording is over. With segments, the schedule is completed and
 * the recording waits for its MP4 (status stays 'recording', segment_state 'finishing', and it
 * can still be watched from the start); with none, both have failed.
 */
function endSegmentCapture(scheduleId, recordingId, { exitCode = null, stderrTail = [], why = null } = {}) {
    if (active.get(scheduleId)?.recordingId === recordingId) active.delete(scheduleId);
    const rec = recordingsDb.getById(recordingId);
    if (!rec) return;
    segments.sealAll(rec.work_dir);
    const count = segments.archiveSegmentCount(rec.work_dir);
    const startedAt = rec.started_at || Date.now();
    if (count > 0) {
        recordingsDb.setSegmentFields(recordingId, {
            segment_state: 'finishing', ended_at: Date.now(),
            duration_sec: Math.round(segments.recordedSeconds(rec.work_dir))
        });
        setScheduleStatus(scheduleId, 'completed', why ? { error: `Stopped early: ${why}` } : {});
        console.log(`[Recordings] Recording #${recordingId} captured ${count} segments in ${Math.round((Date.now() - startedAt) / 1000)}s; making its MP4`);
        segments.processQueue().catch(err => console.error('[Recordings] Finishing queue error:', err.message));
        return;
    }
    const error = redact((stderrTail || []).slice(-10).join('\n')) || (exitCode === null ? 'Nothing was recorded.' : `ffmpeg exited with code ${exitCode}`);
    recordingsDb.setSegmentFields(recordingId, { status: 'failed', segment_state: 'failed', ended_at: Date.now(), error });
    segments.removeWork(rec).catch(() => {});
    setScheduleStatus(scheduleId, 'failed', { error: why ? `Recording failed: ${why}` : `Recording failed (exit code ${exitCode})` });
    console.log(`[Recordings] Recording #${recordingId} finished (failed), nothing recorded`);
}

/**
 * R3: a note on a segmented recording for each gap a failover or restart left. #302 (Opus L3): `newGap` false (the part
 * before wrote nothing: the same outage) adds to the total without counting another gap.
 */
function noteSegmentGap(recordingId, gapMs, why, { newGap = true } = {}) {
    const rec = recordingsDb.getById(recordingId);
    if (!rec) return;
    const prior = /^Gaps: (\d+), (\d+) s in all/.exec(rec.error || '');
    const count = (prior ? Number(prior[1]) : 0) + (newGap || !prior ? 1 : 0);
    const total = (prior ? Number(prior[2]) : 0) + Math.round(gapMs / 1000);
    recordingsDb.markEndedEarly(recordingId, `Gaps: ${count}, ${total} s in all (the last: ${why}).`);
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
    // #217 (0440 Codex round 1, high): a part waiting for a provider checks its game before its stored stop is taken as
    // the end (followEvents sees running captures only), so a game still on keeps it waiting and then recording.
    followEvent(scheduleId, now);
    if (now >= currentStopTime(schedule)) {
        continuations.delete(scheduleId);
        if (cont.resume) endSegmentCapture(scheduleId, cont.resume.recordingId);
        return;
    }
    // #288 (Mark, 14 Nov; Opus L4): past backoffAfterMs of an outage, at most one try per backoffEveryMs (an immediate
    // try per provider included), so a long outage is not a provider connection every 15 s for hours.
    if (cont.outageSince != null && cont.lastTryAt != null && now - cont.outageSince >= failoverTuning.backoffAfterMs &&
        now - cont.lastTryAt < failoverTuning.backoffEveryMs) return;
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
        // DVR-4 (0232): the continuation stays queued until its capture runs, so a cancel while the
        // feed is awaited finds it (and ends the recording), and this start then gives up.
        const generation = stopAllGeneration;
        const ours = () => continuations.get(scheduleId) === cont && generation === stopAllGeneration && !active.has(scheduleId);
        if (cont.resume) {
            // R3: the same recording, a new epoch.
            const rec = recordingsDb.getById(cont.resume.recordingId);
            if (!rec || rec.segment_state !== 'capturing') { continuations.delete(scheduleId); finishSchedule(scheduleId); return; }
            const feed = await feedFor(settings, route.candidates[index]); // Wave 5
            if (!ours()) return abandonStart(schedule, feed);
            // #302 (Codex round 1): the gap ends when the next part is spawned, after the feed is awaited (a shared
            // ingest's subscribe can spend ~10 s timing out): that wait is missing too, and the next part's gap counts
            // from its spawn, so the gaps touch.
            const gapMs = Date.now() - cont.lostAt;
            noteSegmentGap(rec.id, gapMs, cont.resume.why || 'the provider dropped out', { newGap: cont.newGap !== false });
            if (route.candidates[index].providerId !== rec.provider_id) recordingsDb.setProvider(rec.id, route.candidates[index].providerId ?? null);
            console.log(`[Recordings] #${rec.id} continues after ${Math.round(gapMs / 1000)}s` +
                (route.multi ? ` on ${route.candidates[index].providerName}` : ''));
            continuations.delete(scheduleId);
            spawnSegment(schedule, settings, { recordingId: rec.id, workDir: rec.work_dir, route, index, resumes: cont.resume.resumes, shortRun: cont.resume.shortRun, feed,
                outageSince: cont.outageSince ?? null });
            return;
        }
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
 * 0177, #274 (D-10): a recording whose file has stopped growing has stalled - its provider went silent without closing
 * the connection. Every running part is watched (stallWatchdog, one per part, from its start to its exit); what follows
 * depends on the route, not whether it is noticed. It is stopped the way a stop is, but marked stalled and not asked
 * for, so onSegmentExit continues it: with a backup (route multi) on the next provider, as since 0177; with one
 * provider in a new epoch on the same one, through 0499's early-end continuation (until its stop time, the gap noted),
 * without counting toward that provider's breaker (#304). The sampling is also where a part that is recording counts as
 * a success for its provider's breaker (a half-open provider is up again).
 */
function watchForStall(entry) {
    stopStallWatch(entry);
    entry.stallWatchdog = createStallWatchdog({
        label: `Recordings #${entry.recordingId}`,
        getLastActivity: () => captureActivity(entry),
        onStall: (quietMs) => onCaptureStall(entry, quietMs),
        stallMs: failoverTuning.stallMs,
        startupMs: failoverTuning.stallMs, // as before: before any growth, measured from the part's start
        checkIntervalMs: Math.min(failoverTuning.stallCheckMs, failoverTuning.stallMs)
    });
    stallWatchdogs.add(entry.stallWatchdog);
}

/** The part has ended, or a stop was asked for: its watchdog goes (it never outlives its part). */
function stopStallWatch(entry) {
    if (!entry.stallWatchdog) return;
    entry.stallWatchdog.stop();
    stallWatchdogs.delete(entry.stallWatchdog);
    entry.stallWatchdog = null;
}

/**
 * The watchdog's sample: when the capture last grew (null before it has), and the breaker's success once it has
 * written more than 1 KB. A single-provider capture on a shared feed that has handed it nothing at all since the
 * capture last grew (or since the part started) is excused for now: a silent feed is the ingest's to judge (it
 * reconnects, or ends the feed, which ends this part once). Acting on it here too would end this part and then, after
 * the resume joins the same dying ingest, the next one as well: two resumes for one silence. The excuse is judged over
 * the whole quiet spell, not per sample (0576 review, Codex high): once the feed has handed over any bytes since the
 * last growth, it is over until the capture grows again, and the limit runs from the last moment it held. So a feed
 * that delivers in bursts cannot keep alive an ffmpeg that reads but writes nothing (caught within the gap before the
 * first burst + stallMs), and the excused spell itself lasts only while the ingest lets a feed be silent (its lag limit,
 * at most 28 s, then reconnectMs, 10 s, before it ends the feed, which ends the excuse). A feed that has ended is this
 * watchdog's. Multi-provider routes are not excused (their resume goes to another provider's ingest).
 */
async function captureActivity(entry) {
    const now = Date.now();
    // Read before the size: bytes handed over while it is read count as after the growth (never an excuse).
    const fedBefore = entry.feed ? entry.feed.bytesOut : null;
    const size = await captureSize(entry);
    if (size > entry.lastSize) {
        entry.lastSize = size;
        entry.lastGrowthAt = now;
        entry.feedBytesAtGrowth = fedBefore;
        if (!entry.played && size > 1024) {
            entry.played = true;
            providerRouting.noteSuccess(entry.route.candidates[entry.index]);
        }
    }
    if (feedSilentSinceGrowth(entry)) entry.feedExcusedAt = now;
    const grew = entry.lastSize > 0 ? entry.lastGrowthAt : null;
    return entry.feedExcusedAt ? Math.max(grew ?? 0, entry.feedExcusedAt) : grew;
}

/** A single-provider capture's live shared feed has handed it nothing since the capture last grew (see captureActivity). */
function feedSilentSinceGrowth(entry) {
    const feed = entry.feed;
    if (!feed || entry.route.multi || feed.endReason || feed.destroyed || feed.ingest?.closed) return false;
    return feed.bytesOut === entry.feedBytesAtGrowth;
}

function onCaptureStall(entry, quietMs) {
    stopStallWatch(entry);
    if (entry.stopRequested || entry.stalled || active.get(entry.schedule.id) !== entry) return;
    entry.stalled = true;
    // The provider is named only when there is more than one to choose from.
    const from = entry.route.multi ? ` from ${entry.route.candidates[entry.index].providerName}` : '';
    console.warn(`[Recordings] #${entry.recordingId} has had no data for ${Math.round(quietMs / 1000)}s${from}; ending this part`);
    try { askToStop(entry); } catch (e) { /* killed below */ }
    const proc = entry.proc;
    // A stalled ffmpeg may be blocked reading the input and never see the "q".
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } } }, 5000).unref?.();
}

async function stopRecording(scheduledId, reasonStatus = 'completed') {
    const entry = active.get(scheduledId);
    if (!entry) return;
    if (entry.hardStopTimer) clearTimeout(entry.hardStopTimer);
    // Asked for (0177): an exit that follows is never a provider failure to fail over from.
    entry.stopRequested = true;
    stopStallWatch(entry); // #274: nothing left for it to notice

    // 0490 Codex round 1 (medium): a cancel during the shutdown wins over leaving it to resume.
    if (reasonStatus === 'cancelled') entry.leaveForRestart = false;

    await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        entry.proc.once('close', done);

        try {
            // Graceful stop: ffmpeg treats "q" on stdin as a request to finish
            // the output file cleanly (flushes the last packets; an older .mkv got its trailer).
            askToStop(entry);
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
    // #146: wait for the capture's exit handling (onPartExit; bounded), so the cancel below is the last word.
    if (entry.exited) await Promise.race([entry.exited, new Promise(r => setTimeout(r, shareFs.tuning.timeoutMs + 1000))]);

    // The proc's 'close' handler registered in spawnPart (onPartExit -> onSegmentExit) runs
    // before the listener above, since it was registered first. For an explicit cancel, override
    // the schedule's final status to 'cancelled' (what was recorded is still made into its MP4).
    if (reasonStatus === 'cancelled') {
        setScheduleStatus(scheduledId, 'cancelled');
    }
}

/**
 * Called once at startup. Any schedule left in status 'recording' means the
 * server process that owned its ffmpeg child is gone (container restarted,
 * crashed, etc). We can't resume the child process, so mark it interrupted -
 * the partial file (if any) is left on disk for the user to keep or delete.
 * #141: its size is read through shareFs; resolves once those parts are finished.
 */
function reconcileOnStartup() {
    const finishing = [];
    const orphans = scheduledDb.findOrphanedRecording();
    for (const schedule of orphans) {
        if (resumeSegmentedOnStartup(schedule)) continue;
        console.warn(`[Recordings] Schedule #${schedule.id} was mid-recording when the server last stopped; marking as failed (partial file, if any, was left on disk).`);
        if (schedule.recording_id && recordingsDb.getById(schedule.recording_id)?.status === 'recording') {
            // 0177: only a part still marked as recording. One between parts (its
            // provider died and the next had not started) is already finished, and so
            // is every earlier part: they are kept as they are.
            const rec = recordingsDb.getById(schedule.recording_id);
            const endedAt = Date.now();
            finishing.push((async () => {
                // 0 when the file is missing; null when the share did not answer (#143: unknown is not
                // "nothing recorded", so the part is kept as it would be with its file there).
                const fileSize = rec?.file_path ? await shareFs.sizeOf(rec.file_path) : 0;
                recordingsDb.finish(rec.id, {
                    status: (fileSize === null || fileSize > 1024) ? 'completed' : 'failed',
                    ended_at: endedAt,
                    file_size_bytes: fileSize,
                    duration_sec: null,
                    error: 'Server restarted while this recording was in progress.'
                });
                // reconcileJobsOnStartup's backfill ran before this answered.
                if (media.isPrepareQueueOn()) recordingsDb.queueNativeBackfill();
            })().catch(err => console.warn(`[Recordings] #${rec.id}: could not finish it after the restart:`, err.message)));
        }
        setScheduleStatus(schedule.id, 'failed', { error: 'Server restarted while this recording was in progress.' });
    }

    const missed = scheduledDb.findMissed(Date.now());
    for (const schedule of missed) {
        setScheduleStatus(schedule.id, 'missed', { error: 'Server was not running when this recording was due.' });
    }

    // A break-detection run did not survive the restart. A completed recording goes back to the
    // queue; one that never completed has nothing to analyse.
    try {
        getDb().prepare(`UPDATE recordings SET ad_detect_status = CASE WHEN status = 'completed' THEN 'pending' ELSE NULL END,
            ad_detect_error = NULL WHERE ad_detect_status = 'running'`).run();
    } catch (e) { /* columns may be missing on a very old database */ }
    return Promise.all(finishing);
}

/**
 * R3: a segmented recording survives a restart. Its epochs are sealed (their ffmpeg is gone);
 * while its window is still open it continues in a new epoch of the same recording as soon as a
 * provider connection is free (a restart has ended every viewer's session, so usually at the
 * first tick), with the gap noted; after its window it is finished into its MP4. True when the
 * schedule was one of these.
 */
function resumeSegmentedOnStartup(schedule) {
    const rec = schedule.recording_id ? recordingsDb.getById(schedule.recording_id) : null;
    if (!rec || !rec.work_dir || rec.segment_state !== 'capturing') return false;
    // #302 (Opus L2): where the gap starts, read before sealing (a seal appends to the playlist, moving its mtime). The
    // newest epoch: its playlist's last write (its last growth); one that wrote nothing (a try refused during an
    // outage, whose gap up to its start is already noted) from its folder's time, its start, and the same outage.
    let lostAt = null;
    let newGap = true;
    try {
        const last = segments.epochs(rec.work_dir).pop();
        if (last && segments.epochSegmentCount(last.dir) > 0) lostAt = fs.statSync(path.join(last.dir, 'archive.m3u8')).mtimeMs;
        else if (last) { lostAt = fs.statSync(last.dir).mtimeMs; newGap = false; }
    } catch (e) { lostAt = null; newGap = true; /* the restart time, then */ }
    // #288 (Opus L4): an outage the restart fell in goes on from the last growth before it (the back-off's clock).
    let outageSince = null;
    if (!newGap) {
        try {
            const grown = segments.epochs(rec.work_dir).filter(e => segments.epochSegmentCount(e.dir) > 0).pop();
            outageSince = grown ? fs.statSync(path.join(grown.dir, 'archive.m3u8')).mtimeMs : lostAt;
        } catch (e) { outageSince = lostAt; }
    }
    segments.sealAll(rec.work_dir);
    const now = Date.now();
    // #217 (0440 Codex round 1, high): its game is checked before its stored stop decides whether it resumes.
    if (followEvent(schedule.id, now)) schedule = scheduledDb.getById(schedule.id) || schedule;
    if (now < stopTimeOf(schedule) - failoverTuning.endGraceMs) {
        console.warn(`[Recordings] Schedule #${schedule.id} was recording when the server stopped; it continues in the same recording (#${rec.id})`);
        continuations.set(schedule.id, {
            schedule, nextPart: 1, lostAt: Math.min(now, lostAt ?? now), starting: false, waitingLogged: false, newGap,
            outageSince: outageSince === null ? null : Math.min(now, outageSince),
            resume: { recordingId: rec.id, workDir: rec.work_dir, resumes: 0, why: 'the server restarted' }
        });
        return true;
    }
    console.warn(`[Recordings] Schedule #${schedule.id} was recording when the server stopped and its time is over; making the MP4 of what it recorded`);
    endSegmentCapture(schedule.id, rec.id, { why: 'the server restarted' });
    return true;
}

/**
 * 0192: jobs cut short by the last stop go back in their queues. An interrupted
 * encode's output is removed (older versions wrote it in place, so the final name
 * may hold a truncated file), and the library recorded before preparation existed
 * is queued for it.
 * #141: those removals go through shareFs, and the queues wait for them as for the sweep (whenSwept).
 */
function reconcileJobsOnStartup() {
    const interrupted = recordingsDb.requeueInterrupted();
    const oldPrepared = recordingsDb.findOldPreparedWithOriginal();
    const removals = (async () => {
        for (const rec of interrupted) {
            if (!rec.file_path) continue;
            const target = compressionTargetPath(rec.file_path);
            for (const file of [target, `${target}.partial`]) {
                try {
                    if (await shareFs.unlink(file)) console.warn(`[Recordings] Removed ${path.basename(file)}, left by an interrupted compression`);
                } catch (err) {
                    if (err.code === 'SHARE_UNRESPONSIVE') console.warn(`[Recordings] Could not remove ${path.basename(file)}, left by an interrupted compression: the recordings folder is not responding`);
                }
            }
        }
        // 0203: an MP4 made the old way (audio copied, never decode-checked) beside an .mkv that
        // still exists is made again; one whose .mkv is already gone can only be left as it is.
        for (const rec of oldPrepared) {
            const native = nativePlaybackTargetPath(rec.file_path);
            try { await shareFs.unlink(native); } catch (err) {
                // Not answering: it stays as it is, and is found again at the next start.
                if (err.code === 'SHARE_UNRESPONSIVE') continue;
            }
            verifiedNativeFiles.delete(native);
            recordingsDb.setNativeStatus(rec.id, 'pending');
            console.log(`[Recordings] #${rec.id} will be prepared again (its audio is re-encoded since 0203)`);
        }
    })();
    // 0270: files writers of deleted recordings left when a deletion stopped waiting for them.
    owners.sweepCleanup(removals).catch(err => console.warn('[Recordings] Could not remove what deleted recordings left:', err.message));
    if (media.isPrepareQueueOn()) {
        const queued = recordingsDb.queueNativeBackfill();
        if (queued) console.log(`[Recordings] ${queued} earlier recording(s) queued to be prepared for the Apple client`);
    }
    return removals;
}

/**
 * Stop in-progress recordings if the volume is running out of room. Uses half
 * the configured minimum as the floor, so a recording that started legitimately
 * is only killed when space is genuinely critical. The partial file is kept.
 */
async function enforceFreeSpaceDuringRecording() {
    // #286 (Opus L6): a segmented recording waiting between parts (a continuation, for hours in an outage: #288) is
    // stopped too, or its next part would start into a nearly full appdata.
    const waitingIds = () => [...continuations.entries()].filter(([, c]) => c.resume).map(([id]) => id);
    if (active.size === 0 && waitingIds().length === 0) return;

    const settings = await getSettings();
    const minFreeGB = Number.isFinite(settings.minFreeSpaceGB) ? settings.minFreeSpaceGB : 10;
    if (minFreeGB <= 0) return;

    // R3: segmented recordings fill appdata, not the share (so a share that is down changes nothing here).
    const segmented = [...active.entries()].filter(([, e]) => e.segmented).map(([id]) => id);
    const waiting = waitingIds().filter(id => !segmented.includes(id));
    if (!segmented.length && !waiting.length) return;
    const work = hasFreeSpace(segments.workRoot(), minFreeGB, 0.5);
    if (work.ok) return;
    const why = `free space in appdata ran low (${work.freeGB.toFixed(1)} GB free)`;
    console.error(`[Recordings] Free space critical in appdata (${work.freeGB.toFixed(1)} GB); stopping ${segmented.length + waiting.length} segmented recording(s). Anything they recorded is kept.`);
    let stopped = 0;
    for (const scheduledId of segmented) {
        try {
            await stopRecording(scheduledId, 'completed');
            stopped++;
            // #286: say why it ended (as stopForViewer does), so the completed schedule is not left unexplained.
            const row = scheduledDb.getById(scheduledId);
            if (row && row.status === 'completed' && !row.error) {
                setScheduleStatus(row, 'completed', { error: `Stopped early: ${why}` });
            }
        } catch (err) {
            console.error('[Recordings] Error stopping recording for low disk space:', err.message);
        }
    }
    for (const scheduledId of waiting) {
        const cont = continuations.get(scheduledId);
        if (!cont?.resume) continue;
        continuations.delete(scheduledId); // a start under way gives up (ours() fails)
        try {
            endSegmentCapture(scheduledId, cont.resume.recordingId, { why });
            stopped++;
        } catch (err) {
            console.error('[Recordings] Error stopping recording for low disk space:', err.message);
        }
    }
    // #286 (Opus L7): after the stops, with the number really stopped (one with nothing recorded included: the text says
    // anything recorded is kept, not that each kept something).
    if (stopped) {
        try { require('./notify').recordingsStoppedLowDisk(stopped, work.freeGB); } catch (e) { /* best-effort (R11) */ }
    }
}

/**
 * Where a recording's window ends: program end + post-buffer, or (#217) later while its sport event runs past that
 * (`event_stop`, never earlier: recordingGuideEnd.eventStop).
 */
function stopTimeOf(schedule) {
    return require('./recordingGuideEnd').stopOf(schedule); // 0442: capped at the current floor + 4 h
}

/**
 * #217: decide a running recording's event stop (recordingGuideEnd.eventStop: the score collector's stored answer for
 * its game, never a request to ESPN) and store it. True when it changed (the caller re-arms the hard stop).
 */
function followEvent(scheduleId, now = Date.now(), { store = null, catalog = null } = {}) {
    try {
        const s = scheduledDb.getById(scheduleId);
        if (!s || s.status !== 'recording') return false;
        const current = Number.isFinite(s.event_stop) ? s.event_stop : null;
        const next = require('./recordingGuideEnd').eventStop(s, { now, store, catalog });
        if (next === current) return false;
        getDb().prepare('UPDATE scheduled_recordings SET event_stop = ? WHERE id = ?').run(next, s.id);
        if (current === null) console.log(`[Recordings] Schedule #${s.id} "${s.title}": its event is still on; recording past the guide end, until ${new Date(next).toISOString()}`);
        else if (next === null || next < current) console.log(`[Recordings] Schedule #${s.id} "${s.title}": its event has ended; stopping at ${new Date(stopTimeOf({ ...s, event_stop: next })).toISOString()}`);
        return true;
    } catch (err) {
        console.warn('[Recordings] Following the event failed:', err.message);
        return false;
    }
}

/** #217: each tick, every running recording near or past its guide end checks its event (one catalog read). */
function followEvents(now = Date.now()) {
    const due = [...active.keys()].map(id => scheduledDb.getById(id)).filter(s => s && s.status === 'recording'
        && (Number.isFinite(s.event_stop) || now >= stopTimeOf(s) - require('./recordingGuideEnd').EARLY_MS));
    if (!due.length) return;
    let store = null, catalog = null;
    try { store = require('./sportsDashboard').store(); catalog = store.catalog(); } catch (e) { return; }
    for (const s of due) {
        const entry = active.get(s.id);
        if (followEvent(s.id, now, { store, catalog }) && entry && !entry.stopRequested) armHardStop(s.id, entry);
    }
}

/**
 * #17 (Mark, 4 Nov): every segmented recording keeps its watch copy running while it captures, so "Play from live"
 * and "Watch from start" open at the live edge at once (a copy started on demand reads the archive from its start at
 * about 25x real time: minutes behind on a long game). Costs a second copy in appdata until the recording finishes.
 * ensureView is idempotent (a running or failed-out copy is left alone) and never throws.
 */
// 0457 (0456 Codex round 1, medium): started beside the tick, never awaited by it: a watch copy's codec probe can take
// 30 s on a bad first segment, and the tick must go on starting recordings and enforcing free space meanwhile. One start
// in flight per recording at a time.
const watchCopyStarting = new Set();
function keepWatchCopies() {
    for (const entry of active.values()) {
        if (!entry.segmented || entry.stopRequested || watchCopyStarting.has(entry.recordingId)) continue;
        const rec = recordingsDb.getById(entry.recordingId);
        if (!rec || rec.status !== 'recording' || rec.segment_state !== 'capturing') continue;
        watchCopyStarting.add(rec.id);
        Promise.resolve().then(() => segments.ensureView(rec)).catch(() => { /* tried again next tick */ })
            .finally(() => watchCopyStarting.delete(rec.id));
    }
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
        // #12 (D-42): who wins each clash, once per tick (only when something is due).
        let outcome = null;
        for (const schedule of due) {
            try {
                // Skip if its window already fully passed (findMissed handles the log/status)
                if (recordingWindow(schedule).stopsAt < now) continue;
                if (active.has(schedule.id)) continue;

                const settings = await getSettings();
                // #12 (D-28): the cap counts provider connections, not recordings. A recording of a channel that is
                // already being recorded joins that recording's shared ingest, so the cap never holds it back.
                // #133: only when the start really reads that recording's ingest (checked again once the feed is had).
                const joins = await sharedRecordingKey(schedule, settings);
                // D-42: a schedule that loses its clash waits for the winner, even when a connection is free now (it would
                // otherwise hold the connection the winner needs later). Joining a running recording costs no connection.
                const epoch = choiceEpoch;
                if (!joins) {
                    // 0412 (0411 Codex round 2, high): a choice made during an earlier start of this tick changes who wins
                    if (!outcome || outcome.epoch !== epoch) { outcome = holds(scheduledDb.listUpcoming(), settings); outcome.epoch = epoch; }
                    const winnerId = (outcome.get(schedule.id) || [])[0];
                    const winner = winnerId ? scheduledDb.getById(winnerId) : null;
                    if (winner) { waitForSlot(schedule, clashReason(winner), winner.id); continue; }
                }
                const atCap = recordingConnections() >= recordingSlots(settings);
                if (!joins && atCap) {
                    waitForSlot(schedule);
                    continue;
                }

                // The provider may allow only one connection, and a viewer may be
                // using it. The coordinator decides; this loop just respects the
                // answer and tries again next tick, which is what makes a declined
                // recording start the moment playback stops.
                // 0177: with backups, the first provider with a free connection is
                // used without asking; the prompt is only for when every one is busy.
                const choice = await chooseProvider(schedule, settings, joins);
                const verdict = choice.verdict;
                if (!verdict.allowed) {
                    if (schedule.status !== 'waiting') {
                        setScheduleStatus(schedule.id, 'waiting', { error: verdict.reason });
                    }
                    continue;
                }

                if (joins && atCap) choice.mustJoin = joins; // past the cap only by joining (#133)
                if (!joins) choice.epoch = epoch; // 0411: re-checked against a choice made while it starts
                await startRecording(schedule, choice);
            } catch (err) {
                // #303: one schedule's failure must not skip the others due in this tick; no status is written, so
                // it is tried again next tick.
                console.error(`[Recordings] Schedule #${schedule.id}: ${err.message}; tried again next tick`);
            }
        }

        // 0177: a part whose provider died and that waits for a free one. (A capture that has stopped growing is
        // its own watchdog's: watchForStall, #274.)
        for (const scheduleId of [...continuations.keys()]) await continuePart(scheduleId, now);
        followEvents(now); // #217
        keepWatchCopies(); // #17: beside the tick (0457)

        // Give a viewer notice before a recording is actually due, rather than
        // at the moment it needs the stream.
        const settingsForLead = await getSettings();
        const leadMs = (settingsForLead.recordingPromptLeadMin ?? coordinator.DEFAULT_PROMPT_LEAD_MIN) * 60000;
        for (const schedule of scheduledDb.listUpcoming()) {
            if (schedule.status !== 'scheduled' && schedule.status !== 'waiting') continue;
            const { startsAt } = recordingWindow(schedule);
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
                error: wasWaiting && schedule.error === SLOT_REASON ? SLOT_MISSED
                    : wasWaiting && String(schedule.error || '').startsWith(CLASH_PREFIX) ? `Not recorded. ${schedule.error}`
                    : wasWaiting ? 'Playback continued for the whole programme, so the provider stream was never free.'
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
        // R3: segmented recordings whose capture is over get their MP4 (and wait for the share).
        segments.processQueue().catch(err =>
            console.error('[Recordings] Finishing queue error:', err.message));
        // R5: recording rules, every 15 minutes (and after each guide sync).
        try { require('./recordingRules').evaluateIfDue()?.catch(() => {}); } catch (e) { /* best-effort */ }
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
    const result = await checkRecordingsFolderAsync(root, minFreeGB); // #8
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
    // #141: the share answers: files of deleted recordings it had not answered for go now.
    if (result.ok) owners.retryDeleted().catch(err => console.warn('[Recordings] Could not remove files of deleted recordings:', err.message));
    return folderHealth;
}

/** The last recordings-folder health check, for GET /api/status (0157). */
function getFolderHealth() {
    return folderHealth;
}

/**
 * R4: after an EPG sync, move each pending or running schedule's end to where the guide now
 * says its programme ends (services/recordingGuideEnd.js has the rules), and re-arm the
 * hard stop of any running one whose end moved. Never throws.
 */
function followGuide({ now = Date.now() } = {}) {
    let changes = [];
    try {
        changes = require('./recordingGuideEnd').apply({ now });
    } catch (err) {
        console.warn('[Recordings] Following the guide failed:', err.message);
        return [];
    }
    for (const change of changes) {
        const entry = active.get(change.id);
        if (entry) armHardStop(change.id, entry);
    }
    return changes;
}

/** Resolves once start-up's own share calls (#141) have answered; nothing needs to wait for it. */
function init({ ffmpegPath, ffprobePath } = {}) {
    media.setToolPaths({ ffmpegPath, ffprobePath });

    const { initSchema } = require('../db/recordingsDb');
    initSchema();
    segments.configure({
        recordingsRoot: getRecordingsRoot,
        minFreeGB: async () => { const s = await getSettings(); return Number.isFinite(s.minFreeSpaceGB) ? s.minFreeSpaceGB : 10; }
    });

    const reconciled = Promise.all([reconcileOnStartup(), reconcileJobsOnStartup()])
        .catch(err => console.warn('[Recordings] Start-up clean-up failed:', err.message)); // never an unhandled rejection

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    tick(); // run once immediately
    followGuide(); // R4: a guide synced while the server was down

    checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    if (folderHealthTimer) clearInterval(folderHealthTimer);
    folderHealthTimer = setInterval(() => {
        checkFolderHealthNow().catch(err => console.warn('[Recordings] Folder health check failed:', err.message));
    }, FOLDER_HEALTH_INTERVAL_MS);

    console.log('[Recordings] Recording engine initialized');
    return reconciled;
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
async function stopAllActive(timeoutMs = 6000, { forRestart = false } = {}) {
    stopAllGeneration++; // DVR-4: a start awaiting its feed now does not start
    const scheduledIds = [...active.keys()];
    // 0490: the container's SIGTERM (forRestart): a segmented recording whose time is not over is
    // left to resume at the next start, not finished. 7 Nov: the weekly appdata backup stopped the
    // container 6 minutes into a 3-hour F1 recording, and it was kept as a complete 6 minutes.
    if (forRestart) {
        const now = Date.now();
        for (const id of scheduledIds) {
            const entry = active.get(id);
            // 0490 Codex round 1 (medium): never one already being stopped (a cancel): that one finishes.
            if (entry?.segmented && !entry.stopRequested && now < currentStopTime(entry.schedule) - failoverTuning.endGraceMs) entry.leaveForRestart = true;
        }
    }
    await Promise.all(scheduledIds.map(id =>
        Promise.race([
            stopRecording(id, 'completed'),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]).catch(() => {})
    ));
}

module.exports = {
    init,
    followGuide,
    followEvent,
    followEvents,
    shutdown,
    stopAllActive,
    scheduleFromProgram,
    listScheduled,
    chooseScheduled,
    editScheduled,
    listActive,
    withChannelLogo,
    withImage,
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
    _owners: owners, // 0270: the deletion's writer wait and the start-up sweep
    _reconcileJobsOnStartup: reconcileJobsOnStartup,
    _reconcileOnStartup: reconcileOnStartup, // R3: what a restart does to a recording in progress
    _failoverTuning: failoverTuning,
    _stallWatchCount: () => stallWatchdogs.size, // #274: no part's watchdog outlives it
    _stopTimeOf: stopTimeOf, // #217: the stop the hard stop and the stop checks read
    _chooseProvider: chooseProvider, // #137: which candidate a join-only start is given
    segments
};

// C-2: the coordinator counts the running recordings from this one source, read at each decision.
coordinator.setRecordingsSource(listActive);
