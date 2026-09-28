const express = require('express');
require('dotenv').config();
const path = require('path');
const compression = require('compression');
const { shouldCompress } = require('./services/compressionFilter');
const syncService = require('./services/syncService');

// Initialize database
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For, etc.)
// Required for correct protocol detection behind reverse proxies (nginx, Caddy, etc.)
app.set('trust proxy', true);
// Express 5 (0137) parses query strings with the 'simple' parser by default;
// keep Express 4's.
app.set('query parser', 'extended');

// Middleware
// Gzip JSON and the small set of text asset types (0108). `filter` is an
// allow-list (server/services/compressionFilter.js): HLS playlists/segments,
// recording media and anything requested with a Range header are never
// compressed, so those responses stay byte-identical. Placed before the
// routes and static files so both get it.
app.use(compression({ filter: shouldCompress }));

// The largest legitimate body is a bulk hide/show list of channel ids (a few
// hundred KB for a very large playlist); 50 MB was never needed and let any
// client make the server buffer and parse that much JSON.
app.use(express.json({ limit: '2mb' }));
// Express 5 (0137) leaves req.body undefined when a request has no JSON body
// (Express 4 set {}); the routes destructure it, so keep it an object.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Authentication is stateless (JWT bearer tokens, verified in server/auth.js), so
// there is deliberately no server-side session store: nothing to grow with
// cookieless requests, and nothing to lose on a restart.

// HTML is always revalidated so a redeploy's new page (and the new ?v= script
// URLs inside it) reaches the browser without a hard reload. Scripts and CSS
// carry ?v= versions and may cache as before (0125).
const noCacheHtml = (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
};
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: noCacheHtml }));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        console.log('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        console.log('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        console.warn('FFmpeg not available - playback and recording will be disabled.');
        console.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

function findFFprobe() {
    // Try system ffprobe first
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        console.log('FFprobe binary configured at: ffprobe (system)');
        return 'ffprobe';
    } catch (e) {
        // Not found in system
    }

    // Try @ffprobe-installer/ffprobe package
    try {
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (ffprobePath) {
            console.log('FFprobe binary configured at:', ffprobePath);
            return ffprobePath;
        }
    } catch (err) {
        // Package not available
    }

    console.warn('FFprobe not available - auto transcode will fallback to always transcode');
    return null;
}

app.locals.ffmpegPath = findFFmpeg();
app.locals.ffprobePath = findFFprobe();

// Graceful shutdown: give any in-progress recordings a chance to close their
// file cleanly before the process is killed. (The plugin loader that used to
// share this handler, and the services map it was handed, went in 0122.)
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, stopping active recordings...');
    try {
        const recordingEngine = require('./services/recordingEngine');
        await recordingEngine.stopAllActive();
    } catch (err) {
        console.error('Error stopping active recordings:', err.message);
    }
    process.exit(0);
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
// Stream endpoints accept a token in the query string, because media players
// cannot send headers. Enforcement is off unless requireStreamAuth is set.
const streamAuth = require('./auth').streamAuthFromSettings(require('./db'));

// P0-3: a handful of routes change state or spend real resources (hide every
// channel) yet were reachable with no token at all. Gate them independently of
// the requireStreamAuth setting, which only governs the media endpoints above.
//   requireAuth - header JWT; callers here always send an Authorization header
// (/api/probe and /api/subtitle, which ran ffprobe/ffmpeg against a caller's URL
// for the movie/series page, went with it in 0122.)
const { requireAuth } = require('./auth');

