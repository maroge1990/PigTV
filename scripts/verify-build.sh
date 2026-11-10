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
# What belongs here (simplification build, 4 Oct)
# ------------------------------------------------
# Only what a test cannot say: something that must NOT come back (check_absent),
# placement and structure (the Python blocks), the image and CI (Dockerfile,
# workflows, package files) and the docs' build numbering. Behaviour belongs in a
# test under test/. This file used to assert ~780 strings of server code and test
# names as well; they broke on every rewording and said nothing the tests did not,
# so they went. The web app's plain string checks live in a test, not here.
#
# Adding checks
# -------------
# When you fix a bug of that kind, add the check that would have caught it, and
# prove it works by reintroducing the bug and watching it fail.

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

echo "=== 0009: Movies/Series toggle (removed with Movies/Series in 0122) ==="
check_absent server/db.js "showMovies" "no movies setting left"

echo "=== 0011: EPG visible filter (0122: the whole-EPG route is gone; /api/library/guide lists visible channels) ==="
check_absent server/routes/proxy.js "router.get('/epg/:sourceId'" "no whole-EPG dump"

echo "=== 0019: category order preserved client-side ==="
if grep -q "stripFlagEmoji\|stripFlags" server/routes/proxy.js; then
    echo "  ✗ MISSING: flag stripping not reverted"; FAIL=1
else
    echo "  ✓ flag stripping reverted"
fi

echo "=== 0021: PigTV rebrand + recording fix ==="
check package.json "pigtv" "package renamed"
check .github/workflows/docker-publish.yml "/pigtv" "CI image renamed"
check README.md "PigTV" "README rebranded"
for f in mark.svg wordmark-light.svg wordmark-dark.svg lockup-horizontal-light.svg lockup-horizontal-dark.svg \
         lockup-stacked-light.svg lockup-stacked-dark.svg favicon-light.ico favicon-dark.ico \
         web-small-light.svg web-small-dark.svg web-light-180.png web-light-192.png web-light-512.png \
         web-dark-180.png web-dark-192.png web-dark-512.png; do
    if [ -f "public/img/brand/$f" ]; then :; else echo "  \u2717 MISSING: public/img/brand/$f"; FAIL=1; fi
done
echo "  \u2713 brand assets checked (public/img/brand)"
for f in pigtv-logo.png pigtv-logo-master.png logo-banner.png pigtv-wordmark-dark.png pigtv-wordmark-light.png; do
    if [ -f "public/img/$f" ]; then echo "  \u2717 STALE: public/img/$f (pre-1.6 family pig) should be gone"; FAIL=1; fi
done
if [ -f public/favicon.svg ]; then echo "  \u2717 STALE: public/favicon.svg should be gone"; FAIL=1; fi
check docs/brand-tokens.json '1\.7\.0' "brand tokens are 1.7.0"
for f in pig-radiance.css pig-glass.css; do
    if [ -f "public/css/$f" ]; then :; else echo "  \u2717 MISSING: public/css/$f"; FAIL=1; fi
done
if grep -rqi "nodecast" package.json public/index.html public/login.html .github/workflows/docker-publish.yml docker-compose.yml Dockerfile; then
    echo "  \u2717 MISSING: nodecast references remain"; FAIL=1
else
    echo "  \u2713 no nodecast references in branded files"
fi

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

echo "=== 0030: guide, stream auth, info ==="
check_absent server/auth.js "{ enforce" "stream auth has no opt-out (R01: always enforced)"
check_absent server/auth.js "streamAuthFromSettings" "no settings-driven enforcement"
check_absent server/db.js "requireStreamAuth" "the stream auth setting is gone from the defaults"
check_absent server/routes/proxy.js "req.query.url;" "the proxy no longer reads a caller-supplied URL"
check_absent server/services/playbackHandles.js "handlesEnabled" "playback handles are always on"
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

echo "=== 0032: ad detection ==="
check Dockerfile "Comskip" "comskip built into image"
check Dockerfile "comskip.ini" "tuning shipped"
check docker/comskip.ini "detect_method" "tuning has detection methods"

echo "=== compression is request-only ==="
python3 - <<'PYCHK'
import re, sys
# 0507: a recording is finished by recordingSegments.completed() (every recording is segmented).
seg = open('server/services/recordingSegments.js').read()
src = open('server/services/recordingEngine.js').read() + seg
i = seg.index('function completed(')
fin = seg[i:i+800]
auto_compress = "setCompressStatus(rec.id, 'pending')" in fin
auto_detect = "setAdDetectStatus(rec.id, 'pending')" in fin
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

echo "=== 0034: native HLS delivery for segmented clients ==="
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

echo "=== 0036: media-auth token propagation to HLS children ==="
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

echo "=== 0047: EPG streaming parser data loss and hangs (review P0-2) ==="
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

echo "=== 0048: Build identity surfaced ==="
# The whole point is that a running server (and any client) can say which
# build it is. Each check asserts the number reaches the surface it is read
# from, not just that version.js exists.
check Dockerfile "PIGTV_COMMIT" "Dockerfile can stamp commit/builtAt at build time"
check Dockerfile "net.unraid.docker.icon=\"https://raw.githubusercontent.com/maroge1990/PigTV/main/public/img/brand/web-dark-512.png\"" "0208: the image carries the Unraid icon label"
check Dockerfile "net.unraid.docker.webui=" "0208: and the Unraid WebUI label"

