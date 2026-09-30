/**
 * Provider account info (0168, multi-provider brief 2.2).
 *
 * Every provider (a source) is an Xtream login underneath, so its player_api.php
 * says when the subscription ends and how many connections it allows. That is read
 * into `provider_accounts` (one row per source) and combined with what Mark types in
 * (the source's own `subscription` and `maxConnections`) by two pure functions:
 *
 *   effectiveExpiry = manual endsAt > purchasedAt + termMonths > account exp_date > unknown (null)
 *   effectiveLimit  = maxConnections > account max_connections > 1
 *
 * A failed read (Strong8K's player_api.php answered 502 all of 30 Sept) keeps the last
 * good values and never marks a provider expired: only a date in the past does.
 * Refreshed 30 s after startup, every 6 h, after a successful sync of the source, and
 * by an admin's "Check now". Error text is fixed sentences, redacted; never a URL.
 */

const { getDb } = require('../db/sqlite');
const { redact } = require('../redact');
const { parseDate } = require('./providerFields');

const TIMEOUT_MS = 10000;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_DAYS = 7;

// ------------------------------------------------------------ expiry, limit --

/** End of a calendar day (UTC), ms. */
const endOfDay = (y, m, d) => Date.UTC(y, m - 1, d, 23, 59, 59, 999);

