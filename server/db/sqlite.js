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

    // The tvg-id (EPG channel id), in its own column rather than buried in the
    // `data` JSON blob. The guide (0111) reads it for every row on every page,
    // and JSON.parse-ing `data` per row does not scale to the several thousand
    // channels a page can now ask for. Filled at ingest (syncService.js, both
    // the M3U and Xtream paths) and backfilled once at startup below for rows
    // that predate the column.
    try {
        db.exec('ALTER TABLE playlist_items ADD COLUMN tvg_id TEXT');
    } catch (e) {
        // Column already exists.
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_playlist_items_tvg ON playlist_items(tvg_id)');

    // A small persisted key/value store. Its first use is `library_rev`
    // (services/libraryRev.js), a counter bumped whenever something that
    // affects the guide changes, so a client can ask "did anything change?"
    // without depending on the current time.
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

    // The logo cache's lookup table (0112, roadmap S1.4). A row here is what
    // makes GET /api/logo/:key answer anything at all - the route is
    // unauthenticated, so this is what keeps it from being an open image
    // proxy. `key` is a hash of `url`; `content_type`/`fetched_at`/`bytes`
    // stay NULL until the logo has actually been fetched once.
    db.exec(`
        CREATE TABLE IF NOT EXISTS logo_cache (
            key TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            content_type TEXT,
            fetched_at INTEGER,
            bytes INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_logo_cache_url ON logo_cache(url);
    `);
    // 0154: the logo as fetched is kept beside the resized copy (routes/logo.js,
    // `?size=full` for the Apple TV Top Shelf): its type and size, NULL until then.
    for (const col of ['original_type TEXT', 'original_bytes INTEGER']) {
        try {
            db.exec(`ALTER TABLE logo_cache ADD COLUMN ${col}`);
        } catch (e) {
            // Column already exists.
        }
    }

    // Channel profiles (0114, roadmap S1.1): the resolve probe's analysis of a
    // channel, so a repeat play can skip ffprobe (services/channelProfiles.js).
    // `key` is a hash of URL + user agent + the client's capability key - the URL
    // carries provider credentials, so it is never stored here. `info` is the
    // analysis as JSON; `probed_at` decides its age, `last_ok_at` is the last
    // time a session played from it.
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_profiles (
            key TEXT PRIMARY KEY,
            info TEXT NOT NULL,
            probed_at INTEGER NOT NULL,
            last_ok_at INTEGER
        );
    `);

    // Channel numbers (0117, roadmap X2.1, contract C-A): one persisted number
    // per channel IDENTITY (source + stable_id, else item_id - the same key the
    // favourites use), so a number survives the provider reordering its playlist
    // and a channel cross-listed in two categories has one number.
    // `last_seen` is the last time the channel was visible; a channel that
    // disappears keeps its number for 30 days (services/channelNumbers.js).
    // `number` is UNIQUE across the server, whatever the source.
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_numbers (
            source_id INTEGER NOT NULL,
            channel_key TEXT NOT NULL,
            item_id TEXT,
            number INTEGER NOT NULL UNIQUE,
            last_seen INTEGER NOT NULL,
            PRIMARY KEY (source_id, channel_key)
        );
    `);

    // Sources, settings and users (0135, roadmap S4.3a), formerly data/db.json.
    // Objects are kept as JSON so their shape stays exactly what db.json held;
    // server/db.js owns them (and the one-time migration from db.json).
    // `username` is a column only for the lookup.
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_sources (
            id INTEGER PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username);
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // Channel health (0133, roadmap S4.1, contract C-G): one row per start
    // attempt, keyed like channel_numbers (source + stable_id, else item_id).
    // `ok` is 0 for a failed start; `reason` is its category (refused,
    // no-response, unavailable, player, error); `first_picture_sec` comes from
    // the client's play-start. Kept 30 days (services/channelHealth.js).
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_health (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            channel_key TEXT NOT NULL,
            name TEXT,
            at INTEGER NOT NULL,
            ok INTEGER NOT NULL,
            first_picture_sec REAL,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_channel_health_at ON channel_health(at);
        CREATE INDEX IF NOT EXISTS idx_channel_health_key ON channel_health(source_id, channel_key, at);
    `);
    // 0142: the play-end that closed the attempt - how long it was watched and
    // how many times it stalled. NULL until (unless) the client reports it.
    for (const col of ['stalls INTEGER', 'watched_sec REAL']) {
        try {
            db.exec(`ALTER TABLE channel_health ADD COLUMN ${col}`);
        } catch (e) {
            // Column already exists.
        }
    }

    // EPG matching (0134, roadmap S4.2): the admin's choice of EPG channel for a
    // playlist channel, keyed by identity like channel_numbers. Read at query
    // time over playlist_items.tvg_id (services/epgMapping.js); a sync never
    // writes here, so it cannot wipe a mapping.
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_mappings (
            source_id INTEGER NOT NULL,
            channel_key TEXT NOT NULL,
            tvg_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (source_id, channel_key)
        );
    `);

    // Sport categories (0146, contract C-H): the live categories an admin marked
    // as sport, for the Apple Home screen's "Sport on now" row. A row present =
    // sport. No sync writes here (services/sportCategories.js).
    db.exec(`
        CREATE TABLE IF NOT EXISTS sport_categories (
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (source_id, category_id)
        );
    `);

    // Sport follow list (0148, contract C-I): the admin's keywords ("NFL", "F1",
    // "Chiefs"), in the admin's order (the first that matches names the league).
    // Only services/sportsEvents.js writes it; no sync touches it.
    db.exec(`
        CREATE TABLE IF NOT EXISTS sports_follow (
            position INTEGER PRIMARY KEY,
            keyword TEXT NOT NULL
        );
    `);

    // Sport fixtures (0162, C-I): ESPN's real kickoff/session times, so live-vs-replay does not
    // have to guess from the guide alone (services/sportsFixtures.js). One row per competition
    // (an event, or one of an F1 event's sessions); `data` is the provider-shaped JSON record.
    // Kept in SQLite, not just memory, so a restart or an ESPN outage does not lose the last good
    // fetch - a stale row is still better than none until the next refresh succeeds.
    db.exec(`
        CREATE TABLE IF NOT EXISTS sport_fixtures (
            league TEXT NOT NULL,
            fixture_id TEXT NOT NULL,
            start INTEGER NOT NULL,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (league, fixture_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sport_fixtures_league_start ON sport_fixtures(league, start);
    `);
    // A league's team roster (names, for fuzzy matching against the guide), cached a day.
    db.exec(`
        CREATE TABLE IF NOT EXISTS sport_fixture_teams (
            league TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    // One row per league: the Status page's "Sport fixtures" panel, and why a league's fixtures
    // stopped updating. A failure keeps the league's last good fixtures/teams rows untouched.
    db.exec(`
        CREATE TABLE IF NOT EXISTS sport_fixture_status (
            league TEXT PRIMARY KEY,
            last_attempt_at INTEGER,
            last_success_at INTEGER,
            last_error TEXT,
            last_error_at INTEGER,
            fixture_count INTEGER
        );
    `);

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
    // 0147: the programme's XMLTV <category> values, as a JSON array of the
    // provider's own strings (trimmed, de-duplicated), NULL when it has none.
    // JSON so SQLite's json_each() can count them (GET /api/sports/categories)
    // and sport recognition (services/sportsEvents.js) reads them as a list.
    try {
        db.exec('ALTER TABLE epg_programs ADD COLUMN categories TEXT');
    } catch (e) {
        // Column already exists.
    }
    // 0152: the programme's XMLTV flags as a bitmask (services/epgParser.js
    // PROGRAMME_FLAGS: previously-shown 1, premiere 2, new 4, live 8), NULL when
    // it has none. Sport events use them to tell a live game from a replay.
    try {
        db.exec('ALTER TABLE epg_programs ADD COLUMN flags INTEGER');
    } catch (e) {
        // Column already exists.
    }
    // A view keeps the column list it was created with, so an epg_live made
    // before 0147 has no `categories` (before 0152 no `flags`): drop it and let
    // it be created again below.
    const liveView = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'epg_live'`).get();
    if (liveView && !(/p\.categories/.test(liveView.sql) && /p\.flags\b/.test(liveView.sql))) db.exec('DROP VIEW epg_live');
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_state (
            source_id INTEGER PRIMARY KEY,
            active_gen INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_epg_source_gen ON epg_programs(source_id, gen);
        CREATE VIEW IF NOT EXISTS epg_live AS
            SELECT p.id, p.channel_id, p.source_id, p.start_time, p.end_time, p.title, p.description, p.data, p.categories, p.flags
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

    // Which channel this watch was OF, for the same reason as favourites below:
    // channel_item_id is a playlist position and the position moves.
    try {
        db.exec('ALTER TABLE channel_history ADD COLUMN stable_id TEXT');
    } catch (e) {
        // Column already exists.
    }

    // Which channel this favourite is FOR, as opposed to which line of the playlist
    // it sat on when it was made. item_id stays, both as the fallback for a row whose
    // channel cannot be resolved and as a record of what was originally favourited.
    try {
        db.exec('ALTER TABLE favorites ADD COLUMN stable_id TEXT');
    } catch (e) {
        // Column already exists.
    }

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
    stripStoredBadges();
    backfillStableIds();
    backfillTvgIds();
    backfillFavoriteIdentities();
    backfillHistoryIdentities();

    console.log('[SQLite] Schema initialized');
}

