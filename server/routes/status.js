/**
 * GET /api/status (admin; 0124, roadmap W2.2)
 *
 * One read of what the server is doing, for the web app's Status page:
 *   build        the build identity (server/version.js)
 *   sessions     live HLS sessions: id, channel name (looked up from the session's
 *                stream identity, else "unknown"), owner key, video/audio copy or
 *                encode, segment type, uptime, idle seconds, ffmpeg status
 *   recordings   { active: [...], upcoming: [the next 5 scheduled] }
 *   events       the last 50 play-start / play-end / failure events, newest first
 *                (services/playbackEvents.js)
 *   leastReliable up to 10 channels with failed starts or stalls in the last 7 days:
 *                name, attempts, failures, stalls, minutes watched, stalls/hour,
 *                median first picture, health, score (services/channelHealth.js)
 *   sync         per source and feed: status, last sync, error text
 *   disk         free/total bytes of the transcode cache (the tmpfs) and of the
 *                recordings volume
 *
 * Never a provider URL: every field is picked explicitly (no row or session is
 * passed through whole), and the finished document is scrubbed of anything
 * URL-shaped as a last line of defence - a sync error or ffmpeg message can quote
 * the URL it failed on.
 */

const fs = require('fs');
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db/sqlite');
const db = require('../db');
const transcodeSession = require('../services/transcodeSession');
const playbackEvents = require('../services/playbackEvents');
const { stableChannelId } = require('../services/stableIds');
const channelHealth = require('../services/channelHealth');
const sportsFixtures = require('../services/sportsFixtures');
const providerRouting = require('../services/providerRouting');
const providerAccounts = require('../services/providerAccounts');
const streamCoordinator = require('../services/streamCoordinator');
const recordingEngine = require('../services/recordingEngine');

router.use(requireAuth, requireAdmin);

const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** Every string in `value`, with anything URL-shaped replaced. */
function scrubUrls(value) {
    if (typeof value === 'string') return value.replace(URLISH, '[url removed]');
    if (Array.isArray(value)) return value.map(scrubUrls);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrubUrls(v);
        return out;
    }
    return value;
}

/** The channel a session is playing, by the identity of its URL; null when not found. */
function channelNameForUrl(url) {
    try {
        const id = stableChannelId(url);
        if (!id) return null;
        const row = getDb().prepare(`
            SELECT name FROM playlist_items WHERE stable_id = ? AND type = 'live' ORDER BY sort_order LIMIT 1
        `).get(id);
        return row?.name || null;
    } catch (e) {
        return null;
    }
}

function ffmpegState(session) {
    const proc = session.process;
    const running = !!proc && proc.exitCode === null && proc.signalCode === null && !proc.killed;
    if (running) return session.status === 'running' ? 'running' : `running (${session.status})`;
    if (session.status === 'error') return 'exited with an error';
    if (session.status === 'stopped') return 'stopped';
    return proc ? 'exited' : 'not started';
}

function providerName(providerId) {
    if (providerId === null || providerId === undefined) return null;
    try {
        const id = Number(providerId);
        const row = getDb().prepare('SELECT name FROM app_sources WHERE id = ?').get(id);
        return row?.name || null;
    } catch (e) {
        return null;
    }
}

function liveSessions() {
    const now = Date.now();
    return transcodeSession.getAllSessions().map(summary => {
        // peek, not get: looking at a stream must not make it look watched (0190).
        const session = transcodeSession.peekSession(summary.id);
        const options = session?.options || {};
        return {
            id: summary.id,
            // 0190: the name the resolve gave it. Guessing from the address only finds a
            // primary channel, so every play on a backup read "unknown".
            channel: options.channelName || channelNameForUrl(summary.url) || 'unknown',
            owner: summary.owner || null,
            providerId: summary.providerId ?? null,
            provider: providerName(summary.providerId),
            video: options.videoMode === 'copy' ? 'copy' : 'encode',
            audio: options.audioMode === 'copy' ? 'copy' : (options.audioMode === 'encode' ? 'encode' : 'auto'),
            segmentType: options.segmentType || null,
            uptimeSec: Math.round((now - summary.startTime) / 1000),
            idleSec: Math.round(summary.idleMs / 1000),
            status: summary.status,
            ffmpeg: session ? ffmpegState(session) : 'unknown',
            error: session?.error || null
        };
    });
}

function recordingSummary(r) {
    return {
        id: r.id,
        title: r.title,
        channel: r.channel_name || null,
        status: r.status,
        programStart: r.program_start,
        programEnd: r.program_end,
        preBufferMin: r.pre_buffer_min || 0,
        postBufferMin: r.post_buffer_min || 0
    };
}