echo "=== 0050: Auth gate on state-changing routes (P0-3) ==="
# The gate has to be on the mount, and the webapp callers have to actually
# send a token, or turning the gate on breaks the web player.
# (0122: /api/probe and /api/subtitle were removed; resolve and the session delete keep
#  their own always-on token middleware, checked next.)
# (0122: /api/probe and /api/subtitle, and the movie/series page that called them, are gone.)
check_absent server/index.js "app.use('/api/probe'" "no /api/probe"
check_absent server/index.js "app.use('/api/subtitle'" "no /api/subtitle"

echo "=== 0051: Drop the dead ffmpeg-static require ==="
check_absent server/routes/proxy.js "require('ffmpeg-static')" "proxy.js no longer requires ffmpeg-static at load (would crash startup if the optional dep failed)"
# index.js keeps its own guarded fallback require - that one is inside try/catch.
# The image installs with `npm ci --omit=dev` and brings its own ffmpeg: the bundled binaries are dev-only.
if node -e 'const p=require("./package.json");process.exit(["ffmpeg-static","@ffprobe-installer/ffprobe"].some(n=>(p.dependencies||{})[n]||(p.optionalDependencies||{})[n])?1:0)'; then
    echo "  ✓ ffmpeg-static and @ffprobe-installer/ffprobe are not production dependencies"
else
    echo "  ✗ a bundled ffmpeg package is a production dependency (the image has its own ffmpeg)"
    FAIL=1
fi

echo "=== 0052: Provider credential redaction (P1-4) ==="
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
check_absent server/index.js "express-session" "no session store at all (0077 removed it; the MemoryStore leak cannot come back)"

echo "=== 0054: ffmpeg output-inactivity watchdog ==="
# Both delivery paths read the same live input with the same reconnect flags,
# so both need the watchdog, and it has to be started on the real process.
# Silence with the client not reading (paused tab, full pipe) is the client's
# doing, not ffmpeg's. Without this guard a paused viewer gets killed.
# Remux idle accounting: idleMs must mean 'time since media last flowed', and
# the coordinator must use it instead of pretending every remux is busy.
check_absent server/services/streamCoordinator.js "idleMs: 0," "coordinator no longer hard-codes remux idleMs to 0"

echo "=== 0055: Viewer-vs-viewer arbitration + live idle timeout (A3) ==="
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
check_absent server/services/streamCoordinator.js "soft" "no soft mode (0122: it existed only for the removed POST /api/transcode/session)"
# (0102: the live player has no fallback sessions any more; resolve creates live sessions server-side.)

echo "=== 0056: Atomic EPG swap (P1-5) ==="
# The bug being fixed: the live guide was deleted before the new feed loaded.
check_absent server/services/syncService.js "DELETE FROM epg_programs WHERE source_id = ?').run(sourceId)" "sync no longer empties the live guide up front"
check_absent server/services/syncService.js "JSON.stringify(p)" "full programme JSON is no longer stored"
# Every reader must go through the view, or it shows two generations at once.
for f in server/routes/library.js server/routes/proxy.js; do
  check_absent "$f" "FROM epg_programs" "$f reads epg_live, not the raw table"
done

echo "=== 0057: HLS segment route hardening (P2-4) ==="
# Whitelist the exact names ffmpeg writes; a suffix check let an encoded-slash
# path through, since Express decodes params after routing.
check_absent server/routes/transcode.js "(ts|m4s|mp4)\$/" "old suffix-only check is gone"

echo "=== 0058: ?token= through the HLS proxy rewriter (P2-5) ==="
# Both rewrite sites must go through proxiedUrl; a third hand-built URL would
# silently drop the token again. (Count the "/stream?" prefix, which only it writes.)
if [ "$(grep -c '/stream?' server/routes/proxy.js)" = "1" ]; then
  echo "  ✓ only proxiedUrl builds /stream?h= URIs in the rewriter"
else
  echo "  ✗ MISSING: a rewriter URL is built outside proxiedUrl (would drop the token)"; FAIL=1
fi

echo "=== 0059: Favourites id normalisation (P1-3 server half) ==="
# The bug: web and native wrote different spellings, so favourites never crossed.
# Each of add/remove must normalise, or one of them silently misses.
if [ "$(grep -c "if (itemType === 'channel') itemId = bareChannelId(itemId);" server/db/sqlite.js)" = "2" ]; then
  echo "  ✓ add and remove both normalise channel ids"
else
  echo "  ✗ MISSING: favorites add/remove must each normalise channel ids"; FAIL=1
fi

echo "=== 0060: Guide query bounds + item index (P2-3) ==="
# Both EPG queries in this file need the lower bound, or one of them still walks the feed.
if [ "$(grep -c 'start_time > ? AND end_time > ? AND start_time < ?' server/routes/library.js)" = "2" ]; then
  echo "  ✓ both EPG queries (guide, now/next) bound start_time from below"
else
  echo "  ✗ MISSING: every EPG query in library.js must bound start_time from below"; FAIL=1
fi

echo "=== 0061: Recording time zone + User-Agent (P2-6) ==="
check docker-compose.yml "TZ=\${TZ:-UTC}" "compose passes TZ through (UTC fallback = unchanged behaviour)"
check_absent server/services/recordingEngine.js "Chrome/123.0.0.0" "no hard-coded Chrome UA left in the recording engine"

