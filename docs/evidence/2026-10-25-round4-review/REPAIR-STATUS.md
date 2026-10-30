# Repair status after the round-4 review (25 Oct)

Local work on 25 Oct from server 0255 (`63a022f`, review docs `93583f6`) and Apple 53 (`6c552cb`), answering
[REVIEW.md](REVIEW.md) with [DVR.md](DVR.md), [SERVICE.md](SERVICE.md), [APPLE.md](APPLE.md) and [CHECKS.md](CHECKS.md).
It updates [the 24 Oct repair status](../2026-10-24-independent-review/REPAIR-STATUS.md) for D1, R-S5 and A5. That file's D2, D3, D4 and A2-R entries
stand (the review passed them, and they are unchanged here), as do its F4 policy proposal, efficiency dispositions and
device steps. Nothing pushed or deployed; no deployed server or provider contacted; no playback flag changed.

"Fixed locally" means implemented, with a test that fails on the code before it (shown below), and the repository checks
passing. It is not device or real-feed acceptance; nothing here is *Verified*.

## The four findings

| ID | Commit / build | Disposition |
|---|---|---|
| R4-D1 (P1) | server 0256 | Fixed locally. No migration infers ownership any more (0251's schema-init claim is removed). Once, from the finishing queue: a pathless kept original whose segments are still in appdata is claimed only when "<name>.ts" is byte for byte those segments, else the row goes back to `moving` and publishes an original of its own; one whose segments are gone (0227–0241) cannot be proven and is left in place, also on delete, and logged. |
| R4-D2 | server 0257 | Fixed locally. `deleteRecording` retires the recording before its first await; the kept original, the fallback `.ts`, the share move and the MP4 itself each check that after their await, and remove only what they published themselves. |
| R4-S1 | server 0258 | Fixed locally. A discovery entry that cannot say which series it is (not an object, `leagues` not a list, a league without an id) makes the discovery failed (all entries) or partial (some), never "no series". `{ scores: [] }` stays a real empty answer. |
| A5-R2 | Apple 54 | Fixed locally. A prune pass is repeated while the cache is over its cap if it removed something **or** a change added bytes while it ran (that write's own claim was refused because the prune was running). A pass that removed nothing with nothing written meanwhile stops, so undeletable files never loop. |

With these, DVR-1, S5 and A5 are fixed locally. DVR-3 stays **within the stated policy only**: the heuristic is not
durable identity, and its broader intent is not closed until Mark accepts a policy or a stronger identity source exists.

### Before/after proof

| ID | Test (file) | Before | After |
|---|---|---|---|
| R4-D1 | `R4-D1: reopening the database after 0242 stopped mid-copy, then deleting, keeps another file…` (recording-segments) | fails on behaviour: the foreign "<name>.ts" is deleted (ENOENT) | passes |
| R4-D1 | `R4-D1: a copy 0242 never finished…`, `…finished but was never recorded…`, `…0227-0241 finished (segments gone)…` | fail: the recovery function does not exist on 0255 (absence, not behaviour) | pass |
| R4-D2 | `R4-D2: a kept original that finishes while the deletion is still running…` | fails: the late copy recorded itself | passes |
| R4-D2 | `R4-D2: the fallback .ts that finishes after / during the deletion…` | both fail: the `.ts` is left on the share | pass |
| R4-D2 | `R4-D2: an MP4 moved to the share while the deletion is still running…` | fails | passes |
| R4-D2 | `R4-D2: an MP4 whose remux ends while the deletion is still running…` | fails | passes |
| R4-S1 | `R4-S1: a discovery whose only entry is unreadable (leagues not a list / not an object / a league without an id)…` (sports-fixtures) | all three fail: the match is erased | pass |
| R4-S1 | `R4-S1: a discovery with readable and unreadable entries is partial…` | fails | passes |
| A5-R2 | `CacheTests.testAWriteThatCrossesTheCapWhileAnEmptyPassEndsIsStillPruned` | fails: disk 2000 > cap 1500, no prune running | passes |
| A5-R2 | `CacheTests.testFilesThatCannotBeDeletedEndThePruneInsteadOfLooping` | passes (guard: build 53 also stopped) | passes |

How "before" was run. Server: `git stash` of `server/` only (the new tests kept), the named tests with `--test-timeout`,
then unstashed; `pgrep` found no fixture process left. Apple: an isolated copy with build 53's stop condition restored
by [`apple-mutate-a5r2.py`](apple-mutate-a5r2.py), only the two tests selected: **2 run, 1 failed (exit 65)** as above.
In that copy the guard test took 92 s (0.005 s on the real tree); the cause was not established (it follows the failing
test, and may be XCTest's diagnostics after a failure).

All the tests above use barriers rather than timers. On the server: a copy held at its end, the deletion held in its
work-folder removal, the remux or share copy held. On Apple: `ArtworkBudget.afterPass`, nil in the app, holds a pass
between its removals and its decision. The guard test's 20 s `fulfillment` timeout only stops a hang; it proves nothing.

The 24 Oct before/after tests (0251–0255, Apple 52–53) are kept and pass, with one exception. 0251's `D1: an original
kept by 0227-0241 … is claimed once at startup and deleted with its recording` asserted the unsafe claim this round
removes, so it is replaced by the R4-D1 tests.

## The full-suite failures in CHECKS.md

Investigated rather than retried; no product code changed (commit `4e6cb33`).

- **`sports-worker.test.js:144`** (revision 7 vs 6): **root cause found and reproduced.** The test asks for events at
  `NOW` (fixed when the file loads), while `setFollow()` schedules its rebuild for the real `Date.now()`. The build key
  includes a 5-minute bucket, so when a bucket boundary passed between the file's start and this test, the two were
  different keys and two builds published. Reproduced every time by moving the request back a bucket (`3 !== 2` at
  :144). The product is consistent (requests and `setFollow` both use the real clock). The test now holds `Date.now` at
  `NOW` for its duration, and passes with the real clock 5 minutes past `NOW`.
- **`start-failure.test.js:259`** (retry-extended `waitForPlaylist(1500)` false): **cause narrowed, not reproduced.**
  The scenario was run 12 times idle and 12 under a parallel full suite. Time between spawns that the allowance does not
  count: 3–9 ms, so the extension is exact. What is tight is the last attempt's own 1.5 s, which includes starting a
  fresh Node child (50–280 ms here; plausibly over 1 s on a saturated 2-vCPU runner). The test now has 4 s of refused
  attempts against a 3 s timeout, which still fails with the extension zeroed (shown), and the last attempt gets 3 s,
  a margin of at least 1 s per AGENTS.md. It also asserts that both refusals were retried, so a missed retry window
  would show as a different failure.
- After this, three consecutive full runs passed: **1099 tests, 1094 passed, 5 skipped, 0 failed** each. That is a local
  result on the MacBook. It is not proof for CI's 2 vCPUs, where the start-failure margin was the tight one.

## Checks run

- Server, Node 24, `PIGTV_SKIP_PERF=1 npm test`: **1099 tests, 1094 passed, 5 skipped, 0 failed**. That held on three
  consecutive runs after the test fixes, and on a fourth run alongside the Xcode push tier. Every commit before those
  passed the same gate. `bash scripts/verify-build.sh .`: all checks passed, at every commit.
- Apple, build 54: `sh Tools/test.sh push` exit 0. **243** contract checks; unit tier **227/227** (rerun with a result
  bundle, because the script's own bundle is not kept); regression UI **16/16** (xcresult). iOS simulator build exit 0.
  Simulators shut down; no booted device left.
- Browser focus harness: not rerun; no web code changed in 0256–0258.
- Timing: no instability seen in these runs. The one timing-sensitive test fixed here (start-failure) has not been
  observed on CI's 2 vCPUs since; watch its first CI run.

## Contract

`docs/CLIENT-CONTRACT.md` C-M now states exactly what a cancel holds against, replacing "never made again … however far
it moved": the ±15-minute presence window, the 72-hour Sport horizon, nearest-time pairing as a guess, the pre-buffer
rule, and series without episode data recreated after a 20-minute correction. It says plainly that this is not durable
identity, and that a policy change is pending. It also documents deletion during a failover move (`cancelled`, 0252)
and that a recording deleted while it is being finished leaves nothing on the share (0257). No route, field or status
was added.

## Decisions (Mark, 25 Oct)

1. **F4 policy: accepted as proposed** (ambiguous pairs record; keep the 72-hour horizon; metadata-free series pair on
   their channel up to 3 hours). Implemented in **0259**. In `recording-rules-events`, the two tests that pinned the
   old limits are replaced by tests of the policy. The four tests for changed behaviour fail on 0258, and the three
   kept-behaviour tests (a clear single cancel, the horizon, episode-keyed series) pass on both. C-M states the policy.
2. **Unprovable pre-0243 originals:** no action. There are no such recordings, so 0256's log line will not fire.

## Still open

- Device and real-feed acceptance for everything (the 24 Oct steps plus the additions below). Nothing is *Verified*.
- Bug 5 (AUS v SA) and bug 8 (iPhone "Tuning"): no root cause. R4-S1 is not shown to be the cause of bug 5.
- The efficiency register: unchanged dispositions (all deferred, none measured; [24 Oct status](../2026-10-24-independent-review/REPAIR-STATUS.md)).

## Device steps for this pass

1. **Versions:** after deploying, `/api/version` shows build 0258 or later; Settings → Version on each Apple device
   shows 54.
2. **After the first restart on 0256 (Segmented recordings on):** look in the server log for `[Recordings]` lines about an
   original ("kept original", "cannot be proven"). A "cannot be proven" line names a `.ts` left in place; tell me if one appears.
3. **Delete while finishing (0257):** delete a segmented recording in the minute after it ends (while its MP4 is being
   made); nothing of it should be left in its channel folder.
4. **Cricket (0258):** Status → Sport fixtures, the Cricket row after a refresh; report any "unreadable" error text.
5. **Artwork cache (Apple 54):** as in the 24 Oct step 3; logos keep appearing after a long browse.
