'use strict';
/**
 * 0285: settings no code reads any more, left behind by removed features (12 on the live server,
 * 27 Oct). server/db.js never saves them again, whatever an older client sends (the start-up delete that
 * cleared stored ones ran on every database from 0285 on; D-57 retired it). Kept out of db.js so verify-build's
 * checks that these never return to the defaults stay meaningful.
 * `requireStreamAuth` misled most: media routes always need a token (0196).
 */
module.exports = Object.freeze(['autoPlayNextEpisode', 'autoTranscode', 'forceProxy', 'forceRemux', 'forceTranscode',
    'forceVideoTranscode', 'probeCacheTTL', 'requireStreamAuth', 'seriesProbeCacheDays', 'showMovies', 'showSeries',
    'streamFormat']);
