'use strict';
/**
 * D-57: the oldest database this version opens is one last opened by build 0476 (release v0476) or later. Anything
 * older is refused before it is touched (no pre-migration copy, no schema step, no write), with the way through: start
 * PigTV v0502 once with it (that release still has the one-time migrations), then this version.
 *
 * The evidence is meta `schema_build`, written at every open since 0213 (dbBackup.recordBuild). Three cases:
 *   - fresh: no content.db, or one with no stamp and no row in any table but `meta` (a first start cut short);
 *   - supported: a stamp of 0476 or later, or one that is not a build number at all (an image's own PIGTV_BUILD);
 *   - too old: a stamp below 0476; data with no stamp (last opened before 0213); a data/db.json whose contents were
 *     never moved into the database (meta `app_data_migrated` absent: the format before 0135, which only v0502 still
 *     imports); a database that cannot be read.
 *
 * Read-only, and it leaves the folder as it found it: a read-only open of a WAL database creates empty -wal and -shm
 * files beside it, which are removed again when they were not there before. No dependency on version.js, which needs
 * package.json (some tests copy only server/).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MINIMUM_BUILD = 476;
const UPGRADE_RELEASE = 'v0502';

/** The build number in a stored stamp ('0502', 'v0502', '0521-dev', 521), or null when it is not one ('dev', '1.2'). */
function buildNumber(value) {
    const m = /^\s*v?(\d+)(?![\d.])/i.exec(String(value ?? ''));
    return m ? Number(m[1]) : null;
}

const pad = (n) => String(n).padStart(4, '0');

/** What the file holds, read without changing it or its folder. Throws when it cannot be read. */
function readFacts(dbPath) {
    const companions = ['-wal', '-shm'].map(s => dbPath + s);
    const existed = new Set(companions.filter(f => fs.existsSync(f)));
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name);
        const meta = (key) => (tables.includes('meta') ? conn.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null : null);
        const hasData = tables.some(t => t !== 'meta'
            && conn.prepare(`SELECT EXISTS (SELECT 1 FROM "${t.replace(/"/g, '""')}") AS e`).get().e === 1);
        return { stamp: meta('schema_build'), appDataMoved: meta('app_data_migrated') !== null, hasData };
    } finally {
        conn.close();
        for (const f of companions) {
            if (existed.has(f)) continue;
            try { if (!f.endsWith('-wal') || fs.statSync(f).size === 0) fs.unlinkSync(f); } catch { /* not created */ }
        }
    }
}

/**
 * The verdict for the database at `dbPath` (data/db.json is looked for beside it):
 * { ok: true, kind: 'fresh' | 'supported', warning? } or { ok: false, reason: 'old' | 'unstamped' | 'db.json' | 'unreadable', ... }.
 */
function check(dbPath) {
    const legacyJson = path.join(path.dirname(dbPath), 'db.json');
    const hasLegacyJson = fs.existsSync(legacyJson);
    if (!fs.existsSync(dbPath)) {
        return hasLegacyJson ? { ok: false, reason: 'db.json', dbPath, legacyJson } : { ok: true, kind: 'fresh' };
    }
    let facts;
    try { facts = readFacts(dbPath); } catch (err) { return { ok: false, reason: 'unreadable', dbPath, error: err.message }; }

    const stamp = facts.stamp === null ? '' : String(facts.stamp).trim();
    let warning = null;
    if (stamp) {
        const n = buildNumber(stamp);
        if (n !== null && n < MINIMUM_BUILD) return { ok: false, reason: 'old', dbPath, build: stamp.slice(0, 40) };
        if (n === null) warning = `[Database] The database's last build is recorded as "${stamp.slice(0, 40)}", which is not a build number; opening it`;
    } else if (facts.hasData) {
        return { ok: false, reason: 'unstamped', dbPath };
    }
    if (hasLegacyJson) {
        if (!facts.appDataMoved) return { ok: false, reason: 'db.json', dbPath, legacyJson };
        warning = '[Database] data/db.json is present but its contents were moved into the database before; it is ignored';
    }
    return { ok: true, kind: stamp ? 'supported' : 'fresh', ...(warning ? { warning } : {}) };
}

/** The one plain message a refusal logs. Names files and builds only: never a provider address or login. */
function message(verdict) {
    const found = {
        old: `The database ${verdict.dbPath} was last opened by PigTV build ${verdict.build}.`,
        unstamped: `The database ${verdict.dbPath} was last opened by a PigTV build before 0213.`,
        'db.json': `${verdict.legacyJson} holds sources, users and settings in the format PigTV used before build 0135, `
            + 'and they have not been moved into the database.',
        unreadable: `The database ${verdict.dbPath} could not be read to see which build last opened it (${verdict.error}).`
    }[verdict.reason];
    const way = verdict.reason === 'unreadable'
        ? 'If it is damaged, restore a backup (docs/OPERATIONS.md, Restore).'
        : `The way through: start PigTV ${UPGRADE_RELEASE} once with this data folder (it upgrades the database), then start this version again.`;
    return `[Database] Not started. ${found} This version opens databases from build ${pad(MINIMUM_BUILD)} on (D-57). ${way} Nothing was changed.`;
}

/** At server start, before anything else touches the data folder: refuse (exit 1) or carry on. */
function exitIfUnsupported(dbPath) {
    const verdict = check(dbPath);
    if (!verdict.ok) {
        console.error(message(verdict));
        process.exit(1);
    }
    return verdict; // a warning is logged by getDb(), which runs the same check when it opens the database
}

module.exports = { MINIMUM_BUILD, UPGRADE_RELEASE, buildNumber, check, message, exitIfUnsupported };
