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
 */

const transcodeSession = require('./transcodeSession');

// A session that has not asked for a segment in this long is assumed dead.
// Transcode sessions are polled continuously by a playing client, so silence
// is meaningful rather than merely quiet.
const DEFAULT_IDLE_TIMEOUT_SEC = 60;

// How far ahead of a recording the viewer is asked to give up the stream.
const DEFAULT_PROMPT_LEAD_MIN = 5;

// Prompts already issued, by schedule id. Cleared when the schedule resolves.
const prompts = new Map(); // scheduleId -> { issuedAt, declinedAt, schedule }

function activeStreams() {
    const sessions = transcodeSession.getAllSessions().map(s => ({
        id: s.id,
        type: 'transcode',
        url: s.url,
        idleMs: s.idleMs,
        startTime: s.startTime,
        owner: s.owner || null
    }));

    let remuxes = [];
    try {
        remuxes = require('../routes/remux').listActiveRemuxes().map(r => ({
            id: r.id,
            type: 'remux',
            url: r.url,
            // Time since media last flowed to the client, so a remux the
            // client has stopped reading goes stale like an HLS session
            // nobody is fetching from.
            idleMs: r.idleMs,
            startTime: r.startTime,
            owner: r.owner || null
        }));
    } catch (err) {
        console.warn('[Coordinator] Could not list remux streams:', err.message);
    }

    return [...sessions, ...remuxes];
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
        if (stream.type === 'remux') {
            require('../routes/remux').killRemux(stream.id);
        } else {
            await transcodeSession.removeSession(stream.id);
        }
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
async function requestForRecording(schedule, settings = {}) {
    const idleTimeout = Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC;

    // More than one provider connection available? Then there is nothing to
    // arbitrate and everything proceeds as before.
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    const streams = activeStreams();
    if (streams.length < limit) {
        return { allowed: true, reason: 'A provider connection is free' };
    }

    // Reclaim anything registered but abandoned, without asking: there is
    // nobody to ask.
    const stale = staleStreams(idleTimeout);
    const live = liveViewers(idleTimeout);

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

    // Somebody is watching. Ask once; after that, wait quietly.
    const existing = prompts.get(schedule.id);
    if (!existing) {
        prompts.set(schedule.id, { issuedAt: Date.now(), declinedAt: null, schedule });
        console.log(`[Coordinator] Recording #${schedule.id} is waiting for the stream; asking the viewer`);
        return { allowed: false, prompted: true, reason: 'Waiting for the viewer to stop playback' };
    }

    return { allowed: false, prompted: false, reason: 'Viewer declined; waiting for playback to stop' };
}

/**
 * What the player should surface, if anything. Polled by a client that is
 * playing; returns null when there is nothing to say.
 */
function pendingPrompt(settings = {}) {
    const leadMs = (Number.isFinite(settings.recordingPromptLeadMin)
        ? settings.recordingPromptLeadMin : DEFAULT_PROMPT_LEAD_MIN) * 60000;
    const now = Date.now();

    for (const [scheduleId, entry] of prompts) {
        if (entry.declinedAt) continue;
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
function announceUpcoming(schedule, settings = {}) {
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    if (activeStreams().length < limit) return;
    if (prompts.has(schedule.id)) return;
    prompts.set(schedule.id, { issuedAt: Date.now(), declinedAt: null, schedule });
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
 *
 * soft: for entry points whose clients cannot answer a 409 (the web app's
 * direct remux and session calls). They reclaim what is clearly free and then
 * proceed exactly as they always have.
 */
function requestForViewer({ force = false, activeRecordings = [], settings = {}, owner = null, soft = false } = {}) {
    const limit = Number.isFinite(settings.maxProviderStreams) ? settings.maxProviderStreams : 1;
    const idleMs = (Number.isFinite(settings.viewerIdleTimeoutSec)
        ? settings.viewerIdleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC) * 1000;

    // The caller is asking to open one more connection, so count it. A
    // recording holds a connection of its own: its ffmpeg talks to the
    // provider directly and never appears in the viewer registries.
    const streams = activeStreams().sort((a, b) => b.idleMs - a.idleMs); // most idle first
    let need = streams.length + activeRecordings.length + 1 - limit;
    if (need <= 0) return { allowed: true, release: [] };

    const release = [];
    const take = (candidates) => {
        for (const s of candidates) {
            if (need <= 0) break;
            if (release.includes(s)) continue;
            release.push(s);
            need--;
        }
    };
    take(streams.filter(s => s.idleMs >= idleMs));
    take(streams.filter(s => owner && s.owner === owner));
    if (need <= 0) return { allowed: true, release };

    if (soft) return { allowed: true, release };

    const others = streams.filter(s => !release.includes(s));

    if (!force) {
        if (activeRecordings.length > 0) {
            const rec = activeRecordings[0];
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
        return {
            allowed: false,
            release,
            conflict: {
                type: 'viewer-in-progress',
                streamId: other.id,
                lastActiveSec: Math.round(other.idleMs / 1000),
                message: `Another device is watching. Your provider allows ${limit === 1 ? 'one stream' : limit + ' streams'} at a time, so watching here will stop it.`
            }
        };
    }

    // Forced: take recordings first (what was captured is kept), then viewers.
    const sacrificed = [];
    for (const r of activeRecordings) {
        if (need <= 0) break;
        sacrificed.push(r.id);
        need--;
    }
    take(others);
    return { allowed: true, release, sacrificed };
}

/**
 * requestForViewer, plus actually stopping whatever it says must go. Streams
 * are released before the caller starts its own, so the provider never sees
 * two connections from us at once.
 */
async function admitViewer(opts = {}) {
    const verdict = requestForViewer(opts);
    if (verdict.allowed) {
        for (const s of verdict.release || []) {
            console.log(`[Coordinator] Releasing ${s.id} (${Math.round(s.idleMs / 1000)}s idle) to admit a new viewer`);
            await releaseStream(s);
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
    ownerKey,
    pendingPrompt,
    declinePrompt,
    clearPrompt,
    announceUpcoming,
    DEFAULT_IDLE_TIMEOUT_SEC,
    DEFAULT_PROMPT_LEAD_MIN
};
