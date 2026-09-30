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
 * Provider pools (0173, multi-provider P5; default path only - the tuner functions
 * further down are unchanged and keep one global pool). With backup providers
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
//            its way (set inside requestForRecording/requestForRecordingTuned, never
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
        providerId: s.providerId ?? null
    }));
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

function streamsInPool(pool, dir) {
    return activeStreams().filter(s => poolKey(s.providerId, dir) === pool);
}

function recordingsInPool(recordings, pool, dir) {
    return (recordings || []).filter(r => poolKey(recordingProvider(r), dir) === pool);
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
 *   A backup: its effective limit (providerAccounts.effectiveLimit: the manual
 *     `maxConnections` > the account's max_connections > 1).
 *   The primary, with backups configured: its manual `maxConnections` when set
 *     (the admin said so, for this provider); otherwise the larger of its account's
 *     max_connections (or 1) and `settings.maxProviderStreams`, so an admin who had
 *     raised the legacy setting above 1 does not lose connections by adding a backup.
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
    const manual = Number(primary.maxConnections);
    if (Number.isInteger(manual) && manual > 0) return lowestShared(manual);
    return lowestShared(Math.max(accounts.effectiveLimit({ ...primary, maxConnections: null }, account(primary.id)), legacy));
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
    const mine = activeStreams().filter(s => s.owner === owner).sort((a, b) => b.startTime - a.startTime);
    return mine.length ? mine[0].providerId : undefined;
}

/**
 * Streams with someone actually watching, as opposed to registered but stale.
 */
function liveViewers(idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC) {
    const cutoff = idleTimeoutSec * 1000;
    return activeStreams().filter(s => s.idleMs < cutoff);
}

function staleStreams(idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC) {
    const cutoff = idleTimeoutSec * 1000;
    return activeStreams().filter(s => s.idleMs >= cutoff);
}

async function releaseStream(stream) {
    try {
        await transcodeSession.removeSession(stream.id);
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

    // More than one provider connection available? Then there is nothing to
    // arbitrate and everything proceeds as before.
    const limit = providerLimit(providerId, settings, dir);
    const streams = streamsInPool(pool, dir);
    if (streams.length < limit) {
        return { allowed: true, reason: 'A provider connection is free' };
    }

    // Reclaim anything registered but abandoned, without asking: there is
    // nobody to ask.
    const cutoff = idleTimeout * 1000;
    const stale = streams.filter(s => s.idleMs >= cutoff);
    const live = streams.filter(s => s.idleMs < cutoff);

    if (live.length === 0 && stale.length > 0) {
        for (const s of stale) {
            console.log(`[Coordinator] Reclaiming idle stream ${s.id} (${Math.round(s.idleMs / 1000)}s silent) for recording #${schedule.id}`);
            await releaseStream(s);
        }
        prompts.delete(schedule.id);
        return { allowed: true, reason: 'Reclaimed an abandoned stream' };
    }

    if (live.length === 0) {
        return { allowed: true, reason: 'Nothing is using the provider' };
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
            for (const s of live) await releaseStream(s);
            prompts.delete(schedule.id);
            return { allowed: true, reason: 'No answer from the viewer; took the stream' };
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
    const live = streamsInPool(pool, dir).filter(s => s.idleMs < cutoff).length;
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
    if (streamsInPool(poolKey(providerId, dir), dir).length < limit) return;
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
function requestForViewer({ force = false, activeRecordings = [], settings = {}, owner = null, providerId = undefined } = {}) {
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
    const streams = streamsInPool(pool, dir).sort((a, b) => b.idleMs - a.idleMs); // most idle first
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
        for (const { stream, cause } of verdict.release || []) {
            console.log(`[Coordinator] Releasing ${stream.id} (${cause}, ${Math.round(stream.idleMs / 1000)}s idle) to admit a new viewer`);
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
            noteReplaced(stream);
            await releaseStream(stream);
        }
    }
    return verdict;
}

// ---------------------------------------------------------------------------
// The tuner model (PIGTV_TUNER=1, 0126). The provider slot is a TUNER, not a
// viewer session: every viewer of one tuner, and every recording holding it,
// shares its one connection. The same policy as above, applied per tuner:
//   - a tuner ffmpeg has already left (dead) goes first, silently;
//   - then one whose viewers have all been idle >= 60 s (and no recording);
//   - then one only this owner is watching (and no recording);
//   - anything else is a 409: recording-in-progress if a recording holds it,
//     else viewer-in-progress; force stops the recordings (kept, partial) and
//     the viewers. A viewer displaced here gets its terminal-status note.
// A viewer whose arguments match a running tuner joins it: no slot is needed.
// ---------------------------------------------------------------------------

function tunerModule() {
    return require('./tuner');
}

function tunerSlots(now = Date.now()) {
    return tunerModule().list().map(t => ({
        tuner: t,
        id: t.id,
        dead: t.dead === true || t.hasFailed(),
        recordings: t.recordingIds(),
        owners: t.viewerOwners(),
        idleMs: t.viewerIdleMs(now)
    }));
}

/**
 * requestForViewer for the tuner model. `key` is the tuner the caller wants, when
 * known: a running tuner with that key is joined, and nothing is released.
 */
function requestForTuner({ force = false, settings = {}, owner = null, key = null, activeRecordings = [] } = {}) {
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    const idleMs = (Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC) * 1000;

    if (key && tunerModule().findByKey(key)) return { allowed: true, release: [], join: true };

    const slots = tunerSlots().sort((a, b) => b.idleMs - a.idleMs); // most idle first
    let need = slots.length + 1 - limit;
    if (need <= 0) return { allowed: true, release: [] };

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
    const free = slots.filter(s => s.recordings.length === 0);
    // A tuner whose ffmpeg has ended serves nobody, even one a recording has not
    // let go of yet (it takes the channel up again on its next tick).
    take(slots.filter(s => s.dead), 'ended');
    take(free.filter(s => s.idleMs >= idleMs), 'idle');
    take(free.filter(s => owner && s.owners.length > 0 && s.owners.every(o => o === owner)), 'replacement');
    if (need <= 0) return { allowed: true, release };

    const others = slots.filter(s => !held.has(s));
    const recordingSlots = others.filter(s => s.recordings.length > 0);

    if (!force) {
        if (recordingSlots.length > 0) {
            const scheduleId = recordingSlots[0].recordings[0];
            const rec = activeRecordings.find(r => Number(r.id) === scheduleId)
                || (() => { try { return require('../db/recordingsDb').scheduled.getById(scheduleId); } catch (e) { return null; } })()
                || { id: scheduleId, title: 'A recording', channel_name: 'this channel', program_end: Date.now(), post_buffer_min: 0 };
            return {
                allowed: false,
                release,
                conflict: {
                    type: 'recording-in-progress',
                    scheduleId: rec.id,
                    title: rec.title,
                    channelName: rec.channel_name,
                    endsAt: rec.program_end + (rec.post_buffer_min || 0) * 60000,
                    message: `"${rec.title}" is recording on ${rec.channel_name}. Your provider allows one stream at a time, so watching now will stop that recording. What has been recorded so far is kept.`
                }
            };
        }
        const other = others[0];
        const viewerId = other.tuner.viewers.values().next().value || other.id;
        return {
            allowed: false,
            release,
            conflict: {
                type: 'viewer-in-progress',
                streamId: viewerId,
                lastActiveSec: Number.isFinite(other.idleMs) ? Math.round(other.idleMs / 1000) : 0,
                message: `Another device is watching. Your provider allows ${limit === 1 ? 'one stream' : limit + ' streams'} at a time, so watching here will stop it.`
            }
        };
    }

    // Forced: recordings' tuners first (what was captured is kept), then viewers'.
    const sacrificed = [];
    for (const s of recordingSlots) {
        if (need <= 0) break;
        held.add(s);
        sacrificed.push(...s.recordings);
        release.push({ stream: s, cause: 'forced-takeover' });
        need--;
    }
    take(others, 'forced-takeover');
    return { allowed: true, release, sacrificed };
}

/**
 * requestForTuner, plus stopping whatever it says must go. `onSacrifice(scheduleId)`
 * finalises a recording (recordingEngine.stopForViewer) before its tuner stops.
 */
async function admitTuner(opts = {}) {
    const verdict = requestForTuner(opts);
    if (!verdict.allowed) return verdict;
    const tuner = tunerModule();
    for (const { stream, cause } of verdict.release || []) {
        const t = stream.tuner;
        console.log(`[Coordinator] Releasing tuner ${t.id} (${cause}, ${Number.isFinite(stream.idleMs) ? Math.round(stream.idleMs / 1000) + 's idle' : 'no viewers'}) to admit a new viewer`);
        for (const scheduleId of stream.recordings) {
            if (typeof opts.onSacrifice === 'function') {
                try { await opts.onSacrifice(scheduleId); } catch (err) {
                    console.error('[Coordinator] Could not stop recording for viewer:', err.message);
                }
            }
        }
        // As admitViewer: every viewer displaced to admit somebody else may learn
        // so - except from a tuner whose ffmpeg had already ended, which nobody took.
        if (cause !== 'ended') {
            for (const id of t.viewers) {
                const v = tuner.getViewer(id);
                if (v) noteReplaced({ id: v.id, owner: v.owner });
            }
        }
        await tuner.destroyTuner(t, `released: ${cause}`);
    }
    return verdict;
}

/**
 * requestForRecording for the tuner model: a tuner already on the channel is
 * shared (no slot, no question); otherwise the viewers' tuners are what a
 * recording may have to wait for, exactly as viewer sessions were. Tuners held
 * by other recordings are not counted, as recordings were not before.
 */
async function requestForRecordingTuned(schedule, settings, url) {
    const tuner = tunerModule();
    if (url && tuner.findByUrl(url)) {
        prompts.delete(schedule.id);
        return { allowed: true, shared: true, reason: 'Sharing the tuner already on this channel' };
    }
    const idleTimeout = Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC;
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    const viewerSlots = tunerSlots().filter(s => s.recordings.length === 0);
    if (viewerSlots.length < limit) return { allowed: true, reason: 'A provider connection is free' };

    const cutoff = idleTimeout * 1000;
    const stale = viewerSlots.filter(s => s.dead || s.idleMs >= cutoff);
    const live = viewerSlots.filter(s => !(s.dead || s.idleMs >= cutoff));
    if (live.length === 0 && stale.length > 0) {
        for (const s of stale) {
            console.log(`[Coordinator] Reclaiming idle tuner ${s.id} for recording #${schedule.id}`);
            await tuner.destroyTuner(s.tuner, 'reclaimed for a recording');
        }
        prompts.delete(schedule.id);
        return { allowed: true, reason: 'Reclaimed an abandoned stream' };
    }
    if (live.length === 0) return { allowed: true, reason: 'Nothing is using the provider' };

    // As requestForRecording (0158): ask once, then take the stream if nobody has
    // answered within recordingPromptTimeoutMin minutes of the recording becoming
    // due (dueSince), unless the viewer explicitly declined (keeps waiting).
    const now = Date.now();
    const existing = prompts.get(schedule.id);
    if (!existing) {
        prompts.set(schedule.id, { issuedAt: now, dueSince: now, declinedAt: null, schedule });
        console.log(`[Coordinator] Recording #${schedule.id} is waiting for the stream; asking the viewer`);
        return { allowed: false, prompted: true, reason: 'Waiting for the viewer to stop playback' };
    }
    if (!existing.dueSince) existing.dueSince = now;

    if (!existing.declinedAt) {
        const timeoutMs = (Number.isFinite(settings.recordingPromptTimeoutMin)
            ? settings.recordingPromptTimeoutMin : DEFAULT_PROMPT_TIMEOUT_MIN) * 60000;
        if (now - existing.dueSince >= timeoutMs) {
            console.log(`[Coordinator] No answer from the viewer in ${Math.round(timeoutMs / 60000)} min; recording #${schedule.id} takes the stream`);
            for (const s of live) await tuner.destroyTuner(s.tuner, 'no answer from the viewer; a recording needs the stream');
            prompts.delete(schedule.id);
            return { allowed: true, reason: 'No answer from the viewer; took the stream' };
        }
    }
    return { allowed: false, prompted: false, reason: 'Viewer declined; waiting for playback to stop' };
}

/** announceUpcoming for the tuner model: no warning when the recording will share a tuner. */
function announceUpcomingTuned(schedule, settings = {}, url = null) {
    const tuner = tunerModule();
    if (url && tuner.findByUrl(url)) return;
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    if (tunerSlots().filter(s => s.recordings.length === 0).length < limit) return;
    if (prompts.has(schedule.id)) return;
    // dueSince stays null here too: see the `prompts` comment near the top of this file.
    prompts.set(schedule.id, { issuedAt: Date.now(), dueSince: null, declinedAt: null, schedule });
}

module.exports = {
    requestForTuner,
    admitTuner,
    requestForRecordingTuned,
    announceUpcomingTuned,
    activeStreams,
    liveViewers,
    staleStreams,
    releaseStream,
    requestForRecording,
    requestForViewer,
    admitViewer,
    // Provider pools (0173)
    providerLimit,
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
    _prompts: prompts
};