/** 'YYYY-MM-DD' plus whole months, the day clamped to the month's length (31 Jan + 1 month = 28/29 Feb). */
function addMonths([y, m, d], months) {
    const index = (y * 12 + (m - 1)) + months;
    const ny = Math.floor(index / 12);
    const nm = (index % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return [ny, nm, Math.min(d, last)];
}

/** { at: ms | null, from: 'manual' | 'term' | 'account' | null } for the precedence in the header. */
function expiryInfo(source, account) {
    const sub = source?.subscription || {};
    const ends = parseDate(sub.endsAt);
    if (ends) return { at: endOfDay(...ends), from: 'manual' };
    const bought = parseDate(sub.purchasedAt);
    const term = Number.isInteger(sub.termMonths) && sub.termMonths > 0 ? sub.termMonths : null;
    if (bought && term) return { at: endOfDay(...addMonths(bought, term)), from: 'term' };
    const exp = Number(account?.exp_date);
    if (Number.isFinite(exp) && exp > 0) return { at: exp, from: 'account' };
    return { at: null, from: null };
}

/** Effective expiry in ms, or null when nothing says. */
const effectiveExpiry = (source, account) => expiryInfo(source, account).at;

/** Effective connection limit: manual > the account's > 1. */
function effectiveLimit(source, account) {
    const manual = Number(source?.maxConnections);
    if (Number.isInteger(manual) && manual > 0) return manual;
    const fromAccount = Number(account?.max_connections);
    if (Number.isInteger(fromAccount) && fromAccount > 0) return fromAccount;
    return 1;
}

/** Expired = the effective expiry is in the past. An unknown expiry is never expired. */
function isExpired(source, account, now = Date.now()) {
    const at = effectiveExpiry(source, account);
    return at !== null && at < now;
}

// ------------------------------------------------------------------- login --

const withScheme = (server) => (/^https?:\/\//i.test(server) ? server : `http://${server}`).replace(/\/+$/, '');

/**
 * The login out of a `#EXT-X-CREDENTIALS:[{...}]` header line (an EPGenius M3U names its
 * provider's server and login there), else null. Key names are read leniently.
 */
function parseCredentialsHeader(line) {
    const m = /^#EXT-X-CREDENTIALS:\s*(.+)$/i.exec(String(line || '').trim());
    if (!m) return null;
    let list;
    try { list = JSON.parse(m[1]); } catch { return null; }
    for (const c of Array.isArray(list) ? list : [list]) {
        if (!c || typeof c !== 'object') continue;
        const server = c.server ?? c.server_url ?? c.host ?? c.url ?? c.portal;
        const username = c.username ?? c.user;
        const password = c.password ?? c.pass;
        if (server && username && password) return { url: withScheme(String(server)), username: String(username), password: String(password) };
    }
    return null;
}

/** The login out of an Xtream stream URL http://host/live/<user>/<pass>/<id>.ts, else null. */
function loginFromStreamUrl(url) {
    const m = /^(https?:\/\/[^/?#]+)\/live\/([^/?#]+)\/([^/?#]+)\/\d+/i.exec(String(url || ''));
    if (!m) return null;
    try { return { url: m[1], username: decodeURIComponent(m[2]), password: decodeURIComponent(m[3]) }; } catch { return null; }
}

/** The login from a get.php?username=&password= playlist address, else null. */
function loginFromPlaylistUrl(url) {
    try {
        const u = new URL(url);
        const username = u.searchParams.get('username');
        const password = u.searchParams.get('password');
        return username && password ? { url: u.origin, username, password } : null;
    } catch { return null; }
}

/**
 * The Xtream login for a source: an xtream source's own; an m3u source's from the
 * playlist header if the last sync saw one, else from its first /live/<u>/<p>/<id>
 * stream URL, else from its own get.php address. null when none can be derived.
 */
function deriveLogin(source) {
    if (!source || source.type === 'epg') return null;
    if (source.type === 'xtream') {
        return source.url && source.username && source.password
            ? { url: withScheme(String(source.url)), username: source.username, password: source.password }
            : null;
    }
    const db = getDb();
    const saved = db.prepare('SELECT m3u_login FROM provider_accounts WHERE source_id = ?').get(source.id)?.m3u_login;
    if (saved) {
        try {
            const l = JSON.parse(saved);
            if (l?.url && l.username && l.password) return l;
        } catch { /* fall through to the stream URLs */ }
    }
    const rows = db.prepare(`SELECT stream_url FROM playlist_items WHERE source_id = ? AND type = 'live'
                             AND stream_url LIKE '%/live/%' LIMIT 50`).all(source.id);
    for (const r of rows) {
        const l = loginFromStreamUrl(r.stream_url);
        if (l) return l;
    }
    return loginFromPlaylistUrl(source.url);
}

/** Remember the login a synced M3U's header named (called by the M3U sync). */
function noteM3uHeader(sourceId, line) {
    const login = parseCredentialsHeader(line);
    if (!login) return false;
    getDb().prepare(`INSERT INTO provider_accounts (source_id, m3u_login) VALUES (?, ?)
                     ON CONFLICT(source_id) DO UPDATE SET m3u_login = excluded.m3u_login`).run(sourceId, JSON.stringify(login));
    return true;
}

// -------------------------------------------------------------------- read --

const toInt = (v) => { const n = Number(v); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) ? Math.trunc(n) : null; };

/** The fields of a player_api.php reply that we keep, or throws a plain sentence. */
function parseAccountReply(body) {
    const info = body && typeof body === 'object' ? body.user_info : null;
    if (!info || typeof info !== 'object') throw new Error('The provider answered, but not with account information');
    if (info.auth !== undefined && Number(info.auth) === 0) throw new Error('The provider rejected the login');
    const exp = toInt(info.exp_date);
    return {
        status: info.status == null ? null : String(info.status).slice(0, 40),
        exp_date: exp && exp > 0 ? exp * 1000 : null,   // Xtream sends seconds; null/0 = unlimited
        max_connections: toInt(info.max_connections),
        active_cons: toInt(info.active_cons),
        is_trial: info.is_trial === undefined || info.is_trial === null ? null : (Number(info.is_trial) ? 1 : 0)
    };
}

async function fetchAccount(login, userAgent) {
    const url = new URL(`${login.url}/player_api.php`);
    url.searchParams.set('username', login.username);
    url.searchParams.set('password', login.password);
    let response;
    try {
        response = await fetch(url, { headers: userAgent ? { 'User-Agent': userAgent } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? 'The provider did not answer within 10 seconds' : 'Could not connect to the provider');
    }
    if (!response.ok) throw new Error(`The provider answered HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('The provider sent a reply that could not be read'); }
    return parseAccountReply(body);
}

const inflight = new Map();

/**
 * Read one source's account and store it. Resolves the stored row; never rejects for a
 * provider problem (that is recorded as ok = 0 with the last good values kept).
 */
function refresh(sourceId) {
    const id = Number(sourceId);
    if (inflight.has(id)) return inflight.get(id);
    const job = (async () => {
        const { sources, settings, getUserAgent } = require('../db');
        const db = getDb();
        const source = await sources.getById(id);
        if (!source || source.type === 'epg') return null;
        const now = Date.now();
        const login = deriveLogin(source);
        try {
            if (!login) throw new Error('No login could be found for this provider (no Xtream address in its playlist)');
            const a = await fetchAccount(login, getUserAgent(await settings.get()));
            db.prepare(`INSERT INTO provider_accounts (source_id, status, exp_date, max_connections, active_cons, is_trial, checked_at, ok, error)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)
                        ON CONFLICT(source_id) DO UPDATE SET status = excluded.status, exp_date = excluded.exp_date,
                            max_connections = excluded.max_connections, active_cons = excluded.active_cons,
                            is_trial = excluded.is_trial, checked_at = excluded.checked_at, ok = 1, error = NULL`)
                .run(id, a.status, a.exp_date, a.max_connections, a.active_cons, a.is_trial, now);
        } catch (err) {
            const message = String(redact(err.message)).slice(0, 200);
            db.prepare(`INSERT INTO provider_accounts (source_id, checked_at, ok, error) VALUES (?, ?, 0, ?)
                        ON CONFLICT(source_id) DO UPDATE SET checked_at = excluded.checked_at, ok = 0, error = excluded.error`)
                .run(id, now, message);
            console.warn(`[Providers] Account check failed for ${source.name}: ${message}`);
        }
        return getAccount(id);
    })().finally(() => inflight.delete(id));
    inflight.set(id, job);
    return job;
}

/** Refresh every enabled provider, one after another. */
async function refreshAll() {
    const { sources } = require('../db');
    for (const s of await sources.getAll()) {
        if (s.enabled && s.type !== 'epg') {
            try { await refresh(s.id); } catch (err) { console.warn('[Providers] Account refresh failed:', redact(err.message)); }
        }
    }
}

/** Startup +30 s, then every 6 h. Returns a function that stops both. */
function startTimers({ delayMs = STARTUP_DELAY_MS, everyMs = REFRESH_MS } = {}) {
    const first = setTimeout(() => { refreshAll().catch(() => {}); }, delayMs);
    const every = setInterval(() => { refreshAll().catch(() => {}); }, everyMs);
    first.unref?.(); every.unref?.();
    return () => { clearTimeout(first); clearInterval(every); };
}

// ------------------------------------------------------------------ stored --

/** The stored row (without the M3U login), or null. */
function getAccount(sourceId) {
    const row = getDb().prepare('SELECT * FROM provider_accounts WHERE source_id = ?').get(Number(sourceId));
    if (!row) return null;
    const { m3u_login, ...rest } = row;
    return rest;
}

/** What GET /api/sources/:id/account returns: the stored info and the effective values. */
function describe(source, now = Date.now()) {
    const account = getAccount(source.id);
    const info = expiryInfo(source, account);
    return {
        account: account && account.checked_at ? {
            status: account.status,
            expiresAt: account.exp_date,
            maxConnections: account.max_connections,
            activeCons: account.active_cons,
            isTrial: account.is_trial === null ? null : account.is_trial === 1,
            checkedAt: account.checked_at,
            ok: account.ok === 1,
            error: account.error
        } : null,
        effective: {
            expiresAt: info.at,
            expirySource: info.from,
            limit: effectiveLimit(source, account),
            expired: info.at !== null && info.at < now
        }
    };
}

/** [{ id, name, expiresAt, daysLeft }] for enabled providers ending within 7 days, or already ended. */
function reminders(allSources, now = Date.now()) {
    const out = [];
    for (const s of allSources) {
        if (!s.enabled || s.type === 'epg') continue;
        const at = effectiveExpiry(s, getAccount(s.id));
        if (at === null || at - now > REMINDER_DAYS * DAY_MS) continue;
        out.push({ id: s.id, name: s.name, expiresAt: at, daysLeft: Math.ceil((at - now) / DAY_MS) || 0 });
    }
    return out.sort((a, b) => a.expiresAt - b.expiresAt);
}

function remove(sourceId) {
    getDb().prepare('DELETE FROM provider_accounts WHERE source_id = ?').run(Number(sourceId));
}

module.exports = {
    effectiveExpiry, effectiveLimit, isExpired, expiryInfo, addMonths,
    parseCredentialsHeader, loginFromStreamUrl, deriveLogin, noteM3uHeader, parseAccountReply,
    refresh, refreshAll, startTimers, getAccount, describe, reminders, remove
};
