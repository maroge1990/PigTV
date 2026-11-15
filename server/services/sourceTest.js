/**
 * #330: the one connection test behind POST /api/sources/:id/test (a saved provider) and POST /api/sources/test (details
 * typed into the add form, before anything is saved). It reads the network and nothing else: no row is written.
 *
 * The reply is the page's: for an Xtream login `{ success, status, expiresAt, isTrial, maxConnections, activeConnections }`
 * (only the account facts: the provider's reply also carries the login and its own address, which never leave the server);
 * for an M3U or a guide `{ success, message }`; a failure `{ success: false, error }`. Every text goes through stripUrls()
 * (redact() first, then no address, host or port). The fetch is providerFetch's (the configured User-Agent; redirects
 * followed as a sync follows them) with a short deadline, and an M3U or guide is read only as far as its first bytes.
 */
const { STATUS_CODES } = require('node:http');
const { providerFetch } = require('./providerFetch');
const { XtreamApi } = require('./xtreamApi');
const providerAccounts = require('./providerAccounts');
const { stripUrls } = require('../redact');

// `timeoutMs` is an object field so a test can shorten it.
const limits = { timeoutMs: 15000, sniffBytes: 64 * 1024 };

/** The first `max` bytes of the body as text; the rest is never downloaded. */
async function readStart(response, max) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (size < max) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            size += value.length;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** A failure whose text is ours alone (no upstream body, status text or address in it). */
const fixed = (message) => Object.assign(new Error(message), { fixedText: true });

/**
 * A plain sentence for the admin: never an address, a host, a login or any of the provider's own text. Only our own
 * sentences, a timeout and a socket error code are passed on; anything else (a JSON parse error quoting the body, a
 * library's message) becomes one fixed sentence.
 */
function failureText(err, url) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return `The server did not answer within ${Math.round(limits.timeoutMs / 1000)} seconds`;
    }
    const code = err && err.cause && err.cause.code;
    if (code) return `Could not reach the server (${stripUrls(String(code), [url])})`;
    if (err && err.fixedText) return stripUrls(err.message, [url]);
    return 'The connection test failed';
}

/** Test `{ type, url, username, password }`; never throws. */
async function testSource({ type, url, username, password } = {}) {
    const options = { timeoutMs: limits.timeoutMs };
    try {
        if (type === 'xtream') {
            const apiUrl = new XtreamApi(String(url), username ?? '', password ?? '').buildApiUrl(null);
            const response = await providerFetch(apiUrl, 'api', {}, options);
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw fixed(`The server answered ${response.status} ${STATUS_CODES[response.status] || ''}`.trim());
            }
            let body;
            try { body = await response.json(); } catch { throw fixed('The server answered, but not with account information'); }
            let account;
            try { account = providerAccounts.parseAccountReply(body); } catch (e) {
                // parseAccountReply's own two sentences; never the body.
                throw fixed(/rejected the login/.test(e && e.message) ? 'The provider rejected the login' : 'The server answered, but not with account information');
            }
            return {
                success: true,
                status: account.status,
                expiresAt: account.exp_date,
                isTrial: account.is_trial === null ? null : account.is_trial === 1,
                maxConnections: account.max_connections,
                activeConnections: account.active_cons
            };
        }
        const response = await providerFetch(String(url), type === 'epg' ? 'guide' : 'playlist', {}, options);
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw fixed(`The server answered ${response.status} ${STATUS_CODES[response.status] || ''}`.trim());
        }
        const text = await readStart(response, limits.sniffBytes);
        if (type === 'm3u') {
            const isValid = text.includes('#EXTM3U');
            return { success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' };
        }
        const isValid = text.includes('<tv') || text.includes('<?xml');
        return { success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' };
    } catch (err) {
        return { success: false, error: failureText(err, url) };
    }
}

module.exports = { testSource, limits };
