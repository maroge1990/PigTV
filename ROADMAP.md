# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 15 Nov 2026, the web upgrade session (batches Web 2, Web 3, Web 4 and the feed
loop; nothing unpushed).*

- **Running:** production is on server **0632** (`:latest`); main is at **0695** and reaches production at Mark's next
  Force Update (D-58). `:release` is still **v0579** (D-45). Apple **246** is on TestFlight (tvOS and iOS). Next builds:
  server **0696**, Apple **247**.
- **Web 2, server 0633 to 0649 (#320 open for Mark's device check, #322 closed, D-63):** no station numbers; player keys
  only on Live TV; Safari fullscreen; closing the tab frees the stream; last channel with Resume, the tab title and Media
  Session; in-player clash prompts. Re-encodes at fixed values (1080p, medium, auto mix), hardware and User-Agent in an
  admin-only Advanced block, no web upscaling. Evidence: `docs/evidence/2026-11-14-web2/`.
- **Web 3, server 0650 to 0664 (#323 closed):** the web Sport section ported from the Apple apps to Mark's approved mocks
  (front page, sport, league, F1, cricket, events, the record menu); hidden scores stay out of the page and its
  accessibility tree (rig: checked in the page source and the tree). Evidence: `docs/evidence/2026-11-14-web3/`.
- **Web 4, server 0665 to 0676 (#321 closed, #62 open for Mark's device check):** the player reconnects as the Apple one
  does (rig: a paused provider came back on the backup in 48 s), Favourite, Record, Audio and Last channel, a Now playing
  bar; the Guide's programme menu, programme search and record marks; recordings prepare before playing, watch from the
  start, Find breaks. Evidence: `docs/evidence/2026-11-14-web4/`.
- **Feed loop, server 0677 to 0695 (#324, open for the real feed):** captured FOX Footy on Strong8K looping a 36 s clip
  (14 Nov, Mark's OK). A feed whose picture and sound repeat is ended and switched to another provider when every viewer
  can move (channel-only quarantine); with nowhere to go it plays on and Status says so. Feeds without a known sound track
  are not checked (Mark). Four sign-off highs in the sound handling were fixed on Mark's say-so. Evidence:
  `docs/evidence/2026-11-15-feed-loop/`.
- **Decisions waiting on Mark:** #232 (Top Shelf); the Appdata Backup setting; #240; #266's rows; #295's colour point;
  whether to tag `:release`; the Force Update to bring 0695 to production.
- **Open investigation:** #3 (sound out of step on the iPad): the relay join measured clean; the device meter (#267) and
  the marker (#268) are filed, not built (Mark).
- Earlier sessions' batches are in their evidence folders under `docs/evidence/` and in git history.

## Now

Batches regrouped on 12 Nov 2026 after the audit; the web upgrade (#320 to #324) is done. Order within a section is the
order to take them.

1. **Sport 2, one source for the sport pages:** #297 · #282 · #29's re-measure; then #291 (after a read of production's
   settings; its item 2 is partly wrong, see the issue).
2. **Sport 3, pickers:** #265 step 2 · #266 (server and Apple), once Mark confirms the rows.
3. **Web leftovers:** #63 first run · #64 Settings.js and sign-out · #292 · #295 · #62's rest (series "new only",
   search, sort, bulk delete).

## Later (each needs a capture, a real provider, a device or a design choice first)

- **A/V sync:** #267 meter · #268 marker, then #3 and #27. **Relay and recovery (released alone, D-25):** #4 · #41's
  transition table and invariant test · #74 · #30. **Start speed:** #240 · #36 · #38.
- **Operations:** #43 · #44 · #45 · #28. **Recording text:** #314. **Logs:** #315. **Recording playback reads:** #318. **Sport join squads:** #319. **Tests:** #26, and the stored replay for #22 to #24 re-run after 0551.
- **Apple launch and tests:** #54 · #55 · #53 · #283 · #313 (Apple 1's review lows) · #316. **Apple structure:** #50 · #51.
- **Apple player:** #25 · #35 · #58 · #308 (Start over from live) · #101. **Apple, design first:** #56 · #57 · #232.
  **Brand kit:** #294.

## Waiting on Mark (no code is waiting; steps are on each issue)

- **Device passes, on production 0632 (includes 0577) and a TestFlight build from 218 (Apple 1's items need one from 239):**
  - Web, after a Force Update to 0695: #320 · #62; the feed loop (#324) on a real looping channel.
  - Playback: #5 · #6 · #7 · #14 · #18 · #19 · #33 · #37 · #46 · #49.
  - Recording day: #12 · #17 · #31 · #32 · #217 · #246 · #260 (P0) · #271 · #274.
  - Sport: #20 · #191 to #199 · #200 to #202 · #204 · #205 · #210 to #216 · #218 · #223 · #230 · #233 · #234 · #261 ·
    #263 · #264; at a real event: #22 to #24 · #206 · #222 · #231 · #235.
  - Layout and brand: #190 · #211 · #225 to #229 · #243 · #277 to #280; from 239: #310 · #311 · #312 · #298 · #293 · #203 ·
    #278's five · #301; from 246 (TestFlight, 14 Nov): #262 on an iPadOS 17 iPad · #317 (sport order by drag).
- **Read-only checks after a release (Claude runs them):** #273 (busy-period rate) · #29 (Mark's Status figures); #259 at
  the next race.
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
