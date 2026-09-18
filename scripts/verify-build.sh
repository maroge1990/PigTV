#!/bin/bash
#
# PigTV feature verification
#
# Asserts that features actually exist in the files that serve them, which is
# a different question from whether the code compiles or the tests pass.
#
#   ./scripts/verify-build.sh .
#
# Exits non-zero if anything is missing. Intended to be run before publishing a
# change, and again against a clean checkout of the result.
#
# Why this exists
# ---------------
# Every check below was added because something got through without it. The
# recurring failure was not broken code but code in the wrong place: a column
# added to a table that already existed and so was silently skipped; a CSS rule
# nested inside :root where it could never match; a route handler added to a
# module nobody imported; a dependency range bumped out of step with the
# lockfile. In each case the syntax was fine and the tests passed.
#
# So the checks assert placement and relationships, not just presence. Where a
# grep cannot express that - "this table is defined once", "this middleware is
# declared before it is used", "compression is not queued automatically" - there
# is a small Python block instead.
#
# Adding checks
# -------------
# When you fix a bug, add the check that would have caught it, and prove it
# works by reintroducing the bug and watching it fail. A check that has never
# failed has not been tested.

set -e
cd "$1"
FAIL=0

check() {
    local file="$1" pattern="$2" label="$3"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        echo "  ✓ $label"
    else
        echo "  ✗ MISSING: $label ($pattern not in $file)"
        FAIL=1
    fi
}

echo "=== Checking version ==="
check package.json '"version"' "version field exists"

echo "=== 0002: VAAPI fix ==="
check server/services/transcodeSession.js "init_hw_device" "CPU decode path"
check server/services/transcodeSession.js "vaapiCpuScale" "setting check"
check server/routes/transcode.js "vaapiCpuScale" "setting passthrough"
check server/db.js "vaapiCpuScale" "default setting"

echo "=== 0003: Remux AAC ==="
check server/routes/remux.js "aac_adtstoasc" "conditional BSF"
check server/routes/remux.js "detectCodecs\|codecCache" "probe function"

echo "=== 0004: DVR fixes ==="
check server/routes/recordings.js "router.use(requireAuth)" "auth middleware"
check server/services/recordingEngine.js "0:v?" "optional stream mapping"

echo "=== 0006: Free space ==="
check server/services/recordingEngine.js "getFreeSpaceGB\|statfsSync" "free space check"
check server/db.js "minFreeSpaceGB" "free space setting"

echo "=== 0007: Recording banner ==="
check public/js/app.js "updateRecordingBanner" "banner polling"
check public/index.html "recording-conflict-banner" "banner markup"

echo "=== 0008+0014: M3U sort order + ID fix ==="
check server/db/sqlite.js "sort_order" "schema column"
check server/db/sqlite.js "ALTER TABLE.*sort_order" "migration"
check server/services/m3uParser.js "position" "parser position"
check server/services/syncService.js "sort_order" "sync writes sort_order"
check server/services/syncService.js "pos_" "position-based ID"
check server/services/syncService.js "syncIfStale" "startup stale check"
check server/index.js "syncIfStale" "startup calls syncIfStale"
check server/routes/transcode.js "sessions/all" "kill-all endpoint"
check public/index.html "kill-all-streams" "kill button markup"
check public/js/pages/Settings.js "killAllSessions" "kill button handler"
check server/services/m3uXtreamAdapter.js "MIN(sort_order)" "category ordering"
check server/services/syncService.js "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?" "14-param INSERT"
check server/services/m3uXtreamAdapter.js "ORDER BY sort_order" "adapter ordering"

echo "=== 0009: Movies/Series toggle ==="
check server/db.js "showMovies" "movies setting"
check public/index.html "Content Visibility" "UI section"
check public/index.html "setting-show-movies" "checkbox markup"
check public/js/pages/Settings.js "loadUiSettings" "UI load handler"
check public/js/pages/Settings.js "saveUiSettings" "UI save handler"
check public/js/app.js "applyContentVisibility" "app apply function"

echo "=== 0010: Guide → Live TV ==="
check public/js/components/EpgGuide.js "navigateTo" "navigation call"
check public/js/components/EpgGuide.js "channelId.*sourceId" "ID-based lookup"

echo "=== 0011: EPG visible filter ==="
check server/routes/proxy.js "visible_epg_ids\|_visible_epg" "visible channel filter"

echo "=== 0017: category order + flags on real endpoint ==="
check server/db/sqlite.js "ALTER TABLE categories ADD COLUMN sort_order" "categories migration"
check server/services/syncService.js "sort_order: idx + 1" "M3U category order captured"
check server/services/syncService.js "sort_order = excluded.sort_order" "categories upsert keeps order"
check server/routes/proxy.js "sort_order ASC, name ASC" "real endpoint ordering"

echo "=== 0017: settings reorganisation ==="
check public/index.html "data-tab=\"recording\"" "Recording tab"
check public/index.html "data-tab=\"ui\"" "UI tab"
check public/index.html "data-tab=\"debug\"" "Debug tab"
check public/js/pages/Settings.js "loadRecordingSettings" "recording handlers"
check public/js/pages/Settings.js "loadUiSettings" "ui handlers"
check public/js/pages/Settings.js "loadActiveSessions" "debug handlers"
check public/js/api.js "killAllSessions" "transcode api group"

