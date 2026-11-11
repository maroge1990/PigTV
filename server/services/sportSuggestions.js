/**
 * #198 (D-41 point 2): a followed team shows only in the leagues the account picked, so the app suggests the other
 * competitions it plays in: when it is followed, and again whenever it gains a fixture in one not picked ("Arsenal are
 * in the FA Cup now. Add it?"). "No thanks" is remembered per account, team and competition (`sport_suggestion_no`).
 *
 * Where a team's competitions come from:
 *   Football   ESPN's schedule of the club across every competition (`soccer/all/teams/<id>/schedule?fixture=true`,
 *              checked 1 Nov 2026: Arsenal's Premier League and Champions League fixtures), its id taken from the
 *              collector's cards (ESPN gives a club one id in every competition). Kept SCHEDULE_TTL.
 *   Any sport  the collector's own cards: an upcoming game of the team in a league of its sport (only leagues some
 *              account follows are collected).
 * Only catalogue leagues of the team's own sport are offered, and only for fixtures still to come.
 */
const { getDb } = require('../db/sqlite');
const catalog = require('./sportCatalog');
const H = 3600000;
const SCHEDULE_TTL = 6 * H;
const MAX_TEAMS = 40; // schedules asked for in one answer (an account follows at most 20 names per sport)

const fold = require('./textFold').personKey;
const schedules = new Map(); // ESPN team id -> { at, leagues: Map(league -> first start) }

function ensureTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS sport_suggestion_no (user_id INTEGER NOT NULL, team TEXT NOT NULL, league TEXT NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (user_id, team, league))`);
}
function declined(db, userId) {
    try { return new Set(db.prepare('SELECT team, league FROM sport_suggestion_no WHERE user_id = ?').all(userId).map(r => `${fold(r.team)}|${r.league}`)); }
    catch { return new Set(); } // no table yet
}

/** "No thanks": never suggest `league` for `team` to this account again. 400 for a league outside the catalogue. */
function decline(userId, { team, league } = {}, db = getDb()) {
    if (typeof team !== 'string' || !team.trim() || team.length > 80) throw Object.assign(new Error('team must be a followed name'), { status: 400 });
    if (!catalog.sportOf(league)) throw Object.assign(new Error('league must be a catalogue league'), { status: 400 });
    ensureTable(db);
    db.prepare('INSERT OR REPLACE INTO sport_suggestion_no (user_id, team, league, at) VALUES (?, ?, ?, ?)').run(userId, team.trim(), league, Date.now());
}

/** The canonical league an ESPN soccer slug ("eng.league_cup") is, or null. */
function leagueOfSlug(slug) {
    const { ESPN_LEAGUE_PATHS } = require('./sportsFixtures');
    const path = `soccer/${slug}`;
    for (const [league, paths] of Object.entries(ESPN_LEAGUE_PATHS)) if ([].concat(paths).includes(path)) return league;
    return null;
}

/** The football competitions a club has fixtures in from `now`: Map(league -> first start); cached SCHEDULE_TTL. */
async function clubCompetitions(teamId, now, fetchJson) {
    const kept = schedules.get(teamId);
    if (kept && now - kept.at < SCHEDULE_TTL) return kept.leagues;
    const leagues = new Map();
    try {
        const json = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/${encodeURIComponent(teamId)}/schedule?fixture=true`);
        for (const e of Array.isArray(json?.events) ? json.events : []) {
            const at = Date.parse(e?.date), league = leagueOfSlug(String(e?.league?.slug || ''));
            if (!league || !Number.isFinite(at) || at < now) continue;
            if (!leagues.has(league) || at < leagues.get(league)) leagues.set(league, at);
        }
        schedules.set(teamId, { at: now, leagues });
        if (schedules.size > 200) schedules.delete(schedules.keys().next().value);
    } catch { return kept?.leagues || leagues; } // unanswered: what was known, else nothing
    return leagues;
}

/**
 * The suggestions for one account: [{ sport, team, league, label, start }] (`start` the team's first fixture there),
 * in the account's order of sports and names. `games` is the collector's catalogue (sportsDashboard.store().catalog()).
 */
async function suggestions(userId, { db = getDb(), now = Date.now(), games = null, fetchJson = require('./sportsScoresEspn').fetchJson } = {}) {
    const follows = require('./sportPagePrefs').follows(userId, db);
    const cards = games || require('./sportsDashboard').store().catalog();
    const no = declined(db, userId);
    const out = [];
    let asked = 0;
    for (const { sport, leagues: picked, teams } of follows.sports) {
        const offered = catalog.sport(sport)?.leagues || [];
        for (const team of teams) {
            const wanted = fold(team);
            const plays = (g) => g.competitors?.find(c => [c.name, ...(c.aliases || [])].some(a => fold(a) === wanted));
            const found = new Map(); // league -> first start
            const note = (league, at) => { if (!found.has(league) || at < found.get(league)) found.set(league, at); };
            for (const g of cards) if (offered.includes(g.league) && g.start >= now && plays(g)) note(g.league, g.start);
            if (sport === 'Football' && asked < MAX_TEAMS) {
                const id = cards.filter(g => g.id?.startsWith('espn:soccer/')).map(plays).find(c => c?.id)?.id;
                if (id) { asked++; for (const [league, at] of await clubCompetitions(id, now, fetchJson)) if (offered.includes(league)) note(league, at); }
            }
            for (const [league, start] of [...found].sort((a, b) => a[1] - b[1])) {
                if (picked.includes(league) || no.has(`${wanted}|${league}`)) continue;
                out.push({ sport, team, league, label: catalog.labelOf(league), start });
            }
        }
    }
    return out;
}

module.exports = { suggestions, decline, clubCompetitions, leagueOfSlug, _schedules: schedules };
