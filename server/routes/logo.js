/**
 * GET /api/logo/:key - the logo cache (0112, roadmap S1.4).
 *
 * Fetches a channel/EPG logo once, downscales it if ffmpeg is around, and
 * serves it from disk forever after with a long cache lifetime - instead of
 * every client re-fetching a slow (or dead) provider URL on every guide load.
 *
 * Unauthenticated on purpose: an image carries no secret, and a plain web
 * `<img src>` (or the Apple client's image loader) cannot attach a bearer
 * header, so gating this behind requireAuth would just break every logo. It
 * is not an open proxy, though: `key` has to already be registered in
 * `logo_cache` (services/logoCache.js, called wherever a library response
 * builds a `logo` field) - a key that was never registered because it never
 * actually appeared as a channel or EPG logo is a plain 404, not a fetch of
 * whatever URL a caller feels like naming.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db/sqlite');

// Same relative depth as services/cache.js's cacheDir - data/ at the repo/
// image root, not inside server/.
const LOGOS_DIR = path.join(__dirname, '..', '..', 'data', 'logos');
if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

const FETCH_TIMEOUT_MS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_WIDTH = 320;

const logoFile = (key) => path.join(LOGOS_DIR, key);

// Keys are always our own sha256-derived hex strings (services/logoCache.js);
// reject anything else before it can be used to build a path or query a row.
const isSafeKey = (key) => /^[a-f0-9]{16,64}$/i.test(key);

function etagFor(row) {
    return `"${row.key}-${row.bytes || 0}"`;
}

function serveFromDisk(req, res, file, row) {
    const etag = etagFor(row);
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('Content-Type', row.content_type || 'image/png');
    fs.createReadStream(file)
        .on('error', () => { if (!res.headersSent) res.status(500).end(); })
        .pipe(res);
}

/** Downscale to <=320px wide PNG via ffmpeg; the scale filter is a no-op on
 *  anything already that width or narrower, so this never upscales. */
function downscale(ffmpegPath, buffer) {
    return new Promise((resolve, reject) => {
        const args = ['-y', '-i', 'pipe:0', '-vf', `scale='min(${MAX_WIDTH},iw)':-1`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
        const proc = spawn(ffmpegPath, args);
        const out = [];
        let settled = false;
        proc.stdout.on('data', d => out.push(d));
        proc.stderr.on('data', () => { /* discarded - not an error signal on its own */ });
        proc.on('error', err => { if (!settled) { settled = true; reject(err); } });
        proc.on('close', code => {
            if (settled) return;
            settled = true;
            if (code !== 0 || !out.length) return reject(new Error(`ffmpeg exited ${code}`));
            resolve(Buffer.concat(out));
        });
        proc.stdin.on('error', () => { /* ffmpeg closed stdin early on a bad input - close() above still fires */ });
        proc.stdin.write(buffer);
        proc.stdin.end();
    });
}

/** Fetch the logo's URL, store it on disk, and update its logo_cache row. */
async function fetchAndStore(req, row) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(row.url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`upstream responded ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) throw new Error(`not an image (${contentType || 'no content-type'})`);

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new Error('logo exceeds the 2 MB limit');
        chunks.push(chunk);
    }
    let buffer = Buffer.concat(chunks);
    let finalType = contentType;

    const ffmpegPath = req.app.locals.ffmpegPath;
    if (ffmpegPath) {
        try {
            const resized = await downscale(ffmpegPath, buffer);
            buffer = resized;
            finalType = 'image/png';
        } catch (e) {
            // Keep the original bytes/type - downscaling is an optimisation,
            // not a requirement for serving the logo.
        }
    }

    fs.writeFileSync(logoFile(row.key), buffer);
    getDb().prepare('UPDATE logo_cache SET content_type = ?, fetched_at = ?, bytes = ? WHERE key = ?')
        .run(finalType, Date.now(), buffer.length, row.key);
}

router.get('/:key', async (req, res) => {
    try {
        const { key } = req.params;
        if (!isSafeKey(key)) return res.status(404).json({ error: 'Not found' });

        const db = getDb();
        const row = db.prepare('SELECT * FROM logo_cache WHERE key = ?').get(key);
        if (!row) return res.status(404).json({ error: 'Not found' });

        const file = logoFile(key);
        if (row.fetched_at && fs.existsSync(file)) {
            return serveFromDisk(req, res, file, row);
        }

        await fetchAndStore(req, row);
        const updated = db.prepare('SELECT * FROM logo_cache WHERE key = ?').get(key);
        if (!updated || !updated.fetched_at || !fs.existsSync(file)) {
            return res.status(502).json({ error: 'Could not fetch logo' });
        }
        serveFromDisk(req, res, file, updated);
    } catch (err) {
        console.error('[Logo]', err.message);
        res.status(502).json({ error: 'Could not fetch logo' });
    }
});

module.exports = router;
