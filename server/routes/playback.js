/**
 * Playback API
 *
 * The entry point a client uses to play something. It asks "here is a channel
 * and here is what I can decode", and gets back a URL it can hand straight to
 * its player, plus a note of what was decided and why.
 *
 * Clients should not need to know that remuxing or transcoding exist. Keeping
 * that decision here means one implementation rather than one per platform,
 * and a fix reaches every client at once.
 */

const { isStreamUrl, NOT_A_STREAM_URL } = require('../services/streamUrl');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDb } = require('../db/sqlite');
const { redact } = require('../redact');
const { MESSAGES: FAILURE_TEXT, clientSafe } = require('../services/playbackErrors');
const playbackStrategy = require('../services/playbackStrategy');
const { streamAuth } = require('../auth');
const { createLimiter } = require('../services/rateLimit');
const playbackEvents = require('../services/playbackEvents');
const channelHealth = require('../services/channelHealth');

// 0180: the newest resolve per owner. A play that finds a newer one from the same
// owner has been superseded (the viewer zapped on): it starts no further candidate.
const ownerGeneration = new Map();
function bumpOwnerGeneration(owner) {
    if (!owner) return 0;
    const n = (ownerGeneration.get(owner) || 0) + 1;
    ownerGeneration.set(owner, n);
    return n;
}
function isSuperseded(owner, generation) {
    return !!owner && ownerGeneration.get(owner) !== generation;
}

/** A channel's name for the status page's recent plays (0124); null when unknown. */
function channelNameFor(sourceId, channelId) {
    if (sourceId === undefined || channelId === undefined) return null;
    try {
        const stripped = String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
        return getDb().prepare(`
            SELECT name FROM playlist_items WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
        `).get(parseInt(sourceId), stripped)?.name || null;
    } catch (e) {
        return null;
    }
}

// P0-3: resolve spends the provider's single upstream slot and starts ffmpeg;
// the delete can kill anyone's session. Both must carry a token. streamAuth
// accepts a bearer header (webapp and native both send one) or a ?token=, and
// rejects a request that has neither. R01: so do /conflict and
// /conflict/decline - both clients always send a token, and without one anyone
// on the network could read a viewer's recording prompt or dismiss it for them.
const requireToken = streamAuth;

// Resolving a channel to its stream (and, from 0174, to the providers that carry
// it) lives in services/providerRouting.js.
const providerRouting = require('../services/providerRouting');

/**
 * POST /api/playback/resolve
 *
 * Body: { sourceId, channelId }  or  { url }
 *       capabilities: { hevc, av1, ac3, eac3, flac, heaac, hls, fmp4 }
 *       upscale: boolean
 *
 * Returns: { strategy, url, container, reason, info, sessionId? }
 */
