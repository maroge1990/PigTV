/**
 * The tuner model (roadmap Phase 3, contract C-E). Only with PIGTV_TUNER=1.
 *
 * A tuner is one provider connection and one ffmpeg, writing HLS segments into a
 * directory of its own. Viewers (and, from 0127, recordings) attach to a tuner;
 * they do not own an ffmpeg. Two viewers whose resolve produces the same ffmpeg
 * arguments share one tuner, so a second device on the same channel costs no
 * second provider connection.
 *
 *   tuner   TunerSession (a TranscodeSession: the same start, retries, stall
 *           watchdog, failure classification and stop), keyed by its arguments
 *   viewer  { id, tunerId, owner, live, lastAccess }: what resolve hands out as
 *           sessionId; DELETE /api/playback/:id, terminal-status, the idle sweep
 *           and the coordinator's owner/idle tracking all work on it
 *   hold    a recording's claim on a tuner ('rec:<scheduleId>', 0127)
 *
 * A tuner stops when its last viewer and its last hold are gone, when every
 * viewer has gone idle past the existing idle rules (5 min live, 30 min
 * otherwise), when the stall watchdog fires, or when the coordinator releases it
 * to admit somebody else.
 *
 * The playlist a client gets is rendered by the server (hlsPlaylist.js) from the
 * tuner's own segment list, not ffmpeg's file: ffmpeg writes a short rolling
 * playlist (ffmpeg.m3u8, FFMPEG_LIST_SIZE entries, never served) that the server
 * reads once a second and on every playlist request. Why that rather than
 * `-f segment` with a segment list: the hls muxer is the one ffmpeg path already
 * proven on the provider's feeds (fMP4 init segment, independent segments,
 * temp_file writes, exact EXTINF durations), so the muxing is unchanged and only
 * the bookkeeping moves to the server.
 *
 * #EXT-X-PROGRAM-DATE-TIME: the wall clock at which the first segment the server
 * sees started is taken as (the time it was seen) minus (the durations of every
 * segment ffmpeg lists at that moment); each later segment starts where the
 * previous one ended (anchor + accumulated EXTINF durations). That keeps the
 * dates strictly monotonic and consistent with the durations, which is what a
 * player's seek(to: Date) needs. It does not follow a provider that resends old
 * content after a reconnect (the ~19 s resend, blueprint §3): the timeline stays
 * continuous and the dates drift by that much, as the picture already does.
 * File mtimes were rejected: they jitter with disk and event-loop latency and
 * can step backwards.
 */

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const ts = require('./transcodeSession');
const { TranscodeSession } = ts;
const hls = require('./hlsPlaylist');
const { redact } = require('../redact');

/** PIGTV_TUNER=1 (also true/yes/on). Read per call so a test can switch it. */
function enabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.PIGTV_TUNER || '').trim());
}

// ffmpeg's own playlist: read by the server only. Long enough that a stalled
// event loop cannot make the server miss a segment (2 minutes at 4 s).
const FFMPEG_LIST_SIZE = 30;
const INGEST_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Timeshift (0128). A tuner keeps up to PIGTV_TIMESHIFT_HOURS (default 3) of
// segments instead of 90, in <recordings volume>/.timeshift/<tunerId> - not on
// the 2 GB tmpfs - so a viewer can pause, rewind and start over, and a recording
// can take its pre-buffer from what the tuner already had. The oldest segments go
// when the window is exceeded, or when the volume's free space drops below
// PIGTV_TIMESHIFT_MIN_FREE_GB (default 20; the recordings' own floor, 10 GB, is
// lower, so timeshift gives way first). PIGTV_TIMESHIFT_HOURS=0 keeps the 0126
// window (90 segments on the tmpfs).
// ---------------------------------------------------------------------------

function timeshiftHours() {
    const h = Number.parseFloat(process.env.PIGTV_TIMESHIFT_HOURS);
    return Number.isFinite(h) && h >= 0 ? h : 3;
}

function timeshiftEnabled() {
    return enabled() && timeshiftHours() > 0;
}

