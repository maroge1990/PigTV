/**
 * 0381 (D-39): the Sport front page's answer (GET /api/sports/front; the "Blend 1" mock-up). Built on the dashboard's
 * projection (sportsDashboard.buildDashboard, on its worker) for the account's followed sports, leagues and teams
 * (sportPagePrefs; the household's before 0391), then arranged here into what the page draws:
 *
 *   sports  one row per followed sport, in the household's order: how many are live, the next start, and `line`
 *           ('live' | 'next' | 'quiet'; the client words and formats it)
 *   follows one per followed team or driver: live now, next, or nothing (`state`), with the card it points at
 *   hero    the one card the page leads with (rule below); stickiness and the long-press override are the client's
 *   rails   per followed league, leagues with a game on now first (D-41), then the account's order; card ids: live first
 *           (earliest start), then today's finals (latest first), then the rest
 *   games   every card once, each with `followed`; the other parts point at their ids
 *
 * Hero, first match wins: a followed card live now ('follow-live'); a live card in the highest-ranked followed sport
 * ('league-live'); the followed card that starts first ('follow-next'); else 'none'. Between live cards, the one closest
 * to finishing wins (D-39, C-R; finishEstimate).
 *
 * #194 (D-41): every card is a fixture's game. The guide only adds channels to one; it never makes a card of its own.
 */
const ONGOING = new Set(['live', 'break', 'suspended']);
const byStart = (a, b) => a.start - b.start || a.id.localeCompare(b.id);
const HOUR = 3600000;
const FOOTBALL = new Set(require('./sportCatalog').sport('Football').leagues);
const TYPICAL_HOURS = { F1: 2, NFL: 3.25, NBA: 2.5, AFL: 3, MLB: 3.25 };
const CRICKET_HOURS = { t20: 4.5, odi: 9, test: 120, 'first-class': 120 };

/** When a card should end: its own `end`, else its start plus the league's typical length (0382). */
function finishEstimate(card) {
    if (Number.isFinite(card.end)) return card.end;
    const hours = require('./sportCatalog').isCricket(card.league) ? CRICKET_HOURS[card.format] || 12
        : FOOTBALL.has(card.league) ? 2 : TYPICAL_HOURS[card.league] || 3;
    return card.start + hours * HOUR;
}
const byFinish = (a, b) => finishEstimate(a) - finishEstimate(b) || byStart(a, b);

function emptyFront({ now, timezone, spoilerFree }) {
    return { now, timezone, spoilerFree, scores: 'unavailable', sports: [], follows: [],
        hero: { reason: 'none', followIndex: null, gameId: null }, rails: [], games: [] };
}

/**
 * Arrange a dashboard answer (built with the front page's options) for an account's follows (sportPagePrefs.follows:
 * `{ spoilerFree, sports: [{ sport, leagues, teams }] }`). Pure. #193 (D-41): a sport's followed name is one follow
 * however many of its leagues it plays in; tiles and rails stay one per league, each naming its `sport`.
 */
