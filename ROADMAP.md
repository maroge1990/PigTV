# Roadmap

Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues) (both repos). This page orders it; the
issues hold the detail.

## Current state

*Overwritten at the end of every session. 30 Oct 2026.*

- Server: **0317** last pushed; **0318–0323** committed locally for Mark to push (sport review repairs, renewal-pin
  accounting, hardening tracked in private advisories, a newer device request ending a recovering relay). Next build **0324**.
- Apple: **61** last pushed; **62–63** local (sport action repairs, tvOS player focus #18). Codex rounds on 62–63 done.
- Documentation reset done (D-22): issues #3–#130 replace the findings register and the roadmaps.
- Relay timeline renewal goes **off** in production (D-25): Mark unticks Settings → System, Claude confirms over SSH.
- Live now dashboard stays gated (D-29). T3 test rig not live yet (#73); the fake provider is built.

## Now

In this order (D-31):

1. #6 Live player drops "Tuning…" before the first picture, never shows buffering, no start or stall timeout
2. #5 A second stream loss within 120 s shows an error mid-game instead of recovering
3. #7 The 30 s live hold cannot apply at the start of a play
4. #12 Overlapping recordings are silently delayed or missed (with the connection rule, D-28)
5. #8 A hung recordings share can freeze all playback

Then the **sport rebuild, #21**, absorbing #22, #23 and #24 (sport recognition on real guide rows) and #20 (per-channel
airing times), with #29 (collector cost) before the dashboard is enabled by default.

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
