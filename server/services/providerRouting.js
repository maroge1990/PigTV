/**
 * Which provider a play goes to (0174, multi-provider brief 2.6).
 *
 * A channel is always the primary's (its guide, its identity); what can change is
 * where its stream comes from. candidatesFor() lists, in order:
 *   1. the primary channel itself - unless the primary is down (the breaker below),
 *      expired, or this channel is quarantined on it;
 *   2. its sibling, the primary's own "(Backup)" feed of the same channel (D5) - only
 *      when the primary is not down (a whole provider down takes its siblings with it);
 *   3. each enabled backup with a usable link (channelLinks.usableLinks: rank 1,
 *      auto/approved/manual), in priority order, skipping expired and down providers and
 *      quarantined links.
 * When everything is skipped the primary is tried anyway, as it always was: with no
 * backup configured the list is the primary alone and nothing changes.
 *
 * The route (routes/playback.js) walks the list: admission, start, and on a failure for
 * a provider reason, note it here and try the next. P7 (recordings) uses the same list.
 *
 * Breaker, per provider, in memory: provider-reason failures on >= 2 distinct channels
 * within 5 min -> `down` (skipped). After a cooldown (3 min, doubling to 15 min) it is
 * `half-open`: plays try it again; a success -> `up` (cooldown reset), a failure -> `down`.
 * One log line per state change, with the provider's name.
 *
 * Quarantine, per provider + channel, 10 min: set when a start fails there for a provider
 * reason, and when a session on it that had played ends unrequested with a provider
 * reason (transcodeSession 'lost': ffmpeg's exit, or the stall watchdog). That is what
 * makes the player's own single re-resolve land on the next provider.
 *
 * Stream URLs carry the provider's login: they are handed to playbackStrategy and
 * nowhere else - never logged, never returned. Logs name providers by name.
 */
const db = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('./xtreamApi');
const providerFields = require('./providerFields');
const providerAccounts = require('./providerAccounts');
const channelLinks = require('./channelLinks');
const { isStreamUrl } = require('./streamUrl');
const { MESSAGES: FAILURE_TEXT } = require('./playbackErrors');

const MINUTE = 60 * 1000;
const BREAKER_WINDOW_MS = 5 * MINUTE;
const BREAKER_CHANNELS = 2;
const COOLDOWN_MS = 3 * MINUTE;
const COOLDOWN_CAP_MS = 15 * MINUTE;
const QUARANTINE_MS = 10 * MINUTE;

// The resolve's own budget when there is somewhere to fail over to: the Apple
// client's request timeout is 35 s. A candidate is not started with less than
// MIN_START_MS left, and one that is not the last must be done NEXT_RESERVE_MS
// before the deadline, so the next still has time for a cold start (7-10 s).
const DEADLINE_MS = 30 * 1000;
const MIN_START_MS = 8 * 1000;
const NEXT_RESERVE_MS = 12 * 1000;
// The refused-connection retries of a candidate that is not the last (the last
// keeps 0143's two, 1.5 s + 3 s).
const EARLY_RETRY_DELAYS_MS = [1000];

const breakers = new Map();   // providerId -> { state, failures: [{ channel, at }], cooldownMs, until }
const quarantined = new Map(); // `${providerId}|${channelKey}` -> until (ms)

// ------------------------------------------------------------------ providers --

/** Every stream source (not EPG), with its role filled in, by id. Read afresh: a handful of rows. */
function providerMap() {
    const map = new Map();
    try {
        for (const r of getDb().prepare('SELECT data FROM app_sources ORDER BY id').all()) {
            let s;
            try { s = providerFields.withDefaults(JSON.parse(r.data)); } catch { continue; }
            if (s && s.type !== 'epg') map.set(Number(s.id), s);
        }
    } catch { /* no database: nothing to fail over to */ }
    return map;
}

function providerName(id, map = providerMap()) {
    const s = map.get(Number(id));
    return s ? String(s.name || `Provider ${id}`) : `Provider ${id}`;
}

function isExpired(source) {
    try { return providerAccounts.isExpired(source, providerAccounts.getAccount(source.id)); } catch { return false; }
}

// -------------------------------------------------------------------- breaker --

function breakerOf(id) {
    const key = Number(id);
    let b = breakers.get(key);
    if (!b) {
        b = { state: 'up', failures: [], cooldownMs: COOLDOWN_MS, until: 0 };
        breakers.set(key, b);
    }
    return b;
}

