/**
 * #193 (D-41): the sports an account can follow and the leagues inside each, in the order Settings offers them. Only
 * leagues with a fixture source are listed (D-41 point 8: games come only from fixtures); #195 widens the list to the
 * curated catalogue (PRODUCT.md › Sport › Following) and #196/#197 add the leagues whose feeds are still to come.
 * Leagues are sportsClassify's canonical names, as everywhere else; #195 groups them under headings, and a few show a
 * label of their own (the two "International (men)" are cricket's 'Cricket' and football's 'Internationals').
 */
const CATALOG = [
    { sport: 'Australian football', groups: [{ heading: null, leagues: ['AFL', 'AFLW'] }] },
    { sport: 'Football', groups: [
        { heading: 'Domestic leagues', leagues: ['EPL', 'Championship', 'Scottish Premiership', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1',
            'Eredivisie', 'MLS', 'A-League'] },
        { heading: 'Domestic cups', leagues: ['FA Cup', 'League Cup'] },
        { heading: 'European club competitions', leagues: ['Champions League', 'Europa League', 'Conference League'] },
        { heading: "Women's", leagues: ['WSL', 'A-League Women'] },
        { heading: 'International', leagues: ['Internationals', "Women's Internationals"] }] },
    // 'Cricket' is the men's internationals (tours and ICC events), "Women's Cricket" the women's (#195, D-41).
    { sport: 'Cricket', groups: [
        { heading: 'International', leagues: ['Cricket', "Women's Cricket"] },
        { heading: 'Franchise', leagues: ['IPL', 'BBL', 'WBBL', 'SA20', 'The Hundred'] },
        { heading: 'Domestic', leagues: ['Sheffield Shield', 'One-Day Cup', 'WNCL'] }] },
    { sport: 'Rugby league', groups: [{ heading: null, leagues: ['NRL', 'NRLW'] }] },
    { sport: 'Rugby union', groups: [
        { heading: 'Club', leagues: ['Super Rugby', 'Premiership Rugby', 'Top 14', 'Champions Cup'] },
        { heading: 'International', leagues: ['Rugby Championship', 'Six Nations', 'Rugby World Cup'] }] },
    { sport: 'Basketball', groups: [{ heading: null, leagues: ['NBA', 'NBL', 'WNBA'] }] },
    { sport: 'American football', groups: [{ heading: null, leagues: ['NFL'] }] },
    { sport: 'Ice hockey', groups: [{ heading: null, leagues: ['NHL'] }] },
    { sport: 'Baseball', groups: [{ heading: null, leagues: ['MLB'] }] },
    { sport: 'Motorsport', groups: [{ heading: null, leagues: ['F1', 'MotoGP', 'Supercars'] }] },
    { sport: 'Netball', groups: [{ heading: null, leagues: ['Super Netball'] }] }
];
const LABELS = { Cricket: 'International (men)', "Women's Cricket": 'International (women)',
    Internationals: 'International (men)', "Women's Internationals": 'International (women)' };

/** Every sport with its leagues in order (the headings dropped): what the rest of the server reads. */
const SPORTS = CATALOG.map(s => ({ sport: s.sport, leagues: s.groups.flatMap(g => g.leagues) }));
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
/** The name Settings shows for a league. */
function labelOf(league) { return LABELS[league] || league; }
/** C-U's catalogue: `[{ sport, leagues: [{ league, label, heading }] }]` (`heading` null where a sport has none). */
function publicCatalog() {
    return CATALOG.map(s => ({ sport: s.sport, leagues: s.groups.flatMap(g => g.leagues.map(league => ({ league, label: labelOf(league), heading: g.heading }))) }));
}

module.exports = { SPORTS, sport, sportOf, isCricket, labelOf, publicCatalog, CRICKET_GROUPS };
