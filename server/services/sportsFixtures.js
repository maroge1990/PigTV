/**
 * Sport fixtures (0161, C-I): ESPN's real kickoff/session times, kept in SQLite and refreshed in
 * the background, so sportsClassify.resolveLive's ESPN rule has ground truth to check the guide's
 * live/replay guesses against instead of only ever guessing itself.
 *
 * Mark follows NFL, AFL, AFLW, NBA, Formula 1, MLB and Cricket (Settings -> Sports). Of those,
 * ESPN's free scoreboard covers NFL, AFL, NBA, F1 and MLB directly (ESPN_LEAGUE_PATHS), plus
 * cricket's IPL and Big Bash by their own fixed league ids. International cricket (Tests, ODIs,
 * T20Is) has no fixed league id, so its series are found each refresh from ESPN's cricket
 * "scorepanel" (services/sportsFixturesEspn.js discoverCricketSeries) and merged under the
 * canonical league 'Cricket'. AFLW has no ESPN feed at all and stays on the heuristics
 * (sportsClassify.js LIVE_HOURS etc.) exactly as before this file existed.
 *
 * Only leagues that matter are fetched: those the follow list names (via
 * sportsClassify.canonicalLeague) or a marked sport category's own name suggests (via
 * sportsClassify.detectLeague) - never all seven, and never international cricket's series
 * discovery, unless 'Cricket' is actually being followed or a sport category is named for it.
 *
 * Refresh: every 30 minutes (armRefreshTimer) and after an EPG sync (scheduleRefresh, called from
 * syncService.js exactly where it already calls sportsEvents.scheduleRebuild), always through
 * setImmediate/async - never inline on a request, and never allowed to block one: a request only
 * ever reads the last good snapshot() from SQLite. A league's fetch failing keeps its last good
 * rows untouched; failures are logged only when a league's ok/not-ok state actually changes, so a
 * flaky evening does not spam the log every 30 minutes. Each ESPN request has its own 10 s
 * timeout (services/sportsFixturesEspn.js). `PIGTV_SPORT_FIXTURES=0` turns this off completely:
 * no fetch ever runs and snapshot() always returns nothing, so resolveLive's ESPN rule never
 * applies and every league is exactly on the heuristics, as before 0161.
 */
const { getDb } = require('../db/sqlite');
const sportsClassify = require('./sportsClassify');
const espn = require('./sportsFixturesEspn');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// The same window sportsEvents.js builds over (services/sportsEvents.js WINDOW_MS/LOOKBACK_MS):
// a fixture outside it can never be the closest one to an airing that build ever looks at.
const LOOKBACK_MS = 36 * HOUR_MS;
const WINDOW_MS = 72 * HOUR_MS;
const REFRESH_EVERY_MS = 30 * 60 * 1000;
const TEAMS_MAX_AGE_MS = DAY_MS;
const MAX_CRICKET_SERIES = 20; // scorepanel's own list is small; a cap keeps a bad response bounded

// canonical league (sportsClassify.LEAGUES) -> ESPN's URL path. 'Cricket' (international) is
// handled separately (discoverCricketSeries): it has no single fixed path. AFLW has no ESPN feed.
const ESPN_LEAGUE_PATHS = {
    NFL: 'football/nfl',
    AFL: 'australian-football/afl',
    NBA: 'basketball/nba',
    F1: 'racing/f1',
    MLB: 'baseball/mlb',
    IPL: 'cricket/8048',
    BBL: 'cricket/8044'
};

function enabled() {
    return process.env.PIGTV_SPORT_FIXTURES !== '0';
}

// ---- which leagues matter right now -------------------------------------------------------

/** The follow list's own canonical leagues (sportsClassify.canonicalLeague of each keyword). */
function followedLeagues(db) {
    const rows = db.prepare('SELECT keyword FROM sports_follow').all();
    const out = new Set();
    for (const r of rows) {
        const l = sportsClassify.canonicalLeague(r.keyword);
        if (l) out.add(l);
    }
    return out;
}

/** Leagues a marked sport category's own name suggests (C-H, sportsClassify.detectLeague). */
function categoryLeagues(db) {
    const rows = db.prepare(`
        SELECT DISTINCT c.name FROM sport_categories sc
        JOIN categories c ON c.source_id = sc.source_id AND c.category_id = sc.category_id
    `).all();
    const out = new Set();
    for (const r of rows) {
        const l = sportsClassify.detectLeague(r.name);
        if (l) out.add(l);
    }
    return out;
}

