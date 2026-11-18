# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 18 Nov 2026 (evening), the TestFlight-291 feedback session.*

- **Running:** production runs **0819**. main is at **0837**, Apple main and TestFlight **319** (uploaded 18 Nov 17:31
  after the full UI run), all CI green; the server reaches production at Mark's next Force Update (D-58). `:release`
  stays **v0579** until Mark's device checks. Next builds: server **0838**, Apple **320**.
- **Pushed 18 Nov:** Mark's TestFlight 291 feedback (#339–#345, D-68, D-69; evidence `docs/evidence/2026-11-18-sport-cards/`)
  and #348's game channel ranking (0835–0837: measured beats the name, short plays are not health, a recent blank sinks).
- **Held, not pushed:** #348's play fallback (placeholder file at resolve, feed-less blank ends the play, the game's
  next channel with `fallback`) on the lead's `int/batch-348`; four Codex sign-off findings left, listed on #348.
- **Not done:** #349 two tuning screens (Apple) and #348's player channel list and notice (Apple); #350 stall and
  timestamp-loop endings free the slot early; #347; #346; the 50 dead channels wait on Mark. Game run 18 Nov: #331.

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
- **Operations:** #43 · #44 · #45 · #28. **Tests:** #26, and the stored replay for #22 to #24 re-run after 0551.
- **Apple launch and tests:** #54 · #55 · #53 · #313 (Apple 1's review lows). **Apple structure:** #50 · #51.
- **Apple player:** #25 · #35 · #58 · #308 (Start over from live) · #101. 
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
