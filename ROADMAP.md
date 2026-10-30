# Roadmap

Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues) (both repos). This page orders it; the
issues hold the detail.

## Current state

*Overwritten at the end of every session. 30 Oct 2026, late (first Windows session).*

- **Server:** production runs **0323**. Pushed this session (Claude pushes reviewed batches, D-34; batches by area,
  D-35): **0330–0332** (#141, a hung share no longer stalls deletes or start-up), **0333–0339** (batch 2, sport
  matching: #22, #23, #24, #82, #20 per-channel times in C-I, findings #154, #155), **0340–0345** (batch 3a, the F1 page's
  data, C-P `GET /api/sports/pages/f1`; findings #156–#158, #160, #161). Image 0345 published; **not deployed** (deploy
  is Mark's). Next build **0346**.
- **Apple:** pushed **69–71** (#147, #148, #153) and **72–73** (#7, D-36: the live start builds its 30 s hold at 0.97×;
  #159). The 30 Oct session keeps #7 to the end (Mark's stopwatch check, any follow-up such as GROW); other work leaves
  #7 and the live catch-up code alone. Next build **74**.
- **Tooling:** Claude works in WSL2 (Ubuntu 26.04) on Windows; the MacBook over SSH (`ssh mac`, LAN only) for Xcode and
  the AVPlayer harness (mac:~/pigtv-build). Ubuntu's ffmpeg 8.0.1 fails 4 HE-AAC tests locally; the Unraid rig
  (`scripts/unraid-rig.sh test`, ffmpeg 9.0.2) is the full-suite gate; staging runs 0332 with the copied login.
- **Waiting for Mark (T5, after deploying):** #141/#149/#151/#152, #22/#23/#24 (next Fox Cricket Test), #147/#148/#153,
  #7 (10 cold plays per test channel with a stopwatch), and the older #6, #5, #12, #8, #18 (untested). Relay timeline
  renewal stays **off** (D-25).

## Now

Batches by area (D-35), in this order:

1. **Batch 3b: the Apple TV F1 page** (#21), on C-P. Mock-up: claude.ai "PigTV Sport mock-ups", "Formula 1 · Apple TV"
   (Mark approved it with DESIGN.md › Sport pages: no section tabs, no season calendar, spacing fixed at build).
   Then AFL or NFL (mock-up "NFL · Apple TV" exists), then cricket, each a mock-up for Mark first.
2. Batch 4: channels and guide when providers change (#10, #15, #11, #42, #106, #111), server.
3. Batch 5: web settings (#9, #16, #59, #65, #128). Batch 6: Apple player channel list and Top Shelf (#13, #14, #46).
   Batch 7: Status (#19, #61, #129). Batch 8: #4 relay renewal, capture first, released alone.
4. #29 (collector cost, a pilot) before the Live now dashboard is switched on by default; #85 waits for a format signal.

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
