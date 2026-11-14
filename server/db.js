const fs = require('fs');
const path = require('path');

/**
 * Sources, settings and users (0135, roadmap S4.3a).
 *
 * These used to live in data/db.json, an in-memory write-through cache of a
 * JSON file: every read handed out a deep copy of the whole database,
 * and every write rewrote the file. They now live in SQLite (content.db, the
 * same database as the library), in three tables created by db/sqlite.js:
 *
 *   app_sources   (id, data)             one row per source, the object as JSON
 *   app_users     (id, username, data)   one row per user, the object as JSON
 *   app_settings  (key, value)           one row per stored setting, JSON value
 *
 * plus `next_id` in the meta table (sources and users share one id counter,
 * as they did in db.json).
 *
 * A fresh install starts with the default settings. A data/db.json from before
 * 0135 is no longer imported: the server refuses to start beside one whose
 * contents were never moved in (D-57, services/dbMinimum.js).
 *
 * The API is unchanged: db.sources / db.settings / db.users, all async.
 *
 * Settings are on the hot path (streamAuthFromSettings reads them on every
 * media request, i.e. every HLS segment), so settings.get() returns ONE frozen
 * object, rebuilt only after a write: no clone per request. A caller that
 * needs to add to it copies it first ({ ...settings, extra }).
 *
 * A write that fails (disk full, read-only volume) is rolled back by SQLite's
 * transaction, the in-memory settings are left as they were, and the caller
 * gets a plain sentence; the raw error (which can name a file path) stays in
 * the log and on .cause.
 */

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Default settings
function getDefaultSettings() {
  return {
    arrowKeysChangeChannel: true,
    lastVolume: 80,
    epgRefreshInterval: '24',
    // User-Agent settings
    userAgentPreset: 'chrome',    // chrome | vlc | tivimate | custom
    userAgentCustom: '',          // Custom UA string when preset is 'custom'
    // Transcoding settings
    hwEncoder: 'auto',            // auto | nvenc | amf | qsv | vaapi | software
    // Security
    // Hardware transcoding workarounds
    vaapiCpuScale: true,           // CPU scale + hwupload, instead of the full-GPU VAAPI pipeline
    ingestReconnectRenewal: false, // FR-22: experimental; requires relay + shared ingest, device acceptance pending
    relayEnabled: false,           // R12: in-stream recovery (services/streamRelay.js), experimental
    standbyEnabled: false,         // R12: the hot standby; only effective while relayEnabled is on
    sharedIngestEnabled: true,     // Wave 5 (R2): one provider connection per stream, shared (docs/SHARED-INGEST.md)
    vaapiHwDecode: true,           // Decode on the GPU (frames returned to system memory for the CPU scale)
    // DVR / Recording settings
    recordingsPath: '/app/recordings', // Where recorded files are written (mount your storage here)
    defaultPreBufferMin: 1,        // Minutes to start recording before the scheduled program start
    defaultPostBufferMin: 5,       // Minutes to keep recording after the scheduled program end
    maxConcurrentRecordings: 1,    // Safety cap on simultaneous recordings
    minFreeSpaceGB: 10,            // Refuse to start (and stop) recordings below this much free space
    segmentedRecordings: true,     // R3: record as segments in appdata (watch from the start), MP4 to the share at the end.
                                   // Always on since 0494 (Mark, 8 Nov): no toggle; false is for tests of the old path only
    // Provider stream coordination
    maxProviderStreams: 1,         // How many simultaneous connections the provider allows
    viewerIdleTimeoutSec: 60,      // Silence after which a stream is treated as abandoned
    recordingPromptLeadMin: 5,     // How far ahead a viewer is warned about a due recording
    recordingPromptTimeoutMin: 3,  // No answer this long after the recording is due: it takes the stream
    warmNextChannel: false,        // Start the channel a viewer will probably play next on a spare provider connection (R11)
    // Commercial break detection
    adDetectionEnabled: false,     // Analyse finished recordings for advert breaks
    adAutoSkip: false,             // Skip detected breaks automatically during playback
    // Compression, applied on request from the Recordings page rather than
    // automatically: the space is already spent by the time a recording
    // finishes, and most recordings are watched and deleted. Compressing is
    // worth the GPU time only for something being kept.
    postRecordCodec: 'h264',       // 'h264' (compatible) or 'hevc' (smaller)
    postRecordBitrateKbps: 3000,   // Target video bitrate
    postRecordKeepOriginal: false, // Keep the untouched original alongside the result
    // R11 (0215): notifications (services/notify.js); empty = off. Shown to admins only.
    notifyWebhookUrl: '',
    notifyWebhookFormat: 'json',   // 'json' (Home Assistant and most tools) or 'text' (ntfy)
    // R8 (0217, pilot): { "<sourceId>": [live category ids never imported] }; edited via the
    // guarded /api/sources/:id/import-exclusions only.
    importExclusions: {}
  };
}