function recordings() {
    const engine = require('../services/recordingEngine');
    // 0177: a recording now names the provider whose connection it holds.
    const active = engine.listActive().map(r => ({ ...recordingSummary(r), provider: providerName(r.providerId) }));
    const activeIds = new Set(active.map(r => r.id));
    const upcoming = engine.listScheduled()
        .filter(r => !activeIds.has(r.id) && r.status !== 'recording')
        .slice(0, 5)
        .map(recordingSummary);
    return { active, upcoming };
}

/** Missed/failed schedules from the last 7 days (0156), same list the Recordings page shows. */
function recentProblems() {
    const engine = require('../services/recordingEngine');
    return engine.listScheduled({ includeRecent: true })
        .filter(r => r.status === 'missed' || r.status === 'failed')
        .map(r => ({ ...recordingSummary(r), error: r.error || null }));
}

/** The last recordings-folder health check (0157): missing, not writable, an
 *  unmounted share masquerading as a tiny filesystem, or low on space. */
function recordingsFolderHealth() {
    const engine = require('../services/recordingEngine');
    const h = engine.getFolderHealth();
    return {
        ok: h.ok, problem: h.problem, root: h.root,
        freeBytes: h.freeBytes, totalBytes: h.totalBytes, checkedAt: h.checkedAt
    };
}

async function syncStatus() {
    const sources = await db.sources.getAll();
    const rows = getDb().prepare('SELECT source_id, type, status, last_sync, error FROM sync_status').all();
    const reach = require('../services/syncService').guideAhead(); // #11: each live guide's last programme end
    return sources.map(source => ({
        sourceId: source.id,
        name: source.name,
        type: source.type,
        enabled: !!source.enabled,
        guideUntil: reach.get(source.id) ?? null,
        feeds: rows.filter(r => r.source_id === source.id).map(r => ({
            type: r.type,
            status: r.status,
            lastSync: r.last_sync,
            error: r.error ? String(r.error).slice(0, 300) : null
        }))
    }));
}

