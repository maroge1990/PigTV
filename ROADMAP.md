# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 19 Nov 2026, the TestFlight-324 splash session (continued).*

- **Running:** production runs **0861**. main is at **0878** (CI green), Apple main at **358** (CI green); TestFlight
  **358** uploaded from the Mac on 19 Nov (tvOS and iOS). Server 0862–0878 reaches production at Mark's next Force Update
  (D-58). `:release` stays **v0579**. Next builds: server **0879**, Apple **359**.
- **Pushed 19 Nov:** #342 splash rework (Apple 325–335, D-73); #351 Xcode Cloud tests (bundled fixtures, `XcodeCloud`
  test plan; Mark sets the plan in the workflow, steps on #351); #353 sport cards name only their own recording, C-R
  `slots`/`guideEnd`/`recordingCancelling` (0862–0875); #347 Apple client (336–358) and the server's 409 `cancelling`
  refusal (0876–0878, D-74); #355, #354, #352's tap-through (Apple 336–358). 27 dead duplicate channels hidden on
  production (#331).
- **Not done:** #356 (recording while a game overruns: design first, needs a migration OK); #357 (four Record edge
  cases from the last sign-offs); #351's Xcode Cloud confirmation run after Mark sets the test plan; the 20 dead channels
  with no copy stay shown.

## Now

Order within a section is the order to take them. Rewritten 20 Nov from the open P1s and P2s that are not waiting on
Mark; the audit window, the pickers (#265/#266) and the placeholder work (#332) are built and wait for device checks.

1. **Record:** #357 (Apple half; the web half shipped in 0879–0880) · #358 (the Record sheet remade on every platform:
   Mark picks from the Apple TV mocks, then iPad, iPhone and web) · #356 (overrun recording: design reviewed by Codex,
   then shown to Mark, then code).
2. **Xcode Cloud:** #351's release run (a `tf/` tag on Apple 359) confirms both builds reach TestFlight.
3. **Sport data (server):** #234 (a future game can't be recorded) · #261 (live scores take two minutes) · #259 (F1
   marked a replay) · #235 (cricket score text refused) · #231 (a listing in another language).
4. **Apple Sport:** #263 (the page header scrolls with the page).
5. **Channel audit:** #331's follow-ups (the 20 dead channels with no copy). #291's dead-code leftovers (P3) moved to Later.

## Later (each needs a capture, a real provider, a device or a design choice first)

- **A/V sync:** #267 meter · #268 marker, then #3 and #27. **Relay and recovery (released alone, D-25):** #4 · #41's
  transition table and invariant test · #74 · #30. **Start speed:** #240 · #36 · #38.
- **Operations:** #43 · #44 · #45 · #28. **Tests:** #26, and the stored replay for #22 to #24 re-run after 0551.
- **Apple launch and tests:** #54 · #55 · #53 · #313 (Apple 1's review lows). **Apple structure:** #50 · #51.
- **Apple player:** #25 · #35 · #58 · #308 (Start over from live) · #101. 
  **Brand kit:** #294. **Cleanup:** #291.

## Waiting on Mark (no code is waiting; steps are on each issue)

- **Built, waiting on a device pass:** the audit window's results with #332 (placeholder) and the pickers #265 · #266.
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
