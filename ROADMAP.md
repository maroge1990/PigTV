# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 11 Nov 2026 (audit batches H, L and D: #276, #280, #272).*

- **Released:** server **v0502** (`:release`, 9 Nov) and Apple **191** on TestFlight (tvOS and iOS). A release runs on
  Mark's go-ahead (D-45). Pushed since, not released: server **0503 to 0558**, Apple **192 to 208**. Next builds: server
  **0559**, Apple **209**.
- **The 10 Nov audit** was filed as batch issues #269–#280; each issue's first comment holds the detail and later
  comments Mark's decisions. Pushed: A (#269), I (#277), C (#271), B (#270), G (#275), K (#279), H (#276), L (#280),
  D (#272, with #281). Left, in this order: **E (#273), J (#278), F (#274)**; the handover note is a comment on #273.
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
- **Waiting on Mark:**
  - A release: nothing since v0502 and Apple 191 is released.
  - T5 device checks: #280 (on a TestFlight build from 208; steps in its evidence folder and on the issue), #279 (on a
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
- **Next:** batch E (#273: server hot paths; no design choices; Codex round); then J (#278: scout first, batch L
  moved its lines); then F (#274); then #262 (iPadOS/iOS 17+, three sites need fallbacks).

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
