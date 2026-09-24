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

router.get('/', async (req, res) => {
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
            // 0117 (C-A): library rows carry `number`; guide/channels are ordered by it.
            // Absent when PIGTV_CHANNEL_NUMBERS=0 (the rollback).
            ...(require('../services/channelNumbers').numbersEnabled() ? { channelNumbers: true } : {}),
            // 0119 (C-D): a `direct` resolve's url is /api/proxy/stream?h=<opaque handle>.
            // Absent when PIGTV_PLAYBACK_HANDLES=0 (the rollback).
            ...(require('../services/playbackHandles').handlesEnabled() ? { playbackHandles: true } : {}),
            // 0127 (C-E): recordings are taken from tuners and may be played as HLS
            // (GET /api/recordings/:id/playback answers container "hls", also while
            // recording). Only with PIGTV_TUNER=1.
            ...(require('../services/tuner').enabled() ? { recordingHls: true } : {})
        },

        // What the server can produce, so a client knows what to ask for.
        comskipAvailable,

        playback: {
            strategies: ['direct', 'transcode'],
            segmentTypes: ['mpegts', 'fmp4'],
            hlsSegmentDuration: 4
        }
    });
});

module.exports = router;
