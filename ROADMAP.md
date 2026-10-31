# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 31 Oct 2026, evening (fourth Windows session: D-38 process reset, the issue
clean-up, D-39 and the Sport front page's server side, the Cricket page's server side, the brand review).*

- **Server:** production runs **0362** (deployed 31 Oct 07:06). On GitHub, CI green: **0363–0380** (batch 7, batch 4b,
  the NFL page C-Q), **0381–0382** (the Sport front page's answer C-R: hero rule, rails, follows, results, per-channel
  airing times, logos; one household following store `sports` → `teams`; the score collector on by default, legacy
  `/dashboard` still behind `PIGTV_SPORTS_DASHBOARD=1`), **0383–0385** (the Cricket page's answer C-S; play-start
  `origin`; the lead never a finished match). Next build **0386**. Evidence: `docs/evidence/2026-10-31-sport-front-page`.
- **Apple:** on GitHub **84–88**. **Build 89** (the front page "Blend 1", the app opens on Sport, Home → TV in second
  place, play `origin`, spoiler and feed-off states, 13 unit tests, one UI test) is built in this session's worktree
  with the quick tier green and the review fixes applied; see the handover for whether it was pushed. Next **90**.
- **Process (D-38):** one Codex round per batch, a second only on a high; docs-only pushes skip CI; Claude closes
  issues on T1–T3 evidence; device checks live on Mark's Test Round page (artifact `LbZZpEBbjgnqEj2CDJx3X1`).
- **Issues:** 58 open (from 183): live work plus the device checks. P3 is parked under #188 (`parked` label).
- **Decisions today:** D-38 (process), D-39 (front page = Blend 1, following model sport → team, hero rule, team
  badges, PNG circuit maps, open on Sport, Home → TV with a two-week usage check via play `origin`).
- **Brand review:** done as evidence in PR #189 (docs only, awaiting Mark's read): kit 1.7.0 differs from 1.6.0 only in
  PigMenu and version strings; nine web gaps (W1–W9) and seven Apple gaps (#190, plus #116); the fixes are one web
  batch and one Apple batch after the front page. Apple simulator screenshots still owed (the Mac was busy).
- **TestFlight:** parked until Mark's enrolment clears (steps: Team ID and an App Store Connect API key on the Mac, the
  project moved to the paid team, bundle ids, the app record (iOS + tvOS), `Tools/testflight.sh both`, internal only).
- **Not done:** production's 7 favourites point at a deleted provider id (6 identifiable by name): restoring them needs
  Mark's yes. No in-app "Follow a sport" UI yet: the household's sports/teams were seeded from the admin follow list and
  the F1/NFL page follow buttons write teams; a web Settings page for it is the next web piece. #111 parked.
- **Waiting for Mark (T5):** the Test Round page (batch 7 and 4b web checks, NFL page, Top Shelf, start-up feel, the
  real-feed items and the three set-aside sessions); the front page itself once Apple 89 is on a device.

## Now

1. **Sport front page on the devices** (#21, D-39): Apple 89 pushed and on Mark's Apple TV and iPad (install or
   TestFlight), his T5 pass, then the iPad layout check and the iPhone question (#177); #186, #187 fold in.
2. **Cricket page on Apple** (C-S is on the server, 0383–0385): the "Cricket · Apple TV" mock-up as `CricketPageView`,
   reached from the front page's Cricket tile; then AFL in March.
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
