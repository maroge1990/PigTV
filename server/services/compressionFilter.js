/**
 * The `filter` function for the `compression` middleware: decides, per
 * response, whether to gzip it (0108).
 *
 * Exported on its own, rather than inlined where `compression()` is wired up
 * in index.js, so it can be unit tested against a minimal express app without
 * booting the whole server - see test/compression-filter.test.js.
 *
 * This is an ALLOW-list, not a deny-list, and deliberately narrow: only JSON
 * and the handful of text types the web app itself serves (HTML/CSS/JS) are
 * compressed. Everything else answers `false`, which is what actually keeps
 * media untouched - HLS playlists (`application/vnd.apple.mpegurl`), fMP4
 * segments (served as `video/MP2T` on purpose, see blueprint.md), recording
 * media and any other binary stream are never in the allow-list, so they are
 * never compressed no matter what path serves them.
 *
 * On top of that, two more guards, because a byte-identical response matters
 * more here than anywhere else in the app:
 *   - A `Range` header always means no compression. gzip's Content-Length no
 *     longer matches byte offsets, and a client asking for bytes 100-199 of a
 *     recording must get exactly those bytes, unencoded.
 *   - A handful of path prefixes that serve HLS or recording media are always
 *     excluded, even if a response from them ever set a compressible-looking
 *     Content-Type by mistake. Belt and braces, not the primary mechanism.
 */

const EXCLUDED_PATH_PREFIXES = [
    '/api/transcode',      // HLS sessions: master/media playlists and segments
    '/api/proxy/stream'    // the `direct` playback strategy's proxied stream
];

// /api/recordings/{id}/media.mp4, /stream and /download - the recording media
// routes. Other /api/recordings/* routes (schedule, markers, playback JSON,
// the list) are plain JSON and stay compressible.
const EXCLUDED_RECORDING_PATH = /^\/api\/recordings\/[^/]+\/(media\.mp4|stream|download)(?:\/|$)/;

const COMPRESSIBLE_TYPES = new Set([
    'application/json',
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript'
]);

function isExcludedPath(path) {
    return EXCLUDED_PATH_PREFIXES.some(p => path.startsWith(p)) || EXCLUDED_RECORDING_PATH.test(path);
}

function shouldCompress(req, res) {
    if (req.headers.range) return false;

    const path = req.path || req.originalUrl || '';
    if (isExcludedPath(path)) return false;

    const contentType = res.getHeader('Content-Type');
    if (!contentType) return false;
    const type = String(contentType).split(';')[0].trim().toLowerCase();
    return COMPRESSIBLE_TYPES.has(type);
}

module.exports = { shouldCompress, isExcludedPath, COMPRESSIBLE_TYPES, EXCLUDED_PATH_PREFIXES };
