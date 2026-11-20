# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 20 Nov 2026, the Record-sheet session.*

- **Running:** production runs **0861**; server main **0886** (CI green), so 0862–0886 reach production at Mark's next
  Force Update (D-58). `:release` stays **v0579**. Apple main **372** (CI green). TestFlight **323 = Apple 372**
  (`tf/372`, all of Apple 359–372); 322 = Apple 365 was the first Xcode Cloud release (D-75). Next builds: server
  **0887**, Apple **373**.
- **Pushed 20 Nov:** #358 Record sheet on every platform (web 0882, 0885–0886; Apple 366–370; D-76) with "Usual = ESPN's
  end" for games and its safety net (0881, 0883, 0884); #357 Record safety fixes (web 0879–0880, Apple 359–365, 371–372);
  #351 Xcode Cloud release works (XcodeCloud is the scheme's default plan; closed). Cleanup: 66 old worktrees and 162
  merged branches removed.
- **Not done:** #356 parked after two Codex design rounds each found highs (designs in `/home/markr/wt/design-356*.md`,
  reviews `codex-356-design*.txt`); one web medium on #358 (stepping Start early can drop a carried Finish late).

## Now

Checked 20 Nov against every issue's comments and commits: almost all P1/P2 work is built and waits for Mark's device
checks (`needs-device-test`, see Waiting on Mark). What still needs code, in this order (Mark's write-up:
https://claude.ai/artifact/UC3WMGdoRtEnGbJ8a3MmgA):

1. **A · done 20 Nov** (web 0885–0886, Apple 371–372, TestFlight 323). One web medium left on #358.
2. **B · Operations (server; needs Mark's choices) and C · Apple launch and sign-in, side by side** (different repos).
   B: #44 crash alerts (untouched) · #43 backups' remainder (retention, a second disk, Back up now) · #45 diagnose
   without SSH (untouched); ask Mark how to be alerted and where backups go. C: #55's remainder (show the saved guide
   before the server answers, a Restore signpost) · #54's remainder (a mid-session 401, pairing tests) · #53 iPhone/iPad
   unit tests on CI (D-49 keeps interface tests off CI; ask Mark before changing that).
3. **D · Apple structure** (after C's tests): #50 · #51 (untouched).
4. **E · Apple player** (Mark's devices; playback path, capture first): #25 · #35 (untouched) · #58's remainder (Now
   Playing info, VoiceOver label, stall watchdog, polling) · #308 Start over (design first).
5. **F · Playback reliability** (capture windows Mark approves; released alone, D-25): #74 · #30 · #27 (untouched) ·
   #38's byte budget · #36's zap chain · #41's transition table and randomized test.

**Folded into whichever batch touches the same files:** #292 items 5–12 · #295's remainder · #290 items 3–4 · #291's
remainder · #313 item 4. **Decisions for Mark:** #294 (brand kit icons). **A check Claude runs:** #273 (busy-period
sample on production). **Parked:** #356.

## Waiting on Mark (no code is waiting; steps are on each issue)

- **Newest, after a Force Update to 0884 and the next TestFlight (from Apple 366):** Record #358 and #357 (web 0879–0884,
  Apple 359–370) · #347 · #342 splash · #349 · #348 · #352 · #354 · #332 placeholder and the audit window · pickers #265 · #266 · #330.
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
