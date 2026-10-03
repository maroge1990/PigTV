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
check server/services/playbackStrategy.js "vaapiCpuScale" "setting passthrough (0122: resolve is the only session entry)"
check server/db.js "vaapiCpuScale" "default setting"

echo "=== 0003: Remux AAC ==="

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
# 0182: stopping a stream moved from Settings -> Debug to the Status page.
check public/js/pages/StatusPage.js "data-kill-all" "stop-all button (Status page)"
check public/js/pages/StatusPage.js "killAllSessions" "stop button handler (Status page)"
check server/services/syncService.js "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?" "14-param INSERT"

echo "=== 0009: Movies/Series toggle (removed with Movies/Series in 0122) ==="
check public/js/pages/Settings.js "loadUiSettings" "UI load handler (theme)"
check_absent server/db.js "showMovies" "no movies setting left"
check_absent public/js/app.js "applyContentVisibility" "no movies/series visibility code left"

echo "=== 0010: Guide → Live TV ==="
check public/js/components/EpgGuide.js "navigateTo" "navigation call"
check public/js/components/EpgGuide.js "channelId.*sourceId" "ID-based lookup"

echo "=== 0011: EPG visible filter (0122: the whole-EPG route is gone; /api/library/guide lists visible channels) ==="
check_absent server/routes/proxy.js "router.get('/epg/:sourceId'" "no whole-EPG dump"

echo "=== 0017: category order + flags on real endpoint ==="
check server/db/sqlite.js "ALTER TABLE categories ADD COLUMN sort_order" "categories migration"
check server/services/syncService.js "sort_order: idx + 1" "M3U category order captured"
check server/services/syncService.js "sort_order = excluded.sort_order" "categories upsert keeps order"
check server/routes/library.js "c.sort_order ASC, c.name ASC" "real endpoint ordering (0122: /api/library/categories)"

echo "=== 0017: settings reorganisation ==="
check public/index.html "data-tab=\"recording\"" "Recording tab"
# 0182: six tabs; the theme panel sits under System, Debug is on the Status page.
check public/index.html "id=\"tab-ui\"" "UI panel (under System)"
check public/index.html "data-tab=\"system\"" "System tab"
check public/js/pages/Settings.js "loadRecordingSettings" "recording handlers"
check public/js/pages/Settings.js "loadUiSettings" "ui handlers"
check public/js/pages/StatusPage.js "data-kill-session" "per-stream stop (Status page)"
check public/js/api.js "killAllSessions" "transcode api group"

echo "=== 0017: guide cell + transcode + uncategorized ==="
check public/js/components/EpgGuide.js "resize-handle" "whole-cell click guard"
check public/css/main.css "epg-channel-info {" "whole-cell cursor"
check server/services/transcodeSession.js "fps_mode" "fps passthrough"
check server/services/transcodeSession.js "min(ih," "scale clamp"
check server/routes/library.js "c.category_id = p.category_id AND c.is_hidden = 1" "hidden-category exclusion (0122: in /api/library)"
check public/js/components/ChannelList.js "categoryNames.get(\`\${row.sourceId}:\${row.category}\`) || row.category" "group name fallback (0121: from /api/library/categories, else the category id)"

echo "=== 0018: transcode strategy ==="
check server/services/streamProbe.js "clientCaps" "probe takes client caps"
check server/services/streamProbe.js "videoIsHevc" "probe reports hevc"
check server/services/streamProbe.js "clientCaps" "caps reach the probe (0122: /api/probe removed)"
check public/js/components/VideoPlayer.js "getCodecCapabilities" "client caps detection"
# (0102: the live player no longer probes or picks a segment type itself - the server does.
#  0122: the movie/series page that still did went with VOD.)
check server/services/transcodeSession.js "hls_fmp4_init_filename" "fmp4 output"
check server/services/transcodeSession.js "tag:v" "hvc1 tagging"
check server/services/transcodeSession.js "vaapiHwDecode" "hw decode option"
check server/services/transcodeSession.js "_triedSwDecode" "sw decode fallback"
check server/services/transcodeSession.js "force_key_frames" "segment-aligned keyframes"
check server/routes/transcode.js "m4s" "segment route serves fmp4"
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
check public/js/components/VideoPlayer.js "    stop() {" "stop implementation (0102 removed the unused async duplicate)"
check public/js/components/VideoPlayer.js "goToLive" "go-live implementation"
check public/js/components/VideoPlayer.js "updateLiveButton" "live indicator"
check public/css/main.css "btn-go-live" "live button styles"

echo "=== 0020: kill all covers remux ==="

echo "=== 0021: PigTV rebrand + recording fix ==="
check server/services/recordingEngine.js "m3u|xtream" "channel id normalisation"
check package.json "pigtv" "package renamed"
check public/index.html "pigtv-logo.png" "logo in navbar"
check public/login.html "pigtv-logo.png" "logo on login"
check .github/workflows/docker-publish.yml "/pigtv" "CI image renamed"
check README.md "PigTV" "README rebranded"
check public/css/main.css "EF7AAE" "accent retuned (the 3 Oct brand refresh)"
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
check public/js/components/SourceManager.js "groupItemType()" "group type helper"
check public/js/components/ChannelList.js "Choose what to show under Settings" "empty state wording (0121: points at Manage Content when a source exists)"
check server/routes/channels.js "cascadeCategory" "single hide/show cascades"
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
check server/services/playbackStrategy.js "probeStream" "resolve uses the probe service"
check server/services/playbackStrategy.js "strategy: 'direct'" "direct play path"
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
check server/services/streamCoordinator.js "recordings.length + 1" "requesting viewer is counted"
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
# The live player's own URL builders (proxy / legacy pipe / remux) went with those
# paths in 0102: everything it loads is the server's decision.url, checked above.
# (0122: the movie/series page, with its own session POST, is gone.)

echo "=== 0034: native HLS delivery for segmented clients ==="
check server/services/playbackStrategy.js "segmentedDelivery" "capability flag exists"
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
# (0122: /api/probe and /api/subtitle were removed; resolve and the session delete keep
#  their own always-on token middleware, checked next.)
check server/routes/playback.js "streamAuth({ enforce: true })" "always-on token middleware"
check server/routes/playback.js "router.post('/resolve', requireToken" "resolve requires a token"
check server/routes/playback.js "router.delete('/:sessionId', requireToken" "session delete requires a token"
# (0122: /api/probe and /api/subtitle, and the movie/series page that called them, are gone.)
check_absent server/index.js "app.use('/api/probe'" "no /api/probe"
check_absent server/index.js "app.use('/api/subtitle'" "no /api/subtitle"

echo "=== 0051: Drop the dead ffmpeg-static require ==="
check_absent server/routes/proxy.js "require('ffmpeg-static')" "proxy.js no longer requires ffmpeg-static at load (would crash startup if the optional dep failed)"
# index.js keeps its own guarded fallback require - that one is inside try/catch.
check server/index.js "require('ffmpeg-static')" "index.js keeps its guarded ffmpeg-static fallback"

echo "=== 0052: Provider credential redaction (P1-4) ==="
check server/redact.js "function redact" "redact helper exists"
check server/routes/transcode.js "url: redact(x.url)" "/sessions response redacts upstream URLs"
check server/routes/playback.js "const safe = clientSafe(redact(err.message))" "resolve error body is redacted"
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
# Superseded by 0135 (db.json moved into SQLite): the settings cache is checked there.
check server/db.js "let settingsCache = null;" "settings are served from an in-memory cache"
check_absent server/index.js "express-session" "no session store at all (0077 removed it; the MemoryStore leak cannot come back)"

echo "=== 0054: ffmpeg output-inactivity watchdog ==="
check server/services/stallWatchdog.js "function createStallWatchdog" "shared watchdog exists"
check server/services/stallWatchdog.js "PIGTV_STALL_TIMEOUT_MS" "stall limit is tunable without a patch"
# Both delivery paths read the same live input with the same reconnect flags,
# so both need the watchdog, and it has to be started on the real process.
check server/services/transcodeSession.js "createStallWatchdog(" "HLS session path runs the watchdog"
check server/services/transcodeSession.js "this.startWatchdog()" "HLS watchdog started once ffmpeg is spawned"
check server/services/transcodeSession.js "this.stopWatchdog()" "HLS watchdog stopped when ffmpeg exits / session stops"
# Silence with the client not reading (paused tab, full pipe) is the client's
# doing, not ffmpeg's. Without this guard a paused viewer gets killed.
# Remux idle accounting: idleMs must mean 'time since media last flowed', and
# the coordinator must use it instead of pretending every remux is busy.
check_absent server/services/streamCoordinator.js "idleMs: 0," "coordinator no longer hard-codes remux idleMs to 0"
check test/stall-watchdog.test.js "createStallWatchdog" "watchdog has unit tests"

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
check_absent server/services/streamCoordinator.js "soft" "no soft mode (0122: it existed only for the removed POST /api/transcode/session)"
check server/services/transcodeSession.js "LIVE_SESSION_TIMEOUT_MS" "live sessions have their own idle timeout"
check server/services/transcodeSession.js "session.options.live === true" "sweep honours the live flag"
check server/services/transcodeSession.js "const CLEANUP_INTERVAL_MS = 60 \* 1000" "sweep runs every minute so the live timeout is honoured"
check public/js/components/VideoPlayer.js "viewer-in-progress" "web player words the prompt for another viewer"
# (0102: the live player has no fallback sessions any more; resolve creates live sessions server-side.)
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
# silently drop the token again. (0119 split the line: proxiedUrl builds either
# ?h= or ?url=, so count the "/stream?" prefix, which only it writes.)
if [ "$(grep -c '/stream?' server/routes/proxy.js)" = "1" ]; then
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
# The bug: with unknown codecs the remux started anyway and died on its first
# audio packet. It must refuse instead.

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
# The output of the re-encode is raw AAC: the ADTS->ASC filter would refuse it, and
# delay_moov is only for AC-3/E-AC-3, which the re-encode replaces.
check server/services/playbackStrategy.js "audioEncode ? 'encode'" "resolve can ask for it on an HLS session"
check server/routes/playback.js "audioEncode: audioEncode === true" "the resolve route passes only a real boolean through"
# 'encode' must beat the smart-copy shortcuts or a stereo AAC source is copied again.
check server/services/transcodeSession.js "const forceEncode = this.options.audioMode === 'encode'" "an explicit encode request exists in the session builder"
check server/services/transcodeSession.js "isStereoAac && !forceEncode" "smart copy no longer overrides an explicit encode"
check public/js/components/VideoPlayer.js "shouldRetryWithAudioEncode(details)" "the player retries a failed remux"
check public/js/components/VideoPlayer.js "if (this._audioEncodeActive) return false;" "it never retries a play that was already re-encoding (no loop)"
check public/js/components/VideoPlayer.js "            this._audioRetryKey = null;" "each fresh selection gets one retry, the retry itself does not"
check public/js/components/VideoPlayer.js "this.rememberAudioEncode(this.currentChannel, false)" "a flag that did not help is forgotten"
check test/player-audio-retry.test.js "can never loop" "the retry logic has tests"
check test/audio-encode.test.js "smart copy" "the server side has tests"

echo "=== 0069: cleared-source errors are not playback failures ==="
check public/js/components/VideoPlayer.js "isSourceCleared(video)" "the handler asks whether the source was just cleared"
check public/js/components/VideoPlayer.js "video.getAttribute('src')" "by the src attribute, which is reliable (currentSrc is not: Chrome keeps the old URL)"
check public/js/components/VideoPlayer.js "empty src attribute" "with the browser's own message as a second check"
# The bug: gating on currentSrc alone. It must not be the only guard again.
check_absent public/js/components/VideoPlayer.js "if (!video || !video.currentSrc || !video.error) return;" "no currentSrc-only guard left (Chrome keeps the old URL there)"
check test/player-media-error.test.js "with the old URL still in currentSrc" "the real Chrome sequence is tested"

echo "=== 0070: diagnostics for silent 'nothing plays' failures ==="
check public/js/components/VideoPlayer.js "addEventListener('loadstart', () => this.armStartWatch())" "the player watches for a load that never starts"
check public/js/components/VideoPlayer.js "addEventListener('playing', () => { this.clearStartWatch();" "and stops watching once it plays"
check public/js/components/VideoPlayer.js "event: 'start-timeout'" "and reports it"
check public/js/components/VideoPlayer.js "if (video.paused || video.currentTime > 0) return;" "but not when paused or already moving"
check server/routes/playback.js "body.event !== 'start-timeout'" "the server accepts the new event (and still only the known ones)"
check test/player-start-watch.test.js "innocent explanations" "the start watch has tests"

