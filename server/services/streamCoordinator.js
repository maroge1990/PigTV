/**
 * Stream coordinator.
 *
 * The provider allows a limited number of concurrent connections — one, in the
 * common case — and both live viewing and recording want it. With a single
 * browser that conflict was rare enough to ignore. With a phone and a TV it
 * stops being theoretical, and the failure is miserable to diagnose from the
 * client: a channel that simply refuses to play, for no stated reason.
 *
 * So the rule lives here rather than in each client, and every answer carries
 * its reason.
 *
 * The policy:
 *
 *   - A recording beats a viewer who is not really there. A session that has
 *     not fetched anything recently is a closed laptop, not a person.
 *   - A recording asks a live viewer once, and only once. Nagging is worse
 *     than missing the first few minutes.
 *   - Declining does not cancel the recording: it waits, and starts the moment
 *     playback stops, marked partial with the missing span recorded.
 *   - Starting live TV while recording requires explicit confirmation, and
 *     confirming keeps what has been captured so far.
 *   - Starting live TV while *another device* is watching does too. A device
 *     replaces its own earlier stream without asking (it can only watch one
 *     thing), and an abandoned stream is reclaimed silently, so the question
 *     is only ever put when a person really is on the other end.
 *
 * Provider pools (0173, multi-provider P5). With backup providers
 * configured, every provider has its own connections, so every rule above is
 * applied per provider: a viewer or recording asking for provider B counts,
 * reclaims and asks about B's streams and B's recordings only. A stream or
 * recording belongs to the pool of its `providerId` (a source id); a backup is its
 * own pool, and everything else - the primary, any other non-backup source, and a
 * bare-url resolve with no source (providerId null) - is the primary's pool, which
 * is exactly today's single pool. With no backup configured there is only that
 * pool and nothing here behaves differently from before.
 *
 * Sources that are the same account (0181: the same server origin and login, see
 * accountKey.js) share one pool, whatever they are called: the provider counts one
 * connection for both, so a backup with the primary's login counts in the primary's
 * pool, two such backups in the lower id's, and the pool's limit is the lowest
 * effective limit among them.
 *
 * Leases (R11). Every rule above counts the sessions that exist. But a viewer is
 * admitted, then resolve spends seconds probing the stream before its session is
 * registered, and in that gap a second contender (another device, a recording that
 * has just come due, a relay's standby) sees the connection as free and is admitted
 * too: the provider then sees one connection more than it allows. So the decision
 * that admits somebody also takes a LEASE on the connection, in the same tick,
 * before anything is awaited. A lease is { id, providerId, pool, owner, purpose
 * ('viewer' | 'recording' | 'standby' | 'warm'), createdAt, expiresAt, sessionId,
 * onReclaim }. While it is unbound it counts in its pool like the session it will
 * become; bind() hands the count over to the session (never both), and it is
 * released on a failed probe, a cancel or a departure. One that nobody released
 * expires after LEASE_TTL_MS with a warning, so a bug can never leak a connection.
 * Recordings bind to the recording (the schedule's row is what listActive() counts),
 * and a lease already listed there is not counted twice.
 *
 * An unbound standby or warm lease is as reclaimable as the session it will be: a
 * viewer that arrives during its probe takes the connection and the lease's
 * onReclaim tells its owner to stop. tryReserveFree() is the way for work that must
 * never disturb anybody (a standby, a warm channel) to take a connection: a lease
 * only when one is free right now, atomically, else null.
 *
 * Warm (R11, off by default; services/channelWarming.js): a session started for the
 * channel a viewer is likely to play next, on a connection nobody wants. Like a
 * standby it is abandoned from the start, and it is the FIRST thing reclaimed (before
 * a standby): unasked and silently, no prompt, no terminal-status note, and it never
 * displaces a recording or a viewer - it is only ever started on a free connection.
 */

const transcodeSession = require('./transcodeSession');

// A session that has not asked for a segment in this long is assumed dead.
// Transcode sessions are polled continuously by a playing client, so silence
// is meaningful rather than merely quiet.
const DEFAULT_IDLE_TIMEOUT_SEC = 60;

// How far ahead of a recording the viewer is asked to give up the stream.
const DEFAULT_PROMPT_LEAD_MIN = 5;

// How long a viewer has to answer the "recording needs your stream" prompt,
// once the recording is actually due, before the recording takes the stream
// anyway (0158, Mark's decision). Not answering (the TV switched off while an
// Apple TV keeps streaming) used to mean the recording waited for the whole
// programme and was marked missed; an explicit "Keep watching" still waits,
// exactly as before.
const DEFAULT_PROMPT_TIMEOUT_MIN = 3;

// Prompts already issued, by schedule id. Cleared when the schedule resolves.
//
// issuedAt   when the prompt first existed at all - as early as announceUpcoming's
//            lead-time notice, up to recordingPromptLeadMin minutes before the
//            recording is actually due. Informational only.
// dueSince   when the recording FIRST became due and still found a live viewer in
//            its way (set inside requestForRecording, never
//            by announceUpcoming). This, not issuedAt, is what the timeout counts
//            from: a viewer who has had the early notice on screen for four minutes
//            has not been asked to give up their stream for four minutes, only warned
//            it is coming - the clock the task description means starts once the
//            recording actually needs it.
// declinedAt set once, by an explicit "Keep watching": today's wait-for-it-to-end
//            behaviour, unaffected by the timeout below.
const prompts = new Map(); // scheduleId -> { issuedAt, dueSince, declinedAt, schedule }

