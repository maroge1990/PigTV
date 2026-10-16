/**
 * EPG matching admin API (0134, roadmap S4.2). Web only, admin only.
 *
 *   GET /api/epg/unmatched?search=&limit=
 *       -> {total, channels: [{sourceId, id, stableId, name, category, tvgId, mapped,
 *                              candidates: [{tvgId, name, score}]}]}
 *       visible channels (one per identity) whose tvg-id has no EPG programmes
 *       in the next 24 hours, each with the 5 best-named EPG channels that do
 *   GET /api/epg/channels?search=
 *       -> [{tvgId, name, score, hasProgrammes}] the EPG's channel list, searched
 *   GET /api/epg/mappings
 *       -> [{sourceId, id, name, tvgId, updatedAt}] the stored overrides
 *   PUT /api/epg/mapping  {sourceId, channelId, tvgId}
 *       -> {success, tvgId} stores the override (tvgId null or "" removes it)
 *
 * See services/epgMapping.js for why the override is applied at query time.
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const epgMapping = require('../services/epgMapping');

router.use(requireAuth, requireAdmin);

const clamp = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

router.get('/unmatched', (req, res) => {
    try {
        res.json(epgMapping.unmatched({
            limit: clamp(req.query.limit, 1, 2000, 500),
            search: String(req.query.search || '').slice(0, 100)
        }));
    } catch (err) {
        console.error('[EPG] unmatched failed:', err.message);
        res.status(500).json({ error: 'Could not list the channels without programme information' });
    }
});

router.get('/channels', (req, res) => {
    try {
        res.json(epgMapping.searchEpgChannels(String(req.query.search || '').slice(0, 100)));
    } catch (err) {
        console.error('[EPG] channel search failed:', err.message);
        res.status(500).json({ error: 'Could not search the EPG channels' });
    }
});

router.get('/mappings', (req, res) => {
    try {
        res.json(epgMapping.listMappings());
    } catch (err) {
        console.error('[EPG] mappings failed:', err.message);
        res.status(500).json({ error: 'Could not list the EPG mappings' });
    }
});

// R10: map every clearly-matched channel at once. ?dryRun or {dryRun:true} previews; the answer of
// an apply names its batch, which DELETE /auto-map/:batch undoes. Never touches a mapping made by hand.
const thresholdOf = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.8 && n <= 1 ? n : epgMapping.AUTO_THRESHOLD;
};

router.get('/auto-map', (req, res) => {
    try {
        res.json({ threshold: thresholdOf(req.query.threshold), channels: epgMapping.autoMapPreview({ threshold: thresholdOf(req.query.threshold) }),
            batches: epgMapping.autoMapBatches() });
    } catch (err) {
        console.error('[EPG] auto-map preview failed:', err.message);
        res.status(500).json({ error: 'Could not preview the automatic mappings' });
    }
});

router.post('/auto-map', (req, res) => {
    try {
        const result = epgMapping.autoMapApply({ threshold: thresholdOf(req.body?.threshold) });
        console.log(`[EPG] Auto-map ${result.batch}: ${result.mapped} channel(s) mapped`);
        res.json(result);
    } catch (err) {
        console.error('[EPG] auto-map failed:', err.message);
        res.status(500).json({ error: 'Could not map the channels' });
    }
});

router.delete('/auto-map/:batch', (req, res) => {
    if (!/^auto-\d{10,16}$/.test(req.params.batch)) return res.status(400).json({ error: 'Unknown batch' });
    try {
        res.json(epgMapping.autoMapUndo(req.params.batch));
    } catch (err) {
        console.error('[EPG] auto-map undo failed:', err.message);
        res.status(500).json({ error: 'Could not undo the automatic mappings' });
    }
});

router.put('/mapping', (req, res) => {
    const { sourceId, channelId, tvgId } = req.body || {};
    const source = parseInt(sourceId, 10);
    if (!Number.isFinite(source) || channelId === undefined || channelId === null || channelId === '') {
        return res.status(400).json({ error: 'sourceId and channelId are required' });
    }
    if (tvgId !== null && tvgId !== undefined && typeof tvgId !== 'string') {
        return res.status(400).json({ error: 'tvgId must be a string, or null to remove the mapping' });
    }
    if (typeof tvgId === 'string' && tvgId.trim().length > epgMapping.MAX_TVG_ID) {
        return res.status(400).json({ error: `tvgId must be at most ${epgMapping.MAX_TVG_ID} characters` });
    }
    try {
        const result = epgMapping.setMapping(source, channelId, tvgId);
        if (!result) return res.status(404).json({ error: 'No such channel in the playlist' });
        res.json({ success: true, tvgId: result.tvgId });
    } catch (err) {
        console.error('[EPG] mapping failed:', err.message);
        res.status(500).json({ error: 'Could not save the EPG mapping' });
    }
});

module.exports = router;