echo "=== 0071: probe-phase decoder chatter is summarised, not logged ==="

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
# (0102: the opt-in became the only path - see the 0102 section.)
check public/js/components/VideoPlayer.js "this.notePlaying(); });" "the first picture is measured on the element's 'playing' event"
check public/js/components/VideoPlayer.js "this.reportPlayEnd();" "and the play is closed out when it stops"
check public/js/components/VideoPlayer.js "handleHlsFatal(data)" "a fatal hls.js error is no longer swallowed"
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
check test/db-legacy-keys.test.js "the migration into SQLite carries the used collections, not the two unread arrays" "an older db.json is tested to load and to lose only those two arrays"

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
# 0135 moved the store into SQLite: a write is one transaction, rolled back whole on failure.
check server/db.js "return db.transaction(() => fn(db))();" "every write is one transaction"
check server/db.js "The server could not save its data (is the disk full or read-only?)" "and a failure reaches the caller as a plain sentence"
check_absent server/db.js "Database write failed" "the old catch-and-continue that reported success is gone"
check test/db-write-failure.test.js "two updates in flight together both land" "and two writes in flight together both land (0135: transactions, no whole-store rewrite)"

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
check test/playback-report.test.js "device plays get their own rows, apart from the web player" "and are tested to stay apart from the web player's rows (0113: the trial they were kept out of is retired)"

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
check blueprint.md "/Users/markrogers/Documents/GitHub/PigTV" "the orientation table names the current repo folder"
check blueprint.md "Claude commits and pushes straight to" "and how changes ship is written down"

echo "=== 0092 (docs): commands name the container instead of a placeholder ==="
check blueprint.md "docker exec PigTV node scripts/stream-doctor" "so a command can be pasted as written"
check docs/SWIFT-CLIENT-HANDOFF.md "docker logs PigTV" "including the ones the Apple client session runs"

echo "=== 0093: captured samples survive a deploy ==="
check scripts/stream-doctor.js "path.join(DATA, .samples.)" "they are written under the data bind mount, not the writable layer"
check test/stream-doctor.test.js "not the writable layer" "with a test that pins it to the mount docker-compose declares"
check blueprint.md "has to outlive the build it was taken on" "and the blueprint says why it matters"

echo "=== 0094: a displaced client can tell takeover from an ordinary failure ==="
check server/services/streamCoordinator.js "function terminalStatus" "the coordinator remembers, briefly, that a session was replaced"
check server/services/streamCoordinator.js "noteReplaced(stream)" "written by admitViewer only, so DELETE and the sweeps leave nothing"
check server/services/streamCoordinator.js "forced-takeover" "releases carry why they happened, into the log"
check server/routes/playback.js "terminal-status" "the route exists, behind bearer auth"
check server/routes/info.js "playbackTerminalStatus" "and /api/info advertises it so an older server keeps the old client path"
check test/playback-arbitration.test.js "two password logins share one owner key" "with the case owner equality cannot solve"
check test/api-404.test.js "terminal-status" "and the Apple-client route guard covers it"
check docs/SWIFT-CLIENT-HANDOFF.md "0094" "and the Apple hand-off doc records it"

echo "=== 0095: the image says which source it was built from ==="
check .github/workflows/docker-publish.yml "PIGTV_COMMIT=" "CI passes the commit into the build"
check .github/workflows/docker-publish.yml "id: stamp" "computed in a step, so release and workflow_dispatch work too"
check blueprint.md "builds \`ghcr.io/maroge1990/pigtv\` \*\*only if the tests pass" "and the mechanism is written down rather than assumed"
check .github/workflows/docker-publish.yml "needs: test" "and the image build waits for the regression tests"

echo "=== 0096: a channel identity that a provider reorder cannot move (P1-3, part 1) ==="
check server/services/stableIds.js "function stableChannelId" "identity derived from the provider stream id in the URL"
check server/services/stableIds.js "is not the credentials, which rotate" "and not from the credentials, which rotate"
check server/db/sqlite.js "ADD COLUMN stable_id" "stored alongside the row, additive to the schema"
check server/db/sqlite.js "function backfillStableIds" "backfilled for rows that predate it, idempotently"
check server/services/syncService.js "stable_id = excluded.stable_id" "and rewritten by every sync, so a moved row cannot keep a stale one"
check server/services/syncService.js "Channel identity:" "the sync reports how the whole playlist derived"
check test/stable-id-migration.test.js "survives the reorder that started all this" "with a test of the real reorder"

echo "=== 0097: favourites follow the channel, not the playlist position (P1-3, part 2a) ==="
check server/db/sqlite.js "function identityOf" "a caller id is resolved to the channel it names"
check server/db/sqlite.js "function backfillFavoriteIdentities" "existing favourites are migrated at startup"
check server/db/sqlite.js "stable_id IS NULL AND item_id" "and a stale position is ignored once a row has an identity"
check server/routes/library.js "GROUP BY COALESCE" "a channel listed twice appears once in the favourites list"
check test/favourites-stable.test.js "this is the bug being fixed" "with a test of the real reorder"

echo "=== 0098: recordings and history follow the channel too (P1-3, part 2b) ==="
check server/db/recordingsDb.js "channel_stable_id" "a schedule records which channel it is for"
check server/db/recordingsDb.js "status IN ..scheduled., .waiting.." "backfilled for pending schedules only"
check server/services/recordingEngine.js "function channelIdentity" "resolved when the schedule is made, while the playlist still says where it is"
check server/db/sqlite.js "function backfillHistoryIdentities" "watch history gets the same treatment"
check test/recording-stable-channel.test.js "full of the wrong programme" "with a test of a reorder between scheduling and recording"

echo "=== 0099: strip the small-caps LIVE badge at ingest (SR-2) ==="
check server/services/textCleanup.js "function stripBadgeSuffix" "shared stripper exists"
check server/services/epgParser.js "stripBadgeSuffix" "EPG parser strips titles/names"
check server/services/m3uParser.js "stripBadgeSuffix" "M3U parser strips channel names"
check test/badge-strip.test.js "NFL Football - Giants at Rams" "with a test on the real reported title"
python3 - <<'PYCHK'
import subprocess, sys
# Run the stripper against the two reported strings and a middle-of-title
# lookalike. Grep can prove the function is referenced, not that it strips
# only a TRAILING run — a naive "remove all badge glyphs" would also break
# a (hypothetical) legitimate mid-title use, and an over-eager anchor would
# leave the badge in place. This pins the actual behaviour.
badge = 'ᴸɪᴠᴇ'  # "ᴸɪᴠᴇ"
script = '''
const { stripBadgeSuffix } = require('./server/services/textCleanup.js');
const B = '%s';
const cases = [
    [`NFL 16 ${B}`, 'NFL 16'],
    [`NFL Football - Giants at Rams ${B}`, 'NFL Football - Giants at Rams'],
    ['NFL Football - Giants at Rams', 'NFL Football - Giants at Rams'],
    [`The ${B} Show`, `The ${B} Show`],
];
let ok = true;
for (const [inp, want] of cases) {
    if (stripBadgeSuffix(inp) !== want) { ok = false; console.log('FAIL: ' + JSON.stringify(inp)); }
}
console.log(ok ? 'OK' : 'BAD');
''' % badge
result = subprocess.run(['node', '-e', script], capture_output=True, text=True)
if result.stdout.strip().splitlines()[-1:] == ['OK']:
    print('  ✓ only a trailing badge run is stripped; ordinary and mid-title text untouched')
else:
    print(f'  ✗ MISSING: {result.stdout.strip()}\n{result.stderr.strip()}')
    sys.exit(1)
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0100: HDR sessions carry VIDEO-RANGE in a master playlist (SR-1) ==="
check server/services/streamProbe.js "function classifyVideoRange" "the probe classifies PQ / HLG from color_transfer"
check server/services/playbackStrategy.js "if (hdrCopy && segmentType === 'fmp4') videoRange = info.videoRange" "only a copied fMP4 session is called HDR (0115: expression reworded)"
check server/services/transcodeSession.js "VIDEO-RANGE=" "the master playlist states the range"
check server/routes/transcode.js "master.m3u8" "and is served, with the stream token on its variant"
check test/api-404.test.js "/api/transcode/abc/master.m3u8" "the Apple-client route guard knows it"
check test/hdr-master-playlist.test.js "smpte2084" "with a test built on the real capture's fields"

echo "=== 0102: the web player is on the one path (Phase 3) ==="
check public/js/components/VideoPlayer.js "                segmentedDelivery: true" "every browser asks for HLS segments, as the Apple client does"
check public/js/components/VideoPlayer.js "recoverPlayback(reason" "recovery is a fresh resolve, once per selection"
check public/js/components/VideoPlayer.js "hls.recoverMediaError();" "a fatal media error is first recovered in place"
check public/js/components/VideoPlayer.js "this.stopConflictWatch();" "stop() also ends the recording-conflict poll"
check test/player-hls-delivery.test.js "no second retry: it can never loop" "with tests of the recovery"
check test/player-conflict-cancel.test.js "never a local strategy" "and of a play the server could not start"
python3 - <<'PYCHK'
import sys
# Grep can prove something is present, not that something is gone. The whole point of
# 0102 is what is gone: any of these back in a player means a second delivery path.
live = open('public/js/components/VideoPlayer.js', encoding='utf-8').read()
html = open('public/index.html', encoding='utf-8').read()
bad = [f'live player: {g}' for g in ['/api/remux', '/api/transcode?url=', '/api/probe', 'startTranscodeSession',
                                     'forceRemux', 'autoTranscode', 'pigtv_hls_delivery'] if g in live]
bad += [f'settings: {g}' for g in ['setting-force-remux-tc', 'setting-hls-delivery-tc', 'setting-auto-transcode-tc'] if g in html]
if bad:
    print('  \u2717 MISSING: a second delivery path is back: ' + ', '.join(bad))
    sys.exit(1)
print('  \u2713 no remux, legacy pipe, local probe or beta toggle left in the web player')
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0103: remux retired - one delivery path (Phase 4) ==="
# The checks that pinned the remux route, its registry, watchdog wiring, codec probe,
# argument builder and diagnostics were retired with it; their history is in git.
check server/services/playbackStrategy.js "It was retired in 0103" "resolve documents why there is no remux strategy"
check server/services/playbackStrategy.js "2. Everything else is an HLS session" "codecs-fine streams are HLS sessions with both streams copied"
check test/audio-encode.test.js "never a remux any more" "with a test that a request without segmentedDelivery still gets HLS"
check test/api-404.test.js "one delivery path (0103)" "and that /api/remux and the legacy pipe answer 404"
python3 - <<'PYCHK'
import os, re, sys
# Presence can be grepped; absence has to be checked. Any of these back means a
# second delivery path is back.
bad = []
if os.path.exists('server/routes/remux.js'):
    bad.append('server/routes/remux.js exists')
for root, _, files in os.walk('server'):
    for f in files:
        if not f.endswith('.js'):
            continue
        path = os.path.join(root, f)
        src = open(path, encoding='utf-8').read()
        code = '\n'.join(l for l in src.split('\n') if not l.strip().startswith(('//', '*', '/*')))
        if re.search(r"require\([^)]*routes/remux|require\('\./remux'\)", code):
            bad.append(f'{path} requires the remux route')
        if "'/api/remux" in code or '`/api/remux' in code:
            bad.append(f'{path} builds an /api/remux URL')
        if "strategy: 'remux'" in code:
            bad.append(f'{path} returns a remux strategy')
tsrc = open('server/routes/transcode.js', encoding='utf-8').read()
if re.search(r"router\.get\('/',", tsrc):
    bad.append('the legacy piped GET /api/transcode?url= is back')
if bad:
    print('  \u2717 MISSING: ' + '; '.join(bad))
    sys.exit(1)
print('  \u2713 no remux route, remux URL, remux strategy or legacy pipe anywhere in the server')
PYCHK
[ $? -eq 0 ] || FAIL=1