// Why a displaced client needs to be told, rather than left to guess.
//
// When a viewer is displaced its session is deleted, so its player sees a
// playlist or segment 404 - indistinguishable from an expired session or a
// stalled feed. A client that recovers from that by re-resolving will take the
// provider's only connection straight back off whoever just got it, and the
// two clients trade the stream back and forth. Owner equality cannot prevent
// it: two browsers signed in as the same person are both `user:<id>`.
//
// So a release performed to admit somebody else leaves a short-lived note that
// the session's own owner can read once, and stop instead of recovering.
//
// What is deliberately NOT recorded: who took the stream, their device, the
// channel, or the new session id. The record is the minimum that answers "was
// mine replaced, or did it just break" - anything more would leak one client's
// activity to another.
const terminalRecords = new Map(); // sessionId -> { owner, status, expiresAt }

// Long enough for a player with a full buffer to reach its first failed
// request and ask, short enough that the map stays small. Seconds, tunable.
// Read per call rather than frozen at load so the expiry can be exercised
// without a sleep the length of the real TTL.
function terminalTtlMs() {
    const sec = Number.parseFloat(process.env.PIGTV_TERMINAL_STATUS_TTL_SEC);
    return (Number.isFinite(sec) && sec > 0 ? sec : 15 * 60) * 1000;
}
// A ceiling as well as a TTL: nothing here is load-bearing, and an unbounded
// map fed by session churn is a slow leak.
const TERMINAL_MAX_RECORDS = 200;

function pruneTerminalRecords(now = Date.now()) {
    for (const [id, rec] of terminalRecords) {
        if (rec.expiresAt <= now) terminalRecords.delete(id);
    }
    // Still oversized after pruning? Drop the oldest, which are the least
    // likely to still be wanted.
    while (terminalRecords.size > TERMINAL_MAX_RECORDS) {
        terminalRecords.delete(terminalRecords.keys().next().value);
    }
}

/**
 * Note that this stream is about to be removed so that someone else can play.
 * Called immediately before the release, while the stream's owner is still known.
 */
function noteReplaced(stream) {
    // No owner means nobody could ever prove the session was theirs, so the
    // record could only ever answer "none" - don't keep it.
    if (!stream || !stream.id || !stream.owner) return;
    pruneTerminalRecords();
    terminalRecords.set(String(stream.id), {
        owner: stream.owner,
        status: 'taken-over',
        expiresAt: Date.now() + terminalTtlMs()
    });
}

/**
 * Was this session replaced by another viewer, as far as its own owner is
 * concerned? Answers 'taken-over' or 'none' and nothing else.
 *
 * Non-consuming: the same question during the TTL gets the same answer, so a
 * client that asks twice (a retry, a second failure) is not told a different
 * story the second time.
 *
 * Every other case is 'none', including a session that never existed, one that
 * ended for any other reason, and one that belongs to somebody else - so the
 * answer never reveals that a session exists at all.
 */
function terminalStatus(sessionId, owner) {
    pruneTerminalRecords();
    const rec = terminalRecords.get(String(sessionId));
    if (!rec || !owner || rec.owner !== owner) return 'none';
    return rec.status;
}

function activeStreams() {
    // HLS sessions are the only streams since 0103 (the piped remux is gone).
    return transcodeSession.getAllSessions().map(s => ({
        id: s.id,
        type: 'transcode',
        url: s.url,
        idleMs: s.idleMs,
        startTime: s.startTime,
        owner: s.owner || null,
        providerId: s.providerId ?? null,
        // 0189: a relay's hot standby (services/streamRelay.js). Nobody watches it: it counts
        // as abandoned from the start, so whoever needs its connection takes it unasked.
        standby: s.standby === true,
        // R12: a session started ahead for the channel its owner may play next. Nobody
        // watches it either, and it is reclaimed before even a standby.
        warm: s.warm === true
    }));
}

/** Abandoned: silent for the idle timeout, or a standby (0189) or a warm session (R12), which never have a viewer. */
const isStale = (s, cutoffMs) => s.standby === true || s.warm === true || s.idleMs >= cutoffMs;
const idleText = (s) => (s.warm ? 'a warm session' : s.standby ? 'a standby' : `${Math.round(s.idleMs / 1000)}s idle`);

// ---------------------------------------------------------------------------
// Leases (R11)
// ---------------------------------------------------------------------------

// Long enough for the slowest legitimate probe (15 s) plus a cold start; short enough that
// a lease a bug forgot to release cannot hold a connection for more than a minute.
const LEASE_TTL_MS = 60 * 1000;
// A lease bound to a recording is only a record (the recording row is what counts); it is
// dropped when its ffmpeg exits, and this is only the net under that.
const BOUND_RECORDING_KEEP_MS = 24 * 60 * 60 * 1000;

// A lease is never idle: it is a start in progress, so only its purpose (standby, warm) can make it reclaimable.
const LEASE_IDLE_MS = 0;

const leases = new Map(); // lease id -> lease
let leaseSeq = 0;

const isBound = (l) => l.sessionId !== null || l.recordingId !== null;

/** Drop expired unbound leases (with a warning) and bound ones whose session or recording is gone. */
function pruneLeases(now = Date.now()) {
    for (const [id, l] of leases) {
        if (l.sessionId !== null) {
            const alive = typeof transcodeSession.peekSession === 'function' ? transcodeSession.peekSession(l.sessionId) : true;
            if (!alive) leases.delete(id);
        } else if (l.recordingId !== null) {
            if (now - l.createdAt > BOUND_RECORDING_KEEP_MS) leases.delete(id);
        } else if (l.expiresAt <= now) {
            console.warn(`[Coordinator] Lease ${id} (${l.purpose}, provider ${l.providerId ?? 'primary'}) expired unbound after ${Math.round((now - l.createdAt) / 1000)}s; releasing its connection`);
            leases.delete(id);
            l.released = true;
            callReclaim(l, 'expired');
        }
    }
}