function timeshiftMinFreeGB() {
    const gb = Number.parseFloat(process.env.PIGTV_TIMESHIFT_MIN_FREE_GB);
    return Number.isFinite(gb) && gb >= 0 ? gb : 20;
}

const TIMESHIFT_DIR = '.timeshift';
const SPACE_CHECK_MS = 15 * 1000;

/** Where a new tuner's directory goes, and how long its window is. */
function placement(settings = {}) {
    if (!timeshiftEnabled()) return {};
    return {
        baseDir: path.join(settings.recordingsPath || '/app/recordings', TIMESHIFT_DIR),
        timeshiftSec: timeshiftHours() * 3600
    };
}

/** Free space in GB on the volume holding `dir`, or null when it cannot be told. */
function freeSpaceGB(dir) {
    if (typeof hooks.freeSpaceGB === 'function') return hooks.freeSpaceGB(dir);
    try {
        if (typeof require('fs').statfsSync !== 'function') return null;
        const st = require('fs').statfsSync(dir);
        return (st.bavail * st.bsize) / (1024 ** 3);
    } catch {
        return null;
    }
}

/**
 * Remove every tuner directory a previous run left in <recordings>/.timeshift (at
 * startup nothing can still be writing there; a running tuner's own directory is
 * skipped anyway). Silent when there is nothing to remove.
 */
async function sweepOrphanedTimeshift(recordingsRoot) {
    const dir = path.join(recordingsRoot || '/app/recordings', TIMESHIFT_DIR);
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    const orphans = entries.filter(e => e.isDirectory() && !tuners.has(e.name));
    if (!orphans.length) return 0;
    console.log(`[Tuner] Removing ${orphans.length} timeshift director${orphans.length === 1 ? 'y' : 'ies'} left by a previous run`);
    await Promise.all(orphans.map(e => fs.rm(path.join(dir, e.name), { recursive: true, force: true })
        .catch(err => console.warn(`[Tuner] Could not remove ${e.name}:`, err.message))));
    return orphans.length;
}

const tuners = new Map();   // tunerId -> TunerSession
const viewers = new Map();  // viewerId -> viewer

// Test seams: spawnArgs(tuner) replaces the arguments that are spawned (the key is
// still computed from the real ones); freeSpaceGB(dir) and spaceCheckMs stand in
// for the timeshift volume's free space and how often it is looked at.
const hooks = { spawnArgs: null, freeSpaceGB: null, spaceCheckMs: null };

class TunerSession extends TranscodeSession {
    constructor(url, options = {}) {
        super(url, options);
        this.kind = 'tuner';
        this.baseDir = options.baseDir || ts.CACHE_DIR;
        this.dir = path.join(this.baseDir, this.id);
        this.playlistPath = path.join(this.dir, 'ffmpeg.m3u8');
        this.key = null;
        this.info = options.info || null;   // the probe analysis it was started from
        this.timeshiftSec = options.timeshiftSec > 0 ? options.timeshiftSec : 0;
        this.viewers = new Set();
        this.holds = new Set();
        this.resetWindow();
        this.dead = false;
    }

    resetWindow() {
        this.window = [];          // [{ seq, name, duration, pdt }], oldest first
        this.lastSeq = -1;
        this.targetDuration = 0;
        this.version = 3;
        this.mapName = null;
        this.ended = false;
        this.retired = [];         // names out of the window, not yet deleted
        this.windowVersion = 0;
        this.windowSec = 0;        // the window's total duration
        this._rendered = new Map();
    }

    /** The same source/codec arguments as a session; only the HLS muxer's window differs. */
    buildTunerArgs() {
        return [...this.buildSourceArgs(), ...this.buildTunerOutputArgs()];
    }

