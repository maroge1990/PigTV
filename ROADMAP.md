# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 4 Nov 2026 (Mark's test round of 0446/143 opened; Batch 1 of four built).*

- **Deployed:** server **0446** and Apple **143** on TestFlight (4 Nov). **On main, not deployed:** server **0447–0449**
  (Batch 1, #222 football event slots match their ESPN game; Codex rounds 1–2, both highs fixed). Next builds: server
  **0450**, Apple **144**.
- **Mark's test of 0446/143 (4 Nov)** raised #222, #223, #225–#229 and reopened #212 (an Apple page design point: the
  server is right on live data) and #213 (MLB logos); #224 (F1) was not a bug.
- **Batches agreed 4 Nov:** 1 server sport matching (done); 2 server followed teams (#223 beyond 72 h, #213 logos, #215,
  #202); 3 Apple sport layout (#228, #225, #213 client, #205, #204, #192, #212's "Your other cricket today", awaiting
  Mark's choice); 4 Apple consistent look (#226 headers with the Sport page's pig and a lighter title, #227, #229, #190).
- **T3:** Batch 1 not run on the rig (its fake provider has no event-slot football titles). Evidence:
  `docs/evidence/2026-11-04-sport-matching/`.
- **Still open from before:** the D-44 device pass (T5) per platform; #12, #29, #193–#203, #205, #206, #187, #190, #210.

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