router.post('/resolve', requireToken, async (req, res) => {
    // 0124: for the status page's recent plays (a name, never a URL)
    const eventOwner = require('../services/streamCoordinator').ownerKey(req.user);
    const eventChannel = channelNameFor(req.body?.sourceId, req.body?.channelId);
    // 0174: the provider of the last candidate tried, for a failure's event and health row.
    let lastTried = null;
    try {
        const { sourceId, channelId, url: directUrl, capabilities, upscale, force, audioEncode } = req.body || {};

        let url = directUrl;
        // 0174: a channel play has an ordered list of providers to try (primary,
        // sibling, backups).
        let routing = null;
        if (!url) {
            if (sourceId === undefined || channelId === undefined) {
                return res.status(400).json({ error: 'Provide either url, or sourceId and channelId' });
            }
            routing = await providerRouting.plan(parseInt(sourceId), channelId);
            url = routing.candidates[0].url;
        }
        if (url && !isStreamUrl(url)) {
            return res.status(400).json({ error: NOT_A_STREAM_URL });
        }

        // A copy: db.settings.get() hands out one shared, frozen object (0135).
        const settings = { ...(await db.settings.get()), ffmpegPath: req.app.locals.ffmpegPath || 'ffmpeg' };

        // The provider may allow only one connection. If a recording is using
        // it, say so and let the caller decide, rather than starting a stream
        // that will fail for reasons the user cannot see.
        const recordingEngine = require('../services/recordingEngine');
        const coordinator = require('../services/streamCoordinator');
        const activeRecordings = recordingEngine.listActive();

        // Who is asking decides what counts as "somebody else": this device's
        // own earlier stream is simply replaced, an abandoned one is reclaimed,
        // and only a stream someone else may be watching is put to the caller
        // as a question. admitViewer stops whatever has to go before we start.
        const owner = coordinator.ownerKey(req.user);
        const generation = bumpOwnerGeneration(owner);

        // Whose connection this play takes (0173): the candidate's provider. A bare
        // url names none (null), which counts in the primary's pool.
        const candidates = routing ? routing.candidates : [{ providerId: null, url }];
        // 0174: with somewhere to fail over to, the whole resolve has a deadline
        // (the Apple client gives up at 35 s). With one candidate, as before.
        const failoverPossible = candidates.length > 1;
        const deadlineAt = failoverPossible ? Date.now() + providerRouting.DEADLINE_MS : null;
        const showProvider = !!routing && (routing.backupsConfigured || failoverPossible);
        const live = sourceId !== undefined && channelId !== undefined;

        // Start one candidate: probe, session, first segment. Throws what resolve throws.
        const start = (candidate, index, lease) => {
            const isLast = index === candidates.length - 1;
            lastTried = candidate;
            return playbackStrategy.resolve({
                url: candidate.url,
                capabilities: capabilities || {},
                settings,
                ffprobePath: req.app.locals.ffprobePath,
                upscale: upscale === true,
                audioEncode: audioEncode === true,
                owner,
                // A channel is live TV; a bare url could be anything, so leave it
                // on the longer seekable-session timeout.
                live,
                providerId: candidate.providerId,
                // R11: the connection lease taken when this candidate was admitted.
                lease,
                // 0174: only the last candidate gets 0143's two refused-connection
                // retries; an earlier one gets one, after 1 s, then the next provider.
                ...(failoverPossible ? {
                    refusedRetryDelaysMs: isLast ? undefined : providerRouting.EARLY_RETRY_DELAYS_MS,
                    // An earlier one must leave the next time for a cold start.
                    deadlineAt: isLast ? deadlineAt
                        : Math.max(deadlineAt - providerRouting.NEXT_RESERVE_MS, Math.min(deadlineAt, Date.now() + providerRouting.MIN_START_MS))
                } : {}),
                ...(showProvider ? { timingNote: `, provider ${candidate.providerName} (${candidate.via})` } : {})
            });
        };

        // Walk the candidates: the first that can be admitted without disturbing
        // anybody (a free connection, an idle one reclaimed, this device's own
        // stream replaced) is started; a start that fails for a provider reason
        // is noted (breaker, quarantine) and the next is tried.
        let decision = null;
        let chosen = null;
        let failedOver = false;
        let lastError = null;
        // The client hung up while we were busy: nobody is left to start a stream for. The
        // newer-request check below is the same "do not start any further" answer (R11).
        const clientGone = () => !!(res.socket && res.socket.destroyed);

        // R12: this owner warmed this very channel earlier and the session is still running (and
        // is not needed by anybody else): it becomes the viewer's session, with no new start.
        // Otherwise a warm session for something else ends first.
        const warming = require('../services/channelWarming');
        const warmKey = routing && live ? warming.keyFor({ sourceId, channelId, capabilities, upscale, audioEncode }) : null;
        if (warmKey) {
            const entry = await warming.forResolve(owner, warmKey, settings);
            if (entry && warming.claim(owner)) {
                const verdict = await coordinator.admitViewer({ force: false, activeRecordings, settings, owner, providerId: entry.candidate.providerId, adopt: entry.sessionId });
                const adopted = verdict.allowed ? warming.adopt(owner) : null;
                if (adopted) {
                    const { candidate: warmCandidate, ...warmDecision } = adopted;
                    decision = warmDecision;
                    chosen = warmCandidate;
                } else {
                    warming.unclaim(owner);
                }
            }
        }

        for (let i = 0; !decision && i < candidates.length; i++) {
            const candidate = candidates[i];
            // 0180: the owner's newer request took over while this one was walking.
            if (isSuperseded(owner, generation)) throw playbackStrategy.supersededError();
            if (lastError && deadlineAt && deadlineAt - Date.now() < providerRouting.MIN_START_MS) {
                console.warn(`[Playback] failover: stopped after ${lastTried.providerName}: less than ${providerRouting.MIN_START_MS / 1000}s left of the resolve`);
                break;
            }
            const ask = { force: false, activeRecordings, settings, owner, providerId: candidate.providerId };
            if (!coordinator.canAdmitWithoutDisturbing(ask)) continue;
            const verdict = await coordinator.admitViewer(ask);
            if (!verdict.allowed) continue;
            // R11: the lease is released on every way out that leaves no session to count:
            // a probe that failed (and the failover to the next candidate), a start overtaken
            // by the viewer's next play, the client gone, a direct play. Once the session exists
            // the lease is bound to it and releaseUnbound leaves it alone.
            const lease = verdict.lease;
            try {
                if (clientGone()) throw playbackStrategy.supersededError();
                decision = await start(candidate, i, lease);
                chosen = candidate;
                break;
            } catch (err) {
                // 0180: stopped on request (or overtaken), not a provider failure: nothing
                // is noted and no later candidate is started.
                if (err.superseded || !routing || !providerRouting.isProviderFailure(err)) throw err;
                lastError = err;
                failedOver = true;
                providerRouting.noteFailure(candidate, routing.primaryKey);
                const next = candidates.slice(i + 1)[0];
                if (failoverPossible) console.warn(`[Playback] failover: ${candidate.providerName} (${candidate.via}) failed for "${eventChannel || routing.channelName || 'channel'}"` +
                    ` - ${clientSafe(redact(err.message)).split('. ')[0]}; ${next ? `trying ${next.providerName} (${next.via})` : 'no provider left'}`);
            } finally {
                coordinator.releaseUnbound(lease);
            }
        }

        if (!decision) {
            // Every candidate that could be admitted failed: say why (the last reason).
            if (lastError) throw lastError;

            // None could be admitted without disturbing somebody: today's 409, for the
            // first candidate; `force` acts on that candidate's provider only.
            const first = candidates[0];
            const verdict = await coordinator.admitViewer({
                force: force === true,
                activeRecordings,
                settings,
                owner,
                providerId: first.providerId
            });
            if (!verdict.allowed) {
                return sendConflict(res, verdict, { everyProvider: !!routing && routing.providerCount > 1 });
            }

            if (verdict.sacrificed && verdict.sacrificed.length) {
                // Finalise rather than discard: what was captured is kept, and the
                // recording is marked partial so the list explains itself.
                for (const scheduleId of verdict.sacrificed) {
                    try {
                        await recordingEngine.stopForViewer(scheduleId);
                    } catch (err) {
                        console.error('[Playback] Could not stop recording for viewer:', err.message);
                    }
                }
            }
            // Forced onto the first candidate: nothing else to fall to, so it is
            // started as the last one (the full retries).
            lastTried = first;
            try {
                if (clientGone()) throw playbackStrategy.supersededError();
                decision = await playbackStrategy.resolve({
                    url: first.url,
                    capabilities: capabilities || {},
                    settings,
                    ffprobePath: req.app.locals.ffprobePath,
                    upscale: upscale === true,
                    audioEncode: audioEncode === true,
                    owner,
                    live,
                    providerId: first.providerId,
                    lease: verdict.lease,
                    ...(failoverPossible ? { deadlineAt } : {}),
                    ...(showProvider ? { timingNote: `, provider ${first.providerName} (${first.via})` } : {})
                });
            } catch (err) {
                if (!err.superseded && routing && providerRouting.isProviderFailure(err)) providerRouting.noteFailure(first, routing.primaryKey);
                throw err;
            } finally {
                coordinator.releaseUnbound(verdict.lease);
            }
            chosen = first;
        }

        if (routing) {
            providerRouting.noteSuccess(chosen);
            const session = decision.sessionId ? require('../services/transcodeSession').getSession(decision.sessionId) : null;
            providerRouting.watchSession(session, chosen, routing.primaryKey, eventChannel || routing.channelName);
            // C-J: which provider this play is on, and whether it got there by failing over.
            decision = {
                ...decision,
                provider: {
                    id: chosen.providerId,
                    name: chosen.providerName,
                    role: chosen.role,
                    via: chosen.via,
                    failover: failedOver || routing.primarySkipped
                }
            };
            if (failedOver || routing.primarySkipped) {
                console.log(`[Playback] failover: "${eventChannel || routing.channelName || 'channel'}" plays on ${chosen.providerName} (${chosen.via})` +
                    `${routing.primarySkipped ? ' - primary skipped (down, expired or quarantined for this channel)' : ''}`);
            }
        }

        // 0188: the baseline for recovery work. This resolve closes the viewer's open loss of
        // this channel, if any; and a loss of the session it started is recorded when it happens.
        {
            const interruptions = require('../services/playbackInterruptions');
            const channelLabel = eventChannel || (routing && routing.channelName) || null;
            const providerLabel = chosen ? chosen.providerName : null;
            interruptions.noteResolved({ owner, channel: channelLabel, provider: providerLabel });
            const played = decision.sessionId ? require('../services/transcodeSession').getSession(decision.sessionId) : null;
            // 0190: the Status page names the stream by this.
            if (played && played.options && channelLabel) played.options.channelName = channelLabel;
            if (played && typeof played.once === 'function') {
                played.once('lost', ({ how, providerReason } = {}) => interruptions.noteLost({
                    owner, channel: channelLabel, provider: providerLabel, how, providerReason,
                    reason: how === 'stall' ? 'stalled' : how === 'timestamps' ? 'timestamps' : 'lost',
                    playedSec: played.startTime ? (Date.now() - played.startTime) / 1000 : null
                }));
                // 0191: a blank or placeholder picture marks this attempt's health row
                // (providerRouting.watchSession quarantines the channel on the provider).
                played.once('blank', () => channelHealth.sessionBlank(owner));
                // 0189 (relayEnabled): keep this stream going across a lost provider. A
                // channel play only; off, adopt() does nothing.
                if (routing && live) {
                    require('../services/streamRelay').adopt(played, {
                        sourceId: parseInt(sourceId), channelId, capabilities: capabilities || {}, settings,
                        ffprobePath: req.app.locals.ffprobePath, upscale: upscale === true, audioEncode: audioEncode === true,
                        owner, channelName: channelLabel, primaryKey: routing.primaryKey, candidate: chosen
                    });
                }
            }
        }

        // R12: what this owner is watching now, so a warm request for it is ignored.
        if (warmKey && decision.sessionId) warming.noteWatching(owner, warmKey, decision.sessionId);

        recordHistory(req, sourceId, channelId);
        // 0133 (C-G): a start the server answered; the client's events may
        // still turn it into a failed start (channelHealth.clientFailed).
        // 0174: the primary identity's health, whichever provider served it.
        channelHealth.recordResolve({ sourceId, channelId, ok: true, owner, providerId: chosen.providerId });

        console.log(`[Playback] ${decision.strategy} — ${decision.reason}${decision.warm ? ' (warm: adopted a session started ahead)' : ''}`);
        playbackEvents.noteResolve(owner, { channel: eventChannel, strategy: decision.strategy, videoMode: decision.videoMode || null,
            provider: showProvider ? chosen.providerName : null });
        res.json(decision);
    } catch (err) {
        // 0180: a start overtaken by the same viewer's next play. Not a failure: no
        // failure event, no channel-health row, nothing for the breaker. 499 is used
        // because no client reads it as a provider error or a prompt (409 is the
        // conflict prompt); the web player ignores it and the Apple client has moved on.
        if (err.superseded) {
            return res.status(499).json({ error: playbackStrategy.SUPERSEDED_MESSAGE, superseded: true });
        }
        console.error('[Playback] Resolve failed:', redact(err.detail ? `${err.detail} - ${err.message}` : err.message));
        // 0118 (C-B): never a URL in what the client is sent, whatever the error.
        const safe = clientSafe(redact(err.message));
        const provider = lastTried && lastTried.providerName ? lastTried.providerName : null;
        playbackEvents.record({ type: 'failure', owner: eventOwner, channel: eventChannel, reason: safe, provider });
        // 0133 (C-G): a failed start, when it names a channel in the playlist.
        channelHealth.recordResolve({ sourceId: req.body?.sourceId, channelId: req.body?.channelId, ok: false, reason: safe, owner: eventOwner,
            providerId: lastTried ? lastTried.providerId : null });
        res.status(err.status || 500).json({ error: safe, info: err.info });
    }
});

