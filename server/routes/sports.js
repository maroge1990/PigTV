/**
 * Sport (contract C-I). See services/sportsEvents.js for the rules.
 *
 *   GET /api/sports/events?hours=N   (any signed-in user or device, as /api/library; 0148)
 *       -> { now, events: [{ id, title, league, start, end, live,
 *                            channels: [{ sourceId, id, stableId, name, number, logo, quality }] }] }
 *          events on now or starting within N hours (default 6, 1-24), live first,
 *          then upcoming, each by start; channels best first
 *   GET /api/sports/follow           (admin; 0148) -> { keywords }
 *   PUT /api/sports/follow {keywords} (admin; 0148) -> { keywords } (trimmed, de-duplicated, max 100)
 *   GET /api/sports/preview          (admin; 0148)
 *       -> { now, events } for the next 24 hours, each also with `rule`
 *          ("keyword" | "category" | "sportChannel") and `match` (what matched)
 *   GET /api/sports/categories       (admin; 0147)
 *       -> [{category, programmes}] the EPG categories in the live guide with how
 *          many programmes carry each, most used first, at most 200 (web Status page)
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const sportsEvents = require('../services/sportsEvents');
const { applyLogoCache } = require('../services/logoCache');
const channelNumbers = require('../services/channelNumbers');

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Logos as the library hands them out: the EPG's icon when the playlist has none,
// then our cached /api/logo/<key> path. Run once per build of the event list.
function decorateChannels(channels) {
    try {
        require('./library').fillMissingLogos(channels);
        applyLogoCache(channels);
    } catch (err) {
        console.warn('[Sports] logos:', err.message);
    }
}

router.get('/events', (req, res) => {
    try {
        channelNumbers.ensureChannelNumbers(); // as /api/library (0117)
        res.json(sportsEvents.eventsFor({ hours: req.query.hours, userId: req.user.id, decorateChannels }));
    } catch (err) {
        console.error('[Sports] events failed:', err.message);
        res.status(500).json({ error: 'Could not list the sport events' });
    }
});

router.get('/preview', requireAdmin, (req, res) => {
    try {
        res.json(sportsEvents.eventsFor({ hours: sportsEvents.MAX_HOURS, userId: req.user.id, withRule: true, decorateChannels }));
    } catch (err) {
        console.error('[Sports] preview failed:', err.message);
        res.status(500).json({ error: 'Could not list the sport events' });
    }
});

router.get('/follow', requireAdmin, (req, res) => {
    try {
        res.json({ keywords: sportsEvents.getFollow() });
    } catch (err) {
        console.error('[Sports] follow list failed:', err.message);
        res.status(500).json({ error: 'Could not read the follow list' });
    }
});

router.put('/follow', requireAdmin, (req, res) => {
    const cleaned = sportsEvents.cleanFollow(req.body?.keywords);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });
    try {
        res.json({ keywords: sportsEvents.setFollow(cleaned.keywords) });
    } catch (err) {
        console.error('[Sports] saving the follow list failed:', err.message);
        res.status(500).json({ error: 'Could not save the follow list' });
    }
});

router.get('/categories', requireAdmin, (req, res) => {
    try {
        res.json(sportsEvents.categoryCounts());
    } catch (err) {
        console.error('[Sports] categories failed:', err.message);
        res.status(500).json({ error: 'Could not count the EPG categories' });
    }
});

module.exports = router;
