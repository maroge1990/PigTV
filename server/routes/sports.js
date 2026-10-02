/**
 * Sport (contract C-I). See services/sportsEvents.js for the rules.
 *
 *   GET /api/sports/events?hours=N[&include=all]   (any signed-in user or device, as /api/library; 0148)
 *       -> { now, events: [{ id, kind, title, aliases, league, start, end, live,
 *                            channels: [{ sourceId, id, stableId, name, number, logo, quality }] }] }
 *          on now or starting within N hours (default 6, 1-72; 0153, was 1-24). 0150: kind "event" and
 *          "replay" by default; include=all adds "show" and "placeholder". Events first
 *          (live, then upcoming, each by start), then replays (on now first), then the
 *          rest; channels best first
 *   GET /api/sports/follow           (admin; 0148) -> { keywords }
 *   PUT /api/sports/follow {keywords} (admin; 0148) -> { keywords } (trimmed, de-duplicated, max 100)
 *   GET /api/sports/preview          (admin; 0148)
 *       -> { now, events } for the next 72 hours (0153), every kind, each also with `rule`
 *          ("keyword" | "category" | "sportChannel"), `match` (what matched) and
 *          `kindRule` (why it is that kind, e.g. "placeholder: ends in a bare \":\"")
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
        const include = req.query.include === 'all' ? 'all' : undefined;
        res.json(sportsEvents.eventsFor({ hours: req.query.hours, userId: req.user.id, include, decorateChannels }));
    } catch (err) {
        console.error('[Sports] events failed:', err.message);
        res.status(500).json({ error: 'Could not list the sport events' });
    }
});

router.get('/preview', requireAdmin, (req, res) => {
    try {
        res.json(sportsEvents.eventsFor({ hours: sportsEvents.MAX_HOURS, userId: req.user.id, withRule: true, include: 'all', decorateChannels }));
    } catch (err) {
        console.error('[Sports] preview failed:', err.message);
        res.status(500).json({ error: 'Could not list the sport events' });
    }
});

router.get('/follow', requireAdmin, (req, res) => {
    try {
        // 0185: the leagues the server knows by name, for the Sports tab's list; `fixtures` says
        // whether real kickoff times are fetched for it (ESPN).
        const { LEAGUES } = require('../services/sportsClassify');
        const { ESPN_LEAGUE_PATHS } = require('../services/sportsFixtures');
        const NO_ROSTER = new Set(['F1', 'IPL', 'BBL']); // sessions, or cricket ids with no team list
        const leagues = LEAGUES.map(l => ({ name: l.name, fixtures: Boolean(ESPN_LEAGUE_PATHS[l.name]) || l.name === 'Cricket',
            teams: Boolean(ESPN_LEAGUE_PATHS[l.name]) && !NO_ROSTER.has(l.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ keywords: sportsEvents.getFollow(), leagues });
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

/**
 * GET /api/sports/teams?league=NFL   (admin; 0185) -> { league, teams: ['Arizona Cardinals', ...] }
 * The teams of a league, for the Sports tab's team list. A team is followed as the keyword
 * "<league>: <team>".
 */
router.get('/teams', requireAdmin, async (req, res) => {
    try {
        const league = require('../services/sportsClassify').canonicalLeague(req.query.league);
        if (!league) return res.status(400).json({ error: 'league must be one the server knows (see GET /api/sports/follow)' });
        const roster = await require('../services/sportsFixtures').rosterFor(league);
        const teams = [...new Set(roster.map(t => t.displayName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        res.json({ league, teams });
    } catch (err) {
        console.error('[Sports] teams failed:', err.message);
        res.status(500).json({ error: 'Could not list the teams' });
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