// Where a name or title was stored before 0099 stripped the badge at ingest.
const BADGE_COLUMNS = [
    ['playlist_items', 'name'],
    ['epg_programs', 'title'],
    ['channel_history', 'channel_name'],
    ['scheduled_recordings', 'title'],
    ['scheduled_recordings', 'channel_name'],
    ['recordings', 'title'],
    ['recordings', 'channel_name']
];

/**
 * 0138: strip the small-caps "ᴸɪᴠᴇ" / "ɴᴇᴡ" badge (services/textCleanup.js,
 * 0099) from names and titles stored before ingest stripped it. Once per
 * database (meta `badge_cleanup`): everything written since is stripped on the
 * way in, and a sync replaces most of it anyway. Tables that do not exist yet
 * (the recording tables, before the engine first starts) are skipped; they are
 * only ever written by code that strips. A name that is ONLY a badge is kept.
 */
function stripStoredBadges() {
    if (db.prepare(`SELECT 1 FROM meta WHERE key = 'badge_cleanup'`).get()) return 0;
    const { stripBadgeSuffix } = require('../services/textCleanup');
    db.function('pigtv_strip_badge', { deterministic: true }, (v) => (typeof v === 'string' ? (stripBadgeSuffix(v) || v) : v));
    const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
    let changed = 0;
    db.transaction(() => {
        for (const [table, column] of BADGE_COLUMNS) {
            if (!tables.has(table)) continue;
            changed += db.prepare(`UPDATE ${table} SET ${column} = pigtv_strip_badge(${column})
                                   WHERE ${column} IS NOT NULL AND ${column} <> pigtv_strip_badge(${column})`).run().changes;
        }
        db.prepare(`INSERT INTO meta (key, value) VALUES ('badge_cleanup', ?)`).run(String(Date.now()));
    })();
    if (changed) console.log(`[SQLite] Removed the small-caps badge from ${changed} stored name(s) and title(s)`);
    return changed;
}

