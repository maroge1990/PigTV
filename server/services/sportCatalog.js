/**
 * #193 (D-41): the sports an account can follow and the leagues inside each, in the order Settings offers them. Only
 * leagues with a fixture source are listed (D-41 point 8: games come only from fixtures); #195 widens the list to the
 * curated catalogue (PRODUCT.md › Sport › Following) and #196/#197 add the leagues whose feeds are still to come.
 * Leagues are sportsClassify's canonical names, as everywhere else.
 */
const SPORTS = [
    { sport: 'Australian football', leagues: ['AFL'] },
    { sport: 'Football', leagues: ['EPL', 'Championship', 'Scottish Premiership', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1',
        'Eredivisie', 'MLS', 'A-League', 'FA Cup', 'League Cup', 'Champions League', 'Europa League', 'Conference League', 'WSL',
        'A-League Women', 'Internationals', "Women's Internationals"] },
    // 'Cricket' is the men's internationals (tours and ICC events), "Women's Cricket" the women's (#195, D-41).
    { sport: 'Cricket', leagues: ['Cricket', "Women's Cricket", 'IPL', 'BBL', 'WBBL', 'SA20', 'The Hundred', 'Sheffield Shield',
        'One-Day Cup', 'WNCL'] },
    { sport: 'Rugby league', leagues: ['NRL'] },
    { sport: 'Rugby union', leagues: ['Super Rugby', 'Rugby Championship', 'Six Nations', 'Rugby World Cup', 'Premiership Rugby', 'Top 14', 'Champions Cup'] },
    { sport: 'Basketball', leagues: ['NBA', 'NBL', 'WNBA'] },
    { sport: 'American football', leagues: ['NFL'] },
    { sport: 'Ice hockey', leagues: ['NHL'] },
    { sport: 'Baseball', leagues: ['MLB'] },
    { sport: 'Motorsport', leagues: ['F1'] }
];

const SPORT_OF = new Map(SPORTS.flatMap(s => s.leagues.map(l => [l, s.sport])));
const byName = new Map(SPORTS.map(s => [s.sport.toLowerCase(), s]));

/** The catalogue entry for a sport's name (any case), or null. */
function sport(name) { return typeof name === 'string' ? byName.get(name.trim().toLowerCase()) || null : null; }
/** The sport a canonical league belongs to, or null when the catalogue does not offer that league. */
function sportOf(league) { return SPORT_OF.get(league) || null; }
/** #195: a cricket league (its formats, innings and multi-day windows), not only international cricket. */
function isCricket(league) { return SPORT_OF.get(league) === 'Cricket'; }
/** #195: the two International cricket groups, filled from ESPN's series list by its international class. */
const CRICKET_GROUPS = ['Cricket', "Women's Cricket"];

module.exports = { SPORTS, sport, sportOf, isCricket, CRICKET_GROUPS };
