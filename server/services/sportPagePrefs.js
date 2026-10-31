/**
 * #68, #67 (0346, C-P): the sport pages' preferences, one for the whole household (D-30, D-37): every account and
 * device reads and changes the same spoiler-free switch and followed driver.
 *
 * 0381 (D-39): also what the household follows for the Sport front page: `sports` (canonical leagues, in the order
 * the household ranks them) and `teams` (per league, the followed team or driver names). `following` is now derived
 * from `teams` (the first name of F1 and NFL), kept for the clients that read it; writing it writes `teams`.
 * A stored value from before 0381 (no `sports`) is migrated once from the admin follow list (`sports_follow`).
 *
 * Kept in `meta`, not the settings object: the web saves that whole object back from a copy (#9), which would undo a
 * change made on the Apple TV. A missing or unreadable value is the defaults.
 */
const { getDb } = require('../db/sqlite');
const { canonicalLeague, teamFollow } = require('./sportsClassify');

const KEY = 'sport_page_prefs';
const PAGES = ['F1', 'NFL']; // #21 (0379): the NFL page's followed team (its abbreviation, "GB")
const MAX_NAME = 80;
const MAX_SPORTS = 20;
const MAX_TEAMS = 10;

const cleanName = (name) => name.replace(/\s+/g, ' ').trim();
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
function addName(list, name) { if (name && !list.some(n => sameName(n, name))) list.push(name); }

/** The public shape: the stored `sports`/`teams` with `following` derived from them. */
function view(state) {
    const teams = {};
    for (const league of state.sports) if (state.teams[league]?.length) teams[league] = [...state.teams[league]];
    return { spoilerFree: state.spoilerFree, sports: [...state.sports], teams,
        following: Object.fromEntries(PAGES.map(p => [p, teams[p]?.[0] ?? null])) };
}

/** A stored value read defensively: anything unreadable is dropped. */
function sanitise(stored) {
    const state = { spoilerFree: typeof stored.spoilerFree === 'boolean' ? stored.spoilerFree : false, sports: [], teams: {} };
    for (const s of Array.isArray(stored.sports) ? stored.sports : []) {
        const league = typeof s === 'string' ? canonicalLeague(s) : null;
        if (league && !state.sports.includes(league) && state.sports.length < MAX_SPORTS) state.sports.push(league);
    }
    const teams = stored.teams && typeof stored.teams === 'object' && !Array.isArray(stored.teams) ? stored.teams : {};
    for (const [key, names] of Object.entries(teams)) {
        const league = canonicalLeague(key);
        if (!league || !state.sports.includes(league) || !Array.isArray(names)) continue;
        const list = state.teams[league] || [];
        for (const n of names) if (typeof n === 'string' && list.length < MAX_TEAMS) addName(list, cleanName(n).slice(0, MAX_NAME));
        if (list.length) state.teams[league] = list;
    }
    return state;
}

/** Before 0381 (or nothing stored): the leagues and teams the admin follow list names, plus the legacy followed names. */
function migrate(stored, db) {
    const state = { spoilerFree: typeof stored?.spoilerFree === 'boolean' ? stored.spoilerFree : false, sports: [], teams: {} };
    const addSport = (league) => { if (league && !state.sports.includes(league) && state.sports.length < MAX_SPORTS) state.sports.push(league); };
    const addTeam = (league, name) => {
        const clean = typeof name === 'string' ? cleanName(name) : '';
        if (!clean || clean.length > MAX_NAME || !state.sports.includes(league)) return;
        const list = state.teams[league] || (state.teams[league] = []);
        if (list.length < MAX_TEAMS) addName(list, clean);
    };
    // The legacy followed names first, so `following` (what the F1 and NFL pages show) does not change.
    for (const page of PAGES) {
        const name = stored?.following?.[page];
        if (typeof name === 'string' && name) { addSport(page); addTeam(page, name); }
    }
    let rows = [];
    try { rows = db.prepare('SELECT keyword FROM sports_follow ORDER BY position').all(); } catch { rows = []; }
    for (const { keyword } of rows) {
        const team = teamFollow(keyword);
        addSport(canonicalLeague(keyword) || team?.league || null);
        if (team) addTeam(team.league, team.team);
    }
    // Keep the household's ranking: the follow list's order, then a legacy-only page.
    const ranked = rows.map(r => canonicalLeague(r.keyword) || teamFollow(r.keyword)?.league).filter(Boolean);
    state.sports.sort((a, b) => (ranked.includes(a) ? ranked.indexOf(a) : Infinity) - (ranked.includes(b) ? ranked.indexOf(b) : Infinity));
    return state;
}

