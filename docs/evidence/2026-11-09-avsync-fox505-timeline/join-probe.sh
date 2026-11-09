#!/usr/bin/env bash
# join-probe.sh <rig output dir>: for each segment listed in stream.m3u8, print per-stream first/last PTS
# and the audio-vs-video raggedness at both ends. fMP4 segments are probed with their leg's init.mp4.
set -u
dir="$1"
pl="$dir/stream.m3u8"
map=""
while IFS= read -r line; do
  case "$line" in
    \#EXT-X-MAP:*) map=$(sed -E 's/.*URI="([^"]+)".*/\1/' <<<"$line");;
    \#EXT-X-DISCONTINUITY) echo "---- EXT-X-DISCONTINUITY ----";;
    \#*) ;;
    "") ;;
    *)
      seg="$line"
      if [[ "$seg" == L* ]]; then leg="leg${seg:1:1}"; file="${seg#L?-}"; else leg="leg0"; file="$seg"; fi
      path="$dir/$leg/$file"
      [ -f "$path" ] || { echo "$seg: missing ($path)"; continue; }
      if [[ "$file" == *.m4s ]]; then
        initp="$dir/$leg/$(basename "$map" | sed -E "s/^L[0-9]+-//")"
        data=$(cat "$initp" "$path" | ffprobe -v error -show_entries packet=stream_index,pts_time -of csv=p=0 -f mp4 - 2>/dev/null)
      else
        data=$(ffprobe -v error -show_entries packet=stream_index,pts_time -of csv=p=0 "$path" 2>/dev/null)
      fi
      awk -F, -v seg="$seg" '
        $2!="N/A" && $2!="" { i=$1; v=$2+0; if(!(i in min)||v<min[i])min[i]=v; if(!(i in max)||v>max[i])max[i]=v; n[i]++ }
        END { printf "%-14s", seg; for(i=0;i<=1;i++) if(i in min) printf " s%d: %9.3f .. %9.3f (%4d pk)", i, min[i], max[i], n[i];
              if((0 in min)&&(1 in min)) printf "   start a-v %+6.3f  end a-v %+6.3f", min[1]-min[0], max[1]-max[0]; printf "\n" }' <<<"$data"
      ;;
  esac
done < "$pl"
