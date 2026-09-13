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
        const { sourceId, channelId, url: directUrl, capabilities, upscale } = req.body || {};

        let url = directUrl;
        if (!url) {
            if (sourceId === undefined || channelId === undefined) {
                return res.status(400).json({ error: 'Provide either url, or sourceId and channelId' });
            }
            url = await streamUrlForChannel(parseInt(sourceId), channelId);
        }

        const settings = await db.settings.get();
        settings.ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

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
