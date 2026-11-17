# A profiled start's analysis window (#240, 17 Nov 2026)

A play from a stored channel profile skipped ffprobe but ffmpeg still ran its own 5 MB / 5 s analysis before the first
segment. From this batch a profiled start runs with **5 MB / 2 s**; a start that ends before its first segment with it
(for a reason that is not the provider's) runs once more with the full window, and a channel that needed that keeps the
full window in its profile.

## The bench (T2)

`node scripts/stream-doctor.js bench --window <samples…>`, ffmpeg 8.0.1 on WSL (production runs ffmpeg 9: see below).
20 kept samples from the channel audit (15–16 Nov) and the 14 Nov Fox Footy capture, chosen to cover HDR10 4K 50 fps,
1080p50 and 720p/1080p 59.94 sport, 1080i50 and 576i, HE-AAC (four), AC-3, E-AC-3, MP2 with DVB subtitles, teletext and
data streams, a six-program feed, uneven timestamps (four) and GOPs from 1 to 10 s. Each sample is cut at two join
points: **start** (the capture's first byte, which is what a new provider connection gives: 19 of 20 start on a key
frame) and **third** (a third of the way in: anywhere in a GOP, the worst case; a reader joining a running shared feed
starts on a key frame since #3). Each cut is fed on stdin, as the shared ingest feeds a session, to the server's own
session arguments in both shapes (fMP4 copying audio and video; MPEG-TS copying video and encoding audio), once per window:

- at full speed, comparing what comes out with the full window's output: video codec, size, pixel format, colour
  transfer, frame rate; audio codec, profile, rate, channels; the video timestamps' evenness; the A/V start offset;
- paced to the sample's own byte rate with no initial burst, timing the first listed segment (seconds, fMP4 / MPEG-TS).

"none" is no segment within 25 s; **no output** / **differs** mark a window whose result is not the full window's.

| Sample | GOP | Join | full 5 s | 2 s | 1 s | 0.5 s |
|---|---|---|---|---|---|---|
| 720p50 sport (Fox Footy capture), AAC | 2.0 s | start | 6.3 / 6.3 | 5.4 / 5.4 | 5.4 / 5.4 | 5.4 / 5.5 |
| 720p50 sport (Fox Footy capture), AAC | 2.0 s | third | 5.0 / 5.0 | 4.3 / 4.3 | none / 4.3 **no output** | none / 4.3 **no output** |
| 720p30, AC-3 with 0 channels | 2.5 s | start | none / none | none / none | none / none | none / none |
| 720p30, AC-3 with 0 channels | 2.5 s | third | none / none | none / none | none / none | none / none |
| 540p30, 6 programs, HE-AAC | 4.1 s | start | 4.6 / 4.6 | 4.6 / 4.6 | 4.6 / 4.6 | 4.6 / 4.6 |
| 540p30, 6 programs, HE-AAC | 4.1 s | third | 4.6 / 4.6 | 4.6 / 4.6 | 4.6 / 4.6 | 4.6 / 4.6 |
| 576i50, MP2 + DVB subs | 1.0 s | start | 6.4 / 6.5 | 6.3 / 6.3 | 6.3 / 6.3 | 6.3 / 6.3 |
| 576i50, MP2 + DVB subs | 1.0 s | third | 5.1 / 5.2 | 4.8 / 4.8 | 4.8 / 4.8 | none / 4.9 **no output** |
| 1080p30, AAC 5.1 | 1.0 s | start | 4.5 / 4.5 | 4.1 / 4.2 | 4.1 / 4.2 | 4.2 / 4.2 |
| 1080p30, AAC 5.1 | 1.0 s | third | 5.4 / 5.5 | 5.1 / 5.2 | 5.1 / 5.2 | none / 5.2 **no output** |
| 576i25, 2× MP2 + teletext + data | 1.1 s | start | 17.6 / 17.7 | 17.6 / 17.7 | 3.0 / 2.5 | 3.0 / 2.5 |
| 576i25, 2× MP2 + teletext + data | 1.1 s | third | 16.6 / 16.7 | 16.6 / 16.7 | 16.6 / 16.7 | none / 16.7 **no output** |
| 1080p25 HEVC, 10 s GOP | 10.0 s | start | 9.7 / 9.7 | 9.7 / 9.7 | 9.7 / 9.7 | 9.7 / 9.7 |
| 1080p25 HEVC, 10 s GOP | 10.0 s | third | 11.8 / 11.8 | 11.8 / 11.8 | none / 11.8 **no output** | none / 11.8 **no output** |
| 720p59.94, AAC | 2.0 s | start | 5.5 / 5.5 | 4.9 / 4.9 | 4.9 / 4.9 | 4.9 / 4.9 |
| 720p59.94, AAC | 2.0 s | third | 5.7 / 5.6 | 5.6 / 5.6 | none / 5.7 **no output** | none / 5.6 **no output** |
| 1080p50 sport, AAC | 2.2 s | start | 7.1 / 7.1 | 6.3 / 6.3 | 6.4 / 6.3 | 6.3 / 6.4 |
| 1080p50 sport, AAC | 2.2 s | third | 5.3 / 5.3 | none / 4.9 **no output** | none / 4.9 **no output** | none / 4.9 **no output** |
| 480p29.97, 4 s GOP | 4.0 s | start | 6.3 / 6.3 | 5.1 / 5.1 | 5.2 / 5.1 | 5.2 / 5.1 |
| 480p29.97, 4 s GOP | 4.0 s | third | 6.4 / 6.4 | 6.4 / 6.3 | none / 6.4 **no output** | none / 6.4 **no output** |
| 720p59.94, HE-AAC, uneven | 2.0 s | start | 5.3 / 5.3 | 4.3 / 4.3 | 4.3 / 4.3 | 4.3 / 4.3 |
| 720p59.94, HE-AAC, uneven | 2.0 s | third | 5.5 / 5.5 | 4.8 / 4.8 | 4.8 / 4.8 | 4.8 / 4.8 **differs, differs** |
| 1080p59.94, 2× HE-AAC + subs | 2.0 s | start | 5.2 / 5.2 | 4.3 / 4.3 | 4.3 / 4.3 | 4.3 / 4.3 |
| 1080p59.94, 2× HE-AAC + subs | 2.0 s | third | 4.9 / 4.9 | 4.5 / 4.5 | 4.5 / 4.5 | none / 4.5 **no output** |
| 1080i50, MP2 + subs + data | 1.0 s | start | 6.5 / 6.6 | 6.5 / 6.6 | 6.5 / 6.6 | 5.0 / 5.0 |
| 1080i50, MP2 + subs + data | 1.0 s | third | 6.5 / 6.6 | 6.5 / 6.6 | 4.7 / 4.7 | none / 4.7 **no output** |
| 2160p50 HEVC HDR10 (PQ), E-AC-3 5.1 | 5.8 s | start | 6.3 / 6.3 | 6.3 / 6.3 | 6.3 / 6.3 | 6.3 / 6.3 |
| 2160p50 HEVC HDR10 (PQ), E-AC-3 5.1 | 5.8 s | third | 4.3 / 4.3 | 4.3 / 4.3 | 4.3 / 4.3 | none / 4.3 **no output** |
| 1080p29.97, AAC, uneven | 2.0 s | start | 4.4 / 4.4 | 3.8 / 3.8 | 3.8 / 3.8 | 3.8 / 3.8 |
| 1080p29.97, AAC, uneven | 2.0 s | third | 7.0 / 7.0 | 7.0 / 7.0 | none / 7.0 **no output, differs** | none / 7.0 **no output, differs** |
| 1080p50, AAC + subs | 1.9 s | start | 5.8 / 5.8 | 5.9 / 5.8 | 5.8 / 5.8 | 5.8 / 5.8 |
| 1080p50, AAC + subs | 1.9 s | third | 3.5 / 3.4 | 2.8 / 2.9 | 2.9 / 2.8 | 2.9 / 2.9 |
| 1080p59.94, HE-AAC + subs | 2.0 s | start | 5.0 / 5.0 | 4.1 / 4.1 | 4.1 / 4.1 | 4.1 / 4.1 |
| 1080p59.94, HE-AAC + subs | 2.0 s | third | 5.5 / 5.5 | 4.9 / 4.9 | 4.9 / 4.9 | 4.9 / 4.9 |
| 1080p50, AAC | 2.0 s | start | 4.6 / 4.6 | 3.7 / 3.7 | 3.7 / 3.7 | 3.7 / 3.7 |
| 1080p50, AAC | 2.0 s | third | 5.2 / 5.2 | 4.8 / 4.8 | 4.8 / 4.8 | 4.8 / 4.8 |
| 1080p30, AAC 5.1, uneven | 1.0 s | start | 6.2 / 6.3 | 5.3 / 5.3 | 5.3 / 5.3 | 5.3 / 5.3 |
| 1080p30, AAC 5.1, uneven | 1.0 s | third | 8.0 / 8.0 | 7.4 / 7.5 | 7.4 / 7.5 | none / 7.5 **no output** |
| 1080p30, AAC 5.1 | 1.0 s | start | 4.0 / 4.1 | 3.4 / 3.3 | 3.3 / 3.3 | 3.4 / 3.4 |
| 1080p30, AAC 5.1 | 1.0 s | third | 4.7 / 4.8 | 4.0 / 4.0 | 4.0 / 4.1 | 4.0 / 4.0 |

| Window | Runs (of 80) not the same as the full window | First segment earlier than the full window: start joins | third joins |
|---|---|---|---|
| 2 s | 1 (no output: mid-GOP join, GOP 2.2 s) | mean 0.51 s, median 0.60 s, max 1.19 s, none failed | mean 0.30 s, 1 failed |
| 1 s | 7 (6 no output; 1 **silent**: an uneven feed's MPEG-TS output had 331 timing outliers and 166 warnings, against 1) | mean 1.29 s (one outlier of 15 s), median 0.73 s | mean 0.44 s, 6 failed |
| 0.5 s | 16 (adds an uneven 59.94 fps HE-AAC feed read as 60/1 with 229 timing outliers) | median 0.58 s | — |

**Choice: 2 s.** It changed nothing in any output, on any sample, at either join point. 1 s and 0.5 s are faster on a
few feeds but damage timing silently on a mid-GOP join, which no fallback can see. The one 2 s failure (no picture size
before the window ended, then `Could not write header`) is what the full-window retry is for. One sample fails in every
window (an AC-3 track that reports 0 channels): the window does not change it.

The gain is modest and feed-dependent: nothing where ffmpeg finds every stream quickly (HDR 4K, the six-program feed),
0.4–1.2 s where a subtitle, teletext, data or HE-AAC stream keeps the analysis going. The issue's estimate of 2–3 s
assumed ffmpeg always used the full 5 s; it stops as soon as every stream is known.

## Rig-free check (T2)

`test/analysis-window-start.test.js`: the fake provider's real MPEG-TS through a real session and ffmpeg, a channel of
its own per start: first segment **5.21 s full, 4.21 s short** (twice each), the same streams and parameters.

## Not checked yet

- ffmpeg 9.0.2 (production container, 17 Nov, Mark's OK, local files only, nice 10): 320 runs. 5 MB / 2 s gave the
  same output on 79 of 80 runs; the one difference is the same mid-GOP cut with no output that the full-window retry
  covers. 1 s and 0.5 s again failed mid-GOP cuts and damaged one uneven feed's timing. Mean first segment 6.00 s
  (2 s) vs 6.40 s (5 s).
- A real feed through the new arguments (the 0085 rule): plays of profiled channels after the Force Update, comparing
  `resolve timing … first segment` lines that end `, analysis window short` with earlier ones; any
  `analysis window full after the short one failed` line names a channel that needed the fallback.
- How much of the window a real provider connection's opening burst already hides (the bench paces with no burst).
