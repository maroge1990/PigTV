const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The web app's string checks, moved out of scripts/verify-build.sh (#275) so that editing the web app does not mean
// editing a shell script. Each row says: this file must contain (or, with absent: true, must NOT contain) this text,
// and `why` is the build and the reason it was added. A web edit that breaks one fails the test for that file and
// names every broken row, not just the first.
//
// A row's pattern is either `text`, a plain substring, or `bre`, a grep basic regular expression (what the script's
// `grep -q` read): `.` matches any character, `\|` is "or", `\[` is a literal bracket. Both match within one line, as
// grep does. Add a row only for something that has already gone wrong once; behaviour belongs in a real test.
// Rows are grouped by file, then in the order they were added.

const ROWS = [

    // public/css/main.css
    { file: 'css/main.css', text: 'epg-channel-info {', why: '0017: guide cell + transcode + uncategorized: whole-cell cursor' },
    { file: 'css/main.css', text: 'btn-go-live', why: '0019: category order preserved client-side: live button styles' },
    { file: 'css/main.css', bre: 'lockup-horizontal-light.svg', why: '0021: PigTV rebrand + recording fix: navbar lockup, light theme' },
    { file: 'css/main.css', bre: 'lockup-horizontal-dark.svg', why: '0021: PigTV rebrand + recording fix: navbar lockup, dark theme' },
    { file: 'css/main.css', text: 'EF7AAE', why: '0021: PigTV rebrand + recording fix: accent retuned (the 3 Oct brand refresh)' },
    { file: 'css/main.css', text: 'pig-canvas: var(--color-bg-primary)', why: '0021: PigTV rebrand + recording fix: --pig-* aliases bridge the vendored CSS' },
    { file: 'css/main.css', bre: 'data-theme=.light', why: '0022: HE-AAC, categories, themes, compression: light tokens' },
    { file: 'css/main.css', text: 'skip-ad-btn', why: '0032: ad detection: skip button styles' },
    { file: 'css/main.css', bre: '.transcode-status.error', why: '0065: Web player media-error reporting: the error badge has a style' },
    { file: 'css/main.css', bre: '.movie-card', absent: true, why: '0122: the fork\'s leftovers removed (W2.1): no movie/series CSS' },

    // public/index.html
    { file: 'index.html', text: 'recording-conflict-banner', why: '0007: Recording banner: banner markup' },
    { file: 'index.html', text: 'data-tab="recording"', why: '0017: settings reorganisation: Recording tab' },
    { file: 'index.html', text: 'id="tab-ui"', why: '0017: settings reorganisation: UI panel (under System)' },
    { file: 'index.html', text: 'data-tab="system"', why: '0017: settings reorganisation: System tab' },
    { file: 'index.html', text: 'setting-vaapi-hw-decode', why: '0018: transcode strategy: hw decode toggle' },
    { file: 'index.html', text: 'btn-stop', why: '0019: category order preserved client-side: stop button markup' },
    { file: 'index.html', text: 'btn-go-live', why: '0019: category order preserved client-side: go-live button markup' },
    { file: 'index.html', text: 'brand-lockup', why: '0021: PigTV rebrand + recording fix: product lockup in navbar' },
    { file: 'index.html', text: 'pig-canvas-bloom', why: '0021: PigTV rebrand + recording fix: corner bloom on the app canvas' },
    { file: 'index.html', text: 'pig-glass', why: '0021: PigTV rebrand + recording fix: glass navbar' },
    { file: 'index.html', text: 'pig-splash', why: '0021: PigTV rebrand + recording fix: loading splash' },
    { file: 'index.html', bre: 'css/pig-radiance.css', why: '0021: PigTV rebrand + recording fix: vendored radiance CSS linked (app)' },
    { file: 'index.html', bre: 'css/pig-glass.css', why: '0021: PigTV rebrand + recording fix: vendored glass CSS linked (app)' },
    { file: 'index.html', bre: 'site.webmanifest', why: '0021: PigTV rebrand + recording fix: web manifest linked (app)' },
    { file: 'index.html', bre: 'web-light-180.png', why: '0021: PigTV rebrand + recording fix: apple-touch-icon (app)' },
    { file: 'index.html', bre: 'favicon-dark.ico', why: '0021: PigTV rebrand + recording fix: dark favicon fallback' },
    { file: 'index.html', bre: 'js/theme.js', why: '0022: HE-AAC, categories, themes, compression: theme loaded early' },
    { file: 'index.html', text: 'setting-theme', why: '0022: HE-AAC, categories, themes, compression: theme selector' },
    { file: 'index.html', text: 'dvr-setting-bitrate', why: '0022: HE-AAC, categories, themes, compression: compression tuning UI' },
    { file: 'index.html', text: 'pair-code', why: '0027: devices, library, history: pairing UI' },
    { file: 'index.html', text: 'dvr-setting-addetect', why: '0032: ad detection: detection setting' },
    { file: 'index.html', text: 'version-badge', why: '0048: Build identity surfaced: badge markup present in the header' },
    { file: 'index.html', text: 'SSO token', absent: true, why: '0077: OIDC / SSO and express-session removed (review P2-1, P1-7): the page no longer stores a ?token= from the URL' },
    { file: 'index.html', text: 'setting-force-remux-tc', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the settings page (grep proves presence, not that something is gone): setting-force-remux-tc' },
    { file: 'index.html', text: 'setting-hls-delivery-tc', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the settings page (grep proves presence, not that something is gone): setting-hls-delivery-tc' },
    { file: 'index.html', text: 'setting-auto-transcode-tc', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the settings page (grep proves presence, not that something is gone): setting-auto-transcode-tc' },
    { file: 'index.html', text: 'content-type-movies', absent: true, why: '0121: the web reads /api/library (W2.1): the picker\'s movie/series tabs are gone' },
    { file: 'index.html', text: 'data-page="movies"', absent: true, why: '0122: the fork\'s leftovers removed (W2.1): no Movies nav entry' },
    { file: 'index.html', text: 'data-page="series"', absent: true, why: '0122: the fork\'s leftovers removed (W2.1): no Series nav entry' },
    { file: 'index.html', text: 'id="page-watch"', absent: true, why: '0122: the fork\'s leftovers removed (W2.1): no VOD watch page markup' },
    { file: 'index.html', text: 'data-subtab="lineup"', why: '0123: channel-number editor (Settings -> Channel numbers): the Settings view exists (under Channels, 0182)' },
    { file: 'index.html', text: 'id="lineup-list"', why: '0123: channel-number editor (Settings -> Channel numbers): with its list' },
    { file: 'index.html', text: 'data-page="status"', why: '0124: admin status page (W2.2): with an admin nav entry' },
    { file: 'index.html', text: 'data-subtab="epg">EPG matching', why: '0134: EPG matching (S4.2): Settings has an EPG matching view (under Channels, 0182)' },
    { file: 'index.html', text: 'data-tab="sports">Sport</button>', why: '0149: web Settings -> Sports (C-I): a Sport tab (#276: "Sport" everywhere a person reads, never "Sports")' },
    { file: 'index.html', text: 'id="sports-preview-list"', why: '0149: web Settings -> Sports (C-I): with the preview table' },
    { file: 'index.html', bre: '<script src="/js/pages/SportSettings.js', why: '0149: web Settings -> Sports (C-I): Settings › Your sport is loaded' },
    { file: 'index.html', text: 'Recognised in the next 72 hours', why: '0153: the sport horizon is a whole weekend (C-I): the web preview says so' },
    { file: 'index.html', text: 'dvr-setting-prompt-timeout', why: '0158: an unanswered recording prompt no longer blocks a recording forever: and a web Settings field' },
    { file: 'index.html', text: 'id="tab-providers"', why: '0172: the provider admin pages (multi-provider P4): the Providers tab has its section' },
    { file: 'index.html', text: 'id="tab-backuplinks"', why: '0172: the provider admin pages (multi-provider P4): and so does Backup links' },
    { file: 'index.html', bre: 'pages/BackupLinksSettings.js', why: '0172: the provider admin pages (multi-provider P4): its script is loaded (before Settings.js builds it)' },
    { file: 'index.html', text: 'data-tab="channels">Channels', why: '0182-0187: one Providers section, six tabs, sport lists, the build number: six tabs: Channels' },
    { file: 'index.html', text: 'id="subtabs-channels"', why: '0182-0187: one Providers section, six tabs, sport lists, the build number: with its three views on a strip' },
    { file: 'index.html', text: 'data-tab="sources"', absent: true, why: '0182-0187: one Providers section, six tabs, sport lists, the build number: the Sources tab is gone' },
    { file: 'index.html', text: 'id="tab-debug"', absent: true, why: '0182-0187: one Providers section, six tabs, sport lists, the build number: the Debug tab is gone' },
    { file: 'index.html', text: 'id="setting-relay-enabled"', why: '0188-0189: interruptions, in-stream recovery and the standby (off by default): Settings has the In-stream recovery switch' },
    { file: 'index.html', text: 'id="setting-standby-enabled"', why: '0188-0189: interruptions, in-stream recovery and the standby (off by default): Settings has the Hot standby switch' },
    { file: 'index.html', text: 'id="setting-warm-next-channel"', why: 'R11: the warming switch is in Settings: Settings has a Warm the next channel switch' },
    { file: 'index.html', text: 'id="setting-max-resolution"', absent: true, why: '#322: re-encodes are fixed at 1080p, medium quality, audio mix auto: no Max resolution control' },
    { file: 'index.html', text: 'id="setting-quality"', absent: true, why: '#322: re-encodes are fixed at 1080p, medium quality, audio mix auto: no Quality preset control' },
    { file: 'index.html', text: 'id="setting-audio-mix"', absent: true, why: '#322: re-encodes are fixed at 1080p, medium quality, audio mix auto: no Audio mix preset control' },
    { file: 'index.html', text: 'setting-upscale', absent: true, why: '#322: web upscaling removed (it re-encoded every web play): no Upscaling controls' },
    { file: 'index.html', text: 'setting-overlay-duration', absent: true, why: '#322: the now-playing overlay shows for 5 s: no duration control' },
    { file: 'index.html', text: 'setting-default-volume', absent: true, why: '#322: the last volume is always remembered: no default volume control' },
    { file: 'index.html', text: 'setting-remember-volume', absent: true, why: '#322: the last volume is always remembered: no Remember last volume switch' },

    // public/js/api.js
    { file: 'js/api.js', text: 'killAllSessions', why: '0017: settings reorganisation: transcode api group' },
    { file: 'js/api.js', text: 'compress:', why: '0023: light theme fix + manual compress: compress api method' },
    { file: 'js/api.js', text: 'withStreamToken', why: '0038: web client sends stream auth tokens: shared token helper exists' },
    { file: 'js/api.js', text: 'streamFetch', why: '0038: web client sends stream auth tokens: authenticated fetch helper for transcode management calls' },
    { file: 'js/api.js', bre: 'streamUrl: (id) => API.withStreamToken', why: '0045: native recording playback contract: web client sends token on recording stream URL' },
    { file: 'js/api.js', bre: 'downloadUrl: (id) => API.withStreamToken', why: '0045: native recording playback contract: web client sends token on recording download URL' },
    { file: 'js/api.js', bre: 'API.request(\'GET\', \'/library/categories\')', why: '0121: the web reads /api/library (W2.1): api.js has the library helpers' },
    { file: 'js/api.js', bre: '/sources/${id}/catalogue?type=live', why: '0121: the web reads /api/library (W2.1): and the Sources catalogue' },
    { file: 'js/api.js', text: 'proxy: {', absent: true, why: '0122: the fork\'s leftovers removed (W2.1): api.js has no proxy helpers' },
    { file: 'js/api.js', bre: 'API.request(\'PUT\', \'/lineup/numbers\', { numbers })', why: '0123: channel-number editor (Settings -> Channel numbers): api.js saves through PUT /api/lineup/numbers' },
    { file: 'js/api.js', bre: 'API.request(\'PUT\', \'/sports/follow\'', absent: true, why: '0149: web Settings -> Sports (C-I): no keyword list to save (D-42)' },

    // public/js/app.js
    { file: 'js/app.js', text: 'updateRecordingBanner', why: '0007: Recording banner: banner polling' },
    { file: 'js/app.js', text: 'applyContentVisibility', absent: true, why: '0009: Movies/Series toggle (removed with Movies/Series in 0122): no movies/series visibility code left' },
    { file: 'js/app.js', bre: 'data.display', why: '0048: Build identity surfaced: webapp badge renders the server\'s display string' },

    // public/js/components/ChannelList.js
    { file: 'js/components/ChannelList.js', bre: 'categoryNames.get(`${row.sourceId}:${row.category}`) || row.category', why: '0017: guide cell + transcode + uncategorized: group name fallback (0121: from /api/library/categories, else the category id)' },
    { file: 'js/components/ChannelList.js', bre: 'a.localeCompare(b)', absent: true, why: '0019: category order preserved client-side: ChannelList group sort removed' },
    { file: 'js/components/ChannelList.js', text: 'Choose what to show under Settings', why: '0022: HE-AAC, categories, themes, compression: empty state wording (0121: points at Manage Content when a source exists)' },
    { file: 'js/components/ChannelList.js', bre: 'API.library.allChannels()', why: '0121: the web reads /api/library (W2.1): the live sidebar pages /api/library/channels' },
    { file: 'js/components/ChannelList.js', bre: 'API.library.favourites()', why: '0121: the web reads /api/library (W2.1): and reads /api/library/favourites' },
    { file: 'js/components/ChannelList.js', bre: 'window.app.player.play(channel, null)', why: '0121: the web reads /api/library (W2.1): and plays by channel identity, never a stream URL' },
    { file: 'js/components/ChannelList.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/components/ChannelList.js no longer calls the Xtream-emulation or whole-EPG routes' },

    // public/js/components/EpgGuide.js
    { file: 'js/components/EpgGuide.js', text: 'navigateTo', why: '0010: Guide → Live TV: navigation call' },
    { file: 'js/components/EpgGuide.js', bre: 'channelId.*sourceId', why: '0010: Guide → Live TV: ID-based lookup' },
    { file: 'js/components/EpgGuide.js', text: 'resize-handle', why: '0017: guide cell + transcode + uncategorized: whole-cell click guard' },
    { file: 'js/components/EpgGuide.js', bre: 'API.library.guide({ start, end, limit: 500, cursor })', why: '0121: the web reads /api/library (W2.1): the guide pages /api/library/guide with a cursor' },
    { file: 'js/components/EpgGuide.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/components/EpgGuide.js no longer calls the Xtream-emulation or whole-EPG routes' },

    // public/js/components/SourceManager.js
    { file: 'js/components/SourceManager.js', text: 'localeCompare', absent: true, why: '0019: category order preserved client-side: SourceManager sorts removed' },
    { file: 'js/components/SourceManager.js', text: 'groupItemType()', why: '0022: HE-AAC, categories, themes, compression: group type helper' },
    { file: 'js/components/SourceManager.js', bre: 'const groupKey = `${groupItemType}:${group.categoryId}`;', why: '0072: Hide All / Show All update the group checkboxes: setAllVisibility updates the group key that the checkbox is drawn from' },
    { file: 'js/components/SourceManager.js', bre: 'API.sources.catalogue(sourceId)', why: '0121: the web reads /api/library (W2.1): the Sources picker reads the catalogue' },
    { file: 'js/components/SourceManager.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/components/SourceManager.js no longer calls the Xtream-emulation or whole-EPG routes' },
    { file: 'js/components/SourceManager.js', text: 'sportToggleHtml(group)', why: '0146: sport categories (C-H): the web Sources picker has a Sport toggle' },
    { file: 'js/components/SourceManager.js', text: 'Sport on now row', absent: true, why: '0149: web Settings -> Sports (C-I): the Sport toggle no longer promises the old Home row' },

    // public/js/components/VideoPlayer.js
    { file: 'js/components/VideoPlayer.js', text: 'getCodecCapabilities', why: '0018: transcode strategy: client caps detection' },
    { file: 'js/components/VideoPlayer.js', text: '    stop() {', why: '0019: category order preserved client-side: stop implementation (0102 removed the unused async duplicate)' },
    { file: 'js/components/VideoPlayer.js', text: 'goToLive', why: '0019: category order preserved client-side: go-live implementation' },
    { file: 'js/components/VideoPlayer.js', text: 'updateLiveButton', why: '0019: category order preserved client-side: live indicator' },
    { file: 'js/components/VideoPlayer.js', text: 'resolvePlayback', why: '0027: devices, library, history: client uses resolve' },
    { file: 'js/components/VideoPlayer.js', text: 'startConflictWatch', why: '0031: coordinator + favourites: client watches for conflicts' },
    { file: 'js/components/VideoPlayer.js', bre: 'API.withStreamToken(decision.url)', why: '0038: web client sends stream auth tokens: resolved playback URL carries token' },
    { file: 'js/components/VideoPlayer.js', text: 'viewer-in-progress', why: '0055: Viewer-vs-viewer arbitration + live idle timeout (A3): web player words the prompt for another viewer' },
    { file: 'js/components/VideoPlayer.js', bre: 'addEventListener(\'error\', () => this.handleMediaError())', why: '0065: Web player media-error reporting: the <video> error event is handled (it used to fail silently)' },
    { file: 'js/components/VideoPlayer.js', text: 'handleMediaError()', why: '0065: Web player media-error reporting: handler exists' },
    { file: 'js/components/VideoPlayer.js', bre: 'new URL(video.currentSrc, \'http://localhost\').pathname', why: '0065: Web player media-error reporting: only the URL path is logged/sent, never the query' },
    { file: 'js/components/VideoPlayer.js', bre: 'this.currentStrategy = decision.strategy', why: '0065: Web player media-error reporting: the server\'s chosen strategy is recorded for the report' },
    { file: 'js/components/VideoPlayer.js', bre: 'if (this.isSourceCleared(video)) return;', why: '0065: Web player media-error reporting: clearing the source (channel change) is not reported as a failure' },
    { file: 'js/components/VideoPlayer.js', text: 'shouldRetryWithAudioEncode(details)', why: '0068: Audio re-encode self-heal (remux path): the player retries a failed remux' },
    { file: 'js/components/VideoPlayer.js', bre: 'if (this._audioEncodeActive) return false;', why: '0068: Audio re-encode self-heal (remux path): it never retries a play that was already re-encoding (no loop)' },
    { file: 'js/components/VideoPlayer.js', bre: '            this._audioRetryKey = null;', why: '0068: Audio re-encode self-heal (remux path): each fresh selection gets one retry, the retry itself does not' },
    { file: 'js/components/VideoPlayer.js', bre: 'this.rememberAudioEncode(this.currentChannel, false)', why: '0068: Audio re-encode self-heal (remux path): a flag that did not help is forgotten' },
    { file: 'js/components/VideoPlayer.js', text: 'isSourceCleared(video)', why: '0069: cleared-source errors are not playback failures: the handler asks whether the source was just cleared' },
    { file: 'js/components/VideoPlayer.js', bre: 'video.getAttribute(\'src\')', why: '0069: cleared-source errors are not playback failures: by the src attribute, which is reliable (currentSrc is not: Chrome keeps the old URL)' },
    { file: 'js/components/VideoPlayer.js', text: 'empty src attribute', why: '0069: cleared-source errors are not playback failures: with the browser\'s own message as a second check' },
    { file: 'js/components/VideoPlayer.js', bre: 'if (!video || !video.currentSrc || !video.error) return;', absent: true, why: '0069: cleared-source errors are not playback failures: no currentSrc-only guard left (Chrome keeps the old URL there)' },
    { file: 'js/components/VideoPlayer.js', bre: 'addEventListener(\'loadstart\', () => this.armStartWatch())', why: '0070: diagnostics for silent \'nothing plays\' failures: the player watches for a load that never starts' },
    { file: 'js/components/VideoPlayer.js', bre: 'addEventListener(\'playing\', () => { this.clearStartWatch();', why: '0070: diagnostics for silent \'nothing plays\' failures: and stops watching once it plays' },
    { file: 'js/components/VideoPlayer.js', text: 'event: \'start-timeout\'', why: '0070: diagnostics for silent \'nothing plays\' failures: and reports it' },
    { file: 'js/components/VideoPlayer.js', bre: 'if (video.paused || video.currentTime > 0) return;', why: '0070: diagnostics for silent \'nothing plays\' failures: but not when paused or already moving' },
    { file: 'js/components/VideoPlayer.js', bre: 'this.notePlaying(); });', why: '0075: HLS delivery (beta) for the web player, and play-start / play-end measurement: the first picture is measured on the element\'s \'playing\' event' },
    { file: 'js/components/VideoPlayer.js', bre: 'this.reportPlayEnd();', why: '0075: HLS delivery (beta) for the web player, and play-start / play-end measurement: and the play is closed out when it stops' },
    { file: 'js/components/VideoPlayer.js', text: 'handleHlsFatal(data)', why: '0075: HLS delivery (beta) for the web player, and play-start / play-end measurement: a fatal hls.js error is no longer swallowed' },
    { file: 'js/components/VideoPlayer.js', bre: 'VideoPlayer.CANCELLED = Symbol', why: '0087: cancelling the takeover prompt stops the play instead of taking the stream anyway: a declined takeover has its own answer, distinct from null' },
    { file: 'js/components/VideoPlayer.js', bre: 'decision === VideoPlayer.CANCELLED', why: '0087: cancelling the takeover prompt stops the play instead of taking the stream anyway: and play() stops there rather than falling through to the local strategy' },
    { file: 'js/components/VideoPlayer.js', text: 'abandonPlay()', why: '0087: cancelling the takeover prompt stops the play instead of taking the stream anyway: the screen goes back to how it was, with no play-start reported' },
    { file: 'js/components/VideoPlayer.js', text: '                segmentedDelivery: true', why: '0102: the web player is on the one path (Phase 3): every browser asks for HLS segments, as the Apple client does' },
    { file: 'js/components/VideoPlayer.js', text: 'recoverPlayback(reason', why: '0102: the web player is on the one path (Phase 3): recovery is a fresh resolve, once per selection' },
    { file: 'js/components/VideoPlayer.js', bre: 'hls.recoverMediaError();', why: '0102: the web player is on the one path (Phase 3): a fatal media error is first recovered in place' },
    { file: 'js/components/VideoPlayer.js', bre: 'this.stopConflictWatch();', why: '0102: the web player is on the one path (Phase 3): stop() also ends the recording-conflict poll' },
    { file: 'js/components/VideoPlayer.js', text: '/api/remux', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): /api/remux' },
    { file: 'js/components/VideoPlayer.js', text: '/api/transcode?url=', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): /api/transcode?url=' },
    { file: 'js/components/VideoPlayer.js', text: '/api/probe', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): /api/probe' },
    { file: 'js/components/VideoPlayer.js', text: 'startTranscodeSession', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): startTranscodeSession' },
    { file: 'js/components/VideoPlayer.js', text: 'forceRemux', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): forceRemux' },
    { file: 'js/components/VideoPlayer.js', text: 'autoTranscode', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): autoTranscode' },
    { file: 'js/components/VideoPlayer.js', text: 'pigtv_hls_delivery', absent: true, why: '0102: the web player is on the one path (Phase 3): no second delivery path in the live player (grep proves presence, not that something is gone): pigtv_hls_delivery' },
    { file: 'js/components/VideoPlayer.js', bre: 'stream.m3u8', absent: true, why: '0115: frame-rate-aware master playlist for every session: the web player does not assume the media playlist name' },
    { file: 'js/components/VideoPlayer.js', text: 'heaac', absent: true, why: '0116: HE-AAC passthrough for clients that can decode it: the web player never sends heaac (Chrome cannot decode HE-AAC)' },
    { file: 'js/components/VideoPlayer.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/components/VideoPlayer.js no longer calls the Xtream-emulation or whole-EPG routes' },
    { file: 'js/components/VideoPlayer.js', bre: '!this.currentStreamUrl', absent: true, why: '0121: the web reads /api/library (W2.1): recovery replays a channel by identity, without a stream URL' },
    { file: 'js/components/VideoPlayer.js', bre: 'if (res.status === 499) return VideoPlayer.SUPERSEDED;', why: '0180: a start stopped on request is not a provider failure (P10): the web player ignores a superseded resolve' },

    // public/js/pages/Guide.js
    { file: 'js/pages/Guide.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/pages/Guide.js no longer calls the Xtream-emulation or whole-EPG routes' },

    // public/js/pages/LivePage.js
    { file: 'js/pages/LivePage.js', bre: '/proxy/xtream\\|/proxy/epg\\|API\\.proxy', absent: true, why: '0121: the web reads /api/library (W2.1): public/js/pages/LivePage.js no longer calls the Xtream-emulation or whole-EPG routes' },

    // public/js/pages/ProvidersSettings.js
    { file: 'js/pages/ProvidersSettings.js', bre: 'for (const k of \\[\'epgUrl\', \'idOverlayUrl\'\\]) if (v(k) !== String(saved\\[k\\] ?? \'\')) body\\[k\\] = v(k);', why: '0172: the provider admin pages (multi-provider P4): 0182: an emptied guide or overlay address is removed, an unchanged one is not sent' },
    { file: 'js/pages/ProvidersSettings.js', bre: 'p.idOverlayUrl', absent: true, why: '0172: the provider admin pages (multi-provider P4): the page never reads the stored overlay address' },
    { file: 'js/pages/ProvidersSettings.js', bre: 'these count as one connection. Check this provider\'s settings.', why: '0181: the same account is one connection pool (P10): Settings -> Providers warns' },

    // public/js/pages/RecordingsPage.js
    { file: 'js/pages/RecordingsPage.js', text: 'startCompressionWatch', why: '0023: light theme fix + manual compress: compression polling' },
    { file: 'js/pages/RecordingsPage.js', bre: 'this.recordings = items', why: '0023: light theme fix + manual compress: recordings list stored' },
    { file: 'js/pages/RecordingsPage.js', text: 'resumeCompressionWatchIfNeeded', why: '0025: CQP fallback + status: resumes watching' },
    { file: 'js/pages/RecordingsPage.js', bre: 'recordingsList.offsetParent', why: '0025: CQP fallback + status: pauses when off screen' },
    { file: 'js/pages/RecordingsPage.js', text: 'attachAdSkipping', why: '0032: ad detection: player skip support' },
    { file: 'js/pages/RecordingsPage.js', text: 'waiting: \'Waiting for viewer\'', why: '0082: a recording waiting for a viewer is listed, cancellable and not duplicated: the web page labels it instead of showing the raw status' },
    { file: 'js/pages/RecordingsPage.js', text: 'renderRecentProblems(items)', why: '0156: schedule observability and recent problems: the web Recordings page has a Recent problems section' },

    // public/js/pages/Settings.js
    { file: 'js/pages/Settings.js', text: 'loadUiSettings', why: '0009: Movies/Series toggle (removed with Movies/Series in 0122): UI load handler (theme)' },
    { file: 'js/pages/Settings.js', text: 'loadRecordingSettings', why: '0017: settings reorganisation: recording handlers' },
    { file: 'js/pages/Settings.js', text: 'loadUiSettings', why: '0017: settings reorganisation: ui handlers' },
    { file: 'js/pages/Settings.js', bre: 'API.lineup.get()', why: '0123: channel-number editor (Settings -> Channel numbers): the panel reads GET /api/lineup' },
    { file: 'js/pages/Settings.js', bre: 'if (panel === \'lineup\' && !this.lineupEdits?.size) this.loadLineup();', why: '0123: channel-number editor (Settings -> Channel numbers): and loads when the panel opens (unless numbers are typed but unsaved, #128)' },
    { file: 'js/pages/Settings.js', bre: 'this.setLineupStatus(UI.errorText(err', why: '0123: channel-number editor (Settings -> Channel numbers): the server\'s validation error is shown' },
    { file: 'js/pages/Settings.js', text: 'async loadEpgMatching()', why: '0134: EPG matching (S4.2): which loads the unmatched list' },
    { file: 'js/pages/Settings.js', bre: 'if (this.isAdmin()) this.loadSports();', why: '0149: web Settings -> Sports (C-I): loaded when the tab opens (the preview is admin-only)' },
    { file: 'js/pages/Settings.js', bre: 'this.sportFollow.load();', why: '0149: web Settings -> Sports (C-I): and filled when the tab opens' },
    { file: 'js/pages/Settings.js', bre: 'await this.loadSportsPreview();', why: '0149: web Settings -> Sports (C-I): the preview loads with the tab' },
    { file: 'js/pages/Settings.js', bre: 'this.sportsOpenKinds = new Set(\\[\'event\', \'replay\'\\]);', why: '0151: web Settings -> Sports preview grouped by kind: events and replays open, the rest collapsed' },
    { file: 'js/pages/Settings.js', bre: '\\[\'placeholder\', \'Placeholders\'\\]', why: '0151: web Settings -> Sports preview grouped by kind: grouped by kind' },
    { file: 'js/pages/Settings.js', text: 'guide title', why: '0151: web Settings -> Sports preview grouped by kind: the merged guide titles are listed' },
    { file: 'js/pages/Settings.js', bre: 'this.providers = new ProvidersSettings();', why: '0172: the provider admin pages (multi-provider P4): Settings builds the Providers panel' },
    { file: 'js/pages/Settings.js', bre: 'this.backupLinks = new BackupLinksSettings();', why: '0172: the provider admin pages (multi-provider P4): and the Backup links panel' },
    { file: 'js/pages/Settings.js', text: 'bind(\'setting-warm-next-channel\', \'warmNextChannel\');', why: 'R11: the warming switch is in Settings: and saves it' },
    { file: 'js/pages/Settings.js', bre: 'standby.checked = s.standbyEnabled === true && s.relayEnabled === true;', why: '0203: TS captures; audio re-encoded and decode-checked: Hot standby never shows ticked while recovery is off' },

    // public/js/pages/StatusPage.js
    { file: 'js/pages/StatusPage.js', text: 'data-kill-all', why: '0008+0014: M3U sort order + ID fix: stop-all button (Status page)' },
    { file: 'js/pages/StatusPage.js', text: 'killAllSessions', why: '0008+0014: M3U sort order + ID fix: stop button handler (Status page)' },
    { file: 'js/pages/StatusPage.js', text: 'data-kill-session', why: '0017: settings reorganisation: per-stream stop (Status page)' },
    { file: 'js/pages/StatusPage.js', text: 'pig-amount', why: '0021: PigTV rebrand + recording fix: rounded numerals on Status figures' },
    { file: 'js/pages/StatusPage.js', bre: 'setInterval(() => this.refresh(), this.refreshMs)', why: '0124: admin status page (W2.2): the page refreshes while shown' },
    { file: 'js/pages/StatusPage.js', text: 'Least reliable channels', why: '0133: channel health (C-G): and the web Status page shows them' },
    { file: 'js/pages/StatusPage.js', text: '\'Stalls\', \'Watched\'', why: '0142: stalls count towards channel health: the Status page shows stalls and minutes watched' },
    { file: 'js/pages/StatusPage.js', bre: 'this.loadEpgCategories();', why: '0147: EPG programme categories stored (C-I): the Status page shows the EPG categories' },
    { file: 'js/pages/StatusPage.js', text: 'renderRecordingsFolderWarning(folder)', why: '0157: the recordings folder is checked for real (missing, not writable, an unmounted share, low space): and shown as a warning banner on the web Status page' },
    { file: 'js/pages/StatusPage.js', text: 'renderSportFixtures(fx)', why: '0161: cricket league recognition, ESPN fixtures, the ESPN live/replay rule (C-I): and the web Status page shows it' },
    { file: 'js/pages/StatusPage.js', text: 'Blank picture', why: '0191: reconnect timestamp loop, blank pictures, raw captures: Status shows it' },

    // public/js/theme.js
    { file: 'js/theme.js', text: 'prefers-color-scheme', why: '0022: HE-AAC, categories, themes, compression: theme follows system' },

    // public/login.html
    { file: 'login.html', bre: 'lockup-stacked-light.svg', why: '0021: PigTV rebrand + recording fix: stacked lockup on login, light theme' },
    { file: 'login.html', bre: 'lockup-stacked-dark.svg', why: '0021: PigTV rebrand + recording fix: stacked lockup on login, dark theme' },
    { file: 'login.html', text: 'pig-canvas-bloom', why: '0021: PigTV rebrand + recording fix: corner bloom on login' },
    { file: 'login.html', bre: 'css/pig-radiance.css', why: '0021: PigTV rebrand + recording fix: vendored radiance CSS linked (login)' },
    { file: 'login.html', bre: 'site.webmanifest', why: '0021: PigTV rebrand + recording fix: web manifest linked (login)' },
    { file: 'login.html', bre: 'web-light-180.png', why: '0021: PigTV rebrand + recording fix: apple-touch-icon (login)' },
    { file: 'login.html', text: 'btn-sso-login', absent: true, why: '0077: OIDC / SSO and express-session removed (review P2-1, P1-7): no SSO button on the login page' },

    // public/site.webmanifest
    { file: 'site.webmanifest', text: '"scope": "/"', why: '0021: PigTV rebrand + recording fix: manifest scope' },
];

// Translate a GNU basic regular expression (as `grep` reads it) into a JS RegExp that matches within one line.
// Supports what the rows use: . * [...] ^ $ \| \( \) \+ \? and escaped literals; refuses anything else loudly.
function breToRegExp(bre) {
    let out = '';
    let atStart = true; // start of the pattern, or just after \( or \|: where * is literal and ^ is an anchor
    const isEnd = (i) => i === bre.length || bre.startsWith('\\)', i) || bre.startsWith('\\|', i);
    for (let i = 0; i < bre.length;) {
        const c = bre[i];
        if (c === '\\') {
            const n = bre[i + 1];
            if (n === undefined) throw new Error(`trailing backslash in ${bre}`);
            if (n === '|') { out += '|'; atStart = true; } else if (n === '(') { out += '('; atStart = true; } else if (n === ')') { out += ')'; atStart = false; } else if (n === '+' || n === '?') { out += n; atStart = false; } else if (/[A-Za-z0-9<>{}]/.test(n)) throw new Error(`unsupported BRE escape \\${n} in ${bre}`);
            else { out += '\\' + n; atStart = false; }
            i += 2;
        } else if (c === '[') {
            let j = i + 1;
            let set = '[';
            if (bre[j] === '^') { set += '^'; j++; }
            if (bre[j] === ']') { set += '\\]'; j++; }
            while (j < bre.length && bre[j] !== ']') {
                if (bre[j] === '[' && /[:.=]/.test(bre[j + 1] || '')) throw new Error(`unsupported bracket class in ${bre}`);
                set += bre[j] === '\\' || bre[j] === '[' ? '\\' + bre[j] : bre[j];
                j++;
            }
            if (j >= bre.length) throw new Error(`unterminated [ in ${bre}`);
            out += set + ']';
            i = j + 1;
            atStart = false;
        } else if (c === '*') {
            out += atStart ? '\\*' : '*';
            atStart = false;
            i++;
        } else if (c === '^') {
            out += atStart ? '^' : '\\^';
            i++;
        } else if (c === '$') {
            out += isEnd(i + 1) ? '$' : '\\$';
            atStart = false;
            i++;
        } else if (c === '.') {
            out += '.';
            atStart = false;
            i++;
        } else {
            out += /[+?(){}|\/]/.test(c) ? '\\' + c : c;
            atStart = false;
            i++;
        }
    }
    return new RegExp(out, 's');
}

function matcher(row) {
    if (row.text !== undefined) return (line) => line.includes(row.text);
    const re = breToRegExp(row.bre);
    return (line) => re.test(line);
}

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');

test('the BRE translator reads patterns the way grep does', () => {
    const m = (bre, line) => breToRegExp(bre).test(line);
    assert.ok(m('a.c', 'abc'));
    assert.ok(!m('a.c', 'ac'));
    assert.ok(m('foo\\|bar', 'xbar'));
    assert.ok(!m('foo|bar', 'xbar'), 'a bare | is a literal in a basic regular expression');
    assert.ok(m('foo|bar', 'foo|bar'));
    assert.ok(m('f(x)+', 'f(x)+'), '( ) + { } are literal unless escaped');
    assert.ok(m('a\\+', 'aaa') && !m('a\\+', 'b'));
    assert.ok(m('\\[a\\]', '[a]') && !m('\\[a\\]', 'a'));
    assert.ok(m('*a', '*a') && !m('*a', 'a'), 'a leading * is literal');
    assert.ok(m('a*b', 'b') && m('a*b', 'aab'));
    assert.ok(m('a^b', 'a^b') && m('a$b', 'a$b'), '^ and $ in the middle are literal');
    assert.ok(m('^ab', 'abc') && !m('^ab', 'cab'));
    assert.ok(m('ab$', 'cab') && !m('ab$', 'abc'));
    assert.ok(m('x\\(a\\|b\\)$', 'xb'));
    assert.ok(m('[a.]', '.') && !m('[a.]', 'b'));
    assert.ok(m('[^a]', 'b') && !m('[^a]', 'a'));
    assert.ok(m('[]a]', ']'));
    assert.ok(m('a\\.b', 'a.b') && !m('a\\.b', 'axb'));
    assert.ok(m('a/b', 'a/b'));
    assert.ok(m('a.b', 'a\rb'), '. matches a carriage return, as in grep');
    assert.throws(() => breToRegExp('a\\{2\\}'));
    assert.throws(() => breToRegExp('\\w'));
});

for (const file of [...new Set(ROWS.map((r) => r.file))]) {
    test(`public/${file}: the checks the build used to make hold`, () => {
        const lines = read(file).split('\n');
        const failures = [];
        for (const row of ROWS.filter((r) => r.file === file)) {
            const found = lines.some(matcher(row));
            const pat = row.text !== undefined ? row.text : row.bre;
            if (row.absent && found) failures.push(`STILL PRESENT: ${row.why}  [${pat}]`);
            if (!row.absent && !found) failures.push(`MISSING: ${row.why}  [${pat}]`);
        }
        assert.deepEqual(failures, []);
    });
}

// ---- #276: the words a person reads ---------------------------------------------------------------------------------
// One glossary, sentence case, no "!" and no emoji in labels, one "Loading…", plain buttons, one date format, one rose
// button per screen. The corpus is every piece of text the pages show: the text and the aria-label, title, placeholder and
// alt attributes of index.html and login.html, and the quoted strings (two words or more) of public/js outside code lines
// that only log. The tables below are the rules; an allow-list names what is deliberately kept, and why.

const JS_FILES = ['app.js', 'api.js', 'ui.js', 'providerReminders.js', 'recordingsFeed.js']
    .concat(fs.readdirSync(path.join(__dirname, '../public/js/pages')).map((f) => `pages/${f}`))
    .concat(fs.readdirSync(path.join(__dirname, '../public/js/components')).map((f) => `components/${f}`));
// VideoPlayer.js is outside this batch (its "✓ Copied!" and the strings it returns to Settings are listed in #276).
const WORDS_JS = JS_FILES.filter((f) => f !== 'components/VideoPlayer.js');

function htmlTexts(file) {
    const src = read(file).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    const out = [];
    const lineOf = (index) => src.slice(0, index).split('\n').length;
    for (const m of src.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) out.push({ where: `${file}:${lineOf(m.index)}`, text: m[1], kind: 'attr' });
    for (const m of src.matchAll(/>([^<>]+)</g)) {
        const text = m[1].replace(/\s+/g, ' ').trim();
        if (text) out.push({ where: `${file}:${lineOf(m.index)}`, text, kind: 'text' });
    }
    return out;
}

function jsTexts(file) {
    const out = [];
    read(`js/${file}`).split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || /\bconsole\.(log|warn|error)\b/.test(code)) return;
        const where = `js/${file}:${i + 1}`;
        for (const m of line.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g)) {
            // Markup and ${expressions} are not words: what is left between them is the text a person reads.
            const text = (m[1] ?? m[2] ?? m[3]).replace(/<[^>]*>/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/[\w-]+="[^"]*"/g, ' ').replace(/\s+/g, ' ').trim();
            if (/^[/.[#]/.test(text)) return; // a path, a selector
            if (/[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/.test(text) && !/^[\w./:#[\]=*,>~+-]+$/.test(text)) out.push({ where, text, kind: 'string' });
        }
        for (const m of line.matchAll(/>([^<>`'$]{2,}?)</g)) out.push({ where, text: m[1].trim(), kind: 'text' });
    });
    return out;
}

const CORPUS = [...htmlTexts('index.html'), ...htmlTexts('login.html'), ...WORDS_JS.flatMap(jsTexts)];

const offences = (rows, test) => rows.filter(test).map((r) => `${r.where}  ${r.text.slice(0, 90)}`);

test('#276 corpus: the pages and scripts yielded the text a person reads (a dead extractor would pass every rule)', () => {
    assert.ok(CORPUS.length > 800, `only ${CORPUS.length} pieces of text`);
    for (const must of ['Live TV', 'Add rule', 'Loading…', 'Sign in']) assert.ok(CORPUS.some((r) => r.text.includes(must)), must);
});

// The glossary: the word to use, and the words that mean the same thing.
const GLOSSARY = [
    { use: 'provider', banned: /\b[Ss]ources?\b/, why: 'a provider is never a "source"' },
    { use: 'provider / M3U address', banned: /\b[Pp]laylists?\b(?!\.m3u)/, why: 'a provider is never a "playlist"' },
    { use: 'Sport', banned: /\bSports\b/, why: '"Sport" is the page and the tab' },
    { use: 'Sign in / Sign out', banned: /\b(?:Logout|Log out|Log in|Sign In|Sign Out)\b/, why: 'Sign in and Sign out' },
    { use: 'favourite', banned: /\b[Ff]avorites?\b/, why: 'favourite(s), in words' },
    { use: 'Hide scores / Scores hidden', banned: /spoiler/i, why: 'the setting is "Hide scores" on every platform (code identifiers such as avoidSpoilers are not words a person reads)' },
    { use: 'guide / TV Guide', banned: /\bEPG\b(?! (?:matching|id|channel)\b)(?!\)? address)(?<!Search the EPG)(?<!the EPG)(?<!Type a name or EPG)/, why: 'the guide, not the "EPG": EPG only names the provider\'s EPG id on the matching screens' }
];
for (const rule of GLOSSARY) {
    test(`#276 glossary: say "${rule.use}" (${rule.why})`, () => {
        // Allowed: the settings tab's internal id, the storage key 'Favorites' (no spaces: it is not shown as written) and API paths.
        assert.deepEqual(offences(CORPUS, (r) => rule.banned.test(r.text) && !/^Favorites$/.test(r.text)), []);
    });
}

test('#276 glossary: the Words list is in docs/DESIGN.md', () => {
    const design = fs.readFileSync(path.join(__dirname, '../docs/DESIGN.md'), 'utf8');
    for (const word of ['provider', 'guide', 'Sport', 'Sign in', 'favourite', 'Hide scores']) assert.match(design, new RegExp(`\\*\\*Words\\*\\*[\\s\\S]*${word}`), word);
});

// Sentence case: a label's later words are lower case unless they are a name.
const NAMES = new Set(['PigTV', 'TV', 'Guide', 'Live', 'Apple', 'Home', 'Assistant', 'Chrome', 'VLC', 'TiviMate', 'NVIDIA', 'NVENC', 'AMD', 'AMF', 'Intel', 'QuickSync',
    'QSV', 'VAAPI', 'Lanczos', 'GPU', 'CPU', 'HEVC', 'Xtream', 'M3U', 'EPG', 'ITU', 'User-Agent', 'EPGenius', 'Docker', 'JSON', 'Sport', 'H.264', 'AAC', 'ITU-R', 'BS.775',
    'HTTP', 'URL', 'ntfy', 'Kansas', 'City', 'Chiefs', 'Collingwood', 'AFL', 'NFL', 'Linux', 'Unraid', 'Settings', 'Recordings', 'Providers', 'Channels', 'Backup', 'Manage',
    'Recording', 'Status', 'Playback', 'System', 'Show', 'Hide', 'Continue', 'Stop', 'Fullscreen', 'Picture-in-Picture', 'PgUp', 'PgDn', 'ESPN', 'Adding', 'Up', 'Down',
    'F1', 'EPL', 'NBA', 'MLB', 'UEFA', 'Cup', 'FA', 'League', 'Champions', 'Tour', 'Slams', 'Grand', 'Premier', 'Series', 'Club', 'Cricket', 'Eagles', 'Test', 'Save']);
const LABEL_TEXT = (r) => (r.kind === 'text' || r.kind === 'attr') && r.text.length < 70 && !/[.:?]\s|[.:?]$/.test(r.text) && !/[<>{}$=@/]/.test(r.text) && !/\d{3}/.test(r.text);
test('#276 sentence case: headings, labels, buttons and options do not capitalise every word', () => {
    const bad = offences(CORPUS.filter(LABEL_TEXT), (r) => {
        // Each part of "Event details · AFL" is a label of its own; entities (&larr;) and punctuation are not words.
        return r.text.replace(/&\w+;/g, ' ').split(/ · |–|—/).some((part) => {
            const words = part.replace(/[()&,→←]/g, ' ').split(/\s+/).filter(Boolean);
            return words.slice(1).some((w) => /^[A-Z][a-z]+$/.test(w) && !NAMES.has(w));
        });
    });
    assert.deepEqual(bad, []);
});
test('#276 sentence case: the labels the 10 Nov audit listed are gone', () => {
    const gone = ['Keyboard Controls', 'Now Playing Overlay', 'Display Duration', 'Volume Settings', 'Default Volume', 'Remember Last Volume', 'Keyboard Shortcuts', 'Detected Hardware',
        'Hardware Encoder', 'Max Resolution', 'Quality Preset', 'Audio Mix Preset', 'Hardware Decoding', 'Enable Upscaling', 'Upscale Method', 'Upscale Target', 'Scheduling Defaults',
        'Commercial Breaks', 'Save Recording Settings', 'User Management', 'Add New User', 'Edit User', 'New Password', 'Save Changes', 'Create Admin Account', 'Create Account',
        'Expand/Collapse All', 'Collapse All', 'Expand All', 'All Groups', 'All Sources', 'Up Next', 'Copy Stream URL'];
    assert.deepEqual(offences(CORPUS, (r) => gone.some((g) => r.text.includes(g)) && !/VideoPlayer/.test(r.where)), []);
});

test('#276 no exclamation mark and no emoji in anything a person reads', () => {
    assert.deepEqual(offences(CORPUS, (r) => /[A-Za-z0-9)]!(?!=)/.test(r.text) && !/^<!/.test(r.text)), []);
    // An icon-only button is one glyph with an aria-label; a label that mixes a glyph into words is the offence.
    assert.deepEqual(offences(CORPUS, (r) => /[✓✔✅⏳\u{1F300}-\u{1FAFF}☀-⛿]/u.test(r.text) && /[A-Za-z]{2,}/.test(r.text)), []);
});

test('#276 one "Loading…" and one "…": no three dots in a label, placeholder or message', () => {
    assert.deepEqual(offences(CORPUS, (r) => /[A-Za-z0-9]\.\.\.(?![.\w])/.test(r.text)), []);
});

test('#276 buttons name the thing and the action: no Confirm, OK or Submit', () => {
    assert.deepEqual(offences(CORPUS, (r) => /^(Confirm|OK|Okay|Submit|Yes|No)$/.test(r.text)), []);
    // Two saves never share a screen as a bare "Save".
    assert.deepEqual(offences(CORPUS, (r) => r.kind === 'text' && /^Save$/.test(r.text)), []);
});

test('#276 dates and times: one format (UI.time, UI.dateTime, UI.dateRange, UI.clock, UI.date), none of the browser\'s own', () => {
    const own = [];
    for (const file of JS_FILES.filter((f) => f !== 'ui.js')) {
        read(`js/${file}`).split('\n').forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '');
            // A Date's toLocale*String has no digits-only use here; a number's toLocaleString() (1,840) is a different thing.
            if (/toLocale(?:Date|Time)String\(|new Date\([^)]*\)\.toLocaleString\(|\b(?:d|date|dt)\.toLocaleString\(/.test(code)) own.push(`js/${file}:${i + 1}  ${code.trim().slice(0, 90)}`);
            if (/\b(?:DAYS|MONTHS)\b\s*[:=]\s*\[/.test(code)) own.push(`js/${file}:${i + 1}  hand-built day or month names`);
        });
    }
    assert.deepEqual(own, []);
});

test('#276 one rose button (btn-primary) per screen; a per-row action is never rose', () => {
    const html = read('index.html');
    const at = (id) => html.indexOf(`id="${id}"`);
    // A screen is a page, or a Settings tab (Playback, System: their panels sit one under the other).
    const screens = {
        'page-live': ['page-live', 'page-guide'], 'page-guide': ['page-guide', 'page-recordings'], 'page-recordings': ['page-recordings', 'page-status'],
        'Settings > Playback': ['tab-player', 'tab-content'], 'Settings > Manage content': ['tab-content', 'tab-providers'], 'Settings > Providers': ['tab-providers', 'tab-backuplinks'],
        'Settings > Backup links': ['tab-backuplinks', 'tab-lineup'], 'Settings > Channel numbers': ['tab-lineup', 'tab-epg'], 'Settings > EPG matching': ['tab-epg', 'tab-sports'],
        'Settings > Sport': ['tab-sports', 'tab-recording'], 'Settings > Recording': ['tab-recording', 'tab-ui'], 'Settings > System': ['tab-ui', 'edit-user-modal'],
        'Edit user dialog': ['edit-user-modal', 'app.js']
    };
    const counts = {};
    for (const [name, [from, to]] of Object.entries(screens)) {
        const a = at(from), b = to === 'app.js' ? html.length : at(to);
        assert.ok(a > 0 && b > a, name);
        counts[name] = (html.slice(a, b).match(/btn-primary/g) || []).length;
        assert.ok(counts[name] <= 1, `${name} has ${counts[name]} btn-primary`);
    }
    assert.ok(Object.values(counts).filter((n) => n === 1).length >= 6, 'the extractor found the primaries');
    // Scripts that draw buttons: at most this many btn-primary in the file, and why (each is its own screen or exclusive with the others).
    const SCRIPT_PRIMARIES = {
        'pages/RecordingsPage.js': [2, 'Play on the page (one recording at a time); Resume in the player dialog'],
        'pages/SportsPage.js': [1, 'the record dialog\'s Record this game or Save recording (a screen of its own); the empty page\'s button is a state block\'s primary: true'],
        'pages/SportView.js': [0, 'the Sport pages\' rose button is the hero\'s Watch or Remind me (.pill.primary)'],
        'pages/ProvidersSettings.js': [1, 'Add provider on the one new card; a saved card\'s Save is secondary'],
        'pages/SportSettings.js': [1, 'Follow this sport'],
        'components/EpgGuide.js': [1, 'Record in the programme dialog'],
        'components/SourceManager.js': [0, 'Show on a new group is a per-row action'],
        'components/ChannelList.js': [0, ''], 'pages/Settings.js': [0, ''], 'pages/StatusPage.js': [0, ''], 'pages/BackupLinksSettings.js': [0, ''], 'ui.js': [1, 'a state block\'s action may ask for primary: true']
    };
    for (const [file, [max, why]] of Object.entries(SCRIPT_PRIMARIES)) {
        const n = (read(`js/${file}`).replace(/\/\/.*$/gm, '').match(/btn-primary/g) || []).length;
        assert.ok(n <= max, `${file}: ${n} btn-primary, allowed ${max} (${why})`);
    }
    assert.match(read('js/pages/ProvidersSettings.js'), /\$\{saved \? 'btn-secondary' : 'btn-primary'\}/);
});

module.exports = { breToRegExp, matcher, ROWS };
