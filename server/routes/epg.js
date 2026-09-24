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
