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
const xtreamApi = require('../services/xtreamApi');
const passport = require('passport');
const { streamAuth } = require('../auth');
const { createLimiter } = require('../services/rateLimit');
const playbackEvents = require('../services/playbackEvents');
const channelHealth = require('../services/channelHealth');

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
// with enforce accepts a bearer header (webapp and native both send one) or a
// ?token=, and rejects a request that has neither. conflict/conflict-decline
// below stay optional - they only read or dismiss a prompt.
const requireToken = streamAuth({ enforce: true });

/**
 * Attach req.user when a token is present, without rejecting requests that
 * have none. Playback resolution itself is not gated — the stream endpoints it
 * returns are already reachable — but knowing the user lets history be
 * recorded.
 */
function optionalAuth(req, res, next) {
    passport.authenticate('jwt', { session: false }, (err, user) => {
        if (user) req.user = user;
        next();
    })(req, res, next);
}

/**
 * Resolve a channel id to its upstream URL.
 *
 * Accepts either the bare item_id or the composite id a client may hold
 * (m3u_<source>_<item>), because both are in circulation.
 */
async function streamUrlForChannel(sourceId, channelId) {
    const source = await db.sources.getById(sourceId);
    // 0118 (C-B): the client may show these, so they use its allowed wording;
    // `detail` keeps what actually went wrong for the log.
    if (!source) throw Object.assign(new Error(FAILURE_TEXT.notInPlaylist()), { status: 404, detail: `Source ${sourceId} not found` });

    if (source.type === 'xtream') {
        const api = xtreamApi.createFromSource(source);
        return api.buildStreamUrl(channelId, 'live', 'ts');
    }

    const raw = String(channelId);
    const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');

    const item = getDb().prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live'
          AND (item_id = ? OR item_id = ? OR id = ?)
        LIMIT 1
    `).get(sourceId, raw, stripped, `${sourceId}:${stripped}`);

    if (!item) throw Object.assign(new Error(FAILURE_TEXT.notInPlaylist()), { status: 404, detail: `Channel ${channelId} not found` });
    if (item.stream_url) return item.stream_url;

    try {
        const data = JSON.parse(item.data || '{}');
        if (data.url) return data.url;
        if (data.stream_url) return data.stream_url;
    } catch (e) { /* fall through */ }

    throw Object.assign(new Error(FAILURE_TEXT.noStreamUrl()), { status: 422, detail: 'Channel has no stream URL' });
}

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
    try {
        const { sourceId, channelId, url: directUrl, capabilities, upscale, force, audioEncode } = req.body || {};

        let url = directUrl;
        if (!url) {
            if (sourceId === undefined || channelId === undefined) {
                return res.status(400).json({ error: 'Provide either url, or sourceId and channelId' });
            }
            url = await streamUrlForChannel(parseInt(sourceId), channelId);
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

        // The tuner model (PIGTV_TUNER=1, 0126): admission is decided per tuner,
        // inside resolveTuned, because a viewer joining a running tuner needs no
        // provider slot at all. Same 409 shapes, same history and logging.
        if (require('../services/tuner').enabled()) {
            const owner = coordinator.ownerKey(req.user);
            const outcome = await playbackStrategy.resolveTuned({
                url,
                capabilities: capabilities || {},
                settings,
                ffprobePath: req.app.locals.ffprobePath,
                upscale: upscale === true,
                audioEncode: audioEncode === true,
                owner,
                live: sourceId !== undefined && channelId !== undefined,
                force: force === true,
                activeRecordings,
                onSacrifice: (scheduleId) => recordingEngine.stopForViewer(scheduleId)
            });
            if (outcome.verdict) return sendConflict(res, outcome.verdict);
            recordHistory(req, sourceId, channelId);
            channelHealth.recordResolve({ sourceId, channelId, ok: true, owner });
            const decision = outcome.decision;
            console.log(`[Playback] ${decision.strategy} — ${decision.reason}`);
            playbackEvents.noteResolve(owner, { channel: eventChannel, strategy: decision.strategy, videoMode: decision.videoMode || null });
            return res.json(decision);
        }

        // Who is asking decides what counts as "somebody else": this device's
        // own earlier stream is simply replaced, an abandoned one is reclaimed,
        // and only a stream someone else may be watching is put to the caller
        // as a question. admitViewer stops whatever has to go before we start.
        const owner = coordinator.ownerKey(req.user);
        const verdict = await coordinator.admitViewer({
            force: force === true,
            activeRecordings,
            settings,
            owner
        });

        if (!verdict.allowed) return sendConflict(res, verdict);

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

        const decision = await playbackStrategy.resolve({
            url,
            capabilities: capabilities || {},
            settings,
            ffprobePath: req.app.locals.ffprobePath,
            upscale: upscale === true,
            audioEncode: audioEncode === true,
            owner,
            // A channel is live TV; a bare url could be anything, so leave it
            // on the longer seekable-session timeout.
            live: sourceId !== undefined && channelId !== undefined
        });

        recordHistory(req, sourceId, channelId);
        // 0133 (C-G): a start the server answered; the client's events may
        // still turn it into a failed start (channelHealth.clientFailed).
        channelHealth.recordResolve({ sourceId, channelId, ok: true, owner });

        console.log(`[Playback] ${decision.strategy} — ${decision.reason}`);
        playbackEvents.noteResolve(owner, { channel: eventChannel, strategy: decision.strategy, videoMode: decision.videoMode || null });
        res.json(decision);
    } catch (err) {
        console.error('[Playback] Resolve failed:', redact(err.detail ? `${err.detail} - ${err.message}` : err.message));
        // 0118 (C-B): never a URL in what the client is sent, whatever the error.
        const safe = clientSafe(redact(err.message));
        playbackEvents.record({ type: 'failure', owner: eventOwner, channel: eventChannel, reason: safe });
        // 0133 (C-G): a failed start, when it names a channel in the playlist.
        channelHealth.recordResolve({ sourceId: req.body?.sourceId, channelId: req.body?.channelId, ok: false, reason: safe, owner: eventOwner });
        res.status(err.status || 500).json({ error: safe, info: err.info });
    }
});

/** The 409 a client repeats with force (the same body for sessions and tuners). */
function sendConflict(res, verdict) {
    const isViewer = verdict.conflict && verdict.conflict.type === 'viewer-in-progress';
    return res.status(409).json({
        error: 'Provider stream is in use',
        conflict: verdict.conflict,
        // The caller repeats the request with force to proceed.
        resolution: isViewer
            ? 'Repeat this request with "force": true to stop the other stream and watch.'
            : 'Repeat this request with "force": true to stop the recording and watch.'
    });
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
router.get('/conflict', optionalAuth, async (req, res) => {
    try {
        const settings = await db.settings.get();
        const coordinator = require('../services/streamCoordinator');
        res.json(coordinator.pendingPrompt(settings) || null);
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
    res.json({ status: coordinator.terminalStatus(req.params.sessionId, owner) });
});

/**
 * POST /api/playback/conflict/decline  { scheduleId }
 *
 * The viewer keeps watching. The recording is not cancelled — it waits, and
 * starts as soon as playback stops. Declining is remembered so the same
 * recording never asks twice.
 */
router.post('/conflict/decline', optionalAuth, (req, res) => {
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
            playbackEvents.record({ type: 'play-start', owner, channel: last.channel, start: last.start,
                strategy: text(body.strategy, 20), videoMode: body.videoMode ? text(body.videoMode, 10) : last.videoMode,
                firstPictureSec: sec(body.totalMs), resolveSec: sec(body.resolveMs) });
            channelHealth.clientStarted(owner, sec(body.totalMs));
        } else {
            console.log(`[Player] play-end via ${how} watched=${num(body.watchedSec)}s stalls=${num(body.stalls)} ${from}`);
            playbackEvents.record({ type: 'play-end', owner, channel: last.channel, strategy: text(body.strategy, 20),
                watchedSec: typeof body.watchedSec === 'number' ? body.watchedSec : null,
                stalls: typeof body.stalls === 'number' ? body.stalls : null });
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
        // A tuner viewer (PIGTV_TUNER=1): only this viewer leaves; the tuner
        // stops with its last viewer and recording.
        const tuner = require('../services/tuner');
        if (tuner.enabled() && await tuner.releaseViewer(sessionId)) return res.json({ success: true });
        const transcodeSession = require('../services/transcodeSession');
        await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Exposed so tests can lower the ceiling.
router.clientEventLimiter = clientEventLimiter;
router.measurementLimiter = measurementLimiter;

module.exports = router;