function callReclaim(lease, why) {
    if (typeof lease.onReclaim !== 'function') return;
    try { lease.onReclaim(why); } catch (err) { console.warn(`[Coordinator] onReclaim of lease ${lease.id} failed:`, err.message); }
}

/**
 * Take a lease on a connection of `providerId`'s pool. Synchronous on purpose: it is called in
 * the same tick as the decision it backs. It does not check that a connection is free -
 * the caller has decided already (admitViewer, requestForRecording, tryReserveFree).
 */
function takeLease(providerId, purpose, { owner = null, onReclaim = null, ttlMs = LEASE_TTL_MS, schedule = null } = {}) {
    const dir = providerDirectory();
    const now = Date.now();
    const lease = {
        id: `lease-${++leaseSeq}-${now.toString(36)}`,
        providerId: providerId ?? null,
        pool: poolKey(providerId, dir),
        owner: owner || null,
        purpose,
        createdAt: now,
        expiresAt: now + ttlMs,
        sessionId: null,
        recordingId: null,
        released: false,
        onReclaim: typeof onReclaim === 'function' ? onReclaim : null,
        scheduleId: schedule ? Number(schedule.id) : null,
        schedule: schedule || null
    };
    leases.set(lease.id, lease);
    return lease;
}

const leaseId = (lease) => (lease && typeof lease === 'object' ? lease.id : lease);

/** Is this lease still held (not released, reclaimed or expired)? */
function leaseAlive(lease) {
    pruneLeases();
    const l = leases.get(leaseId(lease));
    return !!l && !l.released;
}

/** The session now exists: it is what counts from here. False when the lease was lost meanwhile. */
function bindLease(lease, sessionId) {
    pruneLeases();
    const l = leases.get(leaseId(lease));
    if (!l || l.released) return false;
    l.sessionId = String(sessionId);
    return true;
}

/** The recording is now running (its row is what listActive() counts). False when the lease was lost. */
function bindLeaseToRecording(lease, recordingId) {
    pruneLeases();
    const l = leases.get(leaseId(lease));
    if (!l || l.released) return false;
    l.recordingId = Number(recordingId);
    return true;
}

/** Give the lease up (a failure, a cancel, the work ended). Idempotent; true when there was one. */
function releaseLease(lease) {
    const l = lease && leases.get(leaseId(lease));
    if (!l) return false;
    leases.delete(l.id);
    l.released = true;
    return true;
}

/** Release a lease only while it holds a connection of its own, i.e. before it is bound. */
function releaseUnbound(lease) {
    const l = lease && leases.get(leaseId(lease));
    if (!l || isBound(l)) return false;
    return releaseLease(l);
}

/** A warm session was adopted by its owner (or any lease changes what it stands for). */
function convertLease(lease, purpose) {
    const l = leases.get(leaseId(lease));
    if (!l) return false;
    l.purpose = purpose;
    return true;
}

/** Leases not yet bound in this pool, optionally of one kind of purpose (see streamsInPool / recordingsInPool). */
function unboundLeasesInPool(pool, dir) {
    pruneLeases();
    return [...leases.values()].filter(l => !isBound(l) && !l.released && poolKey(l.providerId, dir) === pool);
}

/** A lease in the shape of a stream, for the counts and the reclaim order. */
function leaseAsStream(l) {
    return {
        id: l.id,
        type: 'lease',
        lease: l,
        url: null,
        idleMs: LEASE_IDLE_MS,
        startTime: l.createdAt,
        owner: l.owner,
        providerId: l.providerId,
        standby: l.purpose === 'standby',
        warm: l.purpose === 'warm'
    };
}

/** A recording lease in the shape of a recording row, for the viewer's conflict and the count. */
function leaseAsRecording(l) {
    const sch = l.schedule || {};
    return {
        id: l.scheduleId,
        lease: l,
        title: sch.title || 'A recording',
        channel_name: sch.channel_name || 'this channel',
        program_end: sch.program_end || Date.now(),
        post_buffer_min: sch.post_buffer_min || 0,
        providerId: l.providerId
    };
}

/** Every lease currently held, for diagnostics and tests. */
function listLeases() {
    pruneLeases();
    return [...leases.values()].map(l => ({ id: l.id, providerId: l.providerId, pool: l.pool, owner: l.owner, purpose: l.purpose,
        createdAt: l.createdAt, expiresAt: l.expiresAt, sessionId: l.sessionId, recordingId: l.recordingId }));
}

/**
 * 0189: is a connection of this provider free right now - no viewer (watching or not), no
 * recording and no standby on it? Stricter than canAdmitWithoutDisturbing, which would reclaim
 * an idle stream: a standby must never take anything from anybody. Leases count (R11).
 */
function hasFreeConnection(providerId, settings = {}, activeRecordings = []) {
    const dir = providerDirectory();
    const pool = poolKey(providerId, dir);
    return streamsInPool(pool, dir).length + recordingsInPool(activeRecordings, pool, dir).length < providerLimit(providerId, settings, dir);
}

/**
 * R11: a lease on a free connection of this provider, or null. "Free" is hasFreeConnection's
 * meaning - nobody is disturbed, nothing is reclaimed - and the check and the lease are one
 * synchronous step, so two callers cannot both find the same connection free. For work that
 * starts after an await (a standby's probe, a warm channel's start) and must not take anything.
 */
