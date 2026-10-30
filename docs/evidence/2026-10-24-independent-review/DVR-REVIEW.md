# DVR repair review — 24 October 2026

Reviewed current server `bc92dfc` (functional build 0250), specifically 0242–0245, against 0241 `f026c63`. Read the supplied request, AGENTS and repair claims. No application changes, provider/deployed-server calls or commits. All experiments use copied server code, disposable SQLite databases and synthetic feeds/files.

## Verdicts

| Finding | Verdict | Evidence and remaining scope |
|---|---|---|
| F1 / DVR-1, original ownership | **Partial** | Byte comparison and exclusive publication correctly preserve a conflicting original during finishing. However deleting a new recording while its original copy remains pending still deletes that foreign TS; D1 below. |
| F2 / DVR-1, interrupted copy recovery | **Fixed in local scope** | `finishOne` persists `moving` before copying (recordingSegments.js:503), changes to done only after success (509–511); restart queue finds it. Existing interrupted-copy test passes. This does not close DVR-1 because F1 remains partial. |
| F3 / DVR-4, failover cancellation | **Partial** | Cancel and shutdown now own the settings/feed awaits and release late feeds. Deletion does not invalidate that owner; D2 below. |
| F4 / DVR-3, rule identity | **Partial; policy acceptance still required** | Both same-title matches present together and a one-way correction now work. A→B→A corrections fail, and prebuffer-active recordings incorrectly absorb new events. The stated no-provider-ID policy is a heuristic, not durable identity across all window/series cases. |

## Reproduced defects

### D1 — P1: pending-original deletion removes an unrelated file

`server/services/recordingEngine.js:625–629` interprets `segment_keep && !segment_original` as proof that build 0227 published the conventional TS name. That is also the normal state of a **new** recording whose retained-original copy failed or is still pending.

Fixture: put unrelated same-size bytes at the conventional TS name, fail the new exclusive original write, confirm row is `moving` with null `segment_original`, then delete recording. The unrelated TS disappears. Ownership must be explicit, including legacy migration; null ownership is not proof of legacy ownership. Preserve foreign bytes in both failed and in-flight copy cases.

### D2 — P2: deleting during immediate failover starts the deleted recording again

`server/services/recordingEngine.js:595–608` cancels active/continuation entries but does not invalidate `failingOver`. The owner still passes `stillOurs()` at 1022/1042 and calls `spawnPart` at 1044 after the recording row was deleted.

Fixture: primary synthetic ffmpeg fails immediately, hold backup subscription, delete the part, then release backup. The schedule is active again and the late feed has not been released. Deletion must retire every owner for that recording, settle the schedule, and release late subscriptions without spawning.

### D3 — P2: repeated correction back to a known event identity leaves wrong recording time

`server/services/recordingRules.js:265` skips a previously hit identity before applying the current pairing/update at 266–272. Schedule at A (+2h), move to B (+5h), then restore guide to A: schedule remains at B. Historical deduplication must not bypass reconciliation of an existing pending schedule.

### D4 — P2: recording already active in prebuffer absorbs a later event

`server/services/recordingRules.js:223` selects vanished schedules only by future `program_start`, ignoring `status`. A recording already started by its prebuffer is still eligible while nominal start lies in the future. It absorbs a new same-title event, but the update at 269 excludes `recording`, so neither a new schedule nor a moved recording is created.

Fixture: scheduled start +2min, status recording (prebuffer has started); guide replaces it with same-title +1h. Evaluation makes zero schedules and leaves the sole active row unchanged. Exclude already-active/completed schedules from movable candidates, not just timestamps. Existing started-after-nominal-start guard passes, so that test alone misses this boundary.

## F4 policy probes

`dvr-additional-boundaries.cjs` also establishes:

- Two vanished slots and two new events are paired one-to-one by nearest gap. The fixture retains cancellation for one and moves the other. This demonstrates the implementation's rule, not that the real-world identities are knowable.
- A cancelled original slot outside the 72-hour eligible window does not pair; a new identity creates a recording. Fixture deliberately moves its stored original time to +73h to exercise the boundary. Cancellation is therefore bounded by the candidate-window policy, not durable forever.
- Metadata-free **series** cancellation is recreated after a 20-minute guide correction. Series still derives identity from rounded time (`recordingRules.js:169`) and uses ±15min matching (`185–190`); no episode key exists to preserve it. This is an uncovered limitation of the broader durable-cancellation intent, not a new regression introduced by sport pairing.
- A schedule already past its nominal start does not absorb a later successor; guard behaves as intended.

Mark's explicit acceptance is needed for the ambiguity policy (vanished old slot plus new same-title slot means move). Such acceptance would not excuse D3 or D4, which contradict the chosen policy itself. Document separate series and window limitations rather than describing the implementation as having “no time window.”

## Independent evidence

Scripts in this directory:

- `dvr-additional-boundaries.cjs`: **8/8 assertions passed**: four defect reproductions D1–D4, plus four policy/guard cases (two-pair, outside-window, series cancellation, nominal-start guard). These assertions intentionally confirm current behavior and must be inverted/redesigned for regression tests.
- `dvr-parent-proof.cjs`: current code **3/3 pass**; 0241 baseline **0/3 pass**. Two F4 cases fail on real behavior (one instead of two matches; old schedule time unchanged). F1 compares retained bytes via the legacy path when `segment_original` is absent, so its baseline failure is incorrect retained content rather than a missing new column. Current tests are copied over isolated archived server code; no checkout changes.
- Current existing F2/F3 focused tests: **4/4 passed** (one interrupted-copy recovery, three cancel/shutdown failover cases). Full suite is independently run by the lead reviewer.

Logs: `/tmp/pigtv-dvr-boundaries-permitted.log`, `/tmp/pigtv-dvr-parent-permitted.log`, `/tmp/pigtv-dvr-f2-f3-current.log`. Initial sandbox-only runs hit localhost `EPERM`; these were rerun successfully with approved local fixture access and are not product failures. Per-test 25-second deadlines and process 35-second deadlines bound saved proof scripts.

## Documentation corrections and handoff

`docs/evidence/2026-10-23-fix-review/REPAIR-STATUS.md` accurately separates device acceptance and asks for F4 policy approval, but F1's “delete removes only what the recording published”, “DVR-1 closed in local scope”, and “DVR-4 closed in local scope” are contradicted by D1/D2. Reopen those claims. F4's “no time window” overstates the actual ±15min presence/72h move policy and excludes series behavior.

Repair D1 first, then D2–D4 with expected-correct regressions that fail on current code. Add ownership checks across all recording lifecycle transitions rather than only the originally reported entry point. Keep F4 ambiguity approval and actual share/device behavior outstanding. No live acceptance is inferred from these synthetic tests.
