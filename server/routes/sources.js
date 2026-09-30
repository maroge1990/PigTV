const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('../services/xtreamApi');
const syncService = require('../services/syncService');
const m3uParser = require('../services/m3uParser');
const { requireAuth, requireAdmin } = require('../auth');
const { bumpLibraryRev } = require('../services/libraryRev');
const { NUMBER_JOIN } = require('../services/channelNumbers');
const sportCategories = require('../services/sportCategories');
const providerFields = require('../services/providerFields');
const providerAccounts = require('../services/providerAccounts');
const backupChannels = require('../services/backupChannels');

router.use(requireAuth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Browsing clients need identity and availability, never subscription URLs or
// credentials. Use an allowlist so future source fields are private by default.
function sourceSummary(source) {
    return { id: source.id, type: source.type, name: source.name, enabled: source.enabled };
}

// What an admin sees of a source: the summary plus its provider settings (0168). The ID overlay
// address is a capability URL with a login in it, so only the single-source edit form gets it
// (GET /:id); the provider list says only whether one is set. The lists everyone can read
// (GET /, GET /type/:type) and the create/update replies stay the plain summary.
const adminSummary = (source) => ({ ...sourceSummary(source), ...providerFields.adminView(source) });

// Does this source have live channels? (for "one enabled primary with streams")
const hasStreams = (id) => Boolean(getDb().prepare(`SELECT 1 FROM playlist_items WHERE source_id = ? AND type = 'live' LIMIT 1`).get(id));

// Get all sources
router.get('/', async (req, res) => {
    try {
        const allSources = await sources.getAll();
        res.json(allSources.map(sourceSummary));
    } catch (err) {
        console.error('Error getting sources:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get sync status for all sources
router.get('/status', requireAdmin, async (req, res) => {
    try {
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const statuses = db.prepare('SELECT * FROM sync_status').all();
        res.json(statuses);
    } catch (err) {
        console.error('Error getting sync status:', err);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// The providers with their settings (admin; 0168): every non-EPG source, role and all.
router.get('/providers', requireAdmin, async (req, res) => {
    try {
        res.json((await sources.getAll()).filter(s => s.type !== 'epg').map(s => ({
            ...adminSummary(s), ...(s.role === 'backup' ? { backupChannels: backupChannels.count(s.id) } : {}) })));
    } catch (err) {
        console.error('Error getting providers:', err);
        res.status(500).json({ error: 'Failed to get providers' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type);
        res.json(typeSources.map(sourceSummary));
    } catch (err) {
        console.error('Error getting sources by type:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get single source
router.get('/:id', requireAdmin, async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }
        // Only the admin edit form needs the URL/username. Passwords remain
        // write-only: an omitted password on update preserves the saved value.
        res.json({ ...adminSummary(source), url: source.url, username: source.username,
            hasPassword: Boolean(source.password),
            ...(source.type !== 'epg' ? { idOverlayUrl: source.idOverlayUrl ?? null } : {}) });
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
// Every remaining endpoint administers sources or initiates upstream work.
router.use(requireAdmin);

/**
 * GET /api/sources/:id/catalogue?type=live   (admin; 0120)
 *
 * Everything the Sources screen's category/channel picker needs, straight from
 * SQLite, hidden items included (the picker is where they are unhidden):
 *   { categories: [{id, name, hidden, channelCount, sport}],
 *     channels:   [{id, name, categoryId, hidden, number}] }
 * both in the provider's order. `hidden` is the item's own flag; `channelCount`
 * counts every channel in the category, hidden or not; `number` is the channel
 * number (0117), null when it has none. Replaces the picker's use of the
 * Xtream-emulation routes (roadmap W2.1); the web moves onto it separately.
 * Movies and series are not supported: those pages are being removed.
 */
router.get('/:id/catalogue', async (req, res) => {
    try {
        const type = req.query.type === undefined ? 'live' : String(req.query.type);
        if (type === 'movie' || type === 'series') {
            return res.status(400).json({ error: `type=${type} is not supported` });
        }
        if (type !== 'live') return res.status(400).json({ error: 'type must be live' });

        const sourceId = parseInt(req.params.id, 10);
        const source = Number.isInteger(sourceId) ? await sources.getById(sourceId) : null;
        if (!source) return res.status(404).json({ error: 'Source not found' });

        const db = getDb();
        const categories = db.prepare(`
            SELECT c.category_id, c.name, c.is_hidden,
                   (SELECT COUNT(*) FROM playlist_items p
                     WHERE p.source_id = c.source_id AND p.type = c.type
                       AND p.category_id = c.category_id) AS channel_count
            FROM categories c
            WHERE c.source_id = ? AND c.type = 'live'
            ORDER BY CASE WHEN c.sort_order IS NULL THEN 1 ELSE 0 END, c.sort_order ASC, c.name ASC
        `).all(sourceId).map(c => ({
            id: c.category_id,
            name: c.name,
            hidden: c.is_hidden === 1,
            channelCount: c.channel_count,
            sport: sportCategories.isSport(sourceId, c.category_id) // 0146 (C-H)
        }));
        const channels = db.prepare(`
            SELECT p.item_id, p.name, p.category_id, p.is_hidden, n.number
            FROM playlist_items p
            ${NUMBER_JOIN}
            WHERE p.source_id = ? AND p.type = 'live'
            ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order ASC, p.name ASC
        `).all(sourceId).map(ch => ({
            id: ch.item_id,
            name: ch.name,
            categoryId: ch.category_id,
            hidden: ch.is_hidden === 1,
            number: ch.number ?? null
        }));
        res.json({ categories, channels });
    } catch (err) {
        console.error('Error getting source catalogue:', err);
        res.status(500).json({ error: 'Failed to get source catalogue' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { type, name, url, username, password } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        const checked = providerFields.validate(req.body, {
            type, others: await sources.getAll(), hasStreams, enabled: true
        });
        if (checked.error) return res.status(400).json({ error: checked.error });

        const source = await sources.create({ type, name, url, username, password, ...checked.fields });
        // Trigger Sync
        syncService.syncSource(source.id).catch(console.error);
        res.status(201).json(sourceSummary(source));
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(500).json({ error: 'Failed to create source' });
    }
});

// Update source
router.put('/:id', async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const { name, url, username, password } = req.body;
        const checked = providerFields.validate(req.body, {
            existing, type: existing.type, enabled: existing.enabled,
            others: (await sources.getAll()).filter(o => o.id !== existing.id), hasStreams
        });
        if (checked.error) return res.status(400).json({ error: checked.error });
        const updated = await sources.update(req.params.id, {
            name: name || existing.name,
            url: url || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password,
            ...checked.fields
        });
        // Trigger Sync (if critical fields changed? safely just trigger it)
        syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        res.json(sourceSummary(updated));
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.id);
        const existing = await sources.getById(sourceId);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Cascade delete: Clean up SQLite data for this source
        const db = getDb();
        const deleteCategories = db.prepare('DELETE FROM categories WHERE source_id = ?');
        const deleteItems = db.prepare('DELETE FROM playlist_items WHERE source_id = ?');
        const deleteEpg = db.prepare('DELETE FROM epg_programs WHERE source_id = ?');
        const deleteEpgState = db.prepare('DELETE FROM epg_state WHERE source_id = ?');
        const deleteSyncStatus = db.prepare('DELETE FROM sync_status WHERE source_id = ?');
        // 0117: a deleted source's channels will not come back; free their numbers.
        const deleteNumbers = db.prepare('DELETE FROM channel_numbers WHERE source_id = ?');

        const catResult = deleteCategories.run(sourceId);
        const itemResult = deleteItems.run(sourceId);
        const epgResult = deleteEpg.run(sourceId);
        deleteEpgState.run(sourceId);
        deleteSyncStatus.run(sourceId);
        deleteNumbers.run(sourceId);
        providerAccounts.remove(sourceId); // 0168
        backupChannels.removeFor(sourceId); // 0170

        console.log(`[Source] Cascade delete for source ${sourceId}: ${catResult.changes} categories, ${itemResult.changes} items, ${epgResult.changes} EPG programs`);

        // Delete source config and related hidden items (favorites handled by db.js)
        await sources.delete(sourceId);

        // Its channels are gone from the guide too, and nothing else here
        // triggers a sync (which would otherwise bump this on its own).
        bumpLibraryRev();
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', async (req, res) => {
    try {
        const updated = await sources.toggleEnabled(req.params.id);
        if (!updated) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // If enabled, trigger sync (which bumps the guide version on its own);
        // disabling drops its channels from the guide right away, so bump here.
        if (updated.enabled) {
            syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        } else {
            bumpLibraryRev();
        }

        res.json(sourceSummary(updated));
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

/**
 * GET /api/sources/:id/account   (admin; 0168)
 *   { account: { status, expiresAt, maxConnections, activeCons, isTrial, checkedAt, ok, error } | null,
 *     effective: { expiresAt, expirySource: 'manual'|'term'|'account'|null, limit, expired } }
 * POST /api/sources/:id/account/check   reads the provider's player_api.php now, answers the same.
 */
/**
 * GET /api/sources/:id/backup-channels?search=&limit=   (admin; 0170)
 * A backup provider's channels for the manual pick: up to 200 rows of
 * { stream_id, name, category_name, tvg_id, overlay_tvg_id }. Never the stream URL.
 */
router.get('/:id/backup-channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source || source.type === 'epg') return res.status(404).json({ error: 'Provider not found' });
        res.json(backupChannels.search(source.id, req.query.search, req.query.limit));
    } catch (err) {
        console.error('Error searching backup channels:', err);
        res.status(500).json({ error: 'Failed to search the backup channels' });
    }
});

router.get('/:id/account', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source || source.type === 'epg') return res.status(404).json({ error: 'Provider not found' });
        res.json(providerAccounts.describe(source));
    } catch (err) {
        console.error('Error getting provider account:', err);
        res.status(500).json({ error: 'Failed to get the provider account' });
    }
});

router.post('/:id/account/check', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source || source.type === 'epg') return res.status(404).json({ error: 'Provider not found' });
        await providerAccounts.refresh(source.id);
        res.json(providerAccounts.describe(source));
    } catch (err) {
        console.error('Error checking provider account:', err);
        res.status(500).json({ error: 'Failed to check the provider account' });
    }
});

// Manual Sync
router.post('/:id/sync', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const source = await sources.getById(id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Trigger sync (async)
        syncService.syncSource(id).catch(console.error);

        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        console.error('Error starting sync:', err);
        res.status(500).json({ error: 'Failed to start sync' });
    }
});

// Test source connection
router.post('/:id/test', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.type === 'xtream') {
            const result = await xtreamApi.authenticate(source.url, source.username, source.password);
            res.json({ success: true, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

// Estimate M3U playlist size (for large playlist warning)
const M3U_LARGE_THRESHOLD = 50000;

// Estimate by URL (for new sources before creation)
router.post('/estimate', async (req, res) => {
    try {
        const { url, type } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Only M3U sources need estimation
        if (type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for URL...`);
        const count = await m3uParser.countEntries(url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Estimate by source ID (for existing sources)
router.get('/:id/estimate', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Only M3U sources need estimation
        if (source.type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for ${source.name}...`);
        const count = await m3uParser.countEntries(source.url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Global Sync - sync all enabled sources
router.post('/sync-all', async (req, res) => {
    try {
        // Trigger global sync (async - don't wait for completion)
        syncService.syncAll().catch(console.error);
        res.json({ success: true, message: 'Global sync started' });
    } catch (err) {
        console.error('Error starting global sync:', err);
        res.status(500).json({ error: 'Failed to start global sync' });
    }
});

module.exports = router;

