/**
 * #193 (D-41): what each account follows, kept per account (table `sport_follows`), synced to every device signed in
 * to it. A sport (sportCatalog) holds the leagues followed inside it, at least one, in the account's order, and the
 * teams or individuals followed in that sport: each name once, highlighted in every followed league it plays in. The
 * spoiler-free switch is the account's too.
 *
 *   follows(userId)   { spoilerFree, sports: [{ sport, leagues: [league], teams: [name] }] }   (C-U)
 *   get(userId)       the C-P / C-R view the Apple apps up to 90 read: { spoilerFree, sports: [league], teams:
 *                     { [league]: [name] }, following: { F1, NFL } }, the leagues flattened in the account's order and a
 *                     sport's teams listed under each of its leagues; update(userId, patch) writes through it.
 *
 * A new account starts with nothing followed. Only the server's owner (the first admin account) takes over what the
 * household followed before 0391 (the 0381 store in `meta`, else the admin follow list), once, on its first read.
 *
 * Kept apart from the settings object: the web saves that whole object back from a copy (#9).
 */
const { getDb } = require('../db/sqlite');
const { canonicalLeague, teamFollow } = require('./sportsClassify');
const catalog = require('./sportCatalog');

const HOUSEHOLD_KEY = 'sport_page_prefs'; // the 0381 household store, read once for the owner's migration
const PAGES = ['F1', 'NFL']; // C-P / C-Q: the pages whose followed name `following` carries
const MAX_NAME = 80;
const MAX_SPORTS = 20;
const MAX_TEAMS = 20;

// #195: "UEFA" (one league to 0394) is now the Champions League and the Europa League.
const RENAMED = { uefa: ['Champions League', 'Europa League'] };
/** The canonical leagues a stored or sent name stands for: one, or the leagues an old name became. */
function leaguesOf(name) {
    if (typeof name !== 'string') return [];
    const renamed = RENAMED[name.trim().toLowerCase()];
    if (renamed) return renamed;
    const league = canonicalLeague(name);
    return league ? [league] : [];
}
const cleanName = (name) => name.replace(/\s+/g, ' ').trim();
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
function addName(list, name) { if (name && !list.some(n => sameName(n, name))) list.push(name); }
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const empty = () => ({ spoilerFree: false, sports: [] });

// ---- storage ------------------------------------------------------------------------------------

