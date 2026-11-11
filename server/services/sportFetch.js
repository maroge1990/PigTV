/**
 * #272 (D-2): the one fetch every sport feed goes through: ESPN's scoreboards, standings and F1 lookups (the fixture
 * refresh, the score collector, the five sport pages, follow suggestions) and the leagues' own feeds (sportFeeds.js).
 * Before 0547 there were three, and only the collector's had a size cap, refused redirects and backed off ESPN.
 *
 * One rule for all of them:
 * - only the hosts and path prefixes below, https only, are asked; anything else is refused before a request;
 * - a redirect is never followed (it could lead off the list): the answer is refused;
 * - an answer is read up to `maxBytes` (whatever its length header says) and refused past it;
 * - a timeout (10 s unless the caller says);
 * - ESPN's shared 429/5xx cooldown (espnRequestPolicy) is honoured and recorded for ESPN's hosts while the score
 *   collector is on (sportsDashboard.collectorEnabled, the rule 0542 settled); the other feeds' hosts have none;
 * - never throws: `{ ok: true, json }` (or `{ ok: true, text }` with `as: 'text'`), else `{ ok: false, error }`, where
 *   an HTTP failure also carries `status`, `retryAfter` and `recorded` (the cooldown saw it). No URL, header or body
 *   is ever put in an error or a log.
 */
const requestPolicy = require('./espnRequestPolicy');

// Every host and path prefix a sport feed asks today (0547). Adding a feed means adding it here.
const ALLOWED = Object.freeze({
    // scoreboards, teams, team schedules, cricket scorepanel and summary, golf leaderboard (every caller); standings
    // (the NFL, F1 and League pages)
    'site.api.espn.com': ['/apis/site/v2/sports/', '/apis/v2/sports/'],
    // the F1 page's event, circuit and competitor lookups
    'sports.core.api.espn.com': ['/v2/sports/racing/leagues/f1/'],
    'aflapi.afl.com.au': ['/afl/v2/'],                 // AFLW
    'mc.championdata.com': ['/data/'],                 // NRLW, Super Netball
    'api.motogp.pulselive.com': ['/motogp/v1/results/'], // MotoGP
    'www.supercars.com': ['/calendar']                 // Supercars
});
const ESPN_HOSTS = new Set(['site.api.espn.com', 'sports.core.api.espn.com']);
const TIMEOUT_MS = 10000;
const MAX_BYTES = 6 * 1024 * 1024; // the largest cap in use before 0547 (a Grand Slam's scoreboard is ~1.9 MB)
const COOLING = 'Score host cooling down';

/** Is `url` (a URL) on the list? */
function allowed(u) {
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const prefixes = Object.hasOwn(ALLOWED, u.host) ? ALLOWED[u.host] : null;
    return !!prefixes && prefixes.some(p => u.pathname.startsWith(p));
}

// Loaded late: sportsDashboard requires the modules that require this one.
const sharedCooldown = () => require('./sportsDashboard').collectorEnabled();

/** The body as text up to maxBytes, or null past it. A response without a stream (a test double) reads its own text()/json(). */
async function readBody(res, maxBytes, controller) {
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) { controller.abort(); try { await reader.cancel(); } catch { /* aborted */ } return null; }
                chunks.push(Buffer.from(value));
            }
        } finally { try { reader.releaseLock(); } catch { /* cancelled */ } }
        return { text: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
    }
    if (typeof res.text === 'function') {
        const text = String(await res.text());
        const bytes = Buffer.byteLength(text);
        return bytes > maxBytes ? null : { text, bytes };
    }
    if (typeof res.json === 'function') return { json: await res.json(), bytes: 0 };
    return { text: '', bytes: 0 };
}

/**
 * Ask a sport feed. Options: `as` ('json' | 'text'), `timeoutMs`, `maxBytes`, `signal` (the caller's own abort),
 * `headers`, `onParsed(bytes, ms)` (the JSON parse's cost, sportCollectorCost).
 */
async function fetchFeed(url, { as = 'json', timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, signal, headers, onParsed } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { return { ok: false, error: 'bad URL' }; }
    if (!allowed(u)) return { ok: false, error: 'host not allowed' };
    const shared = ESPN_HOSTS.has(u.host) && sharedCooldown();
    if (shared && requestPolicy.blocked()) return { ok: false, error: COOLING };
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
        const res = await fetch(String(url), { signal: controller.signal, redirect: 'manual', ...(headers ? { headers } : {}) });
        if (!res) return { ok: false, error: 'request failed' };
        const status = res.status;
        const retryAfter = res.headers?.get?.('retry-after') ?? null;
        if (shared) requestPolicy.observe(status, retryAfter);
        if (status >= 300 && status < 400) return { ok: false, error: 'redirected' };
        if (!res.ok) return { ok: false, error: `HTTP ${status ?? '?'}`, status, retryAfter, recorded: shared };
        let body;
        try { body = await readBody(res, maxBytes, controller); } catch (err) {
            if (controller.signal.aborted) throw err;
            return { ok: false, error: 'not JSON' }; // a test double's json() that throws
        }
        if (body === null) return { ok: false, error: 'answer too large' };
        if (as === 'text') return { ok: true, text: body.text ?? JSON.stringify(body.json) };
        if ('json' in body) return { ok: true, json: body.json };
        const started = performance.now();
        let json;
        try { json = JSON.parse(body.text); } catch { return { ok: false, error: 'not JSON' }; }
        onParsed?.(body.bytes, performance.now() - started);
        return { ok: true, json };
    } catch (err) {
        if (signal?.aborted) return { ok: false, error: 'aborted' };
        return { ok: false, error: err?.name === 'AbortError' || controller.signal.aborted ? 'timed out' : 'request failed' };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
    }
}

module.exports = { fetchFeed, allowed: (url) => { try { return allowed(new URL(String(url))); } catch { return false; } }, ALLOWED, TIMEOUT_MS, MAX_BYTES, COOLING };
