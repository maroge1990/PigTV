# FOX Kansas City A/V incident — 29 October 2026

Status: recovery failure established; cause of reported A/V offset remains unproven. No playback flags, settings or product code changed.

## Live configuration and user evidence

Deployed build **0315 / 8953d12**, FFmpeg **9.0.2**. Read-only `app_settings` query confirms relay, shared ingest,
hot standby and experimental reconnect timeline renewal are all enabled. Channel: **FOX [Kansas City] 720p**,
Strong8K, source 8 / `pos_11`. Mark reports this occurred on **iPad**, with approximately **1–2 seconds** of A/V offset,
matching prior incidents. He then reports playback stopped entirely, required a relaunch, and returned **in sync**.
Offset direction was not explicitly confirmed in this incident. User-authorized SSH reads and cache copying did not
open a provider connection. Mark subsequently authorized raw capture, but none was started because the affected
play had already ended; a new short capture would only sample the recovered state.

## Observed sequence (AEDT, UTC+11)

| Time | Evidence |
|---|---|
| 13:04:49 | Original session `5bb847040d0ac8e3` follows Strong8K; cached profile says even timestamps; audio and video copied. |
| 13:18:04 | Ingest is ~25 seconds behind real time and reconnects. |
| 13:18:12 | Reconnect succeeds after 8.5 seconds. Experimental renewal stops the original ffmpeg. |
| 13:18:18 | Replacement `d5b648dfdd5fc17c` starts against the same ingest. |
| 13:18:33 | Replacement never produces a playlist within its remaining deadline; relay ends. This is a failed renewal, not a successful seamless switch. |
| 13:18:40 | iPad reports one stall and a media error after ~798 seconds watched. |
| 13:18:42 | Same ingest reconnects again. |
| 13:18:44–45 | Restart `d39f4c846fbb2536` uses a fresh probe: now classified uneven, enabling the existing `igndts` policy. Startup logs contain missing PPS/no-frame messages and one non-monotonic DTS adjustment. |
| 13:20:38 | Ingest ~29 seconds behind; ffmpeg simultaneously has no output for 25 seconds and is stopped as stalled. |
| 13:20:39–54 | Another replacement `400f7553925a827e` cannot produce a playlist; relay ends. |
| 13:20:59 | iPad reports media error, one stall, ~102 seconds watched. |
| 13:21:04 | Original ingest closes after its last subscriber leaves. |
| 13:21:30–34 | Relaunch `793d6f1250a2ead2` creates **fresh ingest 2** and starts playback. Mark reports sync restored after relaunch. |

The affected A/V interval plausibly corresponds to the restarted `d39...` play, but this association is inferred from
the log sequence and report rather than measured client audio. A fresh probe changed the timestamp classification
between plays; whether that was legitimate source variation or a reconnect-related sample requires raw evidence.
Missing-PPS messages are startup observations, not proof of the later stall's cause.

## What the preserved media does and does not show

The cache was copied at approximately 13:21:54. Only the **new, recovered** session remained: init plus 13 finalized
segments, about 53.6 seconds of media. Earlier affected sessions had already been removed. Consequently its measurements
**cannot rule out server-side timing damage during the affected play**, nor establish a player-only defect.

Packet inspection (`restarted-play-packets.json`) shows video at 29.97 fps, successive PTS steps ~33.367 ms; AAC at
48 kHz with successive PTS steps ~21.333 ms. Initial video/audio PTS are 0.066733/0.038937 seconds. Both tracks remain
continuous through the retained sample, without a 1–2 second hole. Local full decode exits 0 with zero warnings.
Continuous packet clocks do not measure lip sync in the underlying content.

Raw media remains outside Git: `/private/tmp/pigtv-avsync-cache-20261029.tar` and the extracted directory of the same
name; assembled server output `/private/tmp/pigtv-avsync-kansas-server.mp4`. A redacted timeline is retained beside this
report. This was evidence collection and offline inspection, not a code test or proof of a fix.

## Preserve the next occurrence

A diagnostic Node process was started as UID 99 at **13:27:20 AEDT**, for **30 minutes** (ends ~13:57:20). It reads only
already-written files under `/app/transcode-cache`, retaining HLS output in `/tmp/pigtv-avsync-20261029`, with media capped
at **128 MiB**. It makes no network request or provider connection, changes no setting, and exits on its own. Files in
container `/tmp` are transient across redeploys. At its first verification no current cache files remained; it will
capture subsequent sessions within its lifetime. This is bounded collection, not an ongoing notification monitor.

If the symptom recurs within that window: note the time and the approximate offset; report it even if a relaunch is
needed. Retrieve the collector directory before redeploying. Inspect the affected leg's first segment, reconnect
boundary and end, then compare that saved HLS in another player. If timestamps differ or content is offset there,
compare a user-approved raw capture through the same argument builders. If the saved affected output plays in sync
elsewhere, instrument the iPad's resume and audio/video clocks. Do not change timestamp flags or the live hold based
on the recovered sample.

Separately reproduce why the planned renewal produced no playlist before its total deadline. Distinguish absence of
incoming bytes/keyframes from ffmpeg processing or subscription handoff problems; the existing logs do not establish
which occurred. The later stall and the iPad A/V issue may share a cause, but this is not established.