function tryReserveFree(providerId, purpose, settings = {}, activeRecordings = [], extra = {}) {
    if (!hasFreeConnection(providerId, settings, activeRecordings)) return null;
    return takeLease(providerId, purpose, extra);
}

/**
 * Continuity before speculation: a standby keeps what is being WATCHED going, a warm channel is
 * only a guess at what might be. So when a provider's only spare connection holds a warm channel,
 * a standby takes it (anything else still needs a free one: tryReserveFree). The lease is taken in
 * the same synchronous step as the decision, and the warm stream is released before this returns,
 * so the caller's probe starts only once the provider has one connection fewer.
 */
async function reserveTakingWarm(providerId, purpose, settings = {}, activeRecordings = [], extra = {}) {
    const free = tryReserveFree(providerId, purpose, settings, activeRecordings, extra);
    if (free) return free;
    const dir = providerDirectory();
    const pool = poolKey(providerId, dir);
    const streams = streamsInPool(pool, dir);
    const warm = streams.find(s => s.warm);
    if (!warm) return null;
    // Room once the warm one is gone, and only then.
    if (streams.length - 1 + recordingsInPool(activeRecordings, pool, dir).length >= providerLimit(providerId, settings, dir)) return null;
    const lease = takeLease(providerId, purpose, extra);
    console.log(`[Coordinator] Releasing ${warm.id} (warm) for a ${purpose}: keeping the playing channel going comes first`);
    await releaseStream(warm);
    return lease;
}

/** 0189: do two providers share a connection pool (the same provider, or the same account)? */
function samePool(a, b) {
    const dir = providerDirectory();
    return poolKey(a, dir) === poolKey(b, dir);
}

// ---------------------------------------------------------------------------
// Provider pools (0173)
// ---------------------------------------------------------------------------

const PRIMARY_POOL = 'primary';
const LEGACY_DIRECTORY = Object.freeze({ multi: false, primary: null, backups: new Map() });

/**
 * The providers as the pools see them: `primary` (the first enabled non-backup
 * stream source), `backups` (every backup source, by id, enabled or not, so a
 * stream still running on one that was just disabled stays in its own pool) and
 * `multi` (at least one enabled backup: pools are per provider).
 *
 * Read from the database only when it is already open - this is never the thing
 * that opens it - and read afresh on every call (a handful of rows), so a provider
 * added or disabled in Settings counts at once. Anything unreadable is today's
 * single pool: a coordinator failure must not be what stops playback.
 */
function providerDirectory() {
    try {
        const sqlite = require('../db/sqlite');
        if (typeof sqlite.isOpen !== 'function' || !sqlite.isOpen()) return LEGACY_DIRECTORY;
        const { withDefaults } = require('./providerFields');
        const all = sqlite.getDb().prepare('SELECT data FROM app_sources ORDER BY id').all()
            .map(r => { try { return withDefaults(JSON.parse(r.data)); } catch (e) { return null; } })
            .filter(src => src && src.type !== 'epg');
        const backups = new Map(all.filter(src => src.role === 'backup').map(src => [Number(src.id), src]));
        const multi = [...backups.values()].some(src => src.enabled !== false);
        if (!multi) return LEGACY_DIRECTORY;
        const primaries = all.filter(src => src.role !== 'backup');
        const primary = primaries.find(src => src.enabled !== false) || primaries[0] || null;
        // 0181: a backup that is the primary's account (or an earlier backup's) counts in that pool.
        const { accountKeyFor } = require('./accountKey');
        const poolOf = new Map();       // backup id -> the pool it counts in
        const merged = new Map();       // pool -> the backups folded into it
        const firstOfKey = new Map();   // account key -> the pool that owns it
        const primaryKey = primary ? accountKeyFor(primary) : null;
        if (primaryKey) firstOfKey.set(primaryKey, PRIMARY_POOL);
        for (const b of [...backups.values()].sort((x, y) => Number(x.id) - Number(y.id))) {
            const key = accountKeyFor(b);
            const owner = key && firstOfKey.has(key) ? firstOfKey.get(key) : Number(b.id);
            if (key && !firstOfKey.has(key)) firstOfKey.set(key, owner);
            poolOf.set(Number(b.id), owner);
            if (owner !== Number(b.id)) {
                if (!merged.has(owner)) merged.set(owner, []);
                merged.get(owner).push(b);
            }
        }
        return { multi, primary, backups, poolOf, merged };
    } catch (err) {
        return LEGACY_DIRECTORY;
    }
}

/** The pool a providerId counts in: a backup's own id, else the primary's pool. */
function poolKey(providerId, dir) {
    if (!dir.multi || providerId === null || providerId === undefined) return PRIMARY_POOL;
    const id = Number(providerId);
    if (!dir.backups.has(id)) return PRIMARY_POOL;
    return dir.poolOf && dir.poolOf.has(id) ? dir.poolOf.get(id) : id;
}

/** A recording's provider: the one it was started on, else its schedule's source. */
function recordingProvider(rec) {
    if (!rec) return null;
    return rec.providerId !== undefined ? rec.providerId : (rec.source_id ?? null);
}

// R11: the sessions in a pool plus the leases that will become sessions. A bound lease is not
// listed (its session is), so nothing is counted twice.
function streamsInPool(pool, dir) {
    const sessions = activeStreams().filter(s => poolKey(s.providerId, dir) === pool);
    const pending = unboundLeasesInPool(pool, dir).filter(l => l.purpose !== 'recording').map(leaseAsStream);
    return [...sessions, ...pending];
}