function ensureTable(db) {
    db.exec('CREATE TABLE IF NOT EXISTS sport_follows (user_id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
}
function readRow(db, userId) {
    try { return db.prepare('SELECT value FROM sport_follows WHERE user_id = ?').get(userId)?.value ?? null; }
    catch { return null; } // no table yet (a read-only connection before the first write)
}
function write(db, userId, state) {
    ensureTable(db);
    db.prepare('INSERT INTO sport_follows (user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value')
        .run(userId, JSON.stringify(state));
    // D-42: the followed leagues decide which guide programmes are sport (sportsEvents.getFollow).
    try { require('./sportsEvents').followsChanged(); } catch { /* not loaded here (a worker, a test) */ }
}

/** The server's owner: the admin account with the lowest id, or null. */
function ownerId(db) {
    let rows = [];
    try { rows = db.prepare('SELECT id, data FROM app_users ORDER BY id').all(); } catch { return null; }
    for (const r of rows) {
        try { if (JSON.parse(r.data)?.role === 'admin') return r.id; } catch { /* an unreadable account is not the owner */ }
    }
    return null;
}

// ---- reading -----------------------------------------------------------------------------------

/** Add `league` to `state` under its sport (appending the sport when new). False when the catalogue lacks it. */
function addLeague(state, league) {
    const sport = catalog.sportOf(league);
    if (!sport) return false;
    let entry = state.sports.find(s => s.sport === sport);
    if (!entry) {
        if (state.sports.length >= MAX_SPORTS) return false;
        entry = { sport, leagues: [], teams: [] };
        state.sports.push(entry);
    }
    if (!entry.leagues.includes(league)) entry.leagues.push(league);
    return true;
}

/** A stored value read defensively: anything unreadable is dropped; a sport left without a league goes. */
function sanitise(stored) {
    const state = { spoilerFree: stored?.spoilerFree === true, sports: [] };
    for (const s of Array.isArray(stored?.sports) ? stored.sports : []) {
        const def = catalog.sport(s?.sport);
        if (!def || state.sports.some(x => x.sport === def.sport) || state.sports.length >= MAX_SPORTS) continue;
        const leagues = [...new Set((Array.isArray(s.leagues) ? s.leagues : []).flatMap(leaguesOf))].filter(l => def.leagues.includes(l));
        if (!leagues.length && def.leagues.length === 1) leagues.push(def.leagues[0]);
        if (!leagues.length) continue;
        const teams = [];
        for (const n of Array.isArray(s.teams) ? s.teams : []) {
            if (typeof n === 'string' && teams.length < MAX_TEAMS) addName(teams, cleanName(n).slice(0, MAX_NAME));
        }
        state.sports.push({ sport: def.sport, leagues, teams });
    }
    return state;
}

/** The household's follows before 0391 (the 0381 store, else the admin follow list), as the owner's first state. */
function fromHousehold(db) {
    let stored = null;
    try { stored = JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(HOUSEHOLD_KEY)?.value ?? 'null'); } catch { stored = null; }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = null;
    const state = { spoilerFree: stored?.spoilerFree === true, sports: [] };
    const addTeam = (league, name) => {
        const entry = state.sports.find(s => s.leagues.includes(league));
        const clean = typeof name === 'string' ? cleanName(name) : '';
        if (entry && clean && clean.length <= MAX_NAME && entry.teams.length < MAX_TEAMS) addName(entry.teams, clean);
    };
    if (stored && Array.isArray(stored.sports)) {
        for (const l of stored.sports) for (const league of leaguesOf(l)) addLeague(state, league);
        const teams = stored.teams && typeof stored.teams === 'object' ? stored.teams : {};
        for (const [key, names] of Object.entries(teams)) {
            const league = leaguesOf(key)[0];
            if (league && Array.isArray(names)) for (const n of names) addTeam(league, n);
        }
        return state;
    }
    // Before 0381: the legacy followed names, then the admin follow list in its order.
    for (const page of PAGES) {
        const name = stored?.following?.[page];
        if (typeof name === 'string' && name) { addLeague(state, page); addTeam(page, name); }
    }
    let rows = [];
    try { rows = db.prepare('SELECT keyword FROM sports_follow ORDER BY position').all(); } catch { rows = []; }
    for (const { keyword } of rows) {
        const team = teamFollow(keyword);
        const leagues = team ? [team.league] : leaguesOf(keyword);
        for (const league of leagues) if (addLeague(state, league) && team) addTeam(team.league, team.team);
    }
    return state;
}

function readState(db, userId, migrate = true) {
    const raw = readRow(db, userId);
    if (raw !== null) {
        let stored = null;
        try { stored = JSON.parse(raw); } catch { stored = null; }
        return sanitise(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null);
    }
    if (userId === ownerId(db)) {
        const state = fromHousehold(db);
        if (migrate) try { write(db, userId, state); } catch { /* a read-only connection migrates again next time */ }
        return state;
    }
    return empty();
}

/**
 * D-42 (#195): the admin keyword list is retired. Once, at server start: the owner takes over the household's follows
 * (if not yet), then `sports_follow` is emptied, so only the leagues accounts follow decide what is sport.
 */