/**
 * POST /api/playback/warm
 *
 * Body: the same as resolve for a channel - { sourceId, channelId, capabilities, upscale?, audioEncode? }.
 *
 * A client that can guess the channel its viewer will play next asks for it to be started ahead,
 * so a following resolve finds the session already running (R12; services/channelWarming.js).
 * Only ever on a provider connection nobody is using: nothing is reclaimed and nobody is asked.
 *
 *   204  nothing was warmed (the warmNextChannel setting is off, the
 *        owner is already watching that channel, no connection is free, or the start failed)
 *   200  { warm: true, ttlSec, refreshed }: a warm session for this channel exists and
 *        lives ttlSec more seconds (refreshed: it was already warm and its time was extended)
 *   400  no sourceId/channelId
 */
router.post('/warm', requireToken, async (req, res) => {
    try {
        const { sourceId, channelId, capabilities, upscale, audioEncode } = req.body || {};
        if (sourceId === undefined || channelId === undefined) {
            return res.status(400).json({ error: 'Provide sourceId and channelId' });
        }
        const settings = { ...(await db.settings.get()), ffmpegPath: req.app.locals.ffmpegPath || 'ffmpeg' };
        const warming = require('../services/channelWarming');
        if (!warming.enabled(settings)) return res.status(204).end();
        const owner = require('../services/streamCoordinator').ownerKey(req.user);
        const result = await warming.warm({
            owner, sourceId, channelId, capabilities: capabilities || {}, upscale: upscale === true, audioEncode: audioEncode === true,
            settings, ffprobePath: req.app.locals.ffprobePath
        });
        if (!result) return res.status(204).end();
        res.json({ warm: true, ttlSec: result.ttlSec, refreshed: result.refreshed });
    } catch (err) {
        // A guess must never be the reason anything fails: say nothing was done.
        console.warn('[Warm] request failed:', redact(err && err.message));
        if (!res.headersSent) res.status(204).end();
    }
});

