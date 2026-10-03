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
 * The first time this module touches the database, a data/db.json left by an
 * older version is copied in (one transaction) and renamed db.json.migrated,
 * which stays as the backup. A fresh install starts with the default settings.
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
const legacyPath = path.join(dataDir, 'db.json');
const migratedPath = legacyPath + '.migrated';

// Default settings
function getDefaultSettings() {
  return {
    arrowKeysChangeChannel: true,
    overlayDuration: 5,
    defaultVolume: 80,
    rememberVolume: true,
    lastVolume: 80,
    epgRefreshInterval: '24',
    // User-Agent settings
    userAgentPreset: 'chrome',    // chrome | vlc | tivimate | custom
    userAgentCustom: '',          // Custom UA string when preset is 'custom'
    // Transcoding settings
    hwEncoder: 'auto',            // auto | nvenc | amf | qsv | vaapi | software
    maxResolution: '1080p',       // 4k | 1080p | 720p | 480p
    quality: 'medium',            // high | medium | low
    audioMixPreset: 'auto',       // auto | itu | night | cinematic | passthrough
    // Upscaling settings
    upscaleEnabled: false,
    upscaleMethod: 'hardware',    // hardware | software
    upscaleTarget: '1080p',       // 1080p | 4k | 720p
    // Security
    // Hardware transcoding workarounds
    vaapiCpuScale: true,           // CPU scale + hwupload, instead of the full-GPU VAAPI pipeline
    relayEnabled: false,           // R12: in-stream recovery (services/streamRelay.js), experimental
    standbyEnabled: false,         // R12: the hot standby; only effective while relayEnabled is on
    vaapiHwDecode: true,           // Decode on the GPU (frames returned to system memory for the CPU scale)
    // DVR / Recording settings
    recordingsPath: '/app/recordings', // Where recorded files are written (mount your storage here)
    defaultPreBufferMin: 1,        // Minutes to start recording before the scheduled program start
    defaultPostBufferMin: 5,       // Minutes to keep recording after the scheduled program end
    maxConcurrentRecordings: 1,    // Safety cap on simultaneous recordings
    minFreeSpaceGB: 10,            // Refuse to start (and stop) recordings below this much free space
    // Provider stream coordination
    maxProviderStreams: 1,         // How many simultaneous connections the provider allows
    viewerIdleTimeoutSec: 60,      // Silence after which a stream is treated as abandoned
    recordingPromptLeadMin: 5,     // How far ahead a viewer is warned about a due recording
    recordingPromptTimeoutMin: 3,  // No answer this long after the recording is due: it takes the stream
    // Commercial break detection
    adDetectionEnabled: false,     // Analyse finished recordings for advert breaks
    adAutoSkip: false,             // Skip detected breaks automatically during playback
    comskipIniPath: '',            // Override the bundled Comskip tuning
    // Compression, applied on request from the Recordings page rather than
    // automatically: the space is already spent by the time a recording
    // finishes, and most recordings are watched and deleted. Compressing is
    // worth the GPU time only for something being kept.
    postRecordCodec: 'h264',       // 'h264' (compatible) or 'hevc' (smaller)
    postRecordBitrateKbps: 3000,   // Target video bitrate
    postRecordKeepOriginal: false  // Keep the untouched original alongside the result
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

/** The SQLite handle, with the one-time db.json migration done. */
function store() {
  const db = require('./db/sqlite').getDb();
  if (!ready) {
    migrateLegacy(db);
    ready = true;
  }
  return db;
}

const metaGet = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const metaSet = (db, key, value) => db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, String(value));

/**
 * Copy an older data/db.json into SQLite once, then rename it db.json.migrated
 * (kept as the backup). `app_data_migrated` in meta records that it happened,
 * so a db.json that reappears later (a restored backup) is never merged in on
 * top of what the server has since saved; it is reported instead.
 */
function migrateLegacy(db) {
  if (metaGet(db, 'app_data_migrated')) {
    if (fs.existsSync(legacyPath)) {
      console.warn('[DB] data/db.json is present but its contents were moved into SQLite before; it is ignored');
    }
    return;
  }

  let legacy = null;
  if (fs.existsSync(legacyPath)) {
    // A file that cannot be read or parsed stops the server here rather than
    // starting it with no sources and no users, which would look like data loss.
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  }

  const sources = Array.isArray(legacy?.sources) ? legacy.sources : [];
  const users = Array.isArray(legacy?.users) ? legacy.users : [];
  const settings = legacy?.settings && typeof legacy.settings === 'object' ? legacy.settings : getDefaultSettings();
  const maxId = Math.max(0, ...sources.map(s => Number(s.id) || 0), ...users.map(u => Number(u.id) || 0));
  const nextId = Math.max(Number(legacy?.nextId) || 1, maxId + 1);

  const insertSource = db.prepare('INSERT OR REPLACE INTO app_sources (id, data) VALUES (?, ?)');
  const insertUser = db.prepare('INSERT OR REPLACE INTO app_users (id, username, data) VALUES (?, ?, ?)');
  const insertSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const s of sources) {
      const id = Number(s.id);
      if (!Number.isInteger(id)) continue;
      insertSource.run(id, JSON.stringify({ ...s, id }));
    }
    for (const u of users) {
      const id = Number(u.id);
      if (!Number.isInteger(id)) continue;
      insertUser.run(id, String(u.username ?? ''), JSON.stringify({ ...u, id }));
    }
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) insertSetting.run(key, JSON.stringify(value));
    }
    metaSet(db, 'next_id', nextId);
    metaSet(db, 'app_data_migrated', legacy ? `db.json ${new Date().toISOString()}` : `fresh ${new Date().toISOString()}`);
  })();

  if (legacy) {
    // The hidden-items / favourites arrays of very old files are not copied:
    // nothing has read them for a long time (both live in SQLite already).
    try {
      fs.renameSync(legacyPath, migratedPath);
    } catch (err) {
      console.warn('[DB] Moved db.json into SQLite but could not rename it:', err.message);
    }
    console.log(`[DB] Moved db.json into SQLite: ${sources.length} source(s), ${users.length} user(s), ` +
      `${Object.keys(settings).length} setting(s); the old file is kept as db.json.migrated`);
  }
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

