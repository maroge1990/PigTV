/**
 * /api/proxy - the one route left here: /stream.
 *
 * It carries a `direct` resolve's stream (by opaque handle, 0119) and rewrites
 * an HLS manifest so every URI it names comes back through it. The rest of this
 * file was the fork's Xtream-provider emulation (/xtream/...), the whole-EPG
 * dump (/epg/:sourceId), /m3u/:sourceId, the file cache (/cache/:sourceId, with
 * services/cache.js) and an open image passthrough (/image); 0122 removed them
 * once the web app had moved onto /api/library (0121) and nothing called them.
 */

const express = require('express');
const router = express.Router();
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { redact } = require('../redact');
const playbackHandles = require('../services/playbackHandles');

/**
 * Proxy stream for playback
 * This handles CORS for streams that don't allow cross-origin
 * Supports HTTP Range requests for video seeking
 */
router.get('/stream', async (req, res) => {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // 0119 (C-D): `h` is an opaque handle from a direct resolve. `url` is
            // only what resolve hands out under the PIGTV_PLAYBACK_HANDLES=0
            // rollback; since 0121 the web itself never sends one.
            const viaHandle = req.query.h !== undefined;
            let url = viaHandle ? playbackHandles.resolveHandle(req.query.h) : req.query.url;
            if (viaHandle && !url) {
                return res.status(404).json({ error: 'Unknown or expired playback handle' });
            }
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'URL required' });
            }

            // Forward some headers to be more "transparent" back to the origin
            const origin = new URL(url).origin;
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': origin,
                'Referer': origin + '/'
            };

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            // Abort the upstream read if the client leaves before the response is
            // done: otherwise a stalled or endless source keeps its connection open
            // (a provider may allow only one) waiting for bytes nobody will read.
            const upstreamAbort = new AbortController();
            res.once('close', () => { if (!res.writableFinished) upstreamAbort.abort(); });

            const response = await fetch(url, { headers, signal: upstreamAbort.signal });

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                console.log(`[Proxy] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                console.error(`Upstream error for ${redact(url).substring(0, 80)}...: ${response.status} ${response.statusText}`);
                if (response.status === 403) {
                    const errorBody = await response.text().catch(() => 'N/A');
                    console.error(`403 Response body: ${errorBody.substring(0, 200)}`);
                }
                return res.status(response.status).send(`Failed to fetch stream: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');

            // Forward range-related headers for video seeking support
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');

            if (contentLength) {
                res.set('Content-Length', contentLength);
            }
            if (contentRange) {
                res.set('Content-Range', contentRange);
            }
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // If server supports content-length but didn't explicitly state accept-ranges,
                // we can safely assume it supports byte ranges
                res.set('Accept-Ranges', 'bytes');
            }

            // Set status code (206 for partial content when range request was made)
            res.status(response.status);

            // Create an async iterator for the response body
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.set('Content-Type', contentType || 'application/octet-stream');
                return res.end();
            }

            const firstChunk = Buffer.from(first.value);

            // Peek at first bytes to check for HLS manifest ({ #EXTM3U })
            const textPrefix = firstChunk.subarray(0, 7).toString('utf8');
            const contentLooksLikeHls = textPrefix === '#EXTM3U';

            if (contentLooksLikeHls) {
                // HLS Manifest: We must read the WHOLE manifest to rewrite it
                const chunks = [firstChunk];

                // Consume the rest of the stream
                let result = await iterator.next();
                while (!result.done) {
                    chunks.push(Buffer.from(result.value));
                    result = await iterator.next();
                }

                const buffer = Buffer.concat(chunks);
                const finalUrl = response.url || url;
                console.log(`[Proxy] Processing HLS manifest from: ${redact(finalUrl).substring(0, 80)}...`);
                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                let manifest = buffer.toString('utf-8');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);

                // A relative URI does not inherit the query string of the
                // manifest's own URL, so every segment and key the player fetches
                // next arrives without the ?token= this request carried. With
                // requireStreamAuth on, that meant the manifest loaded and then
                // every segment was refused with a 401. Carry the token onto each
                // rewritten URI, as withStreamToken() does for HLS sessions.
                const streamToken = typeof req.query.token === 'string' ? req.query.token : '';
                // A manifest reached through a handle hands out handles for what it
                // references too, so the provider's addresses stay off the client.
                const proxiedUrl = (absoluteUrl) =>
                    `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?` +
                    (viaHandle ? `h=${playbackHandles.createHandle(absoluteUrl)}` : `url=${encodeURIComponent(absoluteUrl)}`) +
                    (streamToken ? `&token=${encodeURIComponent(streamToken)}` : '');

                manifest = manifest.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) {
                        // Handle both URI="..." and URI='...' formats
                        if (trimmed.includes('URI=')) {
                            // Replace both double and single quoted URIs
                            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
                                try {
                                    const absoluteUrl = new URL(p1, baseUrl).href;
                                    return `URI="${proxiedUrl(absoluteUrl)}"`;
                                } catch (e) {
                                    return match;
                                }
                            });
                        }
                        return line;
                    }

                    // Stream URL handling
                    try {
                        let absoluteUrl;
                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            absoluteUrl = trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                        }
                        return proxiedUrl(absoluteUrl);
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
            }

            // Binary content (a segment, a key, or a whole progressive file): stream it
            // through. It used to be collected into one Buffer first - harmless for a
            // 2 MB segment, but a progressive MP4 (VOD) was held in memory in full
            // before its first byte left, and a source that never ends never left at
            // all. pipeline() applies the client's back-pressure and stops reading the
            // upstream as soon as the client goes away.
            console.log(`[Proxy] Serving binary content (${contentType})`);
            res.set('Content-Type', contentType || 'application/octet-stream');

            async function* body() {
                try {
                    yield firstChunk;
                    for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
                        yield Buffer.from(r.value);
                    }
                } finally {
                    // Client gone (or done): release the upstream connection too.
                    await iterator.return?.().catch(() => {});
                }
            }
            try {
                await pipeline(Readable.from(body()), res);
            } catch (err) {
                // The headers are sent, so there is nothing to retry and no error to
                // send: a client that left mid-stream is the usual reason.
                if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.name !== 'AbortError') {
                    console.warn(`[Proxy] Stream ended early: ${err.message}`);
                }
            }
            return; // Success - exit the retry loop

        } catch (err) {
            lastError = err;
            console.error(`Stream proxy error (attempt ${attempt}/${maxRetries}):`, err.message);
            if (attempt < maxRetries) {
                console.log('[Proxy] Retrying after error...');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    // All retries failed
    if (!res.headersSent) {
        res.status(500).json({ error: lastError?.message || 'Stream proxy failed after retries' });
    }
});

module.exports = router;
