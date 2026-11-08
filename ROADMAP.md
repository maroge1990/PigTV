# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 8 Nov 2026 (F1 recording, appdata, Mark's bug list, Watch on…).*

- **Deployed:** server **0488** (`:release`, 7 Nov); Apple **175** on TestFlight. Nothing below is released yet: a
  release runs on Mark's go-ahead (D-45).
- **8 Nov, pushed with CI green:**
  - Server 0489–0495:
    - 0489 compact nightly copies (#247).
    - 0490 and 0492: a recording carries on after a container stop (#246; the 7 Nov F1 qualifying recording kept 6 minutes because Unraid's Sunday 04:00 AEDT appdata backup stopped the container).
    - 0491 F1 channels by place name (#248).
    - 0493 `followedSides` (#249).
    - 0494 and 0495: every recording is segmented, with no switch (D-48, Mark).
  - Apple 176–186: #249–#256 and #258 (Mark's picks: the short score in the middle; Start and Finish as menus); 185 and 186 add #257 "Watch on… (N channels)" in the long-press menu (Mark's pick).
  - Production appdata went from 6.9 to 2.7 GB (old captures deleted, Mark's OK).
- **Released 8 Nov (Mark's go-ahead):**
  - Server **v0495** (`:release`), live after Mark's Force Update.
  - Apple **186** uploaded to TestFlight (tvOS and iOS).
  - Waiting on the T5 checks: #246 (stop the container mid-recording and start it again), the iPhone and iPad fixes, and Watch on….
- **Waiting on Mark:**
  - The Appdata Backup setting: don't stop PigTV, or move it from Sunday 04:00.
  - Device checks of 164–175.
  - #240.
  - Next builds: server **0496**, Apple **187**.
- **Mark's decisions (4 Nov):**
  - Release only on his go-ahead.
  - Providers may be used for tests.
  - Recordings are never deleted automatically (#40).
  - A future game records once listed (#234).
  - Top Shelf live sport follows-first (#232).
- **Next:**
  - Captures for #4, #27, #30.
  - #25.
  - Running unattended: #43, #44, #45.
  - Web: #60–#64.

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
