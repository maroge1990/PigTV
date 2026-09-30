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

/**
 * The tuner model (PIGTV_TUNER=1, 0126): one row per viewer, with the tuner it
 * shares (`tuner`, `tunerViewers`); a tuner held only by a recording is a row
 * with no owner.
 */
function tunerRows(now) {
    const tuner = require('../services/tuner');
    const rows = [];
    for (const t of tuner.list()) {
        const options = t.options || {};
        const base = {
            channel: channelNameForUrl(t.url) || 'unknown',
            video: options.videoMode === 'copy' ? 'copy' : 'encode',
            audio: options.audioMode === 'copy' ? 'copy' : (options.audioMode === 'encode' ? 'encode' : 'auto'),
            segmentType: options.segmentType || null,
            uptimeSec: Math.round((now - t.startTime) / 1000),
            status: t.status,
            ffmpeg: ffmpegState(t),
            error: t.error || null,
            tuner: t.id,
            tunerViewers: t.viewers.size,
            recordings: t.recordingIds().length
        };
        const ids = [...t.viewers];
        if (ids.length === 0) rows.push({ ...base, id: t.id, owner: null, idleSec: null });
        for (const id of ids) {
            const v = tuner.getViewer(id);
            if (!v) continue;
            rows.push({ ...base, id: v.id, owner: v.owner || null, idleSec: Math.round((now - v.lastAccess) / 1000) });
        }
    }
    return rows;
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
    if (require('../services/tuner').enabled()) return tunerRows(now);
    return transcodeSession.getAllSessions().map(summary => {
        const session = transcodeSession.getSession(summary.id);
        const options = session?.options || {};
        return {
            id: summary.id,
            channel: channelNameForUrl(summary.url) || 'unknown',
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
    return sources.map(source => ({
        sourceId: source.id,
        name: source.name,
        type: source.type,
        enabled: !!source.enabled,
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

/** P8: Provider status for the Status page and admin reminder banner. */
function providersStatus(settings = {}) {
    try {
        const snapshot = providerRouting.snapshot();
        const activeStreams = streamCoordinator.activeStreams();
        const activeRecordings = recordingEngine.listActive();

        return (snapshot.providers || []).map(prov => {
            const id = Number(prov.id);
            // Count active sessions and recordings for this provider
            const streamCount = activeStreams.filter(s => s.providerId === id).length;
            const recCount = activeRecordings.filter(r => {
                const recProvider = r.providerId !== undefined ? r.providerId : (r.source_id ?? null);
                return recProvider === id;
            }).length;
            const used = streamCount + recCount;

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

router.get('/', async (req, res) => {
    try {
        const settings = await db.settings.get();
        const status = {
            generatedAt: Date.now(),
            build: require('../version'),
            providers: providersStatus(settings),
            sessions: liveSessions(),
            recordings: recordings(),
            recentProblems: recentProblems(),
            recordingsFolder: recordingsFolderHealth(),
            events: playbackEvents.recent(),
            // 0133 (C-G): the channels that failed to start most in the last 7 days.
            leastReliable: leastReliable(),
            // 0161 (C-I): ESPN fixture coverage, per league - last successful fetch, fixture
            // count, last error. Never a URL (sportsFixtures.statusSummary never puts one in).
            sportFixtures: sportsFixtures.statusSummary(),
            sync: await syncStatus(),
            disk: {
                transcodeCache: diskAt(transcodeSession.CACHE_DIR),
                recordings: diskAt(settings.recordingsPath || '/app/recordings')
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