    buildTunerOutputArgs() {
        const isFmp4 = this.options.segmentType === 'fmp4';
        const args = [
            '-f', 'hls',
            '-hls_time', String(ts.SEGMENT_DURATION),
            // The server keeps the window and deletes segments itself, so no
            // delete_segments; ffmpeg's playlist is only a feed for the server.
            '-hls_list_size', String(FFMPEG_LIST_SIZE),
            '-hls_flags', 'independent_segments+temp_file'
        ];
        if (isFmp4) {
            args.push(
                '-hls_segment_type', 'fmp4',
                '-hls_fmp4_init_filename', 'init.mp4',
                '-hls_segment_filename', path.join(this.dir, 'seg%04d.m4s')
            );
        } else {
            args.push(
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts')
            );
        }
        args.push(this.playlistPath);
        return args;
    }

    /**
     * What makes two tuners interchangeable: the exact ffmpeg arguments (with this
     * tuner's own directory taken out) plus what its master playlist says.
     * Computing it builds the arguments once; start() spawns those same ones.
     */
    computeKey() {
        const args = this.buildTunerArgs();
        this._firstArgs = args;
        const portable = args.map(a => a.split(this.dir).join('<dir>'));
        const { videoRange, width, height, fps } = this.options;
        this.key = crypto.createHash('sha256')
            .update(JSON.stringify({ args: portable, master: { videoRange: videoRange || null, width: width || 0, height: height || 0, fps: fps || null } }))
            .digest('hex');
        return this.key;
    }

    buildFFmpegArgs() {
        if (hooks.spawnArgs) return hooks.spawnArgs(this);
        if (this._firstArgs) {
            const args = this._firstArgs;
            this._firstArgs = null;
            return args;
        }
        // A retry (software decode) may have changed an option: build afresh.
        return this.buildTunerArgs();
    }

    /** Read ffmpeg's playlist and take in any segment the server has not seen. */
    ingest() {
        if (!this._ingesting) {
            this._ingesting = this._ingest().finally(() => { this._ingesting = null; });
        }
        return this._ingesting;
    }

    async _ingest() {
        let text;
        try {
            text = await fs.readFile(this.playlistPath, 'utf8');
        } catch {
            return;
        }
        const parsed = hls.parseMediaPlaylist(text);
        if (parsed.version) this.version = Math.max(this.version, parsed.version);
        if (parsed.map) this.mapName = parsed.map;
        if (parsed.targetDuration) this.targetDuration = Math.max(this.targetDuration, parsed.targetDuration);

        const fresh = parsed.segments.filter(s => s.seq > this.lastSeq);
        if (fresh.length) {
            const now = Date.now();
            if (this.lastSeq >= 0 && fresh[0].seq !== this.lastSeq + 1) {
                console.warn(`[Tuner ${this.id}] Missed segments ${this.lastSeq + 1}-${fresh[0].seq - 1}; the playlist skips them`);
            }
            let start;
            if (this.window.length) {
                const last = this.window[this.window.length - 1];
                start = last.pdt + last.duration * 1000;
            } else if (Number.isFinite(this._nextPdt)) {
                start = this._nextPdt;
            } else {
                // First sight: the newest listed segment has only just been closed.
                start = now - fresh.reduce((t, s) => t + s.duration, 0) * 1000;
            }
            const added = [];
            for (const s of fresh) {
                const seg = { seq: s.seq, name: s.name, duration: s.duration, pdt: start };
                start += s.duration * 1000;
                this.window.push(seg);
                this.windowSec += s.duration;
                added.push(seg);
                this.lastSeq = s.seq;
                this.targetDuration = Math.max(this.targetDuration, Math.round(s.duration));
            }
            this._nextPdt = start;
            this.windowVersion++;
            this.emit('segments', added);
        }
        if (parsed.ended && !this.ended) {
            this.ended = true;
            this.windowVersion++;
        }
        await this.trim();
    }

    /**
     * Keep the window - 90 segments, or with timeshift (0128) up to its hours - and
     * the timeshift volume's free-space floor. Segments that left the window are
     * deleted 12 segments later (a client may still be fetching one), except when
     * the floor is the reason, when they go at once.
     */
    async trim() {
        let changed = false;
        const retire = () => {
            const seg = this.window.shift();
            this.windowSec -= seg.duration;
            this.retired.push(seg.name);
            changed = true;
            return seg;
        };
        if (this.timeshiftSec > 0) {
            while (this.window.length > 1 && this.windowSec - this.window[0].duration >= this.timeshiftSec) retire();
        } else {
            while (this.window.length > ts.HLS_LIST_SIZE) retire();
        }
        if (this.timeshiftSec > 0) changed = (await this.keepFreeSpace(retire)) || changed;
        if (changed) this.windowVersion++;
        await this.deleteRetired(ts.HLS_DELETE_THRESHOLD);
    }

