/**
 * #195 (D-41, D-42): the International groups (football's Internationals, cricket's men's and women's internationals)
 * show tournaments in full, and tours, qualifiers and friendlies only for the nations an account follows; everything
 * when the account follows no nation of that group.
 *
 *   isGroup(league)                       one of the four groups
 *   isTournament({ league, id, competition })  football by its ESPN feed (the game id carries it), cricket by its series
 *                                         name (an ICC event: a World Cup, the Champions Trophy, the World Test
 *                                         Championship final)
 *   followsNation(league, names)          whether any of the account's followed names is a team of the group's stored
 *                                         roster (sportsFixtures.teamsOf)
 */
const GROUPS = new Set(['Internationals', "Women's Internationals", 'Cricket', "Women's Cricket"]);
const ICC_EVENT = /\b(?:ICC|World Cup|Champions Trophy|World Test Championship)\b/i;

const isGroup = (league) => GROUPS.has(league);

function isTournament({ league, id, competition }) {
    if (league === 'Cricket' || league === "Women's Cricket") return typeof competition === 'string' && ICC_EVENT.test(competition);
    const path = /^espn:(soccer\/[^:]+):/.exec(String(id || ''))?.[1];
    return Boolean(path) && require('./sportsFixtures').INTERNATIONAL_PATHS.tournaments.has(path);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The group's stored roster, read only from an open database (a pure caller, such as a page's unit test, has none). */
function storedRoster(league) {
    try { return require('../db/sqlite').isOpen() ? require('./sportsFixtures').teamsOf(league) : []; } catch { return []; }
}

function followsNation(league, names, roster = storedRoster(league)) {
    const wanted = new Set((names || []).map(norm).filter(Boolean));
    if (!wanted.size) return false;
    return roster.some(t => ['displayName', 'shortDisplayName', 'name', 'abbreviation'].some(k => wanted.has(norm(t?.[k]))));
}

module.exports = { isGroup, isTournament, followsNation, storedRoster, GROUPS };
