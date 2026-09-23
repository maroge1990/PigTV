/**
 * Lineup admin API (0117, roadmap X2.1, docs/ROADMAP-CONTRACTS.md C-A).
 *
 * Web only, admin only:
 *   GET /api/lineup           -> [{sourceId, id, stableId, name, number, category}]
 *                                one row per visible channel (a cross-listed
 *                                channel once, at its first guide position),
 *                                ordered by number
 *   PUT /api/lineup/numbers   body {numbers: [{sourceId, id, number}]} -> {success}
 *
 * Renumbering validates everything before writing anything: each number a
 * positive integer, no number used twice in the request, and no number held by
 * another visible channel that the request does not also move. A number still
 * RESERVED for a channel that has disappeared yields to the admin's choice
 * (that channel gets a fresh number if it comes back).
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db/sqlite');
const { bumpLibraryRev } = require('../services/libraryRev');
const channelNumbers = require('../services/channelNumbers');
const { NUMBER_JOIN, VISIBLE_SQL, CHANNEL_KEY_SQL } = channelNumbers;

router.use(requireAuth, requireAdmin);

const MAX_NUMBER = 999999;

router.get('/', (req, res) => {
    try {
        channelNumbers.ensureChannelNumbers();
        const rows = getDb().prepare(`
            SELECT p.source_id, p.item_id, p.stable_id, p.name, p.category_id,
                   ${CHANNEL_KEY_SQL} AS channel_key, n.number
            FROM playlist_items p
            ${NUMBER_JOIN}
            WHERE ${VISIBLE_SQL}
            ORDER BY COALESCE(p.sort_order, 999999999) ASC, p.name ASC, p.id ASC
        `).all();
        const seen = new Set();
        const lineup = [];
        for (const r of rows) {
            const k = `${r.source_id}\u0000${r.channel_key}`;
            if (seen.has(k)) continue;
            seen.add(k);
            lineup.push({
                sourceId: r.source_id,
                id: r.item_id,
                stableId: r.stable_id || null,
                name: r.name,
                number: r.number ?? null,
                category: r.category_id
            });
        }
        // Stable sort: numbered first by number, unnumbered after in guide order.
        lineup.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
        res.json(lineup);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/numbers', (req, res) => {
    const list = req.body?.numbers;
    if (!Array.isArray(list) || list.length === 0) {
        return res.status(400).json({ error: 'numbers must be a non-empty array of {sourceId, id, number}' });
    }
    const db = getDb();
    const findChannel = db.prepare(`
        SELECT p.source_id, p.item_id, ${CHANNEL_KEY_SQL} AS channel_key
        FROM playlist_items p
        WHERE p.source_id = ? AND p.item_id = ? AND p.type = 'live'
    `);

    // Validate the whole request first; write nothing unless all of it is good.
    const wanted = new Map(); // identity -> {sourceId, channelKey, itemId, number}
    const byNumber = new Map();
    for (const entry of list) {
        const number = entry?.number;
        if (!Number.isInteger(number) || number < 1 || number > MAX_NUMBER) {
            return res.status(400).json({ error: `Channel numbers must be whole numbers from 1 to ${MAX_NUMBER}` });
        }
        const sourceId = Number(entry.sourceId);
        const channel = Number.isInteger(sourceId) && typeof entry.id === 'string'
            ? findChannel.get(sourceId, entry.id) : null;
        if (!channel) return res.status(400).json({ error: `Unknown channel ${entry?.sourceId}:${entry?.id}` });

        const identity = `${channel.source_id}\u0000${channel.channel_key}`;
        const prior = wanted.get(identity);
        if (prior && prior.number !== number) {
            return res.status(400).json({ error: `Channel ${entry.id} is given two different numbers` });
        }
        const holder = byNumber.get(number);
        if (holder && holder !== identity) return res.status(400).json({ error: `Duplicate number ${number}` });
        byNumber.set(number, identity);
        wanted.set(identity, { sourceId: channel.source_id, channelKey: channel.channel_key, itemId: channel.item_id, number });
    }

    try {
        const visibleKeys = new Set(db.prepare(`
            SELECT p.source_id, ${CHANNEL_KEY_SQL} AS channel_key FROM playlist_items p WHERE ${VISIBLE_SQL}
        `).all().map(r => `${r.source_id}\u0000${r.channel_key}`));
        const holderOf = db.prepare('SELECT source_id, channel_key FROM channel_numbers WHERE number = ?');
        const remove = db.prepare('DELETE FROM channel_numbers WHERE source_id = ? AND channel_key = ?');
        const removeNumber = db.prepare('DELETE FROM channel_numbers WHERE number = ?');
        const insert = db.prepare(`
            INSERT INTO channel_numbers (source_id, channel_key, item_id, number, last_seen) VALUES (?, ?, ?, ?, ?)
        `);

        const conflict = db.transaction(() => {
            // Take every channel being moved out first, so swaps work.
            for (const w of wanted.values()) remove.run(w.sourceId, w.channelKey);
            for (const w of wanted.values()) {
                const holder = holderOf.get(w.number);
                if (holder) {
                    const k = `${holder.source_id}\u0000${holder.channel_key}`;
                    if (visibleKeys.has(k)) throw Object.assign(new Error(`Duplicate number ${w.number}`), { conflict: true });
                    removeNumber.run(w.number); // a reservation yields to the admin
                }
                insert.run(w.sourceId, w.channelKey, w.itemId, w.number, Date.now());
            }
        });
        try {
            conflict();
        } catch (err) {
            if (err.conflict) return res.status(400).json({ error: err.message });
            throw err;
        }
        bumpLibraryRev();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
