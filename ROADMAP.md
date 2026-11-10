# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 10 Nov 2026 (#287: publishing a recording no longer waits on the share).*

- **Released:** server **v0502** (`:release`, 9 Nov) and Apple **191** on TestFlight (tvOS and iOS). A release runs on
  Mark's go-ahead (D-45). Pushed since, not released: server **0503 to 0515**, Apple **192 to 197**. Next builds: server
  **0516**, Apple **198**.
- **10 Nov, audit:** filed as batch issues #269–#280 and bug #281; each issue's first comment holds the detail and a
  later comment Mark's decisions. Batches A (#269), I (#277) and C (#271) are pushed, and #287 after C. Order from
  here: B (#270), G (#275), K (#279), H (#276), L (#280), D (#272, with #281), E (#273), J (#278), F (#274).
- **10 Nov, batch C pushed with CI green (#271; D-56), server 0504 to 0509:** every recording is captured segmented and
  nothing else (the part-based path, its switch and break detection during capture are gone); #284, #285 and the
  low-disk check fixed on the way. Evidence: `docs/evidence/2026-11-10-batch-c/`.
- **10 Nov, #287 pushed with CI green, server 0510 to 0515 (closed):**
  - Publishing a finished recording makes no synchronous call on the share: every share call on that path runs in the
    share helper with a deadline. A share that stalls mid-publish no longer freezes the server; the recording is
    published once when the share answers, and a stall is not counted as a failed attempt.
  - Opus review: one high (two runs finishing one recording) and three mediums, fixed before the commit. Codex: one
    high and one medium on 0511, one high on 0514, each fixed and signed off (0512, 0513, 0515). CI's red run on 0513
    was a real ordering fault, fixed in 0514.
  - T3 on the rig passed: with the share frozen mid-publish the worst API call took 40 ms, a playing channel carried
    on and another recording started. Evidence: `docs/evidence/2026-11-10-share-publish/`.
  - Filed, not fixed: #289 (P2: compression, native-playback preparation and the publish copies still wait on the
    share), #290 (P3: small leftovers after a stall), #286, #288.
- **Waiting on Mark:**
  - T5 device checks: #271 (one real recording end to end, on a build from 0509), #277 (open Sport once on Apple TV,
    iPad and iPhone, on a build from 197), #246 (stop the container mid-recording), #260, the iPhone and iPad fixes in
    176–191, Watch on…, and T4 for #259 at the next race.
  - #288: how long a recording keeps trying when every provider is down (today about 5 minutes).
  - The Appdata Backup setting: don't stop PigTV, or move it from Sunday 04:00.
  - #240.
- **Open investigation:** #3 (sound out of step on the iPad): the relay join measured clean; the device meter (#267)
  and the marker (#268) are filed, not built (Mark).
- **Next:** batch B (#270); then G (#275); then #262 (iPadOS/iOS 17+, three sites need fallbacks).

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