/** The 409 a client repeats with force. */
function sendConflict(res, verdict, { everyProvider = false } = {}) {
    const isViewer = verdict.conflict && verdict.conflict.type === 'viewer-in-progress';
    // 0174: when more than one provider carries the channel and all were full, the
    // message says so; the shape is unchanged (C-B/C-E).
    const conflict = everyProvider && verdict.conflict
        ? { ...verdict.conflict, message: everyProviderMessage(verdict.conflict) }
        : verdict.conflict;
    return res.status(409).json({
        error: 'Provider stream is in use',
        conflict,
        // The caller repeats the request with force to proceed.
        resolution: isViewer
            ? 'Repeat this request with "force": true to stop the other stream and watch.'
            : 'Repeat this request with "force": true to stop the recording and watch.'
    });
}

function everyProviderMessage(conflict) {
    if (conflict.type === 'recording-in-progress') {
        return `Every provider that carries this channel is in use. "${conflict.title}" is recording on ${conflict.channelName}, so watching now will stop that recording. What has been recorded so far is kept.`;
    }
    return 'Every provider that carries this channel is in use. Watching here will stop another device\'s stream.';
}

/**
 * Record what was watched, when the caller identified a channel and we
 * know who is asking. Best effort: history is a convenience and must
 * never be the reason playback fails.
 */
