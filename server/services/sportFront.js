/**
 * 0381 (D-39): the Sport front page's answer (GET /api/sports/front; the "Blend 1" mock-up). Built on the dashboard's
 * projection (sportsDashboard.buildDashboard, on its worker) for the household's followed sports and teams
 * (sportPagePrefs), then arranged here into what the page draws:
 *
 *   sports  one row per followed sport, in the household's order: how many are live, the next start, and `line`
 *           ('live' | 'next' | 'quiet'; the client words and formats it)
 *   follows one per followed team or driver: live now, next, or nothing (`state`), with the card it points at
 *   hero    the one card the page leads with (rule below); stickiness and the long-press override are the client's
 *   rails   per followed sport, card ids: live first (earliest start), then today's finals (latest first), then the rest
 *   games   every card once, each with `followed`; the other parts point at their ids
 *
 * Hero, first match wins: a followed card live now ('follow-live'); a live card in the highest-ranked followed sport
 * ('league-live'); the followed card that starts first ('follow-next'); a guide-only listing on now that can be
 * watched ('guide'); else 'none'. Between live cards, the one closest to finishing wins (D-39, C-R; finishEstimate).
 */
const ONGOING = new Set(['live', 'break', 'suspended']);
const byStart = (a, b) => a.start - b.start || a.id.localeCompare(b.id);
const HOUR = 3600000;
const FOOTBALL = new Set(['EPL', 'Championship', 'FA Cup', 'UEFA', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'MLS', 'A-League']);
const TYPICAL_HOURS = { F1: 2, NFL: 3.25, NBA: 2.5, AFL: 3, MLB: 3.25 };
const CRICKET_HOURS = { t20: 4.5, odi: 9, test: 120, 'first-class': 120 };

/** When a card should end: its own `end`, else its start plus the league's typical length (0382). */
function finishEstimate(card) {
    if (Number.isFinite(card.end)) return card.end;
    const hours = card.league === 'Cricket' ? CRICKET_HOURS[card.format] || 12
        : FOOTBALL.has(card.league) ? 2 : TYPICAL_HOURS[card.league] || 3;
    return card.start + hours * HOUR;
}
const byFinish = (a, b) => finishEstimate(a) - finishEstimate(b) || byStart(a, b);

function emptyFront({ now, timezone, spoilerFree }) {
    return { now, timezone, spoilerFree, scores: 'unavailable', sports: [], follows: [],
        hero: { reason: 'none', followIndex: null, gameId: null }, rails: [], games: [] };
}

/** Arrange a dashboard answer (built with the front page's options) for the household's prefs. Pure. */
function arrange(response, prefs) {
    const order = prefs.sports;
    const matches = response.followMatches || {};
    const games = response.games.filter(g => order.includes(g.league));
    const espnCards = games.filter(g => g.dataSource !== 'guide');
    const scores = espnCards.some(g => g.freshness === 'fresh') ? 'fresh' : espnCards.length ? 'stale' : 'unavailable';
    const inLeague = league => games.filter(g => g.league === league);
    const firstScheduled = list => list.filter(g => g.status === 'scheduled').sort(byStart)[0] || null;

    const sports = order.map(league => {
        const list = inLeague(league);
        const live = list.filter(g => ONGOING.has(g.status)).length;
        const nextCard = firstScheduled(list);
        const next = nextCard ? { gameId: nextCard.id, start: nextCard.start } : null;
        return { league, live, next, line: live ? 'live' : next ? 'next' : 'quiet' };
    });

    const follows = [], followed = [];
    for (const league of order) for (const name of prefs.teams[league] || []) {
        const cards = games.filter(g => (matches[g.id] || []).some(m => m.name === name));
        const pick = cards.filter(g => ONGOING.has(g.status)).sort(byFinish)[0] || firstScheduled(cards);
        const logoOf = card => {
            const index = (matches[card.id] || []).find(m => m.name === name)?.competitor;
            return Number.isInteger(index) ? card.competitors[index]?.logo || null : null;
        };
        const logo = league === 'F1' ? null : (pick && logoOf(pick)) || cards.map(logoOf).find(Boolean) || null;
        follows.push({ league, name, logo, state: !pick ? 'none' : ONGOING.has(pick.status) ? 'live' : 'next',
            gameId: pick?.id ?? null, start: pick?.start ?? null });
        followed.push(new Set(cards.map(g => g.id)));
    }
    const followIndexOf = card => { const i = followed.findIndex(ids => ids.has(card.id)); return i >= 0 ? i : null; };

    let hero = { reason: 'none', followIndex: null, gameId: null };
    const followLive = games.filter(g => g.followed && ONGOING.has(g.status)).sort(byFinish)[0];
    const leagueLive = order.map(l => inLeague(l).filter(g => ONGOING.has(g.status)).sort(byFinish)[0]).find(Boolean);
    const followNext = games.filter(g => g.followed && g.status === 'scheduled').sort(byStart)[0];
    const guide = order.map(l => inLeague(l).filter(g => g.dataSource === 'guide' && g.canWatch &&
        g.start <= response.now && response.now < g.end).sort(byStart)[0]).find(Boolean);
    if (followLive) hero = { reason: 'follow-live', followIndex: followIndexOf(followLive), gameId: followLive.id };
    else if (leagueLive) hero = { reason: 'league-live', followIndex: null, gameId: leagueLive.id };
    else if (followNext) hero = { reason: 'follow-next', followIndex: followIndexOf(followNext), gameId: followNext.id };
    else if (guide) hero = { reason: 'guide', followIndex: null, gameId: guide.id };

    const rank = g => ONGOING.has(g.status) ? 0 : g.status === 'finished' ? 1 : 2;
    const rails = order.map(league => ({ league, gameIds: inLeague(league).sort((a, b) => rank(a) - rank(b) ||
        (rank(a) === 1 ? (b.end ?? b.start) - (a.end ?? a.start) || a.id.localeCompare(b.id) : byStart(a, b))).map(g => g.id) }));

    return { now: response.now, timezone: response.timezone, spoilerFree: prefs.spoilerFree, scores, sports, follows, hero, rails, games };
}

/** The front page for a signed-in user. `events()` answers C-I's cached 72-hour events ({ body }). Throws on a worker failure. */
async function front({ userId, events, now = Date.now() }) {
    const dashboard = require('./sportsDashboard');
    const prefs = require('./sportPagePrefs').get();
    const timezone = dashboard.timezone();
    if (!prefs.sports.length) return emptyFront({ now, timezone, spoilerFree: prefs.spoilerFree });
    dashboard.store(); // the tables exist before the read-only worker opens them
    const cached = await events();
    const response = await dashboard.response({ eventsBody: cached.body, options: { now, userId, timezone,
        league: null, leagues: new Set(prefs.sports), follow: null, broadLeagues: new Set(),
        keepFinishedToday: true, teams: prefs.teams, spoilerFree: prefs.spoilerFree, channelTimes: true, upcomingHours: 72 } });
    require('./logoCache').applyLogoCache(response.games.flatMap(g => g.competitors));
    return arrange(response, prefs);
}

module.exports = { front, arrange, finishEstimate };
