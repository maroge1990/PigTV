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

    // Comskip's build is allowed to fail, so whether it is actually present
    // has to be reported rather than assumed.
    let comskipAvailable = false;
    try {
        comskipAvailable = await require('../services/adDetect').isAvailable();
    } catch (e) { /* reported as unavailable */ }

    res.json({
        name: 'PigTV',
        version: pkg.version,
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
            streamTokenAuth: true    // stream endpoints accept ?token=
        },

        // What the server can produce, so a client knows what to ask for.
        comskipAvailable,

        playback: {
            strategies: ['direct', 'remux', 'transcode'],
            segmentTypes: ['mpegts', 'fmp4'],
            hlsSegmentDuration: 4
        }
    });
});

module.exports = router;