echo "=== 0104: session hardening ==="
check server/services/transcodeSession.js "const requested = this.status === 'stopped';" "an exit nobody asked for is an error, whatever the code (255 used to leave 'running')"
check server/services/transcodeSession.js "this._usedVaapiDecode === true && !this.timings.playlistReady" "the software-decode retry is only for a GPU-decoding encode that never produced a playlist"
check server/services/streamUrl.js "function isStreamUrl" "only network URLs are opened"
check server/services/transcodeSession.js "if (!isStreamUrl(this.url))" "a session will not hand ffmpeg a local file"
check server/services/streamProbe.js "if (!isStreamUrl(url)) return Promise.reject" "nor will the probe"
check server/routes/playback.js "NOT_A_STREAM_URL" "resolve refuses one with a 400"
# (0122: the session route, /api/probe and /api/subtitle - the other entries that took a URL - are gone.)
check server/routes/proxy.js "await pipeline(Readable.from(body()), res);" "/api/proxy/stream streams binary content instead of buffering it"
check server/routes/proxy.js "upstreamAbort.abort()" "and lets go of the upstream when the client leaves"
check_absent server/services/transcodeSession.js "async persist()" "no session.json with the provider URL in it"
check_absent server/services/transcodeSession.js "async function getOrCreateSession" "no unused getOrCreateSession"
check test/session-hardening.test.js "it used to stay" "with tests"
check test/proxy-stream-binary.test.js "releases the upstream connection" "and for the proxy"

echo "=== 0106: stableId on guide and favourites rows ==="
check server/routes/library.js "SELECT p.item_id, p.source_id, p.name, p.stream_icon, p.category_id, p.sort_order, p.data, p.stable_id" "favourites selects p.stable_id, not just /channels"
check server/routes/library.js "stableId: row.stable_id || null," "guide rows carry stableId too"
check test/guide-favourites-stableid.test.js "carries stableId" "with a test"

