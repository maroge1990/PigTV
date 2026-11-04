# Batch 5: cricket leftovers, small server fixes, Play from live (server 0452–0457, Apple 150–151)

From Mark's test of 0451/149 (4 Nov: WBBL and Sheffield Shield on International (men)) and his pick of the next
batch ("small fixes + recording"). His decisions: bundle with the recording work; keep the watch copy running from
the start of every recording (#17); recordings are never deleted automatically (#40, nothing built).

| Build | Issue | Change | Proof (fails on the build before) |
|---|---|---|---|
| 0452 | #212 | A group card from a fixed league's series (stored before 0435) is never shown, and is forgotten | sports-dashboard (WBBL and Shield shown beside NZ v India) |
| 0453 | #220 | DELETE of a recording/schedule that is gone: 404, same text (C-M) | recordings-delete-position (500) |
| 0454 | #209 | Resolve of an id the Xtream source does not list: C-B 404, provider never asked | contract-golden (500; fake provider's live count) |
| test | #48 | Apple routes asked with a token; dead C-E routes out, Apple 149's missing routes in | putting index.m3u8 back fails it |
| 0455 | #38 | A full local disk ("No space left on device") is never a provider reason, exit or stall | reconnect-recovery (provider reason true) |
| 0456 | #17 | Every segmented recording keeps its watch copy running from the start | recording-segments (no copy without a request) |
| 0457 | #17 | Those starts run beside the scheduler (Codex medium) | recording-segments (hanging probe blocks the next recording) |
| 150 | #17 | Play from live: the live playlist, joined 30 s behind its end | RecordingResumeTests, RealPlaybackTests |
| 151 | #17 | The join survives a slow or failed first load (Codex medium) | RealPlaybackTests: on 150 a 90 s recording starts at 0.0 s |

Production read-only (T4, 4 Nov): Mark's account follows only Cricket + Australia; the stored `Cricket` rows held
WBBL 21284 and Shield 8043 cards observed 1 Nov. Watch copy speed (local, 4 cores): 15 min of 720p25 in 37 s (~25x).

**Codex** (one round each, 4 Nov): server: one medium (the tick awaited watch-copy probes), fixed in 0457. Apple:
one medium (silent start at 0), fixed in 151. No high: no second round (D-38).

Gates: `npm test` (4 recording-segments-media failures are this machine's ffmpeg without HE-AAC; CI runs them),
`verify-build.sh`, Apple `Tools/test.sh push`. Not checked on a simulator: the Play from live button (the offline
fixture has no recording in progress). #26 (flaky watch-from-start test) left open: no cause found by reading.
