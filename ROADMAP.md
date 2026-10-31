# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 31 Oct 2026, afternoon (fourth Windows session: the process reset, D-38, and
the issue clean-up Mark approved).*

- **Server:** production runs **0362** (deployed 31 Oct 07:06). On GitHub: **0363–0380** (batch 7: Status and Devices
  name the device and app build, ffmpeg versions, Re-detect GPU, last synced per provider, Status cost cut; batch 4b: a
  backup made the primary keeps the lineup; the NFL page's server answer, C-Q). CI green for each pushed batch. Next build
  **0381**. The D-38 docs commit and this roadmap are the last things pushed.
- **Apple:** on GitHub **84–88** (`X-PigTV-Client`, the NFL page, TestFlight prep). Next build **89**. #7 (live hold)
  stays with its own session.
- **Process (D-38, 31 Oct):** one Codex round per batch, a second only on a high; Apple `test.sh fast` per commit and
  `push` per batch; docs-only pushes skip CI in both repos; Claude closes an issue on T1–T3 evidence, and only issues
  needing a device look wait for Mark, whose steps live on the Test Round page (his checklist artifact), not as issues.
- **Issues:** 183 open this morning, **58** now: 67 fixed issues closed naming their builds (none needed a device),
  13 sport features folded into #21's checklist, 47 P3 items parked under #188 (label `parked`, all reopenable). What is
  left is live work plus the device checks on the Test Round.
- **TestFlight:** parked. Mark joined the developer program on 31 Oct; enrolment is pending (up to 48 h). Then: his
  Team ID and an App Store Connect API key (Admin) on the Mac, the project moved to the paid team, bundle ids
  registered, the app record created by Mark (iOS + tvOS), `Tools/testflight.sh both`, internal testing only.
- **Brand:** the kit is now on WSL at `~/code/PigBrand` (1.7.0); PigTV vendors 1.6.0. The cross-platform brand review
  (a separate session) starts by diffing the two.
- **Not done:** production's 7 favourites point at a provider id that no longer exists (6 identifiable by name: Fox
  Footy 504, Sky Sports Main Event, ESPN, Sky Sports F1, Sky Sports Premier League, Marquee Sports Network); restoring
  them needs Mark's yes. #111 (ordered guide sources) parked until a second guide source exists. Relay timeline renewal
  stays **off** (D-25).
- **Waiting for Mark (T5):** the Test Round page: web checks for batch 7 and 4b, the Apple TV checks for the NFL page,
  Top Shelf, channel up/down, Home staying current, start-up feel (#5, #6, #7), and the real-feed items (#3, #12, #18,
  #22–#24, #32, #101) plus the set-aside sessions (#28, #31, #79).

## Now

1. **Sport front page** (#21): every live game across Mark's followed sports with teams, score, clock, channel and one
   press to watch; next up; the followed team pinned; spoiler-free honoured; honest without ESPN. A one-page brief and
   "Live now" mock-ups (Apple TV, iPad) for Mark's approval first, then tvOS, then iPad, reusing the server's C-O score
   data and replacing the gated dashboard as the Sport tab's landing page. #186, #187 and the iPhone question #177 fold
   in. Then the cricket page (mock-up approved 31 Oct), then AFL in March.
2. **Brand review** in a separate session alongside: diff the vendored 1.6.0 against the kit's 1.7.0, screenshot every
   screen on tvOS, iPad, iPhone and web against `docs/DESIGN.md` › Brand, write up the gaps with before images, fix as
   one batch after the front page.
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