function recordHistory(req, sourceId, channelId) {
    if (sourceId !== undefined && channelId !== undefined && req.user) {
        try {
            const stripped = String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
            // Name and identity from the same lookup: the identity is what makes
            // the row survive the provider reordering its playlist.
            const row = getDb().prepare(`
                SELECT name, stable_id FROM playlist_items
                WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
            `).get(parseInt(sourceId), stripped);
            const name = row?.name || null;

            getDb().prepare(`
                INSERT INTO channel_history (user_id, source_id, channel_item_id, channel_name, watched_at, play_count, stable_id)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(user_id, source_id, channel_item_id) DO UPDATE SET
                    watched_at = excluded.watched_at,
                    channel_name = COALESCE(excluded.channel_name, channel_name),
                    play_count = play_count + 1,
                    -- Refreshed on every play: a row written before the channel
                    -- moved must not keep pointing at where it used to be.
                    stable_id = COALESCE(excluded.stable_id, stable_id)
            `).run(String(req.user.id), parseInt(sourceId), stripped, name, Date.now(), row?.stable_id || null);
        } catch (e) {
            console.warn('[Playback] Could not record history:', e.message);
        }
    }
}

/**
 * GET /api/playback/conflict
 *
 * What a playing client should surface, if anything. Polled during playback;
 * returns null when there is nothing to say. Keeping this separate from
 * resolve means a client can be told about an approaching recording without
 * having to ask to play something first.
 */
