/**
 * Backup links admin API (0171, multi-provider brief 2.4 and 2.9). Web only, admin only.
 * For the Settings -> Backup links review page (P4). Never returns a stream URL or a login.
 *
 *   GET  /api/links?status=&backupSourceId=&categoryId=&search=&unlinked=1&offset=&limit=
 *        -> { total, offset, limit, channels: [{ sourceId, key, id, name, number, categoryId,
 *             categoryName, tvgId, region, quality, event, links: [{ id, backupSourceId, provider,
 *             streamId, name, category, method, status, rank, score, updatedAt }] }] }
 *        one row per visible primary channel. status: channels with a link in that status;
 *        backupSourceId: only that provider's links; unlinked=1: no auto/approved/manual/pending
 *        rank-1 link (at that backup, or at any backup). limit 1-500, default 100.
 *   GET  /api/links/summary
 *        -> { channels, linkable, providers: [{ backupSourceId, name, role: 'backup'|'sibling',
 *             enabled, priority?, counts: {auto, pending, approved, manual, rejected, broken},
 *             linked, unlinked }] }
 *   PUT  /api/links/:id  { status: 'approved' | 'rejected' | 'pending' }   -> the link
 *        'pending' undoes a decision (a manual link is removed).
 *   POST /api/links  { primarySourceId, primaryKey, backupSourceId, streamId }   -> 201 the link
 *        the admin's own pick, ranked first; 404 when the channel or the stream does not exist.
 *   POST /api/links/approve-pending  { categoryId, backupSourceId? }   -> { approved }
 *        approves the rank-1 pending links of the visible channels in that category.
 *   POST /api/links/relink   -> the relink's counts (runs it now instead of after the next sync)
 *
 * The manual pick searches a backup's channels with GET /api/sources/:id/backup-channels (0170).
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const channelLinks = require('../services/channelLinks');

router.use(requireAuth, requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const clamp = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const intOrNull = v => (v === undefined || v === null || v === '' ? null : (Number.isInteger(Number(v)) ? Number(v) : NaN));

// Only what the page shows: never url_data or a URL (the row has none, but say so here).
const linkView = r => r && ({
    id: r.id, primarySourceId: r.primary_source_id, primaryKey: r.primary_key, backupSourceId: r.backup_source_id,
    streamId: r.backup_stream_id, method: r.method, status: r.status, rank: r.rank, score: r.score, updatedAt: r.updated_at
});

router.get('/', (req, res) => {
    try {
        const status = req.query.status ? String(req.query.status) : null;
        if (status && !channelLinks.STATUSES.includes(status)) {
            return res.status(400).json({ error: `status must be one of ${channelLinks.STATUSES.join(', ')}` });
        }
        const backupSourceId = intOrNull(req.query.backupSourceId);
        if (Number.isNaN(backupSourceId)) return res.status(400).json({ error: 'backupSourceId must be a number' });
        res.json(channelLinks.list({
            status,
            backupSourceId,
            categoryId: req.query.categoryId === undefined ? null : String(req.query.categoryId),
            search: String(req.query.search || '').slice(0, 200),
            unlinked: req.query.unlinked === '1' || req.query.unlinked === 'true',
            offset: clamp(req.query.offset, 0, 1e6, 0),
            limit: clamp(req.query.limit, 1, 500, 100)
        }));
    } catch (err) {
        console.error('[Links] List failed:', err.message);
        res.status(500).json({ error: 'Failed to list the backup links' });
    }
});

router.get('/summary', (req, res) => {
    try {
        res.json(channelLinks.summary());
    } catch (err) {
        console.error('[Links] Summary failed:', err.message);
        res.status(500).json({ error: 'Failed to summarise the backup links' });
    }
});

router.post('/approve-pending', (req, res) => {
    const { categoryId } = req.body || {};
    if (categoryId === undefined || categoryId === null || categoryId === '') {
        return res.status(400).json({ error: 'categoryId is required' });
    }
    const backupSourceId = intOrNull(req.body.backupSourceId);
    if (Number.isNaN(backupSourceId)) return res.status(400).json({ error: 'backupSourceId must be a number' });
    try {
        res.json(channelLinks.approvePending({ categoryId: String(categoryId), backupSourceId }));
    } catch (err) {
        console.error('[Links] Bulk approve failed:', err.message);
        res.status(500).json({ error: 'Failed to approve the pending links' });
    }
});

router.post('/relink', async (req, res) => {
    try {
        res.json(await channelLinks.relinkAll());
    } catch (err) {
        console.error('[Links] Relink failed:', err.message);
        res.status(500).json({ error: 'Failed to relink' });
    }
});

router.post('/', (req, res) => {
    const b = req.body || {};
    const primarySourceId = intOrNull(b.primarySourceId);
    const backupSourceId = intOrNull(b.backupSourceId);
    if (primarySourceId == null || Number.isNaN(primarySourceId) || backupSourceId == null || Number.isNaN(backupSourceId)
        || !b.primaryKey || b.streamId === undefined || b.streamId === null || b.streamId === '') {
        return res.status(400).json({ error: 'primarySourceId, primaryKey, backupSourceId and streamId are required' });
    }
    try {
        const r = channelLinks.addManual({ primarySourceId, primaryKey: String(b.primaryKey), backupSourceId, streamId: String(b.streamId) });
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        res.status(201).json(linkView(r.row));
    } catch (err) {
        console.error('[Links] Manual link failed:', err.message);
        res.status(500).json({ error: 'Failed to save the link' });
    }
});

router.put('/:id', (req, res) => {
    const status = req.body && req.body.status;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ error: "status must be 'approved', 'rejected' or 'pending'" });
    }
    try {
        const row = channelLinks.setStatus(req.params.id, status);
        if (!row) return res.status(404).json({ error: 'No such link' });
        res.json(linkView(row));
    } catch (err) {
        console.error('[Links] Update failed:', err.message);
        res.status(500).json({ error: 'Failed to update the link' });
    }
});

module.exports = router;
