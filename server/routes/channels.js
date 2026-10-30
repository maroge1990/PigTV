const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('../services/libraryRev');
const { refreshChannelNumbers } = require('../services/channelNumbers');
const { requireAdmin } = require('../auth');
const hiddenChannels = require('../services/hiddenChannels');

/**
 * #167: a sync rewrites a playlist's rows in batches and moves their hidden flags back onto the right channels only at
 * the end, so a visibility change in between would be recorded against rows that are part-way through moving. It is
 * refused, with a message the web shows, until the sync finishes (usually well under a minute).
 */
function refuseWhileSyncing(res, sourceIds) {
    const syncService = require('../services/syncService');
    const busy = [...new Set(sourceIds.map(Number))].filter(id => Number.isInteger(id) && syncService.isSyncing(id));
    if (!busy.length) return false;
    res.status(409).json({ error: 'Channels are being updated from the provider. Try again when the sync finishes.' });
    return true;
}

// Helper to map API item types to DB types and tables
function mapItemType(apiType) {
    switch (apiType) {
        case 'channel': return { table: 'playlist_items', type: 'live' };
        case 'group': return { table: 'categories', type: 'live' };
        case 'vod_category': return { table: 'categories', type: 'movie' };
        case 'series_category': return { table: 'categories', type: 'series' };
        case 'movie': return { table: 'playlist_items', type: 'movie' };
        case 'series': return { table: 'playlist_items', type: 'series' };
        default: return null;
    }
}

// Get all hidden items (formatted like db.json for frontend compatibility)
router.get('/hidden', async (req, res) => {
    try {
        const { sourceId } = req.query;
        const db = getDb();

        let hidden = [];
        const resultFormat = (row, itemType) => ({
            source_id: row.source_id,
            item_type: itemType,
            item_id: itemType.includes('category') || itemType === 'group' ? row.category_id : row.item_id
        });

        // Query Categories
        let catQuery = `SELECT source_id, category_id, type FROM categories WHERE is_hidden = 1`;
        let itemQuery = `SELECT source_id, item_id, type FROM playlist_items WHERE is_hidden = 1`;

        const params = [];
        if (sourceId) {
            catQuery += ` AND source_id = ?`;
            itemQuery += ` AND source_id = ?`;
            const sid = parseInt(sourceId);
            params.push(sid);
        }

        const hiddenCats = db.prepare(catQuery).all(...params);
        const hiddenItems = db.prepare(itemQuery).all(...params);

        hiddenCats.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'group';
            else if (row.type === 'movie') apiType = 'vod_category';
            else if (row.type === 'series') apiType = 'series_category';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        hiddenItems.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'channel';
            else if (row.type === 'movie') apiType = 'movie';
            else if (row.type === 'series') apiType = 'series';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        res.json(hidden);
    } catch (err) {
        console.error('Error getting hidden items:', err);
        res.status(500).json({ error: 'Failed to get hidden items' });
    }
});

// Hide item
/**
 * Keep a category and its items in step.
 *
 * The UI treats a category as one switch, and the stream query filters on both
 * the item's own flag and its category's. If only one side is written they can
 * disagree — a visible channel inside a hidden category simply disappears, with
 * nothing in the interface to explain why. Cascading on write means the two can
 * never drift, including after a sync inserts new rows.
 */
function cascadeCategory(db, sourceId, type, categoryId, hidden) {
    const stmt = db.prepare(`
        UPDATE playlist_items SET is_hidden = ?
        WHERE source_id = ? AND type = ? AND category_id = ?
    `);
    const result = stmt.run(hidden ? 1 : 0, sourceId, type, String(categoryId));
    return result.changes;
}

router.post('/hide', requireAdmin, async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });
        if (refuseWhileSyncing(res, [sourceId])) return;

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 1 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        let cascaded = 0;
        if (mapping.table === 'categories') {
            cascaded = cascadeCategory(db, sourceId, mapping.type, itemId, true);
            hiddenChannels.dismiss(db, Number(sourceId), [itemId]); // kept hidden on purpose: reviewed
        }
        hiddenChannels.capture(db, Number(sourceId)); // #10: the record follows the channel

        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, cascaded });
    } catch (err) {
        console.error('Error hiding item:', err);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

// Show item
router.post('/show', requireAdmin, async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });
        if (refuseWhileSyncing(res, [sourceId])) return;

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 0 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        let cascaded = 0;
        if (mapping.table === 'categories') {
            cascaded = cascadeCategory(db, sourceId, mapping.type, itemId, false);
            hiddenChannels.dismiss(db, Number(sourceId), [itemId]);
        }
        hiddenChannels.capture(db, Number(sourceId)); // #10: the record follows the channel

        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, cascaded });
    } catch (err) {
        console.error('Error showing item:', err);
        res.status(500).json({ error: 'Failed to show item' });
    }
});

