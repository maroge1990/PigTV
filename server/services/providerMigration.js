/**
 * 0182: one-time move to "one card per provider". Run once at startup (recorded in meta):
 *
 *   1. The hand-typed connection limit and subscription dates are removed from every
 *      provider: both are read from the provider's account now.
 *   2. Exactly one provider is the primary, the rest are backups numbered 1..n in the
 *      order they had. (A second source added the old way read as a second primary.)
 *   3. The first enabled standalone EPG source becomes the primary's guide address. Its
 *      programmes are moved under the primary, so the guide is never empty in between;
 *      if the primary already has a guide of its own, they are dropped and the primary is
 *      synced instead. The EPG source itself is then deleted. Any other standalone EPG
 *      source is left as it is (it still syncs, and is listed under the provider cards).
 *
 * Returns what it did, or null when it has run before.
 */

const { getDb } = require('../db/sqlite');

const FLAG = 'providers_consolidated';

/** Primary first (an enabled one with channels if there is a choice), then the backups in their order. */
function orderOf(providers, hasStreams) {
    const primaries = providers.filter(s => s.role !== 'backup');
    const primary = primaries.find(s => s.enabled && hasStreams(s.id)) || primaries.find(s => s.enabled) || primaries[0] || providers[0];
    const rest = providers.filter(s => s !== primary).sort((a, b) =>
        (a.role === 'backup' ? 0 : 1) - (b.role === 'backup' ? 0 : 1)
        || (a.priority ?? 999) - (b.priority ?? 999) || a.id - b.id);
    return [primary, ...rest];
}

async function run() {
    const db = getDb();
    if (db.prepare('SELECT value FROM meta WHERE key = ?').get(FLAG)) return null;
    const { sources } = require('../db');
    const syncService = require('./syncService');
    const report = { cleared: 0, reordered: false, guide: null };

    let providers = (await sources.getAll()).filter(s => s.type !== 'epg');
    for (const s of providers) {
        if (s.maxConnections != null || s.subscription != null) {
            await sources.update(s.id, { maxConnections: undefined, subscription: undefined });
            report.cleared++;
        }
    }

    if (providers.length) {
        const hasStreams = (id) => Boolean(db.prepare(`SELECT 1 FROM playlist_items WHERE source_id = ? AND type = 'live' LIMIT 1`).get(id));
        const places = orderOf(providers, hasStreams).map((s, i) => ({ id: s.id, role: i === 0 ? 'primary' : 'backup', priority: i === 0 ? null : i }));
        const now = new Map(providers.map(s => [s.id, s]));
        if (places.some(p => now.get(p.id).role !== p.role || (now.get(p.id).priority ?? null) !== p.priority)) {
            await sources.setOrder(places);
            report.reordered = true;
        }

        const primary = await sources.getById(places[0].id);
        const epg = (await sources.getAll()).find(s => s.type === 'epg' && s.enabled);
        if (epg && !primary.epgUrl) {
            await sources.update(primary.id, { epgUrl: epg.url });
            const ownGuide = db.prepare('SELECT 1 FROM epg_programs WHERE source_id = ? LIMIT 1').get(primary.id);
            if (ownGuide) {
                await syncService.purgeEpgRows(epg.id, '<>', -1);
                db.prepare('DELETE FROM epg_state WHERE source_id = ?').run(epg.id);
                report.guide = 'resync';
            } else {
                db.transaction(() => {
                    db.prepare('UPDATE epg_programs SET source_id = ? WHERE source_id = ?').run(primary.id, epg.id);
                    db.prepare('DELETE FROM epg_state WHERE source_id = ?').run(primary.id);
                    db.prepare('UPDATE epg_state SET source_id = ? WHERE source_id = ?').run(primary.id, epg.id);
                    db.prepare(`UPDATE OR IGNORE playlist_items SET source_id = ?, id = ? || item_id
                                WHERE source_id = ? AND type = 'epg_channel'`).run(primary.id, `${primary.id}:`, epg.id);
                    db.prepare(`UPDATE OR REPLACE sync_status SET source_id = ?, type = 'epg' WHERE source_id = ? AND type = 'all'`).run(primary.id, epg.id);
                })();
                report.guide = 'moved';
            }
            db.prepare('DELETE FROM playlist_items WHERE source_id = ?').run(epg.id);
            db.prepare('DELETE FROM sync_status WHERE source_id = ?').run(epg.id);
            await sources.delete(epg.id);
            try { require('./libraryRev').bumpLibraryRev(); } catch (e) { /* best-effort */ }
            if (report.guide === 'resync') syncService.syncSource(primary.id).catch(console.error);
        }
    }

    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(FLAG, new Date().toISOString());
    console.log(`[Providers] One card per provider: ${report.cleared} hand-typed limit/date set(s) removed, `
        + `order ${report.reordered ? 'rewritten' : 'unchanged'}, guide ${report.guide || 'unchanged'}`);
    return report;
}

module.exports = { run, orderOf };