/** 'up' | 'down' | 'half-open'. A down provider whose cooldown has passed becomes half-open here. */
function providerState(id, now = Date.now()) {
    const b = breakers.get(Number(id));
    if (!b) return 'up';
    if (b.state === 'down' && now >= b.until) {
        b.state = 'half-open';
        console.log(`[Providers] ${providerName(id)} is half-open: the next play tries it again`);
    }
    return b.state;
}

function trip(id, b, cooldownMs, why, now) {
    b.state = 'down';
    b.cooldownMs = cooldownMs;
    b.until = now + cooldownMs;
    console.warn(`[Providers] ${providerName(id)} is down (${why}); skipped for ${Math.round(cooldownMs / MINUTE)} min`);
}

/**
 * A provider-reason failure of `channel` (the primary identity it was played for) on
 * provider `id`. Returns the provider's state afterwards.
 */
function noteProviderFailure(id, channel, now = Date.now()) {
    if (id === null || id === undefined) return 'up';
    const state = providerState(id, now);
    const b = breakerOf(id);
    b.failures = b.failures.filter(f => now - f.at < BREAKER_WINDOW_MS);
    b.failures.push({ channel: String(channel), at: now });
    if (state === 'half-open') {
        trip(id, b, Math.min(b.cooldownMs * 2, COOLDOWN_CAP_MS), 'failed again after its cooldown', now);
    } else if (state === 'up') {
        const distinct = new Set(b.failures.map(f => f.channel)).size;
        if (distinct >= BREAKER_CHANNELS) trip(id, b, COOLDOWN_MS, `failures on ${distinct} channels within ${BREAKER_WINDOW_MS / MINUTE} min`, now);
    }
    return b.state;
}

/** A start that played on provider `id`: a half-open (or down) provider is up again. */
function noteProviderSuccess(id) {
    if (id === null || id === undefined) return;
    const b = breakers.get(Number(id));
    if (!b || b.state === 'up') return;
    b.state = 'up';
    b.cooldownMs = COOLDOWN_MS;
    b.until = 0;
    b.failures = [];
    console.log(`[Providers] ${providerName(id)} is up again`);
}

// ----------------------------------------------------------------- quarantine --

const qKey = (id, channelKey) => `${Number(id)}|${String(channelKey)}`;

function quarantine(id, channelKey, now = Date.now()) {
    if (id === null || id === undefined || channelKey === null || channelKey === undefined) return;
    quarantined.set(qKey(id, channelKey), now + QUARANTINE_MS);
}

function isQuarantined(id, channelKey, now = Date.now()) {
    const k = qKey(id, channelKey);
    const until = quarantined.get(k);
    if (!until) return false;
    if (now >= until) { quarantined.delete(k); return false; }
    return true;
}

/**
 * A candidate failed for a provider reason: quarantine it (its provider + its own
 * channel) and count it toward the provider's breaker (keyed by the primary identity,
 * so a channel failing on its primary feed and its sibling is still one channel).
 */
function noteFailure(candidate, primaryKey, now = Date.now()) {
    if (!candidate || candidate.providerId === null || candidate.providerId === undefined) return;
    quarantine(candidate.providerId, candidate.channelKey, now);
    noteProviderFailure(candidate.providerId, primaryKey ?? candidate.channelKey, now);
}

function noteSuccess(candidate) {
    if (candidate) noteProviderSuccess(candidate.providerId);
}

/** An error thrown by playbackStrategy.resolve that another provider might not have. */
function isProviderFailure(err) {
    return !!err && err.providerReason === true;
}

/**
 * Watch a started session: if it ends unrequested after playing, for a provider reason,
 * quarantine the channel there and count it toward the breaker, so the player's
 * re-resolve goes to the next candidate. `label` is the channel's name for the log.
 */