// Check hidden status
router.get('/hidden/check', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.query;
        const mapping = mapItemType(itemType);
        if (!mapping) return res.json({ hidden: false });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const row = db.prepare(`
            SELECT is_hidden FROM ${mapping.table} 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `).get(sourceId, mapping.type, itemId);

        res.json({ hidden: !!(row && row.is_hidden) });
    } catch (err) {
        console.error('Error checking hidden:', err);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Bulk Hide
router.post('/hide/bulk', requireAdmin, async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
        if (refuseWhileSyncing(res, items.map(i => i && i.sourceId))) return;

        const db = getDb();

        // Prepare statements once
        const hideCat = db.prepare('UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');
        const hideItem = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (hide all children of a category)
        const hideCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Hide the category
                        hideCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        hideCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Hide individual item
                        hideItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        hiddenChannels.captureAll(db, items.map(i => i && i.sourceId)); // #10
        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk hide:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Bulk Show
router.post('/show/bulk', requireAdmin, async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
        if (refuseWhileSyncing(res, items.map(i => i && i.sourceId))) return;

        const db = getDb();

        // Prepare statements once
        const showCat = db.prepare('UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');
        const showItem = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (show all children of a category)
        const showCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Show the category
                        showCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        showCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Show individual item
                        showItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        hiddenChannels.captureAll(db, items.map(i => i && i.sourceId)); // #10
        for (const i of items) {
            if (mapItemType(i && i.itemType)?.table === 'categories') hiddenChannels.dismiss(db, Number(i.sourceId), [i.itemId]);
        }
        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk show:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Show ALL items for a source (single SQL statement - much faster than bulk)
router.post('/show/all', requireAdmin, async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
        if (refuseWhileSyncing(res, [sourceId])) return;

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        console.log(`[Channels] Show all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        hiddenChannels.capture(db, Number(sourceId)); // #10
        hiddenChannels.dismiss(db, Number(sourceId));
        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error show all:', err);
        res.status(500).json({ error: 'Failed to show all' });
    }
});

// Hide ALL items for a source (single SQL statement - much faster than bulk)
router.post('/hide/all', requireAdmin, async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
        if (refuseWhileSyncing(res, [sourceId])) return;

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        console.log(`[Channels] Hide all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        hiddenChannels.capture(db, Number(sourceId)); // #10
        bumpLibraryRev();
        refreshChannelNumbers(); // 0117: a shown channel gets a number, a hidden one is reserved
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error hide all:', err);
        res.status(500).json({ error: 'Failed to hide all' });
    }
});

// #10 (0347): groups the provider added since the last sync, which arrive hidden ("New on the provider", D-37).
router.get('/new-groups', requireAdmin, (req, res) => {
    try {
        const sourceId = req.query.sourceId === undefined ? undefined : Number(req.query.sourceId);
        if (sourceId !== undefined && !Number.isInteger(sourceId)) return res.status(400).json({ error: 'Invalid sourceId' });
        res.json(hiddenChannels.newGroups(getDb(), sourceId));
    } catch (err) {
        console.error('Error listing new groups:', err.message);
        res.status(500).json({ error: 'Failed to list new groups' });
    }
});

// Take groups off the review list without showing them (Keep hidden). No categoryIds: the source's whole list.
router.post('/new-groups/dismiss', requireAdmin, (req, res) => {
    try {
        const sourceId = Number(req.body && req.body.sourceId);
        const ids = req.body && req.body.categoryIds;
        if (!Number.isInteger(sourceId)) return res.status(400).json({ error: 'sourceId required' });
        if (ids !== undefined && (!Array.isArray(ids) || ids.some(i => typeof i !== 'string' && typeof i !== 'number'))) {
            return res.status(400).json({ error: 'categoryIds must be a list' });
        }
        res.json({ success: true, dismissed: hiddenChannels.dismiss(getDb(), sourceId, ids) });
    } catch (err) {
        console.error('Error dismissing new groups:', err.message);
        res.status(500).json({ error: 'Failed to dismiss' });
    }
});

module.exports = router;

