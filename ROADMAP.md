# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 22 Nov 2026, batch 0 of the speed and efficiency programme (tracker reset).*

- **Running:** production runs **0886** (read from `/api/version` on 22 Nov; the 20 Nov notes said 0861), which is
  server main. `:release` stays **v0579**. Apple main **372**; TestFlight **323 = Apple 372** (`tf/372`). Next builds:
  server **0887**, Apple **373**.
- **Done 22 Nov (no code):** the speed and efficiency review (https://claude.ai/artifact/6K7yotbLASsn4RMd3Fz5eS) is the
  plan, recorded as D-79 and #359. 83 built issues closed on trust (D-78), each with a comment naming its builds; #74
  closed as not reproducible on 0886 (relay rig, timestamps). New issues: #359 the programme, #360 the slow TV Guide on
  Apple TV, #361 the server's guide data, #362 the MacBook test bench. The MacBook is the test gate for both repos
  (D-77).
- **Read-only checks, 22 Nov:** #29 and #273 closed on production's figures (collector parse 7.7 ms at worst; the
  write-ahead file unchanged in 8 days). Claude can read Status itself now (an admin account whose sign-in is in
  `~/.config/pigtv/status.env` on the WSL machine, GET requests only). #36's Status panel shows 0 plays since the
  21 Nov restart; #259 waits for a race. 64 issues are open.

## Now: the speed and efficiency programme (#359, D-79)

One batch per session, in this order; each ends with a handover comment on its issue. Measure, change, measure: no
speed fix ships without before and after figures from the same test on the same machine.

1. **Test bench on the MacBook** (#362, with #53 · #346 · #26): one command per repo; an iPad and iPhone unit tier; a
   Guide scroll test on a production-sized fixture with signposts inside the grid; a server guide perf test and a
   slow-request log line; all six perf files; Apple GitHub CI made non-blocking; the repeat flakers fixed or
   quarantined. Ends with the Guide baseline as evidence and the targets fixed as numbers.
2. **Guide quick wins, Apple** (#360: G1, G4, G5, G8, hold grid applies while focus moves, the play-list build). Then
   Mark's look on his Apple TV and one `tf/` tag.
3. **Guide data** (#361 server S1 to S8, an additive client-contract change with a Codex round; then #360's G2 proper,
   G3, G6, G7 and #55's saved guide first).
4. **Apple structure and launch:** #50 · #51 · #55 · #54 · #58.
5. **Operations** (may run beside 2 to 4; needs Mark's choices on alerts and where backups go): #44 · #43 · #45 · #331.
6. **Player and channel change** (playback path: capture first, ask Mark before any real provider connection): #36 ·
   #35 · #25 · #308 · #240's check with more plays.
7. **Playback reliability** (released alone): #3 · #4 · #267 · #268 · #30 · #27 · #38 · #41.

**Targets** (numbers fixed after batch 1's baseline): a single focus move with no hitch over 100 ms; the Guide's first
screen within 1 s of opening the tab; a first guide page under 300 KB.

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
