'use strict';
/**
 * 0285: settings no code reads any more, left behind by removed features (12 on the live server,
 * 27 Oct). server/db.js never saves them again, whatever an older client sends (the start-up delete that
 * cleared stored ones ran on every database from 0285 on; D-57 retired it), and never hands out one an older
 * server stored (#322). Kept out of db.js so verify-build's checks that these never return to the defaults stay
 * meaningful.
 * `requireStreamAuth` misled most: media routes always need a token (0196).
 * #322 (Mark, 14 Nov 2026): a re-encode is fixed at 1080p, medium quality, audio mix auto (`maxResolution`, `quality`,
 * `audioMixPreset`), and web upscaling is gone (`upscaleEnabled`, `upscaleMethod`, `upscaleTarget`): it re-encoded
 * every web play. The web's now-playing overlay shows for 5 s and the last volume is always remembered
 * (`overlayDuration`, `defaultVolume`, `rememberVolume`).
 */
module.exports = Object.freeze(['autoPlayNextEpisode', 'autoTranscode', 'forceProxy', 'forceRemux', 'forceTranscode',
    'forceVideoTranscode', 'probeCacheTTL', 'requireStreamAuth', 'seriesProbeCacheDays', 'showMovies', 'showSeries',
    'streamFormat',
    // #322
    'maxResolution', 'quality', 'audioMixPreset', 'upscaleEnabled', 'upscaleMethod', 'upscaleTarget',
    'overlayDuration', 'defaultVolume', 'rememberVolume']);