function watchSession(session, candidate, primaryKey, label = null) {
    if (!session || typeof session.once !== 'function' || !candidate || candidate.providerId == null) return;
    session.once('lost', ({ how, providerReason } = {}) => {
        if (!providerReason) return;
        noteFailure(candidate, primaryKey);
        console.warn(`[Playback] ${candidate.providerName} lost ${label ? `"${label}"` : 'a channel'} mid-play ` +
            `(${how === 'stall' ? 'stalled' : how === 'timestamps' ? 'timestamps broke after a reconnect' : 'ffmpeg exited'}); ` +
            `not used for it for ${QUARANTINE_MS / MINUTE} min`);
    });
    // 0191: a blank or placeholder picture. Quarantined, so the next play of the channel
    // tries another provider first, but not counted toward the breaker: the provider is
    // up, it is this one channel that is wrong. The play itself goes on.
    session.once('blank', ({ kbps } = {}) => {
        quarantine(candidate.providerId, candidate.channelKey);
        console.warn(`[Playback] ${candidate.providerName} is sending a blank picture for ${label ? `"${label}"` : 'a channel'} ` +
            `(${kbps} kbps); the next play tries another provider first for ${QUARANTINE_MS / MINUTE} min`);
    });
}

// ------------------------------------------------------------------ candidates --

/**
 * Resolve a channel id to its upstream URL (moved from routes/playback.js, unchanged).
 *
 * Accepts either the bare item_id or the composite id a client may hold
 * (m3u_<source>_<item>), because both are in circulation.
 */
async function streamUrlForChannel(sourceId, channelId) {
    const source = await db.sources.getById(sourceId);
    // 0118 (C-B): the client may show these, so they use its allowed wording;
    // `detail` keeps what actually went wrong for the log.
    if (!source) throw Object.assign(new Error(FAILURE_TEXT.notInPlaylist()), { status: 404, detail: `Source ${sourceId} not found` });

    if (source.type === 'xtream') {
        const api = xtreamApi.createFromSource(source);
        return api.buildStreamUrl(channelId, 'live', 'ts');
    }

    const raw = String(channelId);
    const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');

    const item = getDb().prepare(`
        SELECT stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live'
          AND (item_id = ? OR item_id = ? OR id = ?)
        LIMIT 1
    `).get(sourceId, raw, stripped, `${sourceId}:${stripped}`);

    if (!item) throw Object.assign(new Error(FAILURE_TEXT.notInPlaylist()), { status: 404, detail: `Channel ${channelId} not found` });
    const url = urlOfItem(item);
    if (url) return url;

    throw Object.assign(new Error(FAILURE_TEXT.noStreamUrl()), { status: 422, detail: 'Channel has no stream URL' });
}

function urlOfItem(item) {
    if (!item) return null;
    if (item.stream_url) return item.stream_url;
    try {
        const data = JSON.parse(item.data || '{}');
        if (data.url) return data.url;
        if (data.stream_url) return data.stream_url;
    } catch (e) { /* fall through */ }
    return null;
}

/** The primary channel's identity (the favourites' key) and name, or null when it is not in the playlist. */
function channelIdentity(sourceId, channelId) {
    try {
        const raw = String(channelId);
        const stripped = raw.replace(/^(?:m3u|xtream)_\d+_/, '');
        const row = getDb().prepare(`
            SELECT COALESCE(stable_id, item_id) AS channel_key, name FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND (item_id = ? OR item_id = ?) LIMIT 1
        `).get(Number(sourceId), raw, stripped);
        return row ? { key: String(row.channel_key), name: row.name || null } : null;
    } catch { return null; }
}

/** A sibling's URL from its identity (stable_id first, then item_id), as recordingEngine resolves one. */
function siblingUrl(source, identity) {
    const dbh = getDb();
    const row = dbh.prepare(`
        SELECT item_id, stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND stable_id = ?
        ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC LIMIT 1
    `).get(Number(source.id), String(identity)) || dbh.prepare(`
        SELECT item_id, stream_url, data FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
    `).get(Number(source.id), String(identity));
    if (!row) return null;
    if (source.type === 'xtream') return xtreamApi.createFromSource(source).buildStreamUrl(row.item_id, 'live', 'ts');
    return urlOfItem(row);
}

/** A backup channel's URL: built from the login (xtream), or its stored url_data (m3u). */
function backupUrl(source, streamId) {
    if (source.type === 'xtream') return xtreamApi.createFromSource(source).buildStreamUrl(streamId, 'live', 'ts');
    const row = getDb().prepare('SELECT url_data FROM backup_channels WHERE source_id = ? AND stream_id = ?')
        .get(Number(source.id), String(streamId));
    return row && row.url_data ? row.url_data : null;
}

/**
 * Everything the route needs to play a channel with failover:
 *   { candidates: [{ providerId, providerName, role, via, url, channelKey }],
 *     primaryKey, primarySkipped, providerCount, backupsConfigured }
 * Throws streamUrlForChannel's 404/422 when the channel itself is not playable.
 */