echo "=== 0062: Recording native playback (P1-2 server half) ==="
# Both the remux and the HEVC compression output need the tag.
if [ "$(cat server/services/recordingMedia.js server/services/recordingPost.js | grep -c "'-tag:v', 'hvc1'")" = "2" ]; then
  echo "  ✓ hvc1 is applied to both the native remux and HEVC compression"
else
  echo "  ✗ MISSING: hvc1 must be applied in both buildNativeRemuxArgs and buildCompressArgs"; FAIL=1
fi

echo "=== 0063: Body cap + rate limits (P2-7, partial) ==="
check_absent server/index.js "50mb" "the 50 MB body limit is gone"
# The key must not come from X-Forwarded-For (client-controlled under 'trust proxy: true').
check_absent server/routes/auth.js "req.ip" "login limit never uses req.ip (spoofable via X-Forwarded-For)"

echo "=== 0067: EPG icon fallback in the library API ==="
# Both places that build channel rows must apply it, or the guide and the channel
# list disagree about what a channel looks like.
if [ "$(grep -c 'fillMissingLogos(' server/routes/library.js)" = "3" ]; then
  echo "  ✓ decorate() (channels, favourites) and the guide both apply it"
else
  echo "  ✗ MISSING: fillMissingLogos must be defined once and called from decorate() and the guide"; FAIL=1
fi

echo "=== 0072: Hide All / Show All update the group checkboxes ==="
# The same key must be what getGroupHtml reads, or the two drift apart again.
if [ "$(grep -c 'groupItemType}:${group.categoryId}' public/js/components/SourceManager.js)" -ge "3" ]; then
  echo "  ✓ the group key is built the same way where it is drawn, saved and bulk-changed"
else
  echo "  ✗ MISSING: getGroupHtml, saveContentChanges and setAllVisibility must all use the same group key"; FAIL=1
fi

echo "=== 0073: HLS sessions tolerate audio/video start-time skew ==="
# It is an input option: it must sit before -i or it would apply to the output.
if awk '/-dts_delta_threshold/{d=NR} /args.push\(.-i., this\.(url|feed)/{i=NR} END{exit !(d && i && d<i)}' server/services/transcodeSession.js; then
  echo "  ✓ it comes before -i (an input option)"
else
  echo "  ✗ MISSING: -dts_delta_threshold must come before -i in the session arguments"; FAIL=1
fi

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
check_absent package.json "express-session" "express-session is not a dependency"
check_absent package.json "passport-openidconnect" "nor is passport-openidconnect"
check_absent package-lock.json "node_modules/express-session" "and the lockfile agrees"

echo "=== 0078: JSON-file hiddenItems / favorites removed from db.js (review P2-1) ==="
check_absent server/db.js "hiddenItems" "no JSON-file hidden items (they live in SQLite, routes/channels.js)"
check_absent server/db.js "db.favorites" "no JSON-file favourites (they live in SQLite, routes/favorites.js)"

echo "=== 0079: unknown /api paths return a JSON 404 ==="
# It must come after every router and before the SPA fallback, or it swallows real routes / never runs.
if awk '/app.use\(.\/api\/recordings/{r=NR} /No such API endpoint/{e=NR} /SPA fallback - serve index.html/{s=NR} END{exit !(r && e && s && r<e && e<s)}' server/index.js; then
  echo "  ✓ it sits after the last router and before the SPA fallback"
else
  echo "  ✗ MISSING: the API 404 must come after all /api routers and before the SPA fallback"; FAIL=1
fi

echo "=== 0080: a failed db.json write is reported, not swallowed (review §2.14) ==="
# 0135 moved the store into SQLite: a write is one transaction, rolled back whole on failure.
check_absent server/db.js "Database write failed" "the old catch-and-continue that reported success is gone"

echo "=== 0081: playback report script for the HLS trial ==="
check scripts/playback-report.js "play-start via" "the report reads the play-start line the server writes"
check scripts/playback-report.js "resolve timing" "and the resolve timing line, to tell cold plays from warm ones"
# The script parses log lines by their exact wording, so the server must still write them that way.

echo "=== 0084: the playback report keeps Apple-device plays apart from the web trial ==="
check scripts/playback-report.js "DEVICE_SUFFIX" "device plays get their own rows"

echo "=== 0090: the timestamp diagnostics become a supported tool ==="
check scripts/stream-doctor.js "capture <pos_N>" "one tool with the five subcommands, replacing four throwaway scripts"
check scripts/stream-doctor.js "classifyTimestamps" "its verdict is the server function, not a second copy of the rule"
check scripts/stream-doctor.js "uses the provider slot" "and it says which subcommands take the provider connection"
check docs/architecture/playback.md "reach for this first on any playback fault" "and the playback page points at it"

echo "=== 0091 (docs): troubleshooting starts from a capture of the real channel ==="
check docs/architecture/playback.md "When a channel misbehaves" "the loop is written down, in order"
check AGENTS.md "No ffmpeg-flag or" "and shipping a timestamp fix on a hypothesis is called out as the 0085 mistake"
check docs/architecture/playback.md "regression corpus" "samples are kept and retested, which 0085 had no way to do"
check AGENTS.md "/Users/markrogers/Documents/GitHub/PigTV" "the map of the docs names the current repo folder"
check AGENTS.md "and pushes it once the batch has passed its reviews" "and how changes ship is written down (D-34: commit, push once reviewed)"