// The recordings in a pool: the running ones, plus recordings that have been admitted but whose
// row is not yet 'recording' (a lease already listed in `recordings` is not counted twice).
function recordingsInPool(recordings, pool, dir) {
    const running = (recordings || []).filter(r => poolKey(recordingProvider(r), dir) === pool);
    const known = new Set((recordings || []).map(r => Number(r.id)));
    const pending = unboundLeasesInPool(pool, dir)
        .filter(l => l.purpose === 'recording' && !known.has(l.scheduleId)).map(leaseAsRecording);
    return [...running, ...pending];
}

/** The provider id a pool stands for, for a conflict body: a backup's id, the primary's id, or null. */
function poolProviderId(pool, dir) {
    if (pool !== PRIMARY_POOL) return pool;
    return dir.primary ? Number(dir.primary.id) : null;
}

/**
 * How many connections this provider allows.
 *
 *   No backup configured (today's setup): `settings.maxProviderStreams`, default 1,
 *     exactly as before - the account's max_connections and a manual override are
 *     not consulted, so nothing changes until a backup is added.
 *   A backup: its account's max_connections, else 1 (providerAccounts.effectiveLimit).
 *   The primary, with backups configured: the larger of its account's max_connections
 *     (or 1) and `settings.maxProviderStreams`, so an admin who had raised the legacy
 *     setting above 1 does not lose connections by adding a backup.
 */
function providerLimit(providerId, settings = {}, dir = providerDirectory()) {
    const legacy = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    if (!dir.multi) return legacy;
    let accounts;
    try { accounts = require('./providerAccounts'); } catch (e) { return legacy; }
    const account = (id) => { try { return accounts.getAccount(id); } catch (e) { return null; } };
    const pool = poolKey(providerId, dir);
    // 0181: sources that are one account are one pool, limited by the lowest of them
    // (enabled ones; a disabled duplicate only when nothing else is left).
    const sharers = (dir.merged && dir.merged.get(pool)) || [];
    const lowestShared = (own) => {
        const live = sharers.filter(src => src.enabled !== false);
        return Math.min(own, ...(live.length ? live : sharers).map(src => accounts.effectiveLimit(src, account(src.id))));
    };
    if (pool !== PRIMARY_POOL) return lowestShared(accounts.effectiveLimit(dir.backups.get(pool), account(pool)));
    const primary = dir.primary;
    if (!primary) return legacy;
    return lowestShared(Math.max(accounts.effectiveLimit(primary, account(primary.id)), legacy));
}

/**
 * This owner's streams on every provider except `providerId`'s: a device watches
 * one thing, so admitting it on one provider replaces what it had on the others.
 * Empty for an unidentified caller, and always empty with one provider (one pool).
 */
function ownStreamsElsewhere(owner, providerId, dir = providerDirectory()) {
    if (!owner || !dir.multi) return [];
    const pool = poolKey(providerId, dir);
    return activeStreams().filter(s => s.owner === owner && poolKey(s.providerId, dir) !== pool);
}

/**
 * Release this owner's streams on other providers, as admitViewer does for a
 * viewer admitted on `providerId` (cause `replacement`, with the same
 * terminal-status note today's replacement leaves). Returns how many went.
 */
async function releaseOwnerElsewhere(owner, providerId) {
    let released = 0;
    for (const stream of ownStreamsElsewhere(owner, providerId)) {
        console.log(`[Coordinator] Releasing ${stream.id} (replacement, ${Math.round(stream.idleMs / 1000)}s idle): its device is now watching on another provider`);
        noteReplaced(stream);
        if (await releaseStream(stream)) released++;
    }
    return released;
}

/** The provider of this owner's most recently started stream; undefined when it has none. */
function ownerProvider(owner) {
    if (!owner) return undefined;
    const mine = activeStreams().filter(s => s.owner === owner && !s.warm).sort((a, b) => b.startTime - a.startTime);
    return mine.length ? mine[0].providerId : undefined;
}

/**
 * Streams with someone actually watching, as opposed to registered but stale.
 */
function liveViewers(idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC) {
    const cutoff = idleTimeoutSec * 1000;
    return activeStreams().filter(s => !isStale(s, cutoff));
}

function staleStreams(idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC) {
    const cutoff = idleTimeoutSec * 1000;
    return activeStreams().filter(s => isStale(s, cutoff));
}

async function releaseStream(stream) {
    // R11: an unbound lease has no session to remove: giving the lease up is the release, and its
    // owner (a probe in progress) is told so it stops instead of starting a session nobody counts.
    if (stream.lease) {
        releaseLease(stream.lease);
        callReclaim(stream.lease, 'reclaimed');
        return true;
    }
    try {
        await transcodeSession.removeSession(stream.id);
        // R12: a warm session's owner-side bookkeeping (the count of reclaimed ones).
        if (stream.warm) { try { require('./channelWarming').noteReclaimed(stream.id); } catch (e) { /* observation only */ } }
        return true;
    } catch (err) {
        console.error(`[Coordinator] Could not release ${stream.id}:`, err.message);
        return false;
    }
}

/**
 * Can a recording take the stream now?
 *
 * Returns { allowed, reason, prompted } — never throws, because a coordinator
 * failure must not be the thing that stops a recording.
 */