    /** Below the floor: drop the oldest segments (never below the 0126 window of 90). */
    async keepFreeSpace(retire) {
        const every = hooks.spaceCheckMs ?? SPACE_CHECK_MS;
        const now = Date.now();
        if (this._spaceCheckedAt && now - this._spaceCheckedAt < every) return false;
        this._spaceCheckedAt = now;
        const free = freeSpaceGB(this.baseDir);
        const floor = timeshiftMinFreeGB();
        if (free === null || free >= floor) return false;
        const needBytes = (floor - free) * 1024 ** 3;
        let freed = 0;
        let dropped = 0;
        while (freed < needBytes && this.window.length > ts.HLS_LIST_SIZE) {
            const seg = retire();
            try { freed += (await fs.stat(path.join(this.dir, seg.name))).size; } catch { /* already gone */ }
            dropped++;
        }
        await this.deleteRetired(0);
        if (dropped) {
            console.warn(`[Tuner ${this.id}] Only ${free.toFixed(1)} GB free for timeshift (floor ${floor} GB): ` +
                `dropped the oldest ${dropped} segments (${(freed / 1024 ** 2).toFixed(0)} MB); window now ${Math.round(this.windowSec / 60)} min`);
        }
        return dropped > 0;
    }

    /** Delete retired segment files beyond the `keep` most recent (a client may still ask for those). */
    async deleteRetired(keep) {
        while (this.retired.length > keep) {
            const name = this.retired.shift();
            await fs.unlink(path.join(this.dir, name)).catch(() => { /* already gone */ });
        }
    }

    async isPlaylistReady() {
        await this.ingest();
        return this.window.length > 0;
    }

    /** Segments with their dates, for a recording (0127). */
    segmentsSnapshot() {
        return this.window.map(s => ({ ...s, map: this.mapName }));
    }

    /**
     * The media playlist a viewer gets. `skip` answers _HLS_skip=YES with a delta
     * update when the tuner advertises CAN-SKIP-UNTIL (timeshift, 0128).
     */
    async getPlaylist({ skip = false } = {}) {
        this.touch();
        await this.ingest();
        if (!this.window.length) return null;
        const canSkipUntil = this.canSkipUntil();
        const wantSkip = skip === true && canSkipUntil > 0;
        const cacheKey = `${this.windowVersion}|${wantSkip ? 1 : 0}`;
        const hit = this._rendered.get(cacheKey);
        if (hit) return hit;
        const map = this.mapName;
        const { text, targetDuration } = hls.renderMediaPlaylist({
            segments: this.window.map(s => ({ name: s.name, duration: s.duration, pdt: s.pdt, map })),
            mediaSequence: this.window[0].seq,
            version: this.version,
            targetDuration: this.targetDuration,
            endList: this.ended,
            canSkipUntil,
            skip: wantSkip
        });
        this.targetDuration = Math.max(this.targetDuration, targetDuration);
        this._rendered = new Map([[cacheKey, text]]);
        return text;
    }

    /**
     * Seconds a delta update may leave out: six target durations, the smallest the
     * HLS spec allows (RFC 8216bis 4.4.3.8), only for a timeshift tuner - whose
     * playlist is hours long - and 0 (no delta updates) otherwise.
     */
    canSkipUntil() {
        if (!(this.timeshiftSec > 0)) return 0;
        return 6 * Math.max(this.targetDuration, ts.SEGMENT_DURATION);
    }

