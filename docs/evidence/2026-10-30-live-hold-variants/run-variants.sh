#!/bin/bash
# run-variants.sh [seconds]: the four #7 variants side by side (macOS), each on its own live session of the same
# bursty feed. Needs, in this folder: src.ts (the synthetic feed), and session.sh + pace-pcr.js from
# ../2026-10-28-avsync-start-repro (the production session command, fed at the feed's own PCR pace).
# BURSTY=6 HEAD=8 by default: an 8 s connect burst, then the data in 6 s batches (Strong8K's FOX delivery, 28 Oct).
R="$(cd "$(dirname "$0")" && pwd)"; RUN=${1:-600}
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" # ssh sessions skip the login profile
export PACER=pace-pcr.js SRC=src.ts BURSTY=${BURSTY:-6} HEAD=${HEAD:-8}
[ -x "$R/hold" ] || swiftc -O -swift-version 5 "$R/hold.swift" -o "$R/hold" || exit 1
mkdir -p "$R/www"
(cd "$R/www" && exec python3 -m http.server 8899 --bind 127.0.0.1 >/dev/null 2>&1) &
HTTP=$!
one() {
    local V=$1 OUT="$R/www/$1"
    rm -rf "$OUT"; mkdir -p "$OUT"
    # the server's master playlist (buildMasterPlaylist)
    printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=59.940,VIDEO-RANGE=SDR\nstream.m3u8\n' > "$OUT/master.m3u8"
    "$R/session.sh" "$OUT" 0 > "$R/$V.ffmpeg.log" 2>&1 &
    local i
    for i in $(seq 1 200); do grep -q "seg0000" "$OUT/stream.m3u8" 2>/dev/null && break; sleep 0.1; done
    grep -q "seg0000" "$OUT/stream.m3u8" 2>/dev/null || { echo "$V: no first segment in 20 s (see $V.ffmpeg.log)"; return 1; }
    echo "$V: first segment after ~$((i * 100)) ms"
    VARIANT=$V "$R/hold" "http://127.0.0.1:8899/$V/master.m3u8" "$RUN" > "$R/$V.player.log" 2>&1
}
PIDS=()
for V in HOLD NOHOLD RATE GROW; do one "$V" & PIDS+=($!); done
wait "${PIDS[@]}"
pkill -f "$R/pace-pcr.js"; kill "$HTTP" 2>/dev/null; sleep 1
grep -h "^SCORE" "$R"/*.player.log
