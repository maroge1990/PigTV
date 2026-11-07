# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 7 Nov 2026 (audit follow-up: batches 1–7 done, one part waits on Mark).*

- **Deployed (7 Nov):** server **0488** (`v0488`, `:release`; Mark's Force Update 08:18 UTC); Apple **175** uploaded to
  TestFlight (tvOS and iOS). 0452–0488 and Apple 150–175 wait for Mark's device checks.
- **Audit follow-up (6 Nov brief), all pushed with CI green:** 1 release gate (#236, D-45); 2 server idle work (#237 sync
  skips unchanged feeds, #238 score collector rests, 0477–0480); 3 Apple scale (#243 part 1: `PigSpacing`, `PigType`,
  one secondary button, 164–166); 4 Apple pages (#243 part 2, #239: 167–173); 5 web shell (#241, #239: 0481–0486);
  6 start timing (#36 phases, 0487–0488, Apple 174–175); 7 docs (#242, D-47). D-46: a round-two high's fix gets its own
  narrow Codex check.
- **Waiting on Mark:** the device checks of 164–175 and the 0452–0476 Test Round; the Apple TV
  look at 164–175 (text size, pages, buttons); #240 (a shorter ffmpeg analysis for profiled channels) needs his OK to
  bench the kept samples in production's data folder and capture a real feed. Next builds: server **0489**, Apple **176**.
- **Mark's decisions (4 Nov):** release only on his go-ahead; providers usable for tests; recordings never deleted
  automatically (#40); a future game records once listed (#234); Top Shelf live sport follows-first (#232: waits on
  mock-ups and whether to share the sign-in with the extension).
- **Checklist:** `TEST-ROUND-0474-163.md` (worktree root, 35 steps) for the release.
- **Next:** captures on the real feeds for #4, #27, #30 (in the production container: Mark's OK) and #25 (Xcode on the
  Apple TV); running unattended (#44, #43, #45: each needs a choice from Mark); web (#60–#64); #54's mid-session 401.

## Now

1. **Sport on the devices** (#21, D-39, D-40): Mark's T5 pass of the front page, NFL, Cricket and F1 on TestFlight
   build 90, then the iPad layout check and the iPhone question (#177); #186, #187, #191, #192 fold in.
2. **Every other team sport on Apple** (D-40): one page design on C-T (the server side is 0388–0389), after step 1;
   then sports without two teams.
3. **The sport revamp (D-41), before more pages; deployed and tested as a whole once complete (Mark, 1 Nov):**
   - Server: built 0390–0432 (#193–#203, #206, #12, #29's measurement, #52).
   - Web: #199 built (0418–0421); the web's sport pages are parked (D-43).
   - Apple: built 91–101 (#200 with #201–#205, #187, #190, #52; the Apple TV sport pages to D-43); iPad/iPhone
     (#186, #177) after the Apple TV device check.
   - Combined test (T3 then T5): all of the above plus #20, #22–#24, #191, #192.
   The web brand fixes W1–W9 (PR #189's README) follow.
3. Batch 8: #4 relay renewal (capture first, a device test with renewal on, released alone): waits for Mark.
4. #29: measured on the rig (0409); its production pilot is a read-only Status check at the combined deploy. #20 per-channel airing times inside the sport work.

## Next (P1)

- #3 A/V out of step on iPhone/iPad (D-24) · #5, #6, #7 start-up and recovery feel: built, on the Test Round
- #12 overlapping recordings: built, on the Test Round · #14 Top Shelf with a page open: built, on the Test Round
- #17 play from live on a recording in progress (Mark's request) · #19 who is playing: built, on the Test Round
- #18 tvOS focus after a non-preferred channel: Apple 62, on the Test Round · #22, #23, #24 cricket and roster
  recognition: fixed, proven at the next Test match

## Later (P2)

- Playback and recording: #25 frozen after a long play · #26 watch-from-start test · #27 timestamp step · #30 reconnect
  or switch · #34 follower deaths · #35 display mode resets · #36 zap chain · #37 live pause policy (D-26) · #38 tmpfs
  in bytes · #40 retention · #41 simplify the hot spots · #74 fake-provider stall run
- Providers, guide and operations: #43 backups · #44 crash alert · #45 diagnose without SSH
- Apple client: #46 stale Home (built, on the Test Round) · #47 degraded `/api/info` · #49 presentation · #50 AppModel
  split · #51 observation rule · #53 iOS tests in CI · #54 sign-in tests · #55 launch requests · #56 richer programmes ·
  #57 search · #58 player overlay
- Contract and web: #48 Apple routes test · #52 contract fixtures · #60 player error texts · #61 Status facts (built,
  on the Test Round) · #62 recordings parity · #63 first run · #64 Settings.js
- Device sessions for Mark: #28 hardware encodes · #31 recordings test day · #32 watch-while-recording · #33 HE-AAC

**Parked (P3):** #188 lists everything; `gh issue list --state closed --label parked`. #101 (a multi-track channel on a
device) stays open on the Test Round.

## How to pick work

1. `gh issue list --label P0`, then `--label P1`. A P0 always comes first (none open on 31 Oct).
2. Otherwise take the next item under **Now**; when Now is empty, the next P1, then by theme from Later.
3. Read the issue, its evidence folder and the area page in `docs/architecture/` before touching code; capture first on
   the playback path.
4. An issue that needs a device look is not "worked": its steps go on Mark's Test Round page, and it closes when he
   reports (D-38). Everything else closes on T1–T3 evidence once pushed.
5. Keep a batch inside one theme so its one Codex round has one focus (AGENTS.md › Reviews).
6. New problems become issues with the template; security matters become private advisories; someday items get the
   `parked` label and a line in #188.