function arrange(response, prefs) {
    const order = prefs.sports.flatMap(s => s.leagues);
    const sportOf = new Map(prefs.sports.flatMap(s => s.leagues.map(l => [l, s.sport])));
    const matches = response.followMatches || {};
    const games = response.games.filter(g => order.includes(g.league));
    const scores = games.some(g => g.freshness === 'fresh') ? 'fresh' : games.length ? 'stale' : 'unavailable';
    const inLeague = league => games.filter(g => g.league === league);
    const firstScheduled = list => list.filter(g => g.status === 'scheduled').sort(byStart)[0] || null;

    const sports = order.map(league => {
        const list = inLeague(league);
        const live = list.filter(g => ONGOING.has(g.status)).length;
        const nextCard = firstScheduled(list);
        const next = nextCard ? { gameId: nextCard.id, start: nextCard.start } : null;
        return { league, sport: sportOf.get(league), live, next, line: live ? 'live' : next ? 'next' : 'quiet' };
    });

    const follows = [], followed = [];
    for (const { sport, leagues, teams } of prefs.sports) for (const name of teams) {
        const cards = games.filter(g => leagues.includes(g.league) && (matches[g.id] || []).some(m => m.name === name));
        const pick = cards.filter(g => ONGOING.has(g.status)).sort(byFinish)[0] || firstScheduled(cards);
        const logoOf = card => {
            const index = (matches[card.id] || []).find(m => m.name === name)?.competitor;
            return Number.isInteger(index) ? card.competitors[index]?.logo || null : null;
        };
        const league = pick?.league ?? leagues[0];
        const logo = league === 'F1' ? null : (pick && logoOf(pick)) || cards.map(logoOf).find(Boolean) || null;
        follows.push({ league, sport, name, logo, state: !pick ? 'none' : ONGOING.has(pick.status) ? 'live' : 'next',
            gameId: pick?.id ?? null, start: pick?.start ?? null });
        followed.push(new Set(cards.map(g => g.id)));
    }
    const followIndexOf = card => { const i = followed.findIndex(ids => ids.has(card.id)); return i >= 0 ? i : null; };

    let hero = { reason: 'none', followIndex: null, gameId: null };
    const followLive = games.filter(g => g.followed && ONGOING.has(g.status)).sort(byFinish)[0];
    const leagueLive = order.map(l => inLeague(l).filter(g => ONGOING.has(g.status)).sort(byFinish)[0]).find(Boolean);
    const followNext = games.filter(g => g.followed && g.status === 'scheduled').sort(byStart)[0];
    if (followLive) hero = { reason: 'follow-live', followIndex: followIndexOf(followLive), gameId: followLive.id };
    else if (leagueLive) hero = { reason: 'league-live', followIndex: null, gameId: leagueLive.id };
    else if (followNext) hero = { reason: 'follow-next', followIndex: followIndexOf(followNext), gameId: followNext.id };

    const rank = g => ONGOING.has(g.status) ? 0 : g.status === 'finished' ? 1 : 2;
    // #193 (D-41 point 10): a league with a game on now moves above the rest until it ends; otherwise the account's order.
    const liveFirst = [...order.filter(l => inLeague(l).some(g => ONGOING.has(g.status))), ...order.filter(l => !inLeague(l).some(g => ONGOING.has(g.status)))];
    const rails = liveFirst.map(league => ({ league, sport: sportOf.get(league), gameIds: inLeague(league).sort((a, b) => rank(a) - rank(b) ||
        (rank(a) === 1 ? (b.end ?? b.start) - (a.end ?? a.start) || a.id.localeCompare(b.id) : byStart(a, b))).map(g => g.id) }));

    return { now: response.now, timezone: response.timezone, spoilerFree: prefs.spoilerFree, scores, sports, follows, hero, rails, games };
}

/**
 * The front page for a signed-in user. `events()` answers C-I's cached 72-hour events ({ body }); `ended(leagues)`, if
 * given, the airings of those leagues that ended within the overrun window (#191, sportsEvents.endedEvents). Throws on a
 * worker failure.
 */
async function front({ userId, events, ended = null, now = Date.now() }) {
    const dashboard = require('./sportsDashboard');
    const store = require('./sportPagePrefs');
    const prefs = store.follows(userId);
    const leagues = new Set(prefs.sports.flatMap(s => s.leagues));
    const timezone = dashboard.timezone();
    if (!leagues.size) return emptyFront({ now, timezone, spoilerFree: prefs.spoilerFree });
    dashboard.store(); // the tables exist before the read-only worker opens them
    const cached = await events();
    const endedEvents = ended ? await ended(leagues) : [];
    // #195: the International groups in which a followed name is one of the group's nations.
    const groups = require('./sportGroups');
    const nations = prefs.sports.flatMap(s => s.leagues.filter(l => groups.isGroup(l) && groups.followsNation(l, s.teams)));
    const response = await dashboard.response({ eventsBody: cached.body, options: { now, userId, timezone, nations,
        league: null, leagues, follow: null, broadLeagues: new Set(),
        keepFinishedToday: true, teams: store.view(prefs).teams, spoilerFree: prefs.spoilerFree, channelTimes: true, upcomingHours: 72, endedEvents, guideCards: false } });
    require('./logoCache').applyLogoCache(response.games.flatMap(g => g.competitors));
    return arrange(response, prefs);
}

module.exports = { front, arrange, finishEstimate };
