# #3: a play that joins a running feed started with sound before the picture (server 0578, 0579)

Mark, 12 Nov, production on 0577: Fox Cricket 501 out of step on the iPad from the start of a play. The web app, on
the same kind of start, was in step. After a 30 s wait before going back in, the iPad was in step.

## What production showed (read-only: the log and the live session's files)

Four plays in four minutes shared one feed: each began inside the 10 s the server keeps a feed open after its last
viewer. The first opened the feed; the next three joined it while it ran, and each logged decode warnings at its
start. A fifth play, after the wait, opened a new feed.

| Play | Feed | First segment: sound starts | picture starts | iPad |
|---|---|---:|---:|---|
| 4 | joined while running | 0.000 s | 1.149 s | out of step |
| 5 | new | 0.000 s | 0.040 s | in step |

Later segments were 40 ms apart in both. Nothing in the join, the session's ffmpeg arguments or the strategy changed
between v0502 and 0577 (`git diff`), so this was not new in that release.

## Cause and fix

A joiner was started at the last PAT in the feed's final 2 s, anywhere in a group of pictures; the copy session
writes sound from the first packet and picture from the next key frame. Since 0579 a joiner gets the newest PAT and
PMT, then the stream from the newest video key frame (`tsKeyframes.js`). No key frame found, or a backlog over half
the slow-reader limit: the old join. The first viewer on a feed and ffmpeg's arguments are unchanged.

## Measurements (sound ahead of picture at the start of the first segment, seconds)

A 60 s capture of the real feed (taken with Mark's yes; 720p50, a key frame every 2.24 s, a new connection starts on
one; kept outside Git, SHA-256 `e073813c173120ad…`), five joins across one group of pictures, and the rig's fake feed
(a key frame every 2.0 s), an opener and five joiners:

| | opener | 1 | 2 | 3 | 4 | 5 |
|---|---:|---:|---:|---:|---:|---:|
| Capture, 0577 | | 1.106 | 0.765 | 0.616 | 0.040 | 1.789 |
| Capture, 0579 | | 0.082 | 0.082 | 0.082 | 0.040 | 0.040 |
| Rig, 0577 | 0.021 | 0.784 | 1.179 | 1.526 | 1.237 | 0.267 |
| Rig, 0579 | 0.021 | 0.149 | 0.251 | 0.304 | 0.064 | 0.117 |

What is left is the feed's own muxing (one audio packet written whole beside the key frame), the same as a new
connection gets. On the rig a joiner's first segment came about 1.4 s sooner, its decode warnings went from 2 to 22
a play to none, and a recording that joined the feed started 0.2 s apart and played back.

## Reviews, gates

- Codex round one on 0578: 2 highs (media before the key frame still sent; a high-bitrate backlog ended the joiner
  at once). Opus: no high, the second of those as a medium (reproduced), 8 lows; 22,000 fuzzed inputs, no throw;
  1.6 ms a join on the real feed, 8.4 ms at 25 Mb/s. Fixed in 0579.
- Codex sign-off on 0579: 2 highs and a medium, all edge cases (the fallback has no byte budget; a part-sent new
  PMT paired with the old one; a repeated table packet). Taken to Mark, who chose ship and file: #309, with the
  high-bitrate limit (about 25 Mb/s with key frames over 2.7 s apart keeps the old join).
- `npm test` on 0579: 2,284 tests, 2,272 pass, 8 skipped, 4 fail on the build machine only. `verify-build.sh` passes.
  CI green on `48174c4`.

Not explained: Mark recalls play 1 (a new feed) going out of step almost at once; its files were gone. Not measured:
what AVPlayer does with the 0.04 to 0.3 s that is left.