/** The leagues to actually fetch: named by the follow list or a sport category, and ESPN-covered. */
function neededLeagues(db = getDb()) {
    const wanted = new Set([...followedLeagues(db), ...categoryLeagues(db)]);
    const out = new Set();
    for (const l of wanted) if (ESPN_LEAGUE_PATHS[l] || l === 'Cricket') out.add(l);
    return out;
}

// ---- state (for "only log on a change") ----------------------------------------------------

let lastOkByLeague = new Map(); // league -> boolean, only what was last logged
let refreshTimer = null;
let refreshing = null; // a Promise while a refreshAll() is in flight, so two never overlap

function logStateChange(league, ok, detail) {
    const was = lastOkByLeague.get(league);
    if (was === ok) return;
    lastOkByLeague.set(league, ok);
    if (ok) console.log(`[SportFixtures] ${league}: fetch recovered${detail ? ` (${detail})` : ''}`);
    else console.warn(`[SportFixtures] ${league}: fetch failing${detail ? ` - ${detail}` : ''}`);
}

// ---- storage --------------------------------------------------------------------------------

function saveStatus(db, league, patch) {
    const existing = db.prepare('SELECT * FROM sport_fixture_status WHERE league = ?').get(league) || {};
    const row = { ...existing, ...patch };
    db.prepare(`
        INSERT INTO sport_fixture_status (league, last_attempt_at, last_success_at, last_error, last_error_at, fixture_count, covered_from, covered_to)
        VALUES (@league, @last_attempt_at, @last_success_at, @last_error, @last_error_at, @fixture_count, @covered_from, @covered_to)
        ON CONFLICT(league) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
            last_error = excluded.last_error, last_error_at = excluded.last_error_at, fixture_count = excluded.fixture_count,
            covered_from = excluded.covered_from, covered_to = excluded.covered_to
    `).run({
        league,
        last_attempt_at: row.last_attempt_at ?? null,
        last_success_at: row.last_success_at ?? null,
        last_error: row.last_error ?? null,
        last_error_at: row.last_error_at ?? null,
        fixture_count: row.fixture_count ?? null,
        // A failure never touches these: the covered window only ever moves on a success (below).
        covered_from: row.covered_from ?? null,
        covered_to: row.covered_to ?? null
    });
}

function saveFixtures(db, league, records) {
    const now = Date.now();
    db.transaction(() => {
        db.prepare('DELETE FROM sport_fixtures WHERE league = ?').run(league);
        const insert = db.prepare('INSERT OR REPLACE INTO sport_fixtures (league, fixture_id, start, data, updated_at) VALUES (?, ?, ?, ?, ?)');
        for (const rec of records) {
            const fixtureId = rec.sessionAbbr ? `${rec.id}#${rec.sessionAbbr}` : rec.id;
            insert.run(league, fixtureId, rec.start, JSON.stringify(rec), now);
        }
    })();
}