// User-Agent presets
const USER_AGENT_PRESETS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  vlc: 'VLC/3.0.20 LibVLC/3.0.20',
  tivimate: 'TiviMate/4.7.0',
};

function getUserAgent(settings) {
  if (settings.userAgentPreset === 'custom' && settings.userAgentCustom) {
    return settings.userAgentCustom;
  }
  return USER_AGENT_PRESETS[settings.userAgentPreset] || USER_AGENT_PRESETS.chrome;
}

// ---------------------------------------------------------------- storage --

let ready = false;

// 0285: settings no code reads any more (retiredSettings.js): never saved again (an older client may still send them).
const RETIRED_SETTINGS = require('./retiredSettings');

// 0494 (Mark, 8 Nov): every recording is segmented (it resumes after a restart or failover, and can be watched from the
// start). Once per database, a stored "off" is dropped so the default (on) applies; the web no longer offers the switch.

function segmentedAlways(db) {
  if (metaGet(db, 'segmented_always')) return;
  const gone = db.prepare(`DELETE FROM app_settings WHERE key = 'segmentedRecordings'`).run().changes;
  metaSet(db, 'segmented_always', new Date().toISOString());
  if (gone) console.log('[Settings] Segmented recordings are always on now (the stored switch was removed)');
}

/** The SQLite handle, with the first start's setup done. */
function store() {
  const db = require('./db/sqlite').getDb();
  if (!ready) {
    firstStart(db);
    segmentedAlways(db);
    ready = true;
  }
  return db;
}

const metaGet = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const metaSet = (db, key, value) => db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, String(value));

/**
 * A new database's first start: the default settings are stored and the id counter starts at 1, once
 * (meta `app_data_migrated`, the name it has had since 0135, when this step also imported db.json).
 */
function firstStart(db) {
  if (metaGet(db, 'app_data_migrated')) return;
  const insertSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries(getDefaultSettings())) {
      if (value !== undefined) insertSetting.run(key, JSON.stringify(value));
    }
    metaSet(db, 'next_id', 1);
    metaSet(db, 'app_data_migrated', `fresh ${new Date().toISOString()}`);
  })();
}

/** Run `fn` in a transaction; a failure becomes the plain sentence a client may be shown. */
function write(fn) {
  const db = store();
  try {
    return db.transaction(() => fn(db))();
  } catch (err) {
    if (err && err.userFacing) throw err;
    console.error('Error writing database:', err);
    throw new Error('The server could not save its data (is the disk full or read-only?)', { cause: err });
  }
}

/** An error meant for the caller as it is (e.g. "Username already exists"). */
const refuse = (message) => Object.assign(new Error(message), { userFacing: true });

function takeId(db) {
  const id = parseInt(metaGet(db, 'next_id') || '1', 10) || 1;
  metaSet(db, 'next_id', id + 1);
  return id;
}

const parseRow = (row) => (row ? JSON.parse(row.data) : undefined);
// 0168: a non-EPG source stored with no role reads as a primary (nothing is rewritten).
const { withDefaults } = require('./services/providerFields');
const parseSource = (row) => withDefaults(parseRow(row));

// ---------------------------------------------------------------- sources --

