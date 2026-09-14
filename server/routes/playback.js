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

const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDb } = require('../db/sqlite');
const playbackStrategy = require('../services/playbackStrategy');
const xtreamApi = require('../services/xtreamApi');
const passport = require('passport');

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
    if (!source) throw Object.assign(new Error(`Source ${sourceId} not found`), { status: 404 });

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

    if (!item) throw Object.assign(new Error(`Channel ${channelId} not found`), { status: 404 });
    if (item.stream_url) return item.stream_url;

    try {
        const data = JSON.parse(item.data || '{}');
        if (data.url) return data.url;
        if (data.stream_url) return data.stream_url;
    } catch (e) { /* fall through */ }

    throw Object.assign(new Error('Channel has no stream URL'), { status: 422 });
}

/**
 * POST /api/playback/resolve
 *
 * Body: { sourceId, channelId }  or  { url }
 *       capabilities: { hevc, av1, ac3, eac3, flac, hls, fmp4 }
 *       upscale: boolean
 *
 * Returns: { strategy, url, container, reason, info, sessionId? }
 */
router.post('/resolve', optionalAuth, async (req, res) => {
    try {
        const { sourceId, channelId, url: directUrl, capabilities, upscale, force } = req.body || {};

        let url = directUrl;
        if (!url) {
            if (sourceId === undefined || channelId === undefined) {
                return res.status(400).json({ error: 'Provide either url, or sourceId and channelId' });
            }
            url = await streamUrlForChannel(parseInt(sourceId), channelId);
        }

        const settings = await db.settings.get();
        settings.ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

        // The provider may allow only one connection. If a recording is using
        // it, say so and let the caller decide, rather than starting a stream
        // that will fail for reasons the user cannot see.
        const recordingEngine = require('../services/recordingEngine');
        const coordinator = require('../services/streamCoordinator');
        const activeRecordings = recordingEngine.listActive();

        const verdict = coordinator.requestForViewer({
            force: force === true,
            activeRecordings,
            settings
        });

        if (!verdict.allowed) {
            return res.status(409).json({
                error: 'Provider stream is in use',
                conflict: verdict.conflict,
                // The caller repeats the request with force to proceed.
                resolution: 'Repeat this request with "force": true to stop the recording and watch.'
            });
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

        const decision = await playbackStrategy.resolve({
            url,
            capabilities: capabilities || {},
            settings,
            ffprobePath: req.app.locals.ffprobePath,
            upscale: upscale === true
        });

        // Record what was watched, when the caller identified a channel and we
        // know who is asking. Best effort: history is a convenience and must
        // never be the reason playback fails.
        if (sourceId !== undefined && channelId !== undefined && req.user) {
            try {
                const stripped = String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
                const name = getDb().prepare(`
                    SELECT name FROM playlist_items
                    WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
                `).get(parseInt(sourceId), stripped)?.name || null;

                getDb().prepare(`
                    INSERT INTO channel_history (user_id, source_id, channel_item_id, channel_name, watched_at, play_count)
                    VALUES (?, ?, ?, ?, ?, 1)
                    ON CONFLICT(user_id, source_id, channel_item_id) DO UPDATE SET
                        watched_at = excluded.watched_at,
                        channel_name = COALESCE(excluded.channel_name, channel_name),
                        play_count = play_count + 1
                `).run(String(req.user.id), parseInt(sourceId), stripped, name, Date.now());
            } catch (e) {
                console.warn('[Playback] Could not record history:', e.message);
            }
        }

        console.log(`[Playback] ${decision.strategy} — ${decision.reason}`);
        res.json(decision);
    } catch (err) {
        console.error('[Playback] Resolve failed:', err.message);
        res.status(err.status || 500).json({ error: err.message, info: err.info });
    }
});

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
 * DELETE /api/playback/:sessionId
 *
 * Release whatever resolve() started. Clients should call this when they stop
 * playing: every session holds an ffmpeg process and a connection to the
 * provider, which matters when the provider allows only one.
 */
router.delete('/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        if (String(sessionId).startsWith('remux_')) {
            const ok = require('./remux').killRemux(sessionId);
            return res.json({ success: ok });
        }
        const transcodeSession = require('../services/transcodeSession');
        await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