function retireKeywordList(db = getDb()) {
    const DONE = 'sports_follow_retired';
    try {
        if (db.prepare('SELECT value FROM meta WHERE key = ?').get(DONE)) return false;
        db.transaction(() => {
            const owner = ownerId(db);
            if (owner !== null) readState(db, owner);
            db.prepare('DELETE FROM sports_follow').run();
            db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DONE, '1');
        })();
        try { require('./sportsEvents').followsChanged(); } catch { /* not loaded */ }
        return true;
    } catch (err) {
        console.warn('[Sport] retiring the keyword list:', err.message);
        return false;
    }
}

const copy = (state) => ({ spoilerFree: state.spoilerFree,
    sports: state.sports.map(s => ({ sport: s.sport, leagues: [...s.leagues], teams: [...s.teams] })) });

/** The C-P / C-R view of a state. */
function view(state) {
    const sports = state.sports.flatMap(s => s.leagues);
    const teams = {};
    for (const s of state.sports) if (s.teams.length) for (const l of s.leagues) teams[l] = [...s.teams];
    return { spoilerFree: state.spoilerFree, sports, teams,
        following: Object.fromEntries(PAGES.map(p => [p, teams[p]?.[0] ?? null])) };
}

function follows(userId, db = getDb()) { return copy(readState(db, userId)); }
function get(userId, db = getDb()) { return view(readState(db, userId)); }

/** Every league some account follows (the owner's migration included): what the collector and fixtures fetch. */
function allLeagues(db = getDb()) {
    const out = new Set();
    let ids = [];
    try { ids = db.prepare('SELECT user_id FROM sport_follows').all().map(r => r.user_id); } catch { ids = []; }
    const owner = ownerId(db);
    if (owner !== null && !ids.includes(owner)) ids.push(owner);
    // The owner's not-yet-migrated follows count without migrating them: only the owner's own read takes them over.
    for (const id of ids) for (const s of readState(db, id, false).sports) for (const l of s.leagues) out.add(l);
    return out;
}

// ---- writing -----------------------------------------------------------------------------------

function checkName(name) {
    if (typeof name !== 'string') throw bad('A followed name must be text or null');
    const clean = cleanName(name);
    if (clean.length > MAX_NAME) throw bad('A followed name is too long');
    return clean;
}
function checkNames(names) {
    if (!Array.isArray(names)) throw bad('teams must be a list of names');
    const list = [];
    for (const n of names) {
        const clean = checkName(n);
        if (!clean) throw bad('A followed name must not be empty');
        addName(list, clean);
    }
    if (list.length > MAX_TEAMS) throw bad('Too many teams for one sport');
    return list;
}
function checkObject(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Expected an object');
    if (!Object.keys(patch).length) throw bad('Nothing to change');
    if ('spoilerFree' in patch && typeof patch.spoilerFree !== 'boolean') throw bad('spoilerFree must be true or false');
}

/**
 * C-U: `{ spoilerFree?, sports?: [{ sport, leagues?, teams? }] }`. `sports` replaces the whole list, in its order. Each
 * sport is a catalogue name with at least one of its own leagues (a one-league sport may leave `leagues` out); anything
 * else is a 400 and changes nothing. Answers the account's follows.
 */
function setFollows(userId, patch, db = getDb()) {
    checkObject(patch);
    if (Object.keys(patch).some(k => !['spoilerFree', 'sports'].includes(k))) throw bad('Unknown preference');
    let sports = null;
    if ('sports' in patch) {
        if (!Array.isArray(patch.sports)) throw bad('sports must be a list');
        if (patch.sports.length > MAX_SPORTS) throw bad('Too many sports');
        sports = [];
        for (const s of patch.sports) {
            if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('Each sport must be an object');
            if (Object.keys(s).some(k => !['sport', 'leagues', 'teams'].includes(k))) throw bad('Unknown sport field');
            const def = catalog.sport(s.sport);
            if (!def) throw bad('Unknown sport');
            if (sports.some(x => x.sport === def.sport)) throw bad('A sport is listed twice');
            const leagues = [];
            if ('leagues' in s) {
                if (!Array.isArray(s.leagues)) throw bad('leagues must be a list');
                for (const l of s.leagues) {
                    const named = leaguesOf(l);
                    if (!named.length || named.some(league => !def.leagues.includes(league))) throw bad('A league is not part of its sport');
                    for (const league of named) if (!leagues.includes(league)) leagues.push(league);
                }
            }
            if (!leagues.length && def.leagues.length === 1) leagues.push(def.leagues[0]);
            if (!leagues.length) throw bad('Choose at least one league');
            sports.push({ sport: def.sport, leagues, teams: 'teams' in s ? checkNames(s.teams) : [] });
        }
    }
    return db.transaction(() => {
        const next = readState(db, userId);
        if ('spoilerFree' in patch) next.spoilerFree = patch.spoilerFree;
        if (sports) next.sports = sports;
        write(db, userId, next);
        return copy(next);
    })();
}

