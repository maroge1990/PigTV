# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 12 Nov 2026 (audit batches E, #273, and J, #278; H, L and D the day before).*

- **Released:** server **v0502** (`:release`, 9 Nov) and Apple **191** on TestFlight (tvOS and iOS). A release runs on
  Mark's go-ahead (D-45). Pushed since, not released: server **0503 to 0566**, Apple **192 to 218**. Next builds: server
  **0567**, Apple **219**.
- **The 10 Nov audit** was filed as batch issues #269–#280; each issue's first comment holds the detail and later
  comments Mark's decisions. Pushed: A (#269), I (#277), C (#271), B (#270), G (#275), K (#279), H (#276), L (#280),
  D (#272, with #281), E (#273), J (#278). Left: **F (#274)**; the handover note is a comment on #274.
- **11 Nov, batch H pushed with CI green, server 0534 to 0541 (#276, closed):** the web app under brand 1.8.
  - Mark's picks: no Home page (the app opens on Live TV, favourites first); compact Sport cards; Recordings as
    picture cards; text at 16 px with the guide grid, the channel list and the admin tables as recorded exceptions.
  - One block for loading, empty and load-error on every page; one focus ring; 44 px touch targets; colour roles;
    opaque surfaces under forms; reduced motion, transparency and contrast handled; one date format; one rose button
    per screen; page titles and Settings tabs in the address; Undo (10 s) in place of a confirm where an action can
    be undone, sent reliably when the page closes or you sign out.
  - The 12-point review of the web (in `docs/DESIGN.md`): 8 pass, 3 pass with a note, 1 fail (status colours under
    4.5:1 in the light theme: a brand-kit decision). Leftovers: #295. Evidence: `docs/evidence/2026-11-11-batch-h/`.
- **11 Nov, batch D pushed with CI green, server 0542 to 0558 (#272 and #281, closed):** the server's sport code.
  - The score collector is the only fetcher and store of ESPN's scoreboards; the guide's live/replay check and the
    League and NFL pages read it, so they change with the front page (seen on the rig within one 10 s poll).
  - One fetch for every sport feed request (allow-list, size cap, cooldown); one reading of ESPN's game status; one
    page cache; the event list and fixture loops sleep when nobody is looking and no rule needs them; a score
    history row only on change (the table keeps the shape older builds write to, so rollback is safe from 0553).
  - #281: a club ESPN lists twice no longer gets another club's badge (Sydney Swans). 0556: the web says "Hide scores".
  - Filed: #296 (the shared channel matcher misses foreign-language listings; the NFL page keeps its own), #297 (F1,
    Cricket and Events pages still read ESPN themselves; the old path when the collector is off). Evidence:
    `docs/evidence/2026-11-11-batch-d/`. The first CI run was red on one test that needed git; fixed in `e25e29f`.
- **11 Nov, batch L pushed with CI green, Apple 204 to 208 (#280, open for Mark's device check):** the Apple apps.
  - Mark's picks: loading is page-shaped placeholders that pulse; empty is the small pig with one button; an error is
    the pig in a retry ring with "Try again", and content stays under a slim notice when a refresh fails.
  - Every screen draws those states from shared components; league pages no longer spin for ever; sign-in errors are
    on the form; no codes on screen; one name per thing ("Hide scores", "Try again", "Close player"); the splash only
    while loading; rounded figures; iPhone sizes and the follow card; Increase Contrast; two named animations.
  - Simulator only. Evidence and the numbered device steps: `docs/evidence/2026-11-11-batch-l/`. Filed: #298 (iPad
    layout faults in the real F1 page and the Sport banner).
- **12 Nov, batch E pushed with CI green, server 0559 to 0566 (#273, open for a read-only check after a release):**
  the server's hot paths; nothing to see, the same answers for less work.
  - A paired device's media requests write "last seen" once a minute, not each time (the revoke check is still read on
    every request); a known logo is a memory lookup; the provider list is parsed once per change, not a dozen times per
    play; the Status poll reads its slow parts once a minute; a scheduled sync leaves an unchanged backup or Xtream list
    alone; the nightly database copy waits for a sync.
  - Review: no high in the six; one medium in the sync check (a failed relink was never retried), fixed in 0565; Codex's
    sign-off found a high in that fix, fixed in 0566 on Mark's say-so and signed off. A relink is now a recorded debt.
  - Rig: a device revoked mid-stream was refused on its next request; play start unchanged. Evidence:
    `docs/evidence/2026-11-12-batch-e/`. T4 after a release: production's write-ahead log size and write rate.
  - Filed on the way: #299 (the Status page shows no provider name on sessions and recordings, since 0175), #300 (deleting
    a user leaves that user's device rows behind; nothing is exposed).
- **12 Nov, batch J pushed, Apple 209 to 218 (#278, open for Mark's device check):** the Apple apps ask for less and
  keep each piece of state in one place.
  - Under the full-screen live player nothing but playback is requested (the minute pass and the pages rest, and run
    once when it closes); favourites every 5 minutes; the Guide's sport list at most every 5 minutes; the Sport front
    page no longer redraws on every scroll step.
  - Recording rules have one owner: a team's "Record every game" switch in Settings › Sport and Recordings › Scheduled
    read one list and send through one queue. Hide scores has one writer and one function that decides it.
  - Review: Opus no high; Codex one high (a rule could be sent while the rules had not loaded), fixed in 218 with the
    medium and three lows, signed off. Simulators against the rig: six checks pass. Evidence:
    `docs/evidence/2026-11-12-batch-j/`. The audit's larger merges were not built; they are listed on #278.
  - Seen on the way, for Mark: no screen draws the cricket page's Hide scores chip; the iPhone strip's LIVE pill has no
    word in it; a suspended game's fixture card says "Played".
- **Waiting on Mark:**
  - A release: nothing since v0502 and Apple 191 is released.
  - T5 device checks: #278 (on a TestFlight build from 218; steps on the issue), #280 (on a build from 208; steps in
    its evidence folder and on the issue), #279 (on a
    build from 203), #271 (one real recording end to end, on a build from 0509), #277 (open Sport once on each
    device, on a build from 197), #246 (stop the container mid-recording), #260, the iPhone and iPad fixes in
    176–191, Watch on…, and T4 for #259 at the next race.
  - #288: how long a recording keeps trying when every provider is down (today about 5 minutes).
  - The Appdata Backup setting: don't stop PigTV, or move it from Sunday 04:00.
  - #240. Whether #293's missing focus tint is fixed before the next TestFlight build.
  - #295's colour point: darker status colours for small text are the brand kit's to decide.
  - Batch F (#274): the two recommended items only, or all six.
- **Open investigation:** #3 (sound out of step on the iPad): the relay join measured clean; the device meter (#267)
  and the marker (#268) are filed, not built (Mark).
- **Next:** F (#274, after Mark's scope answer); then #262 (iPadOS/iOS 17+, three sites need fallbacks).

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
