# Offline A/V start reproduction (FR-22), 28 Oct 2026

A synthetic live feed through the production session's exact ffmpeg command, into a local AVPlayer set up like the
Apple app (`configuredTimeOffsetFromLive` 30 s). No server, provider or device is involved.

1. Make a feed: `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60000/1001 -f lavfi -i sine=... -c:v libx264
   -profile:v high -level 4.2 -g 120 -bf 3 -c:a aac -f mpegts -muxrate 7000000 src.ts` (240 s; keyframes every 2.002 s).
2. Build the harness: `swiftc -O -swift-version 5 avsync.swift -o avsync`. Serve `www/` on 127.0.0.1:8899 with
   `python3 -m http.server`.
3. Run: `BURST=<head start s> ./run.sh <name> <start byte> [encode]`. `pace.js` sends the feed from that byte at its mux
   rate after the head start; `session.sh` is the 0300 session command from the 28 Oct log; the player starts when
   segment 0 exists, as the server answers.

Results (macOS 27 AVPlayer, local ffmpeg 9.0.2; production runs 6.1.1):

| Run | Join | Segment 0 (video / audio start) | Player |
|---|---|---|---|
| dry | at a keyframe | 0.073 / 0.000 s | (not played) |
| dry | mid-GOP | 0.710 / 0.000 s | (not played) |
| mid14 | mid-GOP, 2 s head start | 1.563 / 0.000 s | waited 3.35 s, then 60 s at rate 1.0, **0 stalls**; video on the player clock within 17 ms |
| mid14b12 | mid-GOP, 12 s head start | 1.563 / 0.000 s | started at 0.93 s, 60 s, **0 stalls**; video within 17 ms |

What this does and doesn't show:
- The production start gap is reproduced exactly: segment 0's sound starts up to one GOP before the picture.
- The gap plus the 30 s hold **does not make macOS AVPlayer pause**.
- The audio could not be measured: AVFoundation does not run an `MTAudioProcessingTap` on HLS (`tapCalls=0`). So
  "sound 1–2 s behind" is neither reproduced nor ruled out here.
- FOX's defect, an SPS declaring 4 reference frames while the stream uses 5, cannot be made with x264 (it declares what
  it uses).

## Real feed: FOX [Birmingham] 1080p on Strong8K, 28 Oct (Mark approved one 60 s capture)

One raw read, 01:44 UTC, with nothing else playing: 48.4 MB in 60 s (6.48 Mbit/s average), closed on schedule.
The read went to the container's `/tmp` (not the data volume); the copies on the container and the host were deleted
after transfer. The media stays in the session scratchpad and is **not** in the repo. Delivery was bursty: pauses of 6.6,
4.3, 7.9, 4.7, 4.7, 5.7, 7.7 and 5.7 s, about one every 6–8 s. The feed: H.264 High@4.2 1080p59.94 progressive, a
keyframe every 2.002 s, and the provider starts the stream on a keyframe. Audio: HE-AAC stereo 48 kHz.
`pace-pcr.js` replays it at the pace of its own PCR clock: `HEAD` seconds at once, then real time, or with `BURSTY=6`
in 6 s batches like the measured delivery.

| Run | Sound | Delivery | Player | Result |
|---|---|---|---|---|
| foxcopy | copied (`-c:a copy -bsf:a aac_adtstoasc`) | even | 30 s hold | **fails at 1.07 s: `CoreMediaErrorDomain error 1718449215` (`fmt?`)**, as on the iPhone |
| foxpatch | the same segments, init segment's AudioSpecificConfig changed `0b10` → `1310` | (all present) | 30 s hold | **plays** (status ready, rate 1.0) |
| foxenc | re-encoded AAC-LC (the retry) | 8 s head start, then 6 s bursts | 30 s hold | plays at 0.94 s, **stalls at 4.90 s**, waits 26 s, then plays; video on the clock within 15 ms |
| foxenc-nohold | re-encoded AAC-LC | 8 s head start, then 6 s bursts | AVPlayer default | plays at 1.20 s, stalls at 5.06 s, back in 1.7 s, stalls again at 18.80 s |

**FR-9, cause established offline.** Every ADTS frame of the feed (118 checked) has profile **0 = AAC Main**, 24 kHz,
with SBR implied. ffmpeg decodes it as HE-AAC, but `aac_adtstoasc` writes object type 1 (AAC Main) into the MP4,
and Apple does not decode AAC Main. Relabelling only that field as AAC-LC (object type 2, implicit SBR) makes the same
segments play.

**FR-22, the pause reproduced; the sound offset not measured.** A brand-new session's playlist holds only a few seconds.
The player starts at its very beginning and runs into Strong8K's delivery pauses within about 5 s, with or without the
30 s hold. The hold turns the stall into a 26 s wait; without it the wait is 1.7 s. The synthetic feed with even delivery
never stalled. Whether the sound comes back 1–2 s late after the stall can't be seen here (no audio tap on HLS).