router.get('/conflict', requireToken, async (req, res) => {
    try {
        const settings = await db.settings.get();
        const coordinator = require('../services/streamCoordinator');
        // 0173: a viewer is asked only about a recording that needs the provider
        // it is watching on. Not watching anything (or not identified): as before.
        const providerId = coordinator.ownerProvider(coordinator.ownerKey(req.user));
        res.json(coordinator.pendingPrompt(settings, providerId) || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/playback/:sessionId/terminal-status
 *
 * "Did my stream stop because someone else took it, or did it just break?"
 *
 * A displaced client only sees a 404 on its playlist or segments, which looks
 * exactly like an expired session or a stalled feed. If it recovers from that
 * by re-resolving, it takes the provider's only connection back off whoever
 * just got it, and the two trade the stream back and forth - and owner equality
 * cannot stop that, because two browsers signed in as the same person are both
 * `user:<id>`.
 *
 * So: `taken-over` means stop and say so; `none` means recover as before.
 *
 * Bearer auth, not the optional auth `/conflict` uses: the answer is about the
 * caller's own session and is worthless without knowing who is asking. Every
 * case that is not "your session, replaced by another viewer, recently" is
 * `none`, including somebody else's session and one that never existed, so a
 * caller cannot use this to discover that anyone is watching anything.
 */
router.get('/:sessionId/terminal-status', requireToken, (req, res) => {
    const coordinator = require('../services/streamCoordinator');
    const owner = coordinator.ownerKey(req.user);
    // 0189: a relay's stream is known to the coordinator by its playing leg's id.
    const playingId = require('../services/streamRelay').playingSessionId(req.params.sessionId);
    res.json({ status: coordinator.terminalStatus(playingId, owner) });
});

/**
 * POST /api/playback/conflict/decline  { scheduleId }
 *
 * The viewer keeps watching. The recording is not cancelled — it waits, and
 * starts as soon as playback stops. Declining is remembered so the same
 * recording never asks twice.
 */
router.post('/conflict/decline', requireToken, (req, res) => {
    try {
        const { scheduleId } = req.body || {};
        if (scheduleId === undefined) return res.status(400).json({ error: 'scheduleId is required' });
        const coordinator = require('../services/streamCoordinator');
        res.json({ success: coordinator.declinePrompt(scheduleId) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/playback/client-event
 *
 * A client reporting something it saw that the server cannot: today, the web
 * player's <video> element failing to play a stream. Written to the server log
 * so the reason sits next to the ffmpeg lines from the same moment in `docker
 * logs`, rather than only in a browser console.
 *
 * Diagnostics only: whitelisted fields, bounded, no URLs, rate limited, and it
 * never affects playback.
 */
const clientEventLimiter = createLimiter({ windowMs: 60 * 1000, max: 30 });
// Measurement events (play-start / play-end) have their own budget: two per channel
// change is a lot of traffic when someone is flicking through channels, and it must
// never use up the allowance that media-error and start-timeout reports depend on.
const measurementLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });

router.post('/client-event', requireToken, (req, res) => {
    const key = req.socket?.remoteAddress || 'unknown';
    const body = req.body || {};
    const isMeasurement = body.event === 'play-start' || body.event === 'play-end';
    const limiter = isMeasurement ? measurementLimiter : clientEventLimiter;
    if (limiter.check(key).blocked) return res.status(204).end(); // drop quietly
    limiter.record(key);
    if (!isMeasurement && body.event !== 'media-error' && body.event !== 'start-timeout') return res.status(400).json({ error: 'Unknown event' });

    const coordinator = require('../services/streamCoordinator');
    const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '?');

    if (isMeasurement) {
        // Informational, not a fault: plain log, one greppable line.
        //   docker logs pigtv | grep -E "play-start|play-end"
        const secs = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : '?');
        const how = `${text(body.strategy, 20)}(${text(body.container, 12) || '-'}` +
            `${body.videoMode ? `, video ${text(body.videoMode, 10)}` : ''}) hls-delivery=${body.hlsDelivery === true ? 'on' : 'off'}`;
        const from = `from=${coordinator.ownerKey(req.user) || 'unknown'}`;
        // 0124: the status page's recent plays; the channel is what this owner last resolved.
        const owner = coordinator.ownerKey(req.user);
        const last = playbackEvents.lastResolveFor(owner) || {};
        const sec = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 100) / 10 : null);
        if (body.event === 'play-start') {
            console.log(`[Player] play-start via ${how} resolve=${secs(body.resolveMs)} first-picture=${secs(body.totalMs)} ${from}`);
            playbackEvents.record({ type: 'play-start', owner, channel: last.channel, start: last.start, provider: last.provider,
                strategy: text(body.strategy, 20), videoMode: body.videoMode ? text(body.videoMode, 10) : last.videoMode,
                firstPictureSec: sec(body.totalMs), resolveSec: sec(body.resolveMs) });
            channelHealth.clientStarted(owner, sec(body.totalMs));
        } else {
            console.log(`[Player] play-end via ${how} watched=${num(body.watchedSec)}s stalls=${num(body.stalls)} ${from}`);
            playbackEvents.record({ type: 'play-end', owner, channel: last.channel, provider: last.provider, strategy: text(body.strategy, 20),
                watchedSec: typeof body.watchedSec === 'number' ? body.watchedSec : null,
                stalls: typeof body.stalls === 'number' ? body.stalls : null });
            // 0142: the stalls count towards the channel's health.
            channelHealth.clientEnded(owner, body.watchedSec, body.stalls);
        }
        return res.status(204).end();
    }

    const state = `networkState=${num(body.networkState)} readyState=${num(body.readyState)} ` +
        `t=${num(body.currentTime)}s buffered=${num(body.bufferedEnd)}s from=${coordinator.ownerKey(req.user) || 'unknown'}`;

    const eventOwner = coordinator.ownerKey(req.user);
    const lastChannel = (playbackEvents.lastResolveFor(eventOwner) || {}).channel;
    // 0133 (C-G): before any play-start, this is the owner's last start failing.
    channelHealth.clientFailed(eventOwner);
    if (body.event === 'start-timeout') {
        // Nothing played for `waited` seconds and there was no error to report.
        console.warn(`[Player] start-timeout via ${text(body.strategy, 20)} path=${text(body.path, 80)} waited=${num(body.waitedSec)}s ${state}`);
        playbackEvents.record({ type: 'failure', owner: eventOwner, channel: lastChannel, strategy: text(body.strategy, 20),
            reason: `Nothing played after ${num(body.waitedSec)}s (start-timeout)` });
    } else {
        playbackEvents.record({ type: 'failure', owner: eventOwner, channel: lastChannel, strategy: text(body.strategy, 20),
            reason: `Player media error ${text(body.codeName, 30)} (${num(body.code)})` });
        console.warn(
            `[Player] media-error ${text(body.codeName, 30)}(${num(body.code)}) via ${text(body.strategy, 20)} ` +
            `path=${text(body.path, 80)} msg="${redact(text(body.message, 200))}" ${state}`
        );
    }
    res.status(204).end();
});

/**
 * DELETE /api/playback/:sessionId
 *
 * Release whatever resolve() started. Clients should call this when they stop
 * playing: every session holds an ffmpeg process and a connection to the
 * provider, which matters when the provider allows only one.
 */
router.delete('/:sessionId', requireToken, async (req, res) => {
    const { sessionId } = req.params;
    try {
        const transcodeSession = require('../services/transcodeSession');
        // 0189: a relay ends with every leg it has; else the one session.
        if (!(await require('../services/streamRelay').close(sessionId))) await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Exposed so tests can lower the ceiling.
router.clientEventLimiter = clientEventLimiter;
router.measurementLimiter = measurementLimiter;

module.exports = router;
