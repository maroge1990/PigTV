# Roadmap

Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues) (both repos). This page orders it; the
issues hold the detail.

## Current state

*Overwritten at the end of every session. 31 Oct 2026, early (second Windows session; D-37: Claude worked through
batches 3b–6 without Mark, no device testing, no deploy needed).*

- **Server:** production still runs **0323** (nothing since 0324 is deployed; deploy is Mark's). On GitHub: **0346**
  (batch 3b: household spoiler-free and followed driver, C-P), **0347–0356** (batch 4: hidden channels follow the channel
  #10, new provider groups held for review, shrunken playlist/guide held #42, ingest deadlines and User-Agent #106,
  04:30 schedule, retries and guide-stale warning #11; findings #166–#170, #173), **0357–0362** (batch 5, web: Show/Hide
  all pending with confirm and Undo #16, hidden-group ticks #59, unsaved-edit guards #128, single-key player settings #9,
  New on the provider list, settings copy #65; findings #174–#176). CI green for each. Next build **0363**.
- **Apple:** on GitHub **74–78** (batch 3b: per-channel airing times #20, the Formula 1 page on Apple TV, iPad, iPhone
  #21; findings #162–#165, #171, #172) and **79–83** (batch 6: channel list #13, Top Shelf/timer plays close open pages
  and a watchdog ends a play whose player never appears #14, Home and Top Shelf freshness #46; findings #178, #179).
  Next build **84**. #7 (live hold) stays with its own session.
- **Tooling:** WSL2 on Windows; the Mac over SSH (Xcode, simulators; its two Apple TVs and iPhone are paired with Xcode
  but were not used); the Unraid rig is the full-suite gate (`unraid-rig.sh test`); `PIGTV_RIG_SPORT_FIXTURES=1
  unraid-rig.sh up` lets staging fetch ESPN for the sport pages (staging now runs 0346+). A read-only copy of production's
  database is on the Unraid test share for migration rehearsals (D-37).
- **Waiting for Mark (T5, after deploying):** everything above, plus #141/#149/#151/#152, #22/#23/#24 (next Fox Cricket
  Test), #147/#148/#153, the older #6, #5, #12, #8, #18. Open design question: iPhone sport pages as one scroll or pages
  (#177). Relay timeline renewal stays **off** (D-25).

## Now

Batches by area (D-35), in this order:

1. **Batch 7: Status** (#19 which device and build is playing, needs an Apple header; #61 Status facts; #129 Status
   cost: measure first). A UI test for #179 (open a page, deliver a play link) is owed.
2. **Batch 4b** (server): #15 promote a backup without losing the lineup (carry favourites, numbers, hidden choices, EPG
   matches, rules and schedules through `channel_links`, with a dry run), #111 ordered guide sources.
3. **Sport pages:** AFL or NFL next (mock-up "NFL · Apple TV" approved earlier), then cricket (mock-up approved 31 Oct;
   needs a C-P-style server answer first), each Apple TV first.
4. Batch 8: #4 relay renewal (capture first, a device test with renewal on, released alone): waits for Mark.
5. #29 (collector cost, a pilot) before the Live now dashboard is switched on by default; #85 waits for a format signal.

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
