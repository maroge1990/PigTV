/**
 * #68, #67 (0346, C-P): the sport pages' preferences, one for the whole household (D-30, D-37): every account and
 * device reads and changes the same spoiler-free switch and followed driver.
 *
 * Kept in `meta`, not the settings object: the web saves that whole object back from a copy (#9), which would undo a
 * change made on the Apple TV. A missing or unreadable value is the defaults.
 */
const { getDb } = require('../db/sqlite');

const KEY = 'sport_page_prefs';
const PAGES = ['F1'];
const MAX_NAME = 80;

const defaults = () => ({ spoilerFree: false, following: Object.fromEntries(PAGES.map(p => [p, null])) });

function get(db = getDb()) {
    const out = defaults();
    let stored;
    try { stored = JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY)?.value ?? 'null'); } catch { stored = null; }
    if (!stored || typeof stored !== 'object') return out;
    if (typeof stored.spoilerFree === 'boolean') out.spoilerFree = stored.spoilerFree;
    for (const page of PAGES) {
        const name = stored.following?.[page];
        if (typeof name === 'string' && name) out.following[page] = name;
    }
    return out;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Apply `{ spoilerFree?, following?: { F1?: name | null } }`; anything else is a 400 and changes nothing. */
function update(patch, db = getDb()) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Expected an object');
    const keys = Object.keys(patch);
    if (!keys.length) throw bad('Nothing to change');
    if (keys.some(k => k !== 'spoilerFree' && k !== 'following')) throw bad('Unknown preference');
    if ('spoilerFree' in patch && typeof patch.spoilerFree !== 'boolean') throw bad('spoilerFree must be true or false');
    const following = {};
    if ('following' in patch) {
        const f = patch.following;
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('following must be an object');
        for (const [page, name] of Object.entries(f)) {
            if (!PAGES.includes(page)) throw bad('Unknown sport page');
            if (name === null) { following[page] = null; continue; }
            if (typeof name !== 'string') throw bad('A followed name must be text or null');
            const clean = name.replace(/\s+/g, ' ').trim();
            if (clean.length > MAX_NAME) throw bad('A followed name is too long');
            following[page] = clean || null;
        }
    }
    return db.transaction(() => {
        const next = get(db);
        if ('spoilerFree' in patch) next.spoilerFree = patch.spoilerFree;
        Object.assign(next.following, following);
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(KEY, JSON.stringify(next));
        return next;
    })();
}

module.exports = { get, update, PAGES };