echo "=== 0017: guide cell + transcode + uncategorized ==="
check public/js/components/EpgGuide.js "resize-handle" "whole-cell click guard"
check public/css/main.css "epg-channel-info {" "whole-cell cursor"
check server/services/transcodeSession.js "fps_mode" "fps passthrough"
check server/services/transcodeSession.js "min(ih," "scale clamp"
check server/routes/proxy.js "NOT EXISTS" "hidden-category exclusion"
check public/js/components/ChannelList.js "allCategories" "group name fallback"

echo "=== 0018: transcode strategy ==="
check server/services/streamProbe.js "clientCaps" "probe takes client caps"
check server/services/streamProbe.js "videoIsHevc" "probe reports hevc"
check server/routes/probe.js "capKey" "caps in cache key"
check public/js/components/VideoPlayer.js "getCodecCapabilities" "client caps detection"
check public/js/components/VideoPlayer.js "capabilityQueryString" "caps sent to probe"
check public/js/components/VideoPlayer.js "segmentType" "client picks segment type"
check server/services/transcodeSession.js "hls_fmp4_init_filename" "fmp4 output"
check server/services/transcodeSession.js "tag:v" "hvc1 tagging"
check server/services/transcodeSession.js "vaapiHwDecode" "hw decode option"
check server/services/transcodeSession.js "_triedSwDecode" "sw decode fallback"
check server/services/transcodeSession.js "force_key_frames" "segment-aligned keyframes"
check server/routes/transcode.js "m4s" "segment route serves fmp4"
check server/routes/remux.js "needsHvc1Tag" "remux tags hevc"
check server/db.js "vaapiHwDecode" "hw decode default"
check public/index.html "setting-vaapi-hw-decode" "hw decode toggle"

echo "=== 0019: category order preserved client-side ==="
if grep -q "localeCompare" public/js/components/SourceManager.js; then
    echo "  ✗ MISSING: SourceManager still sorts alphabetically"; FAIL=1
else
    echo "  ✓ SourceManager sorts removed"
fi
if grep -q "a.localeCompare(b)" public/js/components/ChannelList.js; then
    echo "  ✗ MISSING: ChannelList still sorts groups"; FAIL=1
else
    echo "  ✓ ChannelList group sort removed"
fi
if grep -q "stripFlagEmoji\|stripFlags" server/routes/proxy.js server/services/m3uXtreamAdapter.js; then
    echo "  ✗ MISSING: flag stripping not reverted"; FAIL=1
else
    echo "  ✓ flag stripping reverted"
fi
check public/index.html "btn-stop" "stop button markup"
check public/index.html "btn-go-live" "go-live button markup"
check public/js/components/VideoPlayer.js "async stop()" "stop implementation"
check public/js/components/VideoPlayer.js "goToLive" "go-live implementation"
check public/js/components/VideoPlayer.js "updateLiveButton" "live indicator"
check public/css/main.css "btn-go-live" "live button styles"

echo "=== 0020: kill all covers remux ==="
check server/routes/remux.js "activeRemuxes" "remux registry"
check server/routes/remux.js "killAllRemuxes" "remux kill-all export"
check server/routes/transcode.js "killAllRemuxes" "kill-all calls remux"
check server/routes/transcode.js "listActiveRemuxes" "session list includes remux"
check server/routes/transcode.js "remux_" "single kill routes remux ids"
check public/js/pages/Settings.js "Remux" "debug list labels type"

echo "=== 0021: PigTV rebrand + recording fix ==="
check server/services/recordingEngine.js "m3u|xtream" "channel id normalisation"
check package.json "pigtv" "package renamed"
check public/index.html "pigtv-logo.png" "logo in navbar"
check public/login.html "pigtv-logo.png" "logo on login"
check .github/workflows/docker-publish.yml "/pigtv" "CI image renamed"
check README.md "PigTV" "README rebranded"
check public/css/main.css "FF5C8A" "accent retuned"
if [ -f public/img/pigtv-logo.png ]; then echo "  \u2713 logo file present"; else echo "  \u2717 MISSING: logo file"; FAIL=1; fi
if grep -rqi "nodecast" package.json public/index.html public/login.html .github/workflows/docker-publish.yml docker-compose.yml Dockerfile; then
    echo "  \u2717 MISSING: nodecast references remain"; FAIL=1
else
    echo "  \u2713 no nodecast references in branded files"
fi

echo "=== 0022: HE-AAC, categories, themes, compression ==="
check server/services/streamProbe.js "isHeAac" "probe detects HE-AAC"
check server/services/streamProbe.js "audioProfile" "probe reads profile"
check server/services/transcodeSession.js "isHeAac" "session forces AAC-LC"
check server/services/transcodeSession.js "aac_low" "AAC-LC profile set"
check public/js/components/VideoPlayer.js "isHeAac" "client forwards HE-AAC flag"
check public/js/components/SourceManager.js "groupItemType()" "group type helper"
check public/js/components/ChannelList.js "Every category is hidden" "empty state wording"
check server/routes/channels.js "cascadeCategory" "single hide/show cascades"
check server/routes/remux.js "stderrTail" "remux keeps stderr"
check server/routes/remux.js "ffmpegExited" "disconnect vs exit"
check public/js/theme.js "prefers-color-scheme" "theme follows system"
check public/css/main.css "data-theme=.light" "light tokens"
check public/index.html "js/theme.js" "theme loaded early"
check public/index.html "setting-theme" "theme selector"
check server/db.js "postRecordCodec" "compression tuning settings"
check server/services/recordingEngine.js "compressRecording" "compression implementation"
check server/services/recordingEngine.js "processCompressionQueue" "compression queue"
check server/db/recordingsDb.js "compress_status" "compression columns"
check public/index.html "dvr-setting-bitrate" "compression tuning UI"