/**
 * Fill tvg_id for rows that predate the column, from the same `data` JSON the
 * guide used to JSON.parse on every request (0111). Only touches rows where
 * the column is still NULL, so it is a cheap indexed scan on an
 * already-migrated database and runs on every start rather than being
 * tracked as a one-off.
 */
function backfillTvgIds() {
    const rows = db.prepare("SELECT id, data FROM playlist_items WHERE tvg_id IS NULL AND data IS NOT NULL").all();
    if (!rows.length) return;

    const update = db.prepare('UPDATE playlist_items SET tvg_id = ? WHERE id = ?');
    let filled = 0;
    db.transaction(() => {
        for (const r of rows) {
            let tvgId = null;
            try {
                const d = JSON.parse(r.data);
                tvgId = d.tvgId || d.epg_channel_id || null;
            } catch { tvgId = null; }
            if (!tvgId) continue;
            update.run(tvgId, r.id);
            filled++;
        }
    })();
    if (filled) console.log(`[SQLite] Backfilled tvg_id for ${filled} of ${rows.length} playlist item(s)`);
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
 * The same for watch history. A stale row here is less harmful than a stale
 * favourite - it shows the wrong name in "recently watched" and plays the wrong
 * channel if tapped - but it is the same fault and the same fix.
 */
function backfillHistoryIdentities() {
    const rows = db.prepare(`
        SELECT h.rowid AS rid, p.stable_id
        FROM channel_history h
        JOIN playlist_items p ON p.source_id = h.source_id AND p.item_id = h.channel_item_id
        WHERE h.stable_id IS NULL AND p.stable_id IS NOT NULL
    `).all();
    if (!rows.length) return;
    const update = db.prepare('UPDATE channel_history SET stable_id = ? WHERE rowid = ?');
    db.transaction(() => { for (const r of rows) update.run(r.stable_id, r.rid); })();
    console.log(`[SQLite] Pointed ${rows.length} watch-history row(s) at a channel identity`);
}

/**
 * Point existing channel favourites at a channel identity rather than a playlist
 * position, by looking up the row they currently name.
 *
 * What this cannot do is undo drift that has already happened. A favourite made
 * before a reorder now names whatever moved into that position, and this records
 * exactly that - there is nothing left to say what was originally meant. It stops
 * the drift; it does not repair it. Worth re-checking favourites once after this
 * first runs.
 *
 * Only touches rows where stable_id is still NULL, so it is cheap on every start.
 */
function backfillFavoriteIdentities() {
    const rows = db.prepare(`
        SELECT f.id, p.stable_id
        FROM favorites f
        JOIN playlist_items p ON p.source_id = f.source_id AND p.item_id = f.item_id
        WHERE f.stable_id IS NULL AND p.stable_id IS NOT NULL
    `).all();
    if (!rows.length) return;

    const update = db.prepare('UPDATE favorites SET stable_id = ? WHERE id = ?');
    db.transaction(() => {
        for (const r of rows) update.run(r.stable_id, r.id);
    })();
    console.log(`[SQLite] Pointed ${rows.length} favourite(s) at a channel identity instead of a playlist position`);
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
/**
 * The identity of the channel a caller is naming, from whichever id it used.
 * Null when the channel is not in the playlist (an unknown id, or a source that
 * has not synced), in which case callers fall back to matching on item_id - the
 * behaviour before identities existed.
 */
function identityOf(sourceId, itemId, itemType = 'channel') {
    if (itemType !== 'channel') return null;
    const row = db.prepare(
        'SELECT stable_id FROM playlist_items WHERE source_id = ? AND item_id = ? LIMIT 1'
    ).get(sourceId, bareChannelId(itemId));
    return row?.stable_id || null;
}

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
        const stable = identityOf(sourceId, itemId, itemType);
        // item_id is still written: it says what was favourited at the time, and it
        // is what matching falls back to when the channel has no identity.
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type, stable_id)
            VALUES (?, ?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType, stable);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        if (itemType === 'channel') itemId = bareChannelId(itemId);
        const stable = identityOf(sourceId, itemId, itemType);
        // Unfavouriting a channel listed in two categories removes it from both:
        // they are one channel, and leaving the other copy starred would be a
        // button that visibly does nothing.
        const stmt = stable
            ? db.prepare(`DELETE FROM favorites WHERE user_id = ? AND source_id = ? AND item_type = ?
                            AND ((stable_id IS NOT NULL AND stable_id = ?) OR (stable_id IS NULL AND item_id = ?))`)
            : db.prepare('DELETE FROM favorites WHERE user_id = ? AND source_id = ? AND item_type = ? AND stable_id IS NULL AND item_id = ?');
        const result = stable
            ? stmt.run(userId, sourceId, itemType, stable, itemId)
            : stmt.run(userId, sourceId, itemType, itemId);
        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        if (itemType === 'channel') itemId = bareChannelId(itemId);
        const stable = identityOf(sourceId, itemId, itemType);
        // Either spelling counts: the identity for anything favourited since this
        // shipped, the stored item_id for rows that predate it or have no identity.
        const row = stable
            ? db.prepare(`SELECT 1 FROM favorites WHERE user_id = ? AND source_id = ? AND item_type = ?
                            AND ((stable_id IS NOT NULL AND stable_id = ?) OR (stable_id IS NULL AND item_id = ?))`)
                .get(userId, sourceId, itemType, stable, itemId)
            : db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND source_id = ? AND item_type = ? AND stable_id IS NULL AND item_id = ?')
                .get(userId, sourceId, itemType, itemId);
        return !!row;
    },

    // Get all favorites for a user, grouped by type (for bulk checks)
    getAllAsSet(userId) {
        const db = getDb();
        const rows = db.prepare('SELECT source_id, item_id, item_type, stable_id FROM favorites WHERE user_id = ?').all(userId);
        const set = new Set();
        for (const row of rows) {
            // Identity when there is one; the stored item_id only for rows without,
            // because a row that has an identity carries a position that may since
            // have come to mean a different channel.
            if (row.stable_id) set.add(`${row.source_id}:${row.stable_id}:${row.item_type}`);
            else set.add(`${row.source_id}:${row.item_id}:${row.item_type}`);
        }
        return set;
    }
};

module.exports = {
    getDb,
    initSchema,
    // Exported so the migrations can be exercised directly; initSchema calls them.
    backfillStableIds,
    backfillTvgIds,
    backfillFavoriteIdentities,
    backfillHistoryIdentities,
    stripStoredBadges,
    favorites
};
