/**
 * Server info
 *
 * What a client needs to know before it starts making assumptions. Without
 * this, every server-side change is potentially breaking: a client has no way
 * to tell an old PigTV from a new one, so it must either assume the worst or
 * fail in confusing ways.
 *
 * Unauthenticated on purpose — a client has to be able to check what it is
 * talking to before it has a token, and nothing here is sensitive.
 */

const express = require('express');
const router = express.Router();

// Bumped when the API changes in a way a client must notice. The package
// version tracks the product; this tracks the contract, and they move at
// different rates.
const API_VERSION = 1;

/**
 * A switchable flag's `{name: true}` or `{}`. A check that throws (a settings
 * or database failure behind it) leaves that flag out and is logged, so
 * /api/info still answers (0138); a client then does not use that feature.
 */
function safely(flag) {
    try {
        return flag();
    } catch (err) {
        console.warn('[Info] A feature check failed:', err.message);
        return {};
    }
}

async function sendInfo(req, res) {
    const pkg = require('../../package.json');
    const build = require('../version');

    // Comskip's build is allowed to fail, so whether it is actually present
    // has to be reported rather than assumed.
    let comskipAvailable = false;
    try {
        comskipAvailable = await require('../services/adDetect').isAvailable();
    } catch (e) { /* reported as unavailable */ }

    res.json({
        name: 'PigTV',
        version: pkg.version,
        // Which build this actually is, for testing: a client can show the
        // server's build alongside its own. See server/version.js.
        build: build.build,
        commit: build.commit,
        builtAt: build.builtAt,
        display: build.display,
        apiVersion: API_VERSION,

        // Feature flags rather than version comparisons: a client should ask
        // whether something exists, not infer it from a version number.
        features: {
            playbackResolve: true,   // POST /api/playback/resolve
            library: true,           // /api/library/*
            guide: true,             // /api/library/guide
            devicePairing: true,     // /api/devices/pair/*
            recordings: true,        // DVR
            recordingCompression: true,
            channelHistory: true,
            adDetection: true,       // endpoints exist; comskipAvailable says whether it can run
            streamCoordination: true,
            streamTokenAuth: true,   // stream endpoints accept ?token=

            // Behaviours a client may want to switch on, added after the flags above. A client
            // asks for the flag rather than guessing from a version number; an older server
            // simply does not list it.
            recordingPlaybackPolling: true,  // GET /api/recordings/:id/playback?async=1 may answer 202 {status:'preparing'}
            scheduledWaiting: true,          // /api/recordings/scheduled includes status 'waiting' and it can be cancelled
            viewerConflict: true,            // POST /api/playback/resolve may answer 409 conflict.type 'viewer-in-progress'
            epgLogoFallback: true,           // /api/library/* fill a missing logo from the EPG (no client-side icon index needed)
            clientEvents: true,              // POST /api/playback/client-event accepts player diagnostics
            playbackTerminalStatus: true,    // GET /api/playback/:sessionId/terminal-status says whether a dead session was taken over
            guideCursor: true,               // /api/library/guide accepts &cursor= (keyset paging) and limit up to 500
            guideVersion: true,              // GET /api/library/guide/version — cheap "did anything change?" check
            logoCache: true,                 // library `logo` fields are /api/logo/<key>, fetched and cached server-side
            // 0117 (C-A): library rows carry `number` (labels only; 0139 disabled number ordering).
            // Absent when PIGTV_CHANNEL_NUMBERS=0 (the rollback).
            ...safely(() => (require('../services/channelNumbers').numbersEnabled() ? { channelNumbers: true } : {})),
            // 0119 (C-D): a `direct` resolve's url is /api/proxy/stream?h=<opaque handle>.
            // Absent when PIGTV_PLAYBACK_HANDLES=0 (the rollback).
            ...safely(() => (require('../services/playbackHandles').handlesEnabled() ? { playbackHandles: true } : {})),
            // 0127 (C-E): recordings are taken from tuners and may be played as HLS
            // (GET /api/recordings/:id/playback answers container "hls", also while
            // recording). Only with PIGTV_TUNER=1.
            ...safely(() => (require('../services/tuner').enabled() ? { recordingHls: true } : {})),
            // 0128 (C-E): a live playlist may be hours long (timeshift), with
            // PROGRAM-DATE-TIME, delta updates and gzip. Only with PIGTV_TUNER=1 and
            // PIGTV_TIMESHIFT_HOURS above 0 (default 3).
            ...safely(() => (require('../services/tuner').timeshiftEnabled() ? { timeshift: true } : {})),
            // 0133 (C-G): library/guide and library/channels rows carry `health`
            // ("ok" | "flaky" | null) from the last 7 days' starts.
            channelHealth: true,
            // 0146 (C-H): library/categories rows carry `sport`; admins mark them
            // with PUT /api/library/categories/sport.
            sportCategories: true,
            // 0148 (C-I): GET /api/sports/events lists sport events recognised per
            // programme, each with its channels best first.
            sportsEvents: true,
            // 0156: GET /api/recordings/scheduled?include=recent also lists schedules
            // that ended up missed or failed in the last 7 days, each with its status
            // and error - a missed/failed recording no longer simply disappears.
            scheduleHistory: true,
            // 0168 (C-K): GET /api/providers/reminders lists providers whose subscription
            // ends within 7 days (or has ended).
            providerReminders: true,
            // 0174 (C-J): a channel resolve answers `provider: { id, name, role, via,
            // failover }` - which provider it plays on, and whether it failed over.
            providers: true
        },

        // What the server can produce, so a client knows what to ask for.
        comskipAvailable,

        playback: {
            strategies: ['direct', 'transcode'],
            segmentTypes: ['mpegts', 'fmp4'],
            hlsSegmentDuration: 4
        }
    });
}

router.get('/', async (req, res) => {
    try {
        await sendInfo(req, res);
    } catch (err) {
        // 0138: a client checks this before anything else, so it must get an
        // answer that identifies the server even when a feature check (a
        // settings or database read behind it) failed. No flags: a client then
        // uses none of the optional features, which is the safe reading.
        console.error('[Info] failed:', err.message);
        if (res.headersSent) return;
        let build = {};
        try { build = require('../version'); } catch { /* identity unknown */ }
        res.json({ name: 'PigTV', build: build.build || null, display: build.display || null, apiVersion: API_VERSION, features: {} });
    }
});

module.exports = router;
