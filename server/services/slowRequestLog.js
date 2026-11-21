/**
 * #362: one log line for each slow request, so a slow screen can be traced to its route from the container log:
 *   slow request: GET /api/library/guide 200 412 ms 3720113 bytes
 * The route is Express's matched pattern (baseUrl + route.path), never the URL: a query string can hold a token and a
 * path parameter a session id, so neither is ever read. A request no route matched logs `(unmatched)`. `bytes` is what
 * the response wrote (after gzip when compression is on). PIGTV_SLOW_REQUEST_MS sets the threshold (default 1000; 0
 * turns the line off).
 */
const { redact } = require('../redact');

const DEFAULT_MS = 1000;

// Slow by design (they hold the connection open for as long as a viewer watches or waits), so never logged. Matched on the
// route pattern exactly as logged: the playback proxy, HLS playlists and segments, and a recording's media routes.
const EXCLUDED_ROUTES = new Set([
    '/api/proxy/stream',
    '/api/transcode/:sessionId/stream.m3u8',
    '/api/transcode/:sessionId/master.m3u8',
    '/api/transcode/:sessionId/:segment',
    '/api/recordings/:id/stream',
    '/api/recordings/:id/media.mp4',
    '/api/recordings/:id/download',
    '/api/recordings/:id/live/master.m3u8',
    '/api/recordings/:id/live/stream.m3u8',
    '/api/recordings/:id/live/:epoch/:file'
]);

/** The threshold in ms from the environment value: a whole number >= 0, else the default. */
function thresholdFrom(value) {
    if (value === undefined || value === '') return DEFAULT_MS;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MS;
}

/** The pattern the request matched, or '(unmatched)'. Never the URL. */
function routePattern(req) {
    const path = req.route && typeof req.route.path === 'string' ? req.route.path : null;
    return path === null ? '(unmatched)' : `${req.baseUrl || ''}${path === '/' && req.baseUrl ? '' : path}`;
}

/**
 * The middleware. `threshold` is read per request unless given (tests); `now` is a clock in ms; `log` takes the line.
 */
function slowRequestLog({ threshold, now = () => Number(process.hrtime.bigint()) / 1e6, log = console.log, excluded = EXCLUDED_ROUTES } = {}) {
    return (req, res, next) => {
        const limit = threshold === undefined ? thresholdFrom(process.env.PIGTV_SLOW_REQUEST_MS) : threshold;
        if (!limit) return next();
        const started = now();
        let bytes = 0;
        const write = res.write, end = res.end;
        const count = (chunk, encoding) => {
            if (chunk == null || typeof chunk === 'function') return;
            bytes += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
        };
        res.write = function (chunk, encoding, ...rest) { count(chunk, encoding); return write.call(this, chunk, encoding, ...rest); };
        res.end = function (chunk, encoding, ...rest) { count(chunk, encoding); return end.call(this, chunk, encoding, ...rest); };
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            const ms = now() - started;
            if (ms < limit) return;
            const route = routePattern(req);
            if (excluded.has(route)) return;
            log(redact(`slow request: ${req.method} ${route} ${res.statusCode} ${Math.round(ms)} ms ${bytes} bytes`));
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
    };
}

module.exports = { slowRequestLog, thresholdFrom, routePattern, EXCLUDED_ROUTES, DEFAULT_MS };