echo "=== 0107: dead duplicate proxy routes removed ==="
# Express runs only the FIRST matching layer; a second registration of the same
# path+method is unreachable dead code that can be edited by mistake. Count, not
# just grep -q, since presence alone can't tell one registration from two.
# (0122 removed both routes entirely; test/proxy-no-duplicate-routes.test.js now pins
#  the router to its one route, GET /stream.)
if [ "$(grep -c "^router\.\(get\|post\|put\|delete\)(" server/routes/proxy.js)" = "1" ]; then
    echo "  ✓ proxy.js registers one route"
else
    echo "  ✗ MISMATCH: proxy.js should register only GET /stream"; FAIL=1
fi
check test/proxy-no-duplicate-routes.test.js "registers GET /stream, exactly once, and nothing else" "with a test on router.stack"

echo "=== 0108: gzip JSON responses, never media ==="
check package.json '"compression"' "compression package is a dependency"
check server/index.js "require('compression')" "wired into the server"
check server/index.js "filter: shouldCompress" "using the project's own allow-list filter, not the library default"
check server/services/compressionFilter.js "req.headers.range" "the filter refuses any ranged request"
check server/services/compressionFilter.js "/api/transcode" "and anything under /api/transcode"
check server/services/compressionFilter.js "/api/proxy/stream" "and /api/proxy/stream"
check server/services/compressionFilter.js "media\\\\.mp4|stream|download" "and recording media routes"
check_absent server/services/compressionFilter.js "'video/" "and never allow-lists a video type"
check test/compression-filter.test.js "content-encoding'), 'gzip'" "with a test that JSON is gzip-encoded"
check test/compression-filter.test.js "never compressed" "and that media/ranged responses are not"

echo "=== 0109: supported runtime and a reproducible image ==="
check Dockerfile "setup_24.x" "nodesource points at Node 24, not the EOL Node 20"
check_absent Dockerfile "setup_20.x" "no leftover reference to Node 20"
check Dockerfile "npm ci --omit=dev" "production install uses the non-deprecated --omit=dev flag"
check_absent Dockerfile "npm ci --only=production" "the deprecated --only=production flag is gone"
check Dockerfile "git fetch --depth 1 https://github.com/erikkaashoek/Comskip a140b6ac8bc8f596729e9052819affc779c3b377" "Comskip is pinned to a specific commit, not a moving master"
check_absent Dockerfile "git clone --depth 1 https://github.com/erikkaashoek/Comskip" "no unpinned clone of Comskip master left behind"
check .github/workflows/test.yml "node: \[22, 24\]" "CI matrix is Node 22 and 24, not the EOL Node 20"

echo "=== 0110: /api/favorites follows the channel's current identity ==="
check server/routes/favorites.js "function expandToCurrentItemIds" "GET /favorites resolves stored favourites to current playlist rows"
check server/routes/favorites.js "WHERE source_id = ? AND stable_id = ? AND type" "the resolution joins on stable_id, current listings only"
check server/routes/favorites.js "expandToCurrentItemIds(favorites.getAll" "the GET / handler actually calls it"
check test/favorites-current-item-id.test.js "not the stale pos_A" "with a test that fails on the old code"
check test/favorites-current-item-id.test.js "shows a star in both current listings" "and a cross-listed channel"

echo "=== 0111: guide API for scale (cursor paging, tvg_id column, guide version) ==="
check server/routes/info.js "guideCursor: true" "features flag for cursor paging"
check server/routes/info.js "guideVersion: true" "features flag for the version endpoint"
check server/routes/library.js "clamp(req.query.limit, 1, 500, 25)" "guide limit goes up to 500"
check server/routes/library.js "router.get('/guide/version'" "GET /library/guide/version exists"
check server/routes/library.js "currentGuideVersion" "and it uses the shared revision helper"
check server/routes/library.js "decodeGuideCursor" "keyset cursor decoding"
check server/routes/library.js "row.tvg_id || null" "guide rows read the indexed column first"
check server/routes/library.js "JSON.parse(row.data || '{}');" "with the JSON parse kept only as a fallback for rows the column has not reached"
check server/db/sqlite.js "ALTER TABLE playlist_items ADD COLUMN tvg_id TEXT" "tvg_id column migration"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS meta" "meta table for the revision counter"
check server/services/libraryRev.js "function bumpLibraryRev" "revision-bump helper exists"
check server/services/libraryRev.js "epg_state" "and folds in the EPG generations"
check server/services/syncService.js "bumpLibraryRev()" "a completed sync bumps the guide version"
check server/routes/channels.js "bumpLibraryRev()" "hide/show bumps the guide version"
check server/services/syncService.js "item.tvgId || item.epg_channel_id || null" "tvg_id is filled at ingest, not only backfilled"
check test/guide-scale.test.js "same order as the offset page" "with a cursor-vs-offset equivalence test"
check test/guide-scale.test.js "hiding a channel must change the guide version" "and a version-change test"
check test/tvg-id-column.test.js "tvg_id must be set by the sync itself" "and an ingest-time tvg_id test"

echo "=== 0112: logo cache ==="
check server/routes/logo.js "router.get('/:key'" "GET /api/logo/:key exists"
check server/routes/logo.js "isSafeKey" "keys are validated before touching the filesystem or the database"
check server/routes/logo.js "Cache-Control', 'public, max-age=604800'" "a week-long cache lifetime"
check server/routes/logo.js "req.headers\['if-none-match'\]" "conditional requests answer 304"
check server/routes/logo.js "req.app.locals.ffmpegPath" "downscaling uses the shared ffmpeg path, not a hardcoded one"
check server/routes/logo.js "Unauthenticated on purpose" "with the reasoning for being unauthenticated recorded in the file"
check server/index.js "app.use('/api/logo', require('./routes/logo'))" "the route is actually mounted"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS logo_cache" "the lookup table exists"
check server/services/logoCache.js "function registerLogo" "the registration helper exists"
check server/routes/library.js "applyLogoCache(parsed)" "channels/favourites/recent hand out cached logo paths"
check server/routes/library.js "applyLogoCache(channels)" "and so does the guide"
check server/routes/info.js "logoCache: true" "features flag"
check test/logo-cache.test.js "an unknown key must never reach the network" "with a test that an unregistered key never fetches"
check test/logo-cache.test.js "served from disk, not fetched again" "and that a known key is fetched only once"
check test/library-logos.test.js "0112: every library response now hands out" "and the library tests updated for the new logo shape"

echo "=== 0113: a failed start fails fast, says why, and a refused first connection is retried once ==="
check server/services/transcodeSession.js "if (this.hasFailed())" "waitForPlaylist stops polling once ffmpeg has ended without a playlist"
check server/services/transcodeSession.js "function classifyInputFailure" "ffmpeg's input failure is turned into a client-safe reason"
check server/services/transcodeSession.js "Provider refused the connection; retry" "a retry for a refusal right after the probe, with its log line (two since 0143)"
check server/services/transcodeSession.js "REFUSED_RETRY_WINDOW_MS = 3000" "only within ffmpeg's first ~3 s"
check server/services/transcodeSession.js "status === '404'" "a 404 is never retried"
check server/services/transcodeSession.js "!requested && refused && refused.retryable" "and never for a session we stopped ourselves"
check server/services/playbackStrategy.js "new Error(failure || (ended ? FAILURE_TEXT.couldNotOpen() : FAILURE_TEXT.timeout()))" "resolve's error carries the reason, else a fixed C-B sentence (was the old text until 0118)"
check server/services/playbackStrategy.js "NOT produced - ffmpeg ended after" "the resolve timing line says ffmpeg ended, rather than timed out"
check scripts/playback-report.js "NOT produced - ffmpeg ended" "the playback report counts those"
check_absent scripts/playback-report.js "opt-in" "the report no longer speaks of the opt-in HLS trial"
check_absent scripts/playback-report.js "Against the trial criteria" "nor its criteria block"
check_absent scripts/playback-report.js "HLS Delivery (beta)" "nor the retired toggle"
check test/start-failure.test.js "the old code polled the full 15 s" "with a test that fails on the old code"
check test/start-failure.test.js "two retries, no more" "and a test that the retries stop (twice since 0143)"

echo "=== 0114: channel profiles - a repeat play skips ffprobe ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS channel_profiles" "the profile table exists"
check server/services/channelProfiles.js "PIGTV_PROBE_PROFILES" "with an env switch to turn it off (the rollback)"
check server/services/channelProfiles.js "PIGTV_PROFILE_MAX_AGE_DAYS" "and a configurable age limit"
check server/services/channelProfiles.js "createHash('sha256')" "the key is stored hashed (the URL carries credentials)"
check server/services/playbackStrategy.js "channelProfiles.get(cacheKey)" "resolve looks a profile up under the probe cache's own key"
check server/services/playbackStrategy.js 'probeNote: `profile (age ' "and says so in the resolve timing line (probe profile (age Nd))"
check server/services/playbackStrategy.js "channelProfiles.remove(cacheKey)" "a failed start from a profile drops it"
check server/services/playbackStrategy.js "else channelProfiles.save(cacheKey, info, probedAt)" "a profile is written only once a session has played from it"
check server/services/transcodeSession.js "'-probesize', '5000000'" "ffmpeg's own probe is unchanged (long GOPs need it)"
check server/services/transcodeSession.js "'-analyzeduration', '5000000'" "likewise its analyzeduration"
check scripts/playback-report.js "profile \\\\(age" "the playback report counts a profiled play as warm"
check test/channel-profiles.test.js "the old code probed again once the 5-min cache expired" "with a test that fails on the old code"

echo "=== 0115: frame-rate-aware master playlist for every session ==="
check server/services/streamProbe.js "function frameRateOf" "the probe picks a usable frame rate"
check server/services/streamProbe.js "videoStream?.avg_frame_rate, videoStream?.r_frame_rate" "avg_frame_rate first, then r_frame_rate"
check server/services/streamProbe.js "const MAX_FPS = 240" "and ignores absurd values (the TS clock, 0/0)"
check server/services/playbackStrategy.js "else if (!hdrCopy && frameRate !== null) videoRange = 'SDR'" "every non-HDR session with a usable rate gets an SDR master playlist"
check server/services/playbackStrategy.js "if (hdrCopy && segmentType === 'fmp4') videoRange = info.videoRange" "HDR copy sessions keep PQ/HLG"
check server/services/playbackStrategy.js "width: videoMode === 'copy' ? info.width : 0" "RESOLUTION only when the output is the source's size"
check server/services/transcodeSession.js "const rate = parseFrameRate(fps)" "FRAME-RATE uses the same bounds as the probe"
check_absent server/services/transcodeSession.js "CODECS=" "the master playlist still carries no CODECS"
check server/routes/transcode.js "the session has no master playlist" "the route's 404 no longer assumes HDR"
check_absent public/js/components/VideoPlayer.js "stream.m3u8" "the web player does not assume the media playlist name"
check test/frame-rate-master.test.js "the old code handed out stream.m3u8" "with a test that fails on the old code"

echo "=== 0116: HE-AAC passthrough for clients that can decode it ==="
check server/services/playbackStrategy.js "heaac: false," "heaac is a capability, off by default"
check server/services/playbackStrategy.js "heaacCopy: caps.heaac === true" "resolve tells the session only on an explicit true"
check server/services/streamProbe.js "(!isHeAac || clientCaps.heaac === true)" "the probe counts HE-AAC as decodable only for such a client"
check server/services/transcodeSession.js "const heAacBlocked = isHeAac && this.options.heaacCopy !== true" "the session copies HE-AAC only when told it may"
check server/services/transcodeSession.js "heAacBlocked || (isHeAac && forceEncode)" "and still re-encodes it to AAC-LC otherwise, or when asked to"
check server/services/transcodeSession.js "'-profile:a', 'aac_low'" "the AAC-LC re-encode itself is unchanged"
check_absent public/js/components/VideoPlayer.js "heaac" "the web player never sends heaac (Chrome cannot decode HE-AAC)"
check test/heaac-passthrough.test.js "the old code re-encoded to AAC-LC for every client" "with a test that fails on the old code"

echo "=== 0117: channel numbers (C-A) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS channel_numbers" "the numbering table exists"
check server/db/sqlite.js "number INTEGER NOT NULL UNIQUE" "a number is unique across the server"
check server/services/channelNumbers.js "COALESCE(p.stable_id, p.item_id)" "numbers are keyed on the channel's identity, not its position"
check server/services/channelNumbers.js "RESERVE_MS = 30 \\* 24" "a vanished channel's number is reserved for 30 days"
check server/services/syncService.js "refreshChannelNumbers()" "a completed sync numbers new channels"
check server/routes/channels.js "refreshChannelNumbers()" "and so does a hide/show"
check server/routes/library.js "channelNumbers.ensureChannelNumbers()" "the first library request numbers an empty table"
check_absent server/routes/library.js "GUIDE_NUMBER_KEY" "dead number-keyed cursor code removed in 0164 (numbers are labels only since 0139)"
check server/routes/library.js "number: row.channel_number ?? null" "library rows carry number"
check server/routes/lineup.js "router.use(requireAuth, requireAdmin)" "the lineup API is admin only"
check server/routes/lineup.js "bumpLibraryRev()" "a renumber changes the guide version"
check server/index.js "app.use('/api/lineup', require('./routes/lineup'))" "the lineup route is mounted"
check server/routes/info.js "channelNumbers: true" "features flag"
check test/channel-numbers.test.js "cursor pages give the same rows in the same order as the offset listing" "with a cursor-exactness test"
check test/channel-numbers.test.js "the reorder really moved the position ids" "and a provider-reorder stability test"

echo "=== 0118: resolve errors use the client's allowed wording (C-B) ==="
check server/services/playbackErrors.js "'The provider refused this channel'" "the allow-list is recorded next to the texts"
check server/services/transcodeSession.js "message: FAILURE_TEXT.notFound()" "ffmpeg's 404 uses the shared text"
check_absent server/services/transcodeSession.js "could not find this channel" "the old 404 wording is gone"
check_absent server/services/transcodeSession.js "had a problem serving this channel" "the old 5xx wording is gone"
check_absent server/services/playbackStrategy.js "Transcode failed to produce a playlist in time" "the old timeout wording is gone"
check server/services/playbackStrategy.js "throw Object.assign(new Error(probeFailureMessage(err))" "a failed probe never hands its stderr (with the URL) to the client"
check server/services/providerRouting.js "FAILURE_TEXT.notInPlaylist()" "a channel not in the playlist says 'This channel is not available' (streamUrlForChannel moved in 0174)"
check server/routes/playback.js "const safe = clientSafe(redact(err.message))" "the resolve route strips any URL from what it returns"
check test/resolve-errors.test.js "no URL anywhere in the response" "with a route-level no-URL test"

echo "=== 0119: opaque playback handles (C-D) and redacted logs ==="
check server/services/playbackHandles.js "crypto.randomBytes(16).toString('hex')" "a handle is 32 random hex characters"
check server/services/playbackHandles.js "TTL_MS = 12 \\* 60 \\* 60 \\* 1000" "with a 12 h lifetime"
check server/services/playbackHandles.js "MAX_HANDLES = " "and a bounded registry"
check server/services/playbackStrategy.js "/api/proxy/stream?h=\${playbackHandles.createHandle(url)}" "a direct resolve hands out a handle"
check_absent server/services/playbackStrategy.js "const encoded = encodeURIComponent(url)" "not the provider URL (except under the rollback switch)"
check server/routes/proxy.js "playbackHandles.resolveHandle(req.query.h)" "the proxy accepts ?h="
check server/routes/proxy.js "Unknown or expired playback handle" "an unknown handle is a 404"
check server/routes/proxy.js "h=\${playbackHandles.createHandle(absoluteUrl)}" "a manifest reached by handle hands out handles"
check server/routes/proxy.js "Upstream error for \${redact(url)" "the proxy's upstream-error log is redacted"
check server/routes/proxy.js "HLS manifest from: \${redact(finalUrl)" "and its manifest log"
check server/services/recordingEngine.js "redact((stderrTail || \[\]).slice(-10)" "a failed recording's stored stderr is redacted"
check server/routes/info.js "playbackHandles: true" "features flag"
check test/playback-handles.test.js "the resolve JSON must not contain" "with a no-provider-URL resolve test"

echo "=== 0120: source catalogue for the Sources picker ==="
check server/routes/sources.js "router.get('/:id/catalogue'" "GET /api/sources/:id/catalogue exists"
check server/routes/sources.js "is not supported" "movie/series are refused"
awk '/^router.use\(requireAdmin\);/{a=NR} /router.get\(.\/:id\/catalogue./{c=NR} END{exit !(a && c && a < c)}' server/routes/sources.js \
  && echo "  ✓ the catalogue is declared after router.use(requireAdmin) (admin only)" \
  || { echo "  ✗ MISSING: the catalogue route must come after router.use(requireAdmin)"; FAIL=1; }
check test/source-catalogue.test.js "hidden ones included, in provider order" "with a test"

echo "=== 0121: the web reads /api/library (W2.1) ==="
check public/js/api.js "API.request('GET', '/library/categories')" "api.js has the library helpers"
check public/js/api.js "/sources/\${id}/catalogue?type=live" "and the Sources catalogue"
check public/js/components/ChannelList.js "API.library.allChannels()" "the live sidebar pages /api/library/channels"
check public/js/components/ChannelList.js "API.library.favourites()" "and reads /api/library/favourites"
check public/js/components/ChannelList.js "window.app.player.play(channel, null)" "and plays by channel identity, never a stream URL"
check public/js/components/EpgGuide.js "API.library.guide({ start, end, limit: 500, cursor })" "the guide pages /api/library/guide with a cursor"
check public/js/components/SourceManager.js "API.sources.catalogue(sourceId)" "the Sources picker reads the catalogue"
check public/js/pages/HomePage.js "window.API.library.favourites()" "the Home favourites row reads /api/library/favourites"
for f in public/js/components/ChannelList.js public/js/components/EpgGuide.js public/js/components/SourceManager.js public/js/components/VideoPlayer.js public/js/pages/LivePage.js public/js/pages/Guide.js; do
    check_absent "$f" "/proxy/xtream\|/proxy/epg\|API\.proxy" "$f no longer calls the Xtream-emulation or whole-EPG routes"
done
check_absent public/index.html "content-type-movies" "the picker's movie/series tabs are gone"
check_absent public/js/components/VideoPlayer.js "!this.currentStreamUrl" "recovery replays a channel by identity, without a stream URL"
check test/web-library.test.js "no live-TV script still calls the Xtream-emulation or whole-EPG proxy routes" "with a test"

echo "=== 0122: the fork's leftovers removed (W2.1) ==="
for f in public/js/pages/MoviesPage.js public/js/pages/SeriesPage.js public/js/pages/WatchPage.js \
         server/services/cache.js server/plugins server/routes/history.js server/routes/probe.js server/routes/subtitle.js; do
  if [ -e "$f" ]; then echo "  ✗ MISSING: $f should have been deleted"; FAIL=1; else echo "  ✓ $f is gone"; fi
done
if grep -rn "services/cache'\|routes/history'\|routes/probe'\|routes/subtitle'\|MoviesPage\|SeriesPage\|WatchPage" server public scripts --include=*.js --include=*.html | grep -q .; then
  echo "  ✗ MISSING: something still loads a deleted file"; FAIL=1
else
  echo "  ✓ nothing loads them"
fi
check_absent server/index.js "loadPlugins" "no plugin loader"
check_absent server/index.js "Object.freeze(services)" "no services map for plugins"
check_absent server/routes/proxy.js "router.get('/xtream" "no Xtream-emulation routes"
check_absent server/routes/proxy.js "router.get('/image'" "no open image passthrough"
check_absent server/routes/proxy.js "router.get('/m3u/" "no /m3u"
check_absent server/routes/proxy.js "pluto" "no Pluto header special case"
check_absent server/routes/transcode.js "router.post('/session'" "no POST /api/transcode/session"
check_absent server/routes/channels.js "router.get('/recent'" "no /api/channels/recent (movie/series only)"
check_absent public/index.html 'data-page="movies"' "no Movies nav entry"
check_absent public/index.html 'data-page="series"' "no Series nav entry"
check_absent public/index.html 'id="page-watch"' "no VOD watch page markup"
check_absent public/css/main.css ".movie-card" "no movie/series CSS"
check_absent public/js/api.js "proxy: {" "api.js has no proxy helpers"
check test/api-404.test.js "the removed fork routes answer the generic 404, even with a token" "with a test that they 404"
check test/api-404.test.js "nothing in the web app still calls a removed route" "and that nothing in public/ calls them"

echo "=== 0123: channel-number editor (Settings -> Channel numbers) ==="
check public/index.html 'data-subtab="lineup"' "the Settings view exists (under Channels, 0182)"
check public/index.html 'id="lineup-list"' "with its list"
check public/js/api.js "API.request('PUT', '/lineup/numbers', { numbers })" "api.js saves through PUT /api/lineup/numbers"
check public/js/pages/Settings.js "API.lineup.get()" "the panel reads GET /api/lineup"
check public/js/pages/Settings.js "if (panel === 'lineup') this.loadLineup();" "and loads when the panel opens"
check public/js/pages/Settings.js "this.setLineupStatus(err.message" "the server's validation error is shown"
check test/lineup-editor.test.js "validation error as it comes" "with a test"

echo "=== 0124: admin status page (W2.2) ==="
check server/index.js "app.use('/api/status', require('./routes/status'))" "GET /api/status is mounted"
check server/routes/status.js "router.use(requireAuth, requireAdmin)" "and is admin only"
check server/routes/status.js "res.json(scrubUrls(status))" "the whole document is scrubbed of anything URL-shaped"
check_absent server/routes/status.js "url: summary.url" "a session's URL is never passed through"
check server/services/playbackEvents.js "const MAX_EVENTS = 50" "the recent-plays buffer is bounded"
check server/routes/playback.js "playbackEvents.record({ type: 'play-start'" "play-start feeds it"
check server/routes/playback.js "playbackEvents.record({ type: 'failure', owner: eventOwner, channel: eventChannel, reason: safe, provider })" "a failed resolve feeds it with the client-safe text (and, 0174, the provider's name)"
check server/services/playbackStrategy.js "playbackEvents.noteResolve(owner, { start:" "resolve notes cold/warm/profile"
check public/js/pages/StatusPage.js "setInterval(() => this.refresh(), this.refreshMs)" "the page refreshes while shown"
check public/index.html 'data-page="status"' "with an admin nav entry"
check test/status.test.js "never a provider URL" "with a no-URL test"
check test/status.test.js "keeps the last 50" "and a buffer-bound test"

echo "=== 0125: HTML is revalidated after a redeploy ==="
check server/index.js "setHeaders: noCacheHtml" "static HTML is served no-cache"
check test/html-no-cache.test.js "no-cache" "with a test"

echo "=== 0126: the tuner model, T1 (PIGTV_TUNER=1, off by default) ==="
check server/services/tuner.js "PIGTV_TUNER" "the tuner model is behind PIGTV_TUNER"
check server/services/transcodeSession.js "return \[...this.buildSourceArgs(), ...this.buildHlsOutputArgs()\];" "sessions build source + HLS output arguments"
check server/services/tuner.js "return \[...this.buildSourceArgs(), ...this.buildTunerOutputArgs()\];" "a tuner runs the very same source arguments"
check_absent server/services/tuner.js "'independent_segments+delete_segments" "a tuner's ffmpeg never deletes segments (the server keeps the window)"
check server/services/hlsPlaylist.js "#EXT-X-PROGRAM-DATE-TIME:" "the server's playlist carries a date per segment"
check server/routes/playback.js "require('../services/tuner').enabled()" "resolve takes the tuner path only when it is on"
check server/routes/playback.js "tuner.enabled() && await tuner.releaseViewer(sessionId)" "DELETE releases only the viewer"
check server/services/streamCoordinator.js "function requestForTuner" "the coordinator counts tuners"
check server/services/streamCoordinator.js "if (key && tunerModule().findByKey(key)) return { allowed: true, release: \[\], join: true };" "a matching running tuner is joined without a slot"
check server/services/playbackStrategy.js "reanalyzeForCaps(running.info, url, caps)" "a second viewer is never probed while a tuner reads the stream"
check server/routes/transcode.js "if (tuner.enabled()) tuner.startSweep();" "the tuner idle sweep runs only when the tuner is on"
check test/tuner-args.test.js "buildFFmpegArgs produces exactly the 0125 arguments for every option set" "argument equality proved against the 0125 golden file"
check test/tuner.test.js "two devices on the same channel share one tuner" "with a one-spawn test"
check test/tuner.test.js "409 at the limit of 1" "a 409 test for different arguments"
check test/tuner-off.test.js "off by default" "and an env-off test"

echo "=== 0127: the tuner model, T2 - recordings take segments from a tuner ==="
check server/services/recordingEngine.js "if (tunerModel.enabled()) return startTunedRecording(schedule, knownUrl);" "a recording uses a tuner only when the tuner is on"
check server/services/recordingEngine.js "requestForRecordingTuned(schedule, settings, url)" "the coordinator lets a recording share the channel's tuner"
check server/services/playbackStrategy.js "const running = tuner.findByUrl(url);" "a recording joins any tuner already on its channel"
check server/services/hlsRecorder.js "playlistType: this.finished ? 'VOD' : 'EVENT'" "EVENT while recording, VOD when done"
check server/services/hlsRecorder.js "await fs.link(from, to);" "segments are hard-linked where the volume allows"
check server/services/recordingEngine.js "const args = buildNativeRemuxArgs(index, partial, codecs);" "the finished recording is joined with the stream-copy remux arguments"
check server/services/recordingEngine.js "rel.split(path.sep).length !== 2" "deleting only ever removes a <root>/<channel>/<recording> folder"
check server/db/recordingsDb.js "AND file_path NOT LIKE '%.m3u8'" "ad detection and compression wait for the joined MP4"
check server/db/recordingsDb.js "require('../services/tuner').enabled() ? \['format TEXT', 'hls_dir TEXT'\]" "the new columns appear only once the tuner is used"
check server/routes/recordings.js "router.get('/:id/index.m3u8'" "GET /api/recordings/:id/index.m3u8"
check server/routes/recordings.js "container: 'hls'," "the playback answer for an HLS recording"
check server/routes/info.js "recordingHls: true" "flag recordingHls"
check test/api-404.test.js "\['GET', '/api/recordings/1/index.m3u8'\]" "the new Apple routes are in APPLE_CLIENT_ROUTES"
check test/tuner-recordings.test.js "watching and recording one channel is one tuner" "with a shared-tuner test"
check test/tuner-off.test.js "off: /api/info carries none of the tuner flags" "and the flags are absent when off"

echo "=== 0128: the tuner model, T3 - timeshift ==="
check server/services/tuner.js "PIGTV_TIMESHIFT_HOURS" "the window is PIGTV_TIMESHIFT_HOURS"
check server/services/tuner.js "PIGTV_TIMESHIFT_MIN_FREE_GB" "with a free-space floor"
check server/services/tuner.js "const TIMESHIFT_DIR = '.timeshift';" "on the recordings volume, not the tmpfs"
check server/services/tuner.js "while (freed < needBytes && this.window.length > ts.HLS_LIST_SIZE)" "the floor never trims below the 0126 window"
check server/services/tuner.js "return 6 \* Math.max(this.targetDuration, ts.SEGMENT_DURATION);" "CAN-SKIP-UNTIL is six target durations"
check server/services/hlsPlaylist.js "#EXT-X-SKIP:SKIPPED-SEGMENTS=" "delta updates answer _HLS_skip=YES"
check server/routes/transcode.js "return v === 'YES' || v === 'v2';" "the playlist route passes _HLS_skip on"
check server/services/compressionFilter.js "return type === PLAYLIST_TYPE;" "gzip for tuner playlists only"
check_absent server/services/compressionFilter.js "'video/mp2t'" "never for segments"
check server/index.js "sweepOrphanedTimeshift(settings.recordingsPath)" "orphaned timeshift directories are removed at startup"
check server/routes/info.js "timeshiftEnabled() ? { timeshift: true }" "flag timeshift"
check test/tuner-timeshift.test.js "below the free-space floor" "with a free-space test"
check test/tuner-timeshift.test.js "leaves out exactly what precedes the Skip Boundary" "a delta-playlist test"
check test/tuner-timeshift.test.js "playlists may be gzipped, segments never" "and a gzip test"

echo "=== 0129: the tuner model, T4 - watch while recording ==="
check server/services/hlsPlaylist.js "#EXT-X-START:TIME-OFFSET=" "a playlist can say where to start"
check server/services/hlsRecorder.js "startOffset: 0" "a recording plays from its start, also while it records"
check server/services/recordingEngine.js "async function waitForFirstTunedSegment" "Play on a just-started recording waits for its first segment"
check server/routes/recordings.js "if (inProgress) await recordingEngine.waitForFirstTunedSegment(rec.id);" "in the playback answer"
check server/routes/recordings.js "if (rec.status === 'recording') await recordingEngine.waitForFirstTunedSegment(rec.id);" "and the playlist"
check test/tuner-recordings.test.js "T4: an in-progress recording plays from its start" "with a lifecycle test"

echo "=== 0130: a recording's own tuner uses the Apple TV's default capabilities ==="
check_absent server/services/playbackStrategy.js "ac3: true, eac3: true, flac: false, heaac: true" "no heaac in RECORDING_CAPABILITIES"
check test/tuner-recordings.test.js "0130: an Apple TV tuning to an HE-AAC channel that is being recorded joins" "with a test"

echo "=== 0131: a recording lets go of a tuner that died ==="
check server/services/recordingEngine.js "tunerModel.unhold(t, holdKey(scheduleId)).catch(() => {});" "the hold is released when the tuner ends"
check server/services/streamCoordinator.js "take(slots.filter(s => s.dead), 'ended');" "a dead tuner never counts as a slot"
check test/tuner-recordings.test.js "0131: a recording whose tuner dies lets go of it" "with a re-tune test"

echo "=== 0132: timeshift can live on a local disk ==="
check server/services/tuner.js "PIGTV_TIMESHIFT_DIR" "the timeshift folder is configurable"
check test/timeshift-dir.test.js "PIGTV_TIMESHIFT_DIR" "with a test"

echo "=== 0133: channel health (C-G) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS channel_health" "one row per start attempt"
check server/services/channelHealth.js "const KEEP_MS = 30 \* DAY_MS;" "kept 30 days"
check server/services/channelHealth.js "const WINDOW_MS = 7 \* DAY_MS;" "health over the last 7 days"
check server/index.js "require('./services/channelHealth').startPruneTimer();" "pruned at startup and daily"
check server/routes/playback.js "channelHealth.recordResolve({ sourceId: req.body?.sourceId" "a failed resolve is a failed start"
check server/routes/playback.js "channelHealth.clientFailed(eventOwner);" "a player error before play-start is a failed start"
check server/routes/playback.js "channelHealth.clientStarted(owner, sec(body.totalMs));" "play-start gives the first-picture time"
check server/routes/library.js "channelHealth.applyHealth(channels);" "health on guide and channels rows"
check server/routes/info.js "channelHealth: true" "flag channelHealth"
check server/routes/status.js "leastReliable: leastReliable()," "the status document lists the least reliable channels"
check public/js/pages/StatusPage.js "Least reliable channels" "and the web Status page shows them"
check test/channel-health.test.js "the thresholds: flaky at 2 failed starts" "with a threshold test"
echo "=== 0134: EPG matching (S4.2) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS epg_mappings" "mappings in their own table, which no sync writes"
check_absent server/services/syncService.js "epg_mappings" "the sync never touches the mappings"
check server/routes/library.js "tvgId = epgMapping.effectiveTvgId(row.source_id, row.stable_id, row.item_id, tvgId);" "the guide uses the mapped tvg-id"
check server/routes/library.js "const tvgId = epgMapping.effectiveTvgId(row.source_id, row.stable_id, row.item_id," "and so do now/next and the logo fallback"
check server/services/epgMapping.js "bumpLibraryRev();" "a mapping moves the guide version"
check server/index.js "app.use('/api/epg', require('./routes/epg'));" "the EPG admin routes are mounted"
check server/routes/epg.js "router.use(requireAuth, requireAdmin);" "admin only"
check server/routes/epg.js "router.put('/mapping'" "PUT /api/epg/mapping"
check server/routes/epg.js "router.get('/unmatched'" "GET /api/epg/unmatched"
check public/index.html 'data-subtab="epg">EPG matching' "Settings has an EPG matching view (under Channels, 0182)"
check public/js/pages/Settings.js "async loadEpgMatching()" "which loads the unmatched list"
check test/epg-matching.test.js "the mapping survives a playlist sync" "with a sync-survival test"

echo "=== 0135: sources, settings and users in SQLite (S4.3a) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS app_settings" "settings table"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS app_sources" "sources table"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS app_users" "users table"
check server/db.js "fs.renameSync(legacyPath, migratedPath);" "db.json is migrated once and kept as db.json.migrated"
check server/db.js "if (metaGet(db, 'app_data_migrated'))" "and never merged in twice"
check_absent server/db.js "structuredClone" "no clone of the store on reads"
check server/db.js "if (!settingsCache) settingsCache = deepFreeze(" "settings.get() hands out one frozen object"
check server/routes/playback.js "const settings = { ...(await db.settings.get()), ffmpegPath:" "the resolve route copies before adding to it"
check scripts/stream-doctor.js "SELECT value FROM app_settings WHERE key = ?" "stream-doctor reads the user agent from SQLite"
check test/db-sqlite-store.test.js "the hot path: settings.get() hands out one frozen object and never clones it" "with a hot-path test"
check test/db-sqlite-store.test.js "the first start migrates a sample db.json" "and a migration test"

echo "=== 0136: auth without passport (S4.3b) ==="
check_absent package.json '"passport' "no passport packages in package.json"
check_absent package-lock.json '"node_modules/passport' "nor in the lockfile"
check_absent server/index.js "passport" "no passport middleware"
check_absent server/routes/playback.js "require('passport')" "the playback route's optional auth is ours"
check server/auth.js "payload = jwt.verify(token, JWT_SECRET);" "bearer tokens are verified with jsonwebtoken directly"
check server/auth.js "const user = await lookupById(payload.id);" "the user (and role) comes from the store"
check server/auth.js "if (!deviceAuth.isDeviceValid(payload.deviceId)) return null;" "revoked devices are refused"
check server/routes/auth.js "auth.authenticateCredentials(req.body)" "sign-in checks the password itself (bcrypt)"
check test/auth-direct-jwt.test.js "passport is gone: not a dependency, not exported" "with a test"

echo "=== 0137: Express 5 (S4.3c) ==="
check package.json '"express": "^5.' "express 5"
check server/index.js "app.get('/{\*splat}'" "the SPA fallback uses Express 5 wildcard syntax"
check_absent server/index.js "app.get('\*'" "not the Express 4 '*'"
check server/index.js "if (req.body === undefined) req.body = {};" "a request without a JSON body still has req.body"
check server/index.js "app.set('query parser', 'extended');" "query strings parsed as under Express 4"
check server/index.js "app.listen(PORT, async (err) => {" "a listen failure is handled (Express 5 passes it to the callback)"
check server/routes/transcode.js "res.sendFile(segmentPath, { dotfiles: 'allow' });" "segments under .timeshift are served"
check server/routes/recordings.js "res.sendFile(file, { dotfiles: 'allow' });" "and recording segments"
check test/express5.test.js "a port already in use stops the server" "with a test against the real server"

echo "=== 0138: carried-over small items ==="
check server/routes/info.js "await sendInfo(req, res);" "/api/info answers even when something inside fails"
check server/routes/info.js "...safely(() => (require('../services/tuner').timeshiftEnabled()" "a failing feature check drops only its flag"
check server/db/sqlite.js "function stripStoredBadges()" "stored badges are stripped once"
check server/db/sqlite.js "SELECT 1 FROM meta WHERE key = 'badge_cleanup'" "and only once"
check server/services/syncService.js "name = stripBadgeSuffix(item.name)" "the Xtream ingest path strips the badge"
check server/routes/recordings.js "const suffix = parseInt(parts\[1\], 10);" "a suffix Range is served"
check test/carried-over-0138.test.js "the EPG parser loses nothing under bursty input" "P2-8: EPG parser under bursty input"
check test/carried-over-0138.test.js "carries the token onto init.mp4 and every .m4s" "P2-8: the token on fMP4 segments"
check test/carried-over-0138.test.js "a recording answers Range requests" "P2-8: recordings Range"
check test/playback-arbitration.test.js "a device changing channel replaces its own old stream without a prompt" "P2-8: the slot holder re-resolving (existing test)"

echo "=== 0139: channel numbers are labels; the guide keeps the provider's order ==="
check_absent server/routes/library.js "const numbered = false" "dead numbered variable removed in 0164 (kept guide in provider order per 0139)"
check test/channel-numbers.test.js "numbers never reorder the guide" "with a test"

echo "=== 0140: a deploy refreshes cached guides once ==="
check server/services/libraryRev.js "build}:\${rev}" "the guide version includes the build"

echo "=== 0141: logos keep their transparency ==="
check server/routes/logo.js "format=rgba,scale='min(\${maxWidth},iw)':-1,format=rgba" "the downscale converts through rgba (a palette PNG lost its transparency)"
check server/routes/logo.js "'-pix_fmt', 'rgba'" "and writes an rgba PNG"
check server/routes/logo.js "if (width !== null && width <= maxWidth) return original;" "a small logo is stored as it came"
check server/routes/logo.js "function ensureCacheVersion()" "stored logos from an older version are dropped once"
check server/services/logoCache.js "update(\`v\${LOGO_CACHE_VERSION}|\${url}\`)" "the cache version is in the key (new paths for clients)"
check test/logo-alpha.test.js "PNG is downscaled with its transparency intact" "with a test per image kind"

echo "=== 0142: stalls count towards channel health ==="
check server/routes/playback.js "channelHealth.clientEnded(owner, body.watchedSec, body.stalls);" "play-end feeds its stalls into channel health"
check server/db/sqlite.js "ALTER TABLE channel_health ADD COLUMN" "attempts carry stalls and watched time"
check server/services/channelHealth.js "stalls / (watchedSec / 3600) >= FLAKY_STALLS_PER_HOUR" "stalls can make a channel flaky"
check server/services/channelHealth.js "e.stalls / (Math.max(e.watched, RANK_MIN_WATCH_SEC) / 3600)" "the list ranks by failed starts + stalls per hour"
check public/js/pages/StatusPage.js "'Stalls', 'Watched'" "the Status page shows stalls and minutes watched"
check test/channel-health.test.js "a channel that only stalls is listed" "with a test"

echo "=== 0143: a refused reconnect gets two retries ==="
check server/services/transcodeSession.js "REFUSED_RETRY_DELAYS_MS = \[1500, 3000\]" "two retries, 1.5 s then 3 s"
check server/services/transcodeSession.js "this.retryAllowanceMs = (this.retryAllowanceMs || 0) + sinceSpawn + delay;" "the resolve's wait is extended by exactly the retries"
check test/start-failure.test.js "gets a second retry after 3 s more" "with a test"

echo "=== 0144: a finite source starts with an 8 s burst, then real time ==="
check server/services/transcodeSession.js "\['-readrate', '1', '-readrate_initial_burst', String(burst)\] : \['-re'\]" "-readrate 1 -readrate_initial_burst N (ffmpeg 6.1+), PIGTV_READRATE_BURST=0 is -re"
check server/services/transcodeSession.js "if (this.options.paceInput === true) args.push(...paceArgs());" "only for a source that ends"
check server/services/playbackStrategy.js "after an initial \${b}s burst" "the resolve timing line says so"
check test/hls-finite-source.test.js "PIGTV_READRATE_BURST=0 goes back to -re" "with a test for the rollback"

echo "=== 0145: the playback report shows the client wait ==="
check scripts/playback-report.js "clientWaitSec: wait !== null && wait >= 0" "client wait = first picture minus resolve, per play"
check scripts/playback-report.js "Where the time goes" "a per-path median / p90 table"
check test/playback-report.test.js "0145: the client wait (first picture minus resolve) per path" "with a test"

echo "=== 0146: sport categories (C-H) ==="
check server/routes/info.js "sportCategories: true" "/api/info advertises sportCategories"
check server/routes/library.js "sport: sportCategories.isSport(r.source_id, r.category_id)" "library/categories rows carry sport"
check server/routes/library.js "router.put('/categories/sport', requireAdmin," "admins mark a category"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS sport_categories" "stored in a table no sync writes"
check server/services/sportCategories.js "if (changed) bumpLibraryRev();" "a change moves the guide version"
check public/js/components/SourceManager.js "sportToggleHtml(group)" "the web Sources picker has a Sport toggle"
check test/sport-categories.test.js "a playlist sync keeps the marks" "with a test"

echo "=== 0147: EPG programme categories stored (C-I) ==="
check server/db/sqlite.js "ALTER TABLE epg_programs ADD COLUMN categories TEXT" "epg_programs has a categories column"
check server/db/sqlite.js "p.description, p.data, p.categories" "epg_live exposes it"
check server/db/sqlite.js "db.exec('DROP VIEW epg_live')" "an older epg_live view is made again"
check server/services/syncService.js "categoriesJson(p.category)" "the sync stores what the parser collected"
check server/index.js "app.use('/api/sports', require('./routes/sports'))" "the sports routes are mounted"
check server/routes/sports.js "router.get('/categories', requireAdmin," "admin GET /api/sports/categories"
check public/js/pages/StatusPage.js "this.loadEpgCategories();" "the Status page shows the EPG categories"
check test/epg-categories.test.js "the Xtream path (xmltv.php) stores them too" "with a test"
python3 - <<'PY2' || FAIL=1
import sys
s = open('server/db/sqlite.js').read()
if not (s.index('ADD COLUMN categories') < s.index("DROP VIEW epg_live") < s.index('CREATE VIEW IF NOT EXISTS epg_live')):
    print("  ✗ the column and the view drop must come before the view is created"); sys.exit(1)
print("  ✓ the column is added, and a stale view dropped, before epg_live is created")
PY2

echo "=== 0148: sport events and the follow list (C-I) ==="
check server/routes/info.js "sportsEvents: true" "/api/info advertises sportsEvents"
check server/routes/sports.js "router.get('/events', (req, res)" "GET /api/sports/events for any signed-in user"
check server/routes/sports.js "router.get('/preview', requireAdmin," "admin preview"
check server/routes/sports.js "router.put('/follow', requireAdmin," "admin follow list"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS sports_follow" "the follow list has its own table"
check server/services/sportsEvents.js "WHERE \${VISIBLE_SQL}" "only visible channels"
check server/services/sportsEvents.js "sportCategories.isSport(r.source_id, r.category_id)" "the C-H mark is one signal"
check server/services/sportsEvents.js "return { bucket, key: \`\${currentGuideVersion()}|\${followVersion}|\${bucket}\` };" "built once per guide version, follow list and minute"
check server/services/sportsEvents.js "FROM epg_live" "reads the live generation"
check_absent server/services/sportsEvents.js "FROM epg_programs" "never the raw table"
check test/api-404.test.js "\['GET', '/api/sports/events'\]" "the Apple client's new route is guarded"
check test/sports-events.test.js "the same game on three channels is one event" "with a test"

echo "=== 0149: web Settings -> Sports (C-I) ==="
check public/index.html 'data-tab="sports">Sports</button>' "a Sports tab"
check public/index.html 'id="sports-preview-list"' "with the preview table"
check public/js/pages/Settings.js "if (panel === 'sports') this.loadSports();" "loaded when the tab opens"
check public/js/pages/Settings.js "await this.loadSportsPreview();" "the preview reloads after a save"
check public/js/api.js "setFollow: (keywords) => API.request('PUT', '/sports/follow', { keywords })" "saves the follow list"
check_absent public/js/components/SourceManager.js "Sport on now row" "the Sport toggle no longer promises the old Home row"
check test/sports-settings.test.js "the preview reloads after a save" "with a test"

echo "=== 0150: sport programme kinds and merging by meaning (C-I) ==="
check server/services/sportsClassify.js "function classifyKind(" "each programme has a kind"
check server/services/sportsClassify.js "\['F1', \['f1', 'formula 1', 'formula one'" "F1 and Formula 1 are one league"
check server/services/sportsClassify.js "\['AFLW', \['aflw', 'womens afl'" "AFLW is its own league, looked for before AFL"
check server/services/sportsClassify.js "function loopedProgrammes(" "loop channels are detected"
check server/services/sportsClassify.js "function mergeAirings(" "listings merge by meaning"
check server/services/sportsEvents.js "const looped = sportsClassify.loopedProgrammes(progs);" "loop detection runs once per build"
check server/services/sportsEvents.js "const DEFAULT_KINDS = new Set(\['event', 'replay'\]);" "events and replays by default"
check server/routes/sports.js "req.query.include === 'all'" "include=all for every kind"
check server/routes/sports.js "withRule: true, include: 'all'," "the preview shows every kind"
check_absent server/services/sportsEvents.js "if (EXCLUDE_RE.test(text) || categories.some" "non-events are classified, not dropped"
check test/fixtures/sports-export.json "NO EVENT STREAMING" "Mark's export is a fixture"
check test/sports-classify.test.js "after merging, one event per game" "with a test"

echo "=== 0151: web Settings -> Sports preview grouped by kind ==="
check public/js/pages/Settings.js "this.sportsOpenKinds = new Set(\['event', 'replay'\]);" "events and replays open, the rest collapsed"
check public/js/pages/Settings.js "\['placeholder', 'Placeholders'\]" "grouped by kind"
check public/js/pages/Settings.js "guide title" "the merged guide titles are listed"
check test/sports-settings.test.js "the preview groups by kind" "with a test"

echo "=== 0152: live or replay from flags, the first airing and league hours (C-I) ==="
check server/services/epgParser.js "const PROGRAMME_FLAGS = { 'previously-shown': 1, premiere: 2, new: 4, live: 8 };" "the parser collects previously-shown, premiere, new and live"
check server/services/syncService.js "p.flags || null" "the sync stores them"
check server/db/sqlite.js "ALTER TABLE epg_programs ADD COLUMN flags INTEGER" "epg_programs has a flags column"
check server/db/sqlite.js "p.categories, p.flags" "epg_live exposes it (an older view is made again)"
check server/services/sportsClassify.js "function resolveLive(airings, fixturesByLeague, now" "live or replay across a game's airings"
check server/services/sportsClassify.js "MLB: US_EVENING," "a per-league table of live hours"
check server/services/sportsEvents.js "all(...chunk, from - LOOKBACK_MS, to)" "a build reads the 36 h before now"
check server/services/sportsEvents.js "sportsClassify.resolveLive(airings, fixturesByLeague);" "and decides live or replay before merging"
check test/sports-live.test.js "MLB 7 am case" "with a test"
python3 - <<'PY3' || FAIL=1
import sys
s = open('server/db/sqlite.js').read()
if not (s.index('ADD COLUMN flags') < s.index("DROP VIEW epg_live") < s.index('CREATE VIEW IF NOT EXISTS epg_live')):
    print("  ✗ the flags column and the view drop must come before the view is created"); sys.exit(1)
print("  ✓ the flags column is added, and a stale view dropped, before epg_live is created")
PY3

echo "=== 0153: the sport horizon is a whole weekend (C-I) ==="
check server/services/sportsEvents.js "const MAX_HOURS = 72;" "hours up to 72"
check server/services/sportsEvents.js "const DEFAULT_HOURS = 6;" "the default stays 6 for older clients"
check server/services/sportsEvents.js "const WINDOW_MS = 72 \* HOUR_MS + BUILD_EVERY_MS;" "a build covers 72 h plus its 5 minutes"
check server/services/sportsEvents.js "Math.floor(now / BUILD_EVERY_MS) \* BUILD_EVERY_MS" "and is kept 5 minutes"
check server/routes/sports.js "hours: sportsEvents.MAX_HOURS" "the preview covers the same 72 h"
check server/services/syncService.js "console.log(epgCoverageLine(lastStop));" "the sync logs how far ahead the guide reaches"
check public/index.html "Recognised in the next 72 hours" "the web preview says so"
check test/sports-events.test.js "1,000 channels x 108 hours" "with a test"

echo "=== 0154: full-resolution logos for the Top Shelf ==="
check server/routes/logo.js "const SIZES = { full: '.orig', 640: '.640' };" "?size=full and ?size=640 beside the default copy"
check server/routes/logo.js "fs.writeFileSync(logoFile(row.key, SIZES.full), fetched);" "the original is kept at fetch"
check server/routes/logo.js "return res.status(400).json({ error: 'size must be full or 640' });" "any other size is refused"
check server/routes/logo.js "original_type = NULL, original_bytes = NULL" "a cache-version change clears the originals too"
check server/db/sqlite.js "'original_type TEXT', 'original_bytes INTEGER'" "logo_cache records the original"
check test/logo-sizes.test.js "answers the original bytes" "with a test"

echo "=== 0155: a viewer joins a running tuner whose output it can play ==="
check server/services/playbackStrategy.js "let compatible = joined ? null : findCompatibleTuner(tuner, url, caps, { upscale, audioEncode });" "an exact key first, then a compatible tuner"
check server/services/playbackStrategy.js "joined compatible tuner" "logged with what the viewer wanted"
check server/services/playbackStrategy.js "plan = tunerPlan(t);" "the answer describes the joined tuner's output"
check server/services/playbackStrategy.js "case 'heaac': return caps.heaac === true;" "copied HE-AAC only for a client that decodes it"
check server/services/tuner.js "this.output = describeOutput(args, this.options);" "a tuner knows what it writes"
check_absent server/services/playbackStrategy.js "ac3: true, eac3: true, flac: false, heaac: true" "RECORDING_CAPABILITIES still without heaac"
check test/tuner-recordings.test.js "0155: an Apple TV (heaac: true) joins a recording" "with a test"

echo "=== 0156: schedule observability and recent problems ==="
check server/services/recordingEngine.js "function setScheduleStatus(schedule, status, extra = {})" "one log line per actual status change, centralised"
check_absent server/services/recordingEngine.js "scheduledDb.setStatus(schedule.id, 'missed'" "the missed paths go through it too, not straight to the db"
check server/db/recordingsDb.js "findRecentProblems(sinceMs)" "missed/failed schedules stay queryable"
check server/routes/recordings.js "const includeRecent = req.query.include === 'recent';" "?include=recent on the existing route, not a new path"
check server/routes/info.js "scheduleHistory: true" "advertised as a feature flag"
check public/js/pages/RecordingsPage.js "renderRecentProblems(items)" "the web Recordings page has a Recent problems section"
check server/routes/status.js "recentProblems: recentProblems()" "and so does the Status document"
check test/recordings-observability.test.js "scheduled -> missed (was silent)" "with a test"

echo "=== 0157: the recordings folder is checked for real (missing, not writable, an unmounted share, low space) ==="
check server/services/recordingsFolder.js "function checkRecordingsFolder(dir, minFreeGB = 10)" "a pure(ish) checker, freeBytes/totalBytes and a problem code"
check server/services/recordingsFolder.js "const TINY_FS_BYTES = 1 \* GB;" "an unmounted share reads as a filesystem too small to be real"
check server/services/recordingEngine.js "checkFolderHealthNow().catch" "checked at startup"
check server/services/recordingEngine.js "const FOLDER_HEALTH_INTERVAL_MS = 15 \* 60 \* 1000;" "and every 15 minutes"
check server/services/recordingEngine.js "if (!fs.existsSync(parent)) {" "getRecordingsRoot only creates the final folder when its parent exists"
check server/routes/status.js "recordingsFolder: recordingsFolderHealth()" "exposed on /api/status"
check public/js/pages/StatusPage.js "renderRecordingsFolderWarning(folder)" "and shown as a warning banner on the web Status page"
check server/routes/settings.js "validateRecordingsPathSetting(updates.recordingsPath.trim());" "a bad recordingsPath is refused with 400, not saved silently"
check test/recordings-folder.test.js "unmounted network share" "with a test"

echo "=== 0158: an unanswered recording prompt no longer blocks a recording forever ==="
check server/services/streamCoordinator.js "const DEFAULT_PROMPT_TIMEOUT_MIN = 3;" "a default timeout, 3 minutes"
check server/services/streamCoordinator.js "if (now - existing.dueSince >= timeoutMs) {" "counted from dueSince, not the early announceUpcoming notice"
check server/services/streamCoordinator.js "dueSince: null, declinedAt: null, schedule });" "announceUpcoming leaves dueSince unset"
check server/services/streamCoordinator.js "No answer from the viewer in \${Math.round(timeoutMs / 60000)} min; recording #\${schedule.id} takes the stream" "logged, classic path"
check server/services/streamCoordinator.js "tuner.destroyTuner(s.tuner, 'no answer from the viewer; a recording needs the stream')" "and the tuner path takes over the same way"
check server/db.js "recordingPromptTimeoutMin: 3" "a settings default"
check public/index.html "dvr-setting-prompt-timeout" "and a web Settings field"
check test/recording-prompt-timeout.test.js "it waits, however long" "with a test"

echo "=== 0159: sport events are built off the request path (stale-while-revalidate) ==="
check server/services/sportsEvents.js "if (cache \&\& buildInFlight === key) return cache.built;" "a request is served the previous result while a background rebuild runs"
check server/services/sportsEvents.js "function scheduleRebuild(now = Date.now(), decorateChannels = lastDecorateChannels) {" "the rebuild itself runs off the request path (setImmediate)"
check server/services/sportsEvents.js "function armRebuildTimer()" "a timer aligned to the 5-minute bucket"
check server/services/syncService.js "require('./sportsEvents').scheduleRebuild();" "triggered after an EPG sync"
check server/services/sportsEvents.js "rebuild in the background rather than leaving it for the next request" "and when the follow list changes"
check server/index.js "require('./services/sportsEvents').startBackgroundRebuilds();" "started at server startup"
check test/sports-background-rebuild.test.js "served the previous result, not a blocking rebuild" "with a test"

echo "=== 0161: cricket league recognition, ESPN fixtures, the ESPN live/replay rule (C-I) ==="
check server/services/sportsClassify.js "\['IPL', \['ipl', 'indian premier league'\]\]" "IPL is its own league"
check server/services/sportsClassify.js "\['Cricket', \['test cricket'" "international cricket (Test/ODI/T20I) has a catch-all league"
check server/services/sportsFixturesEspn.js "const BASE = 'https://site.api.espn.com/apis/site/v2/sports';" "the ESPN provider, fetch only"
check server/services/sportsFixturesEspn.js "async function discoverCricketSeries(" "international cricket series are discovered from the scorepanel"
check server/services/sportsFixtures.js "process.env.PIGTV_SPORT_FIXTURES !== '0'" "PIGTV_SPORT_FIXTURES=0 turns it off"
check server/services/sportsFixtures.js "function neededLeagues(" "only the leagues that matter are fetched"
check server/services/sportsFixtures.js "const REFRESH_EVERY_MS" "refreshed every 30 minutes"
check server/services/syncService.js "require('./sportsFixtures').scheduleRefresh();" "and after an EPG sync"
check server/index.js "require('./services/sportsFixtures').startBackgroundRefresh();" "started at server startup"
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS sport_fixtures (" "fixtures survive a restart (SQLite, not just memory)"
check server/services/sportsClassify.js "function fixtureVerdict(a, leagueData, now" "the ESPN rule: matched, or both teams known but no such game"
check server/services/sportsClassify.js "if (fixturesByLeague) {" "checked first in resolveLive, ahead of the guide's own flags"
check server/routes/status.js "sportFixtures: sportsFixtures.statusSummary()," "the Status document carries fixture coverage per league"
check public/js/pages/StatusPage.js "renderSportFixtures(fx)" "and the web Status page shows it"
check test/fixtures/espn/nfl-20260927.json "Buffalo Bills" "real recorded ESPN responses, not fabricated"
check test/sports-fixtures.test.js "ESPN: the game started" "with a test"

echo "=== 0162: stale/out-of-window ESPN data must never manufacture a replay (C-I) ==="
check server/db/sqlite.js "covered_from INTEGER" "the last successful fetch's own covered window is stored"
check server/services/sportsFixtures.js "covered_from: now - LOOKBACK_MS, covered_to: now + WINDOW_MS" "a success records exactly the window it fetched"
check server/services/sportsFixtures.js "coverage: { from: status.covered_from, to: status.covered_to, at: status.last_success_at }" "the snapshot carries coverage, not just fixtures"
check_absent server/services/sportsFixtures.js "function mergeFixtures(" "cricket is a full replace too, so a postponed game does not linger"
check server/services/sportsClassify.js "const NO_GAME_MAX_AGE_MS" "\"no such game\" is only trusted while the fetch is recent"
check server/services/sportsClassify.js "const NO_GAME_HALF_WINDOW_MS" "...and only when the window reaches well past the airing on both sides"
check server/services/sportsClassify.js "if (!leagueData || !leagueData.coverage) return null;" "no coverage at all -> straight through to the heuristics"
check server/services/sportsClassify.js "a.start < from || a.start > to) return null;" "outside the covered window -> straight through, matched or not"
check test/sports-fixtures.test.js "must never manufacture a replay for a real, unlisted game" "with a test"

echo "=== 0171: the channel linker (multi-provider P3) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS channel_links (" "links live in their own table"
check server/db/sqlite.js "UNIQUE (primary_source_id, primary_key, backup_source_id, rank)" "one row per rank per channel and provider"
check server/services/channelLinks.js "function candidatesFor(primary, backup)" "the matcher is a pure function"
check server/services/channelLinks.js "function indexBackup(rows)" "a backup is bucketed by tvg key, name key and Fox number (no N x M scan)"
check server/services/channelLinks.js "if (p.event) return \[\];" "event/PPV slots never link"
check server/services/channelLinks.js "if (!backups.some(b => b.enabled)" "with no backup provider nothing is linked"
check server/services/channelLinks.js "const USABLE = new Set(\['auto', 'approved', 'manual'\]);" "only auto/approved/manual links are used"
check server/services/syncService.js "await this.relinkAfterPrimarySync(source);" "a primary sync relinks"
check server/index.js "app.use('/api/links', require('./routes/links'));" "the admin link API is mounted"
check server/routes/links.js "router.use(requireAuth, requireAdmin);" "and is admin only"
check_absent server/services/channelLinks.js "url_data," "the linker never reads a backup's stream URL"
check test/channel-links.test.js "the wrong country never links" "with fixture tests"
check test/channel-links-perf.test.js "relink in under 3 s" "and a performance test"

echo "=== 0172: the provider admin pages (multi-provider P4) ==="
check public/index.html 'id="tab-providers"' "the Providers tab has its section"
check public/index.html 'id="tab-backuplinks"' "and so does Backup links"
check public/index.html 'pages/BackupLinksSettings.js' "its script is loaded (before Settings.js builds it)"
check public/js/pages/Settings.js "this.providers = new ProvidersSettings();" "Settings builds the Providers panel"
check public/js/pages/Settings.js "this.backupLinks = new BackupLinksSettings();" "and the Backup links panel"
check public/js/pages/ProvidersSettings.js "for (const k of \['epgUrl', 'idOverlayUrl'\]) if (v(k) !== String(saved\[k\] ?? '')) body\[k\] = v(k);" "0182: an emptied guide or overlay address is removed, an unchanged one is not sent"
check_absent public/js/pages/ProvidersSettings.js "p.idOverlayUrl" "the page never reads the stored overlay address"
check server/routes/sources.js "const settingsOnly = keys.length > 0 && keys.every(k => k === 'priority');" "an order-only edit does not start a backup sync"
check test/providers-page.test.js "no address, login or password" "with tests"

echo "=== 0173: per-provider connection pools (multi-provider P5) ==="
check server/services/streamCoordinator.js "function providerLimit" "each provider has its own connection limit"
check server/services/streamCoordinator.js "if (!dir.multi) return legacy;" "with no backup the limit is maxProviderStreams, as before"
check server/services/streamCoordinator.js "const streams = streamsInPool(pool, dir).sort" "a viewer is counted within its provider's pool"
check server/services/streamCoordinator.js "function canAdmitWithoutDisturbing" "admission can be asked without acting (P6 walks candidates)"
check server/services/streamCoordinator.js "function canRecordFreely" "and so can a recording's (P7)"
check server/services/streamCoordinator.js "function releaseOwnerElsewhere" "a device watches one thing across providers"
check server/services/streamCoordinator.js "if (typeof sqlite.isOpen !== 'function' || !sqlite.isOpen()) return LEGACY_DIRECTORY;" "the coordinator never opens the database itself"
check server/services/transcodeSession.js "providerId: s.options.providerId ?? null" "sessions carry their provider"
check server/routes/playback.js "const ask = { force: false, activeRecordings, settings, owner, providerId: candidate.providerId };" "resolve admits the viewer on the provider it plays on (0174: the candidate's)"
check server/services/recordingEngine.js "coordinator.requestForRecording(schedule, settings, schedule.source_id)" "a recording asks its own provider's pool"
check test/provider-pools.test.js "with no backup configured every scenario has today" "with tests"

echo "=== 0174: resolve failover, breaker, quarantine, C-J (multi-provider P6) ==="
check server/services/providerRouting.js "async function plan(sourceId, channelId, now = Date.now())" "the candidate list: primary, sibling, backups"
check server/services/providerRouting.js "if (primaryDown || primaryExpired || isQuarantined(id, streamId, now)) continue;" "a sibling only when the primary is not down (D5)"
check server/services/providerRouting.js "if (distinct >= BREAKER_CHANNELS) trip(" "the breaker counts distinct channels"
check server/services/providerRouting.js "// Nowhere else to go: the primary, as it always was." "with nothing else configured the primary is always tried"
check server/routes/playback.js "if (err.superseded || !routing || !providerRouting.isProviderFailure(err)) throw err;" "only a provider-reason failure fails over"
check server/routes/playback.js "refusedRetryDelaysMs: isLast ? undefined : providerRouting.EARLY_RETRY_DELAYS_MS," "0143's two retries only on the last candidate"
check server/routes/playback.js "return sendConflict(res, verdict, { everyProvider: !!routing && routing.providerCount > 1 });" "all full: the 409 for the first candidate"
check server/services/transcodeSession.js "if (!requested && this.timings.playlistReady) this.noteLost('exit');" "an unrequested end after playing is reported (quarantine)"
check server/services/transcodeSession.js "if (this.timings.playlistReady) this.noteLost('stall');" "and so is a stall"
check server/services/transcodeSession.js "const delays = Array.isArray(this.options.refusedRetryDelaysMs) ? this.options.refusedRetryDelaysMs : REFUSED_RETRY_DELAYS_MS;" "retries are an option, 0143's by default"
check server/db/sqlite.js "ALTER TABLE channel_health ADD COLUMN provider_id INTEGER" "health rows carry the provider"
check server/routes/info.js "providers: true" "the C-J flag"
check docs/ROADMAP-CONTRACTS.md "## C-J. Provider on resolve" "C-J is written down"
check test/provider-failover.test.js "with no backup configured: today" "with tests"

echo "=== 0177: recordings choose a free provider, fail over, continue in parts (multi-provider P7) ==="
check server/services/recordingEngine.js "providerId, settings, recordings)) return i;" "a recording takes the first provider with a free connection"
check server/services/recordingEngine.js "return { route, index: 0, verdict: await coordinator.requestForRecording(schedule, settings, route.candidates" "all busy: today's prompt on the first candidate"
check server/services/recordingEngine.js "if (!entry.route.multi || !unrequested || !providerReason) {" "only an unrequested provider-reason exit fails over, and only with a backup"
check server/services/recordingEngine.js "entry.stopRequested = true;" "a requested stop is never a provider failure"
check server/services/recordingEngine.js "const last = entry.part >= failoverTuning.maxParts;" "at most 3 parts"
check server/db/recordingsDb.js "'provider_id INTEGER'," "recordings carry their provider"
check server/db/recordingsDb.js "'part INTEGER'," "and their part"
check docs/SWIFT-CLIENT-HANDOFF.md "| 0177 |" "the additive list fields are in the client handoff"
check test/recording-failover.test.js "no backup configured: a 502 at start fails the recording exactly as before" "with tests"

echo "=== 0178: raw-list bridge for the linker (multi-provider P9) ==="
check server/db/sqlite.js "CREATE TABLE IF NOT EXISTS provider_raw_channels (" "every provider's raw rows have a table"
check server/services/rawChannels.js "async function fetchFor(source)" "fetched with the derived login, never throwing"
check server/services/syncService.js "await require('./rawChannels').fetchFor(source);" "a primary sync reads its raw rows only when a backup exists"
check server/services/syncService.js "await rawChannels.fetchMissing(await sources.getAll(), source.id);" "and the first backup fetches the others'"
check server/routes/sources.js "require('../services/rawChannels').removeFor(sourceId);" "deleting a source removes its raw rows"
check server/services/channelLinks.js "const METHOD_ORDER = { 'raw-name': 0, 'raw-epg': 1," "raw-name and raw-epg rank above the name rules"
check server/services/channelLinks.js "function rawNameKey(name) {" "the raw name is normalised minimally"
check test/raw-bridge.test.js "both ways: Dream4K as the primary" "with a both-ways test"
check test/raw-bridge.test.js "no code path names a provider" "and a provider-neutrality test"

echo "=== 0180: a start stopped on request is not a provider failure (P10) ==="
check server/services/transcodeSession.js "this.stopRequested = true;" "stop() records that it was asked"
check server/services/playbackStrategy.js "if (session.stopRequested) {" "a stopped start throws superseded, not a failure"
check server/routes/playback.js "if (err.superseded || !routing || !providerRouting.isProviderFailure(err)) throw err;" "a superseded start is never failed over"
check server/routes/playback.js "if (isSuperseded(owner, generation)) throw playbackStrategy.supersededError();" "an overtaken walk starts no further candidate"
check public/js/components/VideoPlayer.js "if (res.status === 499) return VideoPlayer.SUPERSEDED;" "the web player ignores a superseded resolve"
check test/provider-failover.test.js "0180: a start replaced by the same viewer" "with a replacement test"

echo "=== 0181: the same account is one connection pool (P10) ==="
check server/services/accountKey.js "createHash('sha256')" "the account key is a hash, never the login"
check server/services/streamCoordinator.js "const lowestShared = (own) => {" "a shared pool's limit is the lowest among its sources"
check server/services/streamCoordinator.js "return dir.poolOf && dir.poolOf.has(id) ? dir.poolOf.get(id) : id;" "poolKey folds a twin into its pool"
check server/routes/sources.js "sharesAccountWith: sharing(s) })));" "the admin list names the twins by id"
check public/js/pages/ProvidersSettings.js "these count as one connection. Check this provider's settings." "Settings -> Providers warns"
check test/provider-pools.test.js "0181: two sources with the same server and login are one pool" "with a pool test"
check test/providers-page.test.js "0181: a provider that is the same account" "and a warning test"

echo "=== 0182-0187: one Providers section, six tabs, sport lists, the build number ==="
check server/routes/sources.js "router.put('/order', async" "the card order is saved in one call"
python3 - <<'PY' || FAIL=1
import sys
s = open('server/routes/sources.js').read()
if s.index("router.put('/order'") > s.index("router.put('/:id'"):
    print("  ✗ PUT /order is registered after PUT /:id, which would swallow it"); sys.exit(1)
print("  ✓ PUT /order is registered before PUT /:id")
PY
check server/services/syncService.js "async syncProviderGuide(source, ownUrl = null)" "the primary's guide comes from its own card"
check server/services/syncService.js "await this.dropGuide(source.id); // 0182" "a backup keeps no guide"
check server/index.js "require('./services/providerMigration').run()" "the one-time provider move runs at startup"
check server/services/syncService.js "rawList = await this.addUnlistedChannels(source, rows);" "0183: an M3U backup gets the provider's whole list"
check public/index.html 'data-tab="channels">Channels' "six tabs: Channels"
check public/index.html 'id="subtabs-channels"' "with its three views on a strip"
check_absent public/index.html 'data-tab="sources"' "the Sources tab is gone"
check_absent public/index.html 'id="tab-debug"' "the Debug tab is gone"
check server/routes/sports.js "router.get('/teams', requireAdmin" "0185: a league's teams for the Sports tab"
check server/services/sportsClassify.js "function teamFollow(keyword)" "a team is followed as League: Team"
check server/services/sportsFixtures.js "EPL: 'soccer/eng.1'" "EPL has ESPN fixtures"
python3 - <<'PY' || FAIL=1
import re, sys, subprocess
build = re.search(r"const BUILD = '(\d{4})';", open('server/version.js').read()).group(1)
nxt = re.search(r"Next build number \| \*\*(\d{4})\*\*", open('blueprint.md').read())
if not nxt or int(nxt.group(1)) != int(build) + 1:
    print(f"  ✗ version.js says build {build} but the blueprint's next build number is {nxt.group(1) if nxt else '?'} (0187: every build bumps both)"); sys.exit(1)
print(f"  ✓ version.js ({build}) is one behind the blueprint's next build number")
PY

echo "=== 0188-0189: interruptions, in-stream recovery and the standby (off by default) ==="
check server/routes/status.js "interruptions: require('../services/playbackInterruptions').summary()," "Status reports streams lost mid-play"
check server/services/streamRelay.js "const enabled = () => on('PIGTV_RELAY');" "the relay is behind PIGTV_RELAY"
check server/services/streamRelay.js "const standbyEnabled = () => enabled() && on('PIGTV_STANDBY');" "the standby needs the relay"
check server/services/streamRelay.js "text.replace(/^#EXT-X-ENDLIST" "a relay never passes ffmpeg's ENDLIST on"
check server/routes/transcode.js "return relay.get(sessionId) || transcodeSession.getSession(sessionId);" "a relay answers for its id"
check server/services/transcodeSession.js "if (this.retainDir) return;" "a relay leg's folder outlives its ffmpeg"
check server/services/transcodeSession.js "if (session.options.standby === true) continue;" "the idle sweep leaves a standby to its relay"
check server/services/streamCoordinator.js "take(streams.filter(s => s.standby), 'standby');" "a viewer takes a standby's connection first"
check server/services/streamCoordinator.js "Releasing standby" "a recording takes a standby's connection unasked"
check test/stream-relay.test.js "the coordinator treats a standby as abandoned" "with tests"
check scripts/relay-rig.js "relay-rig.js standby stall" "and a real-ffmpeg rig"

echo "=== 0191: reconnect timestamp loop, blank pictures, raw captures ==="
check server/services/transcodeSession.js "this.handleTimestampLoop(" "a timestamp loop after a reconnect ends the session"
check server/services/transcodeSession.js "this.noteLost('timestamps');" "as lost, so the relay or the player restarts it"
check server/services/transcodeSession.js "this.emit('blank', { kbps, seconds });" "a near-empty picture is marked blank"
check server/services/providerRouting.js "session.once('blank'" "a blank channel is quarantined on its provider"
check server/routes/playback.js "channelHealth.sessionBlank(owner)" "and its health row failed"
check public/js/pages/StatusPage.js "Blank picture" "Status shows it"
check scripts/stream-doctor.js "function rawFetch(" "capture keeps the provider's raw bytes"
check test/reconnect-recovery.test.js "a single rebase after a reconnect" "with tests"

# Every section must run before the summary below, or its failures cannot fail the script (0132's did not).
python3 - <<'PY' || FAIL=1
import re, sys
s = open('scripts/verify-build.sh').read()
tail = s[s.rindex('if [ $FAIL -eq 0 ]; then'):]
if re.search(r'^(check|check_absent|echo "===) ', tail, re.M):
    print("  ✗ a check sits after the summary"); sys.exit(1)
print("  ✓ every check runs before the summary")
PY

if [ $FAIL -eq 0 ]; then
    echo ""
    echo "=== ALL CHECKS PASSED ==="
else
    echo ""
    echo "=== FAILED — do NOT push ==="
    exit 1
fi