echo "=== 0092 (docs): commands name the container instead of a placeholder ==="
check docs/architecture/playback.md "docker exec PigTV node scripts/stream-doctor" "so a command can be pasted as written"
check docs/CLIENT-CONTRACT.md "docker logs PigTV" "including the ones the Apple client session runs"

echo "=== 0093: captured samples survive a deploy ==="
check scripts/stream-doctor.js "path.join(DATA, .samples.)" "they are written under the data bind mount, not the writable layer"
check docs/architecture/playback.md "has to outlive the build it was taken on" "and the playback page says why it matters"

echo "=== 0095: the image says which source it was built from ==="
check .github/workflows/docker-publish.yml "PIGTV_COMMIT=" "CI passes the commit into the build"
check .github/workflows/docker-publish.yml "id: stamp" "computed in a step, so release and workflow_dispatch work too"
check AGENTS.md "builds \`ghcr.io/maroge1990/pigtv\` \*\*only if the tests pass" "and the mechanism is written down rather than assumed"
check .github/workflows/docker-publish.yml "else npm test; fi" "and the tests run in the same job before the publish step; an empty plan is the full suite (D-50)"

echo "=== D-38: a docs-only push builds no image ==="
check .github/workflows/docker-publish.yml "paths-ignore: \[ 'docs/\*\*', '\*\*.md'" "docker-publish.yml ignores pushes that change only docs"

echo "=== #241: no selector is defined twice at the top level of main.css (the later one silently won) ==="
python3 - <<'CSS_DUPES' || FAIL=1
import re, sys, collections
css = re.sub(r'/\*.*?\*/', '', open('public/css/main.css').read(), flags=re.S)
depth, start, selectors = 0, 0, []
for i, c in enumerate(css):
    if c == '{':
        if depth == 0: selectors.append(css[start:i].strip())
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0: start = i + 1
    elif c == ';' and depth == 0: start = i + 1
twice = sorted(s for s, n in collections.Counter(x for x in selectors if not x.startswith('@')).items() if n > 1)
if twice:
    print('  ✗ defined twice at the top level: ' + '; '.join(twice)); sys.exit(1)
print('  ✓ every top-level selector in main.css is defined once')
CSS_DUPES

echo "=== #241: one type scale, spacing from tokens, three breakpoints ==="
python3 - <<'CSS_SCALE' || FAIL=1
import re, sys, glob
css = re.sub(r'/\*.*?\*/', '', open('public/css/main.css').read(), flags=re.S)
rules = css.replace('\n', ' ')
problems = []
for v in re.findall(r'font-size:\s*([^;]+);', rules):
    if not re.fullmatch(r'var\(--text-[a-z0-9]+\)|inherit|0|initial', v.strip()):
        problems.append('font-size: ' + v.strip())
for prop, v in re.findall(r'(?<![\w-])((?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?):\s*([^;{}]+);', rules):
    if 'env(' in v: continue
    for n in re.findall(r'(?<![\w.-])(\d+)px', v):
        if int(n) > 1: problems.append(f'{prop}: {v.strip()}')
for w in re.findall(r'@media[^{]*?\((?:max|min)-(?:width|height):\s*(\d+)px', rules):
    if w not in ('480', '768', '769', '1024'): problems.append(f'@media {w}px')
for path in glob.glob('public/*.html') + glob.glob('public/js/**/*.js', recursive=True):
    for m in re.finditer(r'style="([^"]*)"', open(path).read()):
        for decl in m.group(1).split(';'):
            if re.match(r'\s*(margin|padding|gap|font-size)', decl) and re.search(r'(?<![\w.$-])\d+(px|rem|em)\b', decl):
                problems.append(f'{path}: inline {decl.strip()}')
if problems:
    print('  ✗ outside the scale: ' + '; '.join(sorted(set(problems))[:12])); sys.exit(1)
print('  ✓ font sizes from --text-*, spacing from --space-*, breakpoints 480/768/1024, no raw inline sizes')
CSS_SCALE

echo "=== #241: status colours are the kit's roles, not Tailwind or Material literals ==="
python3 - <<'CSS_STATUS' || FAIL=1
import re, sys
css = re.sub(r'/\*.*?\*/', '', open('public/css/main.css').read(), flags=re.S)
# amber/orange, blue, green and red literals (Tailwind, Material) outside the token blocks
banned = re.compile(r'#(f59e0b|f97316|4caf50|e76717|dc2626|ffe79c|694300|ffe0df|9b1717)\b|rgba\(\s*(245,\s*158,\s*11|251,\s*191,\s*36|255,\s*153,\s*0|59,\s*130,\s*246|76,\s*175,\s*80|16,\s*185,\s*129|239,\s*68,\s*68|255,\s*68,\s*68|198,\s*40,\s*40)\s*,', re.I)
found = []
for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
    sel = m.group(1).strip()
    if sel.startswith(':root') or ('data-theme' in sel and '--' in m.group(2)): continue
    for hit in banned.finditer(m.group(2)): found.append(f'{sel.splitlines()[-1].strip()[:40]}: {hit.group(0)}')
if found:
    print('  ✗ a status colour typed in (use --color-success/warning/error/accent): ' + '; '.join(found[:8])); sys.exit(1)