async function requestForRecording(schedule, settings = {}, providerId = undefined) {
    const idleTimeout = Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC;

    // Within the pool of the provider the recording will use (0173); with no
    // backup configured that is every stream, as before. As before, only viewer
    // streams are counted here, not other recordings (see canRecordFreely).
    const dir = providerDirectory();
    const pool = poolKey(providerId, dir);

    // R11: every verdict that allows the recording carries the lease on its connection, taken
    // in the same tick as the decision - before any release below is awaited - and handed to
    // the engine, which binds it to the recording (and releases it if the start fails).
    const leased = (verdict) => ({ ...verdict, lease: takeLease(providerId, 'recording', { schedule }) });

    // More than one provider connection available? Then there is nothing to
    // arbitrate and everything proceeds as before.
    const limit = providerLimit(providerId, settings, dir);
    let streams = streamsInPool(pool, dir);
    if (streams.length < limit) {
        return leased({ allowed: true, reason: 'A provider connection is free' });
    }

    // 0189 / R12: a warm session (first) and a standby give way, whoever else is on the provider:
    // with them gone there may be a free connection and nobody to ask.
    const giveWay = [...streams.filter(s => s.warm), ...streams.filter(s => s.standby && !s.warm)];
    if (giveWay.length) {
        const needed = streams.length - limit + 1;
        const going = giveWay.slice(0, needed);
        const enough = going.length >= needed;
        // Enough of them: the decision is made now, so the lease is taken before the first release.
        const verdict = enough ? leased({ allowed: true, reason: going.every(s => s.warm) ? 'A warm session gave up its connection' : 'A standby gave up its connection' }) : null;
        for (const s of going) {
            console.log(s.warm ? `[Coordinator] Releasing warm session ${s.id} for recording #${schedule.id}` : `[Coordinator] Releasing standby ${s.id} for recording #${schedule.id}`);
            await releaseStream(s);
        }
        if (verdict) {
            prompts.delete(schedule.id);
            return verdict;
        }
        // Not enough: those went, and the rest is decided on what is there after the awaits.
        streams = streamsInPool(pool, dir);
        if (streams.length < limit) return leased({ allowed: true, reason: 'A provider connection is free' });
    }

    // Reclaim anything registered but abandoned, without asking: there is
    // nobody to ask.
    const cutoff = idleTimeout * 1000;
    const stale = streams.filter(s => s.idleMs >= cutoff);
    const live = streams.filter(s => s.idleMs < cutoff);

    if (live.length === 0 && stale.length > 0) {
        const verdict = leased({ allowed: true, reason: 'Reclaimed an abandoned stream' });
        for (const s of stale) {
            console.log(`[Coordinator] Reclaiming idle stream ${s.id} (${Math.round(s.idleMs / 1000)}s silent) for recording #${schedule.id}`);
            await releaseStream(s);
        }
        prompts.delete(schedule.id);
        return verdict;
    }

    if (live.length === 0) {
        return leased({ allowed: true, reason: 'Nothing is using the provider' });
    }

    // Somebody is watching. Ask once; after that, wait quietly - unless nobody
    // has answered within recordingPromptTimeoutMin minutes of the recording
    // actually becoming due (dueSince, not the early announceUpcoming notice,
    // see the `prompts` comment above), in which case the recording takes the
    // stream itself, the same as it would if it had been forced. An explicit
    // "Keep watching" (declinedAt set) always keeps today's behaviour: wait.
    const now = Date.now();
    const existing = prompts.get(schedule.id);
    if (!existing) {
        prompts.set(schedule.id, { issuedAt: now, dueSince: now, declinedAt: null, schedule, providerId: providerId ?? null });
        console.log(`[Coordinator] Recording #${schedule.id} is waiting for the stream; asking the viewer`);
        return { allowed: false, prompted: true, reason: 'Waiting for the viewer to stop playback' };
    }
    if (!existing.dueSince) existing.dueSince = now; // became due only now; was only announced before
    existing.providerId = providerId ?? null; // the pool whose viewers are asked (pendingPrompt)

    if (!existing.declinedAt) {
        const timeoutMs = (Number.isFinite(settings.recordingPromptTimeoutMin)
            ? settings.recordingPromptTimeoutMin : DEFAULT_PROMPT_TIMEOUT_MIN) * 60000;
        if (now - existing.dueSince >= timeoutMs) {
            console.log(`[Coordinator] No answer from the viewer in ${Math.round(timeoutMs / 60000)} min; recording #${schedule.id} takes the stream`);
            const verdict = leased({ allowed: true, reason: 'No answer from the viewer; took the stream' });
            for (const s of live) await releaseStream(s);
            prompts.delete(schedule.id);
            return verdict;
        }
    }

    return { allowed: false, prompted: false, reason: 'Viewer declined; waiting for playback to stop' };
}

/**
 * Could a recording start on this provider now without asking anybody? True when
 * the pool has a free connection, or would have one once its abandoned streams
 * are reclaimed (requestForRecording does that). Non-mutating: for choosing the
 * provider a recording starts on (P7) before requestForRecording is called on it.
 *
 * Unlike requestForRecording, recordings already running on the provider count
 * (D4: a recording holds a connection until it ends), so a second recording is
 * not stacked onto a provider whose only connection a recording already holds.
 * `activeRecordings` defaults to recordingEngine.listActive().
 */
function canRecordFreely(providerId, settings = {}, activeRecordings = undefined) {
    const dir = providerDirectory();
    const pool = poolKey(providerId, dir);
    const limit = providerLimit(providerId, settings, dir);
    let recordings = activeRecordings;
    if (recordings === undefined) {
        try { recordings = require('./recordingEngine').listActive(); } catch (e) { recordings = []; }
    }
    const held = recordingsInPool(recordings, pool, dir).length;
    const cutoff = (Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC) * 1000;
    const live = streamsInPool(pool, dir).filter(s => !isStale(s, cutoff)).length;
    return live + held < limit;
}

