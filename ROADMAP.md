# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 15 Nov 2026, the sport and web parity session (batches Sport parity, Sport 2,
Web Sport windows and Web leftovers; nothing unpushed).*

- **Running:** production ran **0695** after Mark's Force Update on 15 Nov (it started clean: database copied before the
  0632 to 0695 migrations, no errors, no feed-loop "repeating" lines). main is at **0757**: everything below reaches
  production at his next Force Update (D-58). `:release` is still **v0579** (D-45). Apple **246** on TestFlight. Next
  builds: server **0758**, Apple **247**. Brand kit **1.9.1** (PigBrand 102e200: status text colours).
- **Sport parity, server 0696 to 0711 (#325 closed, #326 open for Mark's check):** the Sport page fills the window; the
  web Sport pages and cards look like iOS (iPad layout on wide windows, iPhone under 768 px; the league page embedded
  under a sport's banner; ⋯ on hover with right-click). Evidence: `docs/evidence/2026-11-15-sport-parity/`.
- **Sport 2, server 0712 to 0723 (#297 closed; #282 open for the Apple check; #291 item 2 done; #29 re-measured):** F1,
  Cricket and Events pages take status from the score collector and hold back results for a delayed account; a game past
  its guide slot stays in /api/sports/events until the final; with scores off the front page shows the fixture list's
  games as upcoming cards. Production's settings (read only): relay, standby, shared ingest and renewal are on, so #291's
  other items are playback work. Evidence: `docs/evidence/2026-11-15-sport2/`.
- **Web Sport windows, server 0724 to 0734 (#327 open for Mark's check):** ‹ › on card rails; iOS's game details and
  record page (choose the channel; When it stops: ESPN's end via the game id, #217); Save never makes a second recording.
  Evidence: `docs/evidence/2026-11-15-web-sport-windows/`.
- **Web leftovers, server 0735 to 0757 (#62, #63, #64, #130, #292, #295):** Recordings new-only series rules, search, sort,
  bulk delete; one Settings save model (Settings.js split under `pages/settings/`), one signed-in fetch (`API.authFetch`),
  a sign-out that always signs out; Live TV first-run checklist then a slim banner (Mark); brand 1.9.1 status text; the
  channel list race, notices, dialogs and layout leftovers. Evidence: `docs/evidence/2026-11-15-web-leftovers/`.
- **Decisions waiting on Mark:** #328 (Events fields under a score delay while live); #232 (Top Shelf); the Appdata Backup
  setting; #240; whether to tag `:release`; a short probe of the six unlabelled "Sky Sports F1" channels for Sport 3.
- **Open investigation:** #3 (sound out of step on the iPad): the device meter (#267) and the marker (#268) are filed, not
  built (Mark).

## Now

Order within a section is the order to take them.

1. **Sport 3, pickers:** #265 step 2 (quality from the measured stream, `channel_profiles`) · #266 (group true copies).
   Production has six visible channels named exactly "Sky Sports F1" (USA guide 1, UK guide 2, Sport Networks 3) with no
   quality word: measured labels first, then grouping. Channels never played need a short probe: ask Mark (a real
   provider connection).
2. **Recording safety:** #329 (a server-side guard against two schedules of one game) · #330 (test a provider before
   saving it; `/estimate` errors through `redact()`).
3. **Relay and playback leftovers:** #291 items 1, 3, 4, 5 (capture first, full Codex rule).

## Later (each needs a capture, a real provider, a device or a design choice first)

- **A/V sync:** #267 meter · #268 marker, then #3 and #27. **Relay and recovery (released alone, D-25):** #4 · #41's
  transition table and invariant test · #74 · #30. **Start speed:** #240 · #36 · #38.
- **Operations:** #43 · #44 · #45 · #28. **Recording text:** #314. **Logs:** #315. **Recording playback reads:** #318. **Sport join squads:** #319. **Tests:** #26, and the stored replay for #22 to #24 re-run after 0551.
- **Apple launch and tests:** #54 · #55 · #53 · #283 · #313 (Apple 1's review lows) · #316. **Apple structure:** #50 · #51.
- **Apple player:** #25 · #35 · #58 · #308 (Start over from live) · #101. **Apple, design first:** #56 · #57 · #232.
  **Brand kit:** #294.

## Waiting on Mark (no code is waiting; steps are on each issue)

- **Device passes, on production 0632 (includes 0577) and a TestFlight build from 218 (Apple 1's items need one from 239):**
  - Web, after a Force Update to 0757: #320 · #62 · #326 · #327 · #63; the feed loop (#324) on a real looping channel;
    #282 on the Apple apps with scores off (rig).
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
