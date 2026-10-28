#!/bin/bash
# session.sh <outdir> <startByte> [encode]: the production session command (0300 log, 28 Oct), fed by pace.js.
R="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; START="$2"; mkdir -p "$OUT"
AUDIO=(-c:a copy -bsf:a aac_adtstoasc)
[ "$3" = encode ] && AUDIO=(-c:a aac -profile:a aac_low -ar 48000 -b:a 128k)
node "$R/pace.js" "$R/src.ts" "$START" | ffmpeg -hide_banner -loglevel warning -probesize 5000000 -analyzeduration 5000000 \
  -fflags +genpts+discardcorrupt -err_detect ignore_err -dts_delta_threshold 60 -i pipe:0 -map 0:v:0 -map '0:a:0?' \
  -c:v copy "${AUDIO[@]}" -avoid_negative_ts make_zero -max_interleave_delta 0 -f hls -hls_time 4 -hls_list_size 90 \
  -hls_delete_threshold 12 -hls_flags independent_segments+delete_segments+temp_file -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$OUT/seg%04d.m4s" "$OUT/stream.m3u8"