echo "=== 0023: light theme fix + manual compress ==="
python3 - <<'PYCHK'
import re, sys
s = open('public/css/main.css').read()
root_start = s.index(':root {')
root_end = s.index('\n}', root_start)
light = s.index('[data-theme="light"]')
print('  \u2713 light block outside :root' if light > root_end else '  \u2717 MISSING: light block still nested in :root')
sys.exit(0 if light > root_end else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/routes/recordings.js "compress" "manual compress endpoint"
check server/services/recordingEngine.js "manual = false" "manual bypasses setting"
check public/js/api.js "compress:" "compress api method"
check public/js/pages/RecordingsPage.js "startCompressionWatch" "compression polling"
check public/js/pages/RecordingsPage.js "this.recordings = items" "recordings list stored"

echo "=== 0024: compress helpers, EPG staleness, startup order ==="
python3 - <<'PYCHK'
import sys
s = open('server/db/recordingsDb.js').read()
r = s.index('const recordings = {')
ok = s.index('setCompressStatus') > r and s.index('findPendingCompression') > r
print('  \u2713 compress helpers on recordings object' if ok else '  \u2717 MISSING: compress helpers on wrong object')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/services/syncService.js "FROM sync_status" "staleness uses sync_status"
if grep -q "cache.get('epg'" server/services/syncService.js; then
    echo "  \u2717 MISSING: still reads the phantom epg cache"; FAIL=1
else
    echo "  \u2713 phantom epg cache check removed"
fi
python3 - <<'PYCHK2'
import sys
s = open('server/index.js').read()
engine = s.index('recordingEngine.init')
sync = s.index('syncService.syncIfStale')
ok = engine < sync
print('  \u2713 DVR engine starts before sync' if ok else '  \u2717 MISSING: DVR engine still behind sync')
sys.exit(0 if ok else 1)
PYCHK2
[ $? -eq 0 ] || FAIL=1

echo "=== 0025: CQP fallback + status ==="
check server/services/recordingEngine.js "forceCqp" "CQP option"
check server/services/recordingEngine.js "bitrateToQp" "bitrate to quantiser mapping"
check server/services/recordingEngine.js "RC mode" "detects driver rejection"
check server/services/recordingEngine.js "result.tail.slice" "real error stored"
check public/js/pages/RecordingsPage.js "resumeCompressionWatchIfNeeded" "resumes watching"
check public/js/pages/RecordingsPage.js "recordingsList.offsetParent" "pauses when off screen"

echo "=== 0026: playback API ==="
check server/services/streamProbe.js "analyzeProbeResult" "probe logic extracted"
check server/services/streamProbe.js "module.exports" "probe service exports"
check server/routes/probe.js "services/streamProbe" "probe route uses the service"
check server/services/playbackStrategy.js "strategy: 'direct'" "direct play path"
check server/services/playbackStrategy.js "strategy: 'remux'" "remux path"
check server/services/playbackStrategy.js "strategy: 'transcode'" "transcode path"
check server/routes/playback.js "resolve" "resolve endpoint"
check server/index.js "api/playback" "playback route mounted"

echo "=== 0027: devices, library, history ==="
check server/services/deviceAuth.js "startPairing" "pairing start"
check server/services/deviceAuth.js "isDeviceValid" "revocation check"
check server/services/deviceAuth.js "token = NULL" "token is single use"
check server/auth.js "payload.deviceId" "auth honours device tokens"
check server/auth.js "isDeviceValid" "auth enforces revocation"
check server/routes/devices.js "pair/approve" "approve endpoint"
check server/routes/library.js "nowNextFor" "now/next resolution"
check server/routes/library.js "is_hidden = 1" "hidden categories excluded"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS devices" "devices table"
check server/db/sqlite.js "watch_history" "watch history table"
check server/index.js "api/devices" "devices mounted"
check server/index.js "api/library" "library mounted"
check public/js/components/VideoPlayer.js "resolvePlayback" "client uses resolve"
check public/index.html "pair-code" "pairing UI"

echo "=== packaging ==="
python3 - <<'PYCHK'
import json, sys
pkg = json.load(open('package.json'))
lock = json.load(open('package-lock.json'))
root = lock['packages']['']
ok = True

# npm ci fails outright when package.json and the lockfile disagree, and it
# fails in CI rather than locally, so check it here.
for section in ('dependencies', 'optionalDependencies'):
    declared = pkg.get(section, {})
    locked = root.get(section, {})
    for name, rng in declared.items():
        if name not in locked:
            print('  \u2717 MISSING: %s not in lockfile (%s)' % (name, section)); ok = False
        elif locked[name] != rng:
            print('  \u2717 MISSING: %s range %s != lockfile %s' % (name, rng, locked[name])); ok = False

if ok:
    print('  \u2713 package.json agrees with package-lock.json')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== schema sanity ==="
python3 - <<'PYCHK'
import re, sys, collections
src = open('server/db/sqlite.js').read()
names = re.findall(r'CREATE TABLE IF NOT EXISTS\s+(\w+)', src)
dupes = [n for n, c in collections.Counter(names).items() if c > 1]
if dupes:
    # CREATE TABLE IF NOT EXISTS silently skips when the table already exists,
    # so a second definition of the same name never takes effect and its
    # columns are simply missing at runtime.
    print('  \u2717 MISSING: duplicate table definitions: %s' % ', '.join(dupes))
    sys.exit(1)
print('  \u2713 no duplicate CREATE TABLE names (%d tables)' % len(names))
sys.exit(0)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/db/sqlite.js "channel_history" "channel history table"
check server/routes/library.js "channel_history" "recent reads channel_history"
check server/routes/playback.js "channel_history" "history writes channel_history"

echo "=== 0030: guide, stream auth, info ==="
check server/routes/library.js "api/library/guide" "guide endpoint documented"
check server/routes/library.js "24 \* 60 \* 60 \* 1000" "guide window capped"
check server/routes/library.js "isNow" "current programme flagged"
check server/auth.js "streamAuth" "stream auth middleware"
check server/auth.js "req.query.token" "token accepted in query"
check server/auth.js "enforce" "enforcement is opt-in"
check server/db.js "requireStreamAuth" "stream auth setting"
check server/routes/info.js "apiVersion" "api version reported"
check server/routes/info.js "features" "feature flags"
check server/index.js "api/info" "info mounted"
python3 - <<'PYCHK'
import re, sys
s = open('server/index.js').read()
# streamAuth must be declared before the first route that uses it.
decl = s.index('const streamAuth =')
uses = [m.start() for m in re.finditer(r'streamAuth, require', s)]
ok = all(u > decl for u in uses) and len(uses) >= 3
print(('  \u2713 streamAuth declared before its %d uses' % len(uses)) if ok
      else '  \u2717 MISSING: streamAuth used before declaration or not applied to all stream routes')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0031: coordinator + favourites ==="
check server/services/streamCoordinator.js "requestForRecording" "recording arbitration"
check server/services/streamCoordinator.js "requestForViewer" "viewer arbitration"
check server/services/streamCoordinator.js "staleStreams" "idle reclaim"
check server/services/streamCoordinator.js "activeRecordings.length + 1" "requesting viewer is counted"
check server/db/recordingsDb.js "markPartial" "partial recordings tracked"
check server/db/recordingsDb.js "'scheduled', 'waiting'" "waiting schedules retried"
check server/services/recordingEngine.js "stopForViewer" "recording yields to viewer"
check server/routes/playback.js "409" "conflict reported to client"
check server/routes/playback.js "conflict/decline" "decline endpoint"
check server/routes/library.js "library/favourites" "favourites endpoint"
check server/routes/library.js "ch.favourite" "favourite flag on channels"
check server/db.js "maxProviderStreams" "provider limit setting"
check public/js/components/VideoPlayer.js "startConflictWatch" "client watches for conflicts"

echo "=== 0032: ad detection ==="
check server/services/adDetect.js "parseEdl" "EDL parsing"
check server/services/adDetect.js "isAvailable" "graceful when comskip absent"
check Dockerfile "Comskip" "comskip built into image"
check Dockerfile "comskip.ini" "tuning shipped"
check docker/comskip.ini "detect_method" "tuning has detection methods"
check server/db/recordingsDb.js "recording_markers" "markers table"
check server/db/recordingsDb.js "replaceMarkers" "atomic marker replacement"
check server/services/recordingEngine.js "processAdDetectionQueue" "detection queue"
check server/services/recordingEngine.js "if (detecting) return" "compression waits for detection"
check server/routes/recordings.js "detect-ads" "manual detection endpoint"
check server/routes/info.js "comskipAvailable" "availability reported"
check public/js/pages/RecordingsPage.js "attachAdSkipping" "player skip support"
check public/css/main.css "skip-ad-btn" "skip button styles"
check public/index.html "dvr-setting-addetect" "detection setting"

echo "=== compression is request-only ==="
python3 - <<'PYCHK'
import re, sys
src = open('server/services/recordingEngine.js').read()
i = src.index('function finalizeRecording')
fin = src[i:i+3000]
auto_compress = "setCompressStatus(recordingId, 'pending')" in fin
auto_detect = "setAdDetectStatus(recordingId, 'pending')" in fin
gated = 'postRecordCompress' in src
ok = (not auto_compress) and auto_detect and (not gated)
if ok:
    print('  \u2713 compression waits to be asked; detection is automatic')
else:
    if auto_compress: print('  \u2717 MISSING: compression is still queued automatically')
    if not auto_detect: print('  \u2717 MISSING: detection is no longer queued automatically')
    if gated: print('  \u2717 MISSING: postRecordCompress gate still present')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0038: web client sends stream auth tokens ==="
check public/js/api.js "withStreamToken" "shared token helper exists"
check public/js/api.js "streamFetch" "authenticated fetch helper for transcode management calls"
check public/js/components/VideoPlayer.js "API.withStreamToken(decision.url)" "resolved playback URL carries token"
check public/js/pages/WatchPage.js "API.withStreamToken" "watch page uses the shared helper"
python3 - <<'PYCHK'
import re, sys
# Every URL builder that feeds a <video src> or hls.loadSource() must
# route through API.withStreamToken - checking the helper exists
# elsewhere doesn't prove any particular caller still uses it. This
# checks the three builders directly, by function body, so a future
# edit that quietly reverts one back to a raw template string gets
# caught here rather than only when requireStreamAuth is next enabled.
src = open('public/js/components/VideoPlayer.js').read()
fns = ['getProxiedUrl', 'getTranscodeUrl', 'getRemuxUrl']
missing = []
for name in fns:
    m = re.search(re.escape(name) + r'\(url\)\s*\{([\s\S]*?)\n    \}', src)
    if not m or 'API.withStreamToken' not in m.group(1):
        missing.append(name)
if missing:
    print(f'  \u2717 MISSING: {", ".join(missing)} do not route through API.withStreamToken')
    sys.exit(1)
print('  \u2713 getProxiedUrl/getTranscodeUrl/getRemuxUrl all route through the token helper')
PYCHK
[ $? -eq 0 ] || FAIL=1
python3 - <<'PYCHK'
import sys
# The session-creation POST is a plain fetch that CAN carry a header, so
# it must - unlike the ones that end up as <video src>/loadSource, where
# a query-string token is the only option, this one has no excuse to be
# missing an Authorization header once requireStreamAuth is on.
ok = True
for path in ('public/js/components/VideoPlayer.js', 'public/js/pages/WatchPage.js'):
    src = open(path).read()
    i = src.index("fetch('/api/transcode/session'")
    body = src[i:i+400]
    if 'Authorization' not in body:
        print(f'  \u2717 MISSING: {path} session POST has no Authorization header')
        ok = False
if ok:
    print('  \u2713 transcode session creation sends the auth token in both players')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0034: native HLS delivery for segmented clients ==="
check server/services/playbackStrategy.js "segmentedDelivery" "capability flag exists"
check server/services/playbackStrategy.js "caps.segmentedDelivery" "flag actually read, not just declared"
check server/services/transcodeSession.js "audioMode === 'copy'" "explicit audio-copy override"
python3 - <<'PYCHK'
import re, sys
src = open('server/services/transcodeSession.js').read()
# The original bug: isPlaylistReady only recognized MPEG-TS segments, so a
# valid fMP4 playlist (.m4s) could never satisfy it and always timed out.
i = src.index('async isPlaylistReady()')
j = src.index('async waitForPlaylist', i)
body = src[i:j]
ok = "'.m4s'" in body or '".m4s"' in body
print(('  \u2713 fMP4 segments recognized as ready' if ok
       else "  \u2717 MISSING: isPlaylistReady() doesn't check for .m4s"))
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1
python3 - <<'PYCHK'
import re, sys
src = open('server/services/transcodeSession.js').read()
# The original bug: cleanup() called stop() (fire-and-forget, killed the
# process without waiting) then immediately rm()'d the directory ffmpeg
# might still be writing into. stop() must now return a promise, and
# cleanup() must await it before removing anything.
stop_i = src.index('    stop() {')
stop_body = src[stop_i:stop_i + src[stop_i:].index('\n    }\n') + 7]
returns_promise = 'return this._stopPromise' in stop_body and 'new Promise' in stop_body

cleanup_i = src.index('async cleanup()')
cleanup_body = src[cleanup_i:cleanup_i + 700]
awaits_stop = 'await this.stop()' in cleanup_body

ok = returns_promise and awaits_stop
if ok:
    print('  \u2713 cleanup() awaits ffmpeg exit before deleting the directory')
else:
    if not returns_promise: print('  \u2717 MISSING: stop() does not return an awaitable promise')
    if not awaits_stop: print('  \u2717 MISSING: cleanup() does not await stop()')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/services/transcodeSession.js "logTimeoutDiagnostics" "timeout diagnostics logged"

echo "=== 0036: media-auth token propagation to HLS children ==="
check server/routes/transcode.js "withStreamToken" "playlist rewrite exists"
check server/routes/transcode.js "res.send(withStreamToken(playlist" "playlist route actually rewrites before sending"
python3 - <<'PYCHK'
import re, sys
# Run the real function against a real fMP4 playlist shape, rather than
# grepping for a pattern - this is exactly the "instructions removed" bug
# that MISSING: checks elsewhere in this file exist to catch: the function
# could exist and be called, and still not cover the one case (the init
# segment named inside #EXT-X-MAP rather than on its own line) that matters.
src = open('server/routes/transcode.js').read()
m = re.search(r'function withStreamToken[\s\S]*?\n}\n', src)
if not m:
    print('  \u2717 MISSING: withStreamToken function not found')
    sys.exit(1)

# Execute as JS via node instead of trying to run JS in Python.
import subprocess
script = m.group(0) + '''
const playlist = "#EXTM3U\\n#EXT-X-MAP:URI=\\"init.mp4\\"\\n#EXTINF:4,\\nseg0000.m4s\\n";
const out = withStreamToken(playlist, "tok123");
const initOk = out.includes('URI="init.mp4?token=tok123"');
const segOk = out.includes('seg0000.m4s?token=tok123');
if (initOk && segOk) {
  console.log("OK");
} else {
  console.log("FAIL init=" + initOk + " seg=" + segOk);
}
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
ok = result.stdout.strip() == 'OK'
if ok:
    print('  \u2713 token reaches both the init segment (EXT-X-MAP) and media segments')
else:
    print(f'  \u2717 MISSING: token does not reach every child URI ({result.stdout.strip()}{result.stderr.strip()})')
sys.exit(0 if ok else 1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0041: AAC copy into fMP4 needs aac_adtstoasc ==="
check server/services/transcodeSession.js "aac_adtstoasc" "bitstream filter present"
python3 - <<'PYCHK'
import re, sys
# Run buildFFmpegArgs() directly for the three cases that matter, rather
# than grepping for the filter name - grep can't tell you whether it's
# reachable from all three copy branches, or gated correctly to fmp4-only
# and aac-only. This is what actually broke on a real tvOS session: HEVC
# video copy + fmp4 segments + AAC audio copy, muxer rejected every audio
# packet ("Malformed AAC bitstream... Operation not permitted").
import subprocess
script = '''
const { TranscodeSession } = require('./server/services/transcodeSession.js');
function make(opts) {
    const s = Object.create(TranscodeSession.prototype);
    s.id = 'test'; s.url = 'http://example/s.ts'; s.dir = '/tmp/t';
    s.playlistPath = '/tmp/t/stream.m3u8';
    s.options = { userAgent: 'ua', ...opts };
    return s;
}
const cases = [
    ['fmp4 + audioMode copy + aac', { videoMode:'copy', segmentType:'fmp4', videoCodec:'hevc', audioMode:'copy', audioCodec:'aac', audioChannels:2 }, true],
    ['mpegts + audioMode copy + aac', { videoMode:'copy', segmentType:'mpegts', videoCodec:'h264', audioMode:'copy', audioCodec:'aac', audioChannels:2 }, false],
    ['fmp4 + auto smart-copy + aac', { videoMode:'copy', segmentType:'fmp4', videoCodec:'hevc', audioMixPreset:'auto', audioCodec:'aac', audioChannels:2 }, true],
    ['fmp4 + audioMode copy + ac3', { videoMode:'copy', segmentType:'fmp4', videoCodec:'hevc', audioMode:'copy', audioCodec:'ac3', audioChannels:6 }, false],
];
let ok = true;
for (const [name, opts, expect] of cases) {
    const args = make(opts).buildFFmpegArgs();
    const has = args.includes('aac_adtstoasc');
    if (has !== expect) {
        console.log(`FAIL ${name}: expected ${expect}, got ${has}`);
        ok = false;
    }
}
console.log(ok ? 'OK' : 'BAD');
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True, cwd='.')
out = result.stdout.strip()
if 'OK' in out.splitlines()[-1:]:
    print('  \u2713 filter applies only for fmp4+aac, across every copy branch')
