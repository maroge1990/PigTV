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
 *   GET /api/sports/follow           (admin; 0148) -> { keywords, leagues }: since D-42 (0394) the leagues accounts follow, read-only
 *   GET /api/sports/preview          (admin; 0148)
 *       -> { now, events } for the next 72 hours (0153), every kind, each also with `rule`
 *          ("keyword" | "category" | "sportChannel"), `match` (what matched) and
 *          `kindRule` (why it is that kind, e.g. "placeholder: ends in a bare \":\"")
 *   GET/PUT /api/sports/pages/preferences (any user; 0346) -> { spoilerFree, sports, teams, following: { F1, NFL } }, the
 *       account's own since 0391 (#193; the household's before)
 *   GET/PUT /api/sports/follows      (any user; 0391, C-U) -> { spoilerFree, sports: [{ sport, leagues, teams }] }, the account's
 *   GET /api/sports/catalog          (any user; 0391, C-U) -> { sports: [{ sport, leagues: [{ league, label, heading }] }] } what can be followed
 *   GET /api/sports/front            (any user; 0381, D-39) -> the Sport front page (services/sportFront.js)
 *   GET /api/sports/pages/cricket    (any user; 0383, C-S) -> the Cricket page (services/sportPageCricket.js)
 *   GET /api/sports/pages/league/:league (any user; 0388, C-T) -> any other team league's page (services/sportPageLeague.js)
 *   GET /api/sports/pages/events?league=L (any user; 0428, C-V) -> a tennis, golf, UFC, IndyCar or NASCAR league's week (services/sportPageEvents.js)
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
// 0446 (#49, Codex Apple batch 6): the front page applies each account's score delay, and it runs by default, so its
// preferences are open whenever the collector is (or the dashboard flag), not only with PIGTV_SPORTS_DASHBOARD=1.
// #238: the pages that show live scores keep the score collector at its 30 s pace for 5 minutes (sportsDashboard.noteLook).
const SCORE_PAGE = /^\/(front|dashboard|pages\/(?!preferences$)[^/]+(\/[^/]+)?)$/;
router.use((req, res, next) => {
    if (req.method === 'GET' && SCORE_PAGE.test(req.path)) { try { dashboard.noteLook(); } catch { /* never fails a page */ } }
    // #272: the events list keeps the event-list rebuild and the fixture refresh running for 5 minutes, not the score collector
    else if (req.method === 'GET' && req.path === '/events') { try { require('../services/sportDemand').noteAsk(); } catch { /* never fails a page */ } }
    next();
});
const preferencesEnabled = (req, res, next) => dashboard.collectorEnabled() || dashboard.dashboardEnabled() ? next()
    : res.status(404).json({ error: 'Sports dashboard disabled' });
