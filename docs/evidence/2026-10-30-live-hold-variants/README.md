# #7: four ways to hold back from the live edge at the start, 30 Oct 2026

**What:** `hold.swift` (macOS 27 AVPlayer, as the Apple app sets it up) plays the same live HLS four ways, side by side
(`run-variants.sh 600`): 10 min each, each on its own session made by the production ffmpeg command (`session.sh` from
[`../2026-10-28-avsync-start-repro/`](../2026-10-28-avsync-start-repro/README.md), ffmpeg 9.0.2 on the Mac). The feed is
synthetic (testsrc2 1080p59.94, x264 High@4.2, keyframe every 2.002 s, AAC, 7 Mbit/s mux rate), delivered by
`pace-pcr.js` as Strong8K delivered FOX on 28 Oct: an 8 s connect burst (`HEAD=8`), then 6 s batches (`BURSTY=6`).
No provider, server or device. The feed itself (577 MB) stays out of the repo.

| Variant | First picture | Stalls | Frozen (s) | Longest (s) | Stalls × frozen |
|---|---:|---:|---:|---:|---:|
| HOLD: `configuredTimeOffsetFromLive` 30 s (today) | 0.86 s | 1 | 26.0 | 26.0 | 26.0 |
| NOHOLD: AVPlayer's default | 0.86 s | 16 | 2.4 | 2.0 | 38.6 |
| RATE: 0.97× (pitch kept, `.timeDomain`) until 30 s behind, then 1.0 | 1.82 s | 1 | 0.9 | 0.9 | **0.9** |
| GROW: at the k-th stall, wait for min(4k, 30) s of buffer | 0.86 s | 3 | 8.0 | 5.9 | 24.1 |

Logs: `<VARIANT>.player.log` (one line per event, a status line every 10 s, `SCORE` last).

**What it shows:** every variant meets the first burst gap about 4–6 s in (a new session's playlist holds only a few
seconds). Today's hold turns it into a 26 s frozen picture, then never stalls again. Without a hold the picture stalls
every ~12 s for up to 2 s. RATE stalls once for 0.9 s, then builds buffer at ~1.8 s a minute (22 s after 9 min) and
never stalls again; it had not yet reached 30 s at 10 min (that takes ~17 min), so it was still at 0.97× when the run ended.
GROW stalls three times (2.0, 0.1, 5.9 s) before its buffer is deep enough.

**What it doesn't:** one run per variant; an even, regular burst pattern (real feeds vary); macOS, not tvOS or iOS;
whether 0.97× is noticeable (picture motion, commentary) was not judged: that is Mark's device check (T5). The audio
pitch algorithm was not listened to.
