const fs = require('fs/promises');
const path = require('path');
const { existsSync, mkdirSync } = require('fs');

// Ensure data directory exists (sync is fine for startup)
const dataDir = path.join(__dirname, '..', 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.json');

// In-memory write-through cache of db.json. loadDb() reads the file once, then
// serves clones from here; saveDb() keeps it authoritative. db.json is on the
// hot path - streamAuthFromSettings calls settings.get() on every media
// request (every HLS segment) - so re-reading and re-parsing the file each
// time is pure overhead. (Trade-off: a manual edit of db.json on disk is not
// picked up until restart.)
let cachedDb = null;

// Initialize database structure
async function loadDb() {
  // Serve from cache once seeded.
  if (cachedDb) return structuredClone(cachedDb);
  try {
    // Check if file exists (using fs.access is better for async, but we can catch ENOENT)
    try {
      const fileContent = await fs.readFile(dbPath, 'utf-8');
      const data = JSON.parse(fileContent);
      cachedDb = {
        sources: data.sources || [],
        settings: data.settings || getDefaultSettings(),
        users: data.users || [],
        nextId: data.nextId || 1
      };
      // Hand callers their own copy so a mutate-then-save cycle can't corrupt
      // the cache mid-flight.
      return structuredClone(cachedDb);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist (fresh install); seed the cache with the default
        // so the first saveDb writes it out.
        cachedDb = {
          sources: [],
          settings: getDefaultSettings(),
          users: [],
          nextId: 1
        };
        return structuredClone(cachedDb);
      }
      throw error;
    }
  } catch (err) {
    console.error('Error loading database:', err);
    // A transient read/parse failure must not poison the cache: leave it
    // unseeded so the next call retries the disk, and return a safe default.
    return {
      sources: [],
      settings: getDefaultSettings(),
      users: [],
      nextId: 1
    };
  }
}