/**
 * What the player should surface, if anything. Polled by a client that is
 * playing; returns null when there is nothing to say.
 *
 * `providerId` (0173): only a prompt for that provider's pool - the one the
 * asking viewer is watching on. Omitted (undefined), any prompt, as before.
 */
function pendingPrompt(settings = {}, providerId = undefined) {
    const leadMs = (Number.isFinite(settings.recordingPromptLeadMin)
        ? settings.recordingPromptLeadMin : DEFAULT_PROMPT_LEAD_MIN) * 60000;
    const now = Date.now();
    const dir = providerId === undefined ? null : providerDirectory();

    for (const [scheduleId, entry] of prompts) {
        if (entry.declinedAt) continue;
        if (dir && poolKey(entry.providerId, dir) !== poolKey(providerId, dir)) continue;
        const s = entry.schedule;
        const startsAt = s.program_start - (s.pre_buffer_min || 0) * 60000;
        if (startsAt - now > leadMs) continue;

        return {
            scheduleId,
            title: s.title,
            channelName: s.channel_name,
            startsAt,
            startsInSec: Math.max(0, Math.round((startsAt - now) / 1000)),
            programEnd: s.program_end,
            message: `"${s.title}" is due to record on ${s.channel_name}. Your provider allows one stream at a time, so recording cannot start until playback stops.`
        };
    }
    return null;
}

function declinePrompt(scheduleId) {
    const entry = prompts.get(Number(scheduleId));
    if (!entry) return false;
    entry.declinedAt = Date.now();
    console.log(`[Coordinator] Viewer declined to release the stream for recording #${scheduleId}`);
    return true;
}

function clearPrompt(scheduleId) {
    prompts.delete(Number(scheduleId));
}

/**
 * Announce a recording so a viewer can be warned before it is due, even though
 * the conflict has not happened yet.
 */
function announceUpcoming(schedule, settings = {}, providerId = undefined) {
    // Only the viewers of the provider the recording will use are warned (0173).
    const dir = providerDirectory();
    const limit = providerLimit(providerId, settings, dir);
    // 0189 / R12: a standby or a warm session is not a viewer to warn; it gives way when the recording starts.
    if (streamsInPool(poolKey(providerId, dir), dir).filter(s => !s.standby && !s.warm).length < limit) return;
    if (prompts.has(schedule.id)) return;
    // dueSince stays null: the answer-timeout (0158) counts from when the recording
    // is actually due and still blocked (requestForRecording, above), not from this
    // early lead-time notice.
    prompts.set(schedule.id, { issuedAt: Date.now(), dueSince: null, declinedAt: null, schedule, providerId: providerId ?? null });
}

/**
 * Who a stream belongs to, as a stable opaque key. A paired device is its own
 * owner (an Apple TV and an iPad on the same account are different viewers); a
 * plain login is owned by the user. Null when the caller is not identified, in
 * which case nothing is ever treated as "yours".
 */
function ownerKey(user) {
    if (!user) return null;
    if (user.deviceId) return `device:${user.deviceId}`;
    if (user.id !== undefined && user.id !== null) return `user:${user.id}`;
    return null;
}

/**
 * Can a viewer start playing now?
 *
 * Returns { allowed, release?, sacrificed?, conflict? }:
 *   release     viewer streams that must be stopped first (the caller does it,
 *               or use admitViewer, which does)
 *   sacrificed  recordings that must be stopped first
 *   conflict    when not allowed, what is in the way, so a client can ask for
 *               confirmation in the user's own words rather than inventing them
 *
 * Nothing is freed unless the provider's connection limit would otherwise be
 * exceeded. Streams are freed in order of how clearly they are not in use:
 * abandoned ones, then this owner's own earlier stream, and only then
 * something somebody else may be watching.
 */