function diskAt(dir) {
    try {
        if (!dir || !fs.existsSync(dir)) return { available: false };
        const s = fs.statfsSync(dir);
        return { available: true, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch (e) {
        return { available: false };
    }
}

function leastReliable() {
    try {
        return channelHealth.leastReliable({ limit: 10 });
    } catch (e) {
        return [];
    }
}

/** A recording's provider: the one it was started on, else its schedule's source. */
const recordingProviderId = (r) => (r.providerId !== undefined ? r.providerId : (r.source_id ?? null));

/**
 * Bug 9 (0226): the provider connections in use on `id`. Sessions and recordings that read one shared
 * ingest (Wave 5, the same `ingestKey`) hold one connection between them, as the coordinator's pools
 * count them; everything else holds its own.
 */
function connectionsUsed(id, sessions, recordings) {
    const ingests = new Set();
    let own = 0;
    const count = (x) => { if (x.ingestKey) ingests.add(x.ingestKey); else own++; };
    for (const s of sessions) if (s.providerId === id) count(s);
    for (const r of recordings) if (recordingProviderId(r) === id) count(r);
    return own + ingests.size;
}

/** P8: Provider status for the Status page and admin reminder banner. */
function providersStatus(settings = {}) {
    try {
        const snapshot = providerRouting.snapshot();
        const activeStreams = streamCoordinator.activeStreams();
        const activeRecordings = recordingEngine.listActive();

        return (snapshot.providers || []).map(prov => {
            const id = Number(prov.id);
            const used = connectionsUsed(id, activeStreams, activeRecordings);

            const account = providerAccounts.getAccount(id);
            const sourceRow = getDb().prepare('SELECT data FROM app_sources WHERE id = ?').get(id);
            let source = null;
            if (sourceRow) {
                try { source = JSON.parse(sourceRow.data); } catch (e) { /* skip */ }
            }
            const expInfo = providerAccounts.expiryInfo(source, account);
            const limit = streamCoordinator.providerLimit(id, settings);
            const expired = providerAccounts.isExpired(source, account);

            return {
                id,
                name: prov.name,
                role: prov.role || 'primary',
                enabled: source?.enabled !== false,
                state: prov.state || 'up',
                downUntil: prov.downUntil || null,
                connections: { used, limit },
                expiresAt: expInfo.at || null,
                expirySource: expInfo.from || null,
                expired,
                accountCheckedAt: account?.checked_at || null,
                // null until the account was first read (SQLite stores ok as 0/1)
                accountOk: account && account.checked_at ? account.ok === 1 || account.ok === true : null
            };
        });
    } catch (e) {
        return [];
    }
}

/** R16: each provider's connections with what each is for. A new purpose string (e.g. 'warm') just flows through. */
function connectionUse(providers) {
    const out = {};
    try {
        const sessions = streamCoordinator.activeStreams();
        for (const s of sessions) {
            const id = s.providerId;
            if (id === null || id === undefined) continue;
            const purpose = String(transcodeSession.peekSession(s.id)?.purpose || (s.warm ? 'warm' : s.standby ? 'standby' : 'viewer')).slice(0, 24);
            (out[id] ||= []).push({ purpose, channel: transcodeSession.peekSession(s.id)?.options?.channelName || null, ageSec: Math.round((Date.now() - s.startTime) / 1000),
                ...(s.ingestKey ? { shared: true } : {}) }); // bug 9: on a shared connection (Wave 5)
        }
        for (const r of recordingEngine.listActive()) {
            const id = recordingProviderId(r);
            if (id === null || id === undefined) continue;
            (out[Number(id)] ||= []).push({ purpose: 'recording', channel: r.channel_name || null, ageSec: null,
                ...(r.ingestKey ? { shared: true } : {}) });
        }
    } catch (e) { /* the table just stays empty */ }
    return providers.map(p => ({ ...p, uses: out[p.id] || [] }));
}

function preparationQueue() {
    try { return recordingEngine.nativeQueueStatus(); } catch (e) { return null; }
}

router.get('/', async (req, res) => {
    try {
        const settings = await db.settings.get();
        const status = {
            generatedAt: Date.now(),
            mediaTools: req.app.locals.mediaTools || null,
            build: require('../version'),
            providers: connectionUse(providersStatus(settings)),
            sessions: liveSessions(),
            recordings: recordings(),
            recentProblems: recentProblems(),
            recordingsFolder: recordingsFolderHealth(),
            events: playbackEvents.recent(),
            // 0133 (C-G): the channels that failed to start most in the last 7 days.
            leastReliable: leastReliable(),
            // 0188: streams lost mid-play in the last 7 days, and how long they took to come back.
            interruptions: require('../services/playbackInterruptions').summary(),
            // R11: channels warmed ahead (the warmNextChannel setting).
            warming: require('../services/channelWarming').status(settings),
            // 0189: streams a relay is keeping going (Settings: In-stream recovery), and their standbys.
            relay: (() => { const r = require('../services/streamRelay'); return { ...r.modeOf(settings), streams: r.list() }; })(),
            // Wave 5: shared ingests (one provider connection each), their subscribers, buffer and rate.
            ingest: (() => { try { return { enabled: settings.sharedIngestEnabled === true, ...require('../services/ingest').status() }; } catch (e) { return null; } })(),
            // R7 data (0287): each channel's worst lag behind real time per provider, last 30 days.
            feedLag: (() => {
                try { return { limitSec: require('../services/feedLagLimit').baseOf(require('../services/ingest').tuning.behindMs) / 1000, channels: require('../services/feedLag').summary() }; } catch (e) { return null; }
            })(),
            // 0161 (C-I): ESPN fixture coverage, per league - last successful fetch, fixture
            // count, last error. Never a URL (sportsFixtures.statusSummary never puts one in).
            sportFixtures: sportsFixtures.statusSummary(),
            // R09: the sport event list's builds (on a worker thread): count, last build time, the
            // worst event-loop stall seen during it, and how long the served list has been stale.
            sportEvents: require('../services/sportsEvents').status(),
            // R16: the recording preparation queue (0193), and the server's own event-loop lateness.
            preparation: preparationQueue(),
            // R3: segmented recordings' appdata folder and what is still in it (being recorded, being
            // finished, waiting for the recordings folder, or failed with its segments kept).
            segmentedRecordings: (() => { try { return { enabled: settings.segmentedRecordings === true, ...require('../services/recordingSegments').status() }; } catch (e) { return null; } })(),
            loopDelay: require('../services/loopDelay').summary(),
            sync: await syncStatus(),
            // Plan B1 (0216): catch-up as each provider flags it (tv_archive), from the last raw fetch.
            catchup: (() => {
                try {
                    return require('../services/rawChannels').archiveSummary()
                        .map(r => ({ ...r, provider: providerName(r.sourceId) }));
                } catch (e) { return []; }
            })(),
            // R12: the database copies in data/backups (file name, why, when, size; never a path).
            backups: (() => {
                try {
                    const dbBackup = require('../services/dbBackup');
                    return dbBackup.list(require('../db/sqlite').databasePath())
                        .map(({ file, reason, at, bytes }) => ({ file, reason, at, bytes }));
                } catch (e) { return []; }
            })(),
            disk: {
                transcodeCache: diskAt(transcodeSession.CACHE_DIR),
                // #8: the share's line is cached and refreshed off the event loop; a request never touches the share.
                recordings: require('../services/shareFs').diskInfo(settings.recordingsPath || '/app/recordings')
            }
        };
        res.set('Cache-Control', 'no-store');
        res.json(scrubUrls(status));
    } catch (err) {
        console.error('[Status] failed:', err.message);
        res.status(500).json({ error: 'Could not read the server status' });
    }
});

router._scrubUrls = scrubUrls;

module.exports = router;
