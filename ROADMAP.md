# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 16 Nov 2026, the channel audit and closure session (nothing unpushed).*

- **Running:** production runs **0695** (Mark holds the Force Update until the channel audit's window ends, 17 Nov 11:30
  AEDT; a restart stops it). main is at **0787**: everything below reaches production at his next Force Update (D-58).
  `:release` is still **v0579** (D-45). Apple main **255** (TestFlight still 246; uploads are cloud-signed, D-64).
  Next builds: server **0788**, Apple **256**.
- **Channel audit (#331, running in production's container, read only on the provider, yields to plays and
  recordings):** passes 1-2 (15-16 Nov) and a 24 h priority window (16-17 Nov, `data/audit/window-1116`). Findings: the
  provider's placeholder (one identical still frame, about 193 kbps) on about 80 channels while the guide shows a
  programme; switching to another copy rescued every blank so far, retrying the same stream none; the UK "skips" were
  subtitle-track gaps (picture and sound clean). Script: `scripts/channel-audit.js` on the audit branch, not on main.
- **Shipped today (each with evidence under `docs/evidence/2026-11-16-*`):** providers tested before saving and no
  provider host in logs (0758-0765, #330 open for the browser check, #315 and #319 closed); recording safety: one active
  schedule per game, an atomic move, share reads off the thread pool (0766-0772, #329, #314, #318 closed); the
  placeholder detected and a same-provider copy tried (0773-0779, #332 waits for the audit's figures and Mark's check);
  Events detail and status held back for a score delay (0780-0783, #328 closed, Mark's choice); a placeholder file never
  kept in a recording and MP4 audio sane at joins (0784-0787, #333 closed); Apple 247-255 (#313 items, #268's button,
  #329's wording, #316).
- **Production repair (T4, Mark's go-ahead):** the 16 Nov NFL recording held an hour of placeholder file and broken audio
  joins; its MP4 was rebuilt by hand and plays (#333 has the evidence).
- **Decisions waiting on Mark:** #232 (Top Shelf); #283 (fixture flags: options); the Appdata Backup setting; #240;
  whether to tag `:release`; #265/#266's picker design (mock-ups first).

## Now

Order within a section is the order to take them.

1. **After the audit window (17 Nov):** its summary (`node channel-audit.js summary window-1116`): the hide list of dead
   channels, copy rescue rate for #332, then a Force Update and Mark's device checks of 0758-0787.
2. **Sport 3, pickers:** #265 step 2 · #266, now on the audit's measurements (copies share a stable id or a normalised
   name; names that state a quality can be wrong). Design mock-ups for Mark first.
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
