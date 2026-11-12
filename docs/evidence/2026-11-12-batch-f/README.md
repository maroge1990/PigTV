# #274, batch F (server 0567 to 0577): recording and playback duplicates; reviews, gates and the rig

All six items of the 10 Nov audit's batch F (Mark, 12 Nov), in two pushes so a live effect can be told apart: the two
that were wrong (0567 to 0572), then the four merges on the playback path (0573 to 0577).

## What the batch did

- 0567: `recordingWindow(schedule)` owns a recording's window. The viewer's 409 `endsAt` and the scheduled list's clash
  now count an event's overrun. `CLIENT-CONTRACT` documents the conflict body.
- 0568: remux, adoption, compression and the recordings-path check in Settings reach the share through its bounded
  helper (`shareFs`, now with `rename`), not `fs.*Sync` on the main loop.
- 0573: one owner for the composite-id strip (14 inline copies) and for channel to stream address, shared by playback
  and recording. A composite id can no longer reach an Xtream address.
- 0574: the coordinator reads the active recordings from one registered source; the parameter is gone from every call.
- 0575: `playbackStart.startOnFirstFree` is the provider walk for the play route's first pass and the relay's cold start.
- 0576: every recording part has a stall watchdog. With one provider a stalled part ends and the recording resumes on
  that provider (the 0499 rule). Remux and compress use the same watchdog.

## Reviews and findings (each fix has a test that fails on the build before it)

- **Part 1, Codex round one: 1 high.** A recording deleted while its file was being published by rename could have the
  file put back. Fixed in 0570: the publish runs inside the tracked writer, journalled, rechecked after the rename.
- **Part 1, Opus: no high, 4 medium, 5 low.** A schedule due during another's overtime was held and missed: Mark chose
  "start late", fixed in 0569 (the overrun is shown, never held on). A deadline miss ended a job for good; Settings
  refused a local path while the share hung; test margins; a missing prepared file: all in 0570.
- **Codex sign-offs:** on 0570, a medium (Settings helpers piled up on a hung share), fixed in 0571; on 0571, a medium
  (a helper that failed to start kept its place), fixed in 0572; on 0572, approve.
- **Part 2, Codex round one: 1 high.** A shared feed arriving in bursts kept excusing a capture that wrote nothing.
  Fixed in 0577: the excuse holds only while the feed has delivered nothing since the capture last grew.
- **Part 2, Opus: no high, 2 medium, 6 low.** A stall used one of the 20 resumes; the stall watch summed the whole
  epoch folder every 5 s (12,051 file calls in four samples, under 300 now); a degenerate id; test margins: all in
  0577. 0573 and 0575 matched the old code case by case. Codex sign-off on 0577: approve.
- **Left, filed:** #303 (a failed read of the recordings ends the whole recording pass), #304 (a single-provider stall
  counts for the breaker, so Status can say "down"). Not built: back-off for a share that answers checks but stalls
  every rename (one remux per 15 s until two helpers are stuck). The `.m4s` content type is deliberate (ARCHITECTURE).

## Gates

`npm test` on 0577: 2,270 tests, 2,258 pass, 8 skipped, 4 fail on the build machine only (its ffmpeg writes AAC-LC).
`verify-build.sh` passes, with two new sections (the inline id strip; the coordinator requiring the engine or a module
reading the ingest registry). CI green on both pushes (`c29d3bf`, `fbc61b9`): tests, `perf`, image.

## The rig (fake provider only)

| check | 0572 | 0577 |
|---|---|---|
| Play start, resolve to first segment (median) | 5,398 ms (0565: 5,431) | 4,901 ms, five runs |
| Overrun: stop after the game went final | 35 s, pass | 35 s, pass |
| Viewer's `endsAt` during overtime | the real stop (11.5 min later than before) | equals `stopsAt` |
| A recording due during another's overtime | listed as clashing, waited for the slot, started 6 s after, partial | not rerun |
| One connection: second device / same owner / recording holds it / recording due | not run | 409 / plays / 409 / waits, starts 3.5 s after |
| Primary full, primary failing at start | not run | backup, backup with failover |
| Single provider silent for 60 s | not run | noticed at 30 s, resumed, one recording |
| Connections after each case | not run | 0 |

Could not run: a hung share on the rig (its only hang switch is fixed at container start); warming and the relay (off
by default there). Seen on the way: #302 (the gap note said 19 s for about 98 s missing); a waiting reason that stays
after the recording starts; "Infinitys silent" in a reclaim log line; the provider's host and port, credentials masked,
in three log lines (as on 0572). The agent deleted three old test recordings on the rig by mistake.
