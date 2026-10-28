#!/bin/bash
# run.sh <name> <startByte> [encode]: one live session + one AVPlayer measurement (60 s).
R="$(cd "$(dirname "$0")" && pwd)"
NAME="$1"; OUT="$R/www/$NAME"; mkdir -p "$OUT"
# the server's master playlist (buildMasterPlaylist): no CODECS, FRAME-RATE and VIDEO-RANGE
printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=59.940,VIDEO-RANGE=SDR\nstream.m3u8\n' > "$OUT/master.m3u8"
"$R/session.sh" "$OUT" "$2" $3 > "$R/$NAME.ffmpeg.log" 2>&1 &
for i in $(seq 1 100); do grep -q "seg0000" "$OUT/stream.m3u8" 2>/dev/null && break; sleep 0.1; done
echo "first segment after ~$((i*100)) ms"
"$R/avsync" "http://127.0.0.1:8899/$NAME/master.m3u8" 60 > "$R/$NAME.avsync.log" 2>&1
pkill -f "pace.js $R/src.ts $2"; sleep 1
cat "$OUT/init.mp4" "$OUT/seg0000.m4s" > "$R/$NAME.seg0.mp4"
echo "$NAME seg0: v=$(ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$R/$NAME.seg0.mp4" | head -1) a=$(ffprobe -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 "$R/$NAME.seg0.mp4" | head -1)"