print("  ✓ status colours come from the kit's roles")
CSS_STATUS

echo "=== #236: only a v* tag or a manual run moves production's :release ==="
python3 - <<'RELEASE_GATE' || FAIL=1
import sys
# Text, not PyYAML: CI's system python3 is not promised to have it. Comments are dropped first.
def triggers(path):
    lines = [l.split('#')[0].rstrip() for l in open(path)]
    i = lines.index('on:') + 1
    block = []
    while i < len(lines) and (not lines[i] or lines[i].startswith(' ')):
        block.append(lines[i]); i += 1
    events, current = {}, None
    for l in block:
        if l.startswith('  ') and not l.startswith('   ') and l.strip().endswith(':'):
            current = l.strip()[:-1]; events[current] = {}
        elif l.startswith('    ') and not l.startswith('     ') and current and ':' in l:
            key, value = l.strip().split(':', 1); events[current][key] = value.strip()
    return events, '\n'.join(lines)
problems = []
publish, publish_code = triggers('.github/workflows/docker-publish.yml')
if set(publish) - {'push', 'workflow_dispatch'}:
    problems.append('docker-publish.yml runs on ' + ', '.join(sorted(set(publish) - {'push', 'workflow_dispatch'})))
if 'tags' in publish.get('push', {}):
    problems.append('docker-publish.yml builds on a tag push')
if 'release' in publish_code:
    problems.append('docker-publish.yml publishes a release tag')
release, release_code = triggers('.github/workflows/release.yml')
if set(release) != {'push', 'workflow_dispatch'}:
    problems.append('release.yml triggers are ' + ', '.join(sorted(release)))
if release.get('push') != {'tags': "[ 'v*' ]"}:
    problems.append('release.yml runs on a push other than a v* tag')
if 'imagetools create --tag "$IMAGE:release"' not in release_code or 'sha-$SHORT' not in release_code:
    problems.append('release.yml no longer promotes the built sha image to :release')
if 'merge-base --is-ancestor' not in release_code:
    problems.append('release.yml no longer refuses a commit off main')
if '^v[0-9]{1,6}$' not in release_code:
    problems.append('release.yml accepts a release name other than v + digits')
try:
    if not (release_code.index('imagetools inspect "$IMAGE:sha-$SHORT"') < release_code.index('git push origin "refs/tags/$VERSION"')
            < release_code.index('imagetools create --tag "$IMAGE:release"')):
        problems.append('release.yml moves :release before checking the image and recording the git tag')
except ValueError:
    problems.append('release.yml lost its image check, git tag or promotion step')
if problems:
    for pr in problems: print('  ✗ ' + pr)
    sys.exit(1)
print('  ✓ :latest follows main; :release moves only on a v* tag or a manual run, to an image already built')
RELEASE_GATE

echo "=== 0099: strip the small-caps LIVE badge at ingest (SR-2) ==="
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

echo "=== 0103: remux retired - one delivery path (Phase 4) ==="
# The checks that pinned the remux route, its registry, watchdog wiring, codec probe,
# argument builder and diagnostics were retired with it; their history is in git.
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
# (0122: the session route, /api/probe and /api/subtitle - the other entries that took a URL - are gone.)
check_absent server/services/transcodeSession.js "async persist()" "no session.json with the provider URL in it"
check_absent server/services/transcodeSession.js "async function getOrCreateSession" "no unused getOrCreateSession"

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

echo "=== 0108: gzip JSON responses, never media ==="
check package.json '"compression"' "compression package is a dependency"
check_absent server/services/compressionFilter.js "'video/" "and never allow-lists a video type"

echo "=== 0109: supported runtime and a reproducible image ==="
check Dockerfile "setup_24.x" "nodesource points at Node 24, not the EOL Node 20"
check_absent Dockerfile "setup_20.x" "no leftover reference to Node 20"
check Dockerfile "npm ci --omit=dev" "production install uses the non-deprecated --omit=dev flag"
check_absent Dockerfile "npm ci --only=production" "the deprecated --only=production flag is gone"
check Dockerfile "git fetch --depth 1 https://github.com/erikkaashoek/Comskip a140b6ac8bc8f596729e9052819affc779c3b377" "Comskip is pinned to a specific commit, not a moving master"
check_absent Dockerfile "git clone --depth 1 https://github.com/erikkaashoek/Comskip" "no unpinned clone of Comskip master left behind"
check_absent .github/workflows/test.yml "node: \[22" "CI runs Node 24 only (D-52)"

echo "=== 0113: a failed start fails fast, says why, and a refused first connection is retried once ==="
check scripts/playback-report.js "NOT produced - ffmpeg ended" "the playback report counts those"
check_absent scripts/playback-report.js "opt-in" "the report no longer speaks of the opt-in HLS trial"
check_absent scripts/playback-report.js "Against the trial criteria" "nor its criteria block"
check_absent scripts/playback-report.js "HLS Delivery (beta)" "nor the retired toggle"

echo "=== 0114: channel profiles - a repeat play skips ffprobe ==="
check scripts/playback-report.js "profile \\\\(age" "the playback report counts a profiled play as warm"

echo "=== 0115: frame-rate-aware master playlist for every session ==="
check_absent server/services/transcodeSession.js "CODECS=" "the master playlist still carries no CODECS"