async function plan(sourceId, channelId, now = Date.now()) {
    const primaryId = Number(sourceId);
    const primaryUrl = await streamUrlForChannel(primaryId, channelId);
    const map = providerMap();
    const primarySource = map.get(primaryId) || { id: primaryId, name: `Provider ${primaryId}` };
    const identity = channelIdentity(primaryId, channelId);
    const primaryKey = identity ? identity.key : String(channelId).replace(/^(?:m3u|xtream)_\d+_/, '');

    const primary = {
        providerId: primaryId, providerName: providerName(primaryId, map), role: 'primary', via: 'primary',
        url: primaryUrl, channelKey: primaryKey
    };
    const primaryDown = providerState(primaryId, now) === 'down';
    const primaryExpired = isExpired(primarySource);

    const candidates = [];
    let primarySkipped = false;
    if (!primaryDown && !primaryExpired && !isQuarantined(primaryId, primaryKey, now)) candidates.push(primary);
    else primarySkipped = true;

    let links = [];
    try { links = identity ? channelLinks.usableLinks(primaryId, identity.key) : []; } catch { links = []; }
    for (const link of links) {
        const id = Number(link.backupSourceId);
        const streamId = String(link.streamId);
        let candidate = null;
        try {
            if (id === primaryId) {
                // D5: the primary's own backup feed - not when the whole provider is down.
                if (primaryDown || primaryExpired || isQuarantined(id, streamId, now)) continue;
                const url = siblingUrl(primarySource, streamId);
                if (url) candidate = { ...primary, via: 'sibling', url, channelKey: streamId };
            } else {
                const source = map.get(id);
                if (!source || source.enabled === false || source.role !== 'backup') continue;
                if (isExpired(source) || providerState(id, now) === 'down' || isQuarantined(id, streamId, now)) continue;
                const url = backupUrl(source, streamId);
                if (url) candidate = { providerId: id, providerName: providerName(id, map), role: 'backup', via: 'backup', url, channelKey: streamId };
            }
        } catch { candidate = null; }
        if (candidate && isStreamUrl(candidate.url)) candidates.push(candidate);
    }

    // Nowhere else to go: the primary, as it always was.
    if (!candidates.length) {
        candidates.push(primary);
        primarySkipped = false;
    }
    const backupsConfigured = [...map.values()].some(s => s.role === 'backup' && s.enabled !== false);
    return {
        candidates,
        primaryKey,
        channelName: identity ? identity.name : null,
        primarySkipped,
        providerCount: new Set(candidates.map(c => c.providerId)).size,
        backupsConfigured
    };
}

/** The ordered candidates for a channel (see plan). */
async function candidatesFor(sourceId, channelId) {
    return (await plan(sourceId, channelId)).candidates;
}

// ------------------------------------------------------------ status, testing --

/** For the Status page (P8): every provider's breaker state and the channels quarantined now. */
function snapshot(now = Date.now()) {
    const map = providerMap();
    const providers = [...map.values()].map(s => {
        const id = Number(s.id);
        const state = providerState(id, now);
        const b = breakers.get(id);
        return {
            id,
            name: providerName(id, map),
            role: s.role,
            state,
            downUntil: state === 'down' && b ? b.until : null,
            recentFailures: b ? b.failures.filter(f => now - f.at < BREAKER_WINDOW_MS).length : 0,
            quarantinedChannels: [...quarantined.entries()].filter(([k, until]) => k.startsWith(`${id}|`) && until > now).length
        };
    });
    return { providers };
}

function reset() {
    breakers.clear();
    quarantined.clear();
}

module.exports = {
    plan,
    candidatesFor,
    streamUrlForChannel,
    channelIdentity,
    providerState,
    noteFailure,
    noteSuccess,
    noteProviderFailure,
    noteProviderSuccess,
    quarantine,
    isQuarantined,
    isProviderFailure,
    watchSession,
    snapshot,
    reset,
    DEADLINE_MS,
    MIN_START_MS,
    NEXT_RESERVE_MS,
    EARLY_RETRY_DELAYS_MS,
    BREAKER_WINDOW_MS,
    COOLDOWN_MS,
    COOLDOWN_CAP_MS,
    QUARANTINE_MS,
    // Test seam: the breakers, so a test can end a cooldown instead of waiting it out.
    _breakers: breakers
};