function saveTeams(db, league, teams) {
    if (!teams || !teams.length) return;
    db.prepare(`
        INSERT INTO sport_fixture_teams (league, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(league) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(league, JSON.stringify(teams), Date.now());
}

function loadTeams(db, league) {
    const row = db.prepare('SELECT data, updated_at FROM sport_fixture_teams WHERE league = ?').get(league);
    if (!row) return null;
    try { return { teams: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return null; }
}

// ---- refreshing one league --------------------------------------------------------------------

/** NFL/AFL/NBA/F1/MLB/IPL/BBL: one fixed ESPN league path. */
async function refreshLeague(league, { now = Date.now(), db = getDb() } = {}) {
    const path = ESPN_LEAGUE_PATHS[league];
    if (!path) return;
    saveStatus(db, league, { last_attempt_at: now });
    const result = await espn.fetchScoreboard(path, now - LOOKBACK_MS, now + WINDOW_MS);
    if (!result.ok) {
        logStateChange(league, false, result.error);
        saveStatus(db, league, { last_error: result.error || 'failed', last_error_at: now });
        return;
    }
    logStateChange(league, true);
    saveFixtures(db, league, result.records); // a full replace: a postponed/removed game does not linger
    saveStatus(db, league, {
        last_success_at: now, last_error: null, fixture_count: result.records.length,
        covered_from: now - LOOKBACK_MS, covered_to: now + WINDOW_MS
    });

    const cachedTeams = loadTeams(db, league);
    if (!cachedTeams || now - cachedTeams.updatedAt >= TEAMS_MAX_AGE_MS) {
        const teamsResult = await espn.fetchTeams(path);
        if (teamsResult.ok && teamsResult.teams.length) saveTeams(db, league, teamsResult.teams);
        else if (result.teams && result.teams.length) saveTeams(db, league, result.teams); // cricket paths: no /teams endpoint
    }
}

/** International cricket: discover today's active series, then fetch each one's window and merge under 'Cricket'. */
async function refreshCricket({ now = Date.now(), db = getDb() } = {}) {
    saveStatus(db, 'Cricket', { last_attempt_at: now });
    const discovery = await espn.discoverCricketSeries();
    if (!discovery.ok) {
        logStateChange('Cricket', false, discovery.error);
        saveStatus(db, 'Cricket', { last_error: discovery.error || 'failed', last_error_at: now });
        return;
    }
    const series = discovery.series.slice(0, MAX_CRICKET_SERIES);
    const records = [];
    const teams = new Map();
    let anyOk = false;
    let lastError = null;
    for (const s of series) {
        const result = await espn.fetchScoreboard(`cricket/${s.id}`, now - LOOKBACK_MS, now + WINDOW_MS);
        if (!result.ok) { lastError = result.error; continue; }
        anyOk = true;
        records.push(...result.records);
        for (const t of result.teams) teams.set((t.displayName || t.abbreviation || '').toLowerCase(), t);
    }
    if (!series.length) anyOk = true; // nothing active is a legitimate, successful answer
    if (!anyOk) {
        logStateChange('Cricket', false, lastError);
        saveStatus(db, 'Cricket', { last_error: lastError || 'failed', last_error_at: now });
        return;
    }
    logStateChange('Cricket', true);
    // Every refresh re-discovers and re-fetches every currently active series from scratch, so
    // this is already the WHOLE league's fixture set for this cycle - a full replace (like any
    // other league) rather than a merge, so a series that finished or was postponed drops out.
    saveFixtures(db, 'Cricket', records);
    saveStatus(db, 'Cricket', {
        last_success_at: now, last_error: null, fixture_count: records.length,
        covered_from: now - LOOKBACK_MS, covered_to: now + WINDOW_MS
    });
    if (teams.size) saveTeams(db, 'Cricket', [...teams.values()]);
}

/** Refresh every league that currently matters. Never throws; never runs two at once. */
async function refreshAll(now = Date.now()) {
    if (!enabled()) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
        const db = getDb();
        const leagues = neededLeagues(db);
        for (const league of leagues) {
            try {
                if (league === 'Cricket') await refreshCricket({ now, db });
                else await refreshLeague(league, { now, db });
            } catch (err) {
                logStateChange(league, false, err.message);
                try { saveStatus(db, league, { last_error: err.message, last_error_at: now }); } catch { /* best-effort */ }
            }
        }
    })();
    try {
        await refreshing;
    } finally {
        refreshing = null;
    }
}

/** Kick off a refresh in the background (never awaited by a caller on the request path). */
function scheduleRefresh() {
    if (!enabled()) return;
    setImmediate(() => { refreshAll().catch(err => console.warn('[SportFixtures] Refresh failed:', err.message)); });
}

function armRefreshTimer() {
    refreshTimer = setTimeout(() => { scheduleRefresh(); armRefreshTimer(); }, REFRESH_EVERY_MS);
    if (refreshTimer.unref) refreshTimer.unref();
}

/** Start the 30-minute background refresh (called once, at server start). */
function startBackgroundRefresh() {
    if (refreshTimer) return;
    if (!enabled()) { console.log('[SportFixtures] Off (PIGTV_SPORT_FIXTURES=0)'); return; }
    scheduleRefresh();
    armRefreshTimer();
}

function stopBackgroundRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
}

// ---- turning stored rows into what sportsClassify.resolveLive needs --------------------------

/** parseSide of every non-empty, deduplicated name field a fixture's team carries -> [side, ...], or null. */
function teamAliasSides(team) {
    if (!team) return null;
    const seen = new Set();
    const sides = [];
    for (const raw of [team.displayName, team.shortDisplayName, team.name, team.location, team.abbreviation]) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const key = sportsClassify.normText(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const side = sportsClassify.parseSide(raw);
        if (side) sides.push(side);
    }
    return sides.length ? sides : null;
}

const F1_SESSIONS = {
    FP1: { id: 'practice 1', label: 'Practice 1' }, FP2: { id: 'practice 2', label: 'Practice 2' },
    FP3: { id: 'practice 3', label: 'Practice 3' }, PRACTICE: { id: 'practice', label: 'Practice' },
    Q: { id: 'qualifying', label: 'Qualifying' }, QUAL: { id: 'qualifying', label: 'Qualifying' },
    SQ: { id: 'sprint qualifying', label: 'Sprint Qualifying' }, SS: { id: 'sprint qualifying', label: 'Sprint Qualifying' },
    SPRINT: { id: 'sprint', label: 'Sprint' }, R: { id: 'race', label: 'Race' }, RACE: { id: 'race', label: 'Race' }
};
/** The { id, label } an ESPN F1 competition's `type.abbreviation` (FP1, Qual, Sprint, R, ...) names, or null. */
function f1Session(abbr) {
    if (!abbr) return null;
    return F1_SESSIONS[String(abbr).toUpperCase().replace(/\s+/g, '')] || null;
}

/** One stored ESPN record -> what resolveLive's fixtureVerdict needs, or null if it names neither teams nor a session. */
function toFixture(rec) {
    if (rec.teams && rec.teams.length === 2) {
        const a = teamAliasSides(rec.teams[0]);
        const b = teamAliasSides(rec.teams[1]);
        if (!a || !b) return null;
        return { start: rec.start, end: rec.end || null, teamsAliases: [a, b], session: null, location: [] };
    }
    const session = f1Session(rec.sessionAbbr);
    if (!session) return null;
    // The Grand Prix's location, reusing sportsClassify's own title parser on the event name
    // ("Qatar Airways Azerbaijan Grand Prix" -> location ["azerbaijan"]) rather than writing a
    // second, separate location parser that could disagree with the guide's own.
    const location = rec.eventName ? sportsClassify.parseTitle(rec.eventName).location : [];
    return { start: rec.start, end: rec.end || null, teamsAliases: null, session, location };
}

/**
 * The pure snapshot resolveLive(airings, fixturesByLeague, now) takes: Map<league, { fixtures,
 * teamsAliases, coverage: { from, to, at } }>. `coverage` is the LAST SUCCESSFUL fetch's own
 * window and when it happened (sport_fixture_status.covered_from/to/last_success_at) - it is what
 * lets fixtureVerdict tell "ESPN checked this moment and found nothing" from "ESPN has not
 * checked this moment" (0162: a league that has never succeeded, or whose covered window does not
 * reach this airing, is simply not something the ESPN rule can answer for - it is omitted here,
 * so resolveLive falls straight through to the heuristics for it). A league IS included with an
 * empty `fixtures` list as long as it has a coverage window: "no games right now" is itself an
 * answer ESPN gave, not an absence of one.
 *
 * Only `leagues` (sportsEvents.js passes the ones its build actually saw) are read, so a build
 * never pays for a league nobody is watching. Synchronous SQLite reads only - never touches the
 * network, never blocks on one - so it is safe to call on every build.
 */
function snapshot(leagues) {
    if (!enabled() || !leagues || !leagues.size) return new Map();
    const db = getDb();
    const out = new Map();
    for (const league of leagues) {
        if (!ESPN_LEAGUE_PATHS[league] && league !== 'Cricket') continue;
        const status = db.prepare('SELECT covered_from, covered_to, last_success_at FROM sport_fixture_status WHERE league = ?').get(league);
        if (!status || !Number.isFinite(status.covered_from) || !Number.isFinite(status.covered_to)) continue;
        const rows = db.prepare('SELECT data FROM sport_fixtures WHERE league = ?').all(league);
        const fixtures = [];
        for (const row of rows) {
            let rec;
            try { rec = JSON.parse(row.data); } catch { continue; }
            const fixture = toFixture(rec);
            if (fixture) fixtures.push(fixture);
        }
        const cachedTeams = loadTeams(db, league);
        const teamsAliases = (cachedTeams?.teams || []).map(teamAliasSides).filter(Boolean);
        out.set(league, {
            fixtures, teamsAliases,
            coverage: { from: status.covered_from, to: status.covered_to, at: status.last_success_at }
        });
    }
    return out;
}

// ---- the Status page's "Sport fixtures" panel -------------------------------------------------

/** Per league: last successful fetch, fixture count, last error - never a URL. */
function statusSummary() {
    if (!enabled()) return { enabled: false, leagues: [] };
    try {
        const rows = getDb().prepare('SELECT * FROM sport_fixture_status ORDER BY league').all();
        return {
            enabled: true,
            leagues: rows.map(r => ({
                league: r.league,
                lastSuccessAt: r.last_success_at || null,
                lastAttemptAt: r.last_attempt_at || null,
                fixtureCount: r.fixture_count ?? null,
                lastError: r.last_error || null,
                lastErrorAt: r.last_error_at || null
            }))
        };
    } catch (err) {
        return { enabled: true, leagues: [], error: err.message };
    }
}

function reset() {
    lastOkByLeague = new Map();
}

module.exports = {
    enabled, neededLeagues, refreshAll, refreshLeague, refreshCricket, scheduleRefresh,
    startBackgroundRefresh, stopBackgroundRefresh, snapshot, statusSummary, reset,
    ESPN_LEAGUE_PATHS,
    // exposed for tests
    toFixture, teamAliasSides, f1Session
};