echo "=== 0117: channel numbers (C-A) ==="
check_absent server/routes/library.js "GUIDE_NUMBER_KEY" "dead number-keyed cursor code removed in 0164 (numbers are labels only since 0139)"

echo "=== 0118: resolve errors use the client's allowed wording (C-B) ==="
check_absent server/services/transcodeSession.js "could not find this channel" "the old 404 wording is gone"
check_absent server/services/transcodeSession.js "had a problem serving this channel" "the old 5xx wording is gone"
check_absent server/services/playbackStrategy.js "Transcode failed to produce a playlist in time" "the old timeout wording is gone"

echo "=== 0119: opaque playback handles (C-D) and redacted logs ==="
check_absent server/services/playbackStrategy.js "const encoded = encodeURIComponent(url)" "not the provider URL (except under the rollback switch)"

echo "=== 0120: source catalogue for the Sources picker ==="
awk '/^router.use\(requireAdmin\);/{a=NR} /router.get\(.\/:id\/catalogue./{c=NR} END{exit !(a && c && a < c)}' server/routes/sources.js \
  && echo "  ✓ the catalogue is declared after router.use(requireAdmin) (admin only)" \
  || { echo "  ✗ MISSING: the catalogue route must come after router.use(requireAdmin)"; FAIL=1; }

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

echo "=== 0124: admin status page (W2.2) ==="
check_absent server/routes/status.js "url: summary.url" "a session's URL is never passed through"

echo "=== 0126: the tuner model, T1 (PIGTV_TUNER=1, off by default) ==="
check_absent server/services/tuner.js "'independent_segments+delete_segments" "a tuner's ffmpeg never deletes segments (the server keeps the window)"

echo "=== 0128: the tuner model, T3 - timeshift ==="
check_absent server/services/compressionFilter.js "'video/mp2t'" "never for segments"

echo "=== 0130: a recording's own tuner uses the Apple TV's default capabilities ==="
check_absent server/services/playbackStrategy.js "ac3: true, eac3: true, flac: false, heaac: true" "no heaac in RECORDING_CAPABILITIES"

echo "=== 0134: EPG matching (S4.2) ==="
check_absent server/services/syncService.js "epg_mappings" "the sync never touches the mappings"

echo "=== 0135: sources, settings and users in SQLite (S4.3a) ==="
check_absent server/db.js "structuredClone" "no clone of the store on reads"
check scripts/stream-doctor.js "SELECT value FROM app_settings WHERE key = ?" "stream-doctor reads the user agent from SQLite"

echo "=== 0136: auth without passport (S4.3b) ==="
check_absent package.json '"passport' "no passport packages in package.json"
check_absent package-lock.json '"node_modules/passport' "nor in the lockfile"
check_absent server/index.js "passport" "no passport middleware"
check_absent server/routes/playback.js "require('passport')" "the playback route's optional auth is ours"

echo "=== 0137: Express 5 (S4.3c) ==="
check package.json '"express": "^5.' "express 5"
check_absent server/index.js "app.get('\*'" "not the Express 4 '*'"

echo "=== 0139: channel numbers are labels; the guide keeps the provider's order ==="
check_absent server/routes/library.js "const numbered = false" "dead numbered variable removed in 0164 (kept guide in provider order per 0139)"

echo "=== 0145: the playback report shows the client wait ==="
check scripts/playback-report.js "clientWaitSec: wait !== null && wait >= 0" "client wait = first picture minus resolve, per play"
check scripts/playback-report.js "Where the time goes" "a per-path median / p90 table"

echo "=== 0147: EPG programme categories stored (C-I) ==="
python3 - <<'PY2' || FAIL=1
import sys
s = open('server/db/sqlite.js').read()
if not (s.index('ADD COLUMN categories') < s.index("DROP VIEW epg_live") < s.index('CREATE VIEW IF NOT EXISTS epg_live')):
    print("  ✗ the column and the view drop must come before the view is created"); sys.exit(1)
print("  ✓ the column is added, and a stale view dropped, before epg_live is created")
PY2

echo "=== 0148: sport events and the follow list (C-I) ==="
check_absent server/services/sportsEvents.js "FROM epg_programs" "never the raw table"

echo "=== 0150: sport programme kinds and merging by meaning (C-I) ==="
check_absent server/services/sportsEvents.js "if (EXCLUDE_RE.test(text) || categories.some" "non-events are classified, not dropped"

echo "=== 0152: live or replay from flags, the first airing and league hours (C-I) ==="
python3 - <<'PY3' || FAIL=1
import sys
s = open('server/db/sqlite.js').read()
if not (s.index('ADD COLUMN flags') < s.index("DROP VIEW epg_live") < s.index('CREATE VIEW IF NOT EXISTS epg_live')):
    print("  ✗ the flags column and the view drop must come before the view is created"); sys.exit(1)
print("  ✓ the flags column is added, and a stale view dropped, before epg_live is created")
PY3

echo "=== 0155: a viewer joins a running tuner whose output it can play ==="
check_absent server/services/playbackStrategy.js "ac3: true, eac3: true, flac: false, heaac: true" "RECORDING_CAPABILITIES still without heaac"

echo "=== 0156: schedule observability and recent problems ==="
check_absent server/services/recordingEngine.js "scheduledDb.setStatus(schedule.id, 'missed'" "the missed paths go through it too, not straight to the db"