router.get('/preferences', preferencesEnabled, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(dashboard.store().preferences(req.user.id)); }
    catch { res.status(500).json({ error: 'Could not read sports preferences' }); }
});
router.put('/preferences', preferencesEnabled, (req, res) => {
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
// scores. 0503 (D-54): served with the collector off too, then without game cards (sportFront.front).
router.get('/front', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        channelNumbers.ensureChannelNumbers();
        const now = Date.now();
        res.json(await require('../services/sportFront').front({ userId: req.user.id, now,
            // 0459: as far ahead as the guide runs, so a followed game days away shows its channels (cards stay 72 h)
            events: () => sportsEvents.eventsResponse({ reach: true, userId: req.user.id, now, decorateChannels }),
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

// #272 (D-3): the five sport pages share one handler shape. 404 when ESPN fixtures are off; `prepare(req, res)` (optional)
// validates the request before anything is built and either answers it itself (returns false) or returns what the
// handler needs; the channel numbers are ensured unless `channelNumbers: false`; the handler returns the page, which
// goes out as JSON; any throw is logged and answered 500 with the page's own message.
function pageRoute({ name, error, channelNumbers: ensureNumbers = true, prepare }, handler) {
    return async (req, res) => {
        if (!require('../services/sportsFixtures').enabled()) return res.status(404).json({ error: 'Sport pages are off on this server' });
        let ctx;
        if (prepare) { ctx = prepare(req, res); if (ctx === false) return undefined; }
        try {
            if (ensureNumbers) channelNumbers.ensureChannelNumbers();
            return res.json(await handler(req, ctx));
        } catch (err) {
            console.error(`[Sports] ${name} page failed:`, err.message);
            return res.status(500).json({ error });
        }
    };
}

// #21 (0340, C-P): the Formula 1 page. On whenever ESPN fixtures are (PIGTV_SPORT_FIXTURES).
const HOUR_MS = 60 * 60 * 1000;
router.get('/pages/f1', pageRoute({ name: 'F1', error: 'Could not build the Formula 1 page' }, async (req) => {
    const f1 = require('../services/sportPageF1');
    const now = Date.now();
    return f1.page(now, {
        registerImage: require('../services/logoCache').registerLogo,
        // #160: only F1's events around the sessions are ordered and built, not the whole 72 h answer.
        // #191: with the airings ended within the overrun window, which a live session's channels keep (sportOverrun.js).
        channelsFor: async (sessions, observedAt) => !sessions.length ? new Map() : f1.channelsForSessions(sessions,
            await sportsEvents.leagueEvents({ league: 'F1', from: Math.min(...sessions.map(s => s.start)) - HOUR_MS,
                to: Math.max(...sessions.map(s => s.end)) + HOUR_MS, userId: req.user.id, now, decorateChannels, ended: true }), { now, observedAt })
    });
}));

// #21 (0379, C-Q): the NFL page, as the F1 page: on whenever ESPN fixtures are.
router.get('/pages/nfl', pageRoute({ name: 'NFL', error: 'Could not build the NFL page' }, async (req) => {
    const nfl = require('../services/sportPageNFL');
    const now = Date.now();
    return nfl.page(now, {
        registerImage: require('../services/logoCache').registerLogo,
        // Only the NFL's events around the two weeks' games are ordered and built, as for F1 (#160); #191 as F1.
        channelsFor: async (games, teams, observedAt) => !games.length ? new Map() : nfl.channelsForGames(games,
            await sportsEvents.leagueEvents({ league: 'NFL', ...nfl.spanOf(games), userId: req.user.id, now, decorateChannels, ended: true }),
            new Map(Object.entries(teams || {})), { now, observedAt })
    });
}));

// #21 (0383, C-S): the Cricket page, as the NFL page: on whenever ESPN fixtures are. The lead follows the household's
// followed cricket teams (sportPagePrefs `teams.Cricket`).
router.get('/pages/cricket', pageRoute({ name: 'Cricket', error: 'Could not build the Cricket page' }, async (req) => {
    const cricket = require('../services/sportPageCricket');
    const cricketFollow = require('../services/sportPagePrefs').follows(req.user.id).sports.find(s => s.sport === 'Cricket');
    const now = Date.now();
    return cricket.page(now, {
        // The Cricket sport's names, whichever of its leagues are followed (0393, Codex round 1), and those leagues (#195).
        followed: cricketFollow?.teams || [],
        leagues: cricketFollow?.leagues || [],
        registerImage: require('../services/logoCache').registerLogo,
        // Only cricket's events around the matches' days are ordered and built, as for F1 (#160), for each league a
        // cricket programme can be filed under; #191 as F1.
        channelsFor: async (airings, observedAt) => cricket.channelsForMatches(airings, (await Promise.all(cricket.LEAGUES.map(league =>
            sportsEvents.leagueEvents({ league, ...cricket.spanOf(airings), userId: req.user.id, now, decorateChannels, ended: true })))).flat(), { now, observedAt })
    });
}));

// #21 (0388, C-T): the page of any other ESPN team league (sportPageLeague.LEAGUES; /api/info `sportPageLeagues`), as the
// NFL page: on whenever ESPN fixtures are. An unknown league, or one with its own page (F1, NFL, cricket), is a 404.
router.get('/pages/league/:league', pageRoute({ name: 'league', error: 'Could not build the sport page',
    prepare: (req, res) => {
        const league = require('../services/sportPageLeague').leagueOf(req.params.league);
        if (!league) { res.status(404).json({ error: 'No sport page for that league' }); return false; }
        return league;
    } }, async (req, league) => {
    const leaguePage = require('../services/sportPageLeague');
    const now = Date.now();
    return leaguePage.page(league, now, {
        registerImage: require('../services/logoCache').registerLogo,
        followed: () => require('../services/sportPagePrefs').get(req.user.id).teams[league] || [],
        // Only this league's events around the page's games are ordered and built, as for F1 (#160); #191 as F1.
        channelsFor: async (games, observedAt) => !games.length ? new Map() : leaguePage.channelsForGames(games,
            await sportsEvents.leagueEvents({ league, ...leaguePage.spanOf(games), userId: req.user.id, now, decorateChannels, ended: true }), { now, observedAt })
    });
}));

// 0428 (C-V, #197, D-43): this week's events of a tennis, golf, UFC, IndyCar or NASCAR league, as the other pages: on
// whenever ESPN fixtures are. `followed` names come from the account's follows in the league's sport (C-U). Unlike the
// others it has no channels to number and a bad league is a 400.
router.get('/pages/events', pageRoute({ name: 'events', error: 'Could not build the sport page', channelNumbers: false,
    prepare: (req, res) => {
        const events = require('../services/sportPageEvents');
        const league = events.leagueOf(req.query.league);
        if (!league) { res.status(400).json({ error: `league must be one of: ${events.LEAGUES.join(', ')}` }); return false; }
        return league;
    } }, async (req, league) => {
    const sport = require('../services/sportCatalog').sportOf(league);
    const names = require('../services/sportPagePrefs').follows(req.user.id).sports.find(s => s.sport === sport)?.teams || [];
    return require('../services/sportPageEvents').page(league, Date.now(), { names });
}));

// #68, #67 (0346, C-P): the sport pages' spoiler-free switch and followed names; the account's own since 0391 (#193, D-41).
router.get('/pages/preferences', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').get(req.user.id)); }
    catch { res.status(500).json({ error: 'Could not read the sport page preferences' }); }
});
router.put('/pages/preferences', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').update(req.user.id, req.body)); }
    catch (err) { res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? err.message : 'Could not save the sport page preferences' }); }
});

// #193 (0391, C-U, D-41): what this account follows, sport by sport, and what can be followed.
router.get('/follows', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').follows(req.user.id)); }
    catch { res.status(500).json({ error: 'Could not read what you follow' }); }
});
router.put('/follows', (req, res) => {
    try { res.json(require('../services/sportPagePrefs').setFollows(req.user.id, req.body)); }
    catch (err) { res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? err.message : 'Could not save what you follow' }); }
});
// 0420 (0419 Codex round 1, medium): a league's roster is asked of ESPN once at a time, and an empty or failed answer is not
// asked again for ROSTER_RETRY (rosterFor keeps only a roster that has teams).
const ROSTER_RETRY = 60 * 60 * 1000;
const rosterAsks = new Map(); // league -> { at, pending }
async function rosterOnce(league, now = Date.now()) {
    const fixtures = require('../services/sportsFixtures');
    const kept = fixtures.teamsOf(league);
    if (kept.length) return kept;
    const ask = rosterAsks.get(league);
    if (ask?.pending) return ask.pending;
    if (ask && now - ask.at < ROSTER_RETRY) return [];
    const pending = fixtures.rosterFor(league).catch(() => []).finally(() => { rosterAsks.set(league, { at: Date.now(), pending: null }); });
    rosterAsks.set(league, { at: now, pending });
    return pending;
}
router._rosterAsks = rosterAsks; // tests