    /**
     * Newest write in the tuner directory, without statting every segment the
     * window holds (hours of them, from 0128): ffmpeg's playlist, the init
     * segment, and any file that is not a finished segment (the one being written,
     * its .tmp). The watchdog's question is unchanged: has ffmpeg written anything?
     */
    async latestOutputAt() {
        let names;
        try {
            names = await fs.readdir(this.dir);
        } catch {
            return null;
        }
        const done = new Set(this.window.map(s => s.name));
        for (const n of this.retired) done.add(n);
        const newest = this.window.length ? this.window[this.window.length - 1].name : null;
        let latest = null;
        for (const name of names) {
            if (done.has(name) && name !== newest) continue;
            try {
                const { mtimeMs } = await fs.stat(path.join(this.dir, name));
                if (latest === null || mtimeMs > latest) latest = mtimeMs;
            } catch { /* deleted between readdir and stat */ }
        }
        return latest;
    }

    async clearSegments() {
        await super.clearSegments();
        // Only reached before the first playlist (the retries); start the list again.
        this.resetWindow();
        this._nextPdt = undefined;
    }

    async handleStall() {
        console.error(`[Tuner ${this.id}] Releasing stalled session (tuner) for ${redact(this.url)}`);
        if (this.stderrTail.length) {
            console.error(`[Tuner ${this.id}] Last ffmpeg output:`);
            this.stderrTail.forEach(line => console.error(`[Tuner ${this.id}]   ${redact(line)}`));
        }
        await destroyTuner(this, 'stalled');
    }

    /** Idle time of the tuner's most recent viewer; Infinity with no viewers. */
    viewerIdleMs(now = Date.now()) {
        let min = Infinity;
        for (const id of this.viewers) {
            const v = viewers.get(id);
            if (v) min = Math.min(min, now - v.lastAccess);
        }
        return min;
    }

    viewerOwners() {
        const owners = [];
        for (const id of this.viewers) {
            const v = viewers.get(id);
            if (v) owners.push(v.owner || null);
        }
        return owners;
    }

    /** Schedule ids of the recordings holding this tuner (0127). */
    recordingIds() {
        return [...this.holds].filter(h => h.startsWith('rec:')).map(h => Number(h.slice(4)));
    }
}

/**
 * A tuner for these arguments: the running one with the same key, or a new one
 * (not yet registered or started). `joined` says which.
 */
function prepare(url, options) {
    const t = new TunerSession(url, options);
    t.computeKey();
    const existing = findByKey(t.key);
    if (existing) return { tuner: existing, joined: true };
    return { tuner: t, joined: false };
}

function isUsable(t) {
    return !!t && !t.dead && !t._destroying && !t.hasFailed();
}

function findByKey(key) {
    for (const t of tuners.values()) if (t.key === key && isUsable(t)) return t;
    return null;
}

/** A usable tuner on this stream, whatever its arguments (a recording may share any). */
function findByUrl(url) {
    let best = null;
    for (const t of tuners.values()) {
        if (t.url !== url || !isUsable(t)) continue;
        if (!best || t.window.length > best.window.length) best = t;
    }
    return best;
}

function register(t) {
    tuners.set(t.id, t);
}

/** Start a registered tuner's ffmpeg and its bookkeeping. */
async function start(t) {
    await fs.mkdir(t.baseDir, { recursive: true });
    t.on('exit', () => onExit(t));
    t.on('error', () => onExit(t));
    t._ingestTimer = setInterval(() => { t.ingest().catch(() => {}); }, INGEST_INTERVAL_MS);
    t._ingestTimer.unref();
    console.log(`[Tuner ${t.id}] Starting (key ${t.key.slice(0, 12)})`);
    await t.start();
}

function onExit(t) {
    // A retry is pending (the status went back to 'pending'): not an end.
    if (t.status === 'pending' || t._destroying) return;
    t.dead = true;
    // Pick up the last segments (and ffmpeg's ENDLIST, for a source that ended).
    t.ingest().catch(() => {}).finally(() => {
        t.emit('ended', 'exited');
        if (t.viewers.size === 0 && t.holds.size === 0) destroyTuner(t, 'exited').catch(() => {});
    });
}

