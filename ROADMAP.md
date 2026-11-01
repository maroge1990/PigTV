# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 1 Nov 2026, evening (sport revamp server and web 0390–0421, Apple 91–94; D-43).*

- **Server:** production runs **0387** (unchanged). On GitHub, CI green: **0390–0421**, the sport revamp (D-41, D-42):
  #193–#196 and #206 (0390–0405); #197's cards: tennis, golf, UFC, IndyCar, NASCAR Cup (0406–0408); #29 collector cost
  counters and rig measurement (0409: no effect on HLS with 61 leagues; production pilot at the combined deploy); #12
  clashes, first scheduled wins (0410–0412); #198 suggestions, "Record every game", recordings on cards (0413–0417);
  #199 web Settings › Sports › Your sport and `GET /api/sports/names` (0418–0421). Every batch had its Codex rounds;
  every high fixed; #207 (keyword rules' merged airing times) left as a finding. Next build **0422**.
- **Deploy rule (D-42):** the revamp is deployed and tested as a whole once complete, not batch by batch.
- **Apple:** TestFlight **90**; on GitHub **91–94** (#200 part 1: Settings › Sport on C-U, clash choices and card
  recordings; two Codex rounds, both highs fixed; web twin #208). Next **95**: the rest of #200 (#201–#205, #187, #190,
  #18, #52), then the Apple TV sport pages to D-43.
- **Decisions:** D-41, D-42, **D-43** (Apple TV sport pages: one banner on the front page and every sport page, a
  layout per sport, no sport tiles; build and device-test on Apple TV first, then iPad and iPhone mock-ups together; web
  parked). Golf's Majors are the four men's; the women's stay under LPGA.
- **Issues:** #12, #29, #193–#199, #206 stay open for the combined test; #197 still needs its league pages (now to
  D-43's layouts). New: #207, #208 (findings, P2).
- **Paused at Mark's request:** the walkthrough of the 19 issues waiting on his device check, starting at #192.
- **Not done:** #197's pages; #201–#203 server halves; production's 7 favourites (needs Mark's yes); PR #189 waits
  for Mark's read; #111 parked.

## Now

1. **Sport on the devices** (#21, D-39, D-40): Mark's T5 pass of the front page, NFL, Cricket and F1 on TestFlight
   build 90, then the iPad layout check and the iPhone question (#177); #186, #187, #191, #192 fold in.
2. **Every other team sport on Apple** (D-40): one page design on C-T (the server side is 0388–0389), after step 1;
   then sports without two teams.
3. **The sport revamp (D-41), before more pages; deployed and tested as a whole once complete (Mark, 1 Nov):**
   - Server: built 0390–0421 (#193–#199, #206, #12, #29's measurement); next #201–#203 server halves and #197's league
     pages to D-43's layouts.
   - Web: #199 built (0418–0421); the web's sport pages are parked (D-43).
   - Apple (next): #200 Settings › Sport with #201–#205, #187, #190 (brand), #18, #52 (contract fixtures from real
     answers), and the Apple TV sport pages to D-43 (DESIGN.md › Apple TV sport pages); iPad/iPhone (#186, #177) after
     the Apple TV device check.
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