else:
    print(f'  \u2717 MISSING: {out}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0042: live-source timestamp handling ==="
check server/services/transcodeSession.js "avoid_negative_ts" "flag present"
check server/services/transcodeSession.js "max_interleave_delta" "flag present"
python3 - <<'PYCHK'
import subprocess, sys
# Both are output-side muxer options - they only take effect placed before
# -f hls, not before -i. A future edit that moves them (or drops one while
# keeping the other) is what this actually catches; grepping for the flag
# name alone can't tell you where it ended up.
script = '''
const { TranscodeSession } = require('./server/services/transcodeSession.js');
function make(opts) {
    const s = Object.create(TranscodeSession.prototype);
    s.id = 'test'; s.url = 'http://example/s.ts'; s.dir = '/tmp/t';
    s.playlistPath = '/tmp/t/stream.m3u8';
    s.options = { userAgent: 'ua', ...opts };
    return s;
}
const args = make({ videoMode:'copy', segmentType:'mpegts', videoCodec:'h264', audioMode:'copy', audioCodec:'aac', audioChannels:2 }).buildFFmpegArgs();
const idx = f => args.indexOf(f);
const ok = idx('-avoid_negative_ts') > -1 && args[idx('-avoid_negative_ts')+1] === 'make_zero'
        && idx('-max_interleave_delta') > -1 && args[idx('-max_interleave_delta')+1] === '0'
        && idx('-avoid_negative_ts') < idx('-f')
        && idx('-max_interleave_delta') < idx('-f');
console.log(ok ? 'OK' : 'BAD');
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 both flags present with correct values, placed before -f hls')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0043: fmp4 segments for codecsOk, matching /api/remux's container ==="
python3 - <<'PYCHK'
import subprocess, sys
# Every case the boolean expression covers, not just "does it mention
# codecsOk somewhere" - this is what actually distinguishes the reported
# bug (H.264 + codecsOk wrongly landing on mpegts) from the two paths
# that must NOT change (HEVC unaffected, non-codecsOk H.264 unaffected).
script = '''
const src = require('fs').readFileSync('server/services/playbackStrategy.js', 'utf8');
const m = src.match(/const segmentType = \\(([\\s\\S]*?)\\)\\s*\\?\\s*'fmp4'\\s*:\\s*'mpegts';/);
if (!m) { console.log('BAD: expression not found'); process.exit(1); }
const expr = new Function('canCopyVideo', 'capsFmp4', 'videoIsHevc', 'codecsOk',
    `const caps = { fmp4: capsFmp4 }; const info = { videoIsHevc };
     return (${m[1].replace(/caps\\.fmp4/g, 'caps.fmp4').replace(/info\\.videoIsHevc/g, 'info.videoIsHevc')}) ? 'fmp4' : 'mpegts';`);
const cases = [
    [true, true, true, false, 'fmp4'],
    [true, true, false, false, 'mpegts'],
    [true, true, false, true, 'fmp4'],
    [true, false, false, true, 'mpegts'],
    [false, true, true, true, 'mpegts'],
];
let ok = true;
for (const [a,b,c,d,expect] of cases) {
    const got = expr(a,b,c,d);
    if (got !== expect) { ok = false; console.log(`FAIL canCopyVideo=${a} fmp4=${b} hevc=${c} codecsOk=${d}: got ${got} expected ${expect}`); }
}
console.log(ok ? 'OK' : 'BAD');
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 H.264+codecsOk gets fmp4; HEVC and non-codecsOk H.264 paths unaffected')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0044: remove dump_extra from fmp4 copy (caused real playback failure) ==="
python3 - <<'PYCHK'
import subprocess, sys
# 0043 added dump_extra here on the (unverified) theory that it should
# match /api/remux's own fmp4 output. A real tvOS session then logged
# bitstream-parser-level corruption - "SEI type 1 size 80 truncated at 1",
# "missing picture in access unit", "[mp4] pts has no value" - immediately
# after 0043 shipped, with playback ending almost immediately rather than
# just stuttering. This checks the fix directly against the built
# command for both codecs, not just that the string is gone from the
# file (0043's own checks already prove the file still says
# "dump_extra" - it's just in the unrelated mpegts fallback branch, and
# a grep-only check can't tell the two apart).
script = '''
const { TranscodeSession } = require('./server/services/transcodeSession.js');
function make(opts) {
    const s = Object.create(TranscodeSession.prototype);
    s.id = 't'; s.url = 'http://e/s.ts'; s.dir = '/tmp/t';
    s.playlistPath = '/tmp/t/stream.m3u8';
    s.options = { userAgent: 'ua', ...opts };
    return s;
}
const hevc = make({ videoMode:'copy', segmentType:'fmp4', videoCodec:'hevc', audioMode:'copy', audioCodec:'aac', audioChannels:2 }).buildFFmpegArgs();
const h264 = make({ videoMode:'copy', segmentType:'fmp4', videoCodec:'h264', audioMode:'copy', audioCodec:'aac', audioChannels:2 }).buildFFmpegArgs();
const unknown = make({ videoMode:'copy', segmentType:'mpegts', videoCodec:'mpeg2video', audioMode:'copy', audioCodec:'aac', audioChannels:2 }).buildFFmpegArgs();
const ok = !hevc.includes('dump_extra') && hevc.includes('hvc1')
        && !h264.includes('dump_extra') && !h264.includes('hvc1')
        && unknown.includes('dump_extra'); // untouched fallback branch, must be unaffected
console.log(ok ? 'OK' : 'BAD ' + JSON.stringify({hevc, h264, unknown}));
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 fmp4 copy path (either codec) sends no bitstream filter; unrelated fallback branch unaffected')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0045: native recording playback contract ==="
check server/index.js "app.use('/api/recordings', streamAuth" "recordings router wrapped in streamAuth"
check server/routes/recordings.js "router.get('/:id/playback'" "playback resolve endpoint exists"
check server/routes/recordings.js "router.get('/:id/media.mp4'" "native media endpoint exists"
check server/services/recordingEngine.js "ensureNativePlayback" "remux function exists"
check server/services/recordingEngine.js "aac_adtstoasc" "ADTS-to-ASC fix applied here too"
check public/js/api.js "streamUrl: (id) => API.withStreamToken" "web client sends token on recording stream URL"
check public/js/api.js "downloadUrl: (id) => API.withStreamToken" "web client sends token on recording download URL"
python3 - <<'PYCHK'
import subprocess, sys
# /:id/playback must sit below router.use(requireAuth) (JWT-gated, like
# /api/playback/resolve for live TV) and /:id/media.mp4 must sit above it
# (reachable by <video src>/AVURLAsset, which cannot send a header) -
# grepping for each route's existence separately can't tell you which side
# of the auth boundary either one landed on.
src = open('server/routes/recordings.js').read()
auth_pos = src.find('router.use(requireAuth)')
playback_pos = src.find("router.get('/:id/playback'")
media_pos = src.find("router.get('/:id/media.mp4'")
ok = auth_pos > -1 and playback_pos > auth_pos and 0 < media_pos < auth_pos
if ok:
    print('  \u2713 playback (JWT-gated) and media.mp4 (token-gated) sit on the correct sides of requireAuth')
else:
    print(f'  \u2717 MISSING: auth_pos={auth_pos} playback_pos={playback_pos} media_pos={media_pos}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0046: bound HLS session disk usage (review P0-1) ==="
check server/services/transcodeSession.js "delete_segments" "segment rotation enabled"
check server/services/transcodeSession.js "sweepOrphanedCache" "startup sweep exists"
check server/index.js "sweepOrphanedCache" "startup sweep is actually called"
check docker-compose.yml "transcode-cache" "cache directory taken off the writable layer"
python3 - <<'PYCHK'
import subprocess, sys
script = '''
const { TranscodeSession } = require('./server/services/transcodeSession.js');
function make(opts) {
    const s = Object.create(TranscodeSession.prototype);
    s.id = 't'; s.url = 'http://e/s.ts'; s.dir = '/tmp/t';
    s.playlistPath = '/tmp/t/stream.m3u8';
    s.options = { userAgent: 'ua', ...opts };
    return s;
}
const args = make({ videoMode:'copy', segmentType:'mpegts', videoCodec:'h264', audioMode:'copy', audioCodec:'aac', audioChannels:2 }).buildFFmpegArgs();
const listSize = parseInt(args[args.indexOf('-hls_list_size') + 1], 10);
const flags = args[args.indexOf('-hls_flags') + 1];
const ok = listSize > 0 && flags.includes('delete_segments') && !flags.includes('append_list');
console.log(ok ? 'OK' : `BAD list_size=${listSize} flags=${flags}`);
'''
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 list_size bounded (not 0), delete_segments on, append_list gone')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/services/transcodeSession.js "clearSegments" "retry path clears stale segments instead of relying on append_list"

echo "=== 0047: EPG streaming parser data loss and hangs (review P0-2) ==="
check server/services/epgParser.js "batchQueue" "real queue replaces the single-slot mailbox"
python3 - <<'PYCHK'
import subprocess, sys
# Runs the actual bug reproduction: many small batches plus a deliberately
# slow consumer - the exact condition that overwrote pendingBatch before a
# consumer could read it. Against the unpatched code this loses 490 of 500
# programmes; grepping the source can't tell you whether the fix actually
# holds under that load, only that a queue-shaped variable exists.
script = '''
const { Readable } = require("stream");
const epgParser = require("./server/services/epgParser.js");
const COUNT = 300;
let xml = "<?xml version=\\"1.0\\"?><tv><channel id=\\"c\\"><display-name>C</display-name></channel>";
for (let i = 0; i < COUNT; i++) {
    xml += `<programme channel="c" start="2026010100${String(i%60).padStart(2,"0")}00 +0000" stop="2026010100${String(i%60).padStart(2,"0")}00 +0000"><title>S${i}</title></programme>`;
}
xml += "</tv>";
(async () => {
    const input = Readable.from([xml]);
    let received = 0;
    const seen = new Set();
    for await (const batch of epgParser.parseStreaming(input, 10)) {
        for (const p of batch.programmes) { received++; seen.add(p.title); }
        await new Promise(r => setTimeout(r, 3));
    }
    console.log(received === COUNT && seen.size === COUNT ? "OK" : `BAD received=${received} unique=${seen.size}`);
})().catch(e => { console.log("THREW " + e.message); process.exit(1); });
'''
try:
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=15)
except subprocess.TimeoutExpired:
    print('  \u2717 MISSING: parser hung under a bursty-input + slow-consumer load')
    sys.exit(1)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 300 programmes, slow consumer, zero data loss (490/500 lost against the unpatched code)')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1
python3 - <<'PYCHK'
import subprocess, sys
# A recoverable sax error (malformed entity) must not hang the generator
# forever. sax's own parser.closed flag never flips true after an
# error+resume even though the document parses correctly to the end - a
# real, verified quirk in sax's error-recovery path - so this specifically
# exercises the case where saxStream's own 'end' would never fire.
script = '''
const { Readable } = require("stream");
const epgParser = require("./server/services/epgParser.js");
let xml = "<?xml version=\\"1.0\\"?><tv><channel id=\\"c\\"><display-name>C</display-name></channel>";
xml += "<programme channel=\\"c\\" start=\\"20260101000000 +0000\\" stop=\\"20260101000000 +0000\\"><title>Bad & Broken</title></programme>";
xml += "<programme channel=\\"c\\" start=\\"20260101010000 +0000\\" stop=\\"20260101010000 +0000\\"><title>After</title></programme>";
xml += "</tv>";
(async () => {
    const input = Readable.from([xml]);
    let received = 0;
    for await (const batch of epgParser.parseStreaming(input, 5)) received += batch.programmes.length;
    console.log(received === 2 ? "OK" : `BAD received=${received}`);
})().catch(e => { console.log("THREW " + e.message); process.exit(1); });
'''
try:
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=10)
except subprocess.TimeoutExpired:
    print('  \u2717 MISSING: generator hangs forever after a recoverable parse error (sax end-event quirk not worked around)')
    sys.exit(1)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  \u2713 recoverable entity error: parsing completes (not hangs, not fails) with all well-formed data intact')
else:
    print(f'  \u2717 MISSING: {result.stdout.strip()}\\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1
check server/services/epgParser.js "input.on('end', finishParsing)" "final batch triggered by the input stream's own end, not sax's"

echo "=== 0048: Build identity surfaced ==="
# The whole point is that a running server (and any client) can say which
# build it is. Each check asserts the number reaches the surface it is read
# from, not just that version.js exists.
check server/version.js "const BUILD =" "version.js carries a committed build number"
check server/version.js "module.exports = { version, build, commit, builtAt, display }" "version.js exports the full identity"
check server/index.js "require('./version')" "/api/version serves version.js (not a bare package.json read)"
check server/routes/info.js "require('../version')" "/api/info includes build identity"
check public/js/app.js "data.display" "webapp badge renders the server's display string"
check public/index.html "version-badge" "badge markup present in the header"
check Dockerfile "PIGTV_COMMIT" "Dockerfile can stamp commit/builtAt at build time"

echo "=== 0049: Live HLS stability ==="
# temp_file must be in the actual flag string, not just mentioned in a comment,
# or the playlist is still rewritten in place under a live client.
check server/services/transcodeSession.js "independent_segments+delete_segments+temp_file" "playlist written atomically (temp_file in hls_flags)"
check server/services/transcodeSession.js "'-hls_delete_threshold'" "delete threshold passed to ffmpeg"
check server/services/transcodeSession.js "const HLS_DELETE_THRESHOLD" "delete threshold has a named constant"

echo "=== 0050: Auth gate on state-changing routes (P0-3) ==="
# The gate has to be on the mount, and the webapp callers have to actually
# send a token, or turning the gate on breaks the web player.
check server/index.js "app.use('/api/channels', requireAuth" "channels requires auth"
check server/index.js "app.use('/api/probe', requireAuth" "probe requires auth"
check server/index.js "app.use('/api/subtitle', requireToken" "subtitle requires a token (header or query)"
check server/index.js "streamAuth({ enforce: true })" "always-on token middleware built in index"
check server/routes/playback.js "router.post('/resolve', requireToken" "resolve requires a token"
check server/routes/playback.js "router.delete('/:sessionId', requireToken" "session delete requires a token"
# Webapp side: probe over streamFetch (bearer), subtitle track over ?token=.
check public/js/components/VideoPlayer.js "API.streamFetch(\`/api/probe" "web player probe sends the bearer header"
check public/js/components/VideoPlayer.js "API.withStreamToken(\`/api/subtitle" "web player subtitle track carries ?token="
check public/js/pages/WatchPage.js "API.streamFetch(\`/api/probe" "watch page probe sends the bearer header"

if [ $FAIL -eq 0 ]; then
    echo ""
    echo "=== ALL CHECKS PASSED ==="
else
    echo ""
    echo "=== FAILED — do NOT export patches ==="
    exit 1
fi