function addViewer(t, { owner = null, live = false } = {}) {
    const v = {
        id: crypto.randomBytes(8).toString('hex'),
        tunerId: t.id,
        owner,
        live: live === true,
        createdAt: Date.now(),
        lastAccess: Date.now()
    };
    viewers.set(v.id, v);
    t.viewers.add(v.id);
    t.touch();
    return v;
}

/** The tuner behind a viewer id, marking both as in use; null when either is gone. */
function viewerTarget(viewerId) {
    const v = viewers.get(String(viewerId));
    if (!v) return null;
    const t = tuners.get(v.tunerId);
    if (!t || t._destroying) {
        viewers.delete(v.id);
        return null;
    }
    v.lastAccess = Date.now();
    t.touch();
    return t;
}

function getViewer(viewerId) {
    return viewers.get(String(viewerId)) || null;
}

/** A viewer leaves; the tuner stops with its last viewer and hold. True if it existed. */
async function releaseViewer(viewerId) {
    const v = viewers.get(String(viewerId));
    if (!v) return false;
    viewers.delete(v.id);
    const t = tuners.get(v.tunerId);
    if (t) {
        t.viewers.delete(v.id);
        if (t.viewers.size === 0 && t.holds.size === 0) await destroyTuner(t, 'last viewer left');
    }
    return true;
}

function hold(t, key) {
    t.holds.add(key);
    t.touch();
}

async function unhold(t, key) {
    if (!t) return;
    t.holds.delete(key);
    if (t.viewers.size === 0 && t.holds.size === 0 && tuners.get(t.id) === t) {
        await destroyTuner(t, 'last hold released');
    }
}

/** Stop a tuner and everything attached to it. Idempotent. */
async function destroyTuner(t, why) {
    if (!t || t._destroying) return;
    t._destroying = true;
    tuners.delete(t.id);
    for (const id of t.viewers) viewers.delete(id);
    t.viewers.clear();
    if (t._ingestTimer) clearInterval(t._ingestTimer);
    console.log(`[Tuner ${t.id}] Stopping (${why})`);
    t.emit('ended', why);
    try {
        await t.cleanup();
    } catch (err) {
        console.error(`[Tuner ${t.id}] Could not clean up:`, err.message);
    }
}

function list() {
    return [...tuners.values()];
}

function getTuner(id) {
    return tuners.get(id) || null;
}

function listViewers() {
    return [...viewers.values()];
}

/**
 * The idle rules, per viewer: a live viewer silent for PIGTV_LIVE_IDLE_TIMEOUT_SEC
 * (5 min), any other for 30 min, is dropped; a tuner left with no viewers and no
 * holds stops.
 */
async function sweep(now = Date.now()) {
    for (const v of [...viewers.values()]) {
        const limit = v.live ? ts.LIVE_SESSION_TIMEOUT_MS : ts.SESSION_TIMEOUT_MS;
        if (now - v.lastAccess > limit) {
            console.log(`[Tuner] Cleaning up stale viewer ${v.id}`);
            await releaseViewer(v.id);
        }
    }
    for (const t of list()) {
        if (t.viewers.size === 0 && t.holds.size === 0) await destroyTuner(t, 'idle');
    }
}

let sweepTimer = null;
function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => { sweep().catch(err => console.error('[Tuner] Sweep failed:', err.message)); }, ts.CLEANUP_INTERVAL_MS);
    sweepTimer.unref();
}

/** Every tuner, stopped (tests; the admin "kill all"). */
async function destroyAll(why = 'stopped') {
    for (const t of list()) await destroyTuner(t, why);
}

module.exports = {
    enabled,
    timeshiftEnabled,
    timeshiftHours,
    timeshiftMinFreeGB,
    placement,
    sweepOrphanedTimeshift,
    TIMESHIFT_DIR,
    TunerSession,
    prepare,
    register,
    start,
    findByKey,
    findByUrl,
    addViewer,
    viewerTarget,
    getViewer,
    releaseViewer,
    hold,
    unhold,
    destroyTuner,
    destroyAll,
    list,
    getTuner,
    listViewers,
    sweep,
    startSweep,
    hooks,
    FFMPEG_LIST_SIZE
};