// I-4 (#273): the coordinator's pools, the failover plan and the Status page ask about the providers
// several times per play. They read ONE parsed, deep-frozen list (listParsed), kept per database handle
// (a re-opened handle reads afresh) and dropped before and after every write below, so a failed write
// or a reader in between can never keep a stale list. A read-only worker connection never caches it
// (the main thread writes). getAll/getById still hand out fresh objects a route may change.
let sourceList = null;
let sourceListDb = null;
const dropSourceList = () => { sourceList = null; sourceListDb = null; };

/** A source write: the cached list is dropped before it and again once it has committed (or failed). */
function writeSources(fn) {
  dropSourceList();
  try {
    return write(fn);
  } finally {
    dropSourceList();
  }
}

const sources = {
  /**
   * Every source (EPG ones included) in id order, with its role filled in (withDefaults), as one
   * deep-frozen array: the same array until a source is written. Synchronous. A row whose JSON
   * cannot be read is left out, as the coordinator and the failover plan have always done. Copy
   * before changing anything (it is frozen); routes that edit a source use getAll/getById.
   */
  listParsed() {
    const db = require('./db/sqlite').getDb();
    if (sourceList && sourceListDb === db) return sourceList;
    const list = [];
    for (const r of db.prepare('SELECT data FROM app_sources ORDER BY id').all()) {
      let s;
      try { s = withDefaults(JSON.parse(r.data)); } catch { continue; }
      if (s) list.push(s);
    }
    deepFreeze(list);
    if (!db.readonly) { sourceList = list; sourceListDb = db; }
    return list;
  },

  async getAll() {
    return store().prepare('SELECT data FROM app_sources ORDER BY id').all().map(parseSource);
  },

  async getById(id) {
    return parseSource(store().prepare('SELECT data FROM app_sources WHERE id = ?').get(parseInt(id)));
  },

  async create(source) {
    return writeSources((db) => {
      const newSource = {
        ...source,
        id: takeId(db), // always the counter's: the row's key
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.prepare('INSERT INTO app_sources (id, data) VALUES (?, ?)').run(newSource.id, JSON.stringify(newSource));
      return withDefaults(newSource);
    });
  },

  async update(id, updates) {
    const key = parseInt(id);
    return writeSources((db) => {
      const current = parseRow(db.prepare('SELECT data FROM app_sources WHERE id = ?').get(key));
      if (!current) return null;
      const updated = { ...current, ...updates, id: current.id, updated_at: new Date().toISOString() };
      db.prepare('UPDATE app_sources SET data = ? WHERE id = ?').run(JSON.stringify(updated), key);
      return withDefaults(updated);
    });
  },

  async delete(id) {
    writeSources((db) => { db.prepare('DELETE FROM app_sources WHERE id = ?').run(parseInt(id)); });
  },

  /** 0182: the role and failover place of every provider, saved together: [{ id, role, priority }]. */
  async setOrder(places) {
    writeSources((db) => {
      const read = db.prepare('SELECT data FROM app_sources WHERE id = ?');
      const save = db.prepare('UPDATE app_sources SET data = ? WHERE id = ?');
      for (const p of places) {
        const current = parseRow(read.get(p.id));
        if (!current) continue;
        save.run(JSON.stringify({ ...current, role: p.role, priority: p.priority, updated_at: new Date().toISOString() }), p.id);
      }
    });
  },

  async toggleEnabled(id) {
    const key = parseInt(id);
    return writeSources((db) => {
      const source = parseRow(db.prepare('SELECT data FROM app_sources WHERE id = ?').get(key));
      if (!source) return source;
      source.enabled = !source.enabled;
      source.updated_at = new Date().toISOString();
      db.prepare('UPDATE app_sources SET data = ? WHERE id = ?').run(JSON.stringify(source), key);
      return withDefaults(source);
    });
  }
};

// --------------------------------------------------------------- settings --

// The merged, frozen settings object settings.get() hands out; null = rebuild.
let settingsCache = null;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function storedSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM app_settings').all()) {
    // #322: a retired setting an older server stored is never handed out (nothing deletes it at start-up, D-57).
    if (RETIRED_SETTINGS.includes(r.key)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* a corrupt value falls back to its default */ }
  }
  return out;
}

