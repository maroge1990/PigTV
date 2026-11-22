# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 22 Nov 2026, batches 1 and 2 of the speed and efficiency programme done, batch 3
under way.*

- **Running:** production runs **0886**; server main is **0895** (in `:latest`, reaches production at Mark's next Force
  Update). `:release` stays **v0579**. Apple main **382**, sent to TestFlight as `tf/382` on 22 Nov (TestFlight 323 =
  Apple 372 until that build lands). Next builds: server **0896**, Apple **383** and up (a builder holds 383 to 386).
- **Batch 1 (#362, done):** the MacBook is the gate for both repos (`scripts/mac-gate.sh`, `Tools/mac-gate.sh`, D-77);
  an iPad and iPhone unit tier; the Guide measures itself (signposts, `GuidePerfUITests` on a 1,250-channel fixture, a
  Settings switch "Guide speed readout"); a server guide perf test and a slow-request log line (0887). Baseline in
  `docs/evidence/2026-11-22-guide-baseline`; targets as numbers in D-80.
- **Batch 2 (#360, done, Apple 375 to 382):** a press no longer re-evaluates the Guide page (1 to 0 per press); the
  30 s tick redraws only what changed (1 page + 20 cells to 0); a vertical step no longer redoes the layout (2.8 to
  0.4 ms per press); logos in memory draw on the first frame. The MacBook simulator never reproduced the hang and its
  milliseconds barely moved, so the proof is Mark's readout on the Apple TV from `tf/382`. Parked for batch 3: hold
  grid applies while focus moves (three attempts failed their measurement). Dropped on the measurement: the play-list
  build (0.4 ms).
- **Batch 3 (#361, under way):** server 0888 to 0895: guide pages come from an in-memory index of the visible line-up
  (page 1 built in 33 ms, was 76), measurements and the logo map no longer reread or rewritten per page, cold logos
  fetched once, six at a time, and written by rename; logo answers carry their length and a 30-day lifetime. A
  per-minute kept guide answer was built and then removed (little use, and each review found another way for it to go
  stale). On production's real guide the first page is 975 KB gzipped, and 50 channels for 6 h is 30 KB: the first-page
  target is met by the app asking for a small first page (Apple 383, in progress), not by a contract change.
- **Open issues:** see `gh issue list`; new on 22 Nov: #363 (a refused Change recording shows no message on iPhone).

## Now: the speed and efficiency programme (#359, D-79)

One batch per session, in this order; each ends with a handover comment on its issue. Measure, change, measure: no
speed fix ships without before and after figures from the same test on the same machine.

1. *(done 22 Nov)* **Test bench on the MacBook** (#362, with #53 · #346 · #26): one command per repo; an iPad and iPhone unit tier; a
   Guide scroll test on a production-sized fixture with signposts inside the grid; a server guide perf test and a
   slow-request log line; all six perf files; Apple GitHub CI made non-blocking; the repeat flakers fixed or
   quarantined. Ends with the Guide baseline as evidence and the targets fixed as numbers.
2. *(done 22 Nov, awaiting Mark's readout from `tf/382`)* **Guide quick wins, Apple** (#360: G1, G4, G5, G8, hold grid applies while focus moves, the play-list build). Then
   Mark's look on his Apple TV and one `tf/` tag.
3. **Guide data** (#361 server S1 to S8, an additive client-contract change with a Codex round; then #360's G2 proper,
   G3, G6, G7 and #55's saved guide first).
4. **Apple structure and launch:** #50 · #51 · #55 · #54 · #58.
5. **Operations** (may run beside 2 to 4; needs Mark's choices on alerts and where backups go): #44 · #43 · #45 · #331.
6. **Player and channel change** (playback path: capture first, ask Mark before any real provider connection): #36 ·
   #35 · #25 · #308 · #240's check with more plays.
7. **Playback reliability** (released alone): #3 · #4 · #267 · #268 · #30 · #27 · #38 · #41.

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
