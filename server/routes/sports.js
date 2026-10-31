/**
 * Sport (contract C-I). See services/sportsEvents.js for the rules.
 *
 *   GET /api/sports/events?hours=N[&include=all]   (any signed-in user or device, as /api/library; 0148)
 *       -> { now, events: [{ id, kind, title, aliases, league, start, end, live,
 *                            channels: [{ sourceId, id, stableId, name, number, logo, quality, start, end }] }] }
 *          on now or starting within N hours (default 6, 1-72; 0153, was 1-24). 0150: kind "event" and
 *          "replay" by default; include=all adds "show" and "placeholder". Events first
 *          (live, then upcoming, each by start), then replays (on now first), then the
 *          rest; channels best first
 *          Answered from a per-minute cache with an ETag (If-None-Match -> 304); `now` is the minute's start
 *   GET /api/sports/follow           (admin; 0148) -> { keywords }
 *   PUT /api/sports/follow {keywords} (admin; 0148) -> { keywords } (trimmed, de-duplicated, max 100)
 *   GET /api/sports/preview          (admin; 0148)
 *       -> { now, events } for the next 72 hours (0153), every kind, each also with `rule`
 *          ("keyword" | "category" | "sportChannel"), `match` (what matched) and
 *          `kindRule` (why it is that kind, e.g. "placeholder: ends in a bare \":\"")
 *   GET/PUT /api/sports/pages/preferences (any user; 0346) -> { spoilerFree, sports, teams, following: { F1, NFL } }, one for the household
 *   GET /api/sports/front            (any user; 0381, D-39) -> the Sport front page (services/sportFront.js)
 *   GET /api/sports/pages/cricket    (any user; 0383, C-S) -> the Cricket page (services/sportPageCricket.js)
 *   GET /api/sports/pages/league/:league (any user; 0388, C-T) -> any other team league's page (services/sportPageLeague.js)
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

// Opt-in additive dashboard API; the existing /events contract is unchanged.
const dashboard = require('../services/sportsDashboard');
// 0381: these legacy routes stay opt-in (PIGTV_SPORTS_DASHBOARD=1); the collector itself runs by default (front page).
const dashboardEnabled = (req, res, next) => dashboard.dashboardEnabled() ? next() : res.status(404).json({ error: 'Sports dashboard disabled' });
router.get('/preferences', dashboardEnabled, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(dashboard.store().preferences(req.user.id)); }
    catch { res.status(500).json({ error: 'Could not read sports preferences' }); }
});
router.put('/preferences', dashboardEnabled, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(dashboard.store().updatePreferences(req.user.id, req.body)); }
    catch (err) { res.status([400,409].includes(err.status) ? err.status : 500).json({ error: err.status ? err.message : 'Could not save sports preferences' }); }
});
router.get('/dashboard', dashboardEnabled, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const league = req.query.league === undefined ? null : require('../services/sportsClassify').canonicalLeague(req.query.league);
    if (req.query.league !== undefined && !league) return res.status(400).json({ error: 'Unknown sports league' });
    try {
        channelNumbers.ensureChannelNumbers();
        dashboard.store(); // Ensure opt-in tables exist before the read-only worker opens them.
        const now = Date.now();
        const cached = await sportsEvents.eventsResponse({ hours: 72, userId: req.user.id, now, decorateChannels });
        const fixtures = require('../services/sportsFixtures');
        const leagues = fixtures.neededLeagues();
        // #191: a live game's airings that ended within the overrun window (sportOverrun.js) keep its channels.
        const endedEvents = await sportsEvents.endedEvents({ leagues, userId: req.user.id, now, decorateChannels });
        const response = await dashboard.response({ eventsBody: cached.body, options: { now,
            userId: req.user.id, league, timezone: dashboard.timezone(), leagues,
            broadLeagues: fixtures.categoryLeagues(), follow: sportsEvents.getFollow(), endedEvents } });
        applyLogoCache(response.games.flatMap(g => g.competitors));
        res.json(response);
    } catch { res.status(500).json({ error: 'Could not list the sports dashboard' }); }
});

// 0381 (D-39): the Sport front page, from the household's followed sports and teams (sportPagePrefs) and the collector's
// scores. On whenever the collector is (sportsDashboard.collectorEnabled).
router.get('/front', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!dashboard.collectorEnabled()) return res.status(404).json({ error: 'The sport front page is off on this server' });
    try {
        channelNumbers.ensureChannelNumbers();
        const now = Date.now();
        res.json(await require('../services/sportFront').front({ userId: req.user.id, now,
            events: () => sportsEvents.eventsResponse({ hours: 72, userId: req.user.id, now, decorateChannels }),
            // #191: the followed sports' airings that ended within the overrun window (sportOverrun.js)
            ended: (leagues) => sportsEvents.endedEvents({ leagues, userId: req.user.id, now, decorateChannels }) }));
    } catch (err) {
        console.error('[Sports] front page failed:', err.message);
        res.status(500).json({ error: 'Could not build the sport front page' });
    }
});

// Logos as the library hands them out: the EPG's icon when the playlist has none,
// then our cached /api/logo/<key> path. Run once per build of the event list, on the main
// thread (it writes the logo cache) and over the channels the events name, in slices.
function decorateChannels(channels) {
    try {
        require('./library').fillMissingLogos(channels);
        applyLogoCache(channels);
    } catch (err) {
        console.warn('[Sports] logos:', err.message);
    }
}

router.get('/events', async (req, res) => {
    try {
        channelNumbers.ensureChannelNumbers(); // as /api/library (0117)
        const include = req.query.include === 'all' ? 'all' : undefined;
        // The serialised answer, kept per minute (sportsEvents.eventsResponse): a repeat is a buffer
        // send, and the ETag lets a client that sends If-None-Match have a 304. `no-cache` rather
        // than the router's `no-store` so such a client may keep the body to revalidate; one that
        // never asks gets the 200 it always did.
        const r = await sportsEvents.eventsResponse({ hours: req.query.hours, userId: req.user.id, include, decorateChannels });
        res.set({ 'Cache-Control': 'private, no-cache', ETag: r.etag, Vary: 'Accept-Encoding' });
        if (req.fresh) return res.status(304).end();
        res.type('json');
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && r.body.length > 1024) {
            // compressed once per cached answer, not per request (the compression middleware
            // leaves a response that already has a Content-Encoding alone)
            const gz = await r.gzip();
            res.set('Content-Encoding', 'gzip');
            return res.send(gz);
        }
        res.send(r.body);
    } catch (err) {
        console.error('[Sports] events failed:', err.message);
        res.status(500).json({ error: 'Could not list the sport events' });
    }
});

// #21 (0340, C-P): the Formula 1 page. On whenever ESPN fixtures are (PIGTV_SPORT_FIXTURES).
const HOUR_MS = 60 * 60 * 1000;
router.get('/pages/f1', async (req, res) => {
    if (!require('../services/sportsFixtures').enabled()) return res.status(404).json({ error: 'Sport pages are off on this server' });
    try {
        channelNumbers.ensureChannelNumbers();
        const f1 = require('../services/sportPageF1');
        const now = Date.now();
        const page = await f1.page(now, {
            registerImage: require('../services/logoCache').registerLogo,
            // #160: only F1's events around the sessions are ordered and built, not the whole 72 h answer.
            // #191: with the airings ended within the overrun window, which a live session's channels keep (sportOverrun.js).
            channelsFor: async (sessions, observedAt) => !sessions.length ? new Map() : f1.channelsForSessions(sessions,
                await sportsEvents.leagueEvents({ league: 'F1', from: Math.min(...sessions.map(s => s.start)) - HOUR_MS,
                    to: Math.max(...sessions.map(s => s.end)) + HOUR_MS, userId: req.user.id, now, decorateChannels, ended: true }), { now, observedAt })
        });
        res.json(page);
    } catch (err) {
        console.error('[Sports] F1 page failed:', err.message);
        res.status(500).json({ error: 'Could not build the Formula 1 page' });
    }
});

// #21 (0379, C-Q): the NFL page, as the F1 page: on whenever ESPN fixtures are.
router.get('/pages/nfl', async (req, res) => {
    if (!require('../services/sportsFixtures').enabled()) return res.status(404).json({ error: 'Sport pages are off on this server' });
    try {
        channelNumbers.ensureChannelNumbers();
        const nfl = require('../services/sportPageNFL');
        const now = Date.now();
        const page = await nfl.page(now, {
            registerImage: require('../services/logoCache').registerLogo,
            // Only the NFL's events around the two weeks' games are ordered and built, as for F1 (#160); #191 as F1.
            channelsFor: async (games, teams, observedAt) => !games.length ? new Map() : nfl.channelsForGames(games,
                await sportsEvents.leagueEvents({ league: 'NFL', ...nfl.spanOf(games), userId: req.user.id, now, decorateChannels, ended: true }),
                new Map(Object.entries(teams || {})), { now, observedAt })
        });
        res.json(page);
    } catch (err) {
        console.error('[Sports] NFL page failed:', err.message);
        res.status(500).json({ error: 'Could not build the NFL page' });
    }
});

// #21 (0383, C-S): the Cricket page, as the NFL page: on whenever ESPN fixtures are. The lead follows the household's
// followed cricket teams (sportPagePrefs `teams.Cricket`).
router.get('/pages/cricket', async (req, res) => {
    if (!require('../services/sportsFixtures').enabled()) return res.status(404).json({ error: 'Sport pages are off on this server' });
    try {
        channelNumbers.ensureChannelNumbers();
        const cricket = require('../services/sportPageCricket');
        const now = Date.now();
        const page = await cricket.page(now, {
            registerImage: require('../services/logoCache').registerLogo,
            // Only cricket's events around the matches' days are ordered and built, as for F1 (#160), for each league a
            // cricket programme can be filed under; #191 as F1.
            channelsFor: async (airings, observedAt) => cricket.channelsForMatches(airings, (await Promise.all(cricket.LEAGUES.map(league =>
                sportsEvents.leagueEvents({ league, ...cricket.spanOf(airings), userId: req.user.id, now, decorateChannels, ended: true })))).flat(), { now, observedAt })
        });
        res.json(page);
    } catch (err) {
        console.error('[Sports] Cricket page failed:', err.message);
        res.status(500).json({ error: 'Could not build the Cricket page' });
    }
});

// #21 (0388, C-T): the page of any other ESPN team league (sportPageLeague.LEAGUES; /api/info `sportPageLeagues`), as the
// NFL page: on whenever ESPN fixtures are. An unknown league, or one with its own page (F1, NFL, cricket), is a 404.
router.get('/pages/league/:league', async (req, res) => {
    if (!require('../services/sportsFixtures').enabled()) return res.status(404).json({ error: 'Sport pages are off on this server' });
    const leaguePage = require('../services/sportPageLeague');
    const league = leaguePage.leagueOf(req.params.league);
    if (!league) return res.status(404).json({ error: 'No sport page for that league' });
    try {
        channelNumbers.ensureChannelNumbers();
        const now = Date.now();
        const page = await leaguePage.page(league, now, {
            registerImage: require('../services/logoCache').registerLogo,
            followed: () => require('../services/sportPagePrefs').get().teams[league] || [],
            // Only this league's events around the page's games are ordered and built, as for F1 (#160); #191 as F1.
            channelsFor: async (games, observedAt) => !games.length ? new Map() : leaguePage.channelsForGames(games,
                await sportsEvents.leagueEvents({ league, ...leaguePage.spanOf(games), userId: req.user.id, now, decorateChannels, ended: true }), { now, observedAt })
        });
        res.json(page);
    } catch (err) {
        console.error('[Sports] league page failed:', err.message);
        res.status(500).json({ error: 'Could not build the sport page' });
    }
});

// #68, #67 (0346, C-P): the sport pages' spoiler-free switch and followed driver, one for the household.
router.get('/pages/preferences', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').get()); }
    catch { res.status(500).json({ error: 'Could not read the sport page preferences' }); }
});
router.put('/pages/preferences', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').update(req.body)); }
    catch (err) { res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? err.message : 'Could not save the sport page preferences' }); }
});

router.get('/preview', requireAdmin, async (req, res) => {
    try {
        res.json(await sportsEvents.eventsFor({ hours: sportsEvents.MAX_HOURS, userId: req.user.id, withRule: true, include: 'all', decorateChannels }));
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