const settings = {
  /** The defaults with the stored values over them: one frozen object, rebuilt only after a write. */
  async get() {
    if (!settingsCache) {
      const merged = { ...getDefaultSettings(), ...storedSettings(store()) };
      // 0494 Codex round 1 (high): always on; a stored or restored "off" never counts.
      merged.segmentedRecordings = true;
      settingsCache = deepFreeze(merged);
    }
    return settingsCache;
  },

  async update(newSettings) {
    try {
      return write((db) => {
        const upsert = db.prepare(`
          INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        for (const [key, value] of Object.entries(newSettings || {})) {
          if (key === 'segmentedRecordings') continue; // 0494: not a setting any more
          if (value !== undefined && !RETIRED_SETTINGS.includes(key)) upsert.run(key, JSON.stringify(value));
        }
        return storedSettings(db);
      });
    } finally {
      settingsCache = null;
    }
  }
};

// ------------------------------------------------------------------ users --

const withoutHash = ({ passwordHash, ...rest }) => rest;

// I-1 (#273): every authenticated request looks its user up, so that statement is prepared once
// per database handle (a re-opened handle gets its own). Still a live read every time.
let byIdStmt = null;
let byIdDb = null;
function userByIdStatement(db) {
  if (byIdDb !== db) {
    byIdStmt = db.prepare('SELECT data FROM app_users WHERE id = ?');
    byIdDb = db;
  }
  return byIdStmt;
}

const users = {
  async getAll() {
    return store().prepare('SELECT data FROM app_users ORDER BY id').all().map(parseRow);
  },

  async getById(id) {
    return parseRow(userByIdStatement(store()).get(parseInt(id)));
  },

  async getByUsername(username) {
    return parseRow(store().prepare('SELECT data FROM app_users WHERE username = ? ORDER BY id LIMIT 1').get(String(username)));
  },

  async create(userData) {
    return write((db) => {
      if (db.prepare('SELECT 1 FROM app_users WHERE username = ?').get(String(userData.username))) {
        throw refuse('Username already exists');
      }
      const newUser = {
        id: takeId(db),
        username: userData.username,
        passwordHash: userData.passwordHash || null,
        role: userData.role || 'viewer',
        email: userData.email || null,
        createdAt: new Date().toISOString()
      };
      db.prepare('INSERT INTO app_users (id, username, data) VALUES (?, ?, ?)')
        .run(newUser.id, String(newUser.username), JSON.stringify(newUser));
      // Return user without password hash
      return withoutHash(newUser);
    });
  },

  async update(id, updates) {
    const key = parseInt(id);
    return write((db) => {
      const current = parseRow(db.prepare('SELECT data FROM app_users WHERE id = ?').get(key));
      if (!current) throw refuse('User not found');
      // Check if username is being changed and if it already exists
      if (updates.username && updates.username !== current.username &&
          db.prepare('SELECT 1 FROM app_users WHERE username = ?').get(String(updates.username))) {
        throw refuse('Username already exists');
      }
      const updated = { ...current, ...updates, id: current.id, updatedAt: new Date().toISOString() };
      db.prepare('UPDATE app_users SET username = ?, data = ? WHERE id = ?')
        .run(String(updated.username), JSON.stringify(updated), key);
      // Return user without password hash
      return withoutHash(updated);
    });
  },

  async delete(id) {
    const key = parseInt(id);
    return write((db) => {
      const user = parseRow(db.prepare('SELECT data FROM app_users WHERE id = ?').get(key));
      if (!user) throw refuse('User not found');
      // Prevent deleting the last admin
      if (user.role === 'admin') {
        const admins = db.prepare('SELECT data FROM app_users').all().map(parseRow).filter(u => u.role === 'admin').length;
        if (admins <= 1) throw refuse('Cannot delete the last admin user');
      }
      db.prepare('DELETE FROM app_users WHERE id = ?').run(key);
      // #300: their paired devices go too (rows and pending last-seen entries), so no token of theirs outlives them.
      require('./services/deviceAuth').removeUserDevices(key);
      return true;
    });
  },

  async count() {
    return store().prepare('SELECT COUNT(*) AS n FROM app_users').get().n;
  }
};

module.exports = { sources, settings, users, getDefaultSettings, getUserAgent, USER_AGENT_PRESETS, RETIRED_SETTINGS };