// Default settings
function getDefaultSettings() {
  return {
    arrowKeysChangeChannel: true,
    overlayDuration: 5,
    defaultVolume: 80,
    rememberVolume: true,
    lastVolume: 80,
    autoPlayNextEpisode: false,
    forceProxy: false,
    forceTranscode: false, // Force Audio Transcode
    forceVideoTranscode: false, // Force Video Transcode
    forceRemux: false,
    autoTranscode: true,
    streamFormat: 'm3u8',
    epgRefreshInterval: '24',
    // User-Agent settings
    userAgentPreset: 'chrome',    // chrome | vlc | tivimate | custom
    userAgentCustom: '',          // Custom UA string when preset is 'custom'
    // Transcoding settings
    hwEncoder: 'auto',            // auto | nvenc | amf | qsv | vaapi | software
    maxResolution: '1080p',       // 4k | 1080p | 720p | 480p
    quality: 'medium',            // high | medium | low
    audioMixPreset: 'auto',       // auto | itu | night | cinematic | passthrough
    // Probe cache settings  
    probeCacheTTL: 300,           // 5 minutes for URL probe cache
    seriesProbeCacheDays: 7,       // 7 days for series episode probe cache
    // Upscaling settings
    upscaleEnabled: false,
    upscaleMethod: 'hardware',    // hardware | software
    upscaleTarget: '1080p',       // 1080p | 4k | 720p
    // Security
    requireStreamAuth: false,      // Require a token on stream endpoints (off: LAN-friendly)
    // UI visibility
    showMovies: true,              // Show Movies tab and Home section
    showSeries: true,              // Show Series tab and Home section
    // Hardware transcoding workarounds
    vaapiCpuScale: true,           // CPU scale + hwupload, instead of the full-GPU VAAPI pipeline
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

// Write lock to prevent concurrent writes from corrupting db.json
let writeQueue = Promise.resolve();
const tmpPath = dbPath + '.tmp';

async function saveDb(data) {
  // Update the cache first so subsequent reads see the new state immediately,
  // independent of when the queued disk write lands.
  cachedDb = structuredClone(data);
  // Queue this write operation - each write waits for the previous one
  writeQueue = writeQueue.then(async () => {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      // Atomic write: write to temp file, then rename
      // Rename is atomic on most filesystems, preventing corruption on crash
      await fs.writeFile(tmpPath, jsonString);
      await fs.rename(tmpPath, dbPath);
    } catch (err) {
      console.error('Error writing database:', err);
      // Clean up temp file if it exists
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }).catch(err => {
    console.error('Database write failed:', err);
  });

  return writeQueue;
}

// Source CRUD operations
const sources = {
  async getAll() {
    const db = await loadDb();
    return db.sources;
  },

  async getById(id) {
    const db = await loadDb();
    return db.sources.find(s => s.id === parseInt(id));
  },

  async getByType(type) {
    const db = await loadDb();
    return db.sources.filter(s => s.type === type && s.enabled);
  },

  async create(source) {
    const db = await loadDb();
    const newSource = {
      id: db.nextId++,
      ...source,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.sources.push(newSource);
    await saveDb(db);
    return newSource;
  },

  async update(id, updates) {
    const db = await loadDb();
    const index = db.sources.findIndex(s => s.id === parseInt(id));
    if (index === -1) return null;

    db.sources[index] = {
      ...db.sources[index],
      ...updates,
      updated_at: new Date().toISOString()
    };
    await saveDb(db);
    return db.sources[index];
  },

  async delete(id) {
    const db = await loadDb();
    db.sources = db.sources.filter(s => s.id !== parseInt(id));
    await saveDb(db);
  },

  async toggleEnabled(id) {
    const db = await loadDb();
    const source = db.sources.find(s => s.id === parseInt(id));
    if (source) {
      source.enabled = !source.enabled;
      source.updated_at = new Date().toISOString();
      await saveDb(db);
    }
    return source;
  }
};

// Settings operations
const settings = {
  async get() {
    const db = await loadDb();
    return { ...getDefaultSettings(), ...db.settings };
  },

  async update(newSettings) {
    const db = await loadDb();
    db.settings = { ...db.settings, ...newSettings };
    await saveDb(db);
    return db.settings;
  },

  async reset() {
    const db = await loadDb();
    db.settings = getDefaultSettings();
    await saveDb(db);
    return db.settings;
  }
};

// User operations
const users = {
  async getAll() {
    const db = await loadDb();
    return db.users || [];
  },

  async getById(id) {
    const db = await loadDb();
    return db.users?.find(u => u.id === parseInt(id));
  },

  async getByUsername(username) {
    const db = await loadDb();
    return db.users?.find(u => u.username === username);
  },

  async create(userData) {
    const db = await loadDb();
    if (!db.users) {
      db.users = [];
    }

    // Check if username already exists
    if (db.users.some(u => u.username === userData.username)) {
      throw new Error('Username already exists');
    }

    const newUser = {
      id: db.nextId++,
      username: userData.username,
      passwordHash: userData.passwordHash || null,
      role: userData.role || 'viewer',
      email: userData.email || null,
      createdAt: new Date().toISOString()
    };

    db.users.push(newUser);
    await saveDb(db);

    // Return user without password hash
    const { passwordHash, ...userWithoutPassword } = newUser;
    return userWithoutPassword;
  },

  async update(id, updates) {
    const db = await loadDb();
    const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

    if (userIndex === -1 || userIndex === undefined) {
      throw new Error('User not found');
    }

    // Check if username is being changed and if it already exists
    if (updates.username && updates.username !== db.users[userIndex].username) {
      if (db.users.some(u => u.username === updates.username)) {
        throw new Error('Username already exists');
      }
    }

    db.users[userIndex] = {
      ...db.users[userIndex],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await saveDb(db);

    // Return user without password hash
    const { passwordHash, ...userWithoutPassword } = db.users[userIndex];
    return userWithoutPassword;
  },

  async delete(id) {
    const db = await loadDb();
    const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

    if (userIndex === -1 || userIndex === undefined) {
      throw new Error('User not found');
    }

    // Prevent deleting the last admin
    const user = db.users[userIndex];
    if (user.role === 'admin') {
      const adminCount = db.users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        throw new Error('Cannot delete the last admin user');
      }
    }

    db.users.splice(userIndex, 1);
    await saveDb(db);
    return true;
  },

  async count() {
    const db = await loadDb();
    return db.users?.length || 0;
  }
};

module.exports = { loadDb, saveDb, sources, settings, users, getDefaultSettings, getUserAgent, USER_AGENT_PRESETS };
