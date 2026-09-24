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
const { LOGO_CACHE_VERSION } = require('../services/logoCache');

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

/**
 * Drop every stored logo once when LOGO_CACHE_VERSION changes (0141): the
 * files 0112 wrote from palette PNGs lost their transparency, and a row with
 * `fetched_at` set would otherwise keep serving them. Rows stay registered
 * (an old path still resolves, and is fetched again with the fixed code);
 * only their files and fetch state go. Runs on the first logo request.
 */
let versionChecked = false;
function ensureCacheVersion() {
    if (versionChecked) return;
    const db = getDb();
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'logo_cache_version'").get();
    if (!stored || stored.value !== String(LOGO_CACHE_VERSION)) {
        let removed = 0;
        for (const name of fs.readdirSync(LOGOS_DIR)) {
            try { fs.rmSync(path.join(LOGOS_DIR, name), { force: true }); removed++; } catch { /* next request overwrites it */ }
        }
        db.prepare('UPDATE logo_cache SET content_type = NULL, fetched_at = NULL, bytes = NULL').run();
        db.prepare(`INSERT INTO meta (key, value) VALUES ('logo_cache_version', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(LOGO_CACHE_VERSION));
        console.log(`[Logo] Cache version ${stored ? stored.value : 1} -> ${LOGO_CACHE_VERSION}: dropped ${removed} stored logos; each is fetched again on its next request`);
    }
    versionChecked = true;
}

function etagFor(row) {
    return `"${row.key}-${row.bytes || 0}-v${LOGO_CACHE_VERSION}"`;
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

/**
 * The pixel width from the image's own header, for the formats logos come in;
 * null when it can't be read (ffmpeg then decides). Only used to skip the
 * conversion for a logo that is already small enough.
 */
function imageWidth(buf) {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
        return buf.readUInt32BE(16);
    }
    if (buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8') return buf.readUInt16LE(6);
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) { i++; continue; }
            const marker = buf[i + 1];
            if (marker === 0xff) { i++; continue; }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buf.readUInt16BE(i + 7);
            i += 2 + buf.readUInt16BE(i + 2);
        }
    }
    return null;
}

/** An SVG (by type, or by content that starts like markup) is served as is. */
function isSvg(buf, contentType) {
    if (/svg/i.test(contentType)) return true;
    const head = buf.toString('utf8', 0, Math.min(buf.length, 256)).replace(/^\uFEFF/, '').trimStart();
    return head.startsWith('<');
}

/**
 * Downscale to <=320px wide via ffmpeg, as an RGBA PNG. The explicit rgba
 * format before and after the scale is the 0141 fix: without it, a palette
 * PNG (pal8 + tRNS) was scaled into ffmpeg's fixed 3-3-2 palette with no
 * transparency at all - the logo's clear background came out solid - and the
 * encoder kept whatever format the decoder chose (pal8, ya8, rgba64be).
 */
function downscale(ffmpegPath, buffer) {
    return new Promise((resolve, reject) => {
        const args = ['-y', '-i', 'pipe:0',
            '-vf', `format=rgba,scale='min(${MAX_WIDTH},iw)':-1,format=rgba`,
            '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-pix_fmt', 'rgba', 'pipe:1'];
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

/**
 * What to store for a fetched logo: the original bytes unless a conversion is
 * both needed and clearly worked. Already <=320px wide, an SVG, a failed or
 * unrecognisable conversion, or one that came out no smaller: the original.
 */
async function storableLogo(ffmpegPath, buffer, contentType) {
    const original = { buffer, type: contentType };
    if (!ffmpegPath || isSvg(buffer, contentType)) return original;
    const width = imageWidth(buffer);
    if (width !== null && width <= MAX_WIDTH) return original;
    try {
        const resized = await downscale(ffmpegPath, buffer);
        const isPng = resized.length >= 8 && resized.readUInt32BE(0) === 0x89504e47;
        if (!isPng || resized.length >= buffer.length) return original;
        return { buffer: resized, type: 'image/png' };
    } catch {
        // Downscaling is an optimisation, not a requirement for serving the logo.
        return original;
    }
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
    const { buffer, type: finalType } = await storableLogo(req.app.locals.ffmpegPath, Buffer.concat(chunks), contentType);

    fs.writeFileSync(logoFile(row.key), buffer);
    getDb().prepare('UPDATE logo_cache SET content_type = ?, fetched_at = ?, bytes = ? WHERE key = ?')
        .run(finalType, Date.now(), buffer.length, row.key);
}

router.get('/:key', async (req, res) => {
    try {
        const { key } = req.params;
        if (!isSafeKey(key)) return res.status(404).json({ error: 'Not found' });

        ensureCacheVersion();
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
// For tests (0141).
module.exports.storableLogo = storableLogo;
module.exports.imageWidth = imageWidth;