app.use('/api/proxy', streamAuth, require('./routes/proxy'));
app.use('/api/channels', requireAuth, require('./routes/channels'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/transcode', streamAuth, require('./routes/transcode'));
app.use('/api/playback', require('./routes/playback'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/library', require('./routes/library'));
app.use('/api/lineup', require('./routes/lineup'));
app.use('/api/epg', require('./routes/epg')); // admin: EPG matching (0134)
app.use('/api/status', require('./routes/status')); // admin (0124)
app.use('/api/sports', require('./routes/sports')); // C-I: sport events (0148), EPG categories (0147)
app.use('/api/info', require('./routes/info'));
// Unauthenticated: an <img> tag cannot send a bearer header, and the route
// itself is not an open proxy (see routes/logo.js's header comment).
app.use('/api/logo', require('./routes/logo'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/recordings', streamAuth, require('./routes/recordings'));

// Version endpoint. Returns the full build identity (version, build number,
// commit, builtAt, display) from the single source of truth in version.js, so
// the webapp badge and any client can tell exactly which build they are
// talking to. Unauthenticated on purpose - a client checks this before it has
// a token, and nothing here is sensitive.
app.get('/api/version', (req, res) => {
    res.json(require('./version'));
});

// An unknown /api path is an error, not the web app. Without this, a mistyped or
// missing endpoint fell through to the SPA fallback below and answered 200 with
// index.html, which a client can only report as a baffling JSON decode failure.
// The query string is left out of the reply: it can carry a token.
app.use('/api', (req, res) => {
    res.status(404).json({
        error: 'No such API endpoint',
        endpoint: `${req.method} ${req.originalUrl.split('?')[0]}`.slice(0, 200)
    });
});

// SPA fallback - serve index.html for all non-API routes
// Express 5 path syntax (0137): a named wildcard, where Express 4 took '*'.
app.get('/{*splat}', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async (err) => {
    // Express 5 (0137) hands a listen failure (e.g. the port in use) to this
    // callback instead of throwing it; stop as Express 4's crash did, rather than
    // carrying on with no server.
    if (err) {
        console.error(`Could not listen on port ${PORT}:`, err.message);
        process.exit(1);
    }
    console.log(`PigTV server running on http://localhost:${PORT}`);

    // Nothing in transcode-cache can belong to this process yet - sweep
    // whatever a previous run (crash or restart mid-session) left behind
    // before anything else runs.
    try {
        const transcodeSession = require('./services/transcodeSession');
        await transcodeSession.sweepOrphanedCache();
    } catch (err) {
        console.warn('Transcode cache sweep failed:', err.message);
    }

    // The same for the tuners' timeshift directories on the recordings volume
    // (PIGTV_TUNER=1, 0128). Silent when there are none - including whenever the
    // tuner has never been on.
    try {
        const settings = await require('./db').settings.get();
        await require('./services/tuner').sweepOrphanedTimeshift(settings.recordingsPath);
    } catch (err) {
        console.warn('Timeshift sweep failed:', err.message);
    }

    // 0133 (C-G): channel health keeps 30 days of start attempts; pruned now and daily.
    try {
        require('./services/channelHealth').startPruneTimer();
    } catch (err) {
        console.warn('Channel health prune failed:', err.message);
    }

    // 0159: the sport event list is rebuilt in the background (an EPG sync landing,
    // a follow-list change, and this 5-minute-aligned timer), never inline on a
    // request - a synchronous build on 1,000 channels can take over a second, and
    // the event loop it would block also serves live HLS segments.
    try {
        require('./services/sportsEvents').startBackgroundRebuilds();
    } catch (err) {
        console.warn('Sport event background rebuilds failed to start:', err.message);
    }

    // Bring up the parts that must not wait.
    //
    // These used to sit behind the sync in one sequential block, so a stale
    // EPG source — several hundred thousand programmes to parse — delayed
    // hardware detection and the DVR scheduler by many minutes. A recording
    // due to start in that window was simply missed.
    setTimeout(async () => {
        try {
            const hwDetect = require('./services/hwDetect');
            await hwDetect.detect();
        } catch (err) {
            console.warn('Hardware detection failed:', err.message);
        }

        try {
            const recordingEngine = require('./services/recordingEngine');
            recordingEngine.init({ ffmpegPath: app.locals.ffmpegPath, ffprobePath: app.locals.ffprobePath });
        } catch (err) {
            console.warn('Recording engine failed to start:', err.message);
        }
    }, 2000);

    // Sync runs independently and may take a long time on a stale EPG source.
    setTimeout(() => {
        syncService.syncIfStale()
            .catch(console.error)
            .finally(() => syncService.startSyncTimer().catch(console.error));
    }, 5000);
});
