# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 31 Oct 2026, night (fifth Windows session: Apple 89 and 90, the overrun fix,
the general league page, the first TestFlight upload).*

- **Server:** production runs **0387** (Mark deployed 31 Oct evening; healthy, score collector on). On GitHub, CI green:
  **0386–0387** (#191: a live game overrunning its guide slot keeps Watch; pages only while their ESPN answer is ≤ 15 min
  old) and **0388–0389** (C-T: a general page for every ESPN team league, `/api/sports/pages/league/:league`,
  `sportPageLeagues` in `/api/info`; no client yet). Next build **0390**.
- **Apple:** on GitHub **89** (the Sport front page, opens on Sport, TV tab second) and **90** (the Cricket page on C-S;
  every sport page and the front page fail closed on spoiler-free, #192). **Build 90 is uploaded to TestFlight** (tvOS
  and iOS, 31 Oct 21:03), processing. Next **91**.
- **Decisions:** D-40 (one league page for all other team sports, no more mock-ups until NFL/Cricket/F1 are tried on a
  device; TestFlight from 90; the overrun rule; the spoiler choice fails closed).
- **Process (D-38):** unchanged. Apple 90 used both Codex rounds; the round-2 highs were fixed with failing-before tests
  and pushed without a third round. Evidence: `docs/evidence/2026-10-31-{overrun-191,league-page,apple-90}`.
- **Issues:** 61 open. #191 and #192 wait for Mark's device check (Test Round checks 25 and 28).
- **TestFlight:** works. `ssh -t mac '... security unlock-keychain ... && sh Tools/testflight.sh both'` from the Terminal
  panel (Mark types the Mac password); internal testers are added in App Store Connect › TestFlight.
- **Not done:** the Apple page for C-T (after the device check); production's 7 favourites (needs Mark's yes); the web
  Following page and brand fixes W1–W9; the Apple brand batch (#190, #116) and its simulator screenshots; PR #189 waits
  for Mark's read. #111 parked.
- **Waiting for Mark (T5):** the Test Round page, now with the front page (checks 22–28) on TestFlight build 90.

## Now

1. **Sport on the devices** (#21, D-39, D-40): Mark's T5 pass of the front page, NFL, Cricket and F1 on TestFlight
   build 90, then the iPad layout check and the iPhone question (#177); #186, #187, #191, #192 fold in.
2. **Every other team sport on Apple** (D-40): one page design on C-T (the server side is 0388–0389), after step 1;
   then sports without two teams.
3. **Web: Following settings** (choose and order sports, follow teams; the household store from 0381) and the brand
   fixes W1–W9 as one web batch (PR #189's README); the Apple brand batch (#190, #116) after.
3. Batch 8: #4 relay renewal (capture first, a device test with renewal on, released alone): waits for Mark.
4. #29 (collector cost) before the Live now data is on by default; #20 per-channel airing times inside the sport work.

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
