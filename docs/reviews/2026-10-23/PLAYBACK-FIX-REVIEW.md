# Playback/ingest fix review — 23 October 2026

Reviewed builds 0230–0234 against current server HEAD f026c63, including current integration paths. No application changes, real provider access, or deployed server access.

## Remaining actionable finding

**[P2] DVR-4 remains incomplete for immediate non-segmented start failover.** `server/services/recordingEngine.js:1006–1009` still awaits `feedFor()` and unconditionally calls `spawnPart()`. At this point `onPartExit` has removed the previous active entry (line 987), while the schedule remains `recording`; this path has neither a continuation entry nor the new `startStillWanted`/shutdown generation guard. `cancelScheduled()` therefore finds neither active nor continuation ownership and leaves the schedule recording. `stopAllActive()` cannot see it either. When the backup feed resolves, ffmpeg starts after cancellation/shutdown. This is a missed path of the original DVR-4 issue, rather than a new regression introduced by the fix.

Reproduced with the real recording engine/database and local fake ffmpeg from the existing `recording-failover.test.js` harness, replacing ingest.subscribe with a controllable promise (no HTTP or provider calls). Primary startup fails with 502; backup feed held pending; cancelScheduled leaves status `recording`; stopAllActive returns; release deferred feed; backup ffmpeg starts. Output asserts and prints the defect. Files: `/tmp/pigtv-failover-cancel-review.test.cjs`, `/tmp/pigtv-failover-cancel-review.log` (one test passed, meaning defective behavior reproduced).

Repair: retain cancellable ownership of immediate failover, propagate cancellation/shutdown generations and release any late feed before spawning. Add a regression for both cancellation and stopAllActive during this immediate failover await (and cancellation during its preceding settings await). Ensure cancellation updates schedule status and releases a late subscription; test assertions must assert corrected behavior, not copy the defect reproduction unchanged.

## Verdicts

| Original ID | Verdict | Evidence |
|---|---|---|
| I1 | Fixed in source and synthetic local tests | Absolute connecting and reconnecting deadlines, ready rejection on close, pending waiters excluded from idle reclaim. Header-only, short-data, reconnect and cancellation cases pass. |
| PB1 | Fixed in source and synthetic local tests | Session ended guard after mkdir and subscription, late feed release, cleanup protection, retry guards, and superseded cancellation classification. |
| PB2 | Fixed in source and synthetic local tests | Recording grouping retains all member schedule IDs; takeover releases co-reading viewers, stops every recording and closes the shared ingest before new start. Tests include two recordings, mixed viewer/recording and two viewers. |
| PB3 | Fixed in source; targeted regression run | Route reads listActive at each candidate, warm admission and forced admission, instead of retaining first request snapshot. |
| DVR-4 | Partially fixed; remains open | Ordinary/segmented initial starts and queued segmented continuation are guarded and their tests pass. Immediate ordinary start-failover path above is not covered or guarded. |

## Validation

Node 24: `node --test test/ingest.test.js test/ingest-playback.test.js test/ingest-recordings.test.js test/coordinator-shared-takeover.test.js test/transcode-session-cancel.test.js`: **42/42 passed**. Log `/tmp/playback-fix-valid.log`.

Prior `/tmp/pigtv-playback-fix-review.log` was sandbox-invalid (local server listen EPERM); those failures are not evidence of product defects. Focused tests were rerun with approved loopback access. Device/real-feed acceptance remains separate.

`node --test test/provider-failover.test.js`: **25/25 passed**, including PB3 recording starts/ends between primary and fallback admission. Log `/tmp/pigtv-pb3-fix-valid.log`. PB3 verdict: fixed in source and synthetic local tests.