function requestForViewer({ force = false, activeRecordings = [], settings = {}, owner = null, providerId = undefined, adopt = null } = {}) {
    // Everything below is within the pool of the provider asked for (0173): its
    // streams, its recordings, its limit. No providerId is the primary's pool,
    // which with no backup configured is every stream, as before.
    const dir = providerDirectory();
    const pool = poolKey(providerId, dir);
    const limit = providerLimit(providerId, settings, dir);
    const idleMs = (Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC) * 1000;
    // A device watches one thing: once admitted here, its streams on the other
    // providers go too (always none with a single provider).
    const elsewhere = () => ownStreamsElsewhere(owner, providerId, dir).map(s => ({ stream: s, cause: 'replacement' }));
    const recordings = recordingsInPool(activeRecordings, pool, dir);

    // The caller is asking to open one more connection, so count it. A
    // recording holds a connection of its own: its ffmpeg talks to the
    // provider directly and never appears in the viewer registries.
    // Most idle first; a standby (0189) before any of them, and a warm session (R12) before that.
    // `adopt` (R12) is a warm session this very request is about to turn into its viewer
    // session: it already holds the connection the +1 below asks for, so it is not counted.
    const streams = streamsInPool(pool, dir).filter(s => !adopt || s.id !== adopt)
        .sort((a, b) => (b.warm === true) - (a.warm === true) || (b.standby === true) - (a.standby === true) || b.idleMs - a.idleMs);
    let need = streams.length + recordings.length + 1 - limit;
    if (need <= 0) return { allowed: true, release: elsewhere() };

    // Entries are { stream, cause }. The cause does not change what happens to
    // the stream - everything released here is released because somebody else
    // needs the connection - but it says so in the log, which is the difference
    // between "why did my stream stop" being answerable and not.
    const release = [];
    const held = new Set();
    const take = (candidates, cause) => {
        for (const s of candidates) {
            if (need <= 0) break;
            if (held.has(s)) continue;
            held.add(s);
            release.push({ stream: s, cause });
            need--;
        }
    };
    take(streams.filter(s => s.warm), 'warm');
    take(streams.filter(s => s.standby), 'standby');
    take(streams.filter(s => s.idleMs >= idleMs), 'idle');
    take(streams.filter(s => owner && s.owner === owner), 'replacement');
    if (need <= 0) return { allowed: true, release: [...release, ...elsewhere()] };

    const others = streams.filter(s => !held.has(s));
    // Which provider the answer is about, only when there is more than one
    // (additive; the single-provider body is exactly as before).
    const tagged = (conflict) => (dir.multi ? { ...conflict, providerId: poolProviderId(pool, dir) } : conflict);

    if (!force) {
        if (recordings.length > 0) {
            const rec = recordings[0];
            return {
                allowed: false,
                release,
                conflict: tagged({
                    type: 'recording-in-progress',
                    scheduleId: rec.id,
                    title: rec.title,
                    channelName: rec.channel_name,
                    endsAt: rec.program_end + (rec.post_buffer_min || 0) * 60000,
                    message: `"${rec.title}" is recording on ${rec.channel_name}. Your provider allows one stream at a time, so watching now will stop that recording. What has been recorded so far is kept.`
                })
            };
        }
        const other = others[0];
        return {
            allowed: false,
            release,
            conflict: tagged({
                type: 'viewer-in-progress',
                streamId: other.id,
                lastActiveSec: Math.round(other.idleMs / 1000),
                message: `Another device is watching. Your provider allows ${limit === 1 ? 'one stream' : limit + ' streams'} at a time, so watching here will stop it.`
            })
        };
    }

    // Forced: take recordings first (what was captured is kept), then viewers.
    const sacrificed = [];
    for (const r of recordings) {
        if (need <= 0) break;
        sacrificed.push(r.id);
        need--;
    }
    take(others, 'forced-takeover');
    return { allowed: true, release: [...release, ...elsewhere()], sacrificed };
}

/**
 * Would this viewer be admitted on this provider without disturbing anybody - a
 * free connection, an abandoned stream reclaimed, or its own earlier stream
 * replaced - with no 409 and no force? Non-mutating: for walking a channel's
 * providers in order (P6) before admitViewer is called on the one chosen.
 */
function canAdmitWithoutDisturbing({ providerId = undefined, owner = null, settings = {}, activeRecordings = [] } = {}) {
    return requestForViewer({ force: false, providerId, owner, settings, activeRecordings }).allowed === true;
}

/**
 * requestForViewer, plus actually stopping whatever it says must go. Streams
 * are released before the caller starts its own, so the provider never sees
 * two connections from us at once.
 */
async function admitViewer(opts = {}) {
    const verdict = requestForViewer(opts);
    if (verdict.allowed) {
        // R11: the lease on the connection is taken here, in the tick of the decision and before
        // the first release is awaited, so a contender arriving while those finish (or while the
        // caller probes) counts it. Not for an adopted warm session: it holds its own lease.
        if (!opts.adopt) verdict.lease = takeLease(opts.providerId, 'viewer', { owner: opts.owner });
        // A recording that was admitted but has not started yet, and is forced out: it must not
        // start after all (its engine checks the lease), and its count goes with it.
        for (const id of verdict.sacrificed || []) {
            for (const l of leases.values()) if (l.purpose === 'recording' && l.scheduleId === Number(id) && !isBound(l)) releaseLease(l);
        }
        for (const { stream, cause } of verdict.release || []) {
            console.log(`[Coordinator] Releasing ${stream.id} (${cause}, ${idleText(stream)}) to admit a new viewer`);
            // Before the release, while the owner is still known. Everything
            // admitViewer releases is released to admit somebody else - including
            // a stream picked for being idle, because a client paused longer than
            // the idle timeout is exactly the one that would otherwise resume,
            // fail, recover, and take the connection straight back.
            //
            // The releases that must NOT leave a note do not come through here:
            // an explicit DELETE goes to transcodeSession.removeSession, the idle
            // sweep and the stall watchdog end sessions on their own, and a
            // recording reclaims streams via requestForRecording.
            // A warm session or a lease is not a stream anybody could be told was taken over.
            if (!stream.warm && !stream.lease) noteReplaced(stream);
            await releaseStream(stream);
        }
    }
    return verdict;
}

module.exports = {
    activeStreams,
    liveViewers,
    staleStreams,
    releaseStream,
    requestForRecording,
    requestForViewer,
    admitViewer,
    // Leases (R11)
    takeLease,
    tryReserveFree,
    reserveTakingWarm,
    bindLease,
    bindLeaseToRecording,
    releaseLease,
    releaseUnbound,
    convertLease,
    leaseAlive,
    listLeases,
    LEASE_TTL_MS,
    // Provider pools (0173)
    providerLimit,
    hasFreeConnection,
    samePool,
    canAdmitWithoutDisturbing,
    canRecordFreely,
    releaseOwnerElsewhere,
    ownerProvider,
    ownerKey,
    terminalStatus,
    pendingPrompt,
    declinePrompt,
    clearPrompt,
    announceUpcoming,
    DEFAULT_IDLE_TIMEOUT_SEC,
    DEFAULT_PROMPT_LEAD_MIN,
    DEFAULT_PROMPT_TIMEOUT_MIN,
    // Test seam: the prompts map, so a test can move a prompt's `dueSince` into the
    // past instead of actually waiting out recordingPromptTimeoutMin minutes.
    _prompts: prompts,
    _leases: leases
};