echo "=== 0162: stale/out-of-window ESPN data must never manufacture a replay (C-I) ==="
check_absent server/services/sportsFixtures.js "function mergeFixtures(" "cricket is a full replace too, so a postponed game does not linger"

echo "=== 0171: the channel linker (multi-provider P3) ==="
check_absent server/services/channelLinks.js "url_data," "the linker never reads a backup's stream URL"

echo "=== 0174: resolve failover, breaker, quarantine, C-J (multi-provider P6) ==="
check docs/CLIENT-CONTRACT.md "### C-J. Provider on resolve" "C-J is written down"

echo "=== 0182-0187: one Providers section, six tabs, sport lists, the build number ==="
python3 - <<'PY' || FAIL=1
import sys
s = open('server/routes/sources.js').read()
if s.index("router.put('/order'") > s.index("router.put('/:id'"):
    print("  ✗ PUT /order is registered after PUT /:id, which would swallow it"); sys.exit(1)
print("  ✓ PUT /order is registered before PUT /:id")
PY
python3 - <<'PY' || FAIL=1
import re, sys, subprocess
m = re.search(r"const BUILD = '(\d{4})';", open('server/version.js').read())
if not m:
    print("  ✗ server/version.js has no well-formed `const BUILD = 'NNNN';` (the next build number is read from it)"); sys.exit(1)
print(f"  ✓ version.js has a well-formed build ({m.group(1)}); the next build is one more")
PY

echo "=== R12: channel warming (off by default) ==="
check scripts/relay-rig.js "relay-rig.js standby stall" "and a real-ffmpeg rig"

echo "=== 0191: reconnect timestamp loop, blank pictures, raw captures ==="
check scripts/stream-doctor.js "function rawFetch(" "capture keeps the provider's raw bytes"

echo "=== 0192: recording codec probe reads ffprobe JSON (audit R02) ==="
check_absent server/services/recordingEngine.js "const \[type, name\] = line.split(',');" "never by CSV column position"
check .github/workflows/test.yml "uses: ./.github/actions/setup-media-tools" "CI selects the pinned production media recipe, so real-media tests run"

echo "=== 0193: recordings prepared ahead of Play; verified compression (audit R06, R08) ==="
check_absent server/services/recordingEngine.js "const durationOk = !sourceDuration || !newDuration" "an unreadable length no longer passes verification"

echo "=== 0194: recordings routes read files asynchronously (audit R09) ==="
check_absent server/routes/recordings.js "fs.statSync(" "no synchronous stat in a recordings request"
check_absent server/routes/recordings.js "fs.existsSync(" "no synchronous existence check in a recordings request"
check_absent server/routes/recordings.js "fs.readFileSync(" "no synchronous read in a recordings request"

echo "=== 0195: sport events built on a worker thread (audit R09) ==="
check_absent server/services/sportsEvents.js "runBuild(bucket, key, decorateChannels);" "no synchronous rebuild on the serving loop"

echo "=== 0196: media always needs a signed-in user; handles only (audit R01) ==="
check_absent server/auth.js "streamAuthFromSettings" "no setting turns it off"

echo "=== R17: hardened image ==="
check Dockerfile "FROM ubuntu:24.04 AS builder" "multi-stage build: compilers live in a builder stage"
check Dockerfile "COPY --from=builder /app/node_modules" "runtime takes node_modules from the builder"
check_absent Dockerfile "chmod 777" "no world-writable folders"
check Dockerfile "HEALTHCHECK" "image declares a healthcheck"
check Dockerfile "api/health" "healthcheck uses /api/health"
check Dockerfile 'ENTRYPOINT \["/app/docker/entrypoint.sh"\]' "entrypoint drops privileges before node"
check docker/entrypoint.sh 'PUID="${PUID:-99}"' "PUID defaults to 99"
check docker/entrypoint.sh 'PGID="${PGID:-100}"' "PGID defaults to 100"
check docker/entrypoint.sh "setpriv" "privileges dropped with setpriv"
check docker/entrypoint.sh 'exec setpriv' "node is exec'd so SIGTERM reaches it"
check_absent docker/entrypoint.sh 'chown -R .*recordings' "the recordings share is never chowned"
check package.json '"node": ">=24' "engines matches the Node version CI tests (D-52)"
check server/services/dbBackup.js "VACUUM INTO ?').run(workerData.dest)" "database backup is a consistent SQLite copy, VACUUM INTO (R12; compact since 0489), never a plain file copy"
check docs/OPERATIONS.md "Restore" "restore procedure documented"
python3 - <<'PY' || FAIL=1
import re, sys
d = open('Dockerfile').read()
runtime = d[d.rindex('FROM ubuntu:24.04\n'):]
bad = [t for t in ('build-essential', 'g++', 'python3', 'autoconf', 'libtool', '-dev ') if re.search(r'^\s*' + re.escape(t), runtime, re.M)]
if bad:
    print("  ✗ the runtime stage installs build tools:", bad); sys.exit(1)
print("  ✓ the runtime stage installs no compilers or -dev packages")
PY

echo "=== 0203: TS captures; audio re-encoded and decode-checked ==="
check_absent server/services/recordingEngine.js "'-f', 'matroska'," "not Matroska (one audio config per file)"

echo "=== simplification build ==="
check_absent server/routes/info.js "safely(" "no switchable feature flags left to guard"
check .github/workflows/test.yml "continue-on-error: true" "and run in their own non-blocking job"