const sources = {
  async getAll() {
    return store().prepare('SELECT data FROM app_sources ORDER BY id').all().map(parseSource);
  },

  async getById(id) {
    return parseSource(store().prepare('SELECT data FROM app_sources WHERE id = ?').get(parseInt(id)));
  },

  async getByType(type) {
    return (await sources.getAll()).filter(s => s.type === type && s.enabled);
  },

  async create(source) {
    return write((db) => {
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
    return write((db) => {
      const current = parseRow(db.prepare('SELECT data FROM app_sources WHERE id = ?').get(key));
      if (!current) return null;
      const updated = { ...current, ...updates, id: current.id, updated_at: new Date().toISOString() };
      db.prepare('UPDATE app_sources SET data = ? WHERE id = ?').run(JSON.stringify(updated), key);
      return withDefaults(updated);
    });
  },

  async delete(id) {
    write((db) => { db.prepare('DELETE FROM app_sources WHERE id = ?').run(parseInt(id)); });
  },

  /** 0182: the role and failover place of every provider, saved together: [{ id, role, priority }]. */
  async setOrder(places) {
    write((db) => {
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
    return write((db) => {
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
    try { out[r.key] = JSON.parse(r.value); } catch { /* a corrupt value falls back to its default */ }
  }
  return out;
}

const settings = {
  /** The defaults with the stored values over them: one frozen object, rebuilt only after a write. */
  async get() {
    if (!settingsCache) settingsCache = deepFreeze({ ...getDefaultSettings(), ...storedSettings(store()) });
    return settingsCache;
  },

  async update(newSettings) {
    try {
      return write((db) => {
        const upsert = db.prepare(`
          INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        for (const [key, value] of Object.entries(newSettings || {})) {
          if (value !== undefined) upsert.run(key, JSON.stringify(value));
        }
        return storedSettings(db);
      });
    } finally {
      settingsCache = null;
    }
  },

  async reset() {
    try {
      return write((db) => {
        db.prepare('DELETE FROM app_settings').run();
        const insert = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
        const defaults = getDefaultSettings();
        for (const [key, value] of Object.entries(defaults)) insert.run(key, JSON.stringify(value));
        return defaults;
      });
    } finally {
      settingsCache = null;
    }
  }
};

// ------------------------------------------------------------------ users --

const withoutHash = ({ passwordHash, ...rest }) => rest;

const users = {
  async getAll() {
    return store().prepare('SELECT data FROM app_users ORDER BY id').all().map(parseRow);
  },

  async getById(id) {
    return parseRow(store().prepare('SELECT data FROM app_users WHERE id = ?').get(parseInt(id)));
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
      return true;
    });
  },

  async count() {
    return store().prepare('SELECT COUNT(*) AS n FROM app_users').get().n;
  }
};

module.exports = { sources, settings, users, getDefaultSettings, getUserAgent, USER_AGENT_PRESETS };
