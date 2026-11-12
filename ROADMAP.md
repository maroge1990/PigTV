# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 12 Nov 2026 (audit batches E, #273, J, #278, and F, #274; H, L and D the day before).*

- **Released:** server **v0579** (`:release`, 13 Nov; v0577 the day before) and Apple **218** uploaded to TestFlight
  (tvOS and iOS, 12 Nov). A release runs on Mark's go-ahead (D-45). Next builds: server **0580**, Apple **219**.
- **The 10 Nov audit** was filed as batch issues #269–#280; each issue's first comment holds the detail and later
  comments Mark's decisions. Pushed: A (#269), I (#277), C (#271), B (#270), G (#275), K (#279), H (#276), L (#280),
  D (#272, with #281), E (#273), J (#278), F (#274). The audit's batches are all pushed.
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
- **12 Nov, batch F pushed with CI green, server 0567 to 0577 (#274, open for Mark's device check):** recording and
  playback duplicates, all six items, in two pushes.
  - A recording's window has one owner: a viewer refused for a recording is told its real end, and the list shows a
    clash during overtime. A recording due during another's overtime starts late (Mark), it is not held.
  - The jobs after a recording (remux, adopt, compress) and the recordings-path check reach the share through its
    bounded helper; a share that does not answer fails the job, deletes nothing and is retried.
  - One owner each for a channel's id and stream address, the count of recordings on a provider, and the walk over
    providers at play start. Every recording is watched for a stall; with one provider it resumes on that provider.
  - Reviews: two Codex highs (a deleted recording's file put back; a bursty feed hiding a dead capture), both fixed and
    signed off. Rig on 0577: play start 4,901 ms (5,398 on 0572), admission, failover, overrun and a stalled
    single-provider recording pass. Not seen end to end: a hung share. Evidence: `docs/evidence/2026-11-12-batch-f/`.
  - Filed: #302 (a stall's gap note under-counts), #303, #304, and the three seen on the way: #305, #306, #307.
- **13 Nov, 0578 and 0579 pushed and released (#3, open for Mark's iPad check):** a play that joined a feed already
  running began with up to a group of pictures of sound before any picture, and the iPad played it out of step (Fox
  Cricket 501, 12 Nov). A joiner now starts on the newest video key frame. Real capture: 0.04 to 1.79 s before, 0.04
  to 0.08 s after; the rig agrees. Left as #309: three edge cases from Codex's sign-off (Mark: ship and file) and
  high-bitrate feeds keeping the old join. Evidence: `docs/evidence/2026-11-13-avsync-join/`.
- **Decisions waiting on Mark** (device passes are listed under Waiting on Mark below):
  - #288: how long a recording keeps trying when every provider is down. #304: should a single-provider stall show
    the provider as down. #307: the provider's host in three log lines. #232: Top Shelf, snapshot or live.
  - The Appdata Backup setting: don't stop PigTV, or move it from Sunday 04:00. #240. #266's rows.
  - Whether #293's missing focus tint is fixed before the next TestFlight build. #295's colour point (brand kit).
- **Open investigation:** #3 (sound out of step on the iPad): the relay join measured clean; the device meter (#267)
  and the marker (#268) are filed, not built (Mark).
- **Next:** the batches under Now, regrouped on 12 Nov after every open issue was read against 0577 and 218.

## Now

Batches regrouped on 12 Nov 2026 after the audit (every open issue read against server 0577 and Apple 218). Each is one
theme and one review round. Order within a section is the order to take them.

1. **Apple 1, the five faults seen during batch J** (last comments on #278; Mark: fix), with #301, #298, #293's
   simulator items and #203's "On air" wording. Simulators against the rig.
2. **Server 1, recording follow-ups** (full review rule): #302 gap note · #286 low-disk reason · #305 waiting reason ·
   #303 one schedule per failed read · #306 log text; #304 and #288 join once Mark has answered them.
3. **Server 2, Status and sign-in:** #299 provider names · #300 device rows of a deleted user · #61's warming line ·
   #307 once Mark has answered. Codex (sign-in code).
4. **Apple 2, iPadOS and iOS 17+ (#262):** seven sites need fallbacks, not three; redo the 17.0 trial build.

## Next

5. **Server 3, the rest of the share:** #289 (segment copies, the owners' sweep, the route's access checks, ad
   detection) · #290 items 1 and 2. Full review rule.
6. **Sport 1, matching:** #296 (a listing with no English name), with what #231 left. Full review rule.
7. **Sport 2, one source for the sport pages:** #297 · #282 · #29's re-measure; then #291 (after a read of production's
   settings; its item 2 is partly wrong, see the issue).
8. **Sport 3, pickers:** #265 step 2 · #266 (server and Apple), once Mark confirms the rows.
9. **Web 1:** #62 play errors · #63 first run without a Home page · #64 Settings.js and sign-out · #292 · #295.

## Later (each needs a capture, a real provider, a device or a design choice first)

- **A/V sync:** #267 meter · #268 marker, then #3 and #27. **Relay and recovery (released alone, D-25):** #4 · #41's
  transition table and invariant test · #74 · #30. **Start speed:** #240 · #36 · #38.
- **Operations:** #43 · #44 · #45 · #28. **Tests:** #26, and the stored replay for #22 to #24 re-run after 0551.
- **Apple launch and tests:** #54 · #55 · #53 · the flaky ChannelWarmer test · #283. **Apple structure:** #50 · #51.
- **Apple player:** #25 · #35 · #58 · #308 (Start over from live) · #101. **Apple, design first:** #56 · #57 · #232.
  **Brand kit:** #294.

## Waiting on Mark (no code is waiting; steps are on each issue)

- **Device passes, on a release that includes 0577 and a TestFlight build from 218:**
  - Playback: #5 · #6 · #7 · #14 · #18 · #19 · #33 · #37 · #46 · #49.
  - Recording day: #12 · #17 · #31 · #32 · #217 · #246 · #260 (P0) · #271 · #274.
  - Sport: #20 · #191 to #199 · #200 to #202 · #204 · #205 · #210 to #216 · #218 · #223 · #230 · #233 · #234 · #261 ·
    #263 · #264; at a real event: #22 to #24 · #206 · #222 · #231 · #235.
  - Layout and brand: #190 · #211 · #225 to #229 · #243 · #277 to #280.
- **Read-only checks after a release (Claude runs them):** #237 · #247 · #273 · #29; #259 at the next race.
- **#21** (the sport rebuild) closes when the sport pass is done: everything under it is built or filed.

**Parked (P3):** #188 lists everything; `gh issue list --state closed --label parked`.

## How to pick work

1. `gh issue list --label P0`, then `--label P1`. A P0 always comes first (#260 is built and waits for its device check).
2. Otherwise take the next batch under **Now**, then **Next**; **Later** only once its capture, device or design choice exists.
3. Read the issue, its evidence folder and the area page in `docs/architecture/` before touching code; capture first on
   the playback path.
4. An issue that needs a device look is not "worked": its numbered steps go in a comment on the issue, it gets the
   `needs-device-test` label, and it closes when he reports (D-38). Everything else closes on T1–T3 evidence once pushed.
5. Keep a batch inside one theme so its one Codex round has one focus (AGENTS.md › Reviews).
6. New problems become issues with the template; security matters become private advisories; someday items get the
   `parked` label and a line in #188.