/**
 * C-P / C-R, for the Apple apps up to 90: `{ spoilerFree?, sports?: [league], teams?: { [league]: [name] }, following?:
 * { F1?, NFL? } }`. `sports` replaces the followed leagues (grouped into their sports, in first-seen order; a sport
 * keeps its teams while one of its leagues stays); `teams[league]` replaces the names of that league's sport;
 * `following.X` replaces X's names with that one (null removes them) and follows X when it was not. Answers the view.
 */
function update(userId, patch, db = getDb()) {
    checkObject(patch);
    const keys = Object.keys(patch);
    if (keys.some(k => !['spoilerFree', 'sports', 'teams', 'following'].includes(k))) throw bad('Unknown preference');
    let leagues = null;
    if ('sports' in patch) {
        if (!Array.isArray(patch.sports)) throw bad('sports must be a list of leagues');
        leagues = [];
        for (const s of patch.sports) {
            const named = leaguesOf(s);
            if (!named.length || named.some(l => !catalog.sportOf(l))) throw bad('Unknown sports league');
            for (const league of named) if (!leagues.includes(league)) leagues.push(league);
        }
    }
    let teams = null;
    if ('teams' in patch) {
        const t = patch.teams;
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('teams must be an object');
        teams = [];
        for (const [key, names] of Object.entries(t)) {
            const league = leaguesOf(key)[0];
            if (!league || !catalog.sportOf(league)) throw bad('Unknown sports league');
            if (!Array.isArray(names)) throw bad('A league\'s teams must be a list');
            teams.push([league, checkNames(names)]);
        }
    }
    const following = [];
    if ('following' in patch) {
        const f = patch.following;
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('following must be an object');
        for (const [page, name] of Object.entries(f)) {
            if (!PAGES.includes(page)) throw bad('Unknown sport page');
            following.push([page, name === null ? null : (checkName(name) || null)]);
        }
    }
    return db.transaction(() => {
        const next = readState(db, userId);
        if ('spoilerFree' in patch) next.spoilerFree = patch.spoilerFree;
        if (leagues) {
            const before = next.sports;
            next.sports = [];
            for (const league of leagues) if (!addLeague(next, league)) throw bad('Too many sports');
            for (const s of next.sports) s.teams = before.find(b => b.sport === s.sport)?.teams || [];
        }
        for (const [league, names] of teams || []) {
            const entry = next.sports.find(s => s.leagues.includes(league));
            if (!entry) throw bad('A league with teams must be one of the followed sports');
            entry.teams = names;
        }
        for (const [page, name] of following) {
            if (name === null) { const entry = next.sports.find(s => s.leagues.includes(page)); if (entry) entry.teams = []; continue; }
            if (!next.sports.some(s => s.leagues.includes(page)) && !addLeague(next, page)) throw bad('Too many sports');
            next.sports.find(s => s.leagues.includes(page)).teams = [name];
        }
        write(db, userId, next);
        return view(next);
    })();
}

module.exports = { get, follows, update, setFollows, allLeagues, retireKeywordList, view, PAGES, MAX_TEAMS };
