# Repair status after the 24 Oct independent review

Local work on 24 Oct, from server 0250 (`bc92dfc`) and Apple build 51 (`64f1258`), answering
[REVIEW.md](REVIEW.md) (with [DVR-REVIEW.md](DVR-REVIEW.md), [SERVICE-REVIEW.md](SERVICE-REVIEW.md) and
[APPLE-REVIEW.md](APPLE-REVIEW.md)). **This supersedes [the 23 Oct repair status](../2026-10-23-fix-review/REPAIR-STATUS.md)**
wherever they differ; that file is kept as the claim the review examined. Nothing pushed or deployed; no deployed server
or provider contacted; no playback flag changed.

"Fixed locally" below means: implemented, with a regression test that fails on the code before it (shown below), and
the repository checks passing. It is not device or real-feed acceptance; nothing here is *Verified*.

## The seven defects

| ID | Commit / build | Disposition |
|---|---|---|
| D1 (P1) | server 0251 | Fixed locally. Deleting a segmented recording removes only `segment_original`, never a file found at "<name>.ts". A copy that finishes after its recording was deleted removes its own published file. 0227–0241 rows (kept, `done`, no path) are claimed once at schema init; a `moving` row owns nothing. |
| D2 | server 0252 | Fixed locally. `deleteRecording` retires a `failingOver` owner and settles the schedule as cancelled; the move then starts nothing and gives back a late feed. |
| D3 | server 0253 | Fixed locally. A candidate's existing schedule is reconciled before the hit check, so A → B → A moves it back; the hit only stops a second schedule. |
| D4 | server 0254 | Fixed locally. Only `scheduled`, `waiting` or `cancelled` schedules can be a moved event; one already recording in its pre-buffer never absorbs a later match. |
| R-S5 | server 0255 | Fixed locally. A discovery answer that is not an object with a `scores` list is a failure (fixtures, last success and coverage kept); `{ scores: [] }` stays a real "nothing active". More series than the cap (20) is a partial refresh. |
| A2-R | Apple 52 | Fixed locally. The sign-out clear is put on the Top Shelf file queue before `clear()` returns (`queueNow`), so the next session's first card, snapshot and `lastWritten` always come after it. No generation check is relied on (the clear and the next session share one). |
| A5-R | Apple 53 | Fixed locally. Every change to the artwork folder (write, replacement, prune removal) runs alone under one owner and is counted with what it actually did (a removal counts the file's size at removal), so the count is the folder's size. |

`docs/CLIENT-CONTRACT.md` is unchanged: no route, field or status was added. What a client can now see differently uses
existing values only (a schedule reads `cancelled` after its recording is deleted during a failover move, where it used
to start recording again).

With these, DVR-1, DVR-3 (within the policy below), DVR-4, S5, A2 and A5 are fixed locally. The other original
findings keep the dispositions in the review (I1, PB1–PB5, DVR-2, DVR-5, W1, W2, S1–S4, S6, S7, A1, A3, A4).

### Before/after proof

Every test below fails on the code before its commit and passes after it. Server old-code runs: `git stash` of
`server/` only (the new tests kept), the named tests run with `--test-timeout`, then unstashed; no stray fixture process
was left (`pgrep` for the fake ffmpeg found none). Apple old-code runs: an isolated copy in the scratchpad with build 51's
ordering restored inside the new code (`apple-mutate.py` below), so the new tests compile and fail on behaviour, not on
missing symbols.

| ID | Test (file) | Before | After |
|---|---|---|---|
| D1 | `D1: deleting a recording whose original could not be published…` (recording-segments) | fails: the foreign "<name>.ts" was deleted (ENOENT reading it) | passes |
| D1 | `D1: deleting a recording while its original is being copied…` (barrier at the copy's end) | fails: "the other file is untouched" | passes |
| D1 | `D1: an original kept by 0227-0241…` (legacy claim) | fails: no `claimLegacyOriginals` (a preservation test: 0250 deleted it by inference) | passes |
| D2 | `D2: …deleted while the start moves to the backup…` (recording-failover) | fails: schedule not settled | passes |
| D2 | `D2: …deleted while the move reads its settings…` | fails: a second ffmpeg starts | passes |
| D3 | `D3: a pending recording follows its match back… A -> B -> A` (recording-rules-events) | fails: left at B | passes |
| D3 | `D3: a cancelled match corrected A -> B -> A stays cancelled` | passes (kept behaviour) | passes |
| D4 | `D4: a recording already running in its pre-buffer never absorbs…` | fails: no schedule made | passes |
| R-S5 | `R-S5: a cricket discovery answer of {} / scores not a list / a bare list…` (sports-fixtures) | all three fail: the match is erased | pass |
| R-S5 | `R-S5: more series than are fetched (the cap)…` | fails: the match is erased, coverage renewed | passes |
| R-S5 | `R-S5: a well-formed discovery with no active series…` | passes (kept behaviour) | passes |
| A2-R | `TopShelfCardTests.testAClearHeldBeforeItIsQueuedNeverRemovesTheNextSessionsSnapshotOrCards` | fails: snapshot nil (removed by the held clear), card gone | passes |
| A5-R | `CacheTests.testAPruneBetweenAReplacementsSizeReadAndItsWriteLeavesTheCountEqualToTheDisk` | fails: counted 1000, disk 2000, cap 1500, no prune running | passes |
| A5-R | `CacheTests.testTwoWritersOfTheSameKeyAreCountedOnce` | fails: counted 2500, disk 1500 | passes |
| A5-R | `CacheTests.testAfterManyConcurrentWritersAndPrunesTheCountIsTheDiskAndUnderTheCap` | fails: counted 9000, disk 7400 | passes |

The Apple proofs use scheduling barriers, not timers: `TopShelfPublication.beforeQueueing` (awaited by `run` before it
queues work; the test holds the clear there, the order the review found), `ArtworkDiskStore.beforeReplacing` (a write
stops between its size read and its replacement) and `ArtworkBudget.waitingForFiles` (another change had to wait). All
three are nil in the app. The tests wait on these signals or on `queuedCount`, and yield rather than sleep.

[`apple-repair-mutate.py`](apple-repair-mutate.py) makes that copy: the clear goes back to a detached
`run(ifCurrent: nil)`, and `ArtworkBudget`'s owner of folder changes runs its body directly. Run on a copy of the
working tree (`python3 apple-repair-mutate.py <copy>`), then the four tests with `-only-testing`: **4 run, 4 failed**
(exit 65) as above; on the real tree the same four pass.

## F4 policy: what it is, its limits, and a proposal for Mark

**What it is (0245, 0253, 0254), stated exactly.** There is no provider event id; a Sport event's id is a hash of its
title and time, so identity is inferred per evaluation:

1. *Present:* a schedule of the same title (event or merged guide title, any channel) within **15 minutes** of an event
   is that event.
2. *Moved:* a schedule that has not begun (`scheduled`, `waiting`, or `cancelled` by the viewer), starts in the future
   and **within the 72-hour Sport guide horizon**, with nothing of its title within 15 minutes, is the same event as the
   nearest same-title event that has no schedule, one to one. A pending one follows it; a cancelled one holds.
3. Otherwise a new event.

The 23 Oct wording "no time window" was wrong: it has a ±15-minute presence window and a 72-hour move horizon.

**Its limits (pinned by tests, commit `d3bbcea`, so a change to them is deliberate):**

- **Ambiguous pairs.** With two vanished schedules and two new same-title events in one evaluation, pairing is by
  nearest time. That is a guess: if the guide swaps two games of the same teams, a cancel can land on the wrong one.
- **The 72-hour horizon.** A schedule starting beyond it is never a move candidate. This is deliberate: the guide shows
  only 72 hours of Sport, so a schedule out there being "absent" proves nothing, and pairing it would let a manual
  next-week schedule absorb this week's game. In practice a rule's Sport schedule is created inside the horizon and only
  gets nearer, so this limit is reached only by a schedule edited out past it.
- **Series without episode data.** A series airing with no episode/sub-title is identified by channel and time (rounded
  to 15 minutes) and matched within ±15 minutes. A guide correction of 20 minutes or more makes a new airing: a cancel
  does not hold and a pending one is duplicated. Episode-keyed series are unaffected.

**Proposal for Mark's acceptance.** *Accepted by Mark on 25 Oct as written (1, 2, and 3 with 3 hours); implemented in 0259.*

1. *Ambiguous Sport pairs: record rather than suppress.* Keep nearest-time pairing for pending schedules (either way one
   recording per game). But a **cancelled** schedule suppresses a new event only when the pairing is unambiguous (one
   vanished schedule of that title and one unscheduled event of that title in the evaluation). Otherwise the new event is
   recorded and the viewer can cancel it again. Rationale: an unwanted recording costs a cancel; a missed one cannot be
   undone.
2. *Keep the 72-hour horizon* as the guide's own horizon, documented as above.
3. *Metadata-free series: the same move rule on the channel.* On the series' own channel, a pending or cancelled airing
   whose slot has vanished pairs with the nearest same-title airing that has no schedule, up to **3 hours** away, one
   to one, with the ambiguity rule of (1). Beyond 3 hours it is a new airing.

Say yes, no, or adjust each of the three; (1) and (3) are small changes to `pairEvents` and `alreadyScheduled` with the
tests above inverted.

## Still open, deliberately

- **Device and feed acceptance** for everything in this pass and the earlier ones (steps below). Nothing is *Verified*.
- **Bug 8 (iPhone "Tuning" during recording)** and **bug 5 (AUS v SA cricket not grouped)**: no root cause established.
  R-S5 changes how a broken ESPN cricket discovery answer is treated; nothing shows it is the cause of bug 5. The DVR and
  Apple concurrency fixes are not evidence about bug 8.
- **The F4 policy proposal** above.
- **Efficiency register (22 Oct)**: each item's disposition is below. No measurement was taken in this pass and no
  performance claim is made. A5 and S6 were resource-bound *defects* (repaired), not efficiency work.

| Efficiency item | Disposition |
|---|---|
| Archive accounting | Not started. Deferred: needs a measurement of what the accounting costs today before changing it. |
| Media-job deadlines | Not started. Deferred: S6 bounded logo conversions only; other media jobs need their own capture of how long they really run, so a deadline is not set on a guess. |
| Rule input batching (one channel map and pending count per evaluation) | Not started. Deferred: source-supported avoidable work, not a measured bottleneck (up to 100 rules). |
| Concurrent Apple recording lists | Not started. Deferred: needs before/after timing on a device; must keep quiet refresh and equality suppression. |
| Web guide window reuse | Not started. Deferred: W1's ownership fix stands; reuse needs a measured cost of the overlapping fetches. |
| Logo request coalescing | Not started. Deferred: S6 gives each download one deadline, not one conversion per key; needs a count of duplicate conversions first. |
| Interval ingest throughput (for R7) | Not started. Deferred: needs Mark's go-ahead for an observation-only rate log and several days with the shared connection on (HANDOVER item 2). |
| Warming/standby on the shared ingest | Not started. Deferred: after R7, with a device test of a relay switch and an adopted warm channel (HANDOVER item 3). |

## Device and data steps for Mark

The 23 Oct steps still stand: [REPAIR-STATUS.md, "Device and data steps"](../2026-10-23-fix-review/REPAIR-STATUS.md#device-and-data-steps-for-mark).
Additions for this pass:

1. **Installed versions:** after deploying, `curl -s http://192.168.1.235:3000/api/version` shows build 0255 or later;
   Settings → Version on each Apple device shows 53.
2. **Top Shelf, sign out and straight back in (Apple 52):** with favourites on the Top Shelf, sign out and sign in again
   at once (same or another account). After the Top Shelf refreshes it shows the new session's channels, and they stay
   after leaving the app for a minute.
3. **Artwork cache (Apple 53):** browse the guide across many channels for a few minutes; logos keep appearing and
   none is stuck loading. (The cap itself is checked by the tests; a device shows no counter.)
4. **Kept original and delete (0251, switch on):** with Segmented recordings on, a recording that keeps its
   original (its MP4 could not be fully checked): delete it while the share is down, then bring the share back; any other ".ts" in
   that channel folder must still be there.
5. **Delete during failover (0252):** only if it happens naturally - deleting a recording in the few seconds it moves to
   the backup provider; it must not come back.
6. **Cricket (0255):** Status → Sport fixtures, the Cricket row after a refresh; report any "not a cricket scorepanel"
   or "series not fetched" error text.
