const Database = require('better-sqlite3');
const { bareChannelId, COMPOSITE } = require('../services/channelIds');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'content.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        console.log('[SQLite] Opening database at', dbPath);
        db = new Database(dbPath);
        // Optimize performance
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        initSchema();
    }
    return db;
}

function initSchema() {
    if (!db) throw new Error('Database not initialized');

    // Categories (Groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:categoryId
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL, -- 'live', 'movie', 'series'
            name TEXT NOT NULL,
            parent_id TEXT, -- For nested categories
            is_hidden INTEGER DEFAULT 0,
            sort_order INTEGER, -- First-seen position in source file
            data JSON -- Extra provider data
        );
        CREATE INDEX IF NOT EXISTS idx_categories_source_type ON categories(source_id, type);
    `);

    // Playlist Items (Channels, Movies, Series, Episodes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_items (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:itemId
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL, -- Original ID from provider
            type TEXT NOT NULL, -- 'live', 'movie', 'series', 'episode'
            name TEXT NOT NULL,
            category_id TEXT, -- maps to categories.category_id (not our composite id)
            parent_id TEXT, -- For episodes -> series_id
            
            -- Common Media Fields
            stream_icon TEXT,
            stream_url TEXT, -- Direct link if available
            container_extension TEXT,
            
            -- VOD/Series Specific
            rating REAL,
            year TEXT,
            added_at TEXT,
            
            -- App State
            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            
            sort_order INTEGER, -- Position in source file (M3U line number); NULL for Xtream
            
            data JSON -- Full original JSON object
        );
        CREATE INDEX IF NOT EXISTS idx_items_source_type ON playlist_items(source_id, type);
        CREATE INDEX IF NOT EXISTS idx_items_category ON playlist_items(source_id, category_id);
        -- Lookups by item id: resolving a channel to its URL, the favourites join,
        -- recording resolution. Without it each one scans the source's rows.
        CREATE INDEX IF NOT EXISTS idx_items_source_item ON playlist_items(source_id, item_id);
    `);

    // Migration: add sort_order column to existing databases.
    // CREATE TABLE IF NOT EXISTS won't alter a table that already exists,
    // so this handles upgrades from pre-2.3 databases.
    try {
        db.exec('ALTER TABLE playlist_items ADD COLUMN sort_order INTEGER');
    } catch (e) {
        // Column already exists — expected on fresh installs or repeat starts.
    }
    try {
        db.exec('ALTER TABLE categories ADD COLUMN sort_order INTEGER');
    } catch (e) {
        // Column already exists.
    }

    // What a channel IS, as opposed to where it currently sits in the playlist.
    // item_id is pos_N - the line number - which shifts whenever the provider
    // inserts channels, taking every favourite, history row and scheduled
    // recording after the insertion with it. See services/stableIds.js.
    // Nullable and NOT unique on purpose: a placeholder row has no URL and so no
    // identity, and a channel cross-listed in two categories is two rows with one
    // identity, which is the right answer for a favourite.
    try {
        db.exec('ALTER TABLE playlist_items ADD COLUMN stable_id TEXT');
    } catch (e) {
        // Column already exists.
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_playlist_items_stable ON playlist_items(source_id, type, stable_id)');

    // EPG Programs
    // Optimized for range queries
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL, -- matches playlist_items.id if possible, or mapping key
            source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, -- Unix timestamp (ms)
            end_time INTEGER NOT NULL,   -- Unix timestamp (ms)
            title TEXT,
            description TEXT,
            data JSON
        );
        CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_epg_cleanup ON epg_programs(end_time); -- For deleting old programs
    `);

    // Atomic EPG swaps. A sync used to DELETE the source's programmes and then
    // stream the new feed in, so the guide was empty (and, if the feed failed
    // half-way, stayed partly empty) for the whole of every sync. Instead each
    // sync writes a new generation of rows that nothing reads, then flips
    // epg_state.active_gen in one tiny statement. Readers go through the
    // epg_live view, which only shows each source's active generation. A source
    // with no epg_state row is on generation 0, which is what every row written
    // before generations existed (or inserted directly) has - so those are live
    // without any migration step.
    try {
        db.exec('ALTER TABLE epg_programs ADD COLUMN gen INTEGER NOT NULL DEFAULT 0');
    } catch (e) {
        // Column already exists.
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_state (
            source_id INTEGER PRIMARY KEY,
            active_gen INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_epg_source_gen ON epg_programs(source_id, gen);
        CREATE VIEW IF NOT EXISTS epg_live AS
            SELECT p.id, p.channel_id, p.source_id, p.start_time, p.end_time, p.title, p.description, p.data
            FROM epg_programs p
            LEFT JOIN epg_state s ON s.source_id = p.source_id
            WHERE p.gen = COALESCE(s.active_gen, 0);
    `);

    // Sync Status
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- 'live', 'vod', 'series', 'epg'
            last_sync INTEGER NOT NULL,
            status TEXT, -- 'success', 'error', 'syncing'
            error TEXT,
            PRIMARY KEY (source_id, type)
        );
    `);

    // Devices
    //
    // A TV cannot reasonably have a password typed into it with a remote, so
    // clients pair instead: the device shows a short code, an already
    // signed-in user approves it, and the device receives a long-lived token.
    // The token is an ordinary JWT carrying a deviceId, so the existing auth
    // path validates it unchanged; the row here exists so devices can be
    // listed and revoked.
    db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            platform TEXT,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER,
            revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

        CREATE TABLE IF NOT EXISTS pairing_codes (
            code TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            name TEXT,
            platform TEXT,
            device_id TEXT,      -- set once approved
            token TEXT,          -- collected once by the device, then cleared
            approved_at INTEGER
        );
    `);

    // Recently watched channels.
    //
    // Distinct from watch_history, which tracks resume positions for movies
    // and episodes. Live TV has no position to resume — what matters is which
    // channels were on recently — so this is its own table rather than more
    // nullable columns on that one.
    //
    // One row per user per channel, updated in place: the screen that uses
    // this wants the last dozen channels, not a log of every tune-in.
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_history (
            user_id TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            channel_item_id TEXT NOT NULL,
            channel_name TEXT,
            watched_at INTEGER NOT NULL,
            play_count INTEGER DEFAULT 1,
            PRIMARY KEY (user_id, source_id, channel_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_history_recent ON channel_history(user_id, watched_at DESC);
    `);

    // User Favorites (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL, -- 'channel', 'movie', 'series'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_type ON favorites(user_id, item_type);
    `);

    // Watch History (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
            id TEXT PRIMARY KEY, -- Composite key: user_id:item_id
            user_id INTEGER NOT NULL,
            source_id INTEGER, -- Source ID for Xtream/M3U
            item_type TEXT NOT NULL, -- 'movie', 'episode'
            item_id TEXT NOT NULL, -- The original item ID (stream_id or composite)
            parent_id TEXT, -- For episodes (series ID)
            progress INTEGER DEFAULT 0, -- Current position in seconds
            duration INTEGER DEFAULT 0, -- Total duration in seconds
            updated_at INTEGER NOT NULL, -- Timestamp
            data JSON -- Snapshot of item data (title, poster, etc)
        );
        CREATE INDEX IF NOT EXISTS idx_history_user_updated ON watch_history(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_user_item ON watch_history(user_id, item_id);
    `);

    // Migration: Add source_id column if missing (for existing databases)
    try {
        db.exec(`ALTER TABLE watch_history ADD COLUMN source_id INTEGER`);
        console.log('[SQLite] Added source_id column to watch_history');
    } catch (e) {
        // Column already exists, ignore
    }

    normalizeFavoriteIds();
    backfillStableIds();

    console.log('[SQLite] Schema initialized');
}

/**
 * Fill stable_id for rows that predate the column, so the identity is available
 * without waiting for the next provider sync.
 *
 * Only touches rows where it is still NULL, so it costs one indexed scan on an
 * already-migrated database and runs on every start rather than being tracked
 * as a one-off. It derives from stream_url and the data blob exactly as the
 * sync does - an M3U sync leaves stream_url empty and keeps the URL in the blob.
 */
function backfillStableIds() {
    const { stableChannelId } = require('../services/stableIds');
    const rows = db.prepare('SELECT id, stream_url, data FROM playlist_items WHERE stable_id IS NULL').all();
    if (!rows.length) return;

    const update = db.prepare('UPDATE playlist_items SET stable_id = ? WHERE id = ?');
    let filled = 0;
    db.transaction(() => {
        for (const r of rows) {
            let url = r.stream_url;
            if (!url) {
                try { const d = JSON.parse(r.data || '{}'); url = d.url || d.stream_url || null; } catch { url = null; }
            }
            const stable = stableChannelId(url);
            if (stable === null) continue;   // a placeholder row with no URL keeps NULL
            update.run(stable, r.id);
            filled++;
        }
    })();
    // Rows with no URL stay NULL and are re-examined on every start; there are
    // few of them and they are cheap. Only say something when something changed.
    if (filled) console.log(`[SQLite] Derived a stable id for ${filled} of ${rows.length} channel row(s)`);
}

/**
 * Rewrite channel favourites stored under the web app's composite id
 * (m3u_<src>_<item>) to the canonical bare id, merging with a bare row that
 * already exists. Idempotent and cheap - it only looks at rows that still carry
 * a prefix - so it runs on every start rather than being tracked as a one-off.
 */
function normalizeFavoriteIds() {
    const rows = db.prepare(`
        SELECT id, user_id, source_id, item_id FROM favorites
        WHERE item_type = 'channel' AND (substr(item_id, 1, 4) = 'm3u_' OR substr(item_id, 1, 7) = 'xtream_')
    `).all().filter(r => COMPOSITE.test(r.item_id));
    if (!rows.length) return;

    const insertBare = db.prepare(`
        INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type, created_at)
        SELECT user_id, source_id, ?, item_type, created_at FROM favorites WHERE id = ?
    `);
    const remove = db.prepare('DELETE FROM favorites WHERE id = ?');
    db.transaction(() => {
        for (const r of rows) {
            insertBare.run(bareChannelId(r.item_id), r.id);
            remove.run(r.id);
        }
    })();
    console.log(`[SQLite] Normalised ${rows.length} channel favourite id(s) to the bare form`);
}

// ============================================================
// Favorites CRUD Operations
// ============================================================
const favorites = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();
        let sql = 'SELECT * FROM favorites WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }
        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY created_at DESC';
        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        if (itemType === 'channel') itemId = bareChannelId(itemId);
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        if (itemType === 'channel') itemId = bareChannelId(itemId);
        const stmt = db.prepare(`
            DELETE FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        if (itemType === 'channel') itemId = bareChannelId(itemId);
        const row = db.prepare(`
            SELECT 1 FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `).get(userId, sourceId, itemId, itemType);
        return !!row;
    },

    // Get all favorites for a user, grouped by type (for bulk checks)
    getAllAsSet(userId) {
        const db = getDb();
        const rows = db.prepare('SELECT source_id, item_id, item_type FROM favorites WHERE user_id = ?').all(userId);
        const set = new Set();
        for (const row of rows) {
            set.add(`${row.source_id}:${row.item_id}:${row.item_type}`);
        }
        return set;
    }
};

module.exports = {
    getDb,
    initSchema,
    // Exported so the migration can be exercised directly; initSchema calls it.
    backfillStableIds,
    favorites
};