function write(db, state) {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(KEY, JSON.stringify(view(state)));
}

function readState(db) {
    let stored;
    try { stored = JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY)?.value ?? 'null'); } catch { stored = null; }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = null;
    if (stored && Array.isArray(stored.sports)) return sanitise(stored);
    const state = migrate(stored, db);
    try { write(db, state); } catch { /* a read-only connection migrates again next time */ }
    return state;
}

function get(db = getDb()) { return view(readState(db)); }

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function checkName(name) {
    if (typeof name !== 'string') throw bad('A followed name must be text or null');
    const clean = cleanName(name);
    if (clean.length > MAX_NAME) throw bad('A followed name is too long');
    return clean;
}

/**
 * Apply `{ spoilerFree?, sports?: [league], teams?: { [league]: [name] }, following?: { F1?: name | null, NFL?: team | null } }`;
 * anything else is a 400 and changes nothing. `sports` replaces the list (a league dropped from it loses its teams);
 * `teams` replaces the names of each league it names (an empty list unfollows them); `following.X` replaces X's names
 * with that one (null removes them) and adds X to `sports` when missing.
 */
function update(patch, db = getDb()) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Expected an object');
    const keys = Object.keys(patch);
    if (!keys.length) throw bad('Nothing to change');
    if (keys.some(k => !['spoilerFree', 'sports', 'teams', 'following'].includes(k))) throw bad('Unknown preference');
    if ('spoilerFree' in patch && typeof patch.spoilerFree !== 'boolean') throw bad('spoilerFree must be true or false');
    let sports = null;
    if ('sports' in patch) {
        if (!Array.isArray(patch.sports)) throw bad('sports must be a list of leagues');
        sports = [];
        for (const s of patch.sports) {
            const league = typeof s === 'string' ? canonicalLeague(s) : null;
            if (!league) throw bad('Unknown sports league');
            if (!sports.includes(league)) sports.push(league);
        }
        if (sports.length > MAX_SPORTS) throw bad('Too many sports');
    }
    let teams = null;
    if ('teams' in patch) {
        const t = patch.teams;
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('teams must be an object');
        teams = {};
        for (const [key, names] of Object.entries(t)) {
            const league = canonicalLeague(key);
            if (!league) throw bad('Unknown sports league');
            if (!Array.isArray(names)) throw bad('A league\'s teams must be a list');
            const list = [];
            for (const n of names) {
                const clean = checkName(n);
                if (!clean) throw bad('A followed name must not be empty');
                addName(list, clean);
            }
            if (list.length > MAX_TEAMS) throw bad('Too many teams for one league');
            teams[league] = list;
        }
    }
    const following = {};
    if ('following' in patch) {
        const f = patch.following;
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('following must be an object');
        for (const [page, name] of Object.entries(f)) {
            if (!PAGES.includes(page)) throw bad('Unknown sport page');
            following[page] = name === null ? null : (checkName(name) || null);
        }
    }
    return db.transaction(() => {
        const next = readState(db);
        if ('spoilerFree' in patch) next.spoilerFree = patch.spoilerFree;
        if (sports) {
            next.sports = sports;
            for (const league of Object.keys(next.teams)) if (!sports.includes(league)) delete next.teams[league];
        }
        if (teams) {
            for (const [league, list] of Object.entries(teams)) {
                if (!next.sports.includes(league)) throw bad('A league with teams must be one of the followed sports');
                if (list.length) next.teams[league] = list; else delete next.teams[league];
            }
        }
        for (const [page, name] of Object.entries(following)) {
            if (name === null) { delete next.teams[page]; continue; }
            if (!next.sports.includes(page)) {
                if (next.sports.length >= MAX_SPORTS) throw bad('Too many sports');
                next.sports.push(page);
            }
            next.teams[page] = [name];
        }
        write(db, next);
        return view(next);
    })();
}

module.exports = { get, update, PAGES };
