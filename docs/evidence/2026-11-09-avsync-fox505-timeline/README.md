# Fox Sports 505 on iPad: sound out of step after ~30 min (#3), 9 Nov 2026

Mark's report (9 Nov, evening AEDT): Fox Sports 505 on the iPad, sound and picture out of step about 30 minutes into
the programme; leaving the stream and coming back put it right. Production was on **0501** (ffmpeg 9.0.2); relay,
hot standby and shared ingest on, renewal off (D-25). No code changed. This folder holds what the log says happened,
and an offline measurement of the one server-side event in that play. Times are UTC (AEDT = UTC + 11).

## The 34-minute play, from the production log (read-only)

Every session in it: `-c:v copy -c:a copy -bsf:a aac_adtstoasc`, fMP4, 4 s segments, source timing **even** (no
`igndts`), 50 fps, master playlist SDR. The log names the device, not the platform; the device id is the iPad's.

| Time | Minutes in | What |
|---|---:|---|
| 08:34:02 | 0:00 | Play starts on Strong8K (first picture 5.6 s); hot standby running on Dream 4K from 08:34:29. |
| 08:47:44 | 13:42 | Strong8K **ends the stream**; the ingest's reconnect is refused (HTTP 407). |
| 08:47:54 | 13:52 | Relay **promotes the Dream 4K standby** ("now on Dream 4K after 0.0 s"): an `EXT-X-DISCONTINUITY`, a new init segment, a different provider's feed. Standbys then come and go (Trex stalls at 08:51; Strong8K standby from 08:58). |
| 09:07:38 | 33:36 | Dream 4K's feed is **24 s behind real time**; its ffmpeg writes nothing for 25 s and is released; the Strong8K standby is not ready; the takeover does not produce a segment in time. |
| 09:08:06 | 34:04 | iPad: `media-error` at t=2010 s, `play-end watched=2042 s stalls=1`. The app reconnects (09:08:27, Strong8K). |

Later plays: 09:08:27–09:15:36 (7 min, lost to a Strong8K lag stall, `stalls=1`); 09:15:50–09:20:38 (5 min,
`stalls=2`, stopped by the client); 09:21:40 onwards on Dream 4K as primary (Strong8K quarantined), which Mark reports
in step at its start. So the stretch Mark watched out of step lies between the standby promotion at 13:52 and the end
at 34:04, on Dream 4K's feed, played through the relay's discontinuity.

Two things in that play are candidates, and nothing else in the log is:

1. **The relay join at 13:52** (server event; measured below).
2. **The player's own catch-up** (Apple build 72, 30 Oct): a live play runs at **0.97×** with `audioTimePitchAlgorithm
   .timeDomain` until it is 30 s behind the edge, then 1.0 (about the first 10–17 minutes of every play). Both
   platforms do this; the web plays at 1.0. Not measured anywhere yet: the macOS harness has no audio tap on HLS.

## What the relay's joined output looks like (relay rig, offline, ffmpeg 8.0.1 on WSL)

`scripts/relay-rig.js standby stall long` and `standby long` (provider A closes, as Strong8K did) with `RIG_OUTPUT`
set; `join-probe.sh <output dir>` (kept here) reads every listed segment with ffprobe (fMP4 with its leg's init) and
prints each track's first and last PTS and the audio-minus-video difference at both ends.

| Case | Old leg's last listed segment | Join | New leg's first listed segments |
|---|---|---|---|
| A stops sending (stall) | `seg0010`, full 4 s: start a−v +0.008 s, end +0.019 s | `#EXT-X-DISCONTINUITY`, `#EXT-X-MAP` L1 | `L1-seg0004…`: a−v +0.002 … +0.039 s at every edge |
| A closes the stream | `seg0011`, **1.48 s flushed**: start +0.002 s, end **−0.138 s** (audio ends 0.14 s before video) | same | `L1-seg0001…`: a−v +0.002 … +0.039 s at every edge |

Within every segment on both sides the tracks start and end within 40 ms of each other; the only raggedness is the
flushed final segment's 0.14 s. A player that lines each track's first sample up with the discontinuity boundary
would be off by at most that. The feeds are synthetic (regular TS from two ffmpeg generators); a real provider's
interleaving can leave a flushed last segment more ragged, which a captured sample through `RIG_SAMPLE` would show.

**So:** the server's output across a hot-standby promotion is in step. If the iPad alone drifts after such a join,
or during the 0.97× phase, the cause is in the player's handling, which only a measurement on the device can show.

## Not yet measured, and how to

- **Objective A/V offset on the iPad.** The fake provider's picture already carries a per-frame clock (`drawtext
  %{localtime}`); give one TEST channel an audible marker (a short beep on each second), play it from the Unraid rig
  through a forced standby switch (`POST /fake/fail?stream=<id>&mode=close|stall`) and a lag stall, record the iPad
  over USB with QuickTime (picture and sound), and read the offset over time from the recording. This tells join from
  catch-up from drift with no guessing.
- **Where it starts, in production.** A Labs button in the player ("Sound out of step") posting a client event with
  the position, the rate, the stall count and the behind-live distance; the server logs it next to the relay's leg
  history, so a report lands on a timeline like the one above without reading the log by hand.
- **Rule the feed out cheaply.** When the iPad is out of step, open the same channel on the Apple TV or the web at
  once: the shared ingest means no second provider connection. In step there ⇒ not the feed.