# 0306: placement/build invariants, beyond the executable media-tool tests.
python3 - <<'MEDIA_CHECK' || FAIL=1
from pathlib import Path
import sys
image = Path('Dockerfile').read_text()
workflow = Path('.github/workflows/docker-publish.yml').read_text()
try:
    assert 'FROM ubuntu:24.04 AS media-build' in image
    assert 'COPY --from=media-build /opt/pigtv-ffmpeg /opt/pigtv-ffmpeg' in image
    assert 'ENV PATH="/opt/pigtv-ffmpeg/bin:${PATH}"' in image
    assert 'node /media-check/scripts/check-media-tools.js --hardware' in image
    build = workflow.index('name: Build candidate without publishing')
    test = workflow.index('name: Test candidate runtime')
    publish = workflow.index('name: Publish validated candidate')
    assert build < test < publish
    assert 'push: false' in workflow[build:test] and 'load: true' in workflow[build:test]
    assert 'push: true' not in workflow
    assert '--user 99:100' in workflow[test:publish] and 'HOME=/tmp' in workflow[test:publish]
    assert '--tmpfs /app/data:rw,uid=99,gid=100' in workflow[test:publish]
    assert 'npm test' in workflow[test:publish] and 'pigtv:candidate -c' in workflow[test:publish]
    assert 'docker tag pigtv:candidate' in workflow[publish:] and 'docker push' in workflow[publish:]
    print('  ✓ pinned media binaries are selected and the final candidate is tested before publication')
except (AssertionError, ValueError):
    print('  ✗ pinned media runtime or candidate publication gate is missing/misplaced'); sys.exit(1)
MEDIA_CHECK

# 0291: retired, unreferenced web scripts and server entry points must stay gone.
for retired in public/js/auth.js public/js/login.js; do
    if [ -e "$retired" ]; then
        echo "  ✗ STILL PRESENT: retired script $retired"; FAIL=1
    else
        echo "  ✓ retired script $retired stays gone"
    fi
done
check_absent server/auth.js "verifyToken" "retired verifyToken stays gone"
check_absent server/auth.js "requireRole" "retired requireRole stays gone"
check_absent server/services/epgParser.js "getCurrentAndUpcoming" "retired getCurrentAndUpcoming stays gone"
check_absent server/services/epgParser.js "getProgrammesForChannel" "retired getProgrammesForChannel stays gone"
check_absent server/services/streamCoordinator.js "releaseOwnerElsewhere" "retired releaseOwnerElsewhere stays gone"
check_absent server/services/streamCoordinator.js "liveViewers" "retired liveViewers stays gone"
check_absent server/services/streamCoordinator.js "staleStreams" "retired staleStreams stays gone"
check_absent server/services/streamRelay.js "closeForOwner" "retired closeForOwner stays gone"
check_absent server/services/dbBackup.js "stopNightly" "retired stopNightly stays gone"

echo "=== 0506: no break detection during capture (#271) ==="
# Every recording is segmented and live detection never ran for one: detection runs once the recording has finished.
if grep -rn "detectLive\|startLiveDetection\|liveCaptureEnded" server | grep -q .; then
    echo "  ✗ STILL PRESENT: live break detection is referred to under server/"; FAIL=1
else
    echo "  ✓ no live break detection under server/"
fi

echo "=== 0507: no part-based capture path (#271) ==="
# Every recording is segmented; recordings the old path made are still read, never made.
if grep -rn "PIGTV_PART_RECORDINGS\|finalizeRecording\|waitForNextPart" server test | grep -q .; then
    echo "  ✗ STILL PRESENT: the part-based capture path is referred to under server/ or test/"; FAIL=1
else
    echo "  ✓ no part-based capture path under server/ or test/"
fi

# Documentation size budgets (30 Oct reset, decision D-22): warnings only, never a failure. A warning means
# something probably belongs elsewhere; it is never a reason to cut useful detail.
echo "=== Doc size budgets (warnings only) ==="
python3 - <<'PY'
import glob
def lines(p):
    with open(p, encoding='utf-8', errors='replace') as f:
        return sum(1 for _ in f)
# D-47: the client contract is one reference read end to end (1,200); evidence from before 7 Nov 2026 is frozen history.
budget = {'AGENTS.md': 120, 'ROADMAP.md': 150, 'docs/CLIENT-CONTRACT.md': 1200}
docs = [f for f in glob.glob('*.md') + glob.glob('docs/**/*.md', recursive=True)
        if not f.startswith(('docs/archive/', 'docs/evidence/'))]
warnings = []
for f in sorted(docs):
    n, limit = lines(f), budget.get(f, 600)
    if n > limit: warnings.append(f"{f}: {n} lines (budget {limit})")
for f in sorted(glob.glob('docs/evidence/*/README.md')):
    if f.split('/')[2][:10] < '2026-11-07': continue
    n = lines(f)
    if n > 40: warnings.append(f"{f}: {n} lines (budget 40)")
for w in warnings:
    print(f"  ⚠ WARNING (not a failure): {w}")
print(f"  ✓ size budgets checked ({len(warnings)} warning(s); AGENTS.md 120, ROADMAP.md 150, CLIENT-CONTRACT 1200, evidence README 40 from 7 Nov 2026, other docs 600)")
PY

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
