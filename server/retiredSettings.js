'use strict';
/**
 * 0285: settings no code reads any more, left behind by removed features (12 on the live server,
 * 27 Oct). server/db.js drops them from the store at start and never saves them again. Kept out of
 * db.js so verify-build's checks that these never return to the defaults stay meaningful.
 * `requireStreamAuth` misled most: media routes always need a token (0196).
 */
module.exports = Object.freeze(['autoPlayNextEpisode', 'autoTranscode', 'forceProxy', 'forceRemux', 'forceTranscode',
    'forceVideoTranscode', 'probeCacheTTL', 'requireStreamAuth', 'seriesProbeCacheDays', 'showMovies', 'showSeries',
    'streamFormat']);
