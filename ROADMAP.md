# Roadmap

Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues) (both repos). This page orders it; the
issues hold the detail.

## Current state

*Overwritten at the end of every session. 31 Oct 2026, morning (third Windows session; D-37: Claude works through
batches without Mark; Mark deployed 0362 at 07:06 and asked for the next batches).*

- **Server:** production runs **0362** (deployed 31 Oct 07:06; the 08:30 sync migrated hidden channels with nothing
  moved: 1,413 shown, 17,693 hidden, the guide 152 h ahead). On GitHub: **0363–0371** (batch 7, Status: the app build per
  device from `X-PigTV-Client`, who is playing by name, the pairing preview #19; ffmpeg/ffprobe, Re-detect GPU, last
  synced per provider #61; Status cost measured and cut, `?details=0`, the banner paused while hidden #129), **0372–0378**
  (batch 4b: a backup made the primary keeps the lineup, with a dry run #15; findings #180–#182), **0379–0380** (the NFL
  page's server answer, C-Q; finding #183). CI green for each pushed batch. Next build **0381**.
- **Apple:** on GitHub **84** (`X-PigTV-Client` on every request), **85** (a UI test for #179), **86–87** (the NFL page,
  findings #184, #185), **88** (TestFlight prep: export compliance, `Tools/testflight.sh`). Next build **89**. #7 (live
  hold) stays with its own session.
- **TestFlight:** parked. Mark joined the developer program on 31 Oct; enrolment is pending (up to 48 h). Then: his
  Team ID and an App Store Connect API key (Admin) on the Mac, the project moved to the paid team, bundle ids
  registered, the app record created by Mark (iOS + tvOS), `Tools/testflight.sh both`, internal testing only.
- **Not done:** #111 (ordered guide sources) deferred: P3, and production has one guide, so nothing duplicates today.
  Production's 7 favourites point at a provider id that no longer exists (an earlier provider change, #15's problem);
  6 are identifiable by name (Fox Footy 504, Sky Sports Main Event, ESPN, Sky Sports F1, Sky Sports Premier League,
  Marquee Sports Network): restoring them needs Mark's yes.
- **Waiting for Mark (T5, after deploying):** batches 3b–7 and 4b, the NFL page, plus the older list (#141/#149/#151/#152,
  #22/#23/#24, #147/#148/#153, #6, #5, #12, #8, #18). Open design question: iPhone sport pages (#177). Relay timeline
  renewal stays **off** (D-25).

## Now

Batches by area (D-35), in this order:

1. **Sport pages:** cricket next (mock-up approved 31 Oct; a C-Q-style server answer first), then AFL (off-season
   until March). The NFL page is built (C-Q, Apple 86–87).
2. Batch 8: #4 relay renewal (capture first, a device test with renewal on, released alone): waits for Mark.
3. #29 (collector cost, a pilot) before the Live now dashboard is switched on by default; #85 waits for a format signal.
4. #111 ordered guide sources, when a second guide source is added.

## Next (P1)

- #3 A/V out of step on iPhone/iPad (stays P1, D-24) · #4 a planned renewal that produces no playlist
- #9 a web player preference reverts other settings · #16 Show All / Hide All with no confirm or undo
- #10 a provider reorder hides the wrong channels · #11 guide sync has no retry or staleness alert ·
  #15 promoting a backup provider loses the curated lineup
- #13 in-player channel list is one item or stale · #14 Top Shelf or timer playback with a page open
- #17 play from live on a recording in progress (Mark's request) · #19 Status cannot say which device or build is playing
- #18 tvOS focus after choosing a non-preferred channel: fixed in Apple 62, waiting for Mark's device check

## Later

**P2** (soon), by theme:

- Playback and recording: #34 watch-copy follower deaths · #35 display mode resets on every zap · #36 zap speed
  (no release wait, D-27) · #37 live pause policy (D-26) · #38 tmpfs budget in bytes · #39 sport-aware recording end ·
  #40 retention · #41 simplify the relay/renewal/segment hot spots · #30 reconnect or switch · #26 watch-from-start test
  failure · #27 timestamp step in a recording epoch
- Providers, guide and operations: #42 shrunken playlist guard · #43 backups · #44 crash alert · #45 diagnose without SSH
  · #28 hardware encode check on PassyFlix
- Apple client: #46 stale Home/Top Shelf · #47 degraded `/api/info` · #49 presentation and focus (before the sport
  rebuild) · #50 AppModel split (before the sport rebuild) · #51 observation rule · #53 iOS tests in CI · #54 sign-in and
  pairing tests · #55 launch requests · #25 player frozen after a long play
- Contract and data: #48 Apple routes test · #52 contract fixtures from the server · #56 richer guide programmes ·
  #57 programme search · #58 player overlay rework
- Web: #59 hidden-category ticks · #60 player error texts · #61 Status facts · #62 recordings parity · #63 first run ·
  #64 Settings.js · #65 settings traps
- Sport, after the rebuild's first pages: #66 Football · #67 follow a team · #68 one spoiler switch (D-30) ·
  #69 reminders · #70 record from sport pages · #71 preferred channels · #72 quality labels
- Testing: #73 T3 rig on Unraid · #74 fake-provider stall run
- Device checks for Mark (T5): #31 segmented recordings test day · #32 watch-while-recording audio and exit flash ·
  #33 FOX "AAC Main" re-encode

**P3** (someday): #75–#130, among them the flaky-test list #77, the efficiency register #93, the log watch list #97 and
the Apple and web debts from the 30 Oct audit. Filter: `gh issue list --label P3`.

## How to pick work

1. `gh issue list --label P0`, then `--label P1`. A P0 always comes first (none open on 30 Oct).
2. Otherwise take the next item under **Now**; when Now is empty, the next P1, then by theme from Later.
3. Read the issue, its evidence folder and the area page in `docs/architecture/` before touching code; capture first on
   the playback path.
4. Items labelled `needs-device-test` are not "worked": they go into Mark's T5 checklist in the handover.
5. Keep a batch inside one theme so its Codex review has one focus (AGENTS.md › Reviews).
6. New problems become issues with the template; security matters become private advisories.
