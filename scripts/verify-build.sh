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

# Assert a pattern is NOT present - for removals, where the bug is the line
# still being there.
check_absent() {
    local file="$1" pattern="$2" label="$3"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        echo "  ✗ STILL PRESENT: $label ($pattern found in $file)"
        FAIL=1
    else
        echo "  ✓ $label"
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
check server/services/syncService.js "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?" "14-param INSERT"

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
if grep -q "stripFlagEmoji\|stripFlags" server/routes/proxy.js; then
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

echo "=== 0051: Drop the dead ffmpeg-static require ==="
check_absent server/routes/proxy.js "require('ffmpeg-static')" "proxy.js no longer requires ffmpeg-static at load (would crash startup if the optional dep failed)"
# index.js keeps its own guarded fallback require - that one is inside try/catch.
check server/index.js "require('ffmpeg-static')" "index.js keeps its guarded ffmpeg-static fallback"

echo "=== 0052: Provider credential redaction (P1-4) ==="
check server/redact.js "function redact" "redact helper exists"
check server/routes/transcode.js "url: redact(x.url)" "/sessions response redacts upstream URLs"
check server/routes/playback.js "error: redact(err.message)" "resolve error body is redacted"
check server/services/streamProbe.js "redact(stderr)" "ffprobe stderr redacted before leaving probeStream"
check server/services/transcodeSession.js "redact(args.join" "session ffmpeg command line redacted in logs"
if node -e '
  const { redact } = require("./server/redact");
  const q = redact("http://p/get.php?username=u&password=pw&token=tk");
  const pth = redact("http://p:8080/live/u/pw/123.ts");
  process.exit((q.includes("pw")||q.includes("tk")||q.includes("username=u")||pth.includes("/u/pw/")) ? 1 : 0);
' 2>/dev/null; then
  echo "  ✓ redact strips both path-based and query-based provider credentials"
else
  echo "  ✗ MISSING: redact does not strip provider credentials"; FAIL=1
fi

echo "=== 0053: db.json cache + session leak (P1-7) ==="
check server/db.js "let cachedDb = null" "in-memory db cache declared"
check server/db.js "if (cachedDb) return structuredClone(cachedDb)" "loadDb serves from cache once seeded"
check server/db.js "cachedDb = snapshot;" "saveDb keeps the cache authoritative (write-through)"
check_absent server/index.js "express-session" "no session store at all (0077 removed it; the MemoryStore leak cannot come back)"

echo "=== 0054: ffmpeg output-inactivity watchdog ==="
check server/services/stallWatchdog.js "function createStallWatchdog" "shared watchdog exists"
check server/services/stallWatchdog.js "PIGTV_STALL_TIMEOUT_MS" "stall limit is tunable without a patch"
# Both delivery paths read the same live input with the same reconnect flags,
# so both need the watchdog, and it has to be started on the real process.
check server/routes/remux.js "createStallWatchdog(" "remux path runs the watchdog"
check server/services/transcodeSession.js "createStallWatchdog(" "HLS session path runs the watchdog"
check server/services/transcodeSession.js "this.startWatchdog()" "HLS watchdog started once ffmpeg is spawned"
check server/services/transcodeSession.js "this.stopWatchdog()" "HLS watchdog stopped when ffmpeg exits / session stops"
check server/routes/remux.js "watchdog.stop()" "remux watchdog stopped when ffmpeg exits"
# Silence with the client not reading (paused tab, full pipe) is the client's
# doing, not ffmpeg's. Without this guard a paused viewer gets killed.
check server/routes/remux.js "writableNeedDrain" "remux does not treat client backpressure as a stall"
# Remux idle accounting: idleMs must mean 'time since media last flowed', and
# the coordinator must use it instead of pretending every remux is busy.
check server/routes/remux.js "r.lastOutputAt ?? r.startedAt" "remux idleMs measured from last output"
check_absent server/routes/remux.js "idleMs: Date.now() - r.startedAt" "remux idleMs no longer grows for a healthy stream"
check_absent server/services/streamCoordinator.js "idleMs: 0," "coordinator no longer hard-codes remux idleMs to 0"
check test/stall-watchdog.test.js "createStallWatchdog" "watchdog has unit tests"
check test/remux-watchdog.test.js "goes silent" "remux stall has an end-to-end test"

echo "=== 0055: Viewer-vs-viewer arbitration + live idle timeout (A3) ==="
check server/services/streamCoordinator.js "function admitViewer" "admitViewer exists"
check server/services/streamCoordinator.js "function ownerKey" "stream owners are identified"
check server/services/streamCoordinator.js "type: 'viewer-in-progress'" "another viewer is reported as a conflict"
check server/services/streamCoordinator.js "    admitViewer," "admitViewer is exported (an edit that missed the export block once shipped a crash)"
# The old gate returned 'allowed' whenever no recording was active, which is
# exactly the hole: with no recording, viewer-vs-viewer was never considered.
check_absent server/services/streamCoordinator.js "if (activeRecordings.length === 0) return { allowed: true }" "viewer arbitration no longer skipped when no recording is active"
# A rewrite that appended instead of replacing left two definitions and two
# export blocks, and node still loaded it. Assert there is exactly one of each.
if [ "$(grep -c '^function requestForViewer' server/services/streamCoordinator.js)" = "1" ] && [ "$(grep -c '^module.exports' server/services/streamCoordinator.js)" = "1" ]; then
  echo "  ✓ coordinator has one requestForViewer and one export block"
else
  echo "  ✗ MISSING: coordinator has duplicated definitions or export blocks"; FAIL=1
fi
check server/routes/playback.js "coordinator.admitViewer(" "resolve arbitrates and releases before starting"
check server/routes/playback.js "coordinator.ownerKey(req.user)" "resolve knows who is asking"
check server/routes/playback.js "viewer-in-progress" "resolve tells the client how to proceed on a viewer conflict"
check server/services/playbackStrategy.js "        owner," "sessions created by resolve record their owner"
check server/routes/remux.js "soft: true" "direct remux reclaims free streams but never refuses"
check server/routes/transcode.js "soft: true" "session route reclaims free streams but never refuses"
check server/services/transcodeSession.js "LIVE_SESSION_TIMEOUT_MS" "live sessions have their own idle timeout"
check server/services/transcodeSession.js "session.options.live === true" "sweep honours the live flag"
check server/services/transcodeSession.js "const CLEANUP_INTERVAL_MS = 60 \* 1000" "sweep runs every minute so the live timeout is honoured"
check public/js/components/VideoPlayer.js "viewer-in-progress" "web player words the prompt for another viewer"
check public/js/components/VideoPlayer.js "live: true, ...options" "web player marks its fallback sessions as live"
check test/stream-coordinator.test.js "viewer-in-progress" "arbitration has unit tests"
check test/playback-arbitration.test.js "viewer-in-progress" "resolve's 409 is tested through the real route with real device tokens"

echo "=== 0056: Atomic EPG swap (P1-5) ==="
check server/db/sqlite.js "CREATE VIEW IF NOT EXISTS epg_live" "readers have a live-generation view"
check server/db/sqlite.js "ADD COLUMN gen INTEGER" "programmes carry a generation (migrated for existing databases)"
check server/db/sqlite.js "COALESCE(s.active_gen, 0)" "a source with no state row is live at generation 0 (legacy rows, direct inserts)"
check server/services/syncService.js "ON CONFLICT(source_id) DO UPDATE SET active_gen" "the swap is a single upsert"
check server/services/syncService.js "async purgeEpgRows" "old generations are purged in slices"
# The bug being fixed: the live guide was deleted before the new feed loaded.
check_absent server/services/syncService.js "DELETE FROM epg_programs WHERE source_id = ?').run(sourceId)" "sync no longer empties the live guide up front"
check_absent server/services/syncService.js "JSON.stringify(p)" "full programme JSON is no longer stored"
# Every reader must go through the view, or it shows two generations at once.
for f in server/routes/library.js server/routes/proxy.js; do
  check_absent "$f" "FROM epg_programs" "$f reads epg_live, not the raw table"
done
check server/routes/sources.js "DELETE FROM epg_state" "deleting a source clears its generation state"
check test/epg-swap.test.js "never empty while a new feed loads" "the swap has tests (incl. a mid-sync read and a legacy upgrade)"

echo "=== 0057: HLS segment route hardening (P2-4) ==="
# Whitelist the exact names ffmpeg writes; a suffix check let an encoded-slash
# path through, since Express decodes params after routing.
check server/routes/transcode.js "seg.d{4,}" "segment route accepts only the names ffmpeg writes (seg<digits>.ts|m4s, init.mp4)"
check_absent server/routes/transcode.js "(ts|m4s|mp4)\$/" "old suffix-only check is gone"
check server/services/transcodeSession.js "path.dirname(segmentPath) !== path.resolve(this.dir)" "getSegment refuses to leave the session directory"
check test/transcode-segments.test.js "encoded slash cannot walk out" "traversal has tests"

echo "=== 0058: ?token= through the HLS proxy rewriter (P2-5) ==="
check server/routes/proxy.js "const proxiedUrl = " "rewriter builds URIs in one place"
check server/routes/proxy.js "URI=\"\${proxiedUrl(absoluteUrl)}\"" "key/init/map URI attributes carry the token"
check server/routes/proxy.js "return proxiedUrl(absoluteUrl);" "segment lines carry the token"
# Both rewrite sites must go through proxiedUrl; a third hand-built URL would
# silently drop the token again.
if [ "$(grep -c 'stream?url=\${encodeURIComponent' server/routes/proxy.js)" = "1" ]; then
  echo "  ✓ only proxiedUrl builds /stream?url= URIs in the rewriter"
else
  echo "  ✗ MISSING: a rewriter URL is built outside proxiedUrl (would drop the token)"; FAIL=1
fi
check test/proxy-hls-token.test.js "carries it" "the rewriter has tests"

echo "=== 0059: Favourites id normalisation (P1-3 server half) ==="
check server/services/channelIds.js "function bareChannelId" "one place defines the bare/composite id forms"
check server/db/sqlite.js "function normalizeFavoriteIds" "existing prefixed favourites are migrated"
check server/db/sqlite.js "    normalizeFavoriteIds();" "the migration actually runs at schema init"
# The bug: web and native wrote different spellings, so favourites never crossed.
# Each of add/remove/isFavorite must normalise, or one of them silently misses.
if [ "$(grep -c "if (itemType === 'channel') itemId = bareChannelId(itemId);" server/db/sqlite.js)" = "3" ]; then
  echo "  ✓ add, remove and isFavorite all normalise channel ids"
else
  echo "  ✗ MISSING: favorites add/remove/isFavorite must each normalise channel ids"; FAIL=1
fi
check server/routes/favorites.js "compositeChannelId(" "the web-facing list keeps the composite form the web matches on"
check test/favourites-ids.test.js "native client adds shows up in the web app" "cross-client favourites have tests"

echo "=== 0060: Guide query bounds + item index (P2-3) ==="
check server/routes/library.js "const MAX_PROGRAMME_MS" "the programme-length bound has a name and a reason"
# Both EPG queries in this file need the lower bound, or one of them still walks the feed.
if [ "$(grep -c 'start_time > ? AND end_time > ? AND start_time < ?' server/routes/library.js)" = "2" ]; then
  echo "  ✓ both EPG queries (guide, now/next) bound start_time from below"
else
  echo "  ✗ MISSING: every EPG query in library.js must bound start_time from below"; FAIL=1
fi
check server/db/sqlite.js "idx_items_source_item" "channel lookups by item id are indexed"
check test/guide-bounds.test.js "long programme that began well before" "the bound has tests"

echo "=== 0061: Recording time zone + User-Agent (P2-6) ==="
check docker-compose.yml "TZ=\${TZ:-UTC}" "compose passes TZ through (UTC fallback = unchanged behaviour)"
check server/services/recordingNames.js "function formatLocalStamp" "file-name timestamp is testable on its own"
check server/services/recordingEngine.js "formatLocalStamp(schedule.program_start)" "recordings use it"
check server/services/recordingEngine.js "getUserAgent(settings)" "recording ffmpeg honours the userAgentPreset setting"
check_absent server/services/recordingEngine.js "Chrome/123.0.0.0" "no hard-coded Chrome UA left in the recording engine"
check test/recording-names.test.js "Australia/Sydney" "time-zone handling has tests"

echo "=== 0062: Recording native playback (P1-2 server half) ==="
check server/services/recordingEngine.js "function buildNativeRemuxArgs" "remux flags are built in one testable place"
check server/services/recordingEngine.js "'-tag:v', 'hvc1'" "HEVC is tagged hvc1"
# Both the remux and the HEVC compression output need the tag.
if [ "$(grep -c "'-tag:v', 'hvc1'" server/services/recordingEngine.js)" = "2" ]; then
  echo "  ✓ hvc1 is applied to both the native remux and HEVC compression"
else
  echo "  ✗ MISSING: hvc1 must be applied in both buildNativeRemuxArgs and buildCompressArgs"; FAIL=1
fi
check server/services/recordingEngine.js "const nativeRemuxes = new Map()" "concurrent remuxes of one recording are shared"
check server/services/recordingEngine.js "fs.renameSync(partial, output)" "output is renamed into place, never written in place"
check server/services/recordingEngine.js "async function nativeFileIsComplete" "pre-existing truncated files are detected"
check server/services/recordingEngine.js "compressionTargetPath(rec.file_path)\]" "deleting a recording removes its derived files"
check test/native-playback.test.js "share one remux" "native playback has tests"

echo "=== 0063: Body cap + rate limits (P2-7, partial) ==="
check server/index.js "express.json({ limit: '2mb' })" "request bodies are capped at 2 MB"
check_absent server/index.js "50mb" "the 50 MB body limit is gone"
check server/services/rateLimit.js "function createLimiter" "limiter exists"
check server/routes/auth.js "loginFailures.record(key)" "failed logins are counted"
check server/routes/auth.js "loginFailures.clear(key)" "a successful login forgets them"
# The key must not come from X-Forwarded-For (client-controlled under 'trust proxy: true').
check server/routes/auth.js "req.socket?.remoteAddress" "login limit is keyed on the socket address"
check_absent server/routes/auth.js "req.ip" "login limit never uses req.ip (spoofable via X-Forwarded-For)"
check server/routes/devices.js "limitRequests(pairStartLimiter" "pair/start is limited"
check server/routes/devices.js "limitRequests(pairingLimiter" "pair/poll is limited"
check test/rate-limit.test.js "ten wrong passwords lock" "the limits have tests"

echo "=== 0064: Remux codec identification ==="
check server/routes/remux.js "async function identifyCodecs" "codecs are identified in one place"
check server/services/streamProbe.js "function findCachedCodecs" "resolve's probe can be reused (no extra provider connection)"
check server/routes/remux.js "streamProbe.findCachedCodecs" "the remux route reuses it"
check server/routes/remux.js "Codec probe failed for" "probe failures are logged with a reason (they used to be silent)"
# The bug: with unknown codecs the remux started anyway and died on its first
# audio packet. It must refuse instead.
check server/routes/remux.js "status(503)" "an unidentifiable stream is refused, not started"
check server/routes/remux.js "identifyCodecs(url, ffprobePath, userAgent)" "the route uses identifyCodecs, not a bare detectCodecs"
check_absent server/routes/remux.js "await detectCodecs(url, ffprobePath, userAgent)" "no bare single-shot probe left in the route"
check test/remux-codecs.test.js "retried after a pause" "the retry has tests"

echo "=== 0065: Web player media-error reporting ==="
check public/js/components/VideoPlayer.js "addEventListener('error', () => this.handleMediaError())" "the <video> error event is handled (it used to fail silently)"
check public/js/components/VideoPlayer.js "handleMediaError()" "handler exists"
# The URL's query string carries the provider login and the session token.
check public/js/components/VideoPlayer.js "new URL(video.currentSrc, 'http://localhost').pathname" "only the URL path is logged/sent, never the query"
check public/js/components/VideoPlayer.js "this.currentStrategy = decision.strategy" "the server's chosen strategy is recorded for the report"
check public/js/components/VideoPlayer.js "if (this.isSourceCleared(video)) return;" "clearing the source (channel change) is not reported as a failure"
check public/css/main.css ".transcode-status.error" "the error badge has a style"
check server/routes/playback.js "router.post('/client-event', requireToken" "the report endpoint needs a token"
check server/routes/playback.js "body.event !== 'media-error'" "only the known event is accepted"
check server/routes/playback.js "redact(text(body.message, 200))" "the message is redacted before it reaches the log"
check server/routes/playback.js "clientEventLimiter" "the endpoint is rate limited"
check test/client-events.test.js "forge a log line" "the endpoint has tests"
check test/player-media-error.test.js "never throws into playback" "the player side has tests"

echo "=== 0066: AC-3 / E-AC-3 through the remux ==="
check server/routes/remux.js "function remuxFixes" "codec-driven fix-ups are decided in one place"
check server/routes/remux.js "function buildRemuxArgs" "the remux arguments are a testable function"
check server/routes/remux.js "needsDelayMoov: (audioCodec === 'ac3' || audioCodec === 'eac3')" "delay_moov only for AC-3/E-AC-3 (everything else keeps today's flags)"
check server/routes/remux.js "frag_keyframe+empty_moov+default_base_moof+delay_moov" "the delayed-header movflags exist"
check server/routes/remux.js "const args = buildRemuxArgs(url, userAgent, fixes);" "the route uses the function, not a second inline copy"
check_absent server/routes/remux.js "{needsAdtsToAsc" "no stale references to the old inline flag variables (only fixes.* remain)"
check test/remux-args.test.js "exactly the arguments it always had" "the existing flags are pinned by a test"

echo "=== 0067: EPG icon fallback in the library API ==="
check server/routes/library.js "function fillMissingLogos" "missing channel logos are filled from the EPG"
check server/routes/library.js "function getEpgIconIndex" "the EPG icon index exists (built once, not per page)"
# Both places that build channel rows must apply it, or the guide and the channel
# list disagree about what a channel looks like.
if [ "$(grep -c 'fillMissingLogos(' server/routes/library.js)" = "3" ]; then
  echo "  ✓ decorate() (channels, favourites) and the guide both apply it"
else
  echo "  ✗ MISSING: fillMissingLogos must be defined once and called from decorate() and the guide"; FAIL=1
fi
check server/routes/library.js "if (ch.logo) continue;" "a playlist-supplied logo is never replaced"
check test/library-logos.test.js "never replaced" "the fallback has tests"

echo "=== 0068: Audio re-encode self-heal (remux path) ==="
check server/routes/remux.js "req.query.audio === 'encode'" "the remux honours ?audio=encode"
check server/routes/remux.js "'-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1'" "the audio re-encode arguments exist"
# The output of the re-encode is raw AAC: the ADTS->ASC filter would refuse it, and
# delay_moov is only for AC-3/E-AC-3, which the re-encode replaces.
check server/routes/remux.js "needsAdtsToAsc: audioCodec === 'aac' && !encodeAudio" "no aac_adtstoasc on re-encoded audio"
check server/routes/remux.js "&& !encodeAudio" "no delay_moov on re-encoded audio"
check server/services/playbackStrategy.js "&audio=encode" "resolve can ask for it on the remux URL"
check server/services/playbackStrategy.js "audioEncode ? 'encode'" "resolve can ask for it on an HLS session"
check server/routes/playback.js "audioEncode: audioEncode === true" "the resolve route passes only a real boolean through"
# 'encode' must beat the smart-copy shortcuts or a stereo AAC source is copied again.
check server/services/transcodeSession.js "const forceEncode = this.options.audioMode === 'encode'" "an explicit encode request exists in the session builder"
check server/services/transcodeSession.js "isStereoAac && !forceEncode" "smart copy no longer overrides an explicit encode"
check public/js/components/VideoPlayer.js "shouldRetryWithAudioEncode(details)" "the player retries a failed remux"
check public/js/components/VideoPlayer.js "if (this._audioEncodeActive) return false;" "it never retries a play that was already re-encoding (no loop)"
check public/js/components/VideoPlayer.js "if (!options.isRetry) this._audioRetryKey = null;" "each fresh selection gets one retry, the retry itself does not"
check public/js/components/VideoPlayer.js "this.rememberAudioEncode(this.currentChannel, false)" "a flag that did not help is forgotten"
check test/player-audio-retry.test.js "can never loop" "the retry logic has tests"
check test/audio-encode.test.js "smart copy" "the server side has tests"

echo "=== 0069: cleared-source errors are not playback failures ==="
check public/js/components/VideoPlayer.js "isSourceCleared(video)" "the handler asks whether the source was just cleared"
check public/js/components/VideoPlayer.js "video.getAttribute('src')" "by the src attribute, which is reliable (currentSrc is not: Chrome keeps the old URL)"
check public/js/components/VideoPlayer.js "empty src attribute" "with the browser's own message as a second check"
# The bug: gating on currentSrc alone. It must not be the only guard again.
check_absent public/js/components/VideoPlayer.js "if (!video || !video.currentSrc || !video.error) return;" "no currentSrc-only guard left (Chrome keeps the old URL there)"
check public/js/pages/WatchPage.js "empty src attribute" "WatchPage does not log the routine cleared-source event"
check test/player-media-error.test.js "with the old URL still in currentSrc" "the real Chrome sequence is tested"

echo "=== 0070: diagnostics for silent 'nothing plays' failures ==="
check server/routes/remux.js "function describeRemuxEnd" "the disconnect line says whether anything was ever sent"
check server/routes/remux.js "ffmpeg had produced no output yet" "including the case that matters: no output at all"
check server/routes/remux.js "first output after" "time to first output is logged"
check server/routes/remux.js "function makeStderrLogger" "ffmpeg's messages are logged in full (capped)"
check_absent server/routes/remux.js "msg.includes('Warning') || msg.includes('Error') || msg.includes('error')" "no 'error'-only filter left hiding ffmpeg's messages"
check server/routes/remux.js "Client disconnected after" "the disconnect line keeps its old prefix (existing greps still work)"
check public/js/components/VideoPlayer.js "addEventListener('loadstart', () => this.armStartWatch())" "the player watches for a load that never starts"
check public/js/components/VideoPlayer.js "addEventListener('playing', () => { this.clearStartWatch();" "and stops watching once it plays"
check public/js/components/VideoPlayer.js "event: 'start-timeout'" "and reports it"
check public/js/components/VideoPlayer.js "if (video.paused || video.currentTime > 0) return;" "but not when paused or already moving"
check server/routes/playback.js "body.event !== 'start-timeout'" "the server accepts the new event (and still only the known ones)"
check test/player-start-watch.test.js "innocent explanations" "the start watch has tests"
check test/remux-diagnostics.test.js "never produced a byte" "the server diagnostics have tests"

echo "=== 0071: probe-phase decoder chatter is summarised, not logged ==="
check server/routes/remux.js "const PROBE_DECODER_MESSAGE" "decoder messages from the probe phase are recognised"
check server/routes/remux.js "logger.flush = " "and summarised in one line"
check server/routes/remux.js "logStderr.flush(); // the probe is over" "the summary is written when the probe ends (first output)"
if [ "$(grep -c 'logStderr.end()' server/routes/remux.js)" -ge "2" ]; then
  echo "  ✓ it is also summarised when the remux ends (client leaves or ffmpeg exits)"
else
  echo "  ✗ MISSING: logStderr.end() must run on client disconnect and on ffmpeg exit"; FAIL=1
fi
check test/remux-diagnostics.test.js "joining a stream mid-keyframe" "the noise handling has tests using the real log lines"
check server/routes/remux.js "function makeLineBuffer" "ffmpeg's stderr is line-buffered (it arrives in arbitrary pieces)"
check server/routes/remux.js "const tailLines = makeLineBuffer" "the stall/exit tail uses it too, not a naive split"
check_absent server/routes/remux.js "msg.split('\n')" "no naive per-chunk split of stderr left in the route"
check test/remux-diagnostics.test.js "however the stream is cut" "and it is tested at every cut point and byte by byte"

echo "=== 0072: Hide All / Show All update the group checkboxes ==="
check public/js/components/SourceManager.js "const groupKey = \`\${groupItemType}:\${group.categoryId}\`;" "setAllVisibility updates the group key that the checkbox is drawn from"
# The same key must be what getGroupHtml reads, or the two drift apart again.
if [ "$(grep -c 'groupItemType}:${group.categoryId}' public/js/components/SourceManager.js)" -ge "3" ]; then
  echo "  ✓ the group key is built the same way where it is drawn, saved and bulk-changed"
else
  echo "  ✗ MISSING: getGroupHtml, saveContentChanges and setAllVisibility must all use the same group key"; FAIL=1
fi
check test/source-manager-hide-all.test.js "straight away, not only after a reload" "the visible checkbox state is tested"

echo "=== 0073: HLS sessions tolerate audio/video start-time skew ==="
check server/services/transcodeSession.js "'-dts_delta_threshold', String(DTS_DELTA_THRESHOLD_SEC)," "the session raises ffmpeg's timestamp-jump threshold"
check server/services/transcodeSession.js "PIGTV_DTS_DELTA_THRESHOLD_SEC" "and it is tunable"
# It is an input option: it must sit before -i or it would apply to the output.
if awk '/-dts_delta_threshold/{d=NR} /args.push\(.-i., this.url\)/{i=NR} END{exit !(d && i && d<i)}' server/services/transcodeSession.js; then
  echo "  ✓ it comes before -i (an input option)"
else
  echo "  ✗ MISSING: -dts_delta_threshold must come before -i in the session arguments"; FAIL=1
fi
check test/hls-timestamp-skew.test.js "the old arguments do reproduce it" "the test also proves the fault reproduces without the flag"

echo "=== 0074: housekeeping ==="
check test/access.test.js "process.platform === 'win32' ? 'junction' : 'dir'" "the access test links node_modules with a junction on Windows (no admin needed)"

echo "=== 0075: HLS delivery (beta) for the web player, and play-start / play-end measurement ==="
check public/js/components/VideoPlayer.js "...(this.hlsDeliveryEnabled ? { segmentedDelivery: true } : {})" "resolve asks for segmented delivery only when this browser opted in"
check public/js/components/VideoPlayer.js "localStorage.getItem('pigtv_hls_delivery') === '1'" "the opt-in is per browser and off by default"
check public/js/components/VideoPlayer.js "this.notePlaying(); });" "the first picture is measured on the element's 'playing' event"
check public/js/components/VideoPlayer.js "this.reportPlayEnd();" "and the play is closed out when it stops"
check public/js/components/VideoPlayer.js "handleHlsFatal(data)" "a fatal hls.js error is no longer swallowed"
check public/index.html 'id="setting-hls-delivery-tc"' "there is a Settings toggle"
check public/js/pages/Settings.js "setHlsDelivery(hlsDeliveryToggle.checked)" "and it is wired to the player"
check server/routes/playback.js "const measurementLimiter" "measurement has its own rate limit, so it cannot starve fault reports"
check server/routes/playback.js "play-start via" "the server logs play-start"
check server/routes/playback.js "play-end via" "and play-end"
check server/services/playbackStrategy.js "resolve timing: HLS session" "resolve logs where a channel change's seconds go"
check test/player-hls-delivery.test.js "the first picture is reported once per play" "the player changes have tests"
check test/resolve-timing.test.js "resolve timing" "the timing lines have tests"

echo "=== 0076: inert files removed (review P2-1, batch a) ==="
for f in server/routes/users.js server/services/m3uXtreamAdapter.js server/plugins/hello.js; do
  if [ -e "$f" ]; then echo "  ✗ MISSING: $f should have been deleted"; FAIL=1; else echo "  ✓ $f is gone"; fi
done
# Nothing may still load them (a require of a deleted file is a startup crash).
if grep -rn "routes/users\|m3uXtreamAdapter\|plugins/hello" server test public --include=*.js | grep -v node_modules | grep -q .; then
  echo "  ✗ MISSING: something still refers to a deleted file"; FAIL=1
else
  echo "  ✓ nothing refers to them"
fi

echo "=== 0077: OIDC / SSO and express-session removed (review P2-1, P1-7) ==="
check_absent server/index.js "passport.session()" "no passport session middleware"
check_absent server/auth.js "openidconnect" "auth.js no longer loads the OIDC strategy"
check_absent server/auth.js "configureSessionSerialization" "or the session (de)serialisation"
check_absent server/routes/auth.js "oidc" "no OIDC routes"
check_absent server/db.js "getByOidcId" "no OIDC lookup in the user store"
check_absent public/login.html "btn-sso-login" "no SSO button on the login page"
check_absent public/index.html "SSO token" "the page no longer stores a ?token= from the URL"
check_absent package.json "express-session" "express-session is not a dependency"
check_absent package.json "passport-openidconnect" "nor is passport-openidconnect"
check_absent package-lock.json "node_modules/express-session" "and the lockfile agrees"

echo "=== 0078: JSON-file hiddenItems / favorites removed from db.js (review P2-1) ==="
check_absent server/db.js "hiddenItems" "no JSON-file hidden items (they live in SQLite, routes/channels.js)"
check_absent server/db.js "db.favorites" "no JSON-file favourites (they live in SQLite, routes/favorites.js)"
check test/db-legacy-keys.test.js "the next write drops the two unread arrays and nothing else" "an older db.json is tested to load and to lose only those two arrays"

echo "=== 0079: unknown /api paths return a JSON 404 ==="
check server/index.js "No such API endpoint" "an unknown /api path is an error, not the web app"
# It must come after every router and before the SPA fallback, or it swallows real routes / never runs.
if awk '/app.use\(.\/api\/recordings/{r=NR} /No such API endpoint/{e=NR} /SPA fallback - serve index.html/{s=NR} END{exit !(r && e && s && r<e && e<s)}' server/index.js; then
  echo "  ✓ it sits after the last router and before the SPA fallback"
else
  echo "  ✗ MISSING: the API 404 must come after all /api routers and before the SPA fallback"; FAIL=1
fi
check test/api-404.test.js "every route the Apple client calls still reaches its real handler" "a test boots the real server and asserts none of the Apple client's routes is swallowed"

echo "=== 0080: a failed db.json write is reported, not swallowed (review §2.14) ==="
check server/db.js "writeQueue = thisWrite.catch" "the write queue survives a failed write"
check server/db.js "return thisWrite;" "and the caller of the failed save is the one who hears about it"
check server/db.js "if (cachedDb === snapshot) cachedDb = previous;" "the in-memory copy is rolled back too (unless a newer save superseded it)"
check_absent server/db.js "Database write failed" "the old catch-and-continue that reported success is gone"
check test/db-write-failure.test.js "a later save that succeeds is not undone" "including the case where a newer save overtakes the failure"

echo "=== 0081: playback report script for the HLS trial ==="
check scripts/playback-report.js "play-start via" "the report reads the play-start line the server writes"
check scripts/playback-report.js "resolve timing" "and the resolve timing line, to tell cold plays from warm ones"
# The script parses log lines by their exact wording, so the server must still write them that way.
check server/routes/playback.js "play-start via" "the server still writes play-start"
check server/routes/playback.js "play-end via" "and play-end"
check server/services/playbackStrategy.js "resolve timing: " "and resolve timing"
check test/playback-report.test.js "the real lines are understood" "the report has tests built from real log lines"

echo "=== 0082: a recording waiting for a viewer is listed, cancellable and not duplicated ==="
check server/db/recordingsDb.js "status IN ('scheduled', 'recording', 'waiting')" "the upcoming list and the duplicate check include waiting"
check server/services/recordingEngine.js "schedule.status === 'scheduled' || schedule.status === 'waiting'" "a waiting recording can be cancelled"
check server/services/recordingEngine.js "coordinator.clearPrompt(id);" "and cancelling withdraws its viewer prompt"
check public/js/pages/RecordingsPage.js "waiting: 'Waiting for viewer'" "the web page labels it instead of showing the raw status"
check test/recordings-waiting.test.js "a waiting recording can be cancelled" "with tests"

echo "=== 0083: recording playback can be polled (202 preparing), and /api/info advertises what a client can rely on ==="
check server/routes/recordings.js "req.query.async === '1'" "the polling flavour is opt-in, so existing clients are unchanged"
check server/routes/recordings.js "status: 'preparing', retryAfterSec: 3" "a remux still running answers 202 preparing"
check server/routes/recordings.js "The server could not prepare this recording for playback" "a failure gives a plain message, not paths or ffmpeg output"
check server/services/recordingEngine.js "function pollNativePlayback" "the engine can say where preparation stands"
check server/services/recordingEngine.js "nativeFailures.delete(rec.id);" "and a failure is reported once, then forgotten"
check server/routes/info.js "recordingPlaybackPolling: true" "/api/info says polling exists"
check server/routes/info.js "scheduledWaiting: true" "and the other client-relevant behaviours"
check test/recording-playback-polling.test.js "two clients asking at once share one remux" "with route-level tests"

echo "=== 0084: the playback report keeps Apple-device plays apart from the web trial ==="
check scripts/playback-report.js "DEVICE_SUFFIX" "device plays get their own rows"
check test/playback-report.test.js "never count towards the web HLS trial" "and are tested not to count towards the web criteria"

echo "=== 0085: stream-copy HLS sessions can rebuild DTS from PTS order (SUPERSEDED by 0088: only feeds that need it) ==="
check server/services/transcodeSession.js "+genpts+discardcorrupt+igndts" "the rebuild is still what an uneven feed gets"
check server/services/transcodeSession.js "videoMode === 'copy' &&" "and still only copy-video ones: a re-encode makes its own timestamps"
check test/hls-copy-dts.test.js "no video packets are lost either way" "with a real-ffmpeg test that the old arguments reproduce the uneven timing"
check docs/SWIFT-CLIENT-HANDOFF.md "0085" "and the Apple hand-off doc records it"

echo "=== 0086: a source that ends is read at real time, so the HLS window cannot slide past the player ==="
check server/services/streamProbe.js "const finite = " "the probe says whether a source ends (a size or a duration)"
check server/services/playbackStrategy.js "paceInput: info.finite === true" "the strategy paces only those sessions"
check server/services/transcodeSession.js "this.options.paceInput === true" "the session reads such an input with -re"
check server/routes/transcode.js "function noteMissing" "and a playlist or segment 404 now leaves a line in the log"
check test/hls-finite-source.test.js "unpaced, ffmpeg outruns the playlist window" "with a real-ffmpeg test that reproduces the 404 without pacing"
check docs/SWIFT-CLIENT-HANDOFF.md "0086" "and the Apple hand-off doc records it"

echo "=== 0087: cancelling the takeover prompt stops the play instead of taking the stream anyway ==="
check public/js/components/VideoPlayer.js "VideoPlayer.CANCELLED = Symbol" "a declined takeover has its own answer, distinct from null"
check public/js/components/VideoPlayer.js "decision === VideoPlayer.CANCELLED" "and play() stops there rather than falling through to the local strategy"
check public/js/components/VideoPlayer.js "abandonPlay()" "the screen goes back to how it was, with no play-start reported"
check test/player-conflict-cancel.test.js "the local fallback - which would take the stream anyway - never runs" "with a test that fails on the old code"

echo "=== 0088: igndts is decided per feed, because it helps one kind of source and harms the other ==="
check server/services/streamProbe.js "function classifyTimestamps" "the probe says whether a feed timing is even"
check server/services/streamProbe.js "read_intervals" "read from the SAME probe call, bounded so a live feed cannot hang it"
check server/services/playbackStrategy.js "dtsUneven: info.dtsUneven === true" "the strategy passes the verdict to the session"
check server/services/transcodeSession.js "const useIgnDts = videoMode" "and only an uneven feed has its DTS rebuilt"
check server/routes/remux.js "needsIgnDts:" "the remux path is decided the same way, not unconditionally as before"
check server/services/transcodeSession.js "PIGTV_DTS_AUTO" "PIGTV_DTS_AUTO=0 restores 0085 behaviour without a rebuild"
check test/dts-classify.test.js "separated by a wide margin, not a fine threshold" "with tests for the classification"
check test/hls-copy-dts.test.js "an even source must be left alone" "and a real-ffmpeg test of BOTH directions"
check docs/SWIFT-CLIENT-HANDOFF.md "0088" "and the Apple hand-off doc records it"

echo "=== 0090: the timestamp diagnostics become a supported tool ==="
check scripts/stream-doctor.js "capture <pos_N>" "one tool with the five subcommands, replacing four throwaway scripts"
check scripts/stream-doctor.js "classifyTimestamps" "its verdict is the server function, not a second copy of the rule"
check scripts/stream-doctor.js "uses the provider slot" "and it says which subcommands take the provider connection"
check test/stream-doctor.test.js "not a second opinion" "with a test that the tool and the server agree"
check blueprint.md "reach for this first on any playback fault" "and the blueprint points at it"

echo "=== 0091 (docs): troubleshooting starts from a capture of the real channel ==="
check blueprint.md "When a channel misbehaves" "the loop is written down, in order"
check blueprint.md "No ffmpeg-flag or" "and shipping a timestamp fix on a hypothesis is called out as the 0085 mistake"
check blueprint.md "regression corpus" "samples are kept and retested, which 0085 had no way to do"
check blueprint.md 'cd "C:.Users.markr.GitHub.PigTV"' "the apply block cds to the current repo folder"
check blueprint.md "moved out of OneDrive" "and the orientation table agrees with it"

echo "=== 0092 (docs): commands name the container instead of a placeholder ==="
check blueprint.md "docker exec PigTV node scripts/stream-doctor" "so a command can be pasted as written"
check docs/SWIFT-CLIENT-HANDOFF.md "docker logs PigTV" "including the ones the Apple client session runs"

echo "=== 0093: captured samples survive a deploy ==="
check scripts/stream-doctor.js "path.join(DATA, .samples.)" "they are written under the data bind mount, not the writable layer"
check test/stream-doctor.test.js "not the writable layer" "with a test that pins it to the mount docker-compose declares"
check blueprint.md "has to outlive the build it was taken on" "and the blueprint says why it matters"

if [ $FAIL -eq 0 ]; then
    echo ""
    echo "=== ALL CHECKS PASSED ==="
else
    echo ""
    echo "=== FAILED — do NOT export patches ==="
    exit 1
fi
