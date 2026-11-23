# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 23 Nov 2026, speed and efficiency programme: batches 1 to 5 and the server
part of 7 done; the Guide's press delay on the Apple TV is under investigation; batch 6 next.*

- **Running:** production runs **0886**; server main is **0907** (in `:latest`, reaches production at Mark's next Force
  Update). `:release` stays **v0579**. Apple main **397**; TestFlight has **382** (`tf/382`); one more `tf/` build goes
  out at the end of the scheduled batches (Mark's choice). Next builds: server **0908**, Apple **398** and up.
- **The Guide on Mark's Apple TV (382):** his readout was 179 moves, typical 261 ms, slowest 839 ms, 0 slow frames,
  longest stall 98 ms, the same everywhere, on single presses. The app is not stalling: the time goes between the press
  arriving and focus moving. An investigation of that gap is running on the MacBook (worktree
  `/home/markr/wt/pigtv-swift-focus-gap`); D-80's targets are not met until it is found.
- **Batches 1 to 3 (#362, #360, #361, done):** the MacBook gate and the Guide's own measurements; a press no longer
  re-evaluates the Guide page; guide pages come from an in-memory index (server 0888 to 0895); the app asks for a small
  first page and extends off the main thread (Apple 383 to 391).
- **Batch 4 (done, Apple 392 to 397):** stores and `AppModel` are `@Observable` (#51, #50); a 401 mid-session is checked
  once and never deletes the saved sign-in, and a session's end leaves nothing behind for the next (#54). #55 and #58
  wait on Mark's design choices.
- **Batch 5 (done, server 0896 to 0903):** a crash is recorded and shown on Status as "Restarts" (#44, restart only, no
  alert); daily, weekly and pre-migration database backups with restore steps in `docs/OPERATIONS.md` (#43). Left out
  after review and filed: a second backup folder (#364), an admin log view (#365); one medium open (#366).
- **Batch 7, server part (0904 to 0907):** an A/V sync meter and relay rig cases; a planned renewal that never produces
  a playlist no longer ends the play (renewal stays off by default, D-25). The rest of 6 and 7 needs captures or a
  device: #3 · #27 · #30 · #38 · #25 · #240.
- **Guide rows, agreed with Mark:** general fixes only (cheap titles for symbol runs, a clamp on the day-wide empty
  cell, both measured on new fixture rows); nothing specific to one provider's divider channels; a section heading only
  after he has seen a mock.
- **Open issues:** see `gh issue list`; new on 22 and 23 Nov: #363 · #364 · #365 · #366 · #367 · #368.

## Now: the speed and efficiency programme (#359, D-79)

One batch per session, in this order; each ends with a handover comment on its issue. Measure, change, measure: no
speed fix ships without before and after figures from the same test on the same machine.

1. *(done 22 Nov)* **Test bench on the MacBook** (#362, with #53 · #346 · #26): one command per repo; an iPad and iPhone unit tier; a
   Guide scroll test on a production-sized fixture with signposts inside the grid; a server guide perf test and a
   slow-request log line; all six perf files; Apple GitHub CI made non-blocking; the repeat flakers fixed or
   quarantined. Ends with the Guide baseline as evidence and the targets fixed as numbers.
2. *(done 22 Nov, awaiting Mark's readout from `tf/382`)* **Guide quick wins, Apple** (#360: G1, G4, G5, G8, hold grid applies while focus moves, the play-list build). Then
   Mark's look on his Apple TV and one `tf/` tag.
3. *(done 22 Nov)* **Guide data** (#361 server S1 to S8, an additive client-contract change with a Codex round; then #360's G2 proper,
   G3, G6, G7 and #55's saved guide first).
4. *(done 23 Nov bar #55 and #58, which wait on Mark)* **Apple structure and launch:** #50 · #51 · #55 · #54 · #58.
5. *(done 22 Nov bar #331)* **Operations** (may run beside 2 to 4; needs Mark's choices on alerts and where backups go): #44 · #43 · #45 · #331.
6. **Player and channel change** (playback path: capture first, ask Mark before any real provider connection): #36 ·
   #35 · #25 · #308 · #240's check with more plays.
7. *(server part done 23 Nov)* **Playback reliability** (released alone): #3 · #4 · #267 · #268 · #30 · #27 · #38 · #41.

**Targets** (D-80): on Mark's Apple TV, the slowest press under 100 ms and the typical one under 50 ms, the Guide's first
screen within 1 s; in the tests, the counts in D-80; a first guide page under 300 KB.

## Next: leftovers, folded into whichever batch touches the same files

- **Built, with a part or a review medium still open:** #49 (covers on recording players, follow settings, alerts) ·
  #63 (a first-run redraw medium) · #214 (reselecting Sport on tvOS) · #274 (share back-off) · #320 (iPhone clash
  banner) · #326 (hero strip, tennis draws, racing cards) · #345 · #347 · #348 · #357 · #358 (review mediums).
- **Built, missing a simulator or rig run Claude can do on the MacBook bench (then close, D-78):** #197 · #229 · #233
  (never reproduced) · #234 · #262 · #277 · #282 · #301 · #330 · #332 · #354.
- **Small review leftovers:** #290 · #291 · #292 · #295 · #313.

## Waiting on Mark

- **At a real event:** #259 (the next F1 race: is it marked live?).
- **Decisions:** #294 (brand kit icons) · #21 (how to close the sport rebuild).
- **Only a device can tell** (`needs-device-test`): #28 (hardware encodes on PassyFlix) · #101 (audio and subtitle
  tracks).
- **Closed on trust on 22 Nov:** nothing to do. Reopen an issue, or file a new one, if the fault shows in daily use.

**Parked:** #356 (two design rounds each found highs) · #188 lists the P3 someday items
(`gh issue list --state closed --label parked`).

## How to pick work

1. `gh issue list --label P0`, then `--label P1`. A P0 always comes first.
2. Otherwise take the next batch under **Now**; fold in **Next** items that touch the same files.
3. Read the issue, its evidence folder and the area page in `docs/architecture/` before touching code; capture first on
   the playback path. On speed work, take the before figure first.
4. An issue closes when its build is in production or on TestFlight with T1 to T3 evidence, in a comment naming the
   build and the numbered device steps as a guide (D-78). Not fully built, or waiting on a read-only check: it stays open.
5. Keep a batch inside one theme so its one Codex round has one focus (AGENTS.md › Reviews).
6. New problems become issues with the template; security matters become private advisories; someday items get the
   `parked` label and a line in #188.