// #199 (C-U): the names that can be followed in one league, for Settings › Sport's search: its teams (ESPN's roster, read
// once and kept; the International groups' stored roster) and whoever the collector's cards list (feed leagues' sides,
// players, fighters and drivers). { league, kind: 'team'|'person', names } in name order.
router.get('/names', async (req, res) => {
    try {
        const catalog = require('../services/sportCatalog');
        const league = typeof req.query.league === 'string' ? req.query.league : '';
        const sport = catalog.sportOf(league);
        if (!sport) return res.status(400).json({ error: 'league must be a catalogue league (GET /api/sports/catalog)' });
        const fixtures = require('../services/sportsFixtures');
        const names = new Set();
        const roster = fixtures.ESPN_LEAGUE_PATHS[league] && !catalog.isCricket(league) ? await rosterOnce(league) : fixtures.teamsOf(league);
        for (const t of roster) if (t?.displayName) names.add(t.displayName);
        // #202: F1's whole grid from its page (kept there; fetched once if cold), not only the drivers the collected
        // sessions list (a session before it runs lists none).
        if (league === 'F1' && fixtures.enabled()) {
            try {
                const page = await require('../services/sportPageF1').page(Date.now(), { registerImage: require('../services/logoCache').registerLogo });
                for (const d of page.drivers || []) if (d?.name) names.add(d.name);
            } catch (err) { console.warn('[Sports] F1 grid for the names:', err.message); }
        }
        for (const g of require('../services/sportsDashboard').store().catalog()) {
            if (g.league !== league) continue;
            for (const c of g.competitors || []) if (c.name) names.add(c.name);
            for (const p of g.players || []) names.add(p);
        }
        res.json({ league, kind: catalog.followsOf(sport), names: [...names].filter(n => n && n !== 'TBD').sort((a, b) => a.localeCompare(b)).slice(0, 2000) });
    } catch (err) {
        console.error('[Sports] names failed:', err.message);
        res.status(500).json({ error: 'Could not list the names' });
    }
});

// #198 (D-41 point 2): the other competitions this account's followed teams play in, and "No thanks".
router.get('/suggestions', async (req, res) => {
    try { res.json({ suggestions: await require('../services/sportSuggestions').suggestions(req.user.id) }); }
    catch (err) { console.error('[Sports] suggestions failed:', err.message); res.status(500).json({ error: 'Could not read the suggestions' }); }
});
router.post('/suggestions/decline', (req, res) => {
    try { require('../services/sportSuggestions').decline(req.user.id, req.body || {}); res.json({ success: true }); }
    catch (err) { res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? err.message : 'Could not save that' }); }
});
router.get('/catalog', (req, res) => {
    res.json({ sports: require('../services/sportCatalog').publicCatalog() });
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
        const leagues = LEAGUES.map(l => ({ name: l.name, fixtures: Boolean(ESPN_LEAGUE_PATHS[l.name]) || require('../services/sportCatalog').CRICKET_GROUPS.includes(l.name),
            teams: Boolean(ESPN_LEAGUE_PATHS[l.name]) && !NO_ROSTER.has(l.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ keywords: sportsEvents.getFollow(), leagues });
    } catch (err) {
        console.error('[Sports] follow list failed:', err.message);
        res.status(500).json({ error: 'Could not read the follow list' });
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
